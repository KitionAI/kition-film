//! C8-film-read: replacement reads implicit media and preserves other clip fields.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId, Label, ParamValue};
use kition_kit::KitDocument;
use serde_json::json;

async fn choose(f: &Fixture, source: u64, clip: u64) {
    let _ = f.inspect().await;
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    for (command, params) in
        [("project.select", json!({"items":[source]})), ("source.open", json!({"item":source})), ("timeline.select", json!({"clips":[clip]}))]
    {
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn replacement_holds_copied_source_fields_but_preserves_unrelated_clip_content() {
    let mut failures = Vec::new();
    for command in ["clip.replaceFromSource", "clip.replaceFromSourceMatchFrame", "clip.replaceFromBin"] {
        for change in ["source-name", "source-label", "source-metadata", "target-effect", "target-time"] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let source = doc.execute("file.newOfflineFile", json!({"name":"Observed source","seconds":4,"audio":false})).unwrap()["item"].as_u64().unwrap();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (q, _) = f.inspect().await;
            let sequence = ItemId(q["id"].as_u64().unwrap());
            let clip = ClipId(v1(&q)[0]);
            choose(&f, source, clip.0).await;
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| match change {
                "source-name" => p.item_mut(ItemId(source)).unwrap().name = "Colleague source".into(),
                "source-label" => {
                    let item = p.item_mut(ItemId(source)).unwrap();
                    item.label = if item.label == Label::Green { Label::Iris } else { Label::Green };
                }
                "source-metadata" => {
                    p.item_mut(ItemId(source)).unwrap().metadata.insert("note".into(), "Colleague".into());
                }
                "target-effect" => {
                    p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1.effect_mut("opacity").unwrap().param_mut("opacity").unwrap().value =
                        ParamValue::Float(37.0);
                }
                _ => p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1.start.0 += SECOND / 10,
            });
            choose(&f, source, clip.0).await;
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":{"clips":[clip.0]}}]})).await;
            let required = matches!(change, "source-name" | "source-label") || (change == "target-time" && command.ends_with("MatchFrame"));
            let label = format!("{command}/{change}");
            if required {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "{label}: a copied field or frame input changed, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                    ));
                }
            } else if let Err(error) = result {
                failures.push(format!("{label}: unrelated content refused: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let target = saved.project.sequence(sequence).unwrap().find_item(clip).unwrap().1;
                assert_eq!(target.item.0, source, "{label}");
                assert_eq!(target.name, "Observed source", "{label}");
                if change == "source-metadata" {
                    assert_eq!(saved.project.item(ItemId(source)).unwrap().metadata["note"], "Colleague", "{label}");
                } else if change == "target-effect" {
                    assert_eq!(target.effect("opacity").unwrap().params["opacity"].value, ParamValue::Float(37.0), "{label}");
                } else {
                    assert_eq!((target.start.0, target.source_in.0), (SECOND / 10, 0), "{label}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
