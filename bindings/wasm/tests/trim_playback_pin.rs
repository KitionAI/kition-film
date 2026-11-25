use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise};
use serde_json::json;

#[test]
fn trim_playback_is_checkpointed_and_survives_an_outside_reread() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    doc.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"out"})).unwrap();
    let before = doc.editor_state()["mode"].clone();
    doc.execute("trim.shuttle", json!({"clock":10})).unwrap();
    assert_ne!(doc.editor_state()["mode"], before, "dynamic playback is a command input");
    let saved = doc.save(None).unwrap();
    let mut reread = FilmDocument::open("Edit.kfilm", &saved).unwrap();
    reread.carry_replica_objects(&doc).unwrap();
    reread.restore_editor_state(&doc.editor_state()).unwrap();
    assert!(doc.reconcile_reread(&reread).unwrap());
    assert_eq!(reread.editor_state()["mode"], doc.editor_state()["mode"]);
    assert_eq!(reread.fork_for_premises().unwrap().editor_state()["mode"], reread.editor_state()["mode"]);
}

#[test]
fn dynamic_commands_hold_the_sequence_material_they_can_replay() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].clone();
    for command in ["trim.shuttle", "trim.shuttleStop", "trim.cancelDynamic", "trim.playAround"] {
        let under = doc.under(command, &json!({"clock":0})).unwrap().unwrap();
        assert!(under.premises.contains(&Premise::on(sequence.clone()).fields(["sequence"]).positions(Vec::<String>::new())), "{command}: {under:?}");
    }
}
