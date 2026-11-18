//! C8-film-pin: frame spellings depend on the sequence timebase even inside one clip.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn frame_based_marks_hold_the_rate_while_tick_marks_do_not() {
    for command in
        ["markers.markIn", "markers.markOut", "markers.markSplitVideoIn", "markers.markSplitVideoOut", "markers.markSplitAudioIn", "markers.markSplitAudioOut"]
    {
        for frames in [true, false] {
            let f = Fixture::new(3);
            let (_, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", json!({"fps":30}))]);
            let before = std::fs::read(f.file()).unwrap();
            let params = if frames { json!({"frame":1}) } else { json!({"time":SECOND / 2}) };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if frames {
                assert_eq!(answer.expect_err(command)["error"]["code"], "conflict", "{command}");
                assert_eq!(std::fs::read(f.file()).unwrap(), before, "{command}");
            } else {
                answer.unwrap_or_else(|error| panic!("{command} uses ticks: {error}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn marker_duration_frames_hold_the_timebase() {
    let f = Fixture::new(3);
    let (_, basis) = f.inspect().await;
    f.colleague(&[("sequence.settings", json!({"fps":30}))]);
    let before = std::fs::read(f.file()).unwrap();
    let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"markers.add","params":{"time":0,"durationFrames":12,"name":"Assigned"}}]})).await;
    assert_eq!(answer.expect_err("duration uses the observed rate")["error"]["code"], "conflict");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}
