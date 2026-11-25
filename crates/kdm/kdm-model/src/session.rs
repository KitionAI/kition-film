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
//! Media are referenced by path, never embedded; the only blobs are the text of the project's
//! LUTs (`Lut.data`). The session keeps them in a [`MemoryBlobs`]: every project it writes puts
//! its LUTs' text there first, and a peer's arrive through [`FilmSession::add_blobs`] (a host
//! hands them over before the changes that reference them, [`FilmSession::blobs`] on the other
//! side).

use std::sync::Arc;

use kition_film_project::{BinEntry, ItemKind, Marker, Project};
use kition_kit::kdm::{ActorId, DocId, Origin, Replica, UndoOutcome, UndoScope, Version};
use kition_kit::session::{BlobSink, Damage, KitError, KitModel, KitSession, MemoryBlobs};

use crate::{FilmModel, Ids, Nodes, Result, normalize, objects, read_document, replace_document, write_changes, write_document};

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
/// `(((actor as u64) % (2^20 − 1)) + 1) << 32`: 2^20 − 1 slots (two actors share one only by a
/// one-in-a-million chance), each a contiguous 2^32-id range above the ids a file starts with
/// (those stay with the replica that imported it: no actor mints below 2^32). The largest slot
/// ends at 2^52, inside the ±2^53 a KDM integer (and a JSON number anywhere in a replica) holds.
pub fn slot_base(actor: ActorId) -> u64 {
    ((actor.get() % ((1u64 << 20) - 1)) + 1) << 32
}

/// How many ids one actor's slot ([`slot_base`]) holds.
pub(crate) const SLOT_SIZE: u64 = 1 << 32;

/// An id counter past every id `project` holds in the slot that starts at `floor`
/// ([`slot_base`]), and never below `floor`: every object's id and every id kept as data (a
/// marker's, a caption's or caption track's, a clip link or group, a `lutN` LUT id, a search
/// bin's). Ids outside that slot are not counted: a file's own ids sit below every slot, and
/// another actor's ids in that actor's slot (counting those would move this actor into the
/// other's slot, where both then mint the same link or group ids).
pub(crate) fn next_id_hint(project: &Project, floor: u64) -> u64 {
    let end = floor.saturating_add(SLOT_SIZE);
    let mut max = None::<u64>;
    let mut bump = |id: u64| {
        if (floor..end).contains(&id) {
            max = Some(max.map_or(id, |max: u64| max.max(id)));
        }
    };
    let mut bins = vec![(&project.root, 0usize)];
    while let Some((bin, depth)) = bins.pop() {
        bump(bin.id.0);
        for entry in &bin.children {
            match entry {
                BinEntry::Item(id) => bump(id.0),
                BinEntry::Bin(child) if depth < 64 => bins.push((child, depth + 1)),
                BinEntry::Bin(_) => {}
            }
        }
    }
    fn markers(markers: &[Marker], bump: &mut dyn FnMut(u64)) {
        for marker in markers {
            bump(marker.id.0);
        }
    }
    for (id, item) in &project.items {
        bump(id.0);
        bump(item.id.0);
        match &item.kind {
            ItemKind::Media(media) => markers(&media.markers, &mut bump),
            ItemKind::Sequence(sequence) => {
                markers(&sequence.markers, &mut bump);
                for track in sequence.all_tracks().chain(sequence.submix_tracks.iter()) {
                    bump(track.id.0);
                    for clip in &track.items {
                        bump(clip.id.0);
                        clip.link.into_iter().chain(clip.group).for_each(&mut bump);
                        markers(&clip.markers, &mut bump);
                    }
                    for transition in &track.transitions {
                        bump(transition.id.0);
                    }
                }
                for track in &sequence.caption_tracks {
                    bump(track.id.0);
                    for caption in &track.captions {
                        bump(caption.id.0);
                    }
                }
            }
            ItemKind::Subclip { .. } | ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => {}
        }
    }
    for lut in &project.luts {
        if let Some(id) = lut.id.strip_prefix("lut").and_then(|id| id.parse::<u64>().ok()) {
            bump(id);
        }
    }
    for bin in &project.search_bins {
        bump(bin.id.0);
    }
    max.map_or(floor, |max| max.saturating_add(1).max(floor))
}

/// Puts the text of every LUT of `project` in `blobs`, where a read of the replica finds it.
pub(crate) fn put_luts(project: &Project, blobs: &mut dyn BlobSink) {
    for lut in &project.luts {
        blobs.put(lut.text.as_bytes(), objects::lut_blob(lut).mime.as_str());
    }
}

/// Blobs as bytes, for a host to hand to a peer: for each, its hash (64 hex digits), its length
/// (8 bytes, little-endian) and its bytes.
pub fn encode_blobs(blobs: &MemoryBlobs) -> Vec<u8> {
    let mut entries: Vec<(&String, &Arc<[u8]>)> = blobs.0.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let mut out = Vec::new();
    for (hash, bytes) in entries {
        out.extend_from_slice(hash.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// Reads [`encode_blobs`]'s bytes. Each blob must hash to its name; anything else is an error.
pub fn decode_blobs(mut bytes: &[u8]) -> Result<MemoryBlobs> {
    let mut blobs = MemoryBlobs::default();
    while !bytes.is_empty() {
        let (hash, rest) = bytes.split_at_checked(64).ok_or_else(|| KitError::new("blobs: a truncated hash"))?;
        let hash = std::str::from_utf8(hash).map_err(|_| KitError::new("blobs: a hash that is not text"))?.to_owned();
        let (length, rest) = rest.split_at_checked(8).ok_or_else(|| KitError::new("blobs: a truncated length"))?;
        let mut size = [0u8; 8];
        size.copy_from_slice(length);
        let length = usize::try_from(u64::from_le_bytes(size)).map_err(|_| KitError::new("blobs: a length past this machine's memory"))?;
        let (blob, rest) = rest.split_at_checked(length).ok_or_else(|| KitError::new("blobs: a length past the end"))?;
        if kition_kit::session::sha256_hex(blob) != hash {
            return Err(KitError::new("blobs: a blob does not match its hash"));
        }
        blobs.0.insert(hash, Arc::from(blob));
        bytes = rest;
    }
    Ok(blobs)
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
        let mut blobs = MemoryBlobs::default();
        put_luts(project, &mut blobs);
        let mut inner: KitSession<FilmModel> = KitSession::from_replica(replica, Box::new(blobs))?;
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
    /// `blobs` holds the text of the replica's LUTs ([`FilmSession::blobs`] of a peer).
    pub fn open_snapshot(bytes: &[u8], blobs: MemoryBlobs) -> Result<Self> {
        let mut inner: KitSession<FilmModel> = KitSession::open_snapshot(bytes, Box::new(blobs), ActorId::random())?;
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
        put_luts(after, self.inner.blobs_mut());
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
        put_luts(after, self.inner.blobs_mut());
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
        let mut blobs = MemoryBlobs::default();
        put_luts(project, &mut blobs);
        let (theirs, _, _) = read_document(&scratch, &blobs).map_err(KitError::from)?;
        let (mine, _, _) = read_document(self.inner.replica(), self.inner.blobs()).map_err(KitError::from)?;
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
        put_luts(project, self.inner.blobs_mut());
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
    /// view. Answers which steps the undo took off the stack ([`UndoOutcome`]: a step with nothing
    /// left to change, its objects gone since, is passed over and the one below it taken back),
    /// and the damage. An empty stack answers an empty outcome.
    pub fn undo_in(&mut self, scope: UndoScope) -> Result<(UndoOutcome, Damage)> {
        self.group = None;
        if !self.inner.can_undo_in(scope) {
            return Ok((UndoOutcome::default(), Damage::None));
        }
        self.inner.undo_in_outcome(scope)
    }

    /// Redoes this replica's last undone step in `scope`, answering as [`FilmSession::undo_in`].
    pub fn redo_in(&mut self, scope: UndoScope) -> Result<(UndoOutcome, Damage)> {
        self.group = None;
        if !self.inner.can_redo_in(scope) {
            return Ok((UndoOutcome::default(), Damage::None));
        }
        self.inner.redo_in_outcome(scope)
    }

    /// Takes a draft's changes (made on a replica forked from this one) in as one transaction of
    /// `origin` (`Replica::merge_changes`): one undo step of the person unless `origin` is a
    /// `system` or `import` one, even when an agent made the draft. Repairs the result and patches
    /// the view as an import does; add the draft's blobs first ([`FilmSession::add_blobs`]). A
    /// refused merge changes nothing.
    pub fn merge_changes(&mut self, bytes: &[u8], origin: &Origin) -> Result<Damage> {
        self.end_undo_group();
        self.inner.merge_changes(bytes, origin)
    }

    /// Writes the state `snapshot` holds (a snapshot or content of this document, as a host's
    /// checkpoint keeps it) over the replica as one transaction of `origin`, keyed by object id,
    /// so every object the two share keeps its id: one undo step of `origin`'s scope unless it is a
    /// `system` or `import` one. Nothing changes when the states are equal; another document's
    /// snapshot is refused. Add the blobs it references first.
    pub fn restore_state(&mut self, snapshot: &[u8], origin: &Origin) -> Result<Damage> {
        self.end_undo_group();
        self.inner.restore_state(snapshot, origin)
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
        read_document(self.inner.replica(), self.inner.blobs()).is_ok()
    }

    /// The text of every LUT the replica references, for a peer ([`FilmSession::add_blobs`]); a
    /// LUT whose text this session does not hold is left out.
    pub fn blobs(&self) -> MemoryBlobs {
        let mut out = MemoryBlobs::default();
        for hash in objects::lut_hashes(self.inner.replica()) {
            if let Some(bytes) = self.inner.blobs().get(&hash) {
                out.0.insert(hash, bytes);
            }
        }
        out
    }

    /// Keeps a peer's blobs ([`FilmSession::blobs`]), for the changes that reference them.
    pub fn add_blobs(&mut self, blobs: &MemoryBlobs) {
        for bytes in blobs.0.values() {
            self.inner.blobs_mut().put(bytes, "application/octet-stream");
        }
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
