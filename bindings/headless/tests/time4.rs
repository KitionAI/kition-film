//! C8-time-4: incomplete media references remain readable and premises match actual edits.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn missing_item_fixture_is_readable_and_keeps_the_missing_reference() {
    let bytes = include_bytes!("../../../conformance/check-missing-item.kfilm");
    let f = Fixture::from_bytes(bytes, Default::default());
    let (sequence, _) = f.inspect().await;
    let clip = &sequence["video"][0]["items"][0];
    let id = clip["clip"].as_u64().unwrap();
    let item = clip["item"].clone();
    f.ok("query", json!({"objects": [id], "describe": "*"})).await;
    f.ok("batch", json!({"ops": [{"op": "set", "target": id, "field": "props.name", "value": "Still missing"}]})).await;
    let saved = std::fs::read(f.file()).unwrap();
    f.shutdown().await;
    let g = Fixture::from_bytes(&saved, Default::default());
    let (after, _) = g.inspect().await;
    assert_eq!(after["video"][0]["items"][0]["item"], item);
    g.ok("query", json!({"objects": [id]})).await;
    g.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn relinking_a_missing_source_clears_and_receipts_its_missing_id() {
    let f = Fixture::from_bytes(include_bytes!("../../../conformance/check-missing-item.kfilm"), Default::default());
    let made = f.colleague(&[("file.newColorMatte", json!({"seconds": 2}))]);
    let source = made[0]["item"].as_u64().unwrap().to_string();
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[0];
    let ran = f.ok("batch", json!({"changes": "all", "ops": [{"op": "set", "target": clip, "field": "item", "value": source}]})).await;
    let loaded = f.ok("query", json!({"objects": [clip], "fields": ["item", "missingItem"]})).await;
    assert!(loaded["objects"][0]["fields"]["missingItem"].is_null(), "{loaded}");
    assert!(
        entry(&ran["changes"]["changed"], &clip.to_string())["edits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edit| edit["field"] == "missingItem" && edit["before"] == 8 && edit["after"].is_null()),
        "{ran}"
    );
    let saved = std::fs::read(f.file()).unwrap();
    f.shutdown().await;
    let g = Fixture::from_bytes(&saved, Default::default());
    let reopened = g.ok("query", json!({"objects": [clip], "fields": ["item", "missingItem"]})).await;
    assert_eq!(reopened["objects"][0]["fields"], loaded["objects"][0]["fields"]);
    g.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reordering_clips_cannot_receipt_an_unstored_order() {
    let f = Fixture::new(3);
    let (sequence, _) = f.inspect().await;
    let track = sequence["video"][0]["id"].as_u64().unwrap();
    let before = v1_on_disk(&f.file());
    let ran = f.ok("batch", json!({"ops": [{"op": "list.move", "target": track, "field": "clips", "from": 0, "to": 2}]})).await;
    assert!(ran["changes"]["moved"].as_array().unwrap().is_empty(), "chronological order is derived from start times: {ran}");
    assert_eq!(v1_on_disk(&f.file()), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_sequence_receipts_every_owned_track_and_clip() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let mut expected = vec![sequence["id"].as_u64().unwrap().to_string()];
    expected.extend(v1(&sequence).iter().map(u64::to_string));
    for kind in ["video", "audio"] {
        expected.extend(sequence[kind].as_array().unwrap().iter().map(|track| track["id"].as_u64().unwrap().to_string()));
    }
    expected.sort();
    let ran = f.ok("batch", json!({"changes": "all", "ops": [{"op": "delete", "target": sequence["id"]}]})).await;
    let mut deleted = ids(&ran["changes"]["deleted"]);
    deleted.sort();
    assert_eq!(deleted, expected, "{ran}");
    let disk = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
    assert!(disk.inspect().unwrap()["sequence"].is_null());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_track_commands_hold_only_the_named_track() {
    for command in ["captions.setTrack", "captions.deleteTrack", "captions.setStyle"] {
        for change in ["clip", "other track", "same track"] {
            let f = Fixture::new(3);
            f.colleague(&[("captions.newTrack", json!({"name": "Mine"})), ("captions.newTrack", json!({"name": "Other"}))]);
            let tracks = f.ok("run", json!({"steps": [{"command": "captions.list"}]})).await;
            let track = tracks["completed"][0]["result"]["tracks"][0]["id"].as_u64().unwrap();
            let (sequence, basis) = f.inspect().await;
            f.colleague(&[match change {
                "clip" => opacity(v1(&sequence)[0], 30.0),
                "other track" => ("captions.setTrack", json!({"track": "C2", "name": "Theirs"})),
                _ => ("captions.setTrack", json!({"track": track, "name": "Theirs"})),
            }]);
            let params = match command {
                "captions.setTrack" => json!({"track": track, "name": "Mine again"}),
                "captions.setStyle" => json!({"track": track, "size": 40}),
                _ => json!({"track": track}),
            };
            let answer = f.call("run", json!({"basis": basis, "steps": [{"command": command, "params": params}]})).await;
            // A size patch does not read
            // name. captions.rs:361-418 writes only supplied style leaves.
            // Same-track rename + setStyle: conflict -> apply, preserving name.
            if change == "same track" && command != "captions.setStyle" {
                assert_conflict(&answer.expect_err(command), &sequence["id"].as_u64().unwrap().to_string(), "changed");
            } else {
                answer.unwrap_or_else(|e| panic!("{command} after {change}: {e}"));
                let mut disk = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
                let saved = kition_kit::KitDocument::execute(&mut disk, "captions.list", json!({})).unwrap();
                let mine = saved["tracks"].as_array().unwrap().iter().find(|found| found["id"] == track);
                match command {
                    "captions.setTrack" => assert_eq!(mine.unwrap()["name"], "Mine again"),
                    "captions.setStyle" => assert_eq!(mine.unwrap()["style"]["size"], 40.0),
                    _ => assert!(mine.is_none()),
                }
                if change == "clip" {
                    assert_eq!(opacity_on_disk(&f.file(), v1(&sequence)[0]), 30.0);
                } else {
                    assert!(saved["tracks"].as_array().unwrap().iter().any(|found| found["name"] == "Theirs"));
                }
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_track_ordinals_cannot_retarget_after_a_delete() {
    for target in [json!("C1"), serde_json::Value::Null] {
        let f = Fixture::new(2);
        f.colleague(&[("captions.newTrack", json!({"name": "First"})), ("captions.newTrack", json!({"name": "Second"}))]);
        let (sequence, basis) = f.inspect().await;
        f.colleague(&[("captions.deleteTrack", json!({"track": "C1"}))]);
        let before = std::fs::read(f.file()).unwrap();
        let answer =
            f.refused("run", json!({"basis": basis, "steps": [{"command": "captions.setTrack", "params": {"track": target, "name": "Wrong track"}}]})).await;
        assert_conflict(&answer, &sequence["id"].as_u64().unwrap().to_string(), "changed");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn automation_holds_only_the_tracks_and_intervals_it_writes() {
    for case in ["other track", "written track", "after overlap", "between markers"] {
        let f = Fixture::new(24);
        let (initial, _) = f.inspect().await;
        let clear = initial["video"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|clip| {
                let start = clip["start"].as_i64().unwrap();
                (10 * SECOND..22 * SECOND).contains(&start)
            })
            .map(|clip| clip["clip"].clone())
            .collect::<Vec<_>>();
        f.colleague(&[("edit.clear", json!({"clips": clear}))]);
        if case == "between markers" {
            f.colleague(&[("markers.add", json!({"seconds": 10})), ("markers.add", json!({"seconds": 20}))]);
        }
        let (sequence, basis) = f.inspect().await;
        let item = sequence["video"][0]["items"][1]["item"].as_u64().unwrap();
        let track = if case == "other track" { "V2" } else { "V1" };
        let seconds = match case {
            "after overlap" => 11.6,
            "between markers" => 15.0,
            _ => 10.0,
        };
        let placed = f.colleague(&[("timeline.place", json!({"item": item, "track": track, "seconds": seconds}))]);
        let theirs = placed[0]["clips"][0].as_u64().unwrap();
        let mut params = json!({"items": [item, item], "method": "overwrite", "videoTransition": false, "audioTransition": false});
        if case == "between markers" {
            params["placement"] = json!("unnumberedMarkers");
        }
        let answer = f.call("run", json!({"basis": basis, "steps": [{"command": "clip.automateToSequence", "params": params, "at": {"time": 10}}]})).await;
        if case == "written track" {
            assert_conflict(&answer.expect_err(case), &theirs.to_string(), "relocated");
        } else {
            answer.unwrap_or_else(|e| panic!("{case}: {e}"));
            let disk = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
            let saved = kition_kit::KitDocument::inspect(&disk).unwrap();
            assert!(
                saved["sequence"]["video"].as_array().unwrap().iter().any(|track| track["items"].as_array().unwrap().iter().any(|clip| clip["clip"] == theirs)),
                "colleague clip {theirs} lost: {saved}"
            );
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn automation_at_markers_holds_captions_it_ripples() {
    for sync in [true, false] {
        let f = Fixture::new(2);
        let made = f.colleague(&[("captions.newTrack", json!({"name": "Captions"})), ("markers.add", json!({"seconds": 10}))]);
        let track = made[0]["track"].as_u64().unwrap();
        f.colleague(&[("captions.setTrack", json!({"track": track, "syncLock": sync}))]);
        let (sequence, basis) = f.inspect().await;
        let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
        f.colleague(&[("captions.add", json!({"track": track, "seconds": 15, "durationSeconds": 1, "text": "Theirs"}))]);
        let before = std::fs::read(f.file()).unwrap();
        let mut disk = kition_film_kit::FilmDocument::open(FILE, &before).unwrap();
        let captions_before = disk.execute("captions.list", json!({})).unwrap();
        let answer = f.call("run", json!({"basis": basis, "steps": [{"command": "clip.automateToSequence", "params": {"items": [item], "method": "insert", "placement": "unnumberedMarkers"}}]})).await;
        if sync {
            assert_conflict(&answer.expect_err("the newly added caption would ripple"), &sequence["id"].as_u64().unwrap().to_string(), "changed");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            answer.unwrap();
            let mut disk = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
            let saved = disk.execute("captions.list", json!({})).unwrap();
            assert_eq!(saved["tracks"][0]["captions"], captions_before["tracks"][0]["captions"]);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn automation_refuses_an_occupied_interval_replaced_by_a_colleague() {
    let f = Fixture::new(12);
    let (sequence, basis) = f.inspect().await;
    let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
    f.colleague(&[("timeline.place", json!({"item": item, "track": "V1", "seconds": 10}))]);
    let before = std::fs::read(f.file()).unwrap();
    let answer = f
        .refused(
            "run",
            json!({"basis": basis, "steps": [{"command": "clip.automateToSequence", "params": {"items": [item], "method": "overwrite"}, "at": {"time": 10}}]}),
        )
        .await;
    assert_eq!(answer["error"]["code"], "conflict", "{answer}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_effect_definition_is_read_only() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    f.refused("batch", json!({"ops": [{"op": "set", "target": v1(&sequence)[0], "field": "effects.0.def", "value": "opacity"}]})).await;
    let schema = f.ok("query", json!({"describe": "*"})).await;
    assert_eq!(schema["describe"]["types"]["Effect"]["fields"]["def"]["readOnly"], true);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_video_clip_cannot_move_to_an_audio_track() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let video = sequence["video"][0]["id"].as_u64().unwrap();
    let audio = sequence["audio"][0]["id"].as_u64().unwrap();
    let clip = v1(&sequence)[0];
    let before = std::fs::read(f.file()).unwrap();
    f.refused(
        "batch",
        json!({"ops": [
            {"op": "list.remove", "target": video, "field": "clips", "index": 0},
            {"op": "list.insert", "target": audio, "field": "clips", "index": 0, "item": clip}
        ]}),
    )
    .await;
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_video_clip_cannot_move_to_audio_by_command() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[0];
    f.refused("run", json!({"steps": [{"command": "timeline.move", "params": {"moves": [{"clip": clip, "track": "A1", "time": 0}]}}]})).await;
    f.shutdown().await;
}
