//! Independent writer regressions from the blind C8-film-read core rows.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn slip_holds_the_source_bounds_and_allows_unrelated_source_metadata() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (sequence, _) = f.inspect().await;
        let mine = v1(&sequence)[1];
        let source = sequence["video"][0]["items"][1]["item"].as_u64().unwrap();
        let sub = f.colleague(&[("clip.makeSubclip", json!({"item":source,"start":0,"end":SECOND,"restrictTrims":true}))])[0]["item"].as_u64().unwrap();
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(ItemId(sequence["id"].as_u64().unwrap())).unwrap();
            q.find_item_mut(ClipId(mine)).unwrap().1.item = ItemId(sub);
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let item = p.item_mut(ItemId(sub)).unwrap();
            if related {
                if let kition_film_project::ItemKind::Subclip { range, .. } = &mut item.kind {
                    range.start.0 += SECOND / 4;
                }
            } else {
                item.metadata.insert("description".into(), "unrelated".into());
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.slip","params":{"clip":mine,"delta":SECOND/10}}]})).await;
        if related {
            assert_eq!(result.expect_err("changed source bounds must refuse")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("source metadata is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_track_setting_holds_only_assigned_fields_for_id_and_ordinal() {
    for ordinal in [false, true] {
        for related in [true, false] {
            let f = Fixture::new(4);
            let (sequence, basis) = f.inspect().await;
            let track = sequence["video"][0]["id"].as_u64().unwrap();
            let named = if ordinal { json!("V1") } else { json!(track) };
            f.colleague(&[("timeline.setTrack", if related { json!({"track":track,"muted":true}) } else { json!({"track":track,"name":"colleague"}) })]);
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.setTrack","params":{"track":named,"muted":false}}]})).await;
            if related {
                assert_eq!(result.expect_err("same-field setting")["error"]["code"], "conflict");
            } else {
                result.unwrap_or_else(|e| panic!("a rename does not change the mute assignment ({ordinal}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn generator_defaults_hold_sequence_size_but_not_sequence_markers() {
    for related in [true, false] {
        let f = Fixture::new(4);
        let (_, basis) = f.inspect().await;
        if related {
            f.colleague(&[("sequence.settings", json!({"width":640}))]);
        } else {
            f.colleague(&[("markers.add", json!({"seconds":3,"name":"unrelated"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"file.newColorMatte","params":{"color":"#557799","seconds":1}}]})).await;
        if related {
            assert_eq!(result.expect_err("inherited width changed")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("marker unrelated to generator size: {e}"));
        }
        f.shutdown().await;
    }
}

#[test]
fn a_roll_cannot_join_clips_on_different_tracks() {
    use kition_film_kit::FilmDocument;
    use kition_kit::KitDocument;
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let seen = doc.inspect().unwrap();
    let seq = &seen["sequence"];
    let clips = v1(seq);
    let v2 = seq["video"][1]["id"].as_u64().unwrap();
    doc.execute("timeline.move", json!({"moves":[{"clip":clips[2],"track":v2,"time":2*SECOND}],"linked":false})).unwrap();
    let before = doc.save(None).unwrap();
    assert!(
        doc.execute("timeline.roll", json!({"left":clips[1],"right":clips[2],"delta":SECOND/4})).is_err(),
        "equal edge times on different tracks are no roll cut"
    );
    assert_eq!(doc.save(None).unwrap(), before);
}
