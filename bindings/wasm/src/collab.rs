//! Kition's collaboration members (engine contract 2, Kition phase 3b Task 3): the project as a
//! KDM replica.
//!
//! The engine keeps its own `Session` (the command bridge to the replica,
//! `kition_film_engine::kdm_bridge`), not a `kition_kit::session::KitSession` directly, so
//! `kition_kit::export_kit_session!` does not apply here; these members are added by hand with
//! the exact JS names and shapes `kition-sdk`'s `session::web` gives
//! (`crates/kition-kit/src/session/web.rs`), so Kition's host code is the same for every kit. The
//! wasm bindings live in [`crate::web`].
//!
//! Media are referenced by path, never embedded; the replica's only blobs are the text of the
//! project's LUTs. [`FilmDocument::blobs`] answers them and [`FilmDocument::add_blobs`] takes a
//! peer's, as a host's generic replica code expects.

use std::sync::Arc;

use kition_film_engine::{Damage, Origin, Session, Version};
use kition_kit::KitDocument;
use serde_json::Value;

use crate::{FilmDocument, KitServices};

impl FilmDocument {
    /// Opens a file with the replica a host stored for it (the Kit UI protocol's `replica`
    /// capability: `.kfilm` cannot carry its own replica, the same as a PSD cannot): the project
    /// is the replica's, so it keeps its KDM identity across saves. The host vouches that the
    /// replica was saved with these bytes (their stamps match). A replica that does not open
    /// (damaged, a newer schema) is ignored and the file opens as [`FilmDocument::open`] opens
    /// it.
    ///
    /// Empty `bytes` mean there is no file yet, only the replica (a host opening a shared
    /// project for the first time from its sync room's snapshot, to save it as a new file): the
    /// project is the replica's alone, as `PhotoDocument::open_with_replica` already does.
    pub fn open_with_replica(name: &str, bytes: &[u8], snapshot: &[u8], blobs: &[u8]) -> Result<Self, String> {
        let services = Arc::new(KitServices::default());
        let restored = (|| -> Result<Session, String> {
            let mut session = Session::for_host(services.clone());
            session.add_blobs(blobs).map_err(|error| error.to_string())?;
            if bytes.is_empty() {
                session.open_snapshot(snapshot).map_err(|error| error.to_string())?;
                // No file, so no saved view either: the first sequence is open, as for a file without one.
                let first = session.project.sequences().next().map(|item| item.id);
                session.state.active_sequence = first;
                session.state.open_sequences = first.into_iter().collect();
            } else {
                session.open_with_replica(bytes, snapshot).map_err(|error| error.to_string())?;
            }
            // The new project is the active one, as after `open`, and is saved to `name`.
            session.path = Some(name.to_owned());
            Ok(session)
        })();
        match restored {
            Ok(session) => {
                let mut doc = Self { session, name: name.to_owned(), services };
                doc.settle();
                Ok(doc)
            }
            Err(_) => Self::open(name, bytes),
        }
    }

    /// Whether the project has made its replica yet: it makes one lazily, on the first shared
    /// edit or when asked for it ([`FilmDocument::version`] and the rest).
    pub fn has_replica(&self) -> bool {
        self.session.kdm().is_some()
    }

    /// The replica's own document id (a `kition-sdk` `DocId`, stable across saves and across
    /// opening another replica of the same document — never Film's own `.kfilm` path/`name`):
    /// Kit UI's generic runtime reads this for the Kit UI protocol's `replica/info` message.
    /// `None` (`undefined` in JS, through [`crate::web`]) before the project has made a replica
    /// yet ([`FilmDocument::has_replica`]).
    pub fn doc_id(&self) -> Option<String> {
        self.session.kdm().map(|kdm| kdm.replica().doc_id().to_string())
    }

    /// The project's replica version (empty before it has made one).
    pub fn version(&mut self) -> Result<Vec<u8>, String> {
        Ok(self.session.version().map_err(|error| error.to_string())?.encode())
    }

    /// The project's changes since `since` (empty bytes: every change).
    pub fn export_changes(&mut self, since: &[u8]) -> Result<Vec<u8>, String> {
        let since = if since.is_empty() { Version::empty() } else { Version::decode(since).map_err(|error| error.to_string())? };
        self.session.export_changes(&since).map_err(|error| error.to_string())
    }

    /// Imports a peer's (or stored) changes. Answers what went stale on screen: always a full
    /// repaint, the engine tracks no finer damage on its replica.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<Damage, String> {
        let damage = self.session.import_changes(bytes).map_err(|error| error.to_string())?;
        self.settle();
        Ok(damage)
    }

    /// The project's replica as a snapshot, for a peer to open as a new replica of the same
    /// project ([`FilmDocument::open`]'ing the saved bytes does not: `.kfilm` carries no
    /// replica).
    pub fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        self.session.snapshot().map_err(|error| error.to_string())
    }

    /// Undoes the project's last local step on its replica. `done` is `false`, not an error, when
    /// there is nothing to undo.
    pub fn undo(&mut self) -> Result<(bool, Damage), String> {
        let done = self.session.undo().is_some();
        if done {
            self.settle();
        }
        Ok((done, if done { Damage::Full } else { Damage::None }))
    }

    pub fn redo(&mut self) -> Result<(bool, Damage), String> {
        let done = self.session.redo().is_some();
        if done {
            self.settle();
        }
        Ok((done, if done { Damage::Full } else { Damage::None }))
    }

    pub fn can_undo(&self) -> bool {
        self.session.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.session.history.can_redo()
    }

    /// Runs a command as `origin` (a person, an agent): the replica records it as theirs, and it
    /// undoes as that replica's own step. Contract 1's [`FilmDocument::execute`](kition_kit::KitDocument::execute)
    /// is this with the local person.
    ///
    /// Anyone but a person (an agent, a script's `model.batch`) runs only the commands an agent
    /// may run ([`crate::files::refuse_for_agent`]): `model.batch` runs commands the agent is not
    /// offered, so the check is here, where every call arrives. (A batch may claim a person's
    /// origin: the engine's [`Session::host_files_only`] keeps those calls off the file system.)
    pub fn execute_as(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        if origin.kind != kition_kit::kdm::OriginKind::Person || crate::files::AGENT_EXCLUDED.contains(&command) {
            crate::files::refuse_for_agent(command)?;
        }
        self.refuse_unknown(command, &params)?;
        if command == crate::render::RENDER {
            return crate::render::render(&self.session, &params);
        }
        // An agent's command given what it acts on or when leaves the open sequence, the
        // playheads, the Source monitor, the track targets and the selections as they were,
        // whatever it moved on the way, also when it fails; only a command whose work is moving
        // them keeps its effect. A person's commands keep the editor's own behaviour (placing a
        // clip selects it).
        let kept = (origin.kind != kition_kit::kdm::OriginKind::Person && crate::acts::names_what_or_when(&params) && !crate::acts::moves_the_editor(command))
            .then(|| self.session.call_state());
        let result = self.session.execute_as(command, params, origin).map_err(crate::command_failure);
        if let Some(kept) = kept {
            self.session.restore_call_state(&kept);
        }
        let result = result?;
        self.settle();
        Ok(result)
    }

    /// Every blob the project's replica references (the text of its LUTs), encoded for a peer's
    /// [`FilmDocument::add_blobs`].
    pub fn blobs(&mut self) -> Result<Vec<u8>, String> {
        self.session.blobs().map_err(|error| error.to_string())
    }

    /// Adds a peer's blobs (from their [`FilmDocument::blobs`]), for the changes a host imports
    /// right after.
    pub fn add_blobs(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.session.add_blobs(bytes).map_err(|error| error.to_string())
    }

    /// How many times the project left its replica because it refused a write or an undo (a
    /// project it cannot hold, or a bug). The project keeps working, undoing from its own
    /// history; the next shared edit makes a fresh replica, which collaborators must resync (its
    /// full [`FilmDocument::snapshot`]). Hosts watch this.
    pub fn kdm_resets(&self) -> u32 {
        u32::try_from(self.session.kdm_resets()).unwrap_or(u32::MAX)
    }
}

/// The object model (`KitObjectModel 1.0`) over the document's change exchange, for `kition-film`
/// served headless: `model.describe` and `model.batch` through
/// `kition_kit::session::model::Exchange`, the replica methods (`model.open`, `model.import`,
/// `model.export`), and an agent's call run as the agent (KHP A11).
impl kition_kit::session::model::ReplicaPort for FilmDocument {
    fn model_schema(&self) -> Arc<kition_kit::kdm::Schema> {
        <kdm_model::FilmModel as kition_kit::session::KitModel>::schema()
    }

    fn model_export(&mut self, since: &[u8]) -> Result<Vec<u8>, String> {
        self.export_changes(since)
    }

    fn model_import(&mut self, bytes: &[u8]) -> Result<(), String> {
        use kition_kit::kdm::{ActorId, Replica};
        let snapshot = self.snapshot()?;
        let before = Replica::load(self.model_schema(), &snapshot, ActorId::random()).map_err(|e| e.to_string())?;
        let mut after = Replica::load(self.model_schema(), &snapshot, ActorId::random()).map_err(|e| e.to_string())?;
        after.import_changes(bytes).map_err(|e| e.to_string())?;
        let blobs = kdm_model::decode_blobs(&self.blobs()?).map_err(|e| e.to_string())?;
        kdm_model::check_model_edits(&before, &after, &blobs).map_err(|e| e.to_string())?;
        self.import_changes(bytes).map(|_| ())
    }

    fn model_command(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        self.execute_as(command, params, origin)
    }

    fn model_commands(&self) -> Vec<kition_kit::KitCommand> {
        self.commands()
    }

    /// A shared project with no file yet (a server's headless kit opening a sync room): the
    /// replica alone, failing rather than falling back to an empty project as
    /// [`FilmDocument::open_with_replica`] does. `blobs` hold the text of the replica's LUTs.
    fn model_open_replica(name: &str, snapshot: &[u8], blobs: &[u8]) -> Result<Self, String> {
        if snapshot.is_empty() {
            return Err("no replica to open".into());
        }
        let services = Arc::new(KitServices::default());
        let mut session = Session::for_host(services.clone());
        session.add_blobs(blobs).map_err(|error| error.to_string())?;
        session.open_snapshot(snapshot).map_err(|error| error.to_string())?;
        let first = session.project.sequences().next().map(|item| item.id);
        session.state.active_sequence = first;
        session.state.open_sequences = first.into_iter().collect();
        session.path = Some(name.to_owned());
        let mut doc = Self { session, name: name.to_owned(), services };
        doc.settle();
        Ok(doc)
    }
}

#[cfg(test)]
mod tests {
    use kition_kit::KitDocument;
    use serde_json::json;

    use super::*;

    /// A 64 x 36 project with a four-second red colour matte on V1 at 0s: no media files needed.
    fn fixture() -> Vec<u8> {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({"color": "#ff0000", "seconds": 4.0})).unwrap();
        doc.execute("timeline.place", json!({"item": matte["item"], "track": "V1", "seconds": 0.0})).unwrap();
        doc.save(None).unwrap()
    }

    fn extra_edit(doc: &mut FilmDocument) {
        let matte = doc.execute("file.newColorMatte", json!({"color": "#0000ff", "seconds": 2.0})).unwrap();
        doc.execute("timeline.place", json!({"item": matte["item"], "track": "V1", "seconds": 4.0})).unwrap();
    }

    #[test]
    fn version_and_snapshot_force_a_replica_lazily() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(!doc.has_replica(), "opening an .kfilm plainly makes no replica");
        let version = doc.version().unwrap();
        assert!(doc.has_replica());
        assert_eq!(doc.version().unwrap(), version, "asking twice makes no further replica");
        let snap = doc.snapshot().unwrap();
        assert!(!snap.is_empty());
    }

    #[test]
    fn undo_redo_report_done_and_damage() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(!doc.can_undo());
        // One history entry (unlike `extra_edit`'s two), so one `undo()` clears it.
        doc.execute("sequence.addTracks", json!({})).unwrap();
        assert!(doc.can_undo());
        let (done, damage) = doc.undo().unwrap();
        assert!(done);
        assert_ne!(damage, Damage::None);
        assert!(!doc.can_undo());
        assert!(doc.can_redo());
        let (done, _) = doc.redo().unwrap();
        assert!(done);
        // Undoing with nothing to undo is a normal `false`, not an error.
        doc.undo().unwrap();
        let (done, damage) = doc.undo().unwrap();
        assert!(!done);
        assert_eq!(damage, Damage::None);
    }

    /// Every item id under the project's root, in tree order (a duplicate means a corrupt tree).
    fn root_ids(doc: &FilmDocument) -> Vec<u64> {
        fn walk(node: &Value, out: &mut Vec<u64>) {
            if let Some(id) = node.get("item").and_then(Value::as_u64) {
                out.push(id);
            }
            for child in node.get("children").and_then(Value::as_array).into_iter().flatten() {
                walk(child, out);
            }
        }
        let mut out = Vec::new();
        walk(&crate::inspect_session(&doc.session)["project"]["root"], &mut out);
        out
    }

    /// The person and the agent each undo their own steps (KitModel 1.1 M12a): the agent taking
    /// back its item after the person took back theirs leaves the rest of the project as it was,
    /// each item listed once.
    #[test]
    fn undo_in_two_histories_keeps_each_item_once() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let person = Origin::person("user:person");
        let agent = Origin::agent("agent:flow");
        let before = root_ids(&doc);
        let tone = doc.execute_as("file.newOfflineFile", json!({ "name": "Tone", "video": false, "audio": true, "seconds": 3 }), &agent).unwrap();
        doc.execute_as("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 2.0 }), &person).unwrap();
        doc.execute_as("edit.undo", json!({}), &person).unwrap();
        doc.execute_as("edit.undo", json!({}), &agent).unwrap();
        let after = root_ids(&doc);
        let mut unique = after.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), after.len(), "an item listed twice: {after:?}");
        assert!(!after.contains(&tone["item"].as_u64().unwrap()), "the agent's item is gone: {after:?}");
        assert_eq!(after, before, "the project is as it was");
    }

    #[test]
    fn execute_as_records_the_given_origin() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let origin = Origin::person("user:agent-1");
        doc.execute_as("sequence.addTracks", json!({}), &origin).unwrap();
        assert!(doc.can_undo());
    }

    /// `docId` is `None` before any replica exists, and the replica's own id (not the file's
    /// `name`, and stable across a save/reopen with that same replica) once one does.
    #[test]
    fn doc_id_is_none_until_a_replica_exists_then_the_replicas_own_id() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert_eq!(doc.doc_id(), None, "no replica yet");
        doc.version().unwrap(); // makes the replica lazily
        let id = doc.doc_id().unwrap_or_else(|| panic!("doc_id should be set once a replica exists"));
        assert!(!id.is_empty());
        assert_eq!(doc.doc_id().as_deref(), Some(id.as_str()), "stable across further asks");

        let bytes = doc.save(None).unwrap();
        let snapshot = doc.snapshot().unwrap();
        let reopened = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &[]).unwrap();
        assert_eq!(reopened.doc_id(), Some(id), "the reopened replica keeps the same document id");
    }

    /// With no file yet (empty bytes), the replica alone opens: a peer's full change export
    /// becomes the same project, same identity and version, and it saves as a new `.kfilm`.
    #[test]
    fn a_replica_opens_without_a_file() {
        let mut a = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        extra_edit(&mut a);
        let changes = a.export_changes(&[]).unwrap();
        let mut b = FilmDocument::open_with_replica("Shared.kfilm", &[], &changes, &[]).unwrap();
        assert_eq!(b.doc_id(), a.doc_id());
        assert_eq!(b.version().unwrap(), a.version().unwrap());
        assert_eq!(b.session.state_hash().unwrap(), a.session.state_hash().unwrap());
        assert!(!b.dirty());
        assert!(b.session.state.active_sequence.is_some(), "the project's sequence is open");
        assert!(kition_film_format::decode(&b.save(None).unwrap()).is_ok());
        assert!(FilmDocument::open_with_replica("Shared.kfilm", &[], b"not a replica", &[]).is_err());
    }

    /// A project without LUTs has no blobs; blobs that are not what `blobs` encodes are refused.
    #[test]
    fn blobs_are_the_luts_text() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert_eq!(doc.blobs().unwrap(), Vec::<u8>::new());
        doc.add_blobs(&[]).unwrap();
        assert!(doc.add_blobs(&[1, 2, 3]).is_err(), "a truncated blob");
    }

    /// An `.kfilm` saved with its replica reopens as that replica: same version, same state, the
    /// same frame, not dirty, and it takes new edits (which undo) at once.
    #[test]
    fn a_project_reopens_with_its_stored_replica() {
        let mut a = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        extra_edit(&mut a);
        let bytes = a.save(None).unwrap();
        let (snapshot, blobs) = (a.snapshot().unwrap(), a.blobs().unwrap());
        let version = a.version().unwrap();

        let mut b = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &blobs).unwrap();
        assert!(b.has_replica());
        assert_eq!(b.version().unwrap(), version);
        assert_eq!(b.session.state_hash().unwrap(), a.session.state_hash().unwrap());
        assert_eq!(b.render(0.0, 0.0, 1.0, 64, 36).unwrap(), a.render(0.0, 0.0, 1.0, 64, 36).unwrap());
        assert!(!b.dirty());
        assert!(!b.can_undo());
        extra_edit(&mut b);
        assert!(b.dirty());
        assert_ne!(b.version().unwrap(), version);
        assert!(b.undo().unwrap().0);
        let saved = b.save(None).unwrap();
        assert!(kition_film_format::decode(&saved).is_ok(), "it still saves as an .kfilm");
    }

    /// A damaged (or missing) stored replica never stops the file from opening: it opens
    /// plainly, never as a blank project.
    #[test]
    fn a_damaged_stored_replica_opens_the_file_plainly() {
        let bytes = fixture();
        let a = FilmDocument::open("Edit.kfilm", &bytes).unwrap();
        for snapshot in [&b"not a snapshot"[..], &[][..]] {
            let doc = FilmDocument::open_with_replica("Edit.kfilm", &bytes, snapshot, &[]).unwrap();
            assert_eq!((doc.width(), doc.height()), (a.width(), a.height()));
            assert!(!doc.has_replica(), "the file opened plainly");
        }
        assert!(FilmDocument::open_with_replica("Edit.kfilm", b"not a project", b"not a snapshot", &[]).is_err());
    }

    /// `a` saves with its replica; `b` opens with it, so both start from the same replica
    /// identity. `a` edits further;
    /// `b.importChanges(a.exportChanges(b.version()))` converges `b` to the same replicated
    /// state as `a`, through the public SDK surface alone.
    #[test]
    fn two_documents_converge_through_export_and_import_changes() {
        let mut a = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        extra_edit(&mut a);
        let bytes = a.save(None).unwrap();
        let snapshot = a.snapshot().unwrap();

        let mut b = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &[]).unwrap();
        assert_eq!(b.version().unwrap(), a.version().unwrap(), "b starts from a's own replica");

        a.execute("sequence.addTracks", json!({})).unwrap();

        let since = b.version().unwrap();
        let changes = a.export_changes(&since).unwrap();
        b.import_changes(&changes).unwrap();

        assert_eq!(a.session.state_hash().unwrap(), b.session.state_hash().unwrap());
        assert_eq!(a.version().unwrap(), b.version().unwrap());
    }
}
