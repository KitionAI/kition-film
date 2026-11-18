//! Targeting commands consume ordered track identities, not track content.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn targeting_commands_guard_the_track_lists_they_consume() {
    for command in [
        "timeline.toggleAllVideoTargets",
        "timeline.toggleAllAudioTargets",
        "timeline.toggleAllSourceVideo",
        "timeline.toggleAllSourceAudio",
        "timeline.toggleTargetV2",
        "timeline.toggleTargetA2",
    ] {
        for relevant in [false, true] {
            let f = Fixture::new(2);
            let (_, basis) = f.inspect().await;
            let audio = command.contains("Audio") || command.contains("A2");
            let track = if audio { "A2" } else { "V2" };
            if relevant {
                f.colleague(&[("sequence.addTracks", if audio { json!({"video":0,"audio":1,"audioAfter":0}) } else { json!({"video":1,"videoAfter":0}) })]);
            } else {
                f.colleague(&[("timeline.setTrack", json!({"track":track,"muted":true}))]);
            }
            let before = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command}]})).await;
            if relevant {
                let error = answer.expect_err("the ordered target identities changed after observation");
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
            } else {
                answer.unwrap_or_else(|error| panic!("{command}: unused track content: {error}"));
            }
            assert_eq!(std::fs::read(f.file()).unwrap(), before, "editor targeting never changes project content");
            f.shutdown().await;
        }
    }
}
