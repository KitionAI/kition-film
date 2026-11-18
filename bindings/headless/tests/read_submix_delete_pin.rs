mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_submix_retains_removed_values_and_route_membership_and_allows_unrelated_clips() {
    for change in ["bus", "new-output", "new-send", "unrelated-name"] {
        let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
        let seen = doc.inspect().unwrap();
        let audio = seen["sequence"]["audio"][0]["id"].clone();
        let clip = seen["sequence"]["video"][0]["clips"][0]["clip"].clone();
        let bus = doc.execute("mixer.addSubmix", json!({"name":"Bus"})).unwrap()["id"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        match change {
            "bus" => {
                f.colleague(&[("mixer.setStrip", json!({"strip":bus,"volumeDb":-9}))]);
            }
            "new-output" => {
                f.colleague(&[("mixer.setStrip", json!({"strip":audio,"output":bus}))]);
            }
            "new-send" => {
                f.colleague(&[("mixer.addSend", json!({"strip":audio,"target":bus}))]);
            }
            _ => {
                f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Unrelated"}))]);
            }
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"mixer.deleteSubmix","params":{"strip":bus}}]})).await;
        if change == "unrelated-name" {
            assert!(result.is_ok(), "{result:?}");
        } else {
            let error = result.expect_err("changed removed fields and new recipients must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{change}: {error}");
        }
        f.shutdown().await;
    }
}
