//! C8-film-read: the host restores modes after an agent run, including setters.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_restore_the_timeline_modes_they_set() {
    let mut failures = Vec::new();
    for (command, field) in [("sequence.snap", "snapping"), ("sequence.linkedSelection", "linkedSelection"), ("sequence.nestSequences", "nest")] {
        let f = Fixture::new(3);
        let before = f.ok("inspect", json!({})).await["details"]["stateDigest"].clone();
        f.ok("run", json!({"steps":[{"command":command,"params":{"on":false}}]})).await;
        let after = f.ok("inspect", json!({})).await["details"]["stateDigest"].clone();
        if before != after {
            failures.push(format!("{command}: a mode leaked beyond the run ({before} -> {after})"));
        }
        // Inspect may reuse an unchanged document revision. Probe the live
        // person's mode through the next toggle's actual returned value too.
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        let probe = f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, Default::default()).await.unwrap().result.unwrap();
        if probe[field] != false {
            failures.push(format!("{command}: live mode was not restored: {probe}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mode_set_by_an_earlier_step_applies_until_the_run_ends() {
    let mut doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let destination = doc.inspect().unwrap()["sequence"]["id"].clone();
    let media = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].clone();
    let source = doc.execute("file.newSequence", json!({"name":"Source","video":2,"audio":0})).unwrap()["sequence"].clone();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V2","time":0})).unwrap();
    doc.execute("sequence.open", json!({"item":destination})).unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let before = f.ok("inspect", json!({})).await["details"]["stateDigest"].clone();
    let answer = f
        .ok(
            "run",
            json!({"steps":[
                {"command":"sequence.nestSequences","params":{"on":false}},
                {"command":"timeline.place","params":{"item":source,"track":"V1","time":0}}
            ]}),
        )
        .await;
    assert_eq!(answer["completed"][1]["result"]["clips"].as_array().unwrap().len(), 2, "the earlier mode selects the copy branch: {answer}");
    let after = f.ok("inspect", json!({})).await["details"]["stateDigest"].clone();
    assert_eq!(after, before, "the mode is restored after using it");
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    let probe =
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "sequence.nestSequences", Default::default()).await.unwrap().result.unwrap();
    assert_eq!(probe["nest"], false, "the next person command sees the restored nest mode: {probe}");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_receive_the_persons_nondefault_timeline_modes() {
    let mut failures = Vec::new();
    for (command, field) in [("sequence.snap", "snapping"), ("sequence.linkedSelection", "linkedSelection"), ("sequence.nestSequences", "nest")] {
        let f = Fixture::new(3);
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, json!({"on":false}).as_object().unwrap().clone()).await.unwrap();
        let answer = f.ok("run", json!({"steps":[{"command":command,"params":{}}]})).await;
        if answer["completed"][0]["result"][field] != true {
            failures.push(format!("{command}: the agent did not receive the person's off mode: {answer}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn disabled_linked_selection_keeps_the_other_partners_write_unrelated() {
    use kition_film_project::{ClipId, ItemId};
    for related in [true, false] {
        let f = Fixture::new(3);
        let (q, _) = f.inspect().await;
        let clips = v1(&q);
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(ItemId(q["id"].as_u64().unwrap())).unwrap();
            for id in &clips[..2] {
                q.find_item_mut(ClipId(*id)).unwrap().1.link = Some(900);
            }
        });
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "sequence.linkedSelection", json!({"on":false}).as_object().unwrap().clone())
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            p.sequence_mut(ItemId(q["id"].as_u64().unwrap())).unwrap().find_item_mut(ClipId(clips[usize::from(!related)])).unwrap().1.enabled = false;
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.enable","params":{"clips":[clips[0]]}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the target enabled field changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("the other partner is not targeted in this mode: {e}"));
            let saved = v1_on_disk(&f.file());
            assert!(!saved[0].2 && !saved[1].2, "only the named target changes; the colleague's partner value survives: {saved:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_restore_marker_and_multicamera_switches() {
    let mut failures = Vec::new();
    for (command, params) in [
        ("sequence.selectionFollowsPlayhead", json!({})),
        ("sequence.showThroughEdits", json!({})),
        ("markers.rippleSequenceMarkers", json!({})),
        ("markers.copyPasteIncludesSequenceMarkers", json!({})),
        ("markers.filterColors", json!({"color":"Red"})),
        ("multicam.audioFollowsVideo", json!({})),
        ("multicam.selectionTopDown", json!({})),
        ("multicam.showPreviewMonitor", json!({})),
        ("multicam.autoAdjustQuality", json!({})),
        ("multicam.transmitView", json!({})),
    ] {
        let f = Fixture::new(3);
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        let expected = f
            .kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone())
            .await
            .unwrap()
            .result
            .unwrap();
        // All these operations toggle a Boolean/membership. Toggle twice to
        // restore the original live value before exercising an agent run.
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap().result.unwrap();
        f.ok("run", json!({"steps":[{"command":command,"params":params}]})).await;
        let actual = f
            .kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone())
            .await
            .unwrap()
            .result
            .unwrap();
        if actual != expected {
            failures.push(format!("{command}: expected restored toggle {expected}, got {actual}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_restore_default_transition_choices() {
    let mut failures = Vec::new();
    for (effect, probe, field, expected) in
        [("mosaic_transition", "exponential_fade", "video", "cross_dissolve"), ("exponential_fade", "mosaic_transition", "audio", "constant_power")]
    {
        let f = Fixture::new(3);
        f.ok("run", json!({"steps":[{"command":"effects.setDefaultTransition","params":{"effect":effect}}]})).await;
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        let actual = f
            .kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "effects.setDefaultTransition",
                json!({"effect":probe}).as_object().unwrap().clone(),
            )
            .await
            .unwrap()
            .result
            .unwrap();
        if actual[field] != expected {
            failures.push(format!("{field}: the agent's default transition leaked: {actual}"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_restore_the_persons_clip_mixer_modes() {
    let f = Fixture::new(3);
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    f.kits
        .execute(
            kition_kits::Caller::User,
            view.kit_id,
            &view.document_id,
            "clipMixer.setMode",
            json!({"track":"A1","mode":"Touch"}).as_object().unwrap().clone(),
        )
        .await
        .unwrap()
        .result
        .unwrap();
    f.ok("run", json!({"steps":[{"command":"clipMixer.setMode","params":{"track":"A1","mode":"Off"}}]})).await;
    let actual = f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "mixer.inspect", Default::default()).await.unwrap().result.unwrap();
    assert_eq!(actual["clipModes"][0]["mode"], "Touch", "the agent's clip mixer mode leaked: {actual}");
    f.shutdown().await;
}
