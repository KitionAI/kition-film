//! The engine members of contract 2 beyond the change exchange (platform rule K3a): a draft's
//! merge and its comparison, a restored version, the receipt of what changed since a version, an
//! agent's reply in tool ids, and the object model (`model/describe`, `model/batch`), with the
//! names and shapes `kition-sdk`'s `export_kit_session!` gives them (the wasm bindings are in
//! [`crate::web`]). The engine's command bridge takes a merged draft or a restored version in as
//! one undo step, as a command's edit (`Session::merge_draft`, `Session::restore_version`): the
//! project, the person's state and the history follow the replica, and one Undo takes it back.

use kition_film_engine::{Damage, Origin, Version};
use kition_kit::kdm::diff::diff_states;
use kition_kit::kdm::tool_ids::ToolIds;
use kition_kit::session::model::Exchange;
use serde_json::{Value, json};

use crate::FilmDocument;

impl FilmDocument {
    /// The replicated state, the replica made first if there is none yet.
    fn replicated_state(&mut self) -> Result<Value, String> {
        self.session.version().map_err(|error| error.to_string())?;
        let kdm = self.session.kdm().ok_or("the project has no replica")?;
        kdm.replica().state_json().map_err(|error| error.to_string())
    }

    /// Takes a draft's changes (from a replica forked from this one) in as one undo step of the
    /// person (`mergeChanges`): the engine's project follows, and Undo takes the whole draft back.
    /// Add the draft's blobs first. Answers `{"damage", "summary"}`, `summary` the `StateDiff` of
    /// the replicated state before and after. A refused merge changes nothing and fails with the
    /// KDM's message.
    pub fn merge_changes(&mut self, bytes: &[u8], origin: &Origin) -> Result<Value, String> {
        let before = self.replicated_state()?;
        let merged = self.session.merge_draft(bytes, origin);
        self.settle();
        let damage = merged.map_err(|error| error.to_string())?;
        let after = self.replicated_state()?;
        Ok(json!({ "damage": damage, "summary": diff_states(&before, &after).to_json() }))
    }

    /// What merging a draft's changes would change in the project now, as `StateDiff` JSON;
    /// nothing changes. Refuses what [`FilmDocument::merge_changes`] refuses.
    pub fn compare_changes(&self, bytes: &[u8]) -> Result<Value, String> {
        let kdm = self.session.kdm().ok_or("the project has no replica, so no draft of it")?;
        let before = kdm.replica().state_json().map_err(|error| error.to_string())?;
        let after = kdm.replica().merged_state(bytes).map_err(|error| error.to_string())?;
        Ok(diff_states(&before, &after).to_json())
    }

    /// Writes the state a snapshot holds (a checkpoint of this project, the Kit UI protocol's
    /// `replica/restore`) over the project by object id, as one undo step of `origin`'s scope: the
    /// engine's project follows. Add the blobs it references first. Nothing changes when the states
    /// are equal; another document's snapshot is refused.
    pub fn restore_state(&mut self, snapshot: &[u8], origin: &Origin) -> Result<Damage, String> {
        let restored = self.session.restore_version(snapshot, origin);
        self.settle();
        restored.map_err(|error| error.to_string())
    }

    /// What changed since the version `since` (empty bytes: since the replica began), a receipt
    /// as `kition-sdk`'s `changesSince` answers it: `{"changes": StateDiff}`, or `{"changes":
    /// null, "unavailable": "<why>"}` when the replica's log does not hold `since` (or there is no
    /// replica yet).
    pub fn changes_since(&self, since: &[u8]) -> Value {
        let Some(kdm) = self.session.kdm() else { return json!({ "changes": null, "unavailable": "the project has no replica yet" }) };
        let replica = kdm.replica();
        let since = if since.is_empty() { Ok(Version::empty()) } else { Version::decode(since) };
        match since.and_then(|since| replica.changes_since(&since)) {
            Ok(changes) => json!({ "changes": changes.to_recorded_json(replica.schema()) }),
            Err(error) => json!({ "changes": null, "unavailable": error.to_string() }),
        }
    }

    /// An agent's reply (JSON text) with every object id it holds as a value or a key named as
    /// the tool interface names it (its tool id, KitObjectModel OM9); unchanged without a replica.
    /// Text that merely holds an id stays as it is, and the project keeps its own ids. The editor
    /// sends every `ai/inspect` reply through here, so only the objects the reply names are read
    /// (`ToolIds::show_reply`), never the whole project's tool ids.
    pub fn model_reply(&self, value: &str) -> Result<String, String> {
        let value: Value = serde_json::from_str(value).map_err(|error| format!("the reply is not JSON: {error}"))?;
        let Some(kdm) = self.session.kdm() else { return Ok(value.to_string()) };
        Ok(ToolIds::show_reply(kdm.replica(), &value).to_string())
    }

    /// `model/describe` as JSON: the object model over the project's change exchange.
    pub fn model_describe(&mut self) -> Result<Value, Value> {
        Exchange::new().describe(self).map_err(|failure| failure.to_json())
    }

    /// `model/batch`: one batch of the object model (reads, writes, commands) as one undo step; a
    /// failure is the error's JSON (`{"code", "index", "message"}`).
    pub fn model_batch(&mut self, request: &Value) -> Result<Value, Value> {
        let answer = Exchange::new().batch(self, request, false).map_err(|failure| failure.to_json());
        self.settle();
        answer
    }
}

#[cfg(test)]
mod tests {
    use kition_kit::KitDocument;
    use kition_kit::kdm::{ActorId, Replica};
    use serde_json::json;

    use super::*;

    fn fixture() -> Vec<u8> {
        crate::tests::fixture()
    }

    fn person() -> Origin {
        Origin::person("person:local")
    }

    fn items(doc: &FilmDocument) -> usize {
        doc.session.project.items.len()
    }

    fn first_track_name(doc: &FilmDocument) -> String {
        doc.session.active_sequence().unwrap().video_tracks[0].name.clone()
    }

    /// The object ids the replica holds, sorted.
    fn object_ids(doc: &mut FilmDocument) -> Vec<String> {
        let mut ids: Vec<String> = doc.replicated_state().unwrap()["objects"].as_object().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// A draft (a replica forked from the project's) merges in as one step of the person's Undo:
    /// the comparison beforehand names what the merge does and changes nothing, the engine's
    /// project follows the merge, an edit made here meanwhile stays, and a refused merge changes
    /// nothing.
    #[test]
    fn a_draft_merges_in_as_one_undo_step_and_the_project_follows() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let base = doc.version().unwrap();
        let mut draft = FilmDocument::open_with_replica("Edit.kfilm", &[], &doc.snapshot().unwrap(), &doc.blobs().unwrap()).unwrap();
        draft.execute("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 2.0 })).unwrap();
        let changes = draft.export_changes(&base).unwrap();
        doc.execute("timeline.setTrack", json!({ "track": "V1", "name": "Meanwhile" })).unwrap();
        let before = items(&doc);
        let version = doc.version().unwrap();
        let preview = doc.compare_changes(&changes).unwrap();
        assert_eq!(doc.version().unwrap(), version, "comparing changes nothing");
        assert_eq!(items(&doc), before);
        let answer = doc.merge_changes(&changes, &person()).unwrap();
        assert_eq!(answer["summary"], preview, "the comparison named what the merge did: {answer}");
        assert_ne!(answer["damage"], json!("none"), "{answer}");
        assert_eq!(items(&doc), before + 1, "the engine's project follows the merge");
        assert!(doc.dirty());
        assert_eq!(first_track_name(&doc), "Meanwhile", "the edit made here stays");
        assert!(doc.undo().unwrap().0);
        assert_eq!(items(&doc), before, "one undo takes the whole draft back");
        assert_eq!(first_track_name(&doc), "Meanwhile", "and only the draft");
        assert!(doc.redo().unwrap().0);
        assert_eq!(items(&doc), before + 1, "one redo brings it back");
        let at = doc.version().unwrap();
        assert!(doc.merge_changes(b"not changes", &person()).is_err());
        assert!(doc.compare_changes(b"not changes").is_err());
        assert_eq!(doc.version().unwrap(), at, "a refused merge changes nothing");
    }

    /// An earlier state (a checkpoint's snapshot) is written over the project by object id as one
    /// undo step: the replica holds that state again, with the same ids, and Undo takes it back.
    #[test]
    fn a_restored_state_keeps_the_ids_and_undoes_as_one_step() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        doc.version().unwrap();
        let checkpoint = doc.snapshot().unwrap();
        let before = items(&doc);
        doc.execute("file.newColorMatte", json!({ "color": "#0000ff", "seconds": 2.0 })).unwrap();
        assert_eq!(items(&doc), before + 1);
        let damage = doc.restore_state(&checkpoint, &person()).unwrap();
        assert_ne!(damage, Damage::None);
        assert_eq!(items(&doc), before, "the engine's project follows the restore");
        let schema = <kdm_model::FilmModel as kition_kit::session::KitModel>::schema();
        let then = Replica::load(schema, &checkpoint, ActorId::random()).unwrap().state_json().unwrap();
        assert_eq!(doc.replicated_state().unwrap()["objects"], then["objects"], "the checkpoint's objects, under their ids");
        let at = doc.version().unwrap();
        assert_eq!(doc.restore_state(&checkpoint, &person()).unwrap(), Damage::None, "the same state again changes nothing");
        assert_eq!(doc.version().unwrap(), at);
        assert!(doc.undo().unwrap().0);
        assert_eq!(items(&doc), before + 1, "one undo takes the restore back");
        let other = FilmDocument::open("Edit.kfilm", &fixture()).unwrap().snapshot().unwrap();
        assert!(doc.restore_state(&other, &person()).is_err(), "another document's state is refused");
    }

    /// The receipt of what changed since a version, or why there is none.
    #[test]
    fn changes_since_answers_a_receipt_or_why_not() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(doc.changes_since(&[])["changes"].is_null(), "no replica yet");
        let since = doc.version().unwrap();
        doc.execute("timeline.setTrack", json!({ "track": "V1", "name": "Receipt" })).unwrap();
        let receipt = doc.changes_since(&since);
        assert!(receipt["changes"].is_object(), "{receipt}");
        assert!(receipt.to_string().contains("Receipt"), "the edit is in the receipt: {receipt}");
        let now = doc.version().unwrap();
        assert_ne!(receipt["changes"], doc.changes_since(&now)["changes"]);
        let other = FilmDocument::open("Edit.kfilm", &fixture()).unwrap().version().unwrap();
        let refused = doc.changes_since(&other);
        assert!(refused["changes"].is_null() && refused["unavailable"].is_string(), "{refused}");
    }

    /// An agent's reply names objects by their tool ids (an item by its item id); text that
    /// merely holds an object id stays.
    #[test]
    fn a_reply_names_objects_by_their_tool_ids() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert_eq!(doc.model_reply(r#"{"a":1}"#).unwrap(), r#"{"a":1}"#, "without a replica the reply is as it is");
        let state = doc.replicated_state().unwrap();
        let (object, item) = state["objects"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, object)| object["$type"] == "Item")
            .map(|(id, object)| (id.clone(), object["itemId"].as_u64().unwrap()))
            .unwrap_or_else(|| panic!("an item object: {state}"));
        let shown: Value =
            serde_json::from_str(&doc.model_reply(&json!({ "target": object, "note": format!("about {object}") }).to_string()).unwrap()).unwrap();
        assert_eq!(shown["target"], json!(item.to_string()), "{shown}");
        assert_eq!(shown["note"], json!(format!("about {object}")), "text that holds an id stays");
        assert!(doc.model_reply("not json").is_err());
    }

    /// The object model over the project: its types, a read, and a command run as one batch that
    /// the project follows and one Undo takes back.
    #[test]
    fn the_object_model_describes_reads_and_writes() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let described = doc.model_describe().unwrap();
        for ty in ["Project", "Bin", "Item", "Sequence", "Track", "Clip"] {
            assert!(described["types"].get(ty).is_some(), "{ty} in {}", described["types"]);
        }
        let read = doc.model_batch(&json!({ "ops": [], "load": [{ "target": "root" }] })).unwrap();
        assert!(read["loaded"][0]["fields"].is_object(), "{read}");
        let before = items(&doc);
        let origin = json!({ "kind": "person", "principal": "person:local" });
        doc.model_batch(&json!({ "origin": origin, "ops": [{ "op": "command", "id": "file.newColorMatte", "params": { "color": "#0000ff", "seconds": 2 } }] }))
            .unwrap();
        assert_eq!(items(&doc), before + 1, "the batch's command ran on the project");
        assert!(doc.undo().unwrap().0);
        assert_eq!(items(&doc), before, "one undo takes the batch back");
        assert!(doc.model_batch(&json!({ "ops": [{ "op": "no such op" }] })).is_err());
    }

    /// An unchanged project saves the bytes it was opened from, and reopened with its stored
    /// replica it holds the same objects under the same ids, writing nothing.
    #[test]
    fn an_unchanged_project_saves_its_own_bytes_and_reopens_with_the_same_ids() {
        let bytes = fixture();
        let mut doc = FilmDocument::open("Edit.kfilm", &bytes).unwrap();
        let ids = object_ids(&mut doc);
        assert_eq!(doc.save(None).unwrap(), bytes, "an unchanged project saves byte-identical");
        let (snapshot, blobs, version) = (doc.snapshot().unwrap(), doc.blobs().unwrap(), doc.version().unwrap());
        let mut again = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &blobs).unwrap();
        assert_eq!(again.version().unwrap(), version, "reopening writes nothing");
        assert_eq!(object_ids(&mut again), ids, "the same object ids");
        assert!(!again.dirty());
    }
}
