//! C8-film-read: source dimensions matter only to presets that scale geometry.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId, ParamValue};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn preset_geometry_uses_source_dimensions_but_a_scalar_fade_does_not() {
    let mut failures = Vec::new();
    for preset in ["Fade In", "PiP 35% Upper Right"] {
        for change in ["source-size", "assigned-effect", "source-name"] {
            let f = Fixture::new(1);
            let (q, basis) = f.inspect().await;
            let sequence = ItemId(q["id"].as_u64().unwrap());
            let clip = ClipId(v1(&q)[0]);
            let source = ItemId(q["video"][0]["items"][0]["item"].as_u64().unwrap());
            rewrite(&f.file(), |p| match change {
                "source-size" => p.item_mut(source).unwrap().as_media_mut().unwrap().info.video.as_mut().unwrap().width = 640,
                "source-name" => p.item_mut(source).unwrap().name = "Colleague".into(),
                _ => {
                    let it = p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1;
                    let id = if preset == "Fade In" { "opacity" } else { "motion" };
                    let param = if preset == "Fade In" { "opacity" } else { "scale" };
                    it.effect_mut(id).unwrap().param_mut(param).unwrap().value = ParamValue::Float(50.0);
                }
            });
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"preset.apply","params":{"clips":[clip.0],"preset":preset}}]})).await;
            let required = change == "assigned-effect" || (change == "source-size" && preset != "Fade In");
            let label = format!("{preset}/{change}");
            if required {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!("{label}: a result dependency changed"));
                }
            } else if let Err(error) = result {
                failures.push(format!("{label}: unrelated source change refused: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let item = saved.project.item(source).unwrap();
                if change == "source-size" {
                    assert_eq!(item.as_media().unwrap().info.video.as_ref().unwrap().width, 640, "{label}");
                } else {
                    assert_eq!(item.name, "Colleague", "{label}");
                }
                assert_eq!(result.unwrap()["completed"][0]["result"]["applied"], 1, "{label}");
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
