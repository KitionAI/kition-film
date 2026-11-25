//! C8-film-read: independently saved writers for implicit layout and preset facts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ItemId, ItemKind};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn implicit_card_resize_holds_sibling_geometry_but_not_sibling_names() {
    for related in [true, false] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let first = seq["video"][0]["items"][0]["item"].as_u64().unwrap();
        let mine = seq["video"][0]["items"][1]["item"].as_u64().unwrap();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if related {
            ("project.freeform.move", json!({"positions":{first.to_string():[40,400]},"snap":false}))
        } else {
            ("clip.rename", json!({"item":first,"name":"unrelated"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"project.freeform.resize","params":{"items":[mine],"size":200}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the auto-placed card's computed y changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("sibling name is unrelated: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn arrangements_hold_their_named_values_but_not_other_arrangements() {
    for related in [true, false] {
        let f = Fixture::new(2);
        f.colleague(&[("project.freeform.saveArrangement", json!({"name":"mine"}))]);
        let (seq, basis) = f.inspect().await;
        let item = seq["video"][0]["items"][0]["item"].as_u64().unwrap();
        rewrite(&f.file(), |p| {
            p.item_mut(ItemId(item))
                .unwrap()
                .metadata
                .insert(format!("Freeform Arrangement: {}", if related { "mine" } else { "other" }), "100,200,128".into());
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"project.freeform.restoreArrangement","params":{"name":"mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the restored arrangement changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("another arrangement is unrelated: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn geometric_preset_holds_source_size_and_allows_source_names() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, basis) = f.inspect().await;
        let clip = seq["video"][0]["items"][0]["clip"].as_u64().unwrap();
        let item = seq["video"][0]["items"][0]["item"].as_u64().unwrap();
        rewrite(&f.file(), |p| {
            let it = p.item_mut(ItemId(item)).unwrap();
            if related {
                if let ItemKind::Media(media) = &mut it.kind {
                    media.info.video.as_mut().unwrap().width += 320;
                } else {
                    panic!("fixture source must have media dimensions")
                }
            } else {
                it.name = "unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"preset.apply","params":{"clips":[clip],"preset":"PiP 35% Upper Right"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the point scales with source width")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("source name is unrelated: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preset_effect_assignment_allows_a_clip_rename_but_protects_existing_effects() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, basis) = f.inspect().await;
        let clip = v1(&seq)[0];
        f.colleague(&[if related { opacity(clip, 50.0) } else { ("clip.rename", json!({"clip":clip,"name":"unrelated"})) }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"preset.apply","params":{"clips":[clip],"preset":"Fade In"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("intrinsic opacity replacement protects the assigned effect")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("a clip rename is unrelated to applying a preset: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sort_column_holds_metadata_column_names_but_not_their_values() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, _) = f.inspect().await;
        let item = seq["video"][0]["items"][0]["item"].as_u64().unwrap();
        f.colleague(&[("metadata.set", json!({"item":item,"field":"Rating","value":"A"}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("metadata.set", json!({"item":item,"field":"Rating","value":if related {""} else {"B"}}))]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"project.sort","params":{"column":"Rating"}}]})).await;
        if related {
            let error = answer.expect_err("the named column no longer exists");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            answer.unwrap_or_else(|error| panic!("sort preference assignment reads column eligibility, not cells: {error}"));
        }
        f.shutdown().await;
    }
}
