//! C8-film-read: assigned sequence fields, inherited effect defaults and implicit selections.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn an_unnamed_new_sequence_holds_the_sequence_count_but_not_sequence_names() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        f.colleague(&[if related { ("sequence.new", json!({"name":"Theirs"})) } else { ("sequence.settings", json!({"name":"Theirs"})) }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.new","params":{}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the default sequence name counts sequences")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("renaming a sequence preserves the count: {e}"));
        }
        f.shutdown().await;
    }
}

#[test]
fn transition_effect_application_honors_the_clip_it_names() {
    use kition_kit::KitDocument;
    let mut doc = kition_film_kit::FilmDocument::open(FILE, &project(4)).unwrap();
    let clip = v1(&doc.inspect().unwrap()["sequence"])[0];
    doc.execute("playhead.set", json!({"seconds":3})).unwrap();
    doc.execute("effect.apply", json!({"clips":[clip],"effect":"cross_dissolve"})).unwrap();
    let seq = doc.inspect().unwrap()["sequence"].clone();
    let transition = &seq["video"][0]["transitions"][0];
    assert!(transition["from"] == clip || transition["to"] == clip, "clips names the addressed clip, even away from the playhead: {transition}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sequence_setting_assignment_holds_the_same_field_but_not_its_name() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.settings", if related { json!({"width":800}) } else { json!({"name":"Unrelated"}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.settings","params":{"width":640}}]})).await;
        if related {
            assert_eq!(answer.expect_err("same-field width replacement")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("sequence name is preserved by a width patch: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn proportional_motion_scaling_holds_distant_motion_but_not_names() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, basis) = f.inspect().await;
        let clip = v1(&seq)[3];
        f.colleague(&[if related {
            ("effect.setParam", json!({"clip":clip,"effect":"motion","param":"scale","value":75}))
        } else {
            ("clip.rename", json!({"clip":clip,"name":"Unrelated"}))
        }]);
        let answer =
            f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.settings","params":{"width":640,"height":360,"scaleMotion":true}}]})).await;
        if related {
            assert_eq!(answer.expect_err("proportional scaling consumes this distant Motion")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("scaling preserves clip names: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn effect_default_points_hold_sequence_size_but_not_sequence_name() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, basis) = f.inspect().await;
        f.colleague(&[("sequence.settings", if related { json!({"width":640}) } else { json!({"name":"Unrelated"}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"effect.apply","params":{"clips":[v1(&seq)[1]],"effect":"lens_flare"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the default flare center moved")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("the sequence name does not supply an effect default: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn implicit_group_assignment_holds_selected_group_but_not_name() {
    for related in [true, false] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let clip = v1(&seq)[2];

        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "timeline.select",
                json!({"clips":[clip],"linked":false}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let clip = p.sequence_mut(ItemId(seq["id"].as_u64().unwrap())).unwrap().find_item_mut(ClipId(clip)).unwrap().1;
            if related {
                clip.group = Some(900);
            } else {
                clip.name = "Unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.group","params":{}}]})).await;
        if related {
            assert_eq!(answer.expect_err("selected group same-field assignment")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("grouping preserves names: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn implicit_duplicate_holds_copied_content_but_not_uncopied_item_metadata() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, _) = f.inspect().await;

        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "project.select", json!({"items":[seq["id"]]}).as_object().unwrap().clone())
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let sequence = ItemId(seq["id"].as_u64().unwrap());
            if related {
                p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(v1(&seq)[3])).unwrap().1.name = "Copied name".into();
            } else {
                p.item_mut(sequence).unwrap().metadata.insert("note".into(), "Unrelated".into());
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"edit.duplicate","params":{}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the duplicate would copy changed source content")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("item metadata is not copied by duplicate: {e}"));
        }
        f.shutdown().await;
    }
}
