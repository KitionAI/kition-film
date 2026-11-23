//! What a call needs of what it acts on (task card C8-time-3, kition-sdk C8-fix-7
//! `Under::premises`, film's `kition_film_engine::premise`): for each command family whose premise
//! the kit narrows, a colleague's change inside the premise refuses the agent's write with `basis`,
//! and one outside it does not. The fixture is `outside.rs`'s: one-second colour mattes end to end
//! on V1, and a colleague's program that edits the `.kfilm` file directly.
//!
//! Tests whose names say `wrongly` pin an outcome that is wrong today (what is wanted is in their
//! comment), so that fixing it fails them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use serde_json::{Value, json};

const CLIPS: usize = 8;

/// The colleague's ripple insert of a one-second clip at 0 s on V1: every clip after it moves.
fn ripple_insert(sequence: &Value) -> (&'static str, Value) {
    ("timeline.place", json!({ "item": sequence["video"][0]["items"][0]["item"], "track": "V1", "seconds": 0, "insert": true }))
}

/// Clip `id` as a new engine reads the file.
fn clip_on_disk(file: &std::path::Path, id: u64) -> Value {
    let doc = <kition_film_kit::FilmDocument as kition_kit::KitDocument>::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let seen = kition_kit::KitDocument::inspect(&doc).unwrap();
    seen["sequence"]["video"][0]["items"].as_array().unwrap().iter().find(|clip| clip["clip"] == id).cloned().unwrap_or_else(|| panic!("no clip {id}"))
}

/// The opacity parameter of clip `id` on disk, keyframes and all.
fn opacity_param(file: &std::path::Path, id: u64) -> Value {
    let clip = clip_on_disk(file, id);
    clip["effects"].as_array().unwrap().iter().find(|effect| effect["effect"] == "opacity").unwrap()["params"]["opacity"].clone()
}

/// The source time of the first keyframe of clip `id`'s opacity, as the file stores it (the
/// `mediaTime` the keyframe commands take).
fn first_key(file: &std::path::Path, id: u64) -> i64 {
    let loaded = kition_film_format::decode(&std::fs::read(file).unwrap()).unwrap();
    let found =
        loaded.project.sequences().find_map(|item| loaded.project.sequence(item.id)?.find_item(kition_film_project::ClipId(id)).map(|(_, clip)| clip.clone()));
    let clip = found.unwrap_or_else(|| panic!("no clip {id}"));
    let opacity = clip.effects.iter().find(|effect| effect.effect == "opacity").unwrap();
    opacity.params["opacity"].keyframes[0].time.0
}

/// A colleague's change outside the open sequence: another project item renamed.
fn rename_another_item(sequence: &Value) -> (&'static str, Value) {
    ("clip.rename", json!({ "item": sequence["video"][0]["items"][7]["item"], "name": "Elsewhere" }))
}

/// The sequence's markers as a new engine reads the file: (id, name).
fn markers_on_disk(file: &std::path::Path) -> Vec<(u64, String)> {
    let doc = <kition_film_kit::FilmDocument as kition_kit::KitDocument>::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let seen = kition_kit::KitDocument::inspect(&doc).unwrap();
    seen["sequence"]["markers"]
        .as_array()
        .unwrap_or_else(|| panic!("markers: {}", seen["sequence"]))
        .iter()
        .map(|marker| (marker["id"].as_u64().unwrap(), marker["name"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// `effects.setParam` by clip id with no time, on a clip with no keyframe, needs the clip's effects
/// and no position (`s3a` in `outside.rs`: a ripple insert before it applies). On a clip whose
/// opacity is animated it keys the value at the clip's source time under the playhead, which the
/// insert moved: refused as `relocated`. (The scratch recipe stated no position for both: applied.)
#[tokio::test(flavor = "multi_thread")]
async fn an_effect_parameter_by_id_on_an_animated_clip_after_a_ripple_insert_is_refused() {
    let f = Fixture::new(CLIPS);
    let (sequence, _) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[("effects.setParam", json!({ "clip": mine, "effect": "opacity", "param": "opacity", "value": 80, "seconds": 2.5 }))]);
    let (sequence, basis) = f.inspect().await;
    f.colleague(&[ripple_insert(&sequence)]);
    let before = std::fs::read(f.file()).unwrap();
    let refused = f.refused("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_conflict(&refused, &mine.to_string(), "relocated");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    f.shutdown().await;
}

/// Inside the premise: the colleague changes another parameter of the target's effects (its
/// blend mode is no opacity, but `effects` is the premise): refused as `changed`.
#[tokio::test(flavor = "multi_thread")]
async fn an_effect_parameter_by_id_after_a_change_of_its_effects_is_refused() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[opacity(mine, 30.0)]);
    let refused = f.refused("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_conflict(&refused, &mine.to_string(), "changed");
    assert_eq!(opacity_on_disk(&f.file(), mine), 30.0, "the colleague's value kept");
    f.shutdown().await;
}

/// A keyframe edit by `mediaTime` needs the clip's effects and no position: after a ripple insert
/// before the clip it applies (the key is found by its source time); after the colleague changed
/// the clip's opacity keys it is refused as `changed`.
#[tokio::test(flavor = "multi_thread")]
async fn a_keyframe_edit_by_media_time_applies_after_a_move_and_is_refused_after_a_change_of_the_keys() {
    for change in ["ripple insert", "their key"] {
        let f = Fixture::new(CLIPS);
        let (sequence, _) = f.inspect().await;
        let mine = v1(&sequence)[2];
        f.colleague(&[("effects.setParam", json!({ "clip": mine, "effect": "opacity", "param": "opacity", "value": 80, "seconds": 2.5 }))]);
        let key = first_key(&f.file(), mine);
        let (sequence, basis) = f.inspect().await;
        let theirs = match change {
            "ripple insert" => ripple_insert(&sequence),
            _ => ("effects.setParam", json!({ "clip": mine, "effect": "opacity", "param": "opacity", "value": 10, "seconds": 2.75 })),
        };
        f.colleague(&[theirs]);
        let step =
            json!({ "command": "effects.setKeyframe", "params": { "clip": mine, "effect": "opacity", "param": "opacity", "mediaTime": key, "value": 40 } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        match change {
            "ripple insert" => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
                assert_eq!(opacity_param(&f.file(), mine)["keyframes"][0]["value"], json!(40.0), "{change}");
            }
            _ => {
                let refused = answer.expect_err(change);
                assert_conflict(&refused, &mine.to_string(), "changed");
            }
        }
        f.shutdown().await;
    }
}

/// `clip.enable` needs each clip's enabled switch and `link`, and its linked clips' too, and no
/// position. Outside: the colleague changes the clip's opacity or moves it (a ripple insert):
/// applied. Inside: the colleague links another clip to it (which `clip.enable` would switch too,
/// and whose state decides on or off): refused as `changed`.
#[tokio::test(flavor = "multi_thread")]
async fn enabling_a_clip_needs_its_switch_and_its_links_alone() {
    for change in ["opacity", "ripple insert", "link"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        let mine = clips[2];
        let theirs = match change {
            "opacity" => opacity(mine, 30.0),
            "ripple insert" => ripple_insert(&sequence),
            _ => ("clip.link", json!({ "clips": [mine, clips[5]] })),
        };
        f.colleague(&[theirs]);
        let answer = f.call("run", json!({ "basis": basis, "steps": [{ "command": "clip.enable", "on": [mine] }] })).await;
        match change {
            "link" => {
                let refused = answer.expect_err(change);
                assert_conflict(&refused, &mine.to_string(), "changed");
            }
            _ => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
                assert_eq!(clip_on_disk(&f.file(), mine)["enabled"], false, "{change}");
            }
        }
        f.shutdown().await;
    }
}

/// `clip.rename` needs the clip's name alone: after the colleague's opacity change it applies,
/// after the colleague renamed it it is refused as `changed`.
#[tokio::test(flavor = "multi_thread")]
async fn renaming_a_clip_needs_its_name_alone() {
    for change in ["opacity", "rename"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let mine = v1(&sequence)[2];
        let theirs = match change {
            "opacity" => opacity(mine, 30.0),
            _ => ("clip.rename", json!({ "clip": mine, "name": "Theirs" })),
        };
        f.colleague(&[theirs]);
        let step = json!({ "command": "clip.rename", "params": { "clip": mine, "name": "Mine" } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        match change {
            "rename" => {
                assert_conflict(&answer.expect_err(change), &mine.to_string(), "changed");
            }
            _ => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
                assert_eq!(clip_on_disk(&f.file(), mine)["name"], "Mine", "{change}");
            }
        }
        f.shutdown().await;
    }
}

/// C8-film-read: move_captions (edit/src/captions.rs:177-219) consumes caption
/// timing and lock eligibility. Another caption's text is preserved independently.
/// A change to unrelated text does not conflict: the move applies with exact movement and
/// preserves the colleague's content.
#[tokio::test(flavor = "multi_thread")]
async fn moving_a_caption_needs_the_caption_tracks() {
    for change in ["another caption", "another project item"] {
        let f = Fixture::new(CLIPS);
        let made = f.colleague(&[("captions.add", json!({ "text": "first", "seconds": 1 })), ("captions.add", json!({ "text": "second", "seconds": 6 }))]);
        let (mine, other) = (made[0]["caption"].as_u64().unwrap(), made[1]["caption"].as_u64().unwrap());
        let (sequence, basis) = f.inspect().await;
        let item = sequence["id"].as_u64().unwrap();
        let theirs = match change {
            "another caption" => ("captions.setText", json!({ "caption": other, "text": "theirs" })),
            _ => rename_another_item(&sequence),
        };
        f.colleague(&[theirs]);
        let before = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
        let before_sequence = before.project.sequence(kition_film_project::ItemId(item)).unwrap();
        let mut expected_mine = before_sequence.find_caption(kition_film_project::ClipId(mine)).unwrap().1.clone();
        expected_mine.start += before_sequence.settings.frame_rate.tick_of(2);
        let expected_other = before_sequence.find_caption(kition_film_project::ClipId(other)).unwrap().1.clone();
        let step = json!({ "command": "captions.move", "params": { "captions": [mine], "deltaFrames": 2 } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        answer.unwrap_or_else(|error| panic!("{change}: {error}"));
        let after = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
        let after_sequence = after.project.sequence(kition_film_project::ItemId(item)).unwrap();
        assert_eq!(after_sequence.find_caption(kition_film_project::ClipId(mine)).unwrap().1, &expected_mine, "{change}: exact two-frame move");
        assert_eq!(after_sequence.find_caption(kition_film_project::ClipId(other)).unwrap().1, &expected_other, "{change}: colleague's caption preserved");
        f.shutdown().await;
    }
}

/// A marker has no tool id: `markers.edit` needs its marker in the sequence's item
/// (`sequence.markers.<i>`). After the colleague renamed that marker it is refused as `changed`,
/// their name kept; after the colleague renamed another marker it applies. (Before: no premise,
/// the colleague's name overwritten. A caption had this protection from the scratch recipe; a
/// marker now has it too.)
#[tokio::test(flavor = "multi_thread")]
async fn editing_a_marker_needs_that_marker() {
    for change in ["that marker", "another marker"] {
        let f = Fixture::new(CLIPS);
        let made = f.colleague(&[("markers.add", json!({ "seconds": 1 })), ("markers.add", json!({ "seconds": 5 }))]);
        let (mine, other) = (made[0]["marker"].as_u64().unwrap_or_else(|| panic!("{made:?}")), made[1]["marker"].as_u64().unwrap());
        let (sequence, basis) = f.inspect().await;
        let item = sequence["id"].as_u64().unwrap();
        let named = if change == "that marker" { mine } else { other };
        f.colleague(&[("markers.edit", json!({ "marker": named, "name": "Theirs" }))]);
        let step = json!({ "command": "markers.edit", "params": { "marker": mine, "name": "Mine" } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        let names = |file: &std::path::Path| markers_on_disk(file).into_iter().find(|(id, _)| *id == mine).map(|(_, name)| name);
        match change {
            "that marker" => {
                assert_conflict(&answer.expect_err(change), &item.to_string(), "changed");
                assert_eq!(names(&f.file()).as_deref(), Some("Theirs"));
            }
            _ => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
                assert_eq!(names(&f.file()).as_deref(), Some("Mine"));
            }
        }
        f.shutdown().await;
    }
}

/// Add Edit to All Tracks also splits the captions under its time: after the colleague added a
/// caption there it is refused as `changed` on the sequence's item; after the colleague renamed
/// another project item it applies.
#[tokio::test(flavor = "multi_thread")]
async fn add_edit_to_all_tracks_needs_the_captions() {
    for change in ["caption there", "another project item"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let item = sequence["id"].as_u64().unwrap();
        let theirs = match change {
            "caption there" => ("captions.add", json!({ "text": "theirs", "seconds": 2 })),
            _ => rename_another_item(&sequence),
        };
        f.colleague(&[theirs]);
        let step = json!({ "command": "sequence.addEditAllTracks", "at": { "time": 2.5 } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        match change {
            "caption there" => {
                assert_conflict(&answer.expect_err(change), &item.to_string(), "changed");
            }
            _ => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
            }
        }
        f.shutdown().await;
    }
}

/// Place Clip with `snap: "markers"` lands on the nearest marker within the tolerance (3 frames):
/// its place is every time it may land on, and the markers are a premise. After the colleague
/// added a marker a frame from the time asked for, it is refused as `changed`; after one far from
/// it too (an added marker is a change of the whole `sequence.markers` list, so the premise cannot
/// be narrowed to the markers near the time); after the colleague renamed another project item,
/// or changed another part of the same sequence (a caption far from the time), it applies.
#[tokio::test(flavor = "multi_thread")]
async fn place_clip_with_snap_needs_the_markers_near_its_time() {
    for change in ["marker near", "marker far", "another project item", "caption elsewhere"] {
        let f = Fixture::new(CLIPS);
        let (sequence, _) = f.inspect().await;
        f.colleague(&[("markers.add", json!({ "seconds": 15 }))]);
        let (_, basis) = f.inspect().await;
        let item = sequence["id"].as_u64().unwrap();
        f.colleague(&[match change {
            "marker near" => ("markers.add", json!({ "seconds": 10.0 + 1.0 / 30.0 })),
            "marker far" => ("markers.add", json!({ "seconds": 15.5 })),
            "caption elsewhere" => ("captions.add", json!({ "text": "theirs", "seconds": 2 })),
            _ => rename_another_item(&sequence),
        }]);
        let step = json!({ "command": "timeline.place", "params": { "item": sequence["video"][0]["items"][1]["item"], "track": "V1", "seconds": 10, "snap": "markers" } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        match change {
            "marker near" | "marker far" => {
                assert_conflict(&answer.expect_err(change), &item.to_string(), "changed");
            }
            _ => {
                answer.unwrap_or_else(|error| panic!("{change}: {error}"));
            }
        }
        f.shutdown().await;
    }
}

/// Place Clip's project item is a premise of its own (a whole number in `item`, every field):
/// after the colleague renamed the item it places, refused as `changed`.
#[tokio::test(flavor = "multi_thread")]
async fn place_clip_after_a_change_of_its_project_item_is_refused() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let item = sequence["video"][0]["items"][1]["item"].as_u64().unwrap();
    f.colleague(&[("clip.rename", json!({ "item": item, "name": "Theirs" }))]);
    let step = json!({ "command": "timeline.place", "params": { "item": item, "track": "V1", "seconds": 10 } });
    let refused = f.refused("run", json!({ "basis": basis, "steps": [step] })).await;
    assert_conflict(&refused, &item.to_string(), "changed");
    f.shutdown().await;
}

/// Automate to Sequence names its project items (`items`, its target parameter) and writes at the
/// playhead (`at.time`): since kition-sdk C8-fix-9 a step's time is a place also when it gives its
/// targets. The colleague places a clip at the playhead on V1; the agent's overwrite there with
/// `basis` is refused as `relocated` on that clip, and nothing is written. (Before: applied over it.)
#[tokio::test(flavor = "multi_thread")]
async fn automate_to_sequence_by_items_is_refused_after_a_clip_was_put_at_its_time() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let item = sequence["video"][0]["items"][1]["item"].as_u64().unwrap();
    f.colleague(&[("timeline.place", json!({ "item": sequence["video"][0]["items"][2]["item"], "track": "V1", "seconds": 10 }))]);
    let theirs = v1_on_disk(&f.file()).into_iter().find(|(_, start, _)| *start == 10 * SECOND).unwrap().0;
    let step = json!({ "command": "clip.automateToSequence", "params": { "items": [item], "method": "overwrite" }, "at": { "time": 10 } });
    let before = std::fs::read(f.file()).unwrap();
    let refused = f.refused("run", json!({ "basis": basis, "steps": [step] })).await;
    assert_conflict(&refused, &theirs.to_string(), "relocated");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    assert!(v1_on_disk(&f.file()).iter().any(|(id, _, _)| *id == theirs), "the colleague's clip kept");
    f.shutdown().await;
}

/// A caption's text and a marker are held by their ids (`…captions[id=…]`, `sequence.markers[id=…]`,
/// kition-sdk C8-fix-9 selectors), not by their index, which others' saves shift. The agent edits
/// the caption at 5 s (or the marker at 5 s) with `basis`:
/// - the colleague adds one at 1 s, before it (it moves from index 0 to 1, unchanged): applied;
/// - the colleague changes it, then in a second save adds one at 1 s: refused as `changed`, the
///   colleague's text or name kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_caption_or_marker_is_held_by_its_id_across_others_saves() {
    for write in ["caption", "marker"] {
        for change in ["one added before it", "it changed, then one added before it"] {
            let f = Fixture::new(CLIPS);
            let add = |seconds: i64| match write {
                "caption" => ("captions.add", json!({ "text": "added", "seconds": seconds })),
                _ => ("markers.add", json!({ "seconds": seconds })),
            };
            let made = f.colleague(&[add(5)]);
            let mine = made[0][write].as_u64().unwrap_or_else(|| panic!("{made:?}"));
            let (sequence, basis) = f.inspect().await;
            let item = sequence["id"].as_u64().unwrap();
            if change.starts_with("it changed") {
                f.colleague(&[match write {
                    "caption" => ("captions.setText", json!({ "caption": mine, "text": "Theirs" })),
                    _ => ("markers.edit", json!({ "marker": mine, "name": "Theirs" })),
                }]);
            }
            f.colleague(&[add(1)]);
            let step = match write {
                "caption" => json!({ "command": "captions.setText", "params": { "caption": mine, "text": "Mine" } }),
                _ => json!({ "command": "markers.edit", "params": { "marker": mine, "name": "Mine" } }),
            };
            let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
            // The sequence (its markers) and its captions as a new engine lists them.
            let doc = |file: &std::path::Path| {
                let mut doc = <kition_film_kit::FilmDocument as kition_kit::KitDocument>::open(FILE, &std::fs::read(file).unwrap()).unwrap();
                let captions = kition_kit::KitDocument::execute(&mut doc, "captions.list", json!({})).unwrap();
                format!("{} {captions}", kition_kit::KitDocument::inspect(&doc).unwrap())
            };
            if change.starts_with("it changed") {
                let refused = answer.unwrap_err();
                assert_conflict(&refused, &item.to_string(), "changed");
                let now = doc(&f.file());
                assert!(now.contains("Theirs") && !now.contains("Mine"), "{write}, {change}: the colleague's kept");
            } else {
                answer.unwrap_or_else(|error| panic!("{write}, {change}: {error}"));
                assert!(doc(&f.file()).contains("Mine"), "{write}, {change}: written");
            }
            f.shutdown().await;
        }
    }
}

/// Automate to Sequence's overwrite holds the time it covers, not more nor less: its items one
/// after another from the playhead, or one at each unnumbered marker. A clip the colleague put
/// after what a sequential overwrite at 10 s covers (at 30 s) refuses nothing; a clip put at an
/// unnumbered marker (12 s) refuses an overwrite at the markers as `relocated`, though the
/// playhead is elsewhere.
#[tokio::test(flavor = "multi_thread")]
async fn automate_to_sequence_holds_the_time_its_overwrite_covers() {
    for case in ["sequentially, a clip after", "at markers, a clip at one"] {
        let f = Fixture::new(CLIPS);
        if case.starts_with("at markers") {
            f.colleague(&[("markers.add", json!({ "seconds": 12 }))]);
        }
        let (sequence, basis) = f.inspect().await;
        let item = sequence["video"][0]["items"][1]["item"].as_u64().unwrap();
        let seconds = if case.starts_with("at markers") { 12 } else { 30 };
        f.colleague(&[("timeline.place", json!({ "item": sequence["video"][0]["items"][2]["item"], "track": "V1", "seconds": seconds }))]);
        let theirs = v1_on_disk(&f.file()).into_iter().find(|(_, start, _)| *start == seconds * SECOND).unwrap().0;
        if case.starts_with("sequentially") {
            let step = json!({ "command": "clip.automateToSequence", "params": { "items": [item], "method": "overwrite" }, "at": { "time": 10 } });
            f.ok("run", json!({ "basis": basis, "steps": [step] })).await;
        } else {
            let step = json!({ "command": "clip.automateToSequence", "params": { "items": [item], "method": "overwrite", "placement": "unnumberedMarkers" }, "at": { "time": 0 } });
            let refused = f.refused("run", json!({ "basis": basis, "steps": [step] })).await;
            assert_conflict(&refused, &theirs.to_string(), "relocated");
        }
        assert!(v1_on_disk(&f.file()).iter().any(|(id, _, _)| *id == theirs), "{case}: the colleague's clip kept");
        f.shutdown().await;
    }
}

/// Automate to Sequence's default `sort` ordering places its items in the bins' order
/// (project_tools.rs:1134-1138): that order is its premise, not the bins' items. After the
/// colleague moved the first of its items into a new bin (after the second), refused as `changed`
/// on that item; after the colleague moved an item it does not place, which lists after both, it
/// applies.
#[tokio::test(flavor = "multi_thread")]
async fn automate_by_sort_holds_the_order_of_its_items_alone() {
    for change in ["its item moved", "another item moved"] {
        let f = Fixture::new(CLIPS);
        let made = f.colleague(&[("file.newBin", json!({ "name": "Later" }))]);
        let bin = made[0]["bin"].as_u64().unwrap();
        let (sequence, basis) = f.inspect().await;
        let items = sequence["video"][0]["items"].as_array().unwrap();
        let (first, second, last) = (items[1]["item"].as_u64().unwrap(), items[2]["item"].as_u64().unwrap(), items[7]["item"].as_u64().unwrap());
        let moved = if change == "its item moved" { first } else { last };
        f.colleague(&[("project.moveToBin", json!({ "items": [moved], "bin": bin }))]);
        let step = json!({ "command": "clip.automateToSequence", "params": { "items": [second, first], "method": "overwrite", "videoTransition": false, "audioTransition": false } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        if change == "its item moved" {
            assert_conflict(&answer.expect_err(change), &first.to_string(), "changed");
        } else {
            answer.unwrap_or_else(|error| panic!("{change}: {error}"));
        }
        f.shutdown().await;
    }
}

/// Apply Video Transition at a time finds its cut on the first targeted lane with a clip edge
/// near the time (commands.rs `transition_point`): of the lane order it reads only that no lane
/// with a cut there now comes first. After the colleague added an empty lane above, it applies;
/// after a lane above with a clip starting at that time, it is refused: that clip is now at its
/// place (`relocated`).
#[tokio::test(flavor = "multi_thread")]
async fn transition_at_a_time_holds_the_lanes_before_its_cut_not_the_lane_order() {
    for change in ["empty lane above", "lane above with a cut there"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let id = kition_film_project::ItemId(sequence["id"].as_u64().unwrap());
        let mut theirs = 0;
        rewrite(&f.file(), |p| {
            let fresh = kition_film_project::TrackId(p.alloc_id());
            let clip_id = kition_film_project::ClipId(p.alloc_id());
            theirs = clip_id.0;
            let q = p.sequence_mut(id).unwrap();
            let mut lane = q.video_tracks[0].clone();
            lane.id = fresh;
            lane.transitions.clear();
            let mut clip = lane.items[4].clone();
            lane.items.clear();
            if change != "empty lane above" {
                clip.id = clip_id;
                clip.link = None;
                lane.items.push(clip);
            }
            q.video_tracks.insert(0, lane);
        });
        let step = json!({ "command": "sequence.applyVideoTransition", "at": { "time": 4 }, "params": { "frames": 6 } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [step] })).await;
        if change == "empty lane above" {
            answer.unwrap_or_else(|error| panic!("{change}: {error}"));
        } else {
            assert_conflict(&answer.expect_err(change), &theirs.to_string(), "relocated");
        }
        f.shutdown().await;
    }
}

/// A caption or a marker has no tool id, so its premise is a path in the sequence's item, naming it
/// by its id (`sequence.captions[id=…]`, `sequence.markers[id=…]`). The
/// colleague changes a clip's opacity (no caption, no marker), and the agent edits a caption's
/// text or a marker's name with `basis`: applied (kition-sdk C8-fix-9 holds a clip at its path
/// under the item; before, at `sequence`, and the write was refused as `changed`).
#[tokio::test(flavor = "multi_thread")]
async fn a_caption_or_marker_write_applies_after_a_change_of_a_clip() {
    for write in ["caption", "marker"] {
        let f = Fixture::new(CLIPS);
        let made = f.colleague(&[("captions.add", json!({ "text": "first", "seconds": 1 })), ("markers.add", json!({ "seconds": 5 }))]);
        let (caption, marker) = (made[0]["caption"].as_u64().unwrap(), made[1]["marker"].as_u64().unwrap());
        let (sequence, basis) = f.inspect().await;
        f.colleague(&[opacity(v1(&sequence)[6], 30.0)]);
        let step = match write {
            "caption" => json!({ "command": "captions.setText", "params": { "caption": caption, "text": "mine" } }),
            _ => json!({ "command": "markers.edit", "params": { "marker": marker, "name": "Mine" } }),
        };
        let ran = f.ok("run", json!({ "basis": basis, "steps": [step] })).await;
        println!("{write} after a clip change: applied, {}", ran["changes"]);
        f.shutdown().await;
    }
}
