//! Slip reads the selected source window even far from the Program playhead.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn slip_keys_hold_source_windows_and_allow_unused_names() {
    for command in ["timeline.slip", "timeline.slipLeft", "timeline.slipRight", "timeline.slipLeft5", "timeline.slipRight5"] {
        for change in ["source", "bounds", "name"] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let parent = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
            let sub = doc.execute("clip.makeSubclip", json!({"item":parent,"start":0,"end":3*SECOND,"restrictTrims":true})).unwrap()["item"].clone();
            let clip = doc.execute("timeline.place", json!({"item":sub,"track":"V2","time":2*SECOND,"sourceIn":SECOND,"duration":SECOND})).unwrap()["clips"][0]
                .clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            match change {
                "source" => {
                    f.colleague(&[("timeline.slip", json!({"clip":clip,"deltaFrames":2}))]);
                }
                "bounds" => {
                    f.colleague(&[("clip.editSubclip", json!({"item":sub,"start":0,"end":2*SECOND,"restrictTrims":true}))]);
                }
                _ => {
                    f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Unused name"}))]);
                }
            }
            let step = if command == "timeline.slip" {
                json!({"command":command,"params":{"clip":clip,"deltaFrames":1}})
            } else {
                json!({"command":command,"on":[clip],"params":{}})
            };
            let result = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            if change == "name" {
                assert!(result.is_ok(), "unused name: {command}: {result:?}");
            } else {
                let error = result.expect_err("changed slip inputs must refuse");
                assert_eq!(error["error"]["code"], "conflict", "{command}/{change}: {error}");
            }
            f.shutdown().await;
        }
    }
}
