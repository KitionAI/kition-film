//! C8-film-pin: navigation results depend on the observed timebase and geometry.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn following_navigation_preserves_the_lane_order_used_by_implicit_recipients() {
    for reordered in [false, true] {
        let f = Fixture::new(1);
        let item = f.colleague(&[("item.newColorMatte", json!({"seconds":1}))])[0]["item"].clone();
        f.colleague(&[("timeline.place", json!({"item":item,"track":"V2","time":0}))]);
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "sequence.selectionFollowsPlayhead",
                json!({"on":true}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        f.kits.save(kition_kits::Caller::User, view.kit_id, &view.document_id).await.unwrap();
        let (seen, basis) = f.inspect().await;
        if reordered {
            rewrite(&f.file(), |project| {
                let sequence = project.sequences().next().unwrap().id;
                project.sequence_mut(sequence).unwrap().video_tracks.swap(0, 1);
            });
        }
        let before = std::fs::read(f.file()).unwrap();
        let result = f
            .call(
                "run",
                json!({"basis":basis,"steps":[
                    {"command":"playhead.set","params":{"time":0}},
                    {"command":"clip.rename","params":{"name":"First observed recipient"}}
                ]}),
            )
            .await;
        if reordered {
            assert!(result.is_err(), "changed selection order accepted: {result:?}");
            assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            result.unwrap();
            let project = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap().project;
            assert_eq!(
                project
                    .sequences()
                    .find_map(|item| project.sequence(item.id)?.find_item(kition_film_project::ClipId(v1(&seen)[0])).map(|(_, clip)| clip.name.as_str())),
                Some("First observed recipient")
            );
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn navigation_retains_timebase_and_sequence_geometry() {
    let mut missing = Vec::new();
    for (command, params, changed) in [
        ("playhead.step", json!({"frames":1}), "rate"),
        ("playhead.end", json!({}), "duration"),
        ("playhead.nextEditAnyTrack", json!({}), "start"),
        ("edit.selectAll", json!({}), "membership"),
        ("project.selectAll", json!({}), "items"),
    ] {
        let f = Fixture::new(2);
        if changed == "start" {
            let (seen, _) = f.inspect().await;
            f.colleague(&[("timeline.move", json!({"moves":[{"clip":v1(&seen)[1],"time":3*SECOND,"track":"V1"}]}))]);
        }
        let (seen, basis) = f.inspect().await;
        match changed {
            "rate" => f.colleague(&[("sequence.settings", json!({"fps":30}))]),
            "duration" => {
                rewrite(&f.file(), |project| {
                    let sequence = project.sequences().next().unwrap().id;
                    project.sequence_mut(sequence).unwrap().video_tracks[0].items.last_mut().unwrap().duration.0 /= 2;
                });
                vec![]
            }
            "start" => f.colleague(&[("timeline.move", json!({"moves":[{"clip":v1(&seen)[1],"time":4*SECOND,"track":"V1"}]}))]),
            "membership" => f.colleague(&[("edit.delete", json!({"clips":[v1(&seen)[1]]}))]),
            _ => f.colleague(&[("item.newColorMatte", json!({"seconds":1}))]),
        };
        let before = std::fs::read(f.file()).unwrap();
        let result =
            f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"time":if changed == "start" {2.5} else {0.0}}}]})).await;
        match result {
            Err(error) => assert_eq!(error["error"]["code"], "conflict", "{command}: {error}"),
            Ok(_) => missing.push(command),
        }
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
    assert!(missing.is_empty(), "changed navigation inputs were accepted: {missing:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn navigation_allows_unconsumed_looks_and_unselected_track_geometry() {
    for command in ["playhead.step", "playhead.end", "playhead.nextEdit", "edit.selectAll", "project.selectAll"] {
        let f = Fixture::new(2);
        let (seen, _) = f.inspect().await;
        let clip = v1(&seen)[0];
        f.colleague(&[("timeline.setTargeting", json!({"track":"V2","targeted":false}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("effect.setParam", json!({"clip":clip,"effect":"opacity","param":"opacity","value":25}))]);
        let params = if command == "playhead.step" { json!({"frames":1}) } else { json!({}) };
        f.ok("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
        f.shutdown().await;
    }
    let f = Fixture::new(2);
    let item = f.colleague(&[("item.newColorMatte", json!({"seconds":1}))])[0]["item"].clone();
    let distant = f.colleague(&[("timeline.place", json!({"item":item,"track":"V2","time":0}))])[0]["clips"][0].clone();
    f.colleague(&[("timeline.setTargeting", json!({"track":"V2","targeted":false}))]);
    let (_, basis) = f.inspect().await;
    f.colleague(&[("timeline.move", json!({"moves":[{"clip":distant,"time":3*SECOND,"track":"V2"}]}))]);
    let answer = f
        .ok(
            "run",
            json!({"basis":basis,"steps":[
                {"command":"timeline.setTargeting","params":{"track":"V2","targeted":false}},
                {"command":"playhead.nextEdit"}
            ]}),
        )
        .await;
    assert!(!answer.to_string().contains("PremiseFact"), "private facts leaked: {answer}");
    assert!(!answer.to_string().contains("fact:"), "private fact ids leaked: {answer}");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn marker_and_source_navigation_retain_their_destination_inputs() {
    let mut missing = Vec::new();
    for (command, source) in
        [("marker.goToIn", false), ("marker.goToOut", false), ("marker.goNext", false), ("source.setPlayhead", true), ("marker.goToOut", true)]
    {
        let f = Fixture::new(2);
        let (seen, _) = f.inspect().await;
        let item = seen["id"].clone();
        f.colleague(&[("marker.markIn", json!({"time":0})), ("marker.markOut", json!({"time":SECOND})), ("marker.add", json!({"time":SECOND}))]);
        let (_, basis) = f.inspect().await;
        match command {
            "marker.goToIn" => {
                f.colleague(&[("marker.markIn", json!({"time":SECOND/2}))]);
            }
            "marker.goToOut" => {
                f.colleague(&[("marker.markOut", json!({"time":SECOND*3/2}))]);
            }
            "marker.goNext" => {
                f.colleague(&[("marker.clearAll", json!({}))]);
            }
            _ => {
                f.colleague(&[("sequence.settings", json!({"fps":30}))]);
            }
        }
        let before = std::fs::read(f.file()).unwrap();
        let params = if source && command != "source.setPlayhead" {
            json!({"target":"source"})
        } else if source {
            json!({"frame":12})
        } else {
            json!({})
        };
        let mut steps = Vec::new();
        if source {
            steps.push(json!({"command":"source.open","params":{"item":item}}));
        }
        steps.push(json!({"command":command,"params":params}));
        match f.call("run", json!({"basis":basis,"steps":steps})).await {
            Err(error) => assert_eq!(error["error"]["code"], "conflict", "{command}/source={source}: {error}"),
            Ok(_) => missing.push((command, source)),
        }
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
    assert!(missing.is_empty(), "changed navigation destinations were accepted: {missing:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn source_marker_routes_retain_bounds_and_destination_timebases() {
    let mut missing = Vec::new();
    for command in ["marker.goNext", "marker.goPrev", "marker.add", "marker.edit"] {
        let f = Fixture::new(2);
        let (seen, _) = f.inspect().await;
        let source = seen["id"].clone();
        let marker = f.colleague(&[("marker.add", json!({"time":SECOND}))])[0]["marker"].clone();
        let (_, basis) = f.inspect().await;
        if command.starts_with("marker.go") {
            f.colleague(&[("sequence.settings", json!({"fps":30}))]);
        } else {
            rewrite(&f.file(), |project| {
                let id = project.sequences().next().unwrap().id;
                project.sequence_mut(id).unwrap().video_tracks[0].items.last_mut().unwrap().duration.0 /= 2;
            });
        }
        let params = match command {
            "marker.edit" => json!({"target":"source","marker":marker,"durationFrames":12}),
            "marker.add" => json!({"target":"source","time":0}),
            _ => json!({"target":"source"}),
        };
        let mut steps = vec![json!({"command":"source.open","params":{"item":source}})];
        if command == "marker.goPrev" {
            steps.push(json!({"command":"source.setPlayhead","params":{"time":SECOND*3/2}}));
        }
        steps.push(json!({"command":command,"params":params}));
        match f.call("run", json!({"basis":basis,"steps":steps})).await {
            Err(error) => assert_eq!(error["error"]["code"], "conflict", "{command}: {error}"),
            Ok(_) => missing.push(command),
        }
        f.shutdown().await;
    }
    assert!(missing.is_empty(), "changed Source marker inputs were accepted: {missing:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn marking_clip_and_selection_preserves_same_field_protection() {
    let mut missing = Vec::new();
    for command in ["marker.markClip", "marker.markSelection"] {
        let f = Fixture::new(2);
        let (seen, basis) = f.inspect().await;
        f.colleague(&[("marker.markIn", json!({"time":SECOND/2}))]);
        let step = if command == "marker.markSelection" { json!({"command":command,"on":[v1(&seen)[0]]}) } else { json!({"command":command}) };
        match f.call("run", json!({"basis":basis,"steps":[step]})).await {
            Err(error) => assert_eq!(error["error"]["code"], "conflict", "{command}: {error}"),
            Ok(_) => missing.push(command),
        }
        f.shutdown().await;
    }
    assert!(missing.is_empty(), "changed assigned marks were accepted: {missing:?}");
}
