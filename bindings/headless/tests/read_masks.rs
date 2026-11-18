//! C8-film-read: frame-space mask inputs and unrelated label changes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::ItemId;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn mask_geometry_holds_dimensions_and_allows_unrelated_names_and_metadata() {
    let mut failures = Vec::new();
    for change in ["source-size", "sequence-size", "source-metadata", "clip-name"] {
        let f = Fixture::new(4);
        // This branch uses the fitting ratio: render/src/lib.rs::motion_matrix.
        // A resolved Motion position without fitting does not consume sequence size.
        let before = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
        use kition_kit::KitDocument;
        let id = before.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].clone();
        f.colleague(&[("timeline.select", json!({"clips":[id]})), ("clip.scaleToFrameSize", json!({}))]);
        let (sequence, basis) = f.inspect().await;
        let clip = v1(&sequence)[0];
        let source = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
        if change == "clip-name" {
            f.colleague(&[("clip.rename", json!({"clip":clip,"name":"Theirs"}))]);
        } else if change == "sequence-size" {
            f.colleague(&[("sequence.settings", json!({"width":640}))]);
        } else {
            rewrite(&f.file(), |project| {
                let item = project.item_mut(ItemId(source)).unwrap();
                if change == "source-size" {
                    item.as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640;
                } else {
                    item.metadata.insert("description".into(), "Theirs".into());
                }
            });
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"masks.add","params":{"clip":clip,"shape":"ellipse"}}]})).await;
        if change.ends_with("size") {
            if !matches!(answer, Err(ref error) if error["error"]["code"] == "conflict") {
                failures.push(format!("{change}: must refuse: {answer:?}"));
            }
        } else if let Err(error) = answer {
            failures.push(format!("{change}: must apply: {error}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn resolved_mask_mapping_ignores_sequence_size_until_fitting_is_enabled() {
    // masks.rs::add and edit_mask -> frame_to_clip -> motion_matrix: sequence
    // width/height enter the matrix only via default position or fitting. Placement
    // resolved position/anchor, so fitting is the only live dependency here.
    for command in ["masks.add", "masks.moveVertex"] {
        for fitting in [false, true] {
            let f = Fixture::new(4);
            let mut doc = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
            use kition_kit::KitDocument;
            let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].clone();
            doc.execute("masks.add", json!({"clip":clip,"shape":"ellipse"})).unwrap();
            if fitting {
                doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
                doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
            }
            std::fs::write(f.file(), doc.save(None).unwrap()).unwrap();
            let (_, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", json!({"width":640,"height":360}))]);
            let params = if command == "masks.add" { json!({"clip":clip,"shape":"ellipse"}) } else { json!({"clip":clip,"mask":0,"vertex":0,"to":[80,45]}) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if fitting {
                let error = result.expect_err("the fitting ratio changed");
                assert_eq!(error["error"]["code"], "conflict", "{error}");
            } else {
                result.unwrap_or_else(|e| panic!("resolved mapping does not consume sequence size ({command}): {e}"));
            }
            f.shutdown().await;
        }
    }
}
