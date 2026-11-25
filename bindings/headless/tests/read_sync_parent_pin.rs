//! C8-film-pin: Merge Clips inherits the reference source's containing bin.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn merge_holds_the_reference_parent_but_not_its_sibling_index() {
    for move_source in [true, false] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let video = doc.execute("item.newOfflineFile", json!({"name":"Video","seconds":2,"audio":false})).unwrap()["item"].clone();
        let audio = doc.execute("item.newOfflineFile", json!({"name":"Audio","seconds":2,"video":false})).unwrap()["item"].clone();
        let bin = doc.execute("bin.add", json!({"name":"Destination"})).unwrap()["bin"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if move_source {
            f.colleague(&[("project.moveToBin", json!({"items":[video],"bin":bin}))]);
        } else {
            f.colleague(&[("item.newColorMatte", json!({"name":"Sibling","seconds":1}))]);
        }
        let before = std::fs::read(f.file()).unwrap();
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.mergeClips","params":{"items":[video,audio],"method":"in"}}]})).await;
        if move_source {
            let error = result.expect_err("a move changes the merged item's destination");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            let answer = result.expect("a sibling append preserves the destination bin");
            assert!(!answer.to_string().contains("parentBin"), "private premises stay out of public receipts: {answer}");
        }
        f.shutdown().await;
    }
}
