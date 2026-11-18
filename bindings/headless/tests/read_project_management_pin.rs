mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn deletion_retains_references_outside_the_program_playhead_and_allows_names() {
    for related in [false, true] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let removed = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
        let other = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
        let clip = doc.execute("timeline.place", json!({"item":other,"track":"V1","seconds":5})).unwrap()["clips"][0].as_u64().unwrap();
        doc.execute("project.select", json!({"items":[removed]})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if related {
            rewrite(&f.file(), |project| {
                for item in project.items.values_mut() {
                    if let Some(q) = item.as_sequence_mut()
                        && let Some((_, clip)) = q.find_item_mut(ClipId(clip))
                    {
                        clip.item = ItemId(removed);
                    }
                }
            });
        } else {
            f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Unrelated"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"project.delete","params":{"items":[removed]}}]})).await;
        if related {
            assert_eq!(result.expect_err("a new reference must not be silently deleted")["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}
