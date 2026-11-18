//! Conditional selection and names use the checkpoint's observed content, including restored assignments.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::{Value, json};

async fn select(f: &Fixture, clips: &[u64]) {
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    f.kits
        .execute(
            kition_kits::Caller::User,
            view.kit_id,
            &view.document_id,
            "timeline.select",
            json!({"clips":clips,"linked":false}).as_object().unwrap().clone(),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn every_explicit_target_form_ignores_the_unconsumed_selection() {
    for form in ["rename-clip", "rename-item", "interpolation-clip", "interpolation-clips", "interpolation-on"] {
        let f = Fixture::new(2);
        let (q, basis) = f.inspect().await;
        let clips = v1(&q);
        f.colleague(&[("clip.rename", json!({"clip":clips[1],"name":"Colleague"}))]);
        let _ = f.inspect().await;
        select(&f, &[clips[1]]).await;
        let step = match form {
            "rename-clip" => json!({"command":"clip.rename","params":{"clip":clips[0],"name":"Agent"}}),
            "rename-item" => json!({"command":"clip.rename","params":{"item":q["video"][0]["items"][0]["item"],"name":"Agent"}}),
            "interpolation-clip" => json!({"command":"clip.setTimeInterpolation","params":{"clip":clips[0],"mode":"opticalFlow"}}),
            "interpolation-clips" => json!({"command":"clip.setTimeInterpolation","params":{"clips":[clips[0]],"mode":"opticalFlow"}}),
            _ => json!({"command":"clip.setTimeInterpolation","on":[clips[0],clips[1]],"params":{"mode":"opticalFlow"}}),
        };
        f.call("run", json!({"basis":basis,"steps":[step]})).await.unwrap_or_else(|error| panic!("{form}: {error}"));
        let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
        let sequence = saved.project.sequences().find_map(|item| item.as_sequence()).unwrap();
        assert_eq!(sequence.find_item(kition_film_project::ClipId(clips[1])).unwrap().1.name, "Colleague");
        if form.starts_with("interpolation-") {
            for id in if form.ends_with("-on") { clips.clone() } else { vec![clips[0]] } {
                assert_eq!(
                    sequence.find_item(kition_film_project::ClipId(id)).unwrap().1.time_interpolation,
                    kition_film_project::TimeInterpolation::OpticalFlow
                );
            }
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn implicit_targets_hold_selection_even_when_it_is_restored() {
    for command in ["clip.rename", "clip.setTimeInterpolation"] {
        for restored in [false, true] {
            let f = Fixture::new(2);
            let (q, _) = f.inspect().await;
            let clips = v1(&q);
            select(&f, &[clips[0]]).await;
            let (_, basis) = f.inspect().await;
            select(&f, &[clips[1]]).await;
            if restored {
                let _ = f.inspect().await;
                select(&f, &[clips[0]]).await;
            }
            let before = std::fs::read(f.file()).unwrap();
            let params = if command == "clip.rename" { json!({"name":"Agent"}) } else { json!({"mode":"opticalFlow"}) };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            let error = answer.expect_err("the implicit target selection was assigned by a colleague");
            assert_eq!(error["error"]["code"], "conflict", "{command}/{restored}: {error}");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn appended_names_do_not_hide_observed_assignments_or_hold_unobserved_names() {
    for change in ["new-name", "observed-name", "restored-name", "own-name", "own-new-name"] {
        let f = Fixture::new(2);
        let (q, basis) = f.inspect().await;
        if change == "own-name" {
            f.ok("run", json!({"steps":[{"command":"timeline.setTrack","params":{"track":"V2","name":"Our name"}}]})).await;
        }
        if change == "own-new-name" {
            f.ok("run", json!({"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":3}}]})).await;
            f.colleague(&[("timeline.setTrack", json!({"track":"V4","name":"Colleague"}))]);
            let _ = f.inspect().await;
        }
        if matches!(change, "observed-name" | "restored-name") {
            f.colleague(&[("timeline.setTrack", json!({"track":"V2","name":"Colleague"}))]);
            let _ = f.inspect().await;
        }
        let mut steps = vec![("sequence.addTracks", json!({"video":1,"videoAfter":3}))];
        if change == "restored-name" {
            steps.push(("timeline.setTrack", json!({"track":"V2","name":q["video"][1]["name"]})));
        } else if change == "new-name" {
            steps.push(("timeline.setTrack", json!({"track":"V4","name":"New colleague track"})));
        }
        f.colleague(&steps);
        let before = std::fs::read(f.file()).unwrap();
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":1}}]})).await;
        if matches!(change, "observed-name" | "restored-name" | "own-new-name") {
            let error = answer.expect_err("an observed name was assigned after the checkpoint");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{change}: {error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            answer.unwrap_or_else(|error| panic!("{change}: {error}"));
            let (after, _) = f.inspect().await;
            assert_eq!(after["video"].as_array().unwrap().len(), 5);
            let name = if change == "own-name" { "Our name" } else { "New colleague track" };
            assert!(after["video"].as_array().unwrap().iter().any(|track| track["name"] == Value::String(name.into())));
        }
        f.shutdown().await;
    }
}
