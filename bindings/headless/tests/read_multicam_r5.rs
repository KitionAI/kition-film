//! C8-film-read: keyboard camera routes consume the same observed camera map.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

fn cameras() -> (Fixture, u64, u64, u64) {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("sequence.new", json!({"name":"Cameras","video":2,"audio":1})).unwrap()["sequence"].as_u64().unwrap();
    for (track, color) in [("V1", "#ff0000"), ("V2", "#0000ff")] {
        let item = doc.execute("item.newColorMatte", json!({"color":color,"seconds":2})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":item,"track":track,"time":0})).unwrap();
    }
    doc.execute("sequence.open", json!({"item":sequence})).unwrap();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V2","time":0,"duration":2*SECOND})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("clip.multicamEnable", json!({"clips":[clip],"enabled":true})).unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), sequence, source, clip)
}

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_camera_writes_hold_the_nested_camera_map() {
    let mut failures = Vec::new();
    for (command, params, angle, cut) in [
        ("multicam.selectCamera1", json!({}), 0, false),
        ("multicam.cutToCamera2", json!({}), 1, true),
        ("multicam.cut", json!({"camera":2}), 1, false),
        ("multicam.cutToCamera", json!({"camera":2}), 1, true),
    ] {
        for related in [true, false] {
            let (f, sequence, source, clip) = cameras();
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                if related {
                    p.sequence_mut(ItemId(source)).unwrap().video_tracks.reverse();
                } else {
                    p.item_mut(ItemId(source)).unwrap().metadata.insert("description".into(), "Colleague".into());
                }
            });
            let result =
                f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"part":{"sequence":sequence},"time":1.0}}]})).await;
            if related {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!("{command}: the observed camera map changed: {result:?}"));
                }
            } else {
                match result {
                    Err(error) => failures.push(format!("{command}: source metadata is unrelated: {error}")),
                    Ok(_) => {
                        let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                        let q = saved.project.sequence(ItemId(sequence)).unwrap();
                        let (track, original) = q.find_item(ClipId(clip)).unwrap();
                        let parts = &q.track(track).unwrap().items;
                        assert_eq!(parts.len(), if cut { 2 } else { 1 }, "{command}");
                        assert_eq!(parts.last().unwrap().multicam.unwrap().angle, angle, "{command}");
                        assert_eq!(original.item.0, source);
                        assert_eq!(saved.project.item(ItemId(source)).unwrap().metadata["description"], "Colleague");
                    }
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// Replaying from the provisional base used to extend the chosen angle past Stop
// when the caller changed undo scope. Clean rereads must retain the original pass too.
#[tokio::test(flavor = "multi_thread")]
async fn live_camera_stop_preserves_its_pass_across_unrelated_file_refreshes() {
    let mut failures = Vec::new();
    for change in ["none", "metadata", "assigned-clip"] {
        let (f, sequence, source, clip) = cameras();
        let _ = f.inspect().await;
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        for (command, params) in [("multicam.recordStart", json!({"time":0})), ("multicam.cut", json!({"time":SECOND/2,"camera":2}))] {
            f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
        }
        // Reread reconciliation applies to clean sessions. Save the live pass before
        // observing; an outside edit over unsaved work remains an unknown conflict.
        f.kits.save(kition_kits::Caller::User, view.kit_id, &view.document_id).await.unwrap();
        let (_, basis) = f.inspect().await;
        if change != "none" {
            rewrite(&f.file(), |p| {
                if change == "metadata" {
                    p.item_mut(ItemId(source)).unwrap().metadata.insert("description".into(), "Colleague".into());
                } else {
                    p.sequence_mut(ItemId(sequence)).unwrap().find_item_mut(ClipId(clip)).unwrap().1.name = "Colleague".into();
                }
            });
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"multicam.recordStop","params":{"time":SECOND}}]})).await;
        if change == "assigned-clip" {
            if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                failures.push(format!("{change}: the pass restores changed clip content but did not refuse"));
            }
        } else if let Err(error) = result {
            failures.push(format!("{change}: stopping the pass refused: {}", error["error"]));
        } else {
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            let q = saved.project.sequence(ItemId(sequence)).unwrap();
            let (owner, _) = q.find_item(ClipId(clip)).unwrap();
            let track = q.track(owner).unwrap();
            let mut sample = track.items[0].start;
            sample.0 = SECOND * 3 / 2;
            let after_stop = track.item_at(sample).unwrap().multicam.unwrap().angle;
            if after_stop != 0 {
                failures.push(format!("{change}: the provisional angle survives after stop (angle {after_stop})"));
            }
            if change == "metadata" {
                assert_eq!(saved.project.item(ItemId(source)).unwrap().metadata["description"], "Colleague");
            }
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
