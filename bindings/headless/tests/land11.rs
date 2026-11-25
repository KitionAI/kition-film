//! C8-land-11t: declarations follow the command's actual object resolvers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn nested_references_and_mixer_names_are_declared() {
    let doc = kition_film_kit::FilmDocument::open(FILE, &project(2)).unwrap();
    let commands = doc.commands();
    for (id, path, ty) in [
        ("timeline.move", "moves[].clip", "Clip"),
        ("timeline.move", "moves[].track", "Track"),
        ("timeline.placeMany", "items[].item", "Item"),
        ("sound.phrase", "items.hit", "Item"),
        ("sound.phrase", "items.transition", "Item"),
        ("mixer.setStrip", "output", "Track"),
        ("mixer.setSend", "target", "Track"),
        ("transition.beatCut", "sfx", "Item"),
        ("sequence.deleteTracks", "video", "Track"),
        ("sequence.deleteTracks", "audio", "Track"),
    ] {
        let command = commands.iter().find(|command| command.id == id).unwrap();
        assert!(command.objects.contains(&path), "{id}.{path}: {:?}", command.objects);
        assert!(command.object_types.iter().any(|(name, types)| *name == path && *types == [ty]), "{id}.{path}");
    }
    for command in &commands {
        for (path, _) in command.object_types {
            let takes_name = (command.id.starts_with("mixer.") && matches!(*path, "strip" | "track" | "target" | "output"))
                || (command.id == "audio.voiceover.start" && *path == "track");
            assert_eq!(command.name_params.contains(&(*path, "props.name")), takes_name, "{}.{}", command.id, path);
        }
    }
    assert!(commands.iter().find(|command| command.id == "audio.voiceover.start").unwrap().name_params.contains(&("track", "props.name")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_nested_move_holds_the_linked_partner_it_moves() {
    for changed in [true, false] {
        let f = Fixture::new(3);
        let (sequence, _) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[("clip.link", json!({"clips": [clips[0], clips[1]]}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[opacity(clips[if changed { 1 } else { 2 }], 25.0)]);
        let answer = f
            .call(
                "run",
                json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                    "moves": [{"clip": clips[0], "track": "V1", "time": 5 * SECOND}], "linked": true
                }}]}),
            )
            .await;
        if changed {
            assert_conflict(&answer.expect_err("linked partner changed"), &clips[1].to_string(), "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[test]
fn move_premises_share_the_commands_explicit_link_and_lock_rules() {
    let mut doc = kition_film_kit::FilmDocument::open(FILE, &project(2)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"].clone();
    let clips = v1(&sequence);
    doc.execute("timeline.move", json!({"moves": [{"clip": clips[1], "track": "V2", "time": SECOND}], "linked": false})).unwrap();
    doc.execute("clip.link", json!({"clips": clips})).unwrap();
    doc.execute("sequence.linkedSelection", json!({"on": false})).unwrap();
    let params = json!({"moves": [{"clip": clips[0], "track": "V1", "time": 5 * SECOND}], "linked": true});
    let under = doc.under("timeline.move", &params).unwrap().unwrap();
    assert!(under.premises.iter().any(|premise| premise.id == clips[1]), "explicit linked: {under:?}");
    doc.execute("sequence.linkedSelection", json!({"on": true})).unwrap();
    doc.execute("timeline.setTrack", json!({"track": "V2", "locked": true})).unwrap();
    let under = doc.under("timeline.move", &params).unwrap().unwrap();
    assert!(!under.premises.iter().any(|premise| premise.id == clips[1]), "locked partner: {under:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn nested_move_holds_the_clip_it_names() {
    for changed in [true, false] {
        let f = Fixture::new(3);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[opacity(clips[usize::from(!changed)], 25.0)]);
        let answer = f
            .call(
                "run",
                json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                    "moves": [{"clip": clips[0], "track": "V1", "time": 4 * SECOND}], "linked": false
                }}]}),
            )
            .await;
        if changed {
            assert_conflict(&answer.expect_err("nested clip changed"), &clips[0].to_string(), "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_move_holds_its_destination_instead_of_the_playhead() {
    for change in ["inside", "outside", "playhead", "deleted", "unrelated lock"] {
        let f = Fixture::new(8);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[match change {
            "inside" => opacity(clips[4], 25.0),
            "deleted" => ("edit.delete", json!({"clips": [clips[4]]})),
            "playhead" => opacity(clips[0], 25.0),
            "unrelated lock" => ("timeline.setTrack", json!({"track": "V3", "locked": true})),
            _ => opacity(clips[6], 25.0),
        }]);
        let before = std::fs::read(f.file()).unwrap();
        let answer = f
            .call(
                "run",
                json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                    "moves": [{"clip": clips[2], "track": "V1", "time": 4 * SECOND}], "linked": false
                }}]}),
            )
            .await;
        if matches!(change, "inside" | "deleted") {
            let error = answer.expect_err("overwritten destination changed");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            if change == "inside" {
                assert_conflict(&error, &clips[4].to_string(), "changed");
            }
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn moves_hold_the_transitions_they_remove() {
    for changed in [true, false] {
        let f = Fixture::new(8);
        let (sequence, _) = f.inspect().await;
        let clips = v1(&sequence);
        let made = f.colleague(&[("sequence.applyVideoTransition", json!({"clip": clips[2], "edge": "out", "frames": 4}))]);
        let transition = made[0]["transition"].clone();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if changed { ("sequence.setTransition", json!({"transition": transition, "reverse": true})) } else { opacity(clips[6], 25.0) }]);
        let answer = f
            .call(
                "run",
                json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                    "moves": [{"clip": clips[2], "track": "V1", "time": 4 * SECOND}], "linked": false
                }}]}),
            )
            .await;
        if changed {
            assert_conflict(&answer.expect_err("removed transition changed"), &transition.to_string(), "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn insert_moves_hold_the_captions_they_ripple() {
    for changed in [true, false] {
        let f = Fixture::new(8);
        let (sequence, _) = f.inspect().await;
        let clips = v1(&sequence);
        let made = f.colleague(&[("caption.add", json!({"text": "Mine", "seconds": 6}))]);
        let (_, basis) = f.inspect().await;
        f.colleague(&[if changed { ("caption.setText", json!({"caption": made[0]["caption"], "text": "Theirs"})) } else { opacity(clips[1], 25.0) }]);
        let answer = f
            .call(
                "run",
                json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                    "moves": [{"clip": clips[2], "track": "V1", "time": 4 * SECOND}], "linked": false, "insert": true
                }}]}),
            )
            .await;
        if changed {
            assert_conflict(&answer.expect_err("rippled caption changed"), &sequence["id"].to_string(), "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn snapped_moves_hold_the_markers_that_choose_their_destination() {
    let f = Fixture::new(8);
    let (sequence, _) = f.inspect().await;
    f.colleague(&[("marker.add", json!({"seconds": 4.05}))]);
    let (_, basis) = f.inspect().await;
    f.colleague(&[("marker.clearAll", json!({"target": "program"}))]);
    let error = f
        .refused(
            "run",
            json!({"basis": basis, "steps": [{"command": "timeline.move", "params": {
                "moves": [{"clip": v1(&sequence)[2], "track": "V1", "time": 4 * SECOND}], "linked": false, "snap": "markers"
            }}]}),
        )
        .await;
    assert_conflict(&error, &sequence["id"].to_string(), "changed");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mixer_references_hold_names_ordinals_outputs_and_send_targets() {
    for reference in ["name", "folded name", "ordinal", "output", "send target"] {
        for changed in [true, false] {
            let f = Fixture::new(2);
            let made = f.colleague(&[("mixer.addSubmix", json!({"name": "Dialogue"})), ("mixer.addSubmix", json!({"name": "Other"}))]);
            let submix = made[0]["id"].as_u64().unwrap();
            let (sequence, _) = f.inspect().await;
            let audio = sequence["audio"][0]["id"].as_u64().unwrap();
            if reference == "send target" {
                f.colleague(&[("mixer.addSend", json!({"strip": audio, "target": "S2"}))]);
            }
            let (_, basis) = f.inspect().await;
            f.colleague(&[if changed { ("mixer.setStrip", json!({"strip": submix, "volumeDb": -7})) } else { opacity(v1(&sequence)[0], 25.0) }]);
            let step = match reference {
                "name" => json!({"command": "mixer.setStrip", "params": {"strip": "Dialogue", "pan": 10}}),
                "folded name" => json!({"command": "mixer.setStrip", "params": {"strip": " dialogue ", "pan": 10}}),
                "ordinal" => json!({"command": "mixer.setStrip", "params": {"strip": "S1", "pan": 10}}),
                "output" => json!({"command": "mixer.setStrip", "params": {"strip": audio, "output": submix}}),
                _ => json!({"command": "mixer.setSend", "params": {"strip": audio, "send": 0, "target": submix}}),
            };
            let answer = f.call("run", json!({"basis": basis, "steps": [step]})).await;
            // mixer.rs::set_strip / set_send consume route identity and channel
            // eligibility, not the destination fader. Preserve that fader while
            // checking the exact named/ordinal destination and assigned patch.
            let written = answer.unwrap_or_else(|error| panic!("{reference}: {error}"));
            let sub = f.ok("query", json!({"objects":[submix]})).await;
            assert_eq!(sub["objects"][0]["fields"]["volumeDb"], if changed { json!(-7) } else { json!(0) }, "{reference}: {sub}");
            if matches!(reference, "name" | "folded name" | "ordinal") {
                assert_eq!(written["completed"][0]["result"]["id"], submix, "{reference}: {written}");
                assert_eq!(sub["objects"][0]["fields"]["pan"], 10, "{reference}: {sub}");
            } else {
                let track = f.ok("query", json!({"objects":[audio]})).await;
                let route = &track["objects"][0]["fields"]["props"]["mixer"];
                assert_eq!(if reference == "output" { &route["output"] } else { &route["sends"][0]["target"] }, &json!(submix), "{reference}: {track}");
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn numeric_model_limits_are_declared_and_enforced() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let audio = sequence["audio"][0]["id"].clone();
    let described = f.ok("query", json!({"describe": "*"})).await;
    for (ty, field, min, max) in [("Track", "volumeDb", -96, 15), ("Track", "pan", -100, 100), ("Sequence", "masterVolumeDb", -96, 15)] {
        let schema = &described["describe"]["types"][ty]["fields"][field];
        assert_eq!((schema["minimum"].clone(), schema["maximum"].clone()), (json!(min), json!(max)), "{ty}.{field}: {schema}");
    }
    for (field, bad, good) in [("volumeDb", 16, -12), ("pan", -101, 40)] {
        let before = std::fs::read(f.file()).unwrap();
        f.refused("batch", json!({"ops": [{"op": "set", "target": audio, "field": field, "value": bad}]})).await;
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.ok("batch", json!({"ops": [{"op": "set", "target": audio, "field": field, "value": good}]})).await;
        let read = f.ok("query", json!({"objects": [audio]})).await;
        assert_eq!(read["objects"][0]["fields"][field], good);
    }
    f.refused("batch", json!({"ops": [{"op": "set", "target": v1(&sequence)[0], "field": "speed", "value": -1}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::excessive_precision, reason = "Match the higher-precision batch input and assert its f32 storage rounding.")]
async fn batch_color_receipt_reports_stored_precision() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[0];
    f.ok("run", json!({"steps": [{"command": "effect.apply", "params": {"clips": [clip], "effect": "tint"}}]})).await;
    let (sequence, _) = f.inspect().await;
    let slot = sequence["video"][0]["items"][0]["effects"].as_array().unwrap().iter().position(|effect| effect["effect"] == "tint").unwrap();
    let path = format!("effects.{slot}.params.black.value.Color");
    let ran = f
        .ok(
            "batch",
            json!({"changes": "all", "ops": [{"op": "set", "target": clip,
        "field": path, "value": [0.123456789, 0.2, 0.3, 1.0]}]}),
        )
        .await;
    let edits = entry(&ran["changes"]["changed"], &clip.to_string())["edits"].as_array().unwrap();
    // The receipt tells the parameter's value at `black.value` or at a leaf inside it: the
    // colour's first channel, read at the path that is left.
    let told = format!("effects.{slot}.params.black.value");
    let edit = edits.iter().find(|edit| edit["field"].as_str().unwrap().starts_with(&told)).unwrap_or_else(|| panic!("{ran}"));
    let inside: Vec<&str> =
        ["Color", "0"].into_iter().skip(edit["field"].as_str().unwrap()[told.len()..].split('.').filter(|part| !part.is_empty()).count()).collect();
    let after = inside.iter().fold(&edit["after"], |at, key| key.parse::<usize>().map_or(&at[*key], |index| &at[index]));
    let disk = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
    let clip = &disk.project.sequence(kition_film_project::ItemId(sequence["id"].as_u64().unwrap())).unwrap().video_tracks[0].items[0];
    let stored =
        serde_json::to_value(clip.effects.iter().find(|effect| effect.effect == "tint").unwrap().params["black"].value.as_color().unwrap()[0]).unwrap();
    assert_eq!(*after, stored, "{ran}");
    assert_eq!(*after, serde_json::to_value(0.123456789_f32).unwrap());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mixer_ordinals_cannot_retarget_after_deleting_a_strip() {
    let f = Fixture::new(2);
    let made = f.colleague(&[("mixer.addSubmix", json!({"name": "First"})), ("mixer.addSubmix", json!({"name": "Second"}))]);
    let (_, basis) = f.inspect().await;
    f.colleague(&[("mixer.deleteSubmix", json!({"strip": made[0]["id"]}))]);
    let answer = f.refused("run", json!({"basis": basis, "steps": [{"command": "mixer.setStrip", "params": {"strip": "S1", "pan": 10}}]})).await;
    assert_conflict(&answer, &made[1]["id"].as_u64().unwrap().to_string(), "relocated");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn search_bins_hold_the_json_entry_the_command_resolves() {
    for changed in [true, false] {
        let f = Fixture::new(2);
        let made = f.colleague(&[("bin.addSearch", json!({"text": "Color", "name": "Mine"})), ("bin.addSearch", json!({"text": "Other"}))]);
        let bin = made[0]["bin"].as_u64().unwrap();
        let (_, basis) = f.inspect().await;
        f.colleague(&[("project.editSearchBin", json!({"bin": made[usize::from(!changed)]["bin"], "name": "Theirs"}))]);
        let answer = f.call("run", json!({"basis": basis, "steps": [{"command": "project.editSearchBin", "params": {"bin": bin, "name": "New name"}}]})).await;
        if changed {
            assert_conflict(&answer.expect_err("search bin changed"), "project", "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn batch_effect_numbers_obey_the_engines_hard_limits() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[0];
    let before = std::fs::read(f.file()).unwrap();
    f.refused("batch", json!({"ops": [{"op": "set", "target": clip, "field": "effects.1.params.opacity.value.Float", "value": 101}]})).await;
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_text_survives_an_unrelated_whole_list_edit() {
    for changed in [true, false] {
        let f = Fixture::new(2);
        let made = f.colleague(&[("caption.add", json!({"text": "Mine", "seconds": 1})), ("caption.add", json!({"text": "Other", "seconds": 5}))]);
        let caption = made[0]["caption"].as_u64().unwrap();
        let (sequence, basis) = f.inspect().await;
        rewrite(&f.file(), |project| {
            let seq = project.sequence_mut(kition_film_project::ItemId(sequence["id"].as_u64().unwrap())).unwrap();
            seq.caption_tracks[0].captions[usize::from(!changed)].text = "Theirs".to_owned();
        });
        let answer =
            f.call("run", json!({"basis": basis, "steps": [{"command": "caption.setText", "params": {"caption": caption, "text": "New text"}}]})).await;
        if changed {
            assert_conflict(&answer.expect_err("target caption changed"), &sequence["id"].as_u64().unwrap().to_string(), "changed");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_text_follows_its_track_after_deleting_an_earlier_track() {
    let f = Fixture::new(2);
    let made = f.colleague(&[("caption.newTrack", json!({"name": "First"})), ("caption.newTrack", json!({"name": "Second"}))]);
    let caption = f.colleague(&[("caption.add", json!({"track": made[1]["track"], "seconds": 1, "text": "Mine"}))])[0]["caption"].clone();
    let (_, basis) = f.inspect().await;
    f.colleague(&[("caption.deleteTrack", json!({"track": made[0]["track"]}))]);
    f.ok("run", json!({"basis": basis, "steps": [{"command": "caption.setText", "params": {"caption": caption, "text": "New text"}}]})).await;
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sdk_replacement_diagnostic_reproduction() {
    let f = Fixture::new(12);
    let (sequence, basis) = f.inspect().await;
    let item = sequence["video"][0]["items"][0]["item"].clone();
    f.colleague(&[("timeline.place", json!({"item": item, "track": "V1", "seconds": 10}))]);
    let answer = f
        .refused(
            "run",
            json!({"basis": basis, "steps": [{"command": "clip.automateToSequence", "params": {"items": [item], "method": "overwrite"}, "at": {"time": 10}}]}),
        )
        .await;
    // A replacement has its own identity. It is never an in-place clipId edit.
    let removed = v1(&sequence)[10];
    assert!(ids(&answer["others"]["deleted"]).contains(&removed.to_string()), "{answer}");
    assert!(!ids(&answer["others"]["created"]).is_empty(), "{answer}");
    assert!(
        !answer["others"]["changed"].as_array().unwrap().iter().any(|change| change["edits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edit| edit["field"] == "clipId" && edit["before"] != edit["after"])),
        "{answer}"
    );
    assert_eq!(answer["error"]["code"], "conflict", "{answer}");
    assert!(answer["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "relocated"), "{answer}");
    println!("SDK replacement diagnostic reproduction: {answer}");
    f.shutdown().await;
}
