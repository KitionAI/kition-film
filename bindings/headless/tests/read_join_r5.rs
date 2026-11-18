//! C8-film-read: all-track and multiple-target joins retain departed recipients.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

async fn departed_members(all: bool) {
    let mut failures = Vec::new();
    for related in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(6)).unwrap();
        let clips = v1(&doc.inspect().unwrap()["sequence"]);
        let right = doc.execute("timeline.razor", json!({"clip":clips[1],"time":3*SECOND/2})).unwrap()["clips"][0].clone();
        doc.execute("timeline.razor", json!({"clip":clips[3],"time":7*SECOND/2})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if related {
            f.colleague(&[("edit.clear", json!({"clips":[right]}))]);
        } else {
            f.colleague(&[("clip.rename", json!({"clip":clips[5],"name":"Unrelated"}))]);
        }
        let params = if all { json!({"all":true}) } else { json!({"clips":[clips[1],clips[3]]}) };
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.joinThroughEdits","params":params}]})).await;
        if related {
            if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                failures.push(format!("all={all}: deleted observed recipient must refuse: {result:?}"));
            }
        } else if let Err(e) = result {
            failures.push(format!("all={all}: distant name must apply: {e}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn all_track_joins_retain_departed_members() {
    departed_members(true).await;
}

// Coverage reconstructs all candidates together, including the deleted recipient.
// Independent single-target plans cannot compose for arbitrary subsets.
#[tokio::test(flavor = "multi_thread")]
async fn multi_target_join_replays_departed_members() {
    departed_members(false).await;
}
