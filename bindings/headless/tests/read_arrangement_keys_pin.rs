//! C8-film-pin: arrangement names are literal metadata keys.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn arrangement_commands_hold_literal_keys_and_leave_other_arrangements_independent() {
    for command in ["project.freeform.saveArrangement", "project.freeform.restoreArrangement", "project.freeform.deleteArrangement"] {
        for name in ["Review.v1", "Review[1]", "Review/mix~1"] {
            for changed_name in [name, "Other", "Review", "Review.v1.extra"] {
                let assigned = changed_name == name;
                let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
                let item = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
                doc.execute("project.freeform.saveArrangement", json!({"name":name})).unwrap();
                let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
                let (_, basis) = f.inspect().await;
                rewrite(&f.file(), |project| {
                    project.item_mut(ItemId(item)).unwrap().metadata.insert(format!("Freeform Arrangement: {changed_name}"), "300,400,100".into());
                });
                let before = std::fs::read(f.file()).unwrap();
                let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":{"name":name}}]})).await;
                if assigned {
                    let error = result.expect_err("the exact arrangement is consumed or assigned");
                    assert_eq!(error["error"]["code"], "conflict", "{command}/{name}: {error}");
                    assert_eq!(std::fs::read(f.file()).unwrap(), before);
                } else {
                    result.unwrap_or_else(|error| panic!("{command}/{name} is independent: {error}"));
                }
                f.shutdown().await;
            }
        }
    }
}
