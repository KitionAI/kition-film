use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn live_controls_and_recorded_gestures_change_the_declared_mode() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let strip = doc.inspect().unwrap()["sequence"]["audio"][0]["id"].clone();
    let before = doc.editor_state()["mode"].clone();
    doc.execute("mixer.touch", json!({"strip":strip,"lane":"volume","value":-6,"time":0})).unwrap();
    assert_ne!(doc.editor_state()["mode"], before, "Release consumes the held value");
    doc.execute("mixer.setStrip", json!({"strip":strip,"mode":"Touch"})).unwrap();
    doc.execute("mixer.recordStart", json!({"time":0})).unwrap();
    let before = doc.editor_state()["mode"].clone();
    doc.execute("mixer.touch", json!({"strip":strip,"lane":"volume","value":-9,"time":1})).unwrap();
    assert_ne!(doc.editor_state()["mode"], before, "Stop consumes the recorded gesture");
    for id in ["mixer.release", "clipMixer.release", "mixer.recordStop"] {
        let spec = doc.commands().into_iter().find(|spec| spec.id == id).unwrap();
        assert!(spec.reads.iter().any(|read| read.as_str() == "mode"), "{id} consumes local recorder state");
    }
}

#[test]
fn stopping_a_pass_retains_recorded_lane_values_and_all_write_mode_assignments() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seen = doc.inspect().unwrap();
    let sequence = seen["sequence"]["id"].clone();
    let strip = seen["sequence"]["audio"][0]["id"].clone();
    doc.execute("mixer.setStrip", json!({"strip":strip,"mode":"Touch"})).unwrap();
    doc.execute("mixer.recordStart", json!({"time":0})).unwrap();
    doc.execute("mixer.touch", json!({"strip":strip,"lane":"volume","value":-9,"time":1})).unwrap();
    let under = doc.under("mixer.recordStop", &json!({"time":254_016_000_000i64})).unwrap().unwrap();
    for (id, field) in [(strip.clone(), "props.mixer.lanes.volume"), (strip, "props.mixer.mode"), (sequence, "sequence.settings.settings.sample_rate")] {
        assert!(
            under.premises.iter().any(|need| need.id == id && need.fields.as_ref().is_some_and(|fields| fields.iter().any(|name| name == field))),
            "missing {id}/{field}: {under:?}"
        );
    }
}

#[test]
fn submix_creation_retains_its_reference_and_deletion_retains_the_removed_bus_and_route_membership() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let add = doc.under("mixer.addSubmix", &json!({"name":"Bus"})).unwrap().unwrap();
    assert!(add.premises.iter().any(|need| need.fields.as_ref().is_some_and(|fields| fields.iter().any(|field| field == "~submixTrackOrder"))), "{add:?}");
    let bus = doc.execute("mixer.addSubmix", json!({"name":"Bus"})).unwrap()["id"].clone();
    let remove = doc.under("mixer.deleteSubmix", &json!({"strip":bus})).unwrap().unwrap();
    assert!(remove.premises.iter().any(|need| need.id == bus && need.fields.is_none()), "{remove:?}");
    let derived = doc.derived(std::slice::from_ref(&bus), &["submixDependants".into()]).unwrap();
    assert!(derived.iter().any(|value| value.id == bus && value.values.get("submixDependants").is_some()), "{derived:?}");
}
