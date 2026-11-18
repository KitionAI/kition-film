//! Gap navigation snaps the destination to the sequence's current timebase.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn gap_navigation_holds_the_frame_rate_that_snaps_its_destination() {
    for command in ["sequence.goToNextGap", "sequence.goToNextGapInTrack", "sequence.goToPrevGap", "sequence.goToPrevGapInTrack"] {
        let f = Fixture::new(3);
        f.colleague(&[("timeline.move", json!({"moves":[{"clip":v1(&f.inspect().await.0)[1],"time":3*SECOND,"track":"V1"}]}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.settings", json!({"fps":60}))]);
        let before = std::fs::read(f.file()).unwrap();
        let params = if command.ends_with("InTrack") { json!({"track":"V1"}) } else { json!({}) };
        let error = f
            .refused("run", json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"time":if command.contains("Prev") {3.5} else {0.0}}}]}))
            .await;
        assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn gap_navigation_holds_the_linked_selection_at_its_destination() {
    use kition_film_project::ClipId;
    for change in ["link", "opacity"] {
        let f = Fixture::new(2);
        let (seen, _) = f.inspect().await;
        f.colleague(&[("timeline.move", json!({"moves":[{"clip":v1(&seen)[1],"time":3*SECOND,"track":"V1"}]}))]);
        let item = f.colleague(&[("file.newBarsAndTone", json!({"seconds":3}))])[0]["item"].clone();
        let placed = f.colleague(&[("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","time":0}))])[0].clone();
        let picture = placed["clips"][0].as_u64().unwrap();
        let sound = placed["clips"][1].as_u64().unwrap();
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        for (command, params) in [
            ("timeline.setTargeting", json!({"track":"V2","targeted":true})),
            ("timeline.setTargeting", json!({"track":"A2","targeted":false})),
            ("sequence.selectionFollowsPlayhead", json!({"on":true})),
        ] {
            f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
        }
        f.kits.save(kition_kits::Caller::User, view.kit_id, &view.document_id).await.unwrap();
        let (_, basis) = f.inspect().await;
        if change == "link" {
            rewrite(&f.file(), |project| {
                let id = project.sequences().next().unwrap().id;
                project.sequence_mut(id).unwrap().find_item_mut(ClipId(sound)).unwrap().1.link = None;
            });
        } else {
            f.colleague(&[("effects.setParam", json!({"clip":picture,"effect":"opacity","param":"opacity","value":25}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.goToNextGapInTrack","params":{"track":"V1"},"at":{"time":0}}]})).await;
        if change == "link" {
            assert!(result.is_err(), "changed destination linked group was accepted: {result:?}");
            assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "unconsumed picture must survive gap navigation: {result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn enabling_playhead_selection_holds_the_group_it_will_select() {
    use kition_film_project::ClipId;
    for params in [json!({"on":true}), json!({})] {
        for change in ["link", "opacity"] {
            let f = Fixture::new(1);
            let item = f.colleague(&[("file.newBarsAndTone", json!({"seconds":3}))])[0]["item"].clone();
            let placed = f.colleague(&[("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","time":0}))])[0].clone();
            let picture = placed["clips"][0].as_u64().unwrap();
            let sound = placed["clips"][1].as_u64().unwrap();
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            for (command, params) in
                [("timeline.setTargeting", json!({"track":"V2","targeted":true})), ("timeline.setTargeting", json!({"track":"A2","targeted":false}))]
            {
                f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
            }
            f.kits.save(kition_kits::Caller::User, view.kit_id, &view.document_id).await.unwrap();
            let (_, basis) = f.inspect().await;
            if change == "link" {
                rewrite(&f.file(), |project| {
                    let id = project.sequences().next().unwrap().id;
                    project.sequence_mut(id).unwrap().find_item_mut(ClipId(sound)).unwrap().1.link = None;
                });
            } else {
                f.colleague(&[("effects.setParam", json!({"clip":picture,"effect":"opacity","param":"opacity","value":25}))]);
            }
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.selectionFollowsPlayhead","params":params,"at":{"time":0}}]})).await;
            if change == "link" {
                let error = result.expect_err("enabling selection follow must hold its linked group");
                assert_eq!(error["error"]["code"], "conflict");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
            } else {
                assert!(result.is_ok(), "unconsumed picture must survive enabling selection follow: {result:?}");
            }
            f.shutdown().await;
        }
    }
}
