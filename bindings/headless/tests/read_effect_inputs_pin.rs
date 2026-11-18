//! C8-film-pin: time conversion and frame-space paths read more than effect values.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn ordinary_effect_selection_is_independent_of_unselected_program_material() {
    let f = Fixture::new(3);
    let (sequence, _) = f.inspect().await;
    let clips = v1(&sequence);
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    f.kits
        .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "timeline.select", json!({"clips":[clips[2]]}).as_object().unwrap().clone())
        .await
        .unwrap();
    let (_, basis) = f.inspect().await;
    f.colleague(&[("clip.rename", json!({"clip":clips[0],"name":"Independent"}))]);
    f.call("run", json!({"basis":basis,"steps":[{"command":"effects.apply","params":{"effect":"gaussian_blur"}}]}))
        .await
        .unwrap_or_else(|error| panic!("the effect acts on the selection: {error}"));
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn effect_frame_addresses_hold_the_timebase_but_tick_addresses_do_not() {
    let mut failures = Vec::new();
    for command in ["effects.setParam", "effects.toggleAnimation", "effects.addKeyframe"] {
        for frames in [true, false] {
            let f = Fixture::new(2);
            let (sequence, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", json!({"fps":30}))]);
            let mut params = json!({"clip":v1(&sequence)[0],"effect":"opacity","param":"opacity"});
            if command == "effects.setParam" {
                params["value"] = json!(50);
            }
            params[if frames { "frame" } else { "time" }] = json!(if frames { 10 } else { SECOND / 2 });
            let before = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if frames {
                if !matches!(&answer, Err(error) if error["error"]["code"] == "conflict") || std::fs::read(f.file()).unwrap() != before {
                    failures.push(format!("{command}: frame timebase must refuse: {answer:?}"));
                }
            } else if let Err(error) = answer {
                failures.push(format!("{command}: explicit ticks must apply: {error}"));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn effect_mask_paths_hold_source_dimensions_and_conditional_frame_size() {
    let mut failures = Vec::new();
    for change in ["source-size", "sequence-size", "source-name", "sequence-name"] {
        let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
        let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].clone();
        doc.execute("masks.add", json!({"clip":clip,"shape":"rectangle"})).unwrap();
        doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
        doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (sequence, basis) = f.inspect().await;
        let source = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
        if change.starts_with("source") {
            rewrite(&f.file(), |project| {
                let source = project.item_mut(ItemId(source)).unwrap();
                if change == "source-size" {
                    source.as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640;
                } else {
                    source.name = "Independent".into();
                }
            });
        } else {
            f.colleague(&[("sequence.settings", if change == "sequence-size" { json!({"width":640,"height":360}) } else { json!({"name":"Independent"}) })]);
        }
        let before = std::fs::read(f.file()).unwrap();
        let answer = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"effects.setParam","params":{
                    "clip":clip,"effect":"opacity","param":"path","mask":0,
                    "value":{"closed":true,"vertices":[{"p":[20,20]},{"p":[100,20]},{"p":[100,100]}]}
                }}]}),
            )
            .await;
        if change.ends_with("size") {
            if !matches!(&answer, Err(error) if error["error"]["code"] == "conflict") || std::fs::read(f.file()).unwrap() != before {
                failures.push(format!("{change}: consumed dimensions must refuse: {answer:?}"));
            }
        } else if let Err(error) = answer {
            failures.push(format!("{change}: independent names must apply: {error}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
