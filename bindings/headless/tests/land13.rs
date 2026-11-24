//! C8-land-13t: identity, insertion destinations and authored dependency boundaries.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

/// The nest placement mode is the person's view state (Kit UI protocol 7n), not the file's: a
/// reopened file has the default mode, and the view state the host kept puts the person's back.
#[test]
fn nest_placement_mode_survives_save_and_reopen_through_the_view_state() {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    doc.execute("sequence.nestSequences", json!({"on":false})).unwrap();
    let saved = doc.save(None).unwrap();
    let mut plain = FilmDocument::open(FILE, &saved).unwrap();
    assert_eq!(plain.execute("sequence.nestSequences", json!({})).unwrap()["nest"], false, "the file keeps no mode: nests, toggled off");
    let mut reopened = FilmDocument::open(FILE, &saved).unwrap();
    assert!(reopened.restore_view(&doc.view_state()));
    assert_eq!(reopened.execute("sequence.nestSequences", json!({})).unwrap()["nest"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn model_timing_edits_settle_the_sequence_duration_in_the_receipt() {
    let f = Fixture::new(1);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[0];
    let answer = f.ok("batch", json!({"ops":[{"op":"set","target":clip,"field":"duration","value":(2*SECOND).to_string()}]})).await;
    assert!(
        answer["changes"]["changed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["id"] == sequence["id"] && change["fields"] == json!(["sequence.duration"])),
        "{answer}"
    );
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ripple_speed_holds_later_positions_and_accepts_earlier_appearance_edits() {
    for dependent in [true, false] {
        let f = Fixture::new(6);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[if dependent {
            ("timeline.move", json!({"moves":[{"clip":clips[4],"track":"V2","time":4*SECOND}],"linked":false}))
        } else {
            opacity(clips[0], 25.0)
        }]);
        let answer =
            f.call("run", json!({"basis":basis,"steps":[{"command":"clip.speedDuration","params":{"clips":[clips[2]],"speed":50,"ripple":true}}]})).await;
        if dependent {
            assert!(answer.is_err(), "ripple speed accepted a changed later placement: {answer:?}");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn non_ripple_speed_does_not_hold_distant_later_placements() {
    let f = Fixture::new(6);
    let (sequence, basis) = f.inspect().await;
    let clips = v1(&sequence);
    f.colleague(&[("timeline.move", json!({"moves":[{"clip":clips[4],"track":"V2","time":4*SECOND}],"linked":false}))]);
    f.ok("run", json!({"basis":basis,"steps":[{"command":"clip.speedDuration","params":{"clips":[clips[1]],"speed":200,"ripple":false}}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ripple_trim_and_roll_hold_the_neighbours_they_change() {
    for command in ["timeline.trim", "timeline.roll"] {
        for dependent in [true, false] {
            let f = Fixture::new(6);
            let (sequence, basis) = f.inspect().await;
            let clips = v1(&sequence);
            f.colleague(&[if dependent {
                ("timeline.move", json!({"moves":[{"clip":clips[3],"track":"V2","time":3*SECOND}],"linked":false}))
            } else {
                opacity(clips[0], 25.0)
            }]);
            let params = if command == "timeline.trim" {
                json!({"clip":clips[2],"edge":"out","mode":"ripple","deltaFrames":-3})
            } else {
                json!({"left":clips[2],"right":clips[3],"deltaFrames":-3})
            };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if dependent {
                let error = answer.expect_err("the neighbouring placement changed");
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
            } else {
                answer.unwrap();
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn expanded_nests_hold_the_source_state_they_copy() {
    for expand in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(3)).unwrap();
        let outer = doc.inspect().unwrap()["sequence"]["id"].clone();
        let clips = v1(&doc.inspect().unwrap()["sequence"]);
        doc.execute("timeline.select", json!({"clips":[clips[1]]})).unwrap();
        let inner = doc.execute("clip.nest", json!({"name":"Inner"})).unwrap()["sequence"].clone();
        doc.execute("sequence.nestSequences", json!({"on":!expand})).unwrap();
        doc.execute("sequence.open", json!({"item":inner})).unwrap();
        let inside = v1(&doc.inspect().unwrap()["sequence"])[0];
        doc.execute("sequence.open", json!({"item":outer})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (shown, basis) = f.inspect().await;
        assert_eq!(shown["id"], outer, "the file opens on its first sequence, the outer one");
        f.colleague(&[("sequence.open", json!({"item":inner})), opacity(inside, 25.0), ("sequence.open", json!({"item":outer}))]);
        // The file keeps no placement mode (it is the person's view state): nesting is the
        // default, and the run turns it off to expand.
        let mut steps = vec![json!({"command":"timeline.place","params":{"item":inner,"track":"V2","seconds":6}})];
        if expand {
            steps.insert(0, json!({"command":"sequence.nestSequences","params":{"on":false}}));
        }
        let answer = f.call("run", json!({"basis":basis,"steps":steps})).await;
        if expand {
            assert!(answer.is_err(), "expanded source content changed: {answer:?}");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_effect_does_not_hold_an_adjustment_layer() {
    for dependent in [true, false] {
        let f = Fixture::new(2);
        let (sequence, _) = f.inspect().await;
        let target = v1(&sequence)[0];
        let item = f.colleague(&[("file.newAdjustmentLayer", json!({"seconds":2}))])[0]["item"].clone();
        f.colleague(&[("timeline.place", json!({"item":item,"track":"V2","seconds":0}))]);
        let (sequence, basis) = f.inspect().await;
        let adjustment = sequence["video"][1]["items"][0]["clip"].as_u64().unwrap();
        f.colleague(&[opacity(if dependent { target } else { adjustment }, 25.0)]);
        let answer = f.call("run", json!({"basis":basis,"steps":[set_opacity(target,75.0)]})).await;
        if dependent {
            assert!(answer.is_err(), "the authored effect changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn multicam_flatten_holds_the_angle_it_copies() {
    for dependent in [true, false] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let source =
            doc.execute("file.newSequence", json!({"name":"Cameras","width":64,"height":36,"fps":24,"video":2,"audio":1})).unwrap()["sequence"].clone();
        for (track, color) in [("V1", "#ff0000"), ("V2", "#0000ff")] {
            let item = doc.execute("file.newColorMatte", json!({"color":color,"seconds":2})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":item,"track":track,"seconds":0})).unwrap();
        }
        let cameras = doc.inspect().unwrap()["sequence"].clone();
        let inside = cameras["video"][if dependent { 0 } else { 1 }]["items"][0]["clip"].as_u64().unwrap();
        let program = doc.execute("file.newSequence", json!({"name":"Program","width":64,"height":36,"fps":24})).unwrap()["sequence"].clone();
        doc.execute("timeline.place", json!({"item":source,"track":"V1","seconds":0})).unwrap();
        let target = v1(&doc.inspect().unwrap()["sequence"])[0];
        doc.execute("clip.multicamEnable", json!({"clips":[target],"enabled":true})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.open", json!({"item":source})), opacity(inside, 25.0), ("sequence.open", json!({"item":program}))]);
        // The file keeps no open sequence (the person's view state): the run opens the program.
        let steps = json!([{"command":"sequence.open","params":{"item":program}},{"command":"clip.multicamFlatten","params":{"clips":[target]}}]);
        let answer = f.call("run", json!({"basis":basis,"steps":steps})).await;
        if dependent {
            assert!(answer.is_err(), "the copied camera changed: {answer:?}");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}
