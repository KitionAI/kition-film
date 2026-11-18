//! C8-film-pin: tracking consumes source frames beyond the target's own fields.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn implicit_mask_targets_are_independent_of_other_program_clips() {
    for selected_mask in [false, true] {
        let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"].clone();
        let clips = v1(&sequence);
        doc.execute("masks.add", json!({"clip":clips[1],"shape":"polygon"})).unwrap();
        doc.execute("timeline.select", json!({"clips":[clips[1]],"linked":false})).unwrap();
        if !selected_mask {
            doc.execute("masks.select", json!({"none":true})).unwrap();
        }
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        for (command, params) in [
            ("timeline.select", json!({"clips":[clips[1]],"linked":false})),
            ("masks.select", if selected_mask { json!({"clip":clips[1],"effect":1,"mask":0}) } else { json!({"none":true}) }),
        ] {
            f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
        }
        let (_, basis) = f.inspect().await;
        f.colleague(&[("clip.rename", json!({"clip":clips[0],"name":"Independent"}))]);
        f.call("run", json!({"basis":basis,"steps":[{"command":"masks.add","params":{"shape":"polygon"}}]}))
            .await
            .unwrap_or_else(|error| panic!("the selected mask/clip is elsewhere: {error}"));
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mask_tracking_holds_source_pixels_and_rate_and_allows_unrelated_names() {
    let mut failures = Vec::new();
    for change in ["unchanged", "size", "rate", "name"] {
        let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
        let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].clone();
        let effect = doc.execute("masks.add", json!({"clip":clip,"shape":"rectangle"})).unwrap()["effect"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (sequence, basis) = f.inspect().await;
        let source = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
        if change != "unchanged" {
            rewrite(&f.file(), |project| {
                let source = project.item_mut(ItemId(source)).unwrap();
                match change {
                    "size" => source.as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640,
                    "rate" => {
                        source.as_media_mut().unwrap().info.video.as_mut().unwrap().frame_rate = serde_json::from_value(json!({"num":30,"den":1})).unwrap()
                    }
                    _ => source.name = "Independent".into(),
                }
            });
        }
        let before = std::fs::read(f.file()).unwrap();
        let answer = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"masks.track","params":{
                    "clip":clip,"effect":effect,"mask":0,"frames":1,"wait":true
                }}]}),
            )
            .await;
        if matches!(change, "size" | "rate") {
            if !matches!(&answer, Err(error) if error["error"]["code"] == "conflict") || std::fs::read(f.file()).unwrap() != before {
                failures.push(format!("{change}: consumed source must refuse without writes: {answer:?}"));
            }
        } else if let Err(error) = answer {
            failures.push(format!("{change}: valid control must apply: {error}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
