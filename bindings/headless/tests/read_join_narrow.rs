//! C8-film-read: a nonmatching neighbour never contributes source mapping to a through join.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_different_source_neighbours_slip_is_unrelated_to_the_join() {
    for index in [0, 2] {
        let mut doc = FilmDocument::open(FILE, &project(6)).unwrap();
        let old_clips = v1(&doc.inspect().unwrap()["sequence"]);
        let left = old_clips[1];
        doc.execute("timeline.razor", json!({"clip":left,"time":3*SECOND/2})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        f.colleague(&[("timeline.slip", json!({"clip":old_clips[index],"delta":SECOND/8}))]);
        f.ok("run", json!({"basis":basis,"steps":[{"command":"sequence.joinThroughEdits","params":{"clips":[left]}}]})).await;
        f.shutdown().await;
    }
}
