//! Paste Attributes resolves the clipboard stream through the target owner.
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn paste_attributes_refuses_a_changed_target_stream_and_allows_unused_names() {
    for change in ["stream", "name", "none"] {
        let f = Fixture::new(2);
        let (seen, _) = f.inspect().await;
        let sequence = ItemId(seen["id"].as_u64().unwrap());
        let clips = v1(&seen);
        f.ok(
            "run",
            json!({"steps":[
                {"command":"effects.setParam","params":{"clip":clips[0],"effect":"opacity","param":"opacity","value":27.0}},
                {"command":"edit.copy","on":[clips[0]]}
            ]}),
        )
        .await;
        let (_, basis) = f.inspect().await;
        if change == "stream" {
            rewrite(&f.file(), |project| {
                let q = project.sequence_mut(sequence).unwrap();
                let index = q.video_tracks[0].items.iter().position(|clip| clip.id == ClipId(clips[1])).unwrap();
                let target = q.video_tracks[0].items.remove(index);
                q.audio_tracks[0].items.push(target);
            });
        } else if change == "name" {
            f.colleague(&[("clip.rename", json!({"clip":clips[1],"name":"Outside name"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"edit.pasteAttributes","params":{"clips":[clips[1]]}}]})).await;
        if change == "stream" {
            let error = result.expect_err("the changed clipboard-stream recipient must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            assert!(result.is_ok(), "{change}: {result:?}");
            assert_eq!(opacity_on_disk(&f.file(), clips[1]), 27.0);
        }
        f.shutdown().await;
    }
}
