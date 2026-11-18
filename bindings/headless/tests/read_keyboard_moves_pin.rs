//! C8-film-pin: keyboard moves use selected geometry and the actual destination.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_moves_retain_geometry_timebase_and_destination_material() {
    let mut missing = Vec::new();
    let mut false_refusals = Vec::new();
    for command in ["timeline.nudgeLeft", "timeline.nudgeRight", "timeline.nudgeLeft5", "timeline.nudgeRight5", "timeline.nudgeUp", "timeline.nudgeDown"] {
        let vertical = matches!(command, "timeline.nudgeUp" | "timeline.nudgeDown");
        for change in ["position", "destination", "appearance", "rate"] {
            if vertical && change == "rate" {
                continue;
            }
            let f = Fixture::new(3);
            let (seen, _) = f.inspect().await;
            let selected = v1(&seen)[2];
            let source = seen["video"][0]["items"][0]["item"].clone();
            let source_track = if command == "timeline.nudgeDown" { "V2" } else { "V1" };
            let destination = if command == "timeline.nudgeDown" {
                "V1"
            } else if command == "timeline.nudgeUp" {
                "V2"
            } else {
                "V1"
            };
            if command == "timeline.nudgeDown" {
                f.colleague(&[("timeline.move", json!({"moves":[{"clip":selected,"track":source_track,"time":2*SECOND}]}))]);
            }
            let (_, basis) = f.inspect().await;
            match change {
                "position" => {
                    f.colleague(&[("timeline.move", json!({"moves":[{"clip":selected,"track":source_track,"time":4*SECOND}]}))]);
                }
                "destination" => {
                    f.colleague(&[("timeline.place", json!({"item":source,"track":destination,"time":2*SECOND+SECOND/2,"duration":SECOND/4}))]);
                }
                "rate" => {
                    f.colleague(&[("sequence.settings", json!({"fps":30}))]);
                }
                _ => {
                    f.colleague(&[opacity(selected, 42.0)]);
                }
            }
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"on":[selected],"at":{"time":0.0}}]})).await;
            if change == "appearance" {
                if result.is_err() {
                    false_refusals.push(command);
                }
            } else {
                match result {
                    Err(error) => {
                        assert_eq!(error["error"]["code"], "conflict", "{command}/{change}: {error}");
                        if change == "position" && !vertical {
                            assert_conflict(&error, &selected.to_string(), "changed");
                        }
                    }
                    Ok(_) => missing.push((command, change)),
                }
            }
            f.shutdown().await;
        }
    }
    assert!(
        missing.is_empty() && false_refusals.is_empty(),
        "changed keyboard-move inputs accepted: {missing:?}; unused appearances refused: {false_refusals:?}"
    );
}
