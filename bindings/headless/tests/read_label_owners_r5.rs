//! C8-film-read: field patches keep their owning sequence, not a track index.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId, Label, Track, TrackId, TrackKind};
use kition_kit::KitDocument;
use serde_json::json;

async fn field_pairs(commands: &[&str], explicit: bool) {
    let mut failures = Vec::new();
    for command in commands.iter().copied() {
        for change in ["none", "video-track", "audio-track", "sequence", "track-sequence", "label"] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let sequence = ItemId(doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap());
            let other = ItemId(doc.execute("sequence.new", json!({"name":"Another sequence"})).unwrap()["sequence"].as_u64().unwrap());
            doc.execute("sequence.open", json!({"item":sequence.0})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (q, _) = f.inspect().await;
            let clip = ClipId(v1(&q)[0]);
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "timeline.select", json!({"clips":[clip.0]}).as_object().unwrap().clone())
                .await
                .unwrap();
            let selected = f.kits.context(kition_kits::Caller::User, view.kit_id, &view.document_id, "context.get", Default::default()).await.unwrap().unwrap();
            assert_eq!(selected["state"]["selection"], json!([clip.0]), "fixture selection: {selected}");
            let (_, basis) = f.inspect().await;
            let selected = f.kits.context(kition_kits::Caller::User, view.kit_id, &view.document_id, "context.get", Default::default()).await.unwrap().unwrap();
            assert_eq!(selected["state"]["selection"], json!([clip.0]), "inspection changed fixture selection: {selected}");
            if change != "none" {
                rewrite(&f.file(), |p| {
                    if change == "label" {
                        let it = p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1;
                        if command == "clip.rename" {
                            it.name = "Colleague".into();
                        } else if command == "clip.enable" {
                            it.enabled = !it.enabled;
                        } else {
                            it.label = if it.label == Label::Green { Label::Iris } else { Label::Green };
                        }
                        return;
                    }
                    if change == "track-sequence" {
                        let track = p.sequence_mut(sequence).unwrap().video_tracks.remove(0);
                        p.sequence_mut(other).unwrap().video_tracks.push(track);
                        return;
                    }
                    let item = p.sequence_mut(sequence).unwrap().video_tracks[0].items.remove(0);
                    if change == "sequence" {
                        p.sequence_mut(other).unwrap().video_tracks[0].items.push(item);
                    } else if change == "audio-track" {
                        p.sequence_mut(sequence).unwrap().audio_tracks[0].items.push(item);
                    } else {
                        let mut track = Track::new(TrackId(p.alloc_id()), TrackKind::Video, "Colleague lane".into());
                        track.items.push(item);
                        p.sequence_mut(sequence).unwrap().video_tracks.push(track);
                    }
                });
            }
            let step = if command == "clip.rename" {
                json!({"command":command,"params":{"clip":clip.0,"name":"Agent"}})
            } else if command == "clip.enable" {
                json!({"command":command,"params":{"clips":[clip.0]}})
            } else if !explicit {
                json!({"command":command,"params":if command == "edit.label" {json!({"label":"Violet"})} else {json!({})}})
            } else if command == "edit.label" {
                json!({"command":command,"on":[clip.0],"params":{"label":"Violet"}})
            } else {
                json!({"command":command,"params":{"clips":[clip.0]}})
            };
            let result = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            let name = format!("{command}/explicit={explicit}/{change}");
            if matches!(change, "sequence" | "track-sequence" | "label") {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "{name}: required conflict, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                    ));
                } else if change == "label" {
                    let error = result.as_ref().unwrap_err();
                    assert!(
                        error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == clip.0 && conflict["reason"] == "changed"),
                        "{name}: {error}"
                    );
                }
            } else if let Err(error) = result {
                failures.push(format!("{name}: a track change is unrelated: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let (_, target) = saved.project.sequence(sequence).unwrap().find_item(clip).unwrap();
                let correct = if command == "clip.rename" {
                    target.name == "Agent"
                } else if command == "clip.enable" {
                    !target.enabled
                } else {
                    target.label == if command.ends_with(".blue") { Label::Blue } else { Label::Violet }
                };
                if !correct {
                    failures.push(format!("{name}: reported success without assigning the field"));
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_field_patches_keep_sequence_scope_and_allow_track_moves() {
    field_pairs(&["edit.label", "edit.label.violet", "edit.label.blue", "clip.rename", "clip.enable"], true).await;
}

// The observed implicit selection remains attached to the live session on reread.
#[tokio::test(flavor = "multi_thread")]
async fn implicit_label_selection_survives_file_refresh() {
    field_pairs(&["edit.label", "edit.label.violet", "edit.label.blue"], false).await;
}
