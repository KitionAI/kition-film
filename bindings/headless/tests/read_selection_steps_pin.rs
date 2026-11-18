//! C8-film-pin: selection steps use neighbours away from the playhead.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn selection_steps_retain_the_neighbour_chosen_from_track_order() {
    for command in ["timeline.selectNextClip", "timeline.selectPrevClip"] {
        for deleted in [false, true] {
            let f = Fixture::new(3);
            let (seen, basis) = f.inspect().await;
            let clips = v1(&seen);
            let anchor = if command == "timeline.selectNextClip" { clips[0] } else { clips[2] };
            if deleted {
                f.colleague(&[("edit.clear", json!({"clips":[clips[1]]}))]);
            } else {
                f.colleague(&[("clip.rename", json!({"clip":clips[1],"name":"Unused neighbour name"}))]);
            }
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"on":[anchor],"at":{"time":0.0}}]})).await;
            if deleted {
                let error = result.expect_err("the selected neighbour was deleted after observation");
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
            } else {
                assert!(result.is_ok(), "the neighbour name is not consumed: {command}: {result:?}");
            }
            f.shutdown().await;
        }
    }
}
