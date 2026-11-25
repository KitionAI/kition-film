//! The reread hook keeps the live replica, histories, and exact observed editor identities.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, kdm::Origin};
use serde_json::{Value, json};

fn fixture() -> (FilmDocument, Vec<Value>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    let clips = (0..2).map(|time| doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":time})).unwrap()["clips"][0].clone()).collect();
    (doc, clips)
}

#[test]
fn file_difference_retains_agent_undo_and_the_colleagues_other_clip() {
    let (mut live, clips) = fixture();
    let original = live.inspect().unwrap()["sequence"]["video"][0]["items"][0]["name"].clone();
    live.execute_as("clip.rename", json!({"clip":clips[0],"name":"Agent"}), &Origin::agent("agent:test")).unwrap();
    live.mark_saved();
    let editor = live.editor_state();
    let mut fresh = FilmDocument::open("Edit.kfilm", &live.save(None).unwrap()).unwrap();
    fresh.execute("clip.rename", json!({"clip":clips[1],"name":"Colleague"})).unwrap();
    fresh.carry_replica_objects(&live).unwrap();
    fresh.restore_editor_state(&editor).unwrap();
    assert!(live.reconcile_reread(&fresh).unwrap());
    assert_eq!(live.editor_state(), editor);
    live.execute_as("edit.undo", json!({}), &Origin::agent("agent:test")).unwrap();
    let q = live.inspect().unwrap();
    assert_eq!(q["sequence"]["video"][0]["items"][0]["name"], original);
    assert_eq!(q["sequence"]["video"][0]["items"][1]["name"], "Colleague");
    assert_eq!(live.kdm_resets(), 0);
}

#[test]
fn deleted_selection_refuses_restoration_and_keeps_the_live_document() {
    let (mut live, clips) = fixture();
    live.execute("timeline.select", json!({"clips":[clips[0]]})).unwrap();
    live.mark_saved();
    let saved = live.editor_state();
    let bytes = live.save(None).unwrap();
    let mut fresh = FilmDocument::open("Edit.kfilm", &bytes).unwrap();
    fresh.execute("edit.delete", json!({"clips":[clips[0]]})).unwrap();
    fresh.carry_replica_objects(&live).unwrap();
    assert!(fresh.restore_editor_state(&saved).unwrap_err().contains("deleted selected target"));
    assert_eq!(live.save(None).unwrap(), bytes);
    assert_eq!(live.editor_state(), saved);
}

#[test]
fn planning_fork_keeps_replica_identity_and_isolates_writes() {
    let (mut live, _) = fixture();
    let _ = live.snapshot().unwrap();
    let bytes = live.save(None).unwrap();
    let mut fork = live.fork_for_premises().unwrap();
    assert_eq!(fork.doc_id(), live.doc_id());
    fork.execute("bin.add", json!({"name":"Scratch only"})).unwrap();
    assert_eq!(live.save(None).unwrap(), bytes);
    assert_ne!(fork.save(None).unwrap(), bytes);
}
