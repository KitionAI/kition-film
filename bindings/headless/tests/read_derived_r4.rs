//! Scoped computed facts compare only the font family or metadata column consumed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn per_track_kind_membership_does_not_hold_other_track_kinds() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.addTracks", if related { json!({"video":1,"audio":0}) } else { json!({"video":0,"audio":1}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"audio":0}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the observed video insertion gap changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("audio membership does not change a video insertion gap: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn font_profile_subpaths_ignore_other_families() {
    let f = Fixture::new(1);
    let mut clips = Vec::new();
    for (index, font) in ["Inter", "Other"].into_iter().enumerate() {
        clips.push(
            f.colleague(&[("graphics.newText", json!({"newClip":true,"text":"Text","font":font,"time":(index as i64+2)*SECOND}))])[0]["clip"].as_u64().unwrap(),
        );
    }
    let (_, basis) = f.inspect().await;
    f.colleague(&[("graphics.set", json!({"clip":clips[1],"layer":0,"props":{"font":"Elsewhere"}}))]);
    f.ok("run", json!({"basis":basis,"steps":[{"command":"file.replaceFonts","params":{"from":"Inter","to":"Serif"}}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_column_profile_ignores_other_columns() {
    let f = Fixture::new(2);
    let (seq, _) = f.inspect().await;
    let item = seq["video"][0]["items"][0]["item"].as_u64().unwrap();
    f.colleague(&[("metadata.set", json!({"item":item,"field":"Rating","value":"A"}))]);
    let (_, basis) = f.inspect().await;
    f.colleague(&[("metadata.set", json!({"item":item,"field":"New unrelated column","value":"B"}))]);
    f.ok("run", json!({"basis":basis,"steps":[{"command":"project.sort","params":{"column":"Rating"}}]})).await;
    f.shutdown().await;
}
