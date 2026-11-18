//! C8-film-read: flattened Source sequences copy each channel's split range.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

fn split_source() -> (Vec<u8>, u64, u64, ClipId, ClipId) {
    let mut doc = FilmDocument::open(FILE, &project(0)).unwrap();
    let destination = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newSequence", json!({"name":"Split Source","video":1,"audio":1,"fps":25})).unwrap()["sequence"].as_u64().unwrap();
    let media = doc.execute("file.newOfflineFile", json!({"name":"Four seconds","seconds":4,"audio":true})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0,"duration":SECOND,"audio":false})).unwrap();
    let outside = ClipId(
        doc.execute("timeline.place", json!({"item":media,"track":"A1","time":0,"sourceIn":0,"duration":SECOND})).unwrap()["clips"][0].as_u64().unwrap(),
    );
    let copied = ClipId(
        doc.execute("timeline.place", json!({"item":media,"track":"A1","time":2*SECOND,"sourceIn":2*SECOND,"duration":SECOND})).unwrap()["clips"][0]
            .as_u64()
            .unwrap(),
    );
    doc.execute("sequence.open", json!({"item":destination})).unwrap();
    let mut loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    let item = loaded.project.item_mut(ItemId(source)).unwrap();
    let mut time = item.duration();
    time.0 = 0;
    item.split.video_in = Some(time);
    time.0 = SECOND - SECOND / 25;
    item.split.video_out = Some(time);
    time.0 = 2 * SECOND;
    item.split.audio_in = Some(time);
    time.0 = 3 * SECOND - SECOND / 25;
    item.split.audio_out = Some(time);
    time.0 = 5 * SECOND;
    let source_rate = loaded.project.sequence(ItemId(source)).unwrap().settings.frame_rate;
    let destination_sequence = loaded.project.sequence_mut(ItemId(destination)).unwrap();
    // Keep both sequences at 25 fps: regular media placement snaps duration to
    // the destination's frame grid, unlike the flattened clip-copy branch.
    destination_sequence.settings.frame_rate = source_rate;
    destination_sequence.mark_in = Some(time);
    (kition_film_format::encode_with_view(&loaded.project, loaded.view.as_ref(), true), destination, source, outside, copied)
}

#[test]
fn sequence_copy_preserves_separate_audio_source_range_and_offset() {
    for command in ["source.insert", "source.overwrite"] {
        let (bytes, destination, source, _, _) = split_source();
        let mut doc = FilmDocument::open(FILE, &bytes).unwrap();
        doc.execute("source.open", json!({"item":source})).unwrap();
        doc.execute("sequence.nestSequences", json!({"on":false})).unwrap();
        doc.execute(command, json!({})).unwrap();
        let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
        let q = loaded.project.sequence(ItemId(destination)).unwrap();
        let video = &q.video_tracks[0].items[0];
        let audio = &q.audio_tracks[0].items[0];
        assert_eq!((video.start.0, video.source_in.0, video.duration.0), (5 * SECOND, 0, SECOND), "{command}/video");
        assert_eq!((audio.start.0, audio.source_in.0, audio.duration.0), (7 * SECOND, 2 * SECOND, SECOND), "{command}/audio");
    }
}

#[test]
fn equal_channel_split_marks_still_replace_the_ordinary_source_range() {
    for flatten in [false, true] {
        for command in ["source.insert", "source.overwrite"] {
            let (bytes, destination, sequence, _, _) = split_source();
            let mut loaded = kition_film_format::decode(&bytes).unwrap();
            let media = loaded.project.sequence(ItemId(sequence)).unwrap().video_tracks[0].items[0].item;
            let source = if flatten { ItemId(sequence) } else { media };
            let split = loaded.project.item(ItemId(sequence)).unwrap().split;
            let item = loaded.project.item_mut(source).unwrap();
            item.split.video_in = split.audio_in;
            item.split.audio_in = split.audio_in;
            item.split.video_out = split.audio_out;
            item.split.audio_out = split.audio_out;
            let bytes = kition_film_format::encode_with_view(&loaded.project, loaded.view.as_ref(), true);
            let mut doc = FilmDocument::open(FILE, &bytes).unwrap();
            doc.execute("source.open", json!({"item":source.0})).unwrap();
            doc.execute("sequence.nestSequences", json!({"on":false})).unwrap();
            doc.execute(command, json!({})).unwrap();
            let saved = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
            let q = saved.project.sequence(ItemId(destination)).unwrap();
            let video: Vec<_> = q.video_tracks.iter().flat_map(|track| &track.items).collect();
            let audio: Vec<_> = q.audio_tracks.iter().flat_map(|track| &track.items).collect();
            let label = format!("{command}/flatten={flatten}");
            assert_eq!(video.len(), usize::from(!flatten), "{label}/video");
            assert_eq!(audio.len(), 1, "{label}/audio count");
            assert_eq!((audio[0].start.0, audio[0].source_in.0, audio[0].duration.0), (5 * SECOND, 2 * SECOND, SECOND), "{label}/audio range");
        }
    }
}

async fn choose(f: &Fixture, source: u64) {
    let _ = f.inspect().await;
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    for (command, params) in [("source.open", json!({"item":source})), ("sequence.nestSequences", json!({"on":false}))] {
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sequence_copy_holds_audio_inside_its_split_range_and_allows_audio_outside() {
    let mut failures = Vec::new();
    for command in ["source.insert", "source.overwrite"] {
        for change in ["copied-audio", "outside-audio", "metadata"] {
            let (bytes, destination, source, outside, copied) = split_source();
            let f = Fixture::from_bytes(&bytes, Default::default());
            choose(&f, source).await;
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                if change == "metadata" {
                    p.item_mut(ItemId(source)).unwrap().metadata.insert("note".into(), "Colleague".into());
                } else {
                    let id = if change == "copied-audio" { copied } else { outside };
                    p.sequence_mut(ItemId(source)).unwrap().find_item_mut(id).unwrap().1.name = "Colleague".into();
                }
            });
            choose(&f, source).await;
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"at":{"part":{"sequence":destination}},"params":{}}]})).await;
            let label = format!("{command}/{change}");
            if change == "copied-audio" {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "{label}: copied audio changed, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                    ));
                }
            } else if let Err(error) = result {
                failures.push(format!("{label}: unrelated change refused: {error}"));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let source_item = saved.project.item(ItemId(source)).unwrap();
                if change == "metadata" {
                    assert_eq!(source_item.metadata["note"], "Colleague", "{label}");
                } else {
                    assert_eq!(source_item.as_sequence().unwrap().find_item(outside).unwrap().1.name, "Colleague", "{label}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
