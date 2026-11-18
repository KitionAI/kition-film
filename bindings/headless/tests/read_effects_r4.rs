//! C8-film-read: writer probes for remaining independently read effect dependencies.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId, ItemKind, ParamValue};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_departed_link_partner_changes_the_recipient_set_but_its_name_does_not() {
    for related in [true, false] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let clips = v1(&seq);
        let sequence = ItemId(seq["id"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(sequence).unwrap();
            for id in &clips[..2] {
                q.find_item_mut(ClipId(*id)).unwrap().1.link = Some(910);
            }
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let clip = p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clips[1])).unwrap().1;
            if related {
                clip.link = None;
            } else {
                clip.name = "Unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.enable","params":{"clips":[clips[0]]}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the observed linked recipient left")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("partner name is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_a_different_link_group_does_not_refuse_an_enable() {
    let f = Fixture::new(4);
    let (seq, _) = f.inspect().await;
    let clips = v1(&seq);
    let sequence = ItemId(seq["id"].as_u64().unwrap());
    rewrite(&f.file(), |p| {
        let q = p.sequence_mut(sequence).unwrap();
        for (index, id) in clips.iter().enumerate() {
            q.find_item_mut(ClipId(*id)).unwrap().1.link = Some(if index < 2 { 910 } else { 911 });
        }
    });
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |p| {
        p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clips[3])).unwrap().1.link = None;
    });
    f.ok("run", json!({"basis":basis,"steps":[{"command":"clip.enable","params":{"clips":[clips[0]]}}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn another_source_graphics_text_is_unrelated_to_this_source_graphic() {
    let f = Fixture::new(1);
    let mut clips = Vec::new();
    for (index, text) in ["First", "Second"].into_iter().enumerate() {
        let clip = f.colleague(&[("graphics.newText", json!({"newClip":true,"text":text,"time":(index as i64+2)*SECOND}))])[0]["clip"].as_u64().unwrap();
        f.colleague(&[("graphics.upgradeToSourceGraphic", json!({"clip":clip}))]);
        clips.push(clip);
    }
    let (_, basis) = f.inspect().await;
    f.colleague(&[("graphics.setText", json!({"clip":clips[1],"layer":0,"text":"Other source changed"}))]);
    f.ok("run", json!({"basis":basis,"steps":[{"command":"graphics.setText","params":{"clip":clips[0],"layer":0,"text":"Mine"}}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_attributes_holds_linked_effects_and_source_size_but_not_names() {
    for change in ["effects", "size", "name"] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let clips = v1(&seq);
        let sequence = ItemId(seq["id"].as_u64().unwrap());
        let source = ItemId(seq["video"][0]["items"][1]["item"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(sequence).unwrap();
            for id in &clips[..2] {
                q.find_item_mut(ClipId(*id)).unwrap().1.link = Some(910);
            }
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            if change == "size" {
                let ItemKind::Media(media) = &mut p.item_mut(source).unwrap().kind else { panic!("media") };
                media.info.video.as_mut().unwrap().width += 100;
            } else {
                let clip = p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clips[1])).unwrap().1;
                if change == "effects" {
                    clip.effect_mut("motion").unwrap().param_mut("scale").unwrap().value = ParamValue::Float(75.0);
                } else {
                    clip.name = "Unrelated".into();
                }
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"edit.removeAttributes","params":{"clips":[clips[0]]}}]})).await;
        if change != "name" {
            assert_eq!(answer.expect_err("linked reset input or assigned effect changed")["error"]["code"], "conflict", "{change}");
        } else {
            answer.unwrap_or_else(|e| panic!("linked clip name is preserved: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn colour_match_holds_the_rendered_reference_but_not_its_name() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, basis) = f.inspect().await;
        let clips = v1(&seq);
        f.colleague(&[if related { opacity(clips[3], 50.0) } else { ("clip.rename", json!({"clip":clips[3],"name":"Unrelated"})) }]);
        let answer =
            f.call("run", json!({"basis":basis,"steps":[{"command":"color.applyMatch","params":{"clip":clips[0],"referenceTime":3*SECOND+SECOND/2}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the reference picture changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("reference name does not enter the picture: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn font_replacement_holds_matching_fonts_but_not_graphic_text() {
    for related in [true, false] {
        let f = Fixture::new(1);
        let clip = f.colleague(&[("graphics.newText", json!({"newClip":true,"text":"Original","font":"Inter","time":2*SECOND}))])[0]["clip"].as_u64().unwrap();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if related {
            ("graphics.set", json!({"clip":clip,"layer":0,"props":{"font":"Other"}}))
        } else {
            ("graphics.setText", json!({"clip":clip,"layer":0,"text":"Unrelated"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"file.replaceFonts","params":{"from":"Inter","to":"Serif"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("font matching eligibility changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("font replacement preserves text: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_departed_source_graphic_peer_changes_the_recipient_set_but_its_name_does_not() {
    for implicit in [false, true] {
        for related in [true, false] {
            let f = Fixture::new(1);
            let clip = f.colleague(&[("graphics.newText", json!({"newClip":true,"text":"Initial","time":2*SECOND}))])[0]["clip"].as_u64().unwrap();
            f.colleague(&[("graphics.upgradeToSourceGraphic", json!({"clip":clip}))]);
            let mut peer = 0;
            rewrite(&f.file(), |p| {
                peer = p.alloc_id();
                let sequence = p.sequences().next().unwrap().id;
                let q = p.sequence_mut(sequence).unwrap();
                let (track, source) = q.find_item(ClipId(clip)).unwrap();
                let mut copy = source.clone();
                copy.id = ClipId(peer);
                copy.start.0 += 8 * SECOND;
                q.track_mut(track).unwrap().items.push(copy);
            });
            if implicit {
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
            }
            let (seq, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let sequence = ItemId(seq["id"].as_u64().unwrap());
                let item = p.sequence(sequence).unwrap().find_item(ClipId(peer)).unwrap().1.item;
                let source = p.item(item).unwrap().clone();
                if related {
                    let other = p.add_item("Different graphic", source.label, source.kind, None);
                    p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(peer)).unwrap().1.item = other;
                } else {
                    p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(peer)).unwrap().1.name = "Unrelated".into();
                }
            });
            let params = if implicit { json!({"layer":0,"text":"Mine"}) } else { json!({"clip":clip,"layer":0,"text":"Mine"}) };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"graphics.setText","params":params}]})).await;
            if related {
                assert_eq!(answer.expect_err("the source graphic's observed recipient left")["error"]["code"], "conflict", "implicit={implicit}");
            } else {
                answer.unwrap_or_else(|e| panic!("a peer name does not affect layer reconciliation: {e}"));
            }
            f.shutdown().await;
        }
    }
}
