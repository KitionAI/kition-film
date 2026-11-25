//! C8-film-pin: loudness sampling and ducking trigger membership are inputs.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn sound_document() -> (FilmDocument, Value, Value) {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    let source = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let bed = doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"][1].clone();
    (doc, source, bed)
}

#[tokio::test(flavor = "multi_thread")]
async fn loudness_matching_holds_its_sample_rate_and_allows_picture_geometry() {
    for change in ["rate", "picture"] {
        let (mut doc, _, clip) = sound_document();
        doc.execute("audioMixing.setType", json!({"clips":[clip],"type":"dialogue"})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.settings", if change == "rate" { json!({"sampleRate":44100}) } else { json!({"width":640}) })]);
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"audioMixing.autoMatch","params":{"clips":[clip],"target":-23}}]})).await;
        if change == "rate" {
            let error = result.expect_err("a changed loudness sampling rate must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
        } else {
            assert!(result.is_ok(), "unused picture geometry must survive: {result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ducking_holds_added_and_deleted_trigger_candidates_but_allows_their_names() {
    for change in ["add", "delete", "name", "empty-lane"] {
        let (mut doc, source, bed) = sound_document();
        doc.execute("audioMixing.setType", json!({"clips":[bed],"type":"music"})).unwrap();
        let trigger = if change != "add" {
            let id = doc.execute("timeline.place", json!({"item":source,"track":"V2","audioTrack":"A2","time":0})).unwrap()["clips"][1].clone();
            doc.execute("audioMixing.setType", json!({"clips":[id],"type":"dialogue"})).unwrap();
            id
        } else {
            Value::Null
        };
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        match change {
            "add" => {
                let id = f.colleague(&[("timeline.place", json!({"item":source,"track":"V2","audioTrack":"A2","time":0}))])[0]["clips"][1].clone();
                f.colleague(&[("audioMixing.setType", json!({"clips":[id],"type":"dialogue"}))]);
            }
            "delete" => {
                f.colleague(&[("edit.delete", json!({"clips":[trigger]}))]);
            }
            "empty-lane" => {
                f.colleague(&[("sequence.addTracks", json!({"audio":1}))]);
            }
            _ => {
                f.colleague(&[("clip.rename", json!({"clip":trigger,"name":"Dialogue label"}))]);
            }
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"audioMixing.generateDucking","params":{"clips":[bed]}}]})).await;
        if matches!(change, "name" | "empty-lane") {
            assert!(result.is_ok(), "an unused name or empty audio lane must survive: {result:?}");
        } else {
            let error = result.expect_err("a changed ducking candidate set must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{change}: {error}");
        }
        f.shutdown().await;
    }
}
