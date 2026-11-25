//! C8-film-read writer cases from the committed blind split/range-marker paths.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ItemId, SplitMarks};
use serde_json::json;

const SPLIT_COMMANDS: [&str; 4] = ["marker.markSplitVideoIn", "marker.markSplitVideoOut", "marker.markSplitAudioIn", "marker.markSplitAudioOut"];

fn change_split(marks: &mut SplitMarks, channel: &str, side: &str, value: i64) {
    let value = Some(serde_json::from_value(json!(value)).unwrap());
    match (channel, side) {
        ("video", "in") => marks.video_in = value,
        ("video", "out") => marks.video_out = value,
        ("audio", "in") => marks.audio_in = value,
        ("audio", "out") => marks.audio_out = value,
        _ => panic!("test split side"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn split_points_hold_the_assigned_side_and_opposite_eligibility_but_not_the_other_channel() {
    for command in SPLIT_COMMANDS {
        for change in ["assigned", "opposite", "other-channel"] {
            let f = Fixture::new(6);
            let (sequence, _) = f.inspect().await;
            let id = ItemId(sequence["id"].as_u64().unwrap());
            let channel = if command.contains("Video") { "video" } else { "audio" };
            let side = if command.ends_with("In") { "in" } else { "out" };
            rewrite(&f.file(), |p| {
                let split = &mut p.sequence_mut(id).unwrap().split;
                change_split(split, channel, "in", SECOND);
                change_split(split, channel, "out", 3 * SECOND);
            });
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let split = &mut p.sequence_mut(id).unwrap().split;
                match change {
                    "assigned" => change_split(split, channel, side, SECOND / 2),
                    "opposite" => {
                        change_split(split, channel, if side == "in" { "out" } else { "in" }, if side == "in" { 3 * SECOND / 2 } else { 5 * SECOND / 2 })
                    }
                    "other-channel" => change_split(split, if channel == "video" { "audio" } else { "video" }, "in", SECOND / 2),
                    _ => panic!("test change"),
                }
            });
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":{"time":2*SECOND}}]})).await;
            if change == "other-channel" {
                answer.unwrap_or_else(|error| panic!("{command}/{change}: {error}"));
            } else {
                assert_eq!(answer.expect_err(&format!("{command}/{change}"))["error"]["code"], "conflict");
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_range_marker_holds_its_in_out_and_rate_but_not_existing_marker_text() {
    for change in ["in", "out", "rate", "marker-text"] {
        let f = Fixture::new(6);
        let marker = f.colleague(&[
            ("marker.markIn", json!({"time":SECOND})),
            ("marker.markOut", json!({"time":3*SECOND})),
            ("marker.add", json!({"time":5*SECOND,"name":"old"})),
        ])[2]["marker"]
            .as_u64()
            .unwrap();
        let (_, basis) = f.inspect().await;
        f.colleague(&[match change {
            "in" => ("marker.markIn", json!({"time":2*SECOND})),
            "out" => ("marker.markOut", json!({"time":4*SECOND})),
            "rate" => ("sequence.settings", json!({"fps":30})),
            "marker-text" => ("marker.edit", json!({"marker":marker,"comment":"unrelated"})),
            _ => panic!("test change"),
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"marker.addRangeInOut","params":{"name":"mine"}}]})).await;
        if change == "marker-text" {
            answer.unwrap_or_else(|error| panic!("{change}: {error}"));
        } else {
            assert_eq!(answer.expect_err(change)["error"]["code"], "conflict");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_range_marker_holds_the_marked_material_and_allows_material_at_the_playhead_outside_it() {
    for in_range in [true, false] {
        let f = Fixture::new(6);
        f.colleague(&[("marker.markIn", json!({"time":SECOND})), ("marker.markOut", json!({"time":3*SECOND}))]);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[("clip.enable", json!({"clips":[clips[if in_range {2} else {0}]]}))]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"marker.addRangeInOut","params":{"name":"mine"}}]})).await;
        if in_range {
            assert_eq!(answer.expect_err("changed material under marked range")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("material outside the marked range: {error}"));
        }
        f.shutdown().await;
    }
}

#[test]
fn source_split_points_hold_the_source_item_not_the_program_sequence() {
    use kition_film_kit::FilmDocument;
    use kition_kit::KitDocument;
    let mut doc = FilmDocument::open(FILE, &project(6)).unwrap();
    let item = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap();
    doc.execute("source.open", json!({"item":item})).unwrap();
    for command in SPLIT_COMMANDS {
        let held = doc.under(command, &json!({"target":"source","time":SECOND})).unwrap().unwrap();
        let channel = if command.contains("Video") { "video" } else { "audio" };
        let required = [format!("props.common.split.{channel}In"), format!("props.common.split.{channel}Out")];
        let premise = held.premises.iter().find(|premise| premise.id == json!(item)).expect("source split is a source-item premise");
        for field in required {
            assert!(premise.fields.as_ref().unwrap().contains(&field), "{command}: missing {field}: {held:?}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_marked_range_replays_its_membership() {
    use kition_film_project::ClipId;
    for in_range in [true, false] {
        let f = Fixture::new(6);
        f.colleague(&[("marker.markIn", json!({"time":SECOND})), ("marker.markOut", json!({"time":3*SECOND}))]);
        let (sequence, basis) = f.inspect().await;
        let clip = v1(&sequence)[if in_range { 2 } else { 5 }];
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(ItemId(sequence["id"].as_u64().unwrap())).unwrap();
            q.find_item_mut(ClipId(clip)).unwrap().1.start.0 = 8 * SECOND;
            for track in &mut q.video_tracks {
                track.items.sort_by_key(|clip| clip.start);
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"marker.addRangeInOut","params":{"name":"mine"}}]})).await;
        if in_range {
            assert_eq!(answer.expect_err("range member moved away")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("move outside marked range: {error}"));
        }
        f.shutdown().await;
    }
}
