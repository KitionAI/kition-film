//! C8-film-read: saved-file writer pairs for sequence dependencies read independently.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn subsequence_copies_layout_but_not_source_track_mute() {
    for related in [true, false] {
        let f = Fixture::new(4);
        f.colleague(&[("markers.markIn", json!({"time":SECOND})), ("markers.markOut", json!({"time":2*SECOND}))]);
        let (sequence, basis) = f.inspect().await;
        let track = sequence["video"][0]["id"].as_u64().unwrap();
        f.colleague(&[("timeline.setTrack", if related { json!({"track":track,"name":"Copied name"}) } else { json!({"track":track,"muted":true}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.makeSubsequence","params":{"name":"Mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("copied track name changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("source mute is not copied: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn simplify_copies_all_clip_content_but_not_source_metadata() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (sequence, basis) = f.inspect().await;
        if related {
            f.colleague(&[("clip.rename", json!({"clip":v1(&sequence)[2],"name":"Copied clip"}))]);
        } else {
            rewrite(&f.file(), |p| {
                p.item_mut(ItemId(sequence["id"].as_u64().unwrap())).unwrap().metadata.insert("unrelated".into(), "theirs".into());
            });
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.simplify","params":{"name":"Mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("copied clip changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("source metadata is not copied: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn gap_navigation_holds_distant_geometry_but_not_clip_names() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (sequence, basis) = f.inspect().await;
        let clip = v1(&sequence)[3];
        if related {
            rewrite(&f.file(), |p| {
                let q = p.sequence_mut(ItemId(sequence["id"].as_u64().unwrap())).unwrap();
                q.find_item_mut(ClipId(clip)).unwrap().1.start.0 += SECOND;
            });
        } else {
            f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Unrelated name"}))]);
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.goToNextGap","params":{}}]})).await;
        if related {
            assert_eq!(answer.expect_err("next gap changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("a name cannot alter gaps: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn track_insertion_holds_renumbered_names_but_not_mute() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (sequence, basis) = f.inspect().await;
        let track = sequence["video"][1]["id"].as_u64().unwrap();
        f.colleague(&[("timeline.setTrack", if related { json!({"track":track,"name":"Theirs"}) } else { json!({"track":track,"muted":true}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":"first"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("renumbering reads old name")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("mute does not affect renumbering: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_track_deletion_holds_emptiness_but_not_kept_track_names() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (sequence, basis) = f.inspect().await;
        let v2 = sequence["video"][1]["id"].as_u64().unwrap();
        if related {
            f.colleague(&[("timeline.move", json!({"moves":[{"clip":v1(&sequence)[3],"track":v2,"time":3*SECOND}],"linked":false}))]);
        } else {
            f.colleague(&[("timeline.setTrack", json!({"track":sequence["video"][0]["id"],"name":"Kept"}))]);
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.deleteTracks","params":{"video":"empty"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("track no longer empty")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("kept track name is irrelevant: {error}"));
        }
        f.shutdown().await;
    }
}

fn multicam() -> (Fixture, u64, u64, u64) {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newSequence", json!({"name":"Camera source","video":2,"audio":1})).unwrap()["sequence"].as_u64().unwrap();
    let media = doc.execute("file.newColorMatte", json!({"name":"Camera","seconds":2})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","seconds":0})).unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V2","seconds":0})).unwrap();
    doc.execute("sequence.open", json!({"item":sequence})).unwrap();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V2","seconds":0,"duration":2*SECOND})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("clip.multicamEnable", json!({"clips":[clip],"enabled":true})).unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), sequence, source, clip)
}

#[tokio::test(flavor = "multi_thread")]
async fn multicamera_switch_holds_camera_map_but_not_clip_name() {
    for related in [true, false] {
        let (f, _, source, clip) = multicam();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            if related {
                let q = p.sequence_mut(ItemId(source)).unwrap();
                q.video_tracks.reverse();
            } else {
                for item in p.items.values_mut() {
                    if let kition_film_project::ItemKind::Sequence(q) = &mut item.kind
                        && let Some((_, found)) = q.find_item_mut(ClipId(clip))
                    {
                        found.name = "Unrelated".into();
                    }
                }
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"multicam.switchAngle","params":{"clips":[clip],"camera":1}}]})).await;
        if related {
            assert_eq!(answer.expect_err("camera one now names another track")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("clip name does not affect its angle: {error}"));
        }
        f.shutdown().await;
    }
}

#[test]
fn simplified_sequence_has_independent_object_identities() {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let before = doc.inspect().unwrap()["sequence"].clone();
    let original = before["id"].as_u64().unwrap();
    let original_clips = v1(&before);
    doc.execute("sequence.simplify", json!({"name":"Copy"})).unwrap();
    let copy = doc.inspect().unwrap()["sequence"].clone();
    let copy_clips = v1(&copy);
    assert!(copy_clips.iter().all(|clip| !original_clips.contains(clip)), "copied clips must receive fresh stable identities");
    doc.execute("clip.rename", json!({"clip":copy_clips[0],"name":"Copy only"})).unwrap();
    doc.execute("sequence.open", json!({"item":original})).unwrap();
    assert_eq!(doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["name"], before["video"][0]["items"][0]["name"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn source_marker_edit_holds_the_assigned_field_but_not_source_metadata() {
    for related in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
        let source = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap();
        doc.execute("source.open", json!({"item":source})).unwrap();
        let marker = doc.execute("markers.add", json!({"target":"source","time":0,"name":"Old"})).unwrap()["marker"].as_u64().unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "source.open", json!({"item":source}).as_object().unwrap().clone())
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let item = p.item_mut(ItemId(source)).unwrap();
            if related {
                item.as_media_mut().unwrap().markers.iter_mut().find(|m| m.id.0 == marker).unwrap().name = "Theirs".into();
            } else {
                item.metadata.insert("description".into(), "Unrelated".into());
            }
        });
        let answer =
            f.call("run", json!({"basis":basis,"steps":[{"command":"markers.edit","params":{"target":"source","marker":marker,"name":"Mine"}}]})).await;
        if related {
            let error = answer.expect_err("source marker same-field overwrite");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            answer.unwrap_or_else(|error| panic!("source metadata is not assigned: {error}"));
        }
        f.shutdown().await;
    }
}
