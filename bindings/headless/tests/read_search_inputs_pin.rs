//! C8-film-pin: search writes return results computed from existing items.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn search_bin_writes_hold_matching_columns_and_allow_unused_labels() {
    for command in ["bin.addSearch", "project.editSearchBin"] {
        for change in ["name", "add", "label"] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let item = doc.execute("item.newColorMatte", json!({"name":"Needle","seconds":1})).unwrap()["item"].clone();
            let bin = doc.execute("bin.addSearch", json!({"name":"Saved","column":"Name","text":"Needle"})).unwrap()["bin"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            match change {
                "name" => {
                    f.colleague(&[("clip.rename", json!({"item":item,"name":"Absent"}))]);
                }
                "add" => {
                    f.colleague(&[("item.newColorMatte", json!({"name":"Needle added","seconds":1}))]);
                }
                _ => {
                    f.colleague(&[("edit.label.blue", json!({"items":[item]}))]);
                }
            }
            let p = if command == "bin.addSearch" { json!({"name":"Agent","column":"Name","text":"Needle"}) } else { json!({"bin":bin,"name":"Agent"}) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":p}]})).await;
            if change == "label" {
                assert!(result.is_ok(), "unused label: {command}: {result:?}");
                let answer = result.unwrap();
                for bucket in ["changes", "others"] {
                    for list in ["created", "changed", "deleted", "moved"] {
                        assert!(
                            answer[bucket][list].as_array().into_iter().flatten().all(|object| object["type"] != "SearchPremises"),
                            "private search facts leaked: {answer}"
                        );
                    }
                }
            } else {
                let error = result.expect_err("search result dependencies must refuse a stale write");
                assert_eq!(error["error"]["code"], "conflict", "{command}/{change}: {error}");
            }
            f.shutdown().await;
        }
    }
}
