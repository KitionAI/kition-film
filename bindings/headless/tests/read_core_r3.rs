//! Saved-file writer pairs from the independently committed core paths.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId, ItemKind};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_clip_holds_owner_lock_but_not_owner_name() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, basis) = f.inspect().await;
        let clip = v1(&seq)[1];
        let track = seq["video"][0]["id"].as_u64().unwrap();
        f.colleague(&[("timeline.setTrack", if related { json!({"track":track,"locked":true}) } else { json!({"track":track,"name":"Other"}) })]);
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"edit.clear","params":{"clips":[clip]}}]})).await;
        if related {
            assert_eq!(result.expect_err("owner lock changes deletion eligibility")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("owner name is unrelated: {e}"));
            assert!(!v1_on_disk(&f.file()).iter().any(|c| c.0 == clip));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_roll_holds_source_limits_but_not_source_metadata() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, _) = f.inspect().await;
        let clips = v1(&seq);
        let source = seq["video"][0]["items"][1]["item"].as_u64().unwrap();
        let sub = f.colleague(&[("clip.makeSubclip", json!({"item":source,"start":0,"end":2*SECOND,"restrictTrims":true}))])[0]["item"].as_u64().unwrap();
        let sequence = ItemId(seq["id"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clips[1])).unwrap().1.item = ItemId(sub);
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let item = p.item_mut(ItemId(sub)).unwrap();
            if related {
                if let ItemKind::Subclip { range, .. } = &mut item.kind {
                    range.duration.0 = SECOND + SECOND / 4;
                }
            } else {
                item.metadata.insert("note".into(), "Other".into());
            }
        });
        let result =
            f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.roll","params":{"left":clips[1],"right":clips[2],"delta":SECOND/2}}]})).await;
        if related {
            assert_eq!(result.expect_err("source bound changes roll clamp")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("source metadata is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_enable_holds_linked_partner_but_not_partner_label() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (seq, _) = f.inspect().await;
        let clips = v1(&seq);
        let sequence = ItemId(seq["id"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(sequence).unwrap();
            for id in [clips[1], clips[2]] {
                q.find_item_mut(ClipId(id)).unwrap().1.link = Some(900);
            }
        });
        let (_, basis) = f.inspect().await;
        if related {
            rewrite(&f.file(), |p| {
                p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clips[2])).unwrap().1.enabled = false;
            });
        } else {
            f.colleague(&[("edit.label.blue", json!({"clips":[clips[2]]}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.enable","on":[clips[1]],"params":{}}]})).await;
        if related {
            assert_eq!(result.expect_err("linked selected partner was changed")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("partner label is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn program_mark_assignment_holds_its_field_but_not_other_markers() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (_, basis) = f.inspect().await;
        f.colleague(&[(
            if related { "markers.markIn" } else { "markers.add" },
            if related { json!({"seconds":0.5}) } else { json!({"seconds":0.5,"name":"Other"}) },
        )]);
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"markers.markIn","params":{"seconds":2.5}}]})).await;
        if related {
            assert_eq!(result.expect_err("same-field mark assignment")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("another marker is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}
