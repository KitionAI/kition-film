//! [`FilmSession`]: one project's replica and its [`FilmModel`] view, for the engine's command
//! bridge (phase 3b Task 2).
//!
//! It is [`kition_kit::session::KitSession<FilmModel>`]'s flow (transactions, per-actor undo, the
//! change exchange, the post-merge repair through [`KitModel::validate`], the view patched
//! through [`KitModel::apply`]) with two things [`KitSession`] does not do on its own: a
//! diff-bridged `record` (the engine already holds the project it wants written; this writes only
//! what changed since the view, the same way [`crate::write::write_changes`] is meant to be used)
//! and counting how many of a `record`'s transactions landed inside an open undo group, so the
//! engine's own per-command history can tell the caller how many replica undo steps one of its
//! own entries is worth.
//!
//! Unlike [`kition_kit::session::KitSession`]'s general shape, this crate's model never embeds
//! blobs (`kdm-model`'s own docs: media are referenced by path, never embedded), so a
//! [`kition_kit::session::MemoryBlobs`] that is never written to is enough.

use kition_kit::kdm::{ActorId, DocId, Origin, Replica, UndoScope, Version};
use kition_kit::session::{Damage, KitError, KitModel, KitSession, MemoryBlobs};

use crate::{FilmModel, Ids, Nodes, Result, normalize, read_document, replace_document, write_changes, write_document};

/// One open project as a KDM replica and the engine's view of it. See the module docs.
pub struct FilmSession {
    inner: KitSession<FilmModel>,
    /// An undo group is open, and whether a transaction in it already made it an undo step
    /// (so only the first transaction of a coalescing gesture counts as one).
    group: Option<bool>,
}

impl std::fmt::Debug for FilmSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilmSession").field("doc", &self.inner.replica().doc_id()).field("actor", &self.inner.replica().actor()).finish_non_exhaustive()
    }
}

/// The first id [`kition_film_project::Project::alloc_id`] may hand out on behalf of `actor`: a
/// per-actor slot of the id space, so two actors that each mint an id-as-data (a marker, a clip
/// link or group, a caption or caption track, a `lutN` LUT id, a search bin — anything
/// `alloc_id` hands out that never becomes its own KDM object, see [`kition_film_project::Project::minimum_next_id`])
/// without exchanging first never collide: unlike a `Bin`/`Item`/`Track`/`Clip`/`Transition`,
/// such an id has no object identity of its own for the merge to keep both of, so a plain
/// last-writer-wins union of two replicas' same id would silently keep only one.
///
/// `((actor as u64) % 2^20) << 32`: 2^20 slots (collisions only beyond a million concurrent
/// actors on one document, and even then only between two of them), each a contiguous 2^32-id
/// range, so a document's edit history keeps minting from well inside its own slot for a very
/// long time before ever reaching the next one. The result is at most `(2^20 - 1) << 32`, under
/// 2^52 — safely inside the range `kition-sdk`'s schema accepts for a bare JSON number (`Tick`s
/// are written as decimal strings for exactly this reason; an id-as-data is not, so it stays
/// under that limit instead).
pub(crate) fn slot_base(actor: ActorId) -> u64 {
    (actor.get() % (1u64 << 20)) << 32
}

impl FilmSession {
    /// A new replica holding `project`, written in its creating transaction (not an undo step).
    /// `project.next_id` is raised to this replica's own actor's id slot ([`slot_base`]) if it
    /// was not already past it, so every id minted on this replica from here on — including
    /// ones, like a marker, kept only as data — stays inside that actor's own range.
    pub fn create(project: &kition_film_project::Project) -> Result<Self> {
        let mut ids = Ids::default();
        let mut nodes = Nodes::default();
        let (replica, ()) = Replica::create_with(FilmModel::schema(), DocId::new(), ActorId::random(), &Origin::system("create"), |tx| {
            write_document(tx, project, &mut ids, &mut nodes).map(|_| ())
        })
        .map_err(KitError::from)?;
        let mut inner: KitSession<FilmModel> = KitSession::from_replica(replica, Box::new(MemoryBlobs::default()))?;
        // `from_replica` just loaded the view back with `FilmModel::load` (a fresh read, no
        // continuity: it mints its own local ids from scratch). Put back the exact `project` and
        // the ids `write_document` already minted for it, so the caller's own engine-side ids
        // (`ItemId`, `BinId`…) survive a replica's creation unchanged.
        let mut project = project.clone();
        project.next_id = project.next_id.max(slot_base(inner.replica().actor()));
        inner.model_mut().adopt(project, ids, nodes);
        Ok(Self { inner, group: None })
    }

    /// Opens a snapshot (or a full change export) of another replica as a new replica of a fresh
    /// actor. The view's `next_id` is raised to this fresh actor's own id slot ([`slot_base`]) if
    /// it was not already past it, same as [`FilmSession::create`] (`FilmModel::load`'s own
    /// `read_document_known` already does this for every ordinary reload; this covers the one
    /// moment a session's project does not yet come from that path — right after opening).
    pub fn open_snapshot(bytes: &[u8]) -> Result<Self> {
        let mut inner: KitSession<FilmModel> = KitSession::open_snapshot(bytes, Box::new(MemoryBlobs::default()), ActorId::random())?;
        let floor = slot_base(inner.replica().actor());
        if inner.model().project.next_id < floor {
            let mut project = inner.model().project.clone();
            project.next_id = floor;
            let ids = inner.model().ids().clone();
            let nodes = inner.model().nodes().clone();
            inner.model_mut().adopt(project, ids, nodes);
        }
        Ok(Self { inner, group: None })
    }

    /// The view: the project as of the last record, undo, redo or import.
    pub fn project(&self) -> &kition_film_project::Project {
        &self.inner.model().project
    }

    pub fn model(&self) -> &FilmModel {
        self.inner.model()
    }

    /// Writes what differs between the view and `after` as one transaction of `origin`, then
    /// makes `after` the view. Answers how many undo steps that made (0 when nothing replicated
    /// changed, or when the transaction joined an undo group that is already a step). On failure
    /// nothing is written and the view is unchanged, so the next record writes the change again.
    pub fn record(&mut self, origin: &Origin, after: &kition_film_project::Project) -> Result<u32> {
        let mut ids = self.inner.model().ids().clone();
        let mut nodes = self.inner.model().nodes().clone();
        let before = self.inner.model().project.clone();
        let version_before = self.inner.version();
        let result = self.inner.record(origin, |tx| write_changes(tx, &before, after, &mut ids, &mut nodes).map(|_| ()).map_err(KitError::from));
        result?;
        self.inner.model_mut().adopt(after.clone(), ids, nodes);
        let wrote = self.inner.version() != version_before;
        let steps = match &mut self.group {
            _ if !wrote => 0,
            None => 1,
            Some(counted) if !*counted => {
                *counted = true;
                1
            }
            Some(_) => 0,
        };
        Ok(steps)
    }

    /// Import only the file difference, retaining both undo histories and object identities.
    pub fn reread(&mut self, after: &kition_film_project::Project) -> Result<()> {
        let mut ids = self.inner.model().ids().clone();
        let mut nodes = self.inner.model().nodes().clone();
        self.inner.reread(|model, tx| write_changes(tx, &model.project, after, &mut ids, &mut nodes).map(|_| ()).map_err(KitError::from))?;
        self.inner.model_mut().adopt(after.clone(), ids, nodes);
        Ok(())
    }

    /// Whether the replica holds `project`'s content, compared as `read_document` reads both back
    /// (ids normalized, and in the reader's own canonical shape, so a difference only in what the
    /// replica does not keep — the interleaving of a bin's sub-bins and items — is no
    /// difference). Errs if `project` cannot be written to a replica at all.
    pub fn holds(&self, project: &kition_film_project::Project) -> Result<bool> {
        let mut ids = Ids::default();
        let mut nodes = Nodes::default();
        let (scratch, ()) = Replica::create_with(FilmModel::schema(), DocId::new(), ActorId::random(), &Origin::system("create"), |tx| {
            write_document(tx, project, &mut ids, &mut nodes).map(|_| ())
        })
        .map_err(KitError::from)?;
        let (theirs, _, _) = read_document(&scratch).map_err(KitError::from)?;
        let (mine, _, _) = read_document(self.inner.replica()).map_err(KitError::from)?;
        let value = |p: &kition_film_project::Project| serde_json::to_value(normalize(p)).map_err(|error| KitError::new(error.to_string()));
        Ok(value(&theirs)? == value(&mine)?)
    }

    /// Records `project` over the whole replica as one transaction of `origin` (see
    /// [`crate::replace_document`]: the replica keeps its document identity), then makes it the
    /// view. For a file that must win over a stored replica that does not hold it.
    pub fn replace(&mut self, origin: &Origin, project: &kition_film_project::Project) -> Result<()> {
        self.end_undo_group();
        let mut ids = Ids::default();
        let mut nodes = self.inner.model().nodes().clone();
        self.inner.record(origin, |tx| replace_document(tx, project, &mut ids, &mut nodes).map_err(KitError::from))?;
        self.inner.model_mut().adopt(project.clone(), ids, nodes);
        Ok(())
    }

    /// Starts an undo group (ending any open one first): the transactions until
    /// [`FilmSession::end_undo_group`] undo as one step.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        self.end_undo_group();
        self.inner.begin_undo_group()?;
        self.group = Some(false);
        Ok(())
    }

    pub fn end_undo_group(&mut self) {
        self.inner.end_undo_group();
        self.group = None;
    }

    /// Whether an undo group is currently open ([`FilmSession::begin_undo_group`] ran more
    /// recently than [`FilmSession::end_undo_group`]): a `record` now joins it rather than
    /// starting a transaction of its own.
    pub fn group_open(&self) -> bool {
        self.group.is_some()
    }

    /// Undoes this replica's last undo step in `scope` (never imports or repairs, and never the
    /// other scope's steps, Kition platform KitModel 1.1 M12a), repairs the result and patches the
    /// view. Answers whether there was one, and the damage.
    pub fn undo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage)> {
        self.group = None;
        if !self.inner.can_undo_in(scope) {
            return Ok((false, Damage::None));
        }
        self.inner.undo_in(scope)
    }

    pub fn redo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage)> {
        self.group = None;
        if !self.inner.can_redo_in(scope) {
            return Ok((false, Damage::None));
        }
        self.inner.redo_in(scope)
    }

    pub fn can_undo_in(&self, scope: UndoScope) -> bool {
        self.inner.can_undo_in(scope)
    }

    pub fn can_redo_in(&self, scope: UndoScope) -> bool {
        self.inner.can_redo_in(scope)
    }

    /// Imports remote or stored changes (ending any open undo group first, so it stays one
    /// step), repairs the merged state and patches the view.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<Damage> {
        self.end_undo_group();
        self.inner.import_changes(bytes)
    }

    /// Whether the view can be (and so, after any import, undo or redo, was) loaded from the
    /// replica as it is now. An import whose repair step fails has still imported its changes
    /// and loaded the view from them; one whose view could not be loaded leaves the view behind
    /// the replica (`KitSession` keeps the old one): a caller that keeps its own copy of the
    /// project tells the two apart with this.
    pub fn view_loaded(&self) -> bool {
        read_document(self.inner.replica()).is_ok()
    }

    pub fn export_changes(&self, since: &Version) -> Result<Vec<u8>> {
        self.inner.export_changes(since)
    }

    pub fn version(&self) -> Version {
        self.inner.version()
    }

    pub fn snapshot(&self) -> Result<Vec<u8>> {
        self.inner.snapshot()
    }

    pub fn state_hash(&self) -> Result<String> {
        self.inner.state_hash()
    }

    pub fn replica(&self) -> &Replica {
        self.inner.replica()
    }
}
