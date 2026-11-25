//! C8-film-read: New Sequence From Clip reads source facts outside the active timeline.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ItemId, Label};
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn new_sequence_from_media_holds_copied_fields_and_indirect_picture_size() {
    let mut failures = Vec::new();
    for subclip in [false, true] {
        for change in ["width", "audio-stream", "sample-rate", "frame-rate", "label", "name", "metadata", "marks", "parent-name"] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let parent = doc.execute("item.newOfflineFile", json!({"name":"Parent","seconds":1,"audio":true})).unwrap()["item"].as_u64().unwrap();
            let source = if subclip {
                doc.execute("clip.makeSubclip", json!({"item":parent,"name":"Subclip","start":0,"end":SECOND/2})).unwrap()["item"].as_u64().unwrap()
            } else {
                parent
            };
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |project| match change {
                "width" => project.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640,
                "audio-stream" => {
                    let media = project.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap();
                    media.info.audio_streams.push(media.info.audio_streams[0].clone());
                }
                "sample-rate" => project.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().info.audio_streams[0].sample_rate = 44100,
                "frame-rate" => {
                    project.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().info.video.as_mut().unwrap().frame_rate =
                        serde_json::from_value(json!({"num":25,"den":1})).unwrap()
                }
                "parent-name" => project.item_mut(ItemId(parent)).unwrap().name = "Renamed parent".into(),
                "marks" => {
                    project.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().mark_out = Some(serde_json::from_value(json!(SECOND / 4)).unwrap())
                }
                other => {
                    let source = project.item_mut(ItemId(source)).unwrap();
                    match other {
                        "label" => source.label = Label::Green,
                        "name" => source.name = "Copied name".into(),
                        _ => {
                            source.metadata.insert("note".into(), "Unrelated".into());
                        }
                    }
                }
            });
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.new","params":{"name":"New","fromItem":source}}]})).await;
            let required =
                matches!(change, "width" | "audio-stream" | "label" | "name") || (matches!(change, "parent-name" | "sample-rate" | "frame-rate") && !subclip);
            if required {
                if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "subclip={subclip}/{change}: must refuse, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                }
            } else if let Ok(ref applied) = result {
                let id = applied["completed"][0]["result"]["sequence"].as_u64().unwrap();
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let q = saved.project.sequence(ItemId(id)).unwrap();
                assert_eq!(q.video_tracks[0].items[0].item.0, source);
                assert_eq!(q.audio_tracks[0].items[0].item.0, source);
            } else if let Err(error) = result {
                failures.push(format!("subclip={subclip}/{change}: must apply: {}", error["error"]));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn new_sequence_from_nested_source_distinguishes_nesting_from_copying() {
    let mut failures = Vec::new();
    for flatten in [false, true] {
        for change in ["duration", "name", "clip-name", "metadata", "track-name", "marks", "departed"] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let media = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
            let source = doc.execute("sequence.new", json!({"name":"Source","video":2,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
            doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(
                    kition_kits::Caller::User,
                    view.kit_id,
                    &view.document_id,
                    "sequence.nestSequences",
                    json!({"on":!flatten}).as_object().unwrap().clone(),
                )
                .await
                .unwrap();
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |project| {
                let item = project.item_mut(ItemId(source)).unwrap();
                match change {
                    "name" => item.name = "Copied outer name".into(),
                    "metadata" => {
                        item.metadata.insert("note".into(), "Unrelated".into());
                    }
                    other => {
                        let q = item.as_sequence_mut().unwrap();
                        match other {
                            "duration" => q.video_tracks[0].items[0].duration.0 += SECOND,
                            "clip-name" => q.video_tracks[0].items[0].name = "Copied inner name".into(),
                            "track-name" => q.video_tracks[0].name = "Unused lane name".into(),
                            "marks" => q.mark_out = Some(serde_json::from_value(json!(SECOND / 4)).unwrap()),
                            _ => {
                                q.video_tracks[0].items.clear();
                            }
                        }
                    }
                }
            });
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.new","params":{"name":"New","fromItem":source}}]})).await;
            let required = matches!(change, "duration" | "departed") || (change == "name" && !flatten) || (change == "clip-name" && flatten);
            if required {
                if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "flatten={flatten}/{change}: must refuse, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                }
            } else if let Ok(ref applied) = result {
                let id = applied["completed"][0]["result"]["sequence"].as_u64().unwrap();
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let q = saved.project.sequence(ItemId(id)).unwrap();
                assert_eq!(q.video_tracks[0].items.len(), 1);
                assert_eq!(q.video_tracks[0].items[0].item.0, if flatten { media.as_u64().unwrap() } else { source });
                assert_eq!(q.audio_tracks.iter().map(|track| track.items.len()).sum::<usize>(), 0);
            } else if let Err(error) = result {
                failures.push(format!("flatten={flatten}/{change}: must apply: {}", error["error"]));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn new_sequence_media_ignores_an_unused_channel_format() {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let source = doc.execute("item.newOfflineFile", json!({"name":"Source","seconds":1,"audio":true})).unwrap()["item"].as_u64().unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        project.item_mut(ItemId(source)).unwrap().as_media_mut().unwrap().interpret.audio_channels =
            Some(kition_film_project::AudioChannelMap { format: kition_film_project::AudioChannels::Mono, clips: Vec::new() });
    });
    let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.new","params":{"name":"New","fromItem":source}}]})).await;
    let applied = result.unwrap_or_else(|error| panic!("an unused format with no channel map changes no placement: {}", error["error"]));
    let id = applied["completed"][0]["result"]["sequence"].as_u64().unwrap();
    let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
    let q = saved.project.sequence(ItemId(id)).unwrap();
    assert_eq!(q.audio_tracks[0].items.len(), 1);
    assert!(q.audio_tracks[0].items[0].source_channels.is_empty());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn full_source_copy_uses_the_true_end_of_an_unsorted_loaded_track() {
    let mut failures = Vec::new();
    for related in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
        let media = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
        let source = doc.execute("sequence.new", json!({"name":"Unsorted source","video":1,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
        doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
        doc.execute("timeline.place", json!({"item":media,"track":"V1","time":2*SECOND})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        rewrite(&f.file(), |p| p.sequence_mut(ItemId(source)).unwrap().video_tracks[0].items.reverse());
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "sequence.nestSequences", json!({"on":false}).as_object().unwrap().clone())
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let track = &mut p.sequence_mut(ItemId(source)).unwrap().video_tracks[0];
            if related {
                track.items.iter_mut().find(|clip| clip.start.0 == 2 * SECOND).unwrap().name = "Copied far name".into();
            } else {
                track.name = "Uncopied lane name".into();
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.new","params":{"name":"New","fromItem":source}}]})).await;
        if related {
            if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                failures.push("a copied far clip's changed name applied".to_owned());
            }
        } else {
            let applied = result.unwrap_or_else(|e| panic!("source order does not make a lane name copied: {}", e["error"]));
            let id = applied["completed"][0]["result"]["sequence"].as_u64().unwrap();
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            assert_eq!(saved.project.sequence(ItemId(id)).unwrap().video_tracks[0].items.len(), 2);
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn new_sequence_from_item_failure_preserves_project_context_and_redo() {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let q = doc.inspect().unwrap()["sequence"].clone();
    let source = q["video"][0]["items"][0]["item"].clone();
    let clip = q["video"][0]["items"][0]["id"].clone();
    doc.execute("clip.rename", json!({"clip":clip,"name":"Temporary"})).unwrap();
    doc.execute("edit.undo", json!({})).unwrap();
    assert_eq!(doc.inspect().unwrap()["canRedo"], true);
    let before = doc.save(None).unwrap();
    let context = doc.inspect().unwrap()["stateDigest"].clone();
    let error = doc.execute("sequence.new", json!({"name":"Must not remain","fromItem":source,"video":0,"audio":0})).unwrap_err();
    assert!(error.contains("no destination track"), "{error}");
    assert!(doc.save(None).unwrap() == before, "a refused compound command left a new sequence or changed the saved view");
    assert_eq!(doc.inspect().unwrap()["stateDigest"], context);
    assert_eq!(doc.inspect().unwrap()["canRedo"], true, "failure must preserve the existing redo branch");
}

#[test]
fn new_sequence_from_item_success_is_one_undo_step() {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let source = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
    let created = doc.execute("sequence.new", json!({"name":"One step","fromItem":source,"video":1,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
    doc.execute("edit.undo", json!({})).unwrap();
    let saved = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    assert!(saved.project.item(ItemId(created)).is_none(), "undo removed only the placement and left the new empty sequence");
    assert!(saved.project.item(ItemId(source.as_u64().unwrap())).is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn sequence_from_clip_holds_parent_placement_and_only_the_first_inherited_rate() {
    let mut failures = Vec::new();
    for first in [true, false] {
        for change in ["width", "rate", "metadata", "deleted-parent"] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let leading = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
            let original = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
            let active = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            let expected_rate = original.project.sequence(ItemId(active)).unwrap().settings.frame_rate;
            let parent = doc.execute("item.newOfflineFile", json!({"name":"Parent","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
            let source = doc.execute("clip.makeSubclip", json!({"item":parent,"name":"Subclip","start":0,"end":SECOND/2})).unwrap()["item"].as_u64().unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                if change == "deleted-parent" {
                    p.items.remove(&ItemId(parent));
                    p.root.remove_item(ItemId(parent));
                } else {
                    let item = p.item_mut(ItemId(parent)).unwrap();
                    match change {
                        "width" => item.as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640,
                        "rate" => {
                            item.as_media_mut().unwrap().info.video.as_mut().unwrap().frame_rate = serde_json::from_value(json!({"num":25,"den":1})).unwrap()
                        }
                        _ => {
                            item.metadata.insert("note".into(), "Unrelated".into());
                        }
                    }
                }
            });
            let items = if first { json!([source]) } else { json!([leading, source]) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.newFromClip","params":{"items":items}}]})).await;
            let required = matches!(change, "width" | "deleted-parent") || (first && change == "rate");
            if required {
                if !matches!(result,Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "first={first}/{change}: must refuse, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                }
            } else {
                let applied = result.unwrap_or_else(|e| panic!("first={first}/{change}: unrelated parent change refused: {}", e["error"]));
                let id = applied["completed"][0]["result"]["sequence"].as_u64().unwrap();
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let q = saved.project.sequence(ItemId(id)).unwrap();
                assert_eq!(q.settings.width, 320);
                assert_eq!(q.settings.frame_rate, expected_rate);
                assert_eq!(q.video_tracks[0].items.len(), if first { 1 } else { 2 });
                assert_eq!(q.video_tracks[0].items.last().unwrap().item.0, source);
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
