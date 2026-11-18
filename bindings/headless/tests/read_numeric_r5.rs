//! C8-film-read: valid integral JSON numbers must resolve exactly as the handler does.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn integral_float_interpolation_ids_hold_only_the_explicit_assignment() {
    let mut failures = Vec::new();
    for floating in [false, true] {
        for change in ["assigned", "selected", "name"] {
            let f = Fixture::new(2);
            let (sequence, basis) = f.inspect().await;
            let clips = v1(&sequence);
            let target = clips[0];
            let selected = clips[1];
            f.colleague(&[
                ("timeline.select", json!({"clips":[if change == "selected" {selected} else {target}],"linked":false})),
                if change == "name" {
                    ("clip.rename", json!({"clip":target,"name":"Colleague"}))
                } else {
                    ("clip.setTimeInterpolation", json!({"clip":if change == "assigned" {target} else {selected},"mode":"frameBlending"}))
                },
            ]);
            let _ = f.inspect().await;
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(
                    kition_kits::Caller::User,
                    view.kit_id,
                    &view.document_id,
                    "timeline.select",
                    json!({"clips":[selected],"linked":false}).as_object().unwrap().clone(),
                )
                .await
                .unwrap();
            let number = if floating { json!(target as f64) } else { json!(target) };
            let result =
                f.call("run", json!({"basis":basis,"steps":[{"command":"clip.setTimeInterpolation","params":{"clip":number,"mode":"opticalFlow"}}]})).await;
            let correct = if change == "assigned" { result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") } else { result.is_ok() };
            if correct && change == "assigned" {
                let error = result.as_ref().unwrap_err();
                assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == target && conflict["reason"] == "changed"), "{error}");
            }
            if !correct {
                failures.push(format!(
                    "floating={floating}/{change}: {}",
                    result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                ));
            } else if result.is_ok() {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let sequence = saved.project.sequences().find_map(|item| item.as_sequence()).unwrap();
                assert_eq!(
                    sequence.find_item(kition_film_project::ClipId(target)).unwrap().1.time_interpolation,
                    kition_film_project::TimeInterpolation::OpticalFlow
                );
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_integral_float_dimensions_do_not_inherit_sequence_size() {
    let mut failures = Vec::new();
    for floating in [false, true] {
        for change in ["width", "name"] {
            let f = Fixture::new(1);
            let (_, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", if change == "width" { json!({"width":800}) } else { json!({"name":"Unrelated"}) })]);
            let params = if floating {
                json!({"name":"Explicit","width":640.0,"height":360.0,"fps":25,"seconds":1,"audio":false})
            } else {
                json!({"name":"Explicit","width":640,"height":360,"fps":25,"seconds":1,"audio":false})
            };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"file.newOfflineFile","params":params}]})).await;
            if let Err(error) = result {
                failures.push(format!("floating={floating}/{change}: explicit size does not inherit sequence dimensions: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let video = saved.project.items.values().find(|item| item.name == "Explicit").unwrap().as_media().unwrap().info.video.as_ref().unwrap();
                assert_eq!((video.width, video.height), (640, 360));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn integral_float_dimensions_hold_motion_scaling_inputs() {
    let mut failures = Vec::new();
    for floating in [false, true] {
        for related in [true, false] {
            let f = Fixture::new(4);
            let (sequence, basis) = f.inspect().await;
            let clip = v1(&sequence)[3];
            f.colleague(&[if related {
                ("effects.setParam", json!({"clip":clip,"effect":"motion","param":"scale","value":75}))
            } else {
                ("clip.rename", json!({"clip":clip,"name":"Unrelated"}))
            }]);
            let dimensions =
                if floating { json!({"width":640.0,"height":360.0,"scaleMotion":true}) } else { json!({"width":640,"height":360,"scaleMotion":true}) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.settings","params":dimensions}]})).await;
            let correct = if related { result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") } else { result.is_ok() };
            if !correct {
                failures.push(format!(
                    "floating={floating}/related={related}: {}",
                    result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                ));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn integral_float_clip_ids_hold_the_explicit_target_not_the_selection() {
    let mut failures = Vec::new();
    for floating in [false, true] {
        for related in [true, false] {
            let f = Fixture::new(2);
            let (sequence, basis) = f.inspect().await;
            let clips = v1(&sequence);
            let target = clips[0];
            let selected = clips[1];
            f.colleague(&[("clip.rename", json!({"clip":if related { target } else { selected },"name":"Colleague"}))]);
            // Preserve the same unrelated selection after the pinned SDK's
            // refresh; this case isolates numeric resolution from lost state.
            let _ = f.inspect().await;
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(
                    kition_kits::Caller::User,
                    view.kit_id,
                    &view.document_id,
                    "timeline.select",
                    json!({"clips":[selected],"linked":false}).as_object().unwrap().clone(),
                )
                .await
                .unwrap();
            let number = if floating { json!(target as f64) } else { json!(target) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.rename","params":{"clip":number,"name":"Agent"}}]})).await;
            let correct = if related { result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") } else { result.is_ok() };
            if !correct {
                failures.push(format!(
                    "floating={floating}/related={related}: {}",
                    result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                ));
            } else if result.is_ok() {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let sequence = saved.project.sequences().find_map(|item| item.as_sequence()).unwrap();
                assert_eq!(sequence.find_item(kition_film_project::ClipId(target)).unwrap().1.name, "Agent");
                assert_eq!(sequence.find_item(kition_film_project::ClipId(selected)).unwrap().1.name, "Colleague");
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
