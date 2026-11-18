//! C8-film-read: a nested source's duration is receipted as Item content.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn nested_source_bounds_hold_duration_without_holding_source_clip_names() {
    for related in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
        let destination = doc.inspect().unwrap()["sequence"]["id"].clone();
        let media = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
        let source = doc.execute("file.newSequence", json!({"name":"Nested source","video":1,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
        doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
        let source_duration = doc.inspect().unwrap()["sequence"]["duration"].as_i64().unwrap();
        doc.execute("sequence.open", json!({"item":destination})).unwrap();
        let outer = doc.execute("timeline.place", json!({"item":source,"track":"V2","time":0,"duration":SECOND/2})).unwrap()["clips"][0].as_u64().unwrap();
        let q = doc.inspect().unwrap()["sequence"].clone();
        let outer_duration = q["video"][1]["items"][0]["duration"].as_i64().unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |project| {
            let clip = &mut project.sequence_mut(ItemId(source)).unwrap().video_tracks[0].items[0];
            if related {
                clip.duration.0 += SECOND;
            } else {
                clip.name = "Unrelated source name".into();
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.slip","params":{"clip":outer,"delta":SECOND}}]})).await;
        if related {
            let error = result.expect_err("nested source duration changes the slip clamp");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_conflict(&error, &source.to_string(), "changed");
        } else {
            result.unwrap_or_else(|e| panic!("a source clip's name does not bound the slip: {e}"));
            let saved = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap().inspect().unwrap();
            assert_eq!(saved["sequence"]["video"][1]["items"][0]["sourceIn"], source_duration - outer_duration);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn nested_placement_holds_implicit_length_and_copied_name_but_not_metadata() {
    let mut failures = Vec::new();
    for explicit in [false, true] {
        for change in ["duration", "name", "metadata", "clip-name"] {
            let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
            let destination = doc.inspect().unwrap()["sequence"]["id"].clone();
            let media = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
            let source = doc.execute("file.newSequence", json!({"name":"Nested source","video":1,"audio":0})).unwrap()["sequence"].as_u64().unwrap();
            doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
            let source_duration = doc.inspect().unwrap()["sequence"]["duration"].clone();
            doc.execute("sequence.open", json!({"item":destination})).unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |project| {
                let item = project.item_mut(ItemId(source)).unwrap();
                match change {
                    "duration" => item.as_sequence_mut().unwrap().video_tracks[0].items[0].duration.0 += SECOND,
                    "name" => item.name = "Copied colleague name".into(),
                    "metadata" => {
                        item.metadata.insert("note".into(), "Unrelated".into());
                    }
                    _ => item.as_sequence_mut().unwrap().video_tracks[0].items[0].name = "Uncopied clip name".into(),
                }
            });
            let mut params = json!({"item":source,"track":"V2","time":0});
            if explicit {
                params["duration"] = source_duration;
            }
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.place","params":params}]})).await;
            let required = change == "name" || (!explicit && change == "duration");
            if required {
                if !matches!(result, Err(ref e) if e["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "explicit={explicit}/{change}: must refuse: {}",
                        result.as_ref().map(|_| "applied".into()).unwrap_or_else(|e| e["error"].to_string())
                    ));
                } else {
                    assert_conflict(result.as_ref().unwrap_err(), &source.to_string(), "changed");
                }
            } else if let Err(e) = result {
                failures.push(format!("explicit={explicit}/{change}: must apply: {e}"));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
