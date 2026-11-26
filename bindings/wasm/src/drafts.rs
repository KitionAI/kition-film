//! The engine members of contract 2 beyond the change exchange (platform rule K3a): a draft's
//! merge and its comparison, a restored version, the receipt of what changed since a version, an
//! agent's reply in tool ids, and the object model (`model/describe`, `model/batch`), with the
//! names and shapes `kition-sdk`'s `export_kit_session!` gives them (the wasm bindings are in
//! [`crate::web`]). The engine's command bridge takes a merged draft or a restored version in as
//! one undo step, as a command's edit (`Session::merge_draft`, `Session::restore_version`): the
//! project, the person's state and the history follow the replica, and one Undo takes it back.

use std::collections::BTreeSet;

use kition_film_engine::{Damage, Origin, UndoScope, Version};
use kition_kit::kdm::diff::diff_states;
use kition_kit::kdm::{ObjectId, Replica};
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
    /// Add the draft's blobs first. Answers `{"damage", "summary", "scope"}`, `summary` the
    /// `StateDiff` of the replicated state before and after, `scope` the undo scope the step went
    /// to (`person`; `null` for an empty draft or a `system` or `import` origin). A refused merge
    /// changes nothing and fails with the KDM's message.
    pub fn merge_changes(&mut self, bytes: &[u8], origin: &Origin) -> Result<Value, String> {
        let before = self.replicated_state()?;
        let merged = self.session.merge_draft(bytes, origin);
        self.settle();
        let (scope, damage) = merged.map_err(|error| error.to_string())?;
        let after = self.replicated_state()?;
        let scope = scope.map(|scope| if scope == UndoScope::Person { "person" } else { "agent" });
        Ok(json!({ "damage": damage, "summary": diff_states(&before, &after).to_json(), "scope": scope }))
    }

    /// What merging a draft's changes would change in the project now, as `StateDiff` JSON;
    /// nothing changes. Refuses what [`FilmDocument::merge_changes`] refuses.
    pub fn compare_changes(&self, bytes: &[u8]) -> Result<Value, String> {
        let kdm = self.session.kdm().ok_or("the project has no replica, so no draft of it")?;
        let before = kdm.replica().state_json().map_err(|error| error.to_string())?;
        let after = kdm.merged_state(bytes).map_err(|error| error.to_string())?;
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
    /// Text that merely holds an id stays as it is, and the project keeps its own ids.
    ///
    /// The editor sends every `ai/inspect` reply through here, and film's replies name bins, items,
    /// tracks, clips and transitions by the engine's own ids, which are their tool ids: what is left
    /// to name is an object id the replica made (a hyphenated UUID). A reply holding none comes back
    /// as it is, only checked to be JSON; otherwise only the objects it names are read
    /// (`Replica::tool_ids_of`). The project's and other fixed objects' ids (`project`) are words
    /// a reply also uses as keys, so they are never taken for objects.
    pub fn model_reply(&self, value: &str) -> Result<String, String> {
        let not_json = |error: serde_json::Error| format!("the reply is not JSON: {error}");
        let kdm = self.session.kdm();
        if kdm.is_none() || !holds_object_id(value) {
            serde_json::from_str::<serde::de::IgnoredAny>(value).map_err(not_json)?;
            return Ok(value.to_owned());
        }
        let parsed: Value = serde_json::from_str(value).map_err(not_json)?;
        let Some(replica) = kdm.map(|kdm| kdm.replica()) else { return Ok(value.to_owned()) };
        let mut named = BTreeSet::new();
        named_objects(&parsed, replica, &mut named);
        if named.is_empty() {
            return Ok(value.to_owned());
        }
        Ok(replica.tool_ids_of(&named).show_json(&parsed).to_string())
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

/// Whether `text` is an object id the replica made: a hyphenated, lower-case UUID.
fn is_object_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| if matches!(at, 8 | 13 | 18 | 23) { *byte == b'-' } else { matches!(*byte, b'0'..=b'9' | b'a'..=b'f') })
}

/// Whether `text` holds an object id the replica made anywhere.
fn holds_object_id(text: &str) -> bool {
    text.as_bytes().windows(36).any(|window| std::str::from_utf8(window).is_ok_and(is_object_id))
}

/// The objects of `replica` that `value` names: a string, a key, or a `:`-separated part of a key
/// that is an object id the replica made and holds.
fn named_objects(value: &Value, replica: &Replica, out: &mut BTreeSet<ObjectId>) {
    let mut name = |text: &str| {
        if is_object_id(text) {
            let id = ObjectId::from_string(text);
            if replica.exists(&id) {
                out.insert(id);
            }
        }
    };
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::String(text) => name(text),
            Value::Array(items) => stack.extend(items),
            Value::Object(members) => {
                for (key, member) in members {
                    key.split(':').for_each(&mut name);
                    stack.push(member);
                }
            }
            _ => {}
        }
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
        draft.execute("item.newColorMatte", json!({ "color": "#00ff00", "seconds": 2.0 })).unwrap();
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
        doc.execute("item.newColorMatte", json!({ "color": "#0000ff", "seconds": 2.0 })).unwrap();
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
        let keys: Value = serde_json::from_str(&doc.model_reply(&json!({ "project": { "root": object } }).to_string()).unwrap()).unwrap();
        assert_eq!(keys["project"]["root"], json!(item.to_string()), "the words a reply uses as keys stay: {keys}");
        assert_eq!(
            doc.model_reply(r#"{"project":{"name":"Edit"}}"#).unwrap(),
            r#"{"project":{"name":"Edit"}}"#,
            "a reply naming no object comes back as it is"
        );
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
        doc.model_batch(&json!({ "origin": origin, "ops": [{ "op": "command", "id": "item.newColorMatte", "params": { "color": "#0000ff", "seconds": 2 } }] }))
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
        assert_eq!(again.save(None).unwrap(), bytes, "and saves the same bytes again: the new actor's id range is not written");
    }

    /// A file holds no session's state: two sessions that open one file, with its stored replica
    /// or plainly, save the bytes it holds; and making the same edit, one that mints no id, they
    /// save the same bytes again.
    #[test]
    fn two_sessions_that_open_one_file_save_the_same_bytes() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        doc.execute("item.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
        let bytes = doc.save(None).unwrap();
        let (snapshot, blobs) = (doc.snapshot().unwrap(), doc.blobs().unwrap());
        let mut one = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &blobs).unwrap();
        let mut two = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &blobs).unwrap();
        let mut plain = FilmDocument::open("Edit.kfilm", &bytes).unwrap();
        assert_ne!(one.session.kdm().unwrap().replica().actor(), two.session.kdm().unwrap().replica().actor(), "each session is its own actor");
        for (name, session) in [("one", &mut one), ("two", &mut two), ("plain", &mut plain)] {
            assert_eq!(session.save(None).unwrap(), bytes, "{name} saves the bytes it opened");
        }
        for session in [&mut one, &mut two] {
            session.execute("timeline.setTrack", json!({ "track": "V1", "name": "Same" })).unwrap();
        }
        let edited = one.save(None).unwrap();
        assert_ne!(edited, bytes);
        assert_eq!(two.save(None).unwrap(), edited, "the same edit saves the same bytes");
        let reopened = FilmDocument::open("Edit.kfilm", &edited).unwrap().save(None).unwrap();
        assert_eq!(reopened, edited);
    }

    /// The project as the engine holds it, with ids normalized and the bins before the items in
    /// each bin (the replica's tree keeps bins apart from items): what the engine's view and a read
    /// of the replica agree on. The session's id counter is left out: it never goes back within a
    /// session, so an undo does not lower it (an id handed out stays used).
    fn view(doc: &FilmDocument) -> Value {
        fn reorder(bin: &mut kition_film_engine::project::Bin) {
            let (mut bins, items): (Vec<_>, Vec<_>) =
                std::mem::take(&mut bin.children).into_iter().partition(|entry| matches!(entry, kition_film_engine::project::BinEntry::Bin(_)));
            for entry in &mut bins {
                if let kition_film_engine::project::BinEntry::Bin(child) = entry {
                    reorder(child);
                }
            }
            bin.children = bins.into_iter().chain(items).collect();
        }
        let mut project = (*doc.session.project).clone();
        reorder(&mut project.root);
        serde_json::to_value(kdm_model::normalize(&project)).unwrap()
    }

    /// The whole state: the replica's (its hash) and the engine's view of it.
    fn whole(doc: &mut FilmDocument) -> (String, Value) {
        (doc.session.state_hash().unwrap(), view(doc))
    }

    /// The clips of the active sequence's V1, by start.
    fn v1_starts(doc: &FilmDocument) -> Vec<i64> {
        doc.session.active_sequence().unwrap().video_tracks[0].items.iter().map(|clip| clip.start.0).collect()
    }

    /// A colour matte placed on V1 at `seconds`, run as `origin`.
    fn place_matte(doc: &mut FilmDocument, seconds: f64, origin: &Origin) {
        let matte = doc.execute_as("item.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 }), origin).unwrap();
        doc.execute_as("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": seconds }), origin).unwrap();
    }

    /// KitModel M12a: an agent's draft, merged with the agent's origin as the editor merges it
    /// (`draft/merge` records `{kind: "agent"}`), is one step of the person's Undo. The document
    /// added a clip to V1 meanwhile and the draft another: both are there. The agent's Undo does
    /// not take the merge back, the person's does, to the exact state before (the replica's and
    /// the engine's), and Redo brings the exact merged state back; the replica's histories say the
    /// same as the engine's.
    #[test]
    fn an_agents_draft_is_one_step_of_the_persons_undo_and_undoes_exactly() {
        let agent = Origin::agent("agent:test");
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let base = doc.version().unwrap();
        let mut draft = FilmDocument::open_with_replica("Edit.kfilm", &[], &doc.snapshot().unwrap(), &doc.blobs().unwrap()).unwrap();
        place_matte(&mut draft, 8.0, &agent);
        let changes = draft.export_changes(&base).unwrap();
        place_matte(&mut doc, 4.0, &person());
        let before = whole(&mut doc);
        let starts = v1_starts(&doc);
        assert_eq!(starts.len(), 2, "the fixture's clip and the one placed meanwhile");
        let history = doc.session.history.undo.len();

        let answer = doc.merge_changes(&changes, &agent).unwrap();
        assert_eq!(answer["scope"], json!("person"), "{answer}");
        let merged = whole(&mut doc);
        assert_eq!(v1_starts(&doc).len(), 3, "both clips added to V1 are there: {:?}", v1_starts(&doc));
        // Both sides lengthened the sequence: the length follows the merged clips.
        let length = doc.session.active_sequence().unwrap().duration();
        let last =
            doc.session.active_sequence().unwrap().video_tracks[0].items.iter().max_by_key(|clip| clip.start).map(|clip| (clip.start.0, clip.end())).unwrap();
        assert_eq!(last.0, 8 * 254_016_000_000, "the draft's clip, placed at 8 s, is the last");
        assert_eq!(length, last.1, "the length is where the draft's clip ends");
        let state = doc.replicated_state().unwrap();
        let lengths: Vec<&Value> =
            state["objects"].as_object().unwrap().values().filter(|object| object["$type"] == "Sequence").map(|object| &object["duration"]).collect();
        assert!(lengths.contains(&&json!(length.0.to_string())), "the replica holds the merged length: {lengths:?}");
        assert!(starts.iter().all(|start| v1_starts(&doc).contains(start)), "the document's clips stay");
        assert_eq!(doc.session.history.undo.len(), history + 1, "one step of the person's history");
        assert_eq!(doc.session.history.undo.last().map(|entry| entry.0.as_str()), Some("Merge Draft"));
        let kdm = doc.session.kdm().unwrap();
        assert!(kdm.can_undo_in(UndoScope::Person), "the replica records it in the person's history");
        assert!(!kdm.can_undo_in(UndoScope::Agent), "and nothing in the agents'");

        assert!(doc.session.undo_in(Some(UndoScope::Agent)).is_none(), "the agent's Undo has nothing to take back");
        assert_eq!(whole(&mut doc), merged, "the merge stays");
        assert!(doc.undo().unwrap().0);
        assert_eq!(whole(&mut doc), before, "one Undo of the person: exactly the state before the merge");
        assert_eq!(v1_starts(&doc), starts);
        assert!(doc.redo().unwrap().0);
        assert_eq!(whole(&mut doc), merged, "one Redo: exactly the merged state");
        assert_eq!(doc.session.kdm_resets(), 0);
    }

    /// A draft whose merge the model's repair takes back entirely records nothing
    /// (regressions/issue-merge-changing-nothing): the agent's draft moves a colour matte into a
    /// bin while the person deletes the matte (Clear); the merge leaves the bin naming an item
    /// that is gone, which the repair removes, so the document is as it was. The state (the
    /// replica's hash and the engine's view), the version, the replica's undo depth, the history
    /// and its labels and the person's selection are unchanged, the answer names no scope, and
    /// the person's next Undo is their Clear, back to the exact state before it.
    #[test]
    fn a_merge_the_repair_takes_back_records_nothing() {
        let agent = Origin::agent("agent:test");
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let matte = doc.execute("item.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap()["item"].clone();
        let bin = doc.execute("bin.add", json!({ "name": "Drafts" })).unwrap()["bin"].clone();
        let base = doc.version().unwrap();
        let mut draft = FilmDocument::open_with_replica("Edit.kfilm", &[], &doc.snapshot().unwrap(), &doc.blobs().unwrap()).unwrap();
        draft.execute_as("project.moveToBin", json!({ "items": [matte], "bin": bin }), &agent).unwrap();
        let changes = draft.export_changes(&base).unwrap();

        let before_clear = whole(&mut doc);
        let id = kition_film_engine::project::ItemId(matte.as_u64().unwrap());
        doc.session.state.project_selection = vec![id];
        doc.execute("project.delete", json!({ "items": [matte] })).unwrap();
        assert!(doc.session.project.item(id).is_none(), "the person cleared the matte");
        let before = whole(&mut doc);
        let version = doc.version().unwrap();
        let depth = doc.session.kdm().unwrap().replica().undo_depth(UndoScope::Person);
        let labels: Vec<String> = doc.session.history.undo.iter().map(|entry| entry.0.clone()).collect();
        let redo = doc.session.history.redo.len();
        let selection = doc.session.state.project_selection.clone();
        assert_eq!(labels.last().map(String::as_str), Some("Clear"));

        let preview = doc.compare_changes(&changes).unwrap();
        let answer = doc.merge_changes(&changes, &agent).unwrap();
        assert_eq!(answer["scope"], Value::Null, "no step was recorded: {answer}");
        assert_eq!(answer["summary"], preview, "the preview named what the merge did: {answer}");
        assert_eq!(whole(&mut doc), before, "the document is as it was");
        assert_eq!(doc.version().unwrap(), version, "the version stays");
        assert_eq!(doc.session.kdm().unwrap().replica().undo_depth(UndoScope::Person), depth, "the replica records no step");
        let after: Vec<String> = doc.session.history.undo.iter().map(|entry| entry.0.clone()).collect();
        assert_eq!(after, labels, "the history gets no entry");
        assert_eq!(doc.session.history.redo.len(), redo);
        assert_eq!(doc.session.state.project_selection, selection, "the selection stays");

        assert!(doc.undo().unwrap().0);
        assert_eq!(whole(&mut doc), before_clear, "the next Undo takes back the person's Clear, exactly");
        assert!(doc.session.project.item(id).is_some(), "the matte is back");
        assert_eq!(doc.session.kdm_resets(), 0);
    }

    /// A restored version undoes to the exact state before it and redoes to the exact restored
    /// state, the replica's and the engine's.
    #[test]
    fn a_restore_undoes_and_redoes_exactly() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        doc.version().unwrap();
        let checkpoint = doc.snapshot().unwrap();
        place_matte(&mut doc, 4.0, &person());
        doc.execute("timeline.setTrack", json!({ "track": "V1", "name": "Since" })).unwrap();
        let before = whole(&mut doc);
        doc.restore_state(&checkpoint, &person()).unwrap();
        let restored = whole(&mut doc);
        assert_ne!(restored, before);
        assert_eq!(v1_starts(&doc).len(), 1, "the checkpoint's one clip");
        assert!(doc.undo().unwrap().0);
        assert_eq!(whole(&mut doc), before, "one Undo: exactly the state before the restore");
        assert!(doc.redo().unwrap().0);
        assert_eq!(whole(&mut doc), restored, "one Redo: exactly the restored state");
        assert_eq!(doc.session.kdm_resets(), 0);
    }

    /// `modelReply` reads only the objects a reply names: in a project of many objects, a reply
    /// naming one object shows it under the tool id a read of the whole project gives it, for
    /// every object; a reply naming none comes back byte for byte.
    #[test]
    fn a_reply_shows_the_ids_the_full_read_gives_and_one_naming_none_is_unchanged() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        for _ in 0..100 {
            doc.execute("item.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
        }
        let state = doc.replicated_state().unwrap();
        let objects: Vec<String> = state["objects"].as_object().unwrap().keys().filter(|id| is_object_id(id)).cloned().collect();
        assert!(objects.len() > 100, "many objects: {}", objects.len());
        let full = doc.session.kdm().unwrap().replica().tool_ids();
        for object in &objects {
            let reply = json!({ "target": object, "list": [object], "note": "one object" });
            let shown: Value = serde_json::from_str(&doc.model_reply(&reply.to_string()).unwrap()).unwrap();
            assert_eq!(shown, full.show_json(&reply), "{object}");
        }
        let none = "{ \"project\" : { \"name\": \"Edit\" },\n  \"clips\": [10, 11] }";
        assert_eq!(doc.model_reply(none).unwrap(), none, "a reply naming no object comes back as it is");
    }
}
