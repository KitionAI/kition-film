//! C8-film-pin: returned caption-track ordinals and automatic C1 creation use membership.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn caption_creation_retains_the_track_membership_it_uses() {
    let mut missing = Vec::new();
    for command in ["caption.newTrack", "caption.add"] {
        let f = Fixture::new(0);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("caption.newTrack", json!({"name":"Outside C1"}))]);
        let params = if command == "caption.newTrack" { json!({"name":"Mine"}) } else { json!({"text":"Mine","time":0}) };
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
        match result {
            Err(error) => assert_eq!(error["error"]["code"], "conflict", "{command}: {error}"),
            Ok(_) => missing.push(command),
        }
        f.shutdown().await;
    }
    assert!(missing.is_empty(), "changed caption track membership accepted: {missing:?}");
}
