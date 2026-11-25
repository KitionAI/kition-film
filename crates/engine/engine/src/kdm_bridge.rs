//! The command bridge to the project's KDM replica (Kition phase 3b, Task 2).
//!
//! The session's replica ([`kdm_model::FilmSession`]) is the project's shared source of truth;
//! [`Session::project`] is the engine's own view of it. Commands run exactly as before on the
//! in-memory [`kition_film_project::Project`] (through [`Session::edit`]/`edit_merged`/
//! `edit_sequence`, which never change); [`Session::execute`] then writes what the *whole command*
//! changed as one transaction, diffed against [`Session::synced`] (the project as the replica last
//! saw it), so a command that runs other commands or folds several edits into one history entry
//! ([`crate::clip_ops::collapse_history`]) still
//! replicates as one. A live, uncommitted gesture that mutates the project without pushing a
//! history entry yet (a dynamic trim's `trim.tick`) is left unsynced until it commits: `execute`
//! always settles one first ([`Session::settle_trim_playback`]), so nothing is lost, and nothing
//! half-finished ever reaches a collaborator.
//!
//! Undo is per person: each history entry remembers how many replica undo steps its own edit
//! took ([`crate::History`]'s third field), and [`Session::undo`]/[`Session::redo`] step the
//! replica that many times, then take the *replica's* resulting project (not the engine's own
//! snapshot) as current — folding in any collaborator's edits that arrived since, the same way
//! `undo` on a shared document must. [`crate::EditorState`] is this person's own state: never
//! written, and [`Session::fix_state`] repairs it (a selection or active sequence an undo, redo
//! or import made dangling) exactly as it already did before KDM.
//!
//! [`Session::edit_merged`]'s coalescing key becomes a KDM undo group ([`kdm_model::FilmSession`]
//! counts a group's first transaction as the one undo step, the rest as none): a few separate
//! `execute` calls of one continuous gesture (a fader drag) still undo on the replica as the one
//! step the engine's own history already made them.

use std::sync::Arc;

use kdm_model::FilmSession;
use kdm_model::kition_kit::kdm::{Origin, UndoScope, Version};
use kdm_model::kition_kit::session::Damage;
use kition_film_project::Project;

use crate::{EngineError, Event, Result, Session};

/// The origin of the local person's commands (used when nothing else was set with
/// [`Session::execute_as`]/[`Session::set_origin`]).
pub fn local_person() -> Origin {
    Origin::person("person:local")
}

pub(crate) fn kdm_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::Other(format!("project replica: {error}"))
}

fn no_replica() -> EngineError {
    EngineError::Other("no project replica yet and none could be made".into())
}

impl Session {
    /// A clean outside reread changes the existing replica, without replacing session inputs.
    pub fn reconcile_file(&mut self, project: &Project) -> Result<()> {
        // Validate the transaction on an isolated replica before touching the live histories.
        let snapshot = self.snapshot()?;
        let blobs = self.kdm.as_ref().map(FilmSession::blobs).unwrap_or_default();
        let mut check = FilmSession::open_snapshot(&snapshot, blobs).map_err(kdm_error)?;
        check.reread(project).map_err(kdm_error)?;
        self.kdm.as_mut().ok_or_else(no_replica)?.reread(project).map_err(kdm_error)?;
        self.follow_kdm();
        self.saved_revision = self.revision;
        Ok(())
    }

    /// The project's replica, if it has made one yet (see [`Session::kdm_resets`]: `None` can
    /// also mean the last one was dropped and the next edit will make a fresh one).
    pub fn kdm(&self) -> Option<&FilmSession> {
        self.kdm.as_ref()
    }

    /// How many times the project left its replica because the replica refused a write or an
    /// undo (a project it cannot hold, or a bug). The project keeps working, undoing from its own
    /// history snapshots; the next edit makes a fresh replica, which is a new KDM document:
    /// collaborators need its full [`Session::snapshot`] to join again. Hosts watch this.
    pub fn kdm_resets(&self) -> u64 {
        self.kdm_resets
    }

    /// Drops the replica (a future edit makes a fresh one) and forgets any pending diff: for a
    /// command that replaces the whole project outright and wipes the history alongside it
    /// (`file.newProject`, `file.openDemoProject`, opening a file…), so the next edit's replica
    /// is baselined on the *new* project, not diffed against whatever the old one last synced.
    /// Such a command is otherwise invisible to [`Session::sync_kdm_after_command`] (it does not
    /// push a history entry to attribute a transaction to), so it must call this itself right
    /// after replacing [`Session::project`].
    pub(crate) fn reset_kdm(&mut self) {
        self.kdm = None;
        self.synced = self.project.clone();
    }

    /// Who the running (or next) command acts for: the origin of [`Session::execute_as`], or the
    /// local person.
    pub fn origin(&self) -> Origin {
        self.origin.clone().unwrap_or_else(local_person)
    }

    /// Sets who the following commands act for (`None`: the local person); answers the previous
    /// setting, to put back. For front ends (the headless Kit Protocol) that run commands through
    /// their own entry points under another person's or agent's identity.
    pub fn set_origin(&mut self, origin: Option<Origin>) -> Option<Origin> {
        let previous = std::mem::replace(&mut self.origin, origin);
        self.use_scope(scope_of(&self.origin()));
        previous
    }

    /// Makes `history` the one of `scope` (Kition platform KitModel 1.1 M12a: the person's and
    /// the agents' steps undo separately).
    /// A coalescing gesture never spans two scopes: its open replica undo group ends here.
    pub(crate) fn use_scope(&mut self, scope: UndoScope) {
        if self.history_scope != scope {
            self.history.merge_key = None;
            if let Some(kdm) = self.kdm.as_mut() {
                kdm.end_undo_group();
            }
            std::mem::swap(&mut self.history, &mut self.other_history);
            self.history_scope = scope;
        }
    }

    /// [`Session::undo`] in `scope` (`None`: the caller's, engine rule E14a).
    pub fn undo_in(&mut self, scope: Option<UndoScope>) -> Option<String> {
        self.in_scope(scope, Self::undo)
    }

    /// [`Session::redo`] in `scope` (`None`: the caller's).
    pub fn redo_in(&mut self, scope: Option<UndoScope>) -> Option<String> {
        self.in_scope(scope, Self::redo)
    }

    fn in_scope(&mut self, scope: Option<UndoScope>, step: fn(&mut Self) -> Option<String>) -> Option<String> {
        let own = scope_of(&self.origin());
        self.use_scope(scope.unwrap_or(own));
        let done = step(self);
        self.use_scope(own);
        done
    }

    /// [`Session::execute`] as `origin` (a person, an agent): the replica records the edit as
    /// theirs, and it undoes as that replica's own step.
    pub fn execute_as(&mut self, id: &str, params: serde_json::Value, origin: &Origin) -> Result<serde_json::Value> {
        let previous = self.set_origin(Some(origin.clone()));
        let r = self.execute(id, params);
        self.set_origin(previous);
        r
    }

    /// The replica, made now from the current project if there is none yet (for a host that asks
    /// for [`Session::version`]/[`Session::snapshot`]/etc. before any edit).
    pub fn ensure_kdm(&mut self) -> Option<&mut FilmSession> {
        self.flush_kdm();
        if self.kdm.is_none() {
            match FilmSession::create(&self.project) {
                Ok(kdm) => {
                    self.kdm = Some(kdm);
                    self.synced = self.project.clone();
                }
                Err(_) => return None,
            }
        }
        self.kdm.as_mut()
    }

    /// The text of every LUT the replica references, encoded for a peer's [`Session::add_blobs`].
    pub fn blobs(&mut self) -> Result<Vec<u8>> {
        Ok(kdm_model::encode_blobs(&self.ensure_kdm().ok_or_else(no_replica)?.blobs()))
    }

    /// Keeps a peer's blobs ([`Session::blobs`]) for the changes and snapshots that reference
    /// them: hand them over before [`Session::import_changes`] or [`Session::open_snapshot`].
    pub fn add_blobs(&mut self, bytes: &[u8]) -> Result<()> {
        let blobs = kdm_model::decode_blobs(bytes).map_err(kdm_error)?;
        if let Some(kdm) = self.kdm.as_mut() {
            kdm.add_blobs(&blobs);
        }
        self.peer_blobs.0.extend(blobs.0);
        Ok(())
    }

    /// The replica's version (its own actor's and every peer's it has merged).
    pub fn version(&mut self) -> Result<Version> {
        Ok(self.ensure_kdm().ok_or_else(no_replica)?.version())
    }

    /// The replica as a snapshot, for a peer to [`Session::open_snapshot`].
    pub fn snapshot(&mut self) -> Result<Vec<u8>> {
        self.ensure_kdm().ok_or_else(no_replica)?.snapshot().map_err(kdm_error)
    }

    /// SHA-256 of the replicated state: equal on replicas that converged.
    pub fn state_hash(&mut self) -> Result<String> {
        self.ensure_kdm().ok_or_else(no_replica)?.state_hash().map_err(kdm_error)
    }

    /// The replica's changes since `since` (`Version::empty()` for all of them).
    pub fn export_changes(&mut self, since: &Version) -> Result<Vec<u8>> {
        self.ensure_kdm().ok_or_else(no_replica)?.export_changes(since).map_err(kdm_error)
    }

    /// Imports a collaborator's (or stored) changes into the replica. The project follows;
    /// anything local not written yet is flushed first, so nothing of it is lost. An import that
    /// fails after its changes landed (the repair step after the merge refused) still follows the
    /// replica when the view loaded from it, so the next local edit does not write the
    /// collaborator's changes back out; when even the view could not be loaded, the project
    /// leaves the replica ([`Session::kdm_resets`]) rather than diff against one it no longer
    /// matches.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<Damage> {
        self.flush_kdm();
        let kdm = self.ensure_kdm().ok_or_else(no_replica)?;
        let before = kdm.version();
        match kdm.import_changes(bytes) {
            Ok(damage) => {
                self.follow_kdm();
                Ok(damage)
            }
            Err(error) => {
                if kdm.version() != before {
                    if kdm.view_loaded() {
                        self.follow_kdm();
                    } else {
                        self.detach_kdm();
                    }
                }
                Err(kdm_error(error))
            }
        }
    }

    /// Opens another replica's snapshot (or a full change export) as this session's project: a
    /// fresh KDM identity, with the project the replica holds and a clean history (undo starts
    /// empty; the replica's own undo/redo is rebuilt fresh from a snapshot too, so there is
    /// nothing stale to undo into). [`Session::state`] resets to its usual defaults: the person's
    /// view (open sequences, timeline zoom…) is their view state, which the editor restores
    /// separately with [`Session::restore_project_view`].
    pub fn open_snapshot(&mut self, bytes: &[u8]) -> Result<()> {
        let kdm = FilmSession::open_snapshot(bytes, self.peer_blobs.clone()).map_err(kdm_error)?;
        let project = view_of(&kdm, self.project.next_id);
        self.project = project.clone();
        self.synced = project;
        self.kdm = Some(kdm);
        self.kdm_resets = 0;
        self.origin = None;
        self.history = crate::History { limit: self.history.limit, ..Default::default() };
        self.other_history = self.history.clone();
        self.history_scope = UndoScope::Person;
        self.state = crate::EditorState { snapping: true, linked_selection: true, ..Default::default() };
        self.fix_state();
        self.revision += 1;
        // A freshly opened replica is clean, the same as a freshly opened file
        // (`install_project`'s own `clean` case): nothing needs saving until an edit changes it.
        self.saved_revision = self.revision;
        self.events.push(Event::ProjectChanged { revision: self.revision });
        Ok(())
    }

    /// [`Session::open_snapshot`] for the `.kfilm` `kition_film_bytes`, opened on its first
    /// sequence (a file keeps no view; the editor restores the person's view state after). For a
    /// host that keeps a document's KDM replica apart from its
    /// saved project file (the kit container Task 3's SDK class reads). The host vouches
    /// that the two were saved together, but the file is what the person saved: when the replica
    /// does not hold the file's content (compared id-blind, [`FilmSession::holds`]) the file
    /// wins — its content is recorded onto the replica as one `import` transaction (not an undo
    /// step), keeping the replica's own document identity, so collaborators get it as ordinary
    /// changes. A file that cannot be written to a replica at all is an error (the host opens it
    /// plainly).
    pub fn open_with_replica(&mut self, kition_film_bytes: &[u8], snapshot: &[u8]) -> Result<()> {
        let mut loaded = kition_film_format::decode(kition_film_bytes).map_err(|error| EngineError::Other(error.to_string()))?;
        loaded.project.next_id =
            loaded.project.next_id.max(loaded.project.minimum_next_id(true).ok_or_else(|| EngineError::Other("project id space exhausted".into()))?);
        self.open_snapshot(snapshot)?;
        let kdm = self.kdm.as_mut().ok_or_else(no_replica)?;
        if kdm.holds(&loaded.project).map_err(kdm_error)? {
            self.open_first_sequence();
            return Ok(());
        }
        kdm.replace(&Origin::system("import"), &loaded.project).map_err(kdm_error)?;
        let project = Arc::new(loaded.project);
        self.project = project.clone();
        self.synced = project;
        self.fix_state();
        self.open_first_sequence();
        self.revision += 1;
        self.saved_revision = self.revision;
        self.events.push(Event::ProjectChanged { revision: self.revision });
        Ok(())
    }

    /// Writes whatever the project changed since [`Session::synced`] as one transaction (lazily
    /// making the replica if there is none yet), for callers (the replica passthroughs above, and
    /// `file.saveAs`'s rename, which bypasses the undo history: "not an edit") that need the
    /// replica current before reading or writing it directly, outside of [`Session::execute`]'s
    /// own per-command flush. Without this, such a change would vanish the moment
    /// [`Session::step_kdm`] next replaces the project wholesale with the replica's own
    /// reconstruction (an undo/redo with nothing in between), instead of surviving folded
    /// (best-effort, uncounted as its own step) into whichever edit is on top of the undo stack.
    pub(crate) fn flush_kdm(&mut self) {
        if Arc::ptr_eq(&self.synced, &self.project) {
            return;
        }
        self.open_or_close_kdm_group(false);
        let origin = self.origin();
        let after = self.project.clone();
        let steps = self.record_kdm(&origin, &after);
        if steps > 0
            && let Some(top) = self.history.undo.last_mut()
        {
            top.2 = top.2.saturating_add(steps);
        }
    }

    /// After [`Session::execute`] runs one top-level command (or [`Session::poll_persistence`]
    /// applies a background job's result outside any command): replicates what it changed as one
    /// transaction per new history entry it pushed (normally exactly one), found by
    /// [`crate::History`]'s push counters rather than the stack's length (at the limit a push
    /// drops the oldest entry, leaving the length unchanged). A change that pushed no entry of its
    /// own is added to the top entry, unless it is a live trim-mode gesture not committed to an
    /// entry yet (deferred to its commit). `before` is where the history stood before.
    pub(crate) fn sync_kdm_after_command(&mut self, before: crate::HistoryMark) {
        if Arc::ptr_eq(&self.synced, &self.project) {
            return;
        }
        let origin = self.origin();
        let merging = self.history.merge_key.is_some();
        let pushed = self.history.pushed_since(before);
        if pushed.is_empty() {
            // Whether this is a continuation of the open coalescing group (left open by the
            // group's first call, below) is asked of the replica's own group, not of
            // `self.history.merge_key`: a command that ends the group itself (clearing the key
            // before returning, so the *next*, unrelated edit does not join it — multicam's
            // `record_stop`, among others) is still that same group's own last transaction, due
            // now, not a live gesture deferred to a commit that will never come.
            //
            // Otherwise only a live, uncommitted trim-mode gesture (a `trim.tick`) is deferred to
            // its own commit, which will diff against this same `synced` and capture the whole
            // change. Anything else is added to the top entry: a command that pushes and pops
            // again to fold its edit into the entry below (Edit Text's typing, a template
            // export's bookkeeping) — deferring it would hand it to the next, unrelated command,
            // whose undo would then take it back too.
            if !self.kdm.as_ref().is_some_and(FilmSession::group_open) && self.trim_play.active() {
                return;
            }
            let after = self.project.clone();
            let steps = self.record_kdm(&origin, &after);
            if let Some(top) = self.history.undo.last_mut() {
                top.2 = top.2.saturating_add(steps);
            }
            return;
        }
        let end = pushed.end;
        for i in pushed {
            let after = self.history.undo.get(i + 1).map(|e| e.1.clone()).unwrap_or_else(|| self.project.clone());
            if Arc::ptr_eq(&self.synced, &after) {
                continue;
            }
            let is_last = i + 1 == end;
            // The replica must exist before deciding the group: `begin_undo_group`'s first call
            // on a lazily-made replica would otherwise be silently skipped (no replica yet to
            // hold it), and `record_kdm`'s own lazy creation runs too late for that decision.
            self.ensure_kdm_baseline();
            self.open_or_close_kdm_group(is_last && merging);
            let steps = self.record_kdm(&origin, &after);
            if let Some(e) = self.history.undo.get_mut(i) {
                e.2 = steps;
            }
        }
    }

    /// Makes the replica now, baselined on [`Session::synced`], if there is none yet. A no-op
    /// once one exists; a creation failure just leaves it `None` (the caller's own write attempt
    /// will report/handle that).
    fn ensure_kdm_baseline(&mut self) {
        if self.kdm.is_none()
            && let Ok(kdm) = FilmSession::create(&self.synced)
        {
            self.kdm = Some(kdm);
        }
    }

    /// Begins a fresh coalescing undo group (ending any open one) when `open_new`, else just ends
    /// whatever is open. A no-op before the replica exists: its first transaction needs no group
    /// either way.
    fn open_or_close_kdm_group(&mut self, open_new: bool) {
        let Some(kdm) = self.kdm.as_mut() else { return };
        if open_new {
            let _ = kdm.begin_undo_group();
        } else {
            kdm.end_undo_group();
        }
    }

    /// Writes `after` as one transaction on top of the replica (made now, baselined on
    /// [`Session::synced`], if there is none), and answers the undo steps that took. A refused
    /// write or creation leaves the project exactly as it is and drops the replica
    /// ([`Session::detach_kdm`]); the diff is not lost, it is simply not replicated this time
    /// (the next edit's fresh replica is baselined on the project as it is by then, which already
    /// holds it).
    fn record_kdm(&mut self, origin: &Origin, after: &Arc<Project>) -> u32 {
        if self.kdm.is_none()
            && let Ok(kdm) = FilmSession::create(&self.synced)
        {
            self.kdm = Some(kdm);
        }
        let Some(kdm) = self.kdm.as_mut() else {
            self.synced = after.clone();
            return 0;
        };
        match kdm.record(origin, after) {
            Ok(steps) => {
                self.synced = after.clone();
                steps
            }
            Err(_) => {
                self.detach_kdm();
                0
            }
        }
    }

    /// The replica refused the project: leave it (see [`Session::kdm_resets`]).
    ///
    /// Every history step's replica undo-step count is cleared with it: those steps were the
    /// dropped replica's, and a fresh one never holds them (undoing them on it would undo its own
    /// unrelated steps instead).
    fn detach_kdm(&mut self) {
        self.kdm = None;
        self.kdm_resets += 1;
        self.synced = self.project.clone();
        for entry in self.history.undo.iter_mut().chain(self.history.redo.iter_mut()) {
            entry.2 = 0;
        }
    }

    /// Undoes (or redoes) `steps` replica transactions and makes the result (merged with any
    /// collaborator's edits that arrived since) the project, in place of the engine's own
    /// snapshot [`Session::undo`]/[`Session::redo`] already set it to. No replica at all leaves
    /// that snapshot as the project, exactly as before KDM. With a replica, `steps == 0` is a
    /// step the replica holds nothing of to undo (one that changed nothing the replica keeps, or
    /// one from before a reset): the project is the replica's current view, not the snapshot —
    /// which predates any collaborator's edits imported since, and would silently drop them from
    /// this project while the replica keeps them. A replica that refuses mid-way, or runs out, resets
    /// it.
    ///
    /// The engine's history stays in step with the replica's by what each replica call took off
    /// its stack ([`kdm_model::kition_kit::kdm::UndoOutcome`]): a replica step with nothing left
    /// to change (its objects deleted since, by an agent or an import) is passed over, and the
    /// call goes on to the step below it, which belongs to the history entry below this one. Such
    /// entries leave the history with this one ([`take_steps_below`]): the replica brings them
    /// back together, as the one step this entry now counts on the other stack. A replica whose
    /// history no longer holds the entry's steps (it keeps fewer steps than the engine) is left,
    /// as before: the project is the entry's own snapshot.
    ///
    /// `floor` is the project's `next_id` before the step: the replica's own reconstruction never
    /// lowers it (see [`view_of`]).
    pub(crate) fn step_kdm(&mut self, steps: u32, undo: bool, floor: u64) {
        if steps == 0 {
            if let Some(kdm) = self.kdm.as_ref() {
                self.project = view_of(kdm, floor);
            }
            self.synced = self.project.clone();
            return;
        }
        let Some(kdm) = self.kdm.as_mut() else {
            self.synced = self.project.clone();
            return;
        };
        let scope = self.history_scope;
        let mut owed = usize::try_from(steps).unwrap_or(usize::MAX);
        let mut made = 0u32;
        let mut beyond = 0usize;
        while owed > 0 {
            let outcome = match if undo { kdm.undo_in(scope) } else { kdm.redo_in(scope) } {
                Ok((outcome, _)) => outcome,
                Err(_) => {
                    self.detach_kdm();
                    return;
                }
            };
            let took = outcome.steps();
            if took == 0 {
                // The replica's history no longer reaches the entry's steps (it keeps fewer steps
                // than the engine's): the project is the entry's own snapshot, and it leaves the
                // replica, as a refused step does.
                self.detach_kdm();
                return;
            }
            made = made.saturating_add(u32::from(outcome.is_done()));
            beyond = took.saturating_sub(owed);
            owed = owed.saturating_sub(took);
        }
        let (moved, below) = if undo { (&mut self.history.redo, &mut self.history.undo) } else { (&mut self.history.undo, &mut self.history.redo) };
        if let Some(entry) = moved.last_mut() {
            entry.2 = made;
        }
        take_steps_below(below, beyond);
        self.project = view_of(kdm, floor);
        self.synced = self.project.clone();
    }

    /// Takes a draft's changes (made on a replica forked from this one, `mergeChanges`) into the
    /// project as one undo step of the person (unless `origin` is a `system` or `import` one, as
    /// the replica counts it), as a command's edit is: changes not written yet are written first,
    /// the project and the person's state follow the replica, and one undo takes the whole draft
    /// back. Add the draft's blobs first ([`Session::add_blobs`]). A refused merge changes nothing.
    pub fn merge_draft(&mut self, bytes: &[u8], origin: &Origin) -> Result<Damage> {
        let scope = UndoScope::of(origin.kind).map(|_| UndoScope::Person);
        self.take_in(scope, "Merge Draft", |kdm| kdm.merge_changes(bytes, origin))
    }

    /// Writes the state a snapshot holds (a checkpoint of this project, `replica/restore`) over
    /// the project by object id, as one undo step of `origin`'s scope, taken in as a merged draft
    /// is ([`Session::merge_draft`]). Nothing changes when the states are equal; another
    /// document's snapshot is refused. Add the blobs it references first.
    pub fn restore_version(&mut self, snapshot: &[u8], origin: &Origin) -> Result<Damage> {
        let scope = UndoScope::of(origin.kind);
        self.take_in(scope, "Restore Version", |kdm| kdm.restore_state(snapshot, origin))
    }

    /// One transaction `write` makes on the replica, taken into the project as a command's step:
    /// the project follows the replica, and the history of `scope` (none for a `system` or
    /// `import` origin) gets an entry worth the one replica undo step. A write that failed after
    /// its transaction landed (its repair refused) still follows the replica when the view loaded
    /// from it, as an import does; otherwise the project leaves the replica.
    fn take_in(
        &mut self,
        scope: Option<UndoScope>,
        label: &str,
        write: impl FnOnce(&mut FilmSession) -> kdm_model::kition_kit::session::Result<Damage>,
    ) -> Result<Damage> {
        let kdm = self.ensure_kdm().ok_or_else(no_replica)?;
        kdm.end_undo_group();
        let before = kdm.version();
        let result = write(&mut *kdm);
        let changed = kdm.version() != before;
        let loaded = changed && (result.is_ok() || kdm.view_loaded());
        if loaded {
            let previous = self.project.clone();
            self.follow_kdm();
            if let Some(scope) = scope {
                let history = if scope == self.history_scope { &mut self.history } else { &mut self.other_history };
                history.push((label.to_owned(), previous, 1));
                history.redo.clear();
            }
        } else if changed {
            self.detach_kdm();
        }
        result.map_err(kdm_error)
    }

    /// After an import: the project follows the replica, and per-person state that named
    /// something an import removed (a selected clip, the active sequence) moves on, as
    /// [`Session::fix_state`] already does for undo/redo.
    fn follow_kdm(&mut self) {
        let Some(kdm) = self.kdm.as_ref() else { return };
        let project = view_of(kdm, self.project.next_id);
        self.project = project.clone();
        self.synced = project;
        self.history.merge_key = None;
        self.fix_state();
        self.bump();
    }
}

/// The replica's view as the session's project, with a `next_id` never below `floor` (the
/// session's own counter before it took the view). The replica's reconstruction counts only the
/// ids the replica still holds (`kdm_model`'s `next_id_hint`), but an id this session handed out
/// may live on where the replica cannot see it — in an undo or redo step the reload replaced —
/// and must never be handed out again.
fn view_of(kdm: &FilmSession, floor: u64) -> Arc<Project> {
    let mut project = kdm.project().clone();
    project.next_id = project.next_id.max(floor);
    Arc::new(project)
}

/// Takes `beyond` replica steps off the history entries on top of `stack` (the ones below the
/// entry just undone or redone): the replica took them with that entry, passed over or taken back
/// together with it. An entry left with none leaves the history; one the replica took only some
/// steps of keeps the rest. An entry that holds no replica step stays where it is.
fn take_steps_below(stack: &mut Vec<(String, Arc<Project>, u32)>, mut beyond: usize) {
    let mut at = stack.len();
    while beyond > 0 && at > 0 {
        at -= 1;
        let Some(entry) = stack.get_mut(at) else { break };
        let held = usize::try_from(entry.2).unwrap_or(usize::MAX);
        if held == 0 {
            continue;
        }
        if held <= beyond {
            beyond -= held;
            stack.remove(at);
        } else {
            entry.2 = u32::try_from(held - beyond).unwrap_or(u32::MAX);
            beyond = 0;
        }
    }
}

/// The undo scope `origin`'s steps join (KitModel 1.1 M12a): the agents' for an agent, else the
/// person's (imports and repairs are no undo steps and record nothing in a history).
pub(crate) fn scope_of(origin: &Origin) -> UndoScope {
    UndoScope::of(origin.kind).unwrap_or(UndoScope::Person)
}
