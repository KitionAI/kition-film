//! C8-film-read: source graphics reconcile only instances edited by this dispatch.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId, ParamValue, Project};
use kition_kit::KitDocument;
use serde_json::json;

fn graphics() -> (Fixture, u64, u64, u64, u64, u64) {
    let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
    let a = doc.execute("graphics.newText", json!({"newClip":true,"text":"A","seconds":1})).unwrap()["clip"].as_u64().unwrap();
    let item = doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":a})).unwrap()["item"].as_u64().unwrap();
    let copy = doc.execute("timeline.place", json!({"item":item,"track":"V2","time":0,"duration":SECOND})).unwrap()["clips"][0].as_u64().unwrap();
    let b = doc.execute("graphics.newText", json!({"newClip":true,"text":"B","seconds":1})).unwrap()["clip"].as_u64().unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), sequence, item, a, copy, b)
}

fn text(project: &Project, sequence: u64, clip: u64) -> String {
    let (_, clip) = project.sequence(ItemId(sequence)).unwrap().find_item(ClipId(clip)).unwrap();
    let ParamValue::Text(text) = &clip.effects.iter().find(|e| e.effect == "graphic_text").unwrap().params["text"].value else { panic!("text value") };
    text.clone()
}

fn change_text(project: &mut Project, sequence: u64, clip: u64, value: &str) {
    let (_, clip) = project.sequence_mut(ItemId(sequence)).unwrap().find_item_mut(ClipId(clip)).unwrap();
    clip.effects.iter_mut().find(|e| e.effect == "graphic_text").unwrap().params.get_mut("text").unwrap().value = ParamValue::Text(value.to_owned());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unrelated_graphic_write_preserves_divergent_source_instances() {
    let (f, sequence, source, a, copy, b) = graphics();
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |p| change_text(p, sequence, copy, "Colleague"));
    f.ok("run", json!({"basis":basis,"steps":[{"command":"graphics.setText","params":{"clip":b,"text":"Mine"}}]})).await;
    let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
    assert_eq!(text(&saved.project, sequence, a), "A", "an unrelated command must not rewrite this source instance");
    assert_eq!(text(&saved.project, sequence, copy), "Colleague");
    assert_eq!(text(&saved.project, sequence, b), "Mine");
    assert_eq!(saved.project.source_graphics[&ItemId(source)].layers[0].params["text"].value, ParamValue::Text("A".to_owned()));
    f.shutdown().await;
}

#[test]
fn the_edited_instance_supplies_the_source_content() {
    let (f, sequence, _, a, copy, _) = graphics();
    rewrite(&f.file(), |p| change_text(p, sequence, copy, "Earlier divergence"));
    let mut doc = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
    doc.execute("graphics.setText", json!({"clip":a,"text":"Mine"})).unwrap();
    let saved = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    assert_eq!(text(&saved.project, sequence, a), "Mine", "the requested edit must survive reconciliation");
    assert_eq!(text(&saved.project, sequence, copy), "Mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn setting_text_ignores_source_geometry_and_rate_but_protects_the_assigned_text() {
    let mut failures = Vec::new();
    for shared in [false, true] {
        for change in ["geometry", "rate", "text"] {
            let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
            let clip = doc.execute("graphics.newText", json!({"newClip":true,"text":"Original","time":0})).unwrap()["clip"].as_u64().unwrap();
            let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            if shared {
                doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":clip})).unwrap();
            }
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (q, basis) = f.inspect().await;
            let source = ItemId(
                q["video"].as_array().unwrap().iter().flat_map(|tr| tr["items"].as_array().unwrap()).find(|it| it["clip"] == clip).unwrap()["item"]
                    .as_u64()
                    .unwrap(),
            );
            rewrite(&f.file(), |p| {
                if change == "text" {
                    change_text(p, sequence, clip, "Colleague");
                } else {
                    let kition_film_project::ItemKind::Graphic { width, rate, .. } = &mut p.item_mut(source).unwrap().kind else { panic!("graphic") };
                    if change == "geometry" {
                        *width = 640;
                    } else {
                        rate.num = 30;
                        rate.den = 1;
                    }
                }
            });
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"graphics.setText","params":{"clip":clip,"layer":0,"text":"Mine"}}]})).await;
            let label = format!("shared={shared}/{change}");
            if change == "text" {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!("{label}: assigned text changed"));
                }
            } else if let Err(error) = result {
                failures.push(format!("{label}: unrelated source change refused: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                assert_eq!(text(&saved.project, sequence, clip), "Mine", "{label}");
                let kition_film_project::ItemKind::Graphic { width, rate, .. } = &saved.project.item(source).unwrap().kind else { panic!("graphic") };
                if change == "geometry" {
                    assert_eq!(*width, 640, "{label}");
                } else {
                    assert_eq!((rate.num, rate.den), (30, 1), "{label}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
