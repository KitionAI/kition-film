//! C8-film-read: consumed audio graphs, source parents and delegated trim inputs.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId, ItemKind};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn processed_bin_reuses_the_observed_named_bin_and_ignores_other_bin_names() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let made = f.colleague(&[("bin.add", json!({"name":"Processed Clips"})), ("bin.add", json!({"name":"Other"}))]);
        let processed = made[0]["bin"].as_u64().unwrap();
        let other = made[1]["bin"].as_u64().unwrap();
        let (seq, basis) = f.inspect().await;
        let items: Vec<_> = seq["video"][0]["items"].as_array().unwrap().iter().map(|clip| clip["item"].clone()).collect();
        rewrite(&f.file(), |p| {
            if related {
                p.root.children.retain(|entry| !matches!(entry, kition_film_project::BinEntry::Bin(bin) if bin.id.0 == processed));
            } else {
                p.root.find_bin_mut(kition_film_project::BinId(other)).unwrap().name = "Unrelated".into();
            }
        });
        let answer = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"clip.addMulticam","params":{"items":items,"method":"in","name":"Mine","processedBin":true}}]}),
            )
            .await;
        if related {
            assert_eq!(answer.expect_err("the named destination no longer exists")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("another bin name does not affect the selected named destination: {e}"));
        }
        f.shutdown().await;
    }
}

#[test]
fn normalization_stays_representable_by_the_project_model() {
    use kition_kit::KitDocument;
    let mut doc = kition_film_kit::FilmDocument::open(FILE, &project(1)).unwrap();
    let tone = doc.execute("item.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":tone,"track":"A1","time":0})).unwrap();
    let normalized = doc.execute("sequence.normalizeMixTrack", json!({"db":-3})).unwrap();
    assert!(normalized["masterVolumeDb"].as_f64().unwrap() <= 15.0, "the schema's Mix fader maximum is +15 dB: {normalized}");
}

#[test]
fn duplicated_sequences_have_independent_timeline_identities() {
    use kition_kit::KitDocument;
    let mut doc = kition_film_kit::FilmDocument::open(FILE, &project(2)).unwrap();
    let original = doc.inspect().unwrap()["sequence"].clone();
    let original_clips = v1(&original);
    doc.execute("project.select", json!({"items":[original["id"]]})).unwrap();
    let duplicate = doc.execute("edit.duplicate", json!({})).unwrap()["items"][0].clone();
    doc.execute("sequence.open", json!({"item":duplicate})).unwrap();
    let copied = doc.inspect().unwrap()["sequence"].clone();
    assert!(v1(&copied).iter().all(|id| !original_clips.contains(id)), "a duplicate must not alias another sequence's timeline ids");
    doc.execute("clip.rename", json!({"clip":v1(&copied)[0],"name":"Copy only"})).unwrap();
    doc.execute("sequence.open", json!({"item":original["id"]})).unwrap();
    assert_eq!(doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["name"], original["video"][0]["items"][0]["name"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn mix_normalization_holds_audio_gain_but_not_audio_names() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let tone = f.colleague(&[("item.newBarsAndTone", json!({"seconds":2}))])[0]["item"].as_u64().unwrap();
        let clip = f.colleague(&[("timeline.place", json!({"item":tone,"track":"A1","time":0}))])[0]["clips"][0].as_u64().unwrap();
        let (seq, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let clip = p.sequence_mut(ItemId(seq["id"].as_u64().unwrap())).unwrap().find_item_mut(ClipId(clip)).unwrap().1;
            if related {
                clip.gain_db = -6.0;
            } else {
                clip.name = "Unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.normalizeMixTrack","params":{"db":-3}}]})).await;
        if related {
            assert_eq!(answer.expect_err("normalization measures this gain")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("audio name does not affect the mix: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn multicamera_creation_holds_parent_timecode_but_not_parent_metadata() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, _) = f.inspect().await;
        let sources: Vec<_> = seq["video"][0]["items"].as_array().unwrap().iter().map(|clip| clip["item"].as_u64().unwrap()).collect();
        let subs = f.colleague(&[
            ("clip.makeSubclip", json!({"item":sources[0],"start":0,"end":SECOND})),
            ("clip.makeSubclip", json!({"item":sources[1],"start":0,"end":SECOND})),
        ]);
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let source = p.item_mut(ItemId(sources[1])).unwrap();
            if related {
                let ItemKind::Media(media) = &mut source.kind else { panic!("media") };
                media.info.start_timecode = Some(24);
            } else {
                source.metadata.insert("note".into(), "Unrelated".into());
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.addMulticam","params":{"items":[subs[0]["item"],subs[1]["item"]],"method":"timecode","name":"Mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("timecode is resolved through the subclip parent")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("parent metadata is not copied or used for camera names: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn trim_wrapper_holds_the_delegated_source_clamp_but_not_clip_name() {
    for related in [true, false] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let clip = v1(&seq)[1];
        let source = seq["video"][0]["items"][1]["item"].as_u64().unwrap();
        let sub = f.colleague(&[("clip.makeSubclip", json!({"item":source,"start":0,"end":2*SECOND,"restrictTrims":true}))])[0]["item"].as_u64().unwrap();
        let sequence = ItemId(seq["id"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clip)).unwrap().1.item = ItemId(sub);
        });
        // The person selects the edit point before the agent observes: the trim acts on the
        // active edit points, and a selection after `basis` is itself a change of what it reads
        // (the SDK compares the active editor state, as `read_source_r5::open_source` notes).
        let _ = f.inspect().await;
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "trim.selectEditPoint",
                json!({"clip":clip,"edge":"out"}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            if related {
                let ItemKind::Subclip { range, .. } = &mut p.item_mut(ItemId(sub)).unwrap().kind else { panic!("subclip") };
                range.duration.0 = SECOND;
            } else {
                p.sequence_mut(sequence).unwrap().find_item_mut(ClipId(clip)).unwrap().1.name = "Unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"trim.forward","params":{}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the delegated trim now clamps at another source bound")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("trim does not consume clip names: {e}"));
        }
        f.shutdown().await;
    }
}
