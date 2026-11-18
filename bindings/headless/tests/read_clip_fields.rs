//! C8-film-read: label, field-option and interpolation assignments preserve unrelated fields.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, FieldOptions, FieldProcessing, ItemId, Label, TimeInterpolation};
use kition_kit::{CallContext, KitDocument};
use serde_json::{Value, json};

const LABELS: [&str; 16] = [
    "edit.label.violet",
    "edit.label.iris",
    "edit.label.caribbean",
    "edit.label.lavender",
    "edit.label.cerulean",
    "edit.label.forest",
    "edit.label.rose",
    "edit.label.mango",
    "edit.label.purple",
    "edit.label.blue",
    "edit.label.teal",
    "edit.label.magenta",
    "edit.label.tan",
    "edit.label.green",
    "edit.label.brown",
    "edit.label.yellow",
];
const VIDEO_FIELDS: [&str; 5] = [
    "clip.fieldOptions",
    "clip.setTimeInterpolation",
    "clip.timeInterpolation.frameSampling",
    "clip.timeInterpolation.frameBlending",
    "clip.timeInterpolation.opticalFlow",
];

#[tokio::test(flavor = "multi_thread")]
async fn explicit_and_selected_clip_patches_hold_the_assigned_field() {
    let mut failures = Vec::new();
    for command in LABELS.into_iter().chain(["edit.label"]).chain(VIDEO_FIELDS) {
        for same_field in [false, true] {
            let f = Fixture::new(2);
            let (sequence, basis) = f.inspect().await;
            let clip = v1(&sequence)[0];
            let sequence_id = sequence["id"].as_u64().unwrap();
            rewrite(&f.file(), |p| {
                let (_, target) = p.sequence_mut(ItemId(sequence_id)).unwrap().find_item_mut(ClipId(clip)).unwrap();
                if !same_field {
                    target.name = "Colleague".to_owned();
                } else if command.starts_with("edit.label") {
                    target.label = Label::Green;
                } else if command == "clip.fieldOptions" {
                    target.field_options = Some(FieldOptions { reverse_field_dominance: true, processing: FieldProcessing::AlwaysDeinterlace });
                } else {
                    target.time_interpolation = TimeInterpolation::OpticalFlow;
                }
            });
            let mut params = if command == "edit.label" { json!({"label":"Violet"}) } else { json!({"clips":[clip]}) };
            if command == "clip.fieldOptions" {
                params["processing"] = json!("none");
            }
            if command == "clip.setTimeInterpolation" {
                params["mode"] = json!("frameBlending");
            }
            let mut step = json!({"command":command,"params":params});
            if command == "edit.label" {
                step["on"] = json!([clip]);
            }
            let answer = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            if same_field {
                if !matches!(answer, Err(ref error) if error["error"]["code"] == "conflict") {
                    failures.push(format!("{command}: assigned field must refuse: {answer:?}"));
                }
            } else if let Err(error) = answer {
                failures.push(format!("{command}: rename is unrelated: {error}"));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn item_labels_hold_labels_and_allow_unrelated_metadata() {
    let mut failures = Vec::new();
    for command in LABELS.into_iter().chain(["edit.label"]) {
        for same_field in [false, true] {
            let f = Fixture::new(1);
            let (sequence, basis) = f.inspect().await;
            let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
            rewrite(&f.file(), |p| {
                let target = p.item_mut(ItemId(item)).unwrap();
                if same_field {
                    target.label = Label::Green;
                } else {
                    target.metadata.insert("description".to_owned(), "Colleague".to_owned());
                }
            });
            let step = if command == "edit.label" {
                json!({"command":command,"on":[item],"params":{"label":"Violet"}})
            } else {
                json!({"command":command,"params":{"items":[item]}})
            };
            let answer = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            if same_field {
                if !matches!(answer, Err(ref error) if error["error"]["code"] == "conflict") {
                    failures.push(format!("{command}: assigned item label must refuse: {answer:?}"));
                }
            } else if let Err(error) = answer {
                failures.push(format!("{command}: item metadata is unrelated: {error}"));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn label_resolution_matches_explicit_suppression_and_both_default_selections() {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"].clone();
    let clip = v1(&sequence)[0];
    let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
    doc.set_context(&CallContext { on: vec![json!(clip), json!(item)], ..Default::default() }).unwrap();
    for (command, params, ids) in [
        ("edit.label.blue", json!({}), vec![clip, item]),
        ("edit.label.blue", json!({"clips":[clip]}), vec![clip]),
        ("edit.label.blue", json!({"items":[item]}), vec![item]),
        ("edit.label", json!({"label":"Blue"}), vec![clip, item]),
    ] {
        let under = doc.under(command, &params).unwrap().expect("label field premises");
        let actual: std::collections::BTreeSet<_> = under.premises.iter().map(|premise| premise.id.clone().as_u64().unwrap()).collect();
        assert_eq!(actual, ids.into_iter().collect(), "{command}: {params}: {under:?}");
        for premise in &under.premises {
            let field = if premise.id == json!(clip) { "props.label" } else { "props.common.label" };
            assert_eq!(premise.fields, Some(vec![field.to_owned()]));
            assert_eq!(premise.positions, Some(Vec::new()));
        }
    }
    for command in VIDEO_FIELDS {
        let under = doc.under(command, &Value::Null).unwrap().expect("selected video field premise");
        let target = under.premises.iter().find(|premise| premise.id == json!(clip)).unwrap();
        assert_eq!(target.fields, Some(vec![if command == "clip.fieldOptions" { "props.field_options" } else { "props.time_interpolation" }.to_owned()]));
        assert_eq!(target.positions, Some(vec!["clips".to_owned()]));
    }
}
