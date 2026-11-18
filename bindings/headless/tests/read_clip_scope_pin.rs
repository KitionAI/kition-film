//! Field-only core operations resolve recipients in the active sequence.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId, Track, TrackId, TrackKind};
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn core_field_patches_keep_sequence_scope_and_allow_lane_moves() {
    for command in ["clip.link", "clip.group", "clip.ungroup", "clip.scaleToFrameSize"] {
        for change in ["none", "video", "audio", "sequence"] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let sequence = ItemId(doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap());
            let other = ItemId(doc.execute("file.newSequence", json!({"name":"Other"})).unwrap()["sequence"].as_u64().unwrap());
            doc.execute("sequence.open", json!({"item":sequence.0})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (q, basis) = f.inspect().await;
            let clip = ClipId(v1(&q)[0]);
            if change != "none" {
                rewrite(&f.file(), |p| {
                    let item = p.sequence_mut(sequence).unwrap().video_tracks[0].items.remove(0);
                    if change == "sequence" {
                        p.sequence_mut(other).unwrap().video_tracks[0].items.push(item);
                    } else if change == "audio" {
                        p.sequence_mut(sequence).unwrap().audio_tracks[0].items.push(item);
                    } else {
                        let mut lane = Track::new(TrackId(p.alloc_id()), TrackKind::Video, "Other lane".into());
                        lane.items.push(item);
                        p.sequence_mut(sequence).unwrap().video_tracks.push(lane);
                    }
                });
            }
            let reply = f.call("run", json!({"basis":basis,"steps":[{"command":command,"on":[clip.0],"params":{}}]})).await;
            if change == "sequence" {
                let error = reply.expect_err(&format!("{command}: a departed recipient must be refused"));
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == clip.0), "{command}: {error}");
            } else {
                assert!(reply.is_ok(), "{command}/{change}: {reply:?}");
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let (_, target) = saved.project.sequence(sequence).unwrap().find_item(clip).unwrap();
                match command {
                    "clip.link" => assert!(target.link.is_some()),
                    "clip.group" => assert!(target.group.is_some()),
                    "clip.ungroup" => assert!(target.group.is_none()),
                    _ => assert!(target.scale_to_frame),
                }
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_unlinked_selection_does_not_require_sequence_ownership() {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    let sequence = ItemId(doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap());
    let other = ItemId(doc.execute("file.newSequence", json!({"name":"Other"})).unwrap()["sequence"].as_u64().unwrap());
    doc.execute("sequence.open", json!({"item":sequence.0})).unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (q, basis) = f.inspect().await;
    let clip = v1(&q)[0];
    rewrite(&f.file(), |p| {
        let item = p.sequence_mut(sequence).unwrap().video_tracks[0].items.remove(0);
        p.sequence_mut(other).unwrap().video_tracks[0].items.push(item);
    });
    let reply = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.select","params":{"clips":[clip],"linked":false}}]})).await;
    assert!(reply.is_ok(), "an unlinked selection does not consume ownership: {reply:?}");
    f.shutdown().await;
}
