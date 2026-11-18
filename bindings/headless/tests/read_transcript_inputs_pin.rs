//! C8-film-pin: transcript edits consume words, routes and audio geometry.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn words(text: &str) -> Value {
    json!({"words":[{"text":text,"start":SECOND/4,"end":SECOND/2,"speaker":0}]})
}

#[tokio::test(flavor = "multi_thread")]
async fn transcript_edits_retain_word_inputs_and_accept_unrelated_source_names() {
    for command in [
        "transcript.set",
        "transcript.delete",
        "transcript.renameSpeaker",
        "transcript.select",
        "transcript.lift",
        "transcript.extract",
        "transcript.removePauses",
        "transcript.removeFillers",
        "transcript.createCaptions",
    ] {
        for change in ["words", "name"] {
            let mut doc = FilmDocument::open(FILE, &project(0)).unwrap();
            let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","time":0})).unwrap();
            doc.execute("transcript.set", json!({"item":item,"transcript":words("um")})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            if change == "words" {
                f.colleague(&[("transcript.set", json!({"item":item,"transcript":words("outside")}))]);
            } else {
                f.colleague(&[("clip.rename", json!({"item":item,"name":"Unrelated source name"}))]);
            }
            let params = match command {
                "transcript.set" => json!({"item":item,"transcript":words("assigned")}),
                "transcript.delete" => json!({"items":[item]}),
                "transcript.renameSpeaker" => json!({"item":item,"speaker":0,"name":"Assigned"}),
                "transcript.select" | "transcript.lift" | "transcript.extract" => json!({"from":0}),
                _ => json!({}),
            };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if change == "words" {
                let error = result.expect_err(command);
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{command}: {error}");
            } else {
                assert!(result.is_ok(), "{command} must accept unused source name: {result:?}");
            }
            f.shutdown().await;
        }
    }
}
