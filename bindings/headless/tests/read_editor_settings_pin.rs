//! C8-film-pin: local settings do not consume material under the Program playhead.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn local_settings_accept_an_outside_change_of_program_material() {
    for (command, params) in [
        ("sequence.snap", json!({"on":false})),
        ("sequence.linkedSelection", json!({"on":false})),
        ("sequence.nestSequences", json!({"on":false})),
        ("sequence.showThroughEdits", json!({"on":true})),
        ("markers.filterColors", json!({"hidden":["red"]})),
        ("markers.rippleSequenceMarkers", json!({"on":true})),
        ("markers.copyPasteIncludesSequenceMarkers", json!({"on":true})),
        ("multicam.audioFollowsVideo", json!({"enabled":true})),
        ("multicam.selectionTopDown", json!({"enabled":true})),
        ("multicam.showPreviewMonitor", json!({"enabled":true})),
        ("multicam.autoAdjustQuality", json!({"enabled":true})),
        ("multicam.transmitView", json!({"enabled":true})),
        ("project.columns.resize", json!({"column":"Name","width":125})),
        ("project.freeform.options", json!({"grid":25})),
        ("project.viewPreset.saveAs", json!({"slot":2,"name":"Working"})),
    ] {
        let f = Fixture::new(2);
        let (sequence, basis) = f.inspect().await;
        let clip = v1(&sequence)[0];
        f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Outside"}))]);
        let before = std::fs::read(f.file()).unwrap();
        f.ok("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
        assert_eq!(std::fs::read(f.file()).unwrap(), before, "{command} changes no project content");
        f.shutdown().await;
    }
}
