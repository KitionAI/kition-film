//! C8-land-13t: index insertion destinations.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn track_insertions_hold_the_destination_gap() {
    for before in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.addTracks", json!({"video":1,"videoAfter":if before {0} else {3}}))]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":1}}]})).await;
        if before {
            assert!(answer.is_err(), "a stale numeric track insertion applied: {answer:?}");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}
