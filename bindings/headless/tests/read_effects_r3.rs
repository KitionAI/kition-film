//! C8-film-read: independent-file writers for the effects dependency audit.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

async fn linked_audio() -> (Fixture, u64, u64) {
    let f = Fixture::new(4);
    let (seq, _) = f.inspect().await;
    let clips = v1(&seq);
    rewrite(&f.file(), |p| {
        let q = p.sequence_mut(ItemId(seq["id"].as_u64().unwrap())).unwrap();
        let mut audio = q.video_tracks[0].items.remove(1);
        audio.link = Some(910);
        audio.effects = ["volume", "panner"].iter().map(|id| kition_film_project::find_effect(id).unwrap().instance()).collect();
        q.video_tracks[0].items[0].link = Some(910);
        q.audio_tracks[0].items.push(audio);
    });
    (f, clips[0], clips[1])
}

#[tokio::test(flavor = "multi_thread")]
async fn gain_holds_linked_audio_assigned_gain_and_allows_its_name() {
    for related in [true, false] {
        let (f, video, audio) = linked_audio().await;
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let q = p.sequences().next().unwrap().id;
            let (_, clip) = p.sequence_mut(q).unwrap().find_item_mut(ClipId(audio)).unwrap();
            if related {
                clip.gain_db = -7.0;
            } else {
                clip.name = "colleague".into();
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.audioGain","params":{"clips":[video],"mode":"set","db":-3}}]})).await;
        if related {
            assert_conflict(&result.expect_err("same-field linked audio gain must refuse"), &audio.to_string(), "changed");
        } else {
            result.unwrap_or_else(|e| panic!("linked audio name does not affect gain: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sound_type_holds_linked_audio_reconciliation_and_allows_its_name() {
    for related in [true, false] {
        let (f, video, audio) = linked_audio().await;
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let q = p.sequences().next().unwrap().id;
            let (_, clip) = p.sequence_mut(q).unwrap().find_item_mut(ClipId(audio)).unwrap();
            if related {
                clip.audio_mixing = Some(kition_film_project::AudioMixing::new(kition_film_project::audio_mixing::AudioType::Dialogue));
            } else {
                clip.name = "colleague".into();
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"audioMixing.setType","params":{"clips":[video],"type":"music"}}]})).await;
        if related {
            assert_conflict(&result.expect_err("linked reconciliation replaces sound type"), &audio.to_string(), "changed");
        } else {
            result.unwrap_or_else(|e| panic!("linked audio name is unrelated: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_submix_holds_dependent_send_and_allows_unrelated_fader() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let sub = f.colleague(&[("mixer.addSubmix", json!({"name":"bus"}))])[0]["id"].as_u64().unwrap();
        f.colleague(&[("mixer.addSend", json!({"strip":"A1","target":sub,"levelDb":-10}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[if related {
            ("mixer.setSend", json!({"strip":"A1","send":0,"levelDb":-6}))
        } else {
            ("mixer.setStrip", json!({"strip":"A1","volumeDb":-6}))
        }]);
        {
            use kition_kit::KitDocument;
            let doc = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
            let held = doc.under("mixer.deleteSubmix", &json!({"strip":sub})).unwrap().unwrap();
            assert!(
                held.premises.iter().any(|p| p.fields.as_ref().is_some_and(|fs| fs.iter().any(|name| name.starts_with("props.mixer.sends")))),
                "dependent send declaration: {held:?}"
            );
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"mixer.deleteSubmix","params":{"strip":sub}}]})).await;
        if related {
            assert_eq!(result.expect_err("dependent send deleted by this write")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("a fader survives bus deletion: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn automation_holds_sample_rate_and_allows_unrelated_track_name() {
    for related in [true, false] {
        let f = Fixture::new(2);
        let (seq, basis) = f.inspect().await;
        if related {
            rewrite(&f.file(), |p| {
                p.sequence_mut(ItemId(seq["id"].as_u64().unwrap())).unwrap().settings.sample_rate = 96000;
            });
        } else {
            f.colleague(&[("mixer.setStrip", json!({"strip":"A1","name":"renamed"}))]);
        }
        let result = f
            .call("run", json!({"basis":basis,"steps":[{"command":"mixer.writeAutomation","params":{"strip":"A1","points":[[SECOND,-5],[2*SECOND,-8]]}}]}))
            .await;
        if related {
            assert_eq!(result.expect_err("automation epsilon uses sample rate")["error"]["code"], "conflict");
        } else {
            result.unwrap_or_else(|e| panic!("track name does not affect automation: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn source_graphic_peer_same_field_is_protected_and_enabled_is_unrelated() {
    for related in [true, false] {
        let f = Fixture::new(1);
        let clip = f.colleague(&[("graphics.newText", json!({"newClip":true,"text":"initial","time":2*SECOND}))])[0]["clip"].as_u64().unwrap();
        f.colleague(&[("graphics.upgradeToSourceGraphic", json!({"clip":clip}))]);
        let mut peer = 0;
        rewrite(&f.file(), |p| {
            peer = p.alloc_id();
            let qid = p.sequences().next().unwrap().id;
            let q = p.sequence_mut(qid).unwrap();
            let (tid, source) = q.find_item(ClipId(clip)).unwrap();
            let mut copy = source.clone();
            copy.id = ClipId(peer);
            copy.start.0 += 8 * SECOND;
            q.track_mut(tid).unwrap().items.push(copy);
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let qid = p.sequences().next().unwrap().id;
            let (_, copy) = p.sequence_mut(qid).unwrap().find_item_mut(ClipId(peer)).unwrap();
            if related {
                copy.effect_mut("graphic_text").unwrap().param_mut("text").unwrap().value = kition_film_project::ParamValue::Text("colleague".into());
            } else {
                copy.enabled = false;
            }
        });
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"graphics.setText","params":{"clip":clip,"layer":0,"text":"mine"}}]})).await;
        if related {
            assert_conflict(&result.expect_err("source-graphic peer text is replaced"), &peer.to_string(), "changed");
        } else {
            result.unwrap_or_else(|e| panic!("source peer enabled survives layer reconciliation: {e}"));
        }
        f.shutdown().await;
    }
}
