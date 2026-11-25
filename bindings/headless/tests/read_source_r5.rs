//! C8-film-read: Source placement consumes marked media and destination facts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ItemId, Label};
use kition_kit::KitDocument;
use serde_json::json;

async fn open_source(f: &Fixture, source: u64) {
    // Select Source before observation. The public SDK compares canonical active
    // state; selecting it after basis would itself be a relevant person edit.
    let _ = f.inspect().await;
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    f.kits
        .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "source.open", json!({"item":source}).as_object().unwrap().clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn source_selected_by_a_prior_step() {
    // The isolated plan opens Source before reading the following placement's premises.
    for command in ["source.insert", "source.overwrite"] {
        for related in [true, false] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let source = doc.execute("item.newOfflineFile", json!({"name":"Source","seconds":1,"audio":false})).unwrap()["item"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (q, basis) = f.inspect().await;
            if related {
                f.colleague(&[("project.setMarks", json!({"item":source,"out":SECOND/2}))]);
            } else {
                f.colleague(&[("metadata.set", json!({"item":source,"field":"Description","value":"Unrelated"}))]);
            }
            let result = f
                .call(
                    "run",
                    json!({"basis":basis,"steps":[
                        {"command":"source.open","params":{"item":source}},
                        {"command":command,"at":{"part":{"sequence":q["id"]},"time":1.0},"params":{}}
                    ]}),
                )
                .await;
            if related {
                assert_eq!(result.expect_err("the copied Source range changed")["error"]["code"], "conflict", "{command}");
            } else {
                result.unwrap_or_else(|e| panic!("uncopied Source metadata is unrelated ({command}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn source_placement_holds_copied_identity_geometry_and_program_in() {
    let mut failures = Vec::new();
    for command in ["source.insert", "source.overwrite"] {
        for field in ["label", "source-size", "split", "program-in", "sequence-size", "lock", "metadata"] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let source = doc.execute("item.newOfflineFile", json!({"name":"Source","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            open_source(&f, source).await;
            let (q, basis) = f.inspect().await;
            let qid = ItemId(q["id"].as_u64().unwrap());
            rewrite(&f.file(), |p| {
                let item = p.item_mut(ItemId(source)).unwrap();
                match field {
                    "label" => item.label = Label::Green,
                    "source-size" => item.as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640,
                    "split" => item.split.video_in = Some(serde_json::from_value(json!(SECOND / 4)).unwrap()),
                    "program-in" => p.sequence_mut(qid).unwrap().mark_in = Some(serde_json::from_value(json!(SECOND / 4)).unwrap()),
                    "sequence-size" => p.sequence_mut(qid).unwrap().settings.width = 640,
                    "lock" => p.sequence_mut(qid).unwrap().video_tracks[0].locked = true,
                    _ => {
                        item.metadata.insert("note".into(), "Unrelated".into());
                    }
                }
            });
            let answer = f
                .call(
                    "run",
                    json!({"basis":basis,"steps":[
                        {"command":command,"at":{"part":{"sequence":q["id"]},"time":1.0},"params":{}}
                    ]}),
                )
                .await;
            let correct = if field == "metadata" { answer.is_ok() } else { matches!(answer, Err(ref e) if e["error"]["code"] == "conflict") };
            if !correct {
                failures.push(format!("{command}/{field}: {}", answer.as_ref().map(|_| "accepted".to_owned()).unwrap_or_else(|e| e["error"].to_string())));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn source_placement_holds_the_live_sources_marked_range() {
    for command in ["source.insert", "source.overwrite"] {
        for related in [true, false] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let source = doc.execute("item.newOfflineFile", json!({"name":"Source","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            open_source(&f, source).await;
            let (q, basis) = f.inspect().await;
            f.colleague(&[(
                if related { "project.setMarks" } else { "metadata.set" },
                if related { json!({"item":source,"out":SECOND/2}) } else { json!({"item":source,"field":"Description","value":"Unrelated"}) },
            )]);
            let answer = f
                .call(
                    "run",
                    json!({"basis":basis,"steps":[
                        {"command":command,"at":{"part":{"sequence":q["id"]},"time":1.0},"params":{}}
                    ]}),
                )
                .await;
            if related {
                assert_eq!(answer.expect_err("the copied Source range changed")["error"]["code"], "conflict", "{command}");
            } else {
                answer.unwrap_or_else(|e| panic!("uncopied metadata is unrelated ({command}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn source_sequences_hold_copied_material_and_each_destination() {
    use kition_film_project::ClipId;
    let mut failures = Vec::new();
    for flatten in [false, true] {
        for change in [
            "duration",
            "copied-name",
            "deleted-piece",
            "deleted-transition",
            "second-lock",
            "second-appearance",
            "track-name",
            "empty-track",
            "empty-audio",
            "outside-name",
        ] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let before = doc.inspect().unwrap()["sequence"].clone();
            let destination = before["id"].as_u64().unwrap();
            let media = before["video"][0]["items"][0]["item"].clone();
            let source = doc.execute("sequence.new", json!({"name":"Source sequence","video":2,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
            let first = doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
            let last = doc.execute("timeline.place", json!({"item":media,"track":"V1","time":SECOND})).unwrap()["clips"][0].as_u64().unwrap();
            if change == "deleted-transition" {
                doc.execute("sequence.applyVideoTransition", json!({"clip":first,"edge":"out","frames":6})).unwrap();
            }
            doc.execute("timeline.place", json!({"item":media,"track":"V2","time":0})).unwrap();
            if change == "outside-name" {
                doc.execute("project.setMarks", json!({"item":source,"out":SECOND/2})).unwrap();
            }
            doc.execute("sequence.open", json!({"item":destination})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            open_source(&f, source).await;
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
                let empty = matches!(change, "empty-track" | "empty-audio").then(|| project.alloc_id());
                let q = project.sequence_mut(ItemId(source)).unwrap();
                match change {
                    "duration" => q.find_item_mut(ClipId(last)).unwrap().1.duration.0 += SECOND,
                    "copied-name" => q.find_item_mut(ClipId(first)).unwrap().1.name = "Copied colleague name".into(),
                    "deleted-piece" => q.video_tracks[0].items.retain(|clip| clip.id != ClipId(first)),
                    "deleted-transition" => q.video_tracks[0].transitions.clear(),
                    "empty-track" => q.video_tracks.push(kition_film_project::Track::new(
                        kition_film_project::TrackId(empty.unwrap()),
                        kition_film_project::TrackKind::Video,
                        "Unused".into(),
                    )),
                    "empty-audio" => q.audio_tracks.push(kition_film_project::Track::new(
                        kition_film_project::TrackId(empty.unwrap()),
                        kition_film_project::TrackKind::Audio,
                        "Unused audio".into(),
                    )),
                    "outside-name" => q.find_item_mut(ClipId(last)).unwrap().1.name = "Outside the copied marks".into(),
                    "track-name" => q.video_tracks[0].name = "Uncopied track name".into(),
                    "second-lock" => project.sequence_mut(ItemId(destination)).unwrap().video_tracks[1].locked = true,
                    _ => {}
                }
            });
            if change == "second-appearance" {
                f.colleague(&[("timeline.place", json!({"item":media,"track":"V2","time":SECOND}))]);
            }
            let result = f
                .call("run", json!({"basis":basis,"steps":[{"command":"source.overwrite","at":{"part":{"sequence":destination},"time":1.0},"params":{}}]}))
                .await;
            let required = change == "duration"
                || (!flatten && change == "empty-audio")
                || (flatten && !matches!(change, "track-name" | "empty-track" | "empty-audio" | "outside-name"));
            if required {
                if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "flatten={flatten}/{change}: must refuse: {}",
                        result.as_ref().map(|_| "applied".into()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                }
            } else if let Err(e) = result {
                failures.push(format!("flatten={flatten}/{change}: must apply: {e}"));
            } else if let Ok(answer) = result {
                let placed = answer["completed"][0]["result"]["clips"].as_array().unwrap();
                assert_eq!(placed.len(), if flatten { if change == "outside-name" { 2 } else { 3 } } else { 1 }, "{answer}");
                let saved = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap().inspect().unwrap();
                for id in placed {
                    let clip = saved["sequence"]["video"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .flat_map(|track| track["items"].as_array().unwrap())
                        .find(|clip| clip["clip"] == *id)
                        .unwrap();
                    assert_eq!(clip["item"], if flatten { media.clone() } else { json!(source) }, "{clip}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn split_media_source_holds_secondary_destinations_and_new_track_templates() {
    use kition_film_project::{Track, TrackId, TrackKind};
    let mut failures = Vec::new();
    for command in ["source.insert", "source.overwrite"] {
        for change in [
            "secondary-lock",
            "secondary-content",
            "secondary-replaced",
            "secondary-deleted",
            "track-name",
            "far-lock",
            "before-primary",
            "template-volume",
            "template-name",
        ] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let source =
                doc.execute("item.newOfflineFile", json!({"name":"Split Source","seconds":1,"video":false,"audio":true})).unwrap()["item"].as_u64().unwrap();
            doc.execute("timeline.place", json!({"item":source,"track":"A2","time":0})).unwrap();
            let q = doc.inspect().unwrap()["sequence"].clone();
            let qid = ItemId(q["id"].as_u64().unwrap());
            let primary = q["audio"][0]["id"].as_u64().unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            rewrite(&f.file(), |p| {
                let media = p.item_mut(ItemId(source)).unwrap().as_media_mut().unwrap();
                media.info.audio_streams.push(media.info.audio_streams[0].clone());
                if change.starts_with("template-") {
                    p.sequence_mut(qid).unwrap().audio_tracks.truncate(1);
                }
            });
            open_source(&f, source).await;
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(
                    kition_kits::Caller::User,
                    view.kit_id,
                    &view.document_id,
                    "timeline.setTargeting",
                    json!({"track":primary,"sourcePatch":true}).as_object().unwrap().clone(),
                )
                .await
                .unwrap();
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let allocated = TrackId(p.alloc_id());
                let q = p.sequence_mut(qid).unwrap();
                match change {
                    "secondary-lock" => q.audio_tracks[1].locked = true,
                    "secondary-content" => q.audio_tracks[1].items[0].enabled = false,
                    "secondary-replaced" => q.audio_tracks[1].id = allocated,
                    "secondary-deleted" => q.audio_tracks[1].items.clear(),
                    "track-name" => q.audio_tracks[1].name = "Uncopied lane name".into(),
                    "far-lock" => q.audio_tracks[2].locked = true,
                    "before-primary" => q.audio_tracks.insert(0, Track::new(allocated, TrackKind::Audio, "Before patched destination".into())),
                    "template-volume" => q.audio_tracks[0].volume_db = -12.0,
                    _ => q.audio_tracks[0].name = "Uncopied template name".into(),
                }
            });
            // A source patch names a track by identity. An insertion before it
            // does not alter the following destination tracks or the result.
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"at":{"part":{"sequence":q["id"]},"time":0.0},"params":{}}]})).await;
            let required = matches!(change, "secondary-lock" | "secondary-content" | "secondary-replaced" | "secondary-deleted" | "template-volume");
            if required {
                if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "{command}/{change}: must refuse, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                }
            } else if let Ok(ref applied) = result {
                let copied = applied["completed"][0]["result"]["clips"].as_array().unwrap();
                assert_eq!(copied.len(), 2);
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let q = saved.project.sequence(qid).unwrap();
                let placed: Vec<_> = copied.iter().map(|id| q.find_item(kition_film_project::ClipId(id.as_u64().unwrap())).unwrap()).collect();
                assert!(placed.iter().all(|(_, clip)| clip.item.0 == source));
                assert_eq!(placed[0].0.0, primary);
                assert_eq!(placed.iter().map(|(_, clip)| clip.audio_stream).collect::<Vec<_>>(), [0, 1]);
            } else if let Err(e) = result {
                failures.push(format!("{command}/{change}: must apply: {}", e["error"]));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
