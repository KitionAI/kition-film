//! C8-film-read: a reread must preserve named session preset definitions.
//! Clean rereads retain session definitions through the SDK continuity hooks.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId, ParamValue};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn preset_library_survives_unrelated_file_refresh() {
    let mut failures = Vec::new();
    for change in ["none", "metadata", "duration"] {
        let f = Fixture::new(1);
        let (q, _) = f.inspect().await;
        let sequence = ItemId(q["id"].as_u64().unwrap());
        let clip = ClipId(v1(&q)[0]);
        let source = ItemId(q["video"][0]["items"][0]["item"].as_u64().unwrap());
        f.colleague(&[("effect.apply", json!({"clips":[clip.0],"effect":"gaussian_blur"}))]);
        rewrite(&f.file(), |p| {
            let it = p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1;
            let mut zero = it.duration;
            zero.0 = 0;
            let end = it.duration;
            let effect = &mut it.effects[0];
            assert_eq!(effect.effect, "gaussian_blur");
            let param = effect.params.get_mut("blurriness").unwrap();
            param.put_keyframe(zero, ParamValue::Float(10.0));
            param.put_keyframe(end, ParamValue::Float(20.0));
        });
        let _ = f.inspect().await;
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        let preset = f
            .kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "preset.save",
                json!({"clip":clip.0,"effects":[0],"name":"Fade In","keyframes":"scale"}).as_object().unwrap().clone(),
            )
            .await
            .unwrap()
            .result
            .unwrap();
        assert_eq!(preset["effects"], json!(["Gaussian Blur"]));
        let (_, basis) = f.inspect().await;
        if change != "none" {
            rewrite(&f.file(), |p| {
                if change == "duration" {
                    p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1.duration.0 += SECOND / 2;
                } else {
                    p.item_mut(source).unwrap().metadata.insert("description".into(), "Colleague".into());
                }
            });
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"preset.apply","params":{"clips":[clip.0],"preset":"Fade In"}}]})).await;
        if change == "duration" {
            assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|error| panic!("{change}: {error}"));
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            let it = saved.project.sequence(sequence).unwrap().find_item(clip).unwrap().1;
            let effects: Vec<_> = it.effects.iter().map(|e| e.effect.as_str()).collect();
            if effects.iter().filter(|e| **e == "gaussian_blur").count() != 2 {
                failures.push(format!("{change}: the named user preset changed to a built-in: {effects:?}"));
            }
            if change == "metadata" {
                assert_eq!(saved.project.item(source).unwrap().metadata["description"], "Colleague");
            }
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
