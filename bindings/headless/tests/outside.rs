//! The premise guard and receipts when the `.kfilm` file itself changes (task card C8-film): a
//! colleague's program, an engine of this kit that shares nothing with the server under test,
//! opens the project, edits it and writes it back, so the server sees only a changed file. The
//! agent works through the kits' MCP server's tools (`kition_kits::tools::call_as`, the library
//! `kition-kits-mcp` serves) on the `kition-film` executable, holding the ids and the `revision`
//! of an inspect made before the colleague's edit.
//!
//! The project's sequence holds one-second colour mattes end to end on V1. A clip's `start` and
//! `duration` are its place in time (`"position": true` in the object model's schema): a ripple
//! that moves a clip is a move of it (`relocated`), not a change of its content, and the clips it
//! shifts are stated once in `others` (`footprint`). A write by id is refused for such a move
//! unless its command is declared position-independent (`clip.enable`, `clip.rename`,
//! `edit.label`). A write by place (a step with no clip id that acts at `at.time`, or at its own
//! `track` and time) has as premise the clips under that place (`context.under`, film's
//! `kition_film_engine::place`).
//!
//! Tests whose names say `wrongly` pin an outcome that is wrong today (what is wanted is in their
//! comment), so that fixing it fails them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::Instant;

use common::*;
use kition_kits::tools::{CallOptions, Guard};
use serde_json::{Value, json};

const CLIPS: usize = 8;

/// The colleague's ripple insert: a one-second clip of `item` at 0 s on V1, every clip after it
/// moved later.
fn ripple_insert_at_start(item: &Value) -> (&'static str, Value) {
    ("timeline.place", json!({ "item": item, "track": "V1", "seconds": 0, "insert": true }))
}

// ---- 1. An unrelated clip's property ----

/// The colleague changes another clip's opacity; the agent's write with `basis` applies, and
/// `others` names that clip alone, at the path to its opacity effect's parameters.
#[tokio::test(flavor = "multi_thread")]
async fn s1_a_colleagues_change_of_another_clip_applies_and_others_names_that_clip_alone() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let clips = v1(&sequence);
    let (mine, theirs) = (clips[2], clips[5]);
    f.colleague(&[opacity(theirs, 30.0)]);
    let ran = f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), [mine.to_string()], "{ran}");
    let others = &ran["others"];
    assert_eq!(others["by"], json!(["outside"]), "{ran}");
    assert_eq!(ids(&others["changed"]), [theirs.to_string()], "others names the colleague's clip alone: {others}");
    // kition-sdk C8-fix-6 (b0dbf77, past this kit's pin): a json value is told at its leaves.
    assert_eq!(entry(&others["changed"], &theirs.to_string())["fields"], json!(["effects.1.params.opacity.value.Float"]), "{others}");
    for list in ["created", "moved", "deleted"] {
        assert!(ids(&others[list]).is_empty(), "{others}");
    }
    assert!(others.get("unnamed").is_none_or(Value::is_null), "{others}");
    println!("s1: others for one unrelated opacity change: {} bytes: {others}", others.to_string().len());
    assert_eq!((opacity_on_disk(&f.file(), mine), opacity_on_disk(&f.file(), theirs)), (50.0, 30.0));
    f.shutdown().await;
}

// ---- 2. The target's same property ----

/// The colleague changes the target clip's opacity: the agent's write is refused as `changed` on
/// that clip and nothing is written; after inspecting again, the retry applies.
#[tokio::test(flavor = "multi_thread")]
async fn s2_a_colleagues_change_of_the_target_is_refused_as_changed_and_the_retry_applies() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[opacity(mine, 30.0)]);
    let before = std::fs::read(f.file()).unwrap();
    let refused = f.refused("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_conflict(&refused, &mine.to_string(), "changed");
    assert_eq!(ids(&refused["others"]["changed"]), [mine.to_string()], "{refused}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    println!("s2: refusal's others {} bytes", refused["others"].to_string().len());
    let (_, basis) = f.inspect().await;
    f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_eq!(opacity_on_disk(&f.file(), mine), 50.0);
    f.shutdown().await;
}

// ---- 3. A ripple insert before the target ----

/// The colleague ripple-inserts a clip at the start of V1: the target keeps its id and moves one
/// second later, at index 3 of V1's clips where it was at 2. C8-fix-7: the kit states that
/// `effect.setParam` by clip id with no time needs the clip's effects and no position, so setting
/// its opacity applies, `others` saying the insert (one created clip, the shift in a footprint);
/// a write that depends on where it is stays refused (s3e). (C8-film pinned it refused as
/// `relocated`.)
#[tokio::test(flavor = "multi_thread")]
async fn s3a_a_ripple_insert_before_the_target_does_not_refuse_an_effect_parameter_by_id() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[ripple_insert_at_start(&sequence["video"][0]["items"][0]["item"])]);
    let ran = f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    let others = &ran["others"];
    assert_eq!(others["created"].as_array().map(Vec::len), Some(1), "{others}");
    assert_eq!(opacity_on_disk(&f.file(), mine), 50.0);
    println!("s3a: applied; others {} bytes: {others}", others.to_string().len());
    f.shutdown().await;
}

/// The same ripple insert, and a write naming the target by its time: the agent selects the clip
/// at 2.5 s on the targeted tracks (`timeline.selectClipAtPlayhead` at `at.time` 2.5, where its
/// inspect showed the target) and disables the selection (`clip.enable`). The place is a premise
/// (kition-sdk C8-fix-5, `context.under`): the clip under 2.5 s is not the one there at `basis`, so
/// the write is refused as `relocated`, naming the clip under the place now and where the target
/// went, and nothing is written.
#[tokio::test(flavor = "multi_thread")]
async fn s3b_a_write_by_time_after_a_ripple_insert_is_refused_as_relocated() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let clips = v1(&sequence);
    let (mine, earlier) = (clips[2], clips[1]);
    f.colleague(&[ripple_insert_at_start(&sequence["video"][0]["items"][0]["item"])]);
    let before = std::fs::read(f.file()).unwrap();
    let steps = json!([
        { "command": "timeline.selectClipAtPlayhead", "at": { "time": 2.5 } },
        { "command": "clip.enable" },
    ]);
    let refused = f.refused("run", json!({ "basis": basis, "steps": steps })).await;
    let entered = assert_conflict(&refused, &earlier.to_string(), "relocated");
    assert_eq!(entered["place"]["under"], json!([earlier]), "{refused}");
    let left = assert_conflict(&refused, &mine.to_string(), "relocated");
    assert_eq!(left["now"]["index"], 3, "{refused}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    println!("s3b: refused, conflicts {}", refused["conflicts"]);
    f.shutdown().await;
}

/// The same with track and time in the step's parameters: a razor cut on V1 at 2.5 s (`track`,
/// `at.time`). Refused as `relocated`, nothing written.
#[tokio::test(flavor = "multi_thread")]
async fn s3c_a_cut_by_track_and_time_after_a_ripple_insert_is_refused_as_relocated() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[ripple_insert_at_start(&sequence["video"][0]["items"][0]["item"])]);
    let before = std::fs::read(f.file()).unwrap();
    let earlier = v1(&sequence)[1];
    let refused =
        f.refused("run", json!({ "basis": basis, "steps": [{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": 2.5 } }] })).await;
    let entered = assert_conflict(&refused, &earlier.to_string(), "relocated");
    assert_eq!(entered["place"]["under"], json!([earlier]), "the clip under V1 at 2.5 s now: {refused}");
    assert_eq!(entered["place"]["track"], "V1", "{refused}");
    let left = assert_conflict(&refused, &mine.to_string(), "relocated");
    let start = v1_on_disk(&f.file())[3].1;
    assert_eq!((left["now"]["index"].clone(), left["now"]["start"].clone()), (json!(3), json!(start.to_string())), "where the clip seen there went: {refused}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    f.shutdown().await;
}

/// A cut by track and time after changes elsewhere applies: the colleague ripple-deletes a clip
/// later on V1, or changes another clip's opacity.
#[tokio::test(flavor = "multi_thread")]
async fn s3d_a_cut_by_track_and_time_after_a_change_elsewhere_applies() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let clips = v1(&sequence);
    f.colleague(&[("edit.rippleDelete", json!({ "clips": [clips[5]] }))]);
    let ran = f.ok("run", json!({ "basis": basis, "steps": [{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": 2.5 } }] })).await;
    assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(clips[2]), "{ran}");
    let basis = revision(&ran);
    f.colleague(&[opacity(clips[6], 20.0)]);
    let ran = f.ok("run", json!({ "basis": basis, "steps": [{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": 1.5 } }] })).await;
    assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(clips[1]), "{ran}");
    f.shutdown().await;
}

/// The same ripple insert, and writes naming the target by id: one whose command does not depend
/// on where the clip is (`clip.enable`, declared position-independent) applies, and `others` says
/// the target moved, in one footprint with the clips after it; one that depends on it (a cut of
/// that clip at a time, `timeline.razor` with `clip`) is refused as `relocated` with where it is.
#[tokio::test(flavor = "multi_thread")]
async fn s3e_a_ripple_insert_before_the_target_refuses_only_a_write_by_id_that_depends_on_its_place() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[ripple_insert_at_start(&sequence["video"][0]["items"][0]["item"])]);
    let before = std::fs::read(f.file()).unwrap();
    let cut = json!({ "command": "timeline.razor", "params": { "clip": mine, "seconds": 2.5 } });
    let refused = f.refused("run", json!({ "basis": basis, "steps": [cut] })).await;
    let conflict = assert_conflict(&refused, &mine.to_string(), "relocated");
    assert_eq!(conflict["now"]["index"], 3, "{refused}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    let ran = f.ok("run", json!({ "basis": basis, "steps": [{ "command": "clip.enable", "on": [mine] }] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), [mine.to_string()], "{ran}");
    let others = &ran["others"];
    assert_eq!(others["created"].as_array().map(Vec::len), Some(1), "{others}");
    let print = &others["footprint"][0];
    assert_eq!(
        (print["field"].clone(), print["from"].clone(), print["count"].clone(), print["shift"].clone()),
        (json!("clips"), json!(1), json!(CLIPS), json!({ "field": "start", "by": v1_on_disk(&f.file())[1].1.to_string() })),
        "{others}"
    );
    assert!(v1_on_disk(&f.file()).iter().any(|(id, _, enabled)| *id == mine && !enabled), "the target disabled");
    println!("s3e: by id after a ripple insert: independent applied, others {} bytes: {others}", others.to_string().len());
    f.shutdown().await;
}

/// The time-addressed step of each kind below, `timeline.place` of a clip at `at.time` 2.5 s on V1
/// (an insert or an overwrite), or a sequence marker at 2.5 s (`marker.add`).
fn at_time(kind: &str, item: &Value) -> Value {
    match kind {
        "insert" | "overwrite" => {
            json!({ "command": "timeline.place", "params": { "item": item, "track": "V1", "insert": kind == "insert" }, "at": { "time": 2.5 } })
        }
        _ => json!({ "command": "marker.add", "params": { "name": "door" }, "at": { "time": 2.5 } }),
    }
}

/// A clip put at a time (an insert or an overwrite at `at.time` 2.5 s on V1, `timeline.place`
/// naming no clip it acts on), and a sequence marker added at 2.5 s, after the colleague's ripple
/// insert before 2.5 s: refused as `relocated`, the clip under 2.5 s now named, nothing written.
/// The marker's premise is what is under its time on every track: a marker marks what is seen and
/// heard there (the decision of C8-film-2; a marker meant for a time whatever is there is the same
/// step without `basis`).
#[tokio::test(flavor = "multi_thread")]
async fn s3f_a_write_at_a_time_after_a_ripple_insert_before_it_is_refused() {
    for kind in ["insert", "overwrite", "marker"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        let item = sequence["video"][0]["items"][0]["item"].clone();
        f.colleague(&[ripple_insert_at_start(&item)]);
        let before = std::fs::read(f.file()).unwrap();
        let refused = f.refused("run", json!({ "basis": basis, "steps": [at_time(kind, &item)] })).await;
        let entered = assert_conflict(&refused, &clips[1].to_string(), "relocated");
        assert_eq!(entered["place"]["under"][0], json!(clips[1]), "{kind}: {refused}");
        assert_conflict(&refused, &clips[2].to_string(), "relocated");
        assert_eq!(std::fs::read(f.file()).unwrap(), before, "{kind}: nothing written");
        f.shutdown().await;
    }
}

/// The same writes at 2.5 s after a colleague's change after that time on V1 (a ripple delete of
/// the clip at 5 s) or on another track (a clip put on V2 at 2 s): applied, but for the marker
/// after the clip put on V2, which is under 2.5 s now: the marker's premise is what is under its
/// time on every track, and that changed (refused as `relocated`, naming the new clip).
#[tokio::test(flavor = "multi_thread")]
async fn s3g_a_write_at_a_time_after_a_change_after_it_or_on_another_track_applies() {
    for kind in ["insert", "overwrite", "marker"] {
        for elsewhere in ["later", "V2"] {
            let f = Fixture::new(CLIPS);
            let (sequence, basis) = f.inspect().await;
            let clips = v1(&sequence);
            let item = sequence["video"][0]["items"][0]["item"].clone();
            match elsewhere {
                "later" => f.colleague(&[("edit.rippleDelete", json!({ "clips": [clips[5]] }))]),
                _ => f.colleague(&[("timeline.place", json!({ "item": item, "track": "V2", "seconds": 2 }))]),
            };
            let saved = std::fs::read(f.file()).unwrap();
            let ran = f.call("run", json!({ "basis": basis, "steps": [at_time(kind, &item)] })).await;
            if kind == "insert" && elsewhere == "later" {
                // Inserting shifts the suffix's starts. A colleague already
                // assigned those same fields during the later ripple delete.
                let refused = ran.expect_err("same-field suffix start assignment");
                assert_eq!(refused["error"]["code"], "conflict", "{refused}");
                assert!(refused["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{refused}");
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            } else if kind == "marker" && elsewhere == "V2" {
                // The marker's premise is what is under 2.5 s on every track: the clip put on V2
                // there is under it now.
                let refused = ran.expect_err("refused");
                let placed = v1_on_disk(&f.file()).len();
                assert_eq!(placed, CLIPS, "V1 as it was");
                assert_eq!(refused["conflicts"].as_array().map(Vec::len), Some(1), "{refused}");
                assert_eq!(refused["conflicts"][0]["reason"], "relocated", "{refused}");
                assert_eq!(refused["conflicts"][0]["place"]["under"].as_array().map(Vec::len), Some(2), "V1's clip and V2's: {refused}");
            } else {
                let ran = ran.unwrap_or_else(|error| panic!("{kind} after a change {elsewhere}: {error}"));
                assert!(ran["others"].is_object(), "{kind} {elsewhere}: {ran}");
            }
            f.shutdown().await;
        }
    }
}

/// A colleague changes the clip under 2.5 s without changing the order of V1's clips, and the
/// agent cuts V1 at 2.5 s (`timeline.razor`, `track`, `at.time`) with `basis`. Before `basis` the
/// target's Out point was trimmed 12 frames earlier, so it can be slipped.
/// - A slip (its source In 3 frames later; start and duration as they were): the clip under the
///   place is a target as if named by id, its content (`sourceIn`) a premise: refused as
///   `changed` (C8-fix-7; was applied).
/// - A trim of its Out point 3 frames earlier (still under 2.5 s, its source frame there the
///   same): the kit says a cut depends on where the clip under it starts, not on its length, and
///   the guard replays that the clip still covers 2.5 s: applied (C8-fix-7; was refused as
///   `relocated`).
#[tokio::test(flavor = "multi_thread")]
async fn s9_a_slip_of_the_clip_under_the_time_is_refused_and_a_trim_clear_of_it_applies() {
    for change in ["slip", "trim"] {
        let f = Fixture::new(CLIPS);
        let (sequence, _) = f.inspect().await;
        let mine = v1(&sequence)[2];
        f.colleague(&[("timeline.trim", json!({ "clip": mine, "edge": "out", "mode": "regular", "deltaFrames": -12 }))]);
        let (_, basis) = f.inspect().await;
        let step = match change {
            "slip" => ("timeline.slip", json!({ "clip": mine, "deltaFrames": 3 })),
            _ => ("timeline.trim", json!({ "clip": mine, "edge": "out", "mode": "regular", "deltaFrames": -3 })),
        };
        f.colleague(&[step]);
        let cut = json!({ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": 2.25 } });
        let answer = f.call("run", json!({ "basis": basis, "steps": [cut] })).await;
        match change {
            "slip" => {
                let refused = answer.expect_err("slip: refused");
                assert_conflict(&refused, &mine.to_string(), "changed");
                println!("s9: slip of the clip under the place: refused, conflicts {}", refused["conflicts"]);
            }
            _ => {
                let ran = answer.unwrap_or_else(|error| panic!("trim: {error}"));
                assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(mine), "{ran}");
                println!("s9: trim of the clip under the place: applied");
            }
        }
        f.shutdown().await;
    }
}

// ---- 4. The target deleted ----

/// The colleague deletes the target (a ripple delete): the agent's write is refused as `deleted`.
#[tokio::test(flavor = "multi_thread")]
async fn s4_a_colleague_deleting_the_target_is_refused_as_deleted() {
    let f = Fixture::new(CLIPS);
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[("edit.rippleDelete", json!({ "clips": [mine] }))]);
    let before = std::fs::read(f.file()).unwrap();
    let refused = f.refused("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_conflict(&refused, &mine.to_string(), "deleted");
    assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
    f.shutdown().await;
}

// ---- 5. A write at a time after a ripple edit ----

/// A cut at `at.time` 2.5 s naming, in `on`, the clip the agent saw under 2.5 s: after the
/// colleague's ripple insert before it, refused (`relocated`: the clip under 2.5 s is another one
/// now); after a ripple insert at the end of V1, which leaves that clip where it was, applied.
/// Without `on` the cut names no object and applies to whatever is under 2.5 s (s3c).
#[tokio::test(flavor = "multi_thread")]
async fn s5_a_cut_at_a_time_naming_its_clip_is_refused_when_the_clip_moved_and_applies_when_it_stayed() {
    for moved in [true, false] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let mine = v1(&sequence)[2];
        let item = sequence["video"][0]["items"][0]["item"].clone();
        let at = if moved { 0 } else { CLIPS };
        f.colleague(&[("timeline.place", json!({ "item": item, "track": "V1", "seconds": at, "insert": true }))]);
        let cut = json!({ "command": "timeline.razor", "on": [mine], "at": { "time": 2.5 } });
        if moved {
            let before = std::fs::read(f.file()).unwrap();
            let refused = f.refused("run", json!({ "basis": basis, "steps": [cut] })).await;
            assert_conflict(&refused, &mine.to_string(), "relocated");
            assert_eq!(std::fs::read(f.file()).unwrap(), before, "nothing written");
        } else {
            let pieces = v1_on_disk(&f.file()).len();
            let ran = f.ok("run", json!({ "basis": basis, "steps": [cut] })).await;
            assert!(ids(&ran["changes"]["changed"]).contains(&mine.to_string()), "{ran}");
            assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(mine), "{ran}");
            assert_eq!(v1_on_disk(&f.file()).len(), pieces + 1, "one cut: {ran}");
        }
        f.shutdown().await;
    }
}

// ---- 6. Guard modes ----

/// `--guard epoch` refuses scenario 1 (any change by others); `--guard off` applies scenario 2,
/// overwriting the colleague's opacity, and still tells it in `others`.
#[tokio::test(flavor = "multi_thread")]
async fn s6_epoch_refuses_an_unrelated_change_and_off_overwrites_the_targets() {
    let f = Fixture::with(CLIPS, CallOptions { guard: Guard::Epoch, ..CallOptions::default() });
    let (sequence, basis) = f.inspect().await;
    let clips = v1(&sequence);
    f.colleague(&[opacity(clips[5], 30.0)]);
    let refused = f.refused("run", json!({ "basis": basis, "steps": [set_opacity(clips[2], 50.0)] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(opacity_on_disk(&f.file(), clips[2]), 100.0, "nothing written");
    f.shutdown().await;

    let f = Fixture::with(CLIPS, CallOptions { guard: Guard::Off, ..CallOptions::default() });
    let (sequence, basis) = f.inspect().await;
    let mine = v1(&sequence)[2];
    f.colleague(&[opacity(mine, 30.0)]);
    let ran = f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), [mine.to_string()], "{ran}");
    assert_eq!(opacity_on_disk(&f.file(), mine), 50.0, "the colleague's 30 overwritten");
    f.shutdown().await;
}

// ---- 7. Saved again unchanged ----

/// The file saved again with no change, by the colleague's engine and by a bare rewrite (pretty
/// JSON, another generator string): no notice, no refusal, nothing in `others`, with or without
/// `basis`.
#[tokio::test(flavor = "multi_thread")]
async fn s7_a_file_saved_again_unchanged_is_no_change() {
    for how in ["engine", "rewrite"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let mine = v1(&sequence)[2];
        let bytes = std::fs::read(f.file()).unwrap();
        match how {
            "engine" => {
                f.colleague(&[]);
            }
            _ => rewrite(&f.file(), |_| {}),
        }
        // The engine writes the same bytes again (only the file's time differs); the bare rewrite
        // writes other bytes (pretty JSON).
        assert_eq!(std::fs::read(f.file()).unwrap() == bytes, how == "engine", "{how}");
        let ran = f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0)] })).await;
        assert!(ran.get("others").is_none_or(Value::is_null), "{how}: {ran}");
        if how == "engine" {
            f.colleague(&[]);
        } else {
            rewrite(&f.file(), |_| {});
        }
        let seen = f.ok("inspect", json!({})).await;
        assert!(seen.get("changedOutside").is_none_or(|told| told.is_null() || told == false), "{how}: {seen}");
        f.ok("run", json!({ "steps": [set_opacity(mine, 60.0)] })).await;
        f.shutdown().await;
    }
}

// ---- 8. False refusals ----

/// Fifty rounds on a 24-clip sequence: the colleague changes the opacity of a clip picked at
/// random (a fixed seed) among the 23 other than the agent's target, then the agent writes its
/// target with the revision of its last answer. Under the premise guard no write is refused;
/// under `--guard epoch` every one is. Prints both counts.
#[tokio::test(flavor = "multi_thread")]
async fn s8_fifty_unrelated_file_changes_refuse_no_write_under_premise_and_every_write_under_epoch() {
    const ROUNDS: u64 = 50;
    let mut counts = Vec::new();
    for (guard, name) in [(Guard::Premise, "premise"), (Guard::Epoch, "epoch")] {
        let f = Fixture::with(24, CallOptions { guard, ..CallOptions::default() });
        let (sequence, mut basis) = f.inspect().await;
        let mut clips = v1(&sequence);
        let mine = clips.remove(7);
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut refused = 0;
        for round in 0..ROUNDS {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let theirs = clips[usize::try_from(seed % 23).unwrap()];
            f.colleague(&[opacity(theirs, f64::from(u32::try_from(round).unwrap()))]);
            match f.call("run", json!({ "basis": basis, "steps": [set_opacity(mine, 50.0 + f64::from(u32::try_from(round % 2).unwrap()))] })).await {
                Ok(ran) => {
                    assert_eq!(ids(&ran["others"]["changed"]), [theirs.to_string()], "{ran}");
                    basis = revision(&ran);
                }
                Err(error) => {
                    assert_eq!(error["error"]["code"], "conflict", "{error}");
                    refused += 1;
                    basis = revision(&error);
                }
            }
        }
        println!("s8: --guard {name}: {refused} of {ROUNDS} writes refused after an unrelated file change");
        counts.push(refused);
        f.shutdown().await;
    }
    assert_eq!(counts, [0, ROUNDS], "premise refuses none, epoch every one");
}

/// The same fifty rounds as `s8` (same seed), the agent naming its target in `on` instead of the
/// command's `clip` parameter (C8-time-3).
#[tokio::test(flavor = "multi_thread")]
async fn s8c_fifty_unrelated_file_changes_refuse_no_write_by_on_under_premise_and_every_one_under_epoch() {
    const ROUNDS: u64 = 50;
    let mut counts = Vec::new();
    for (guard, name) in [(Guard::Premise, "premise"), (Guard::Epoch, "epoch")] {
        let f = Fixture::with(24, CallOptions { guard, ..CallOptions::default() });
        let (sequence, mut basis) = f.inspect().await;
        let mut clips = v1(&sequence);
        let mine = clips.remove(7);
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut refused = 0;
        for round in 0..ROUNDS {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let theirs = clips[usize::try_from(seed % 23).unwrap()];
            f.colleague(&[opacity(theirs, f64::from(u32::try_from(round).unwrap()))]);
            match f.call("run", json!({ "basis": basis, "steps": [{ "command": "effect.setParam", "on": [mine], "params": { "effect": "opacity", "param": "opacity", "value": 50.0 + f64::from(u32::try_from(round % 2).unwrap()) } }] })).await {
                Ok(ran) => {
                    assert_eq!(ids(&ran["others"]["changed"]), [theirs.to_string()], "{ran}");
                    basis = revision(&ran);
                }
                Err(error) => {
                    assert_eq!(error["error"]["code"], "conflict", "{error}");
                    refused += 1;
                    basis = revision(&error);
                }
            }
        }
        println!("s8c: --guard {name}: {refused} of {ROUNDS} writes refused after an unrelated file change");
        counts.push(refused);
        f.shutdown().await;
    }
    assert_eq!(counts, [0, ROUNDS], "premise refuses none, epoch every one");
}

/// The same fifty rounds, the agent writing by place: it selects the clip under its target's
/// time and toggles it (`timeline.selectClipAtPlayhead` at `at.time`, then `clip.enable`). Under
/// the premise guard no write is refused; under `--guard epoch` every one is.
#[tokio::test(flavor = "multi_thread")]
async fn s8b_fifty_unrelated_file_changes_refuse_no_write_by_time_under_premise_and_every_one_under_epoch() {
    const ROUNDS: u64 = 50;
    let mut counts = Vec::new();
    for (guard, name) in [(Guard::Premise, "premise"), (Guard::Epoch, "epoch")] {
        let f = Fixture::with(24, CallOptions { guard, ..CallOptions::default() });
        let (sequence, mut basis) = f.inspect().await;
        let mut clips = v1(&sequence);
        let mine = clips.remove(7);
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut refused = 0;
        let mut times = Vec::new();
        for round in 0..ROUNDS {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let theirs = clips[usize::try_from(seed % 23).unwrap()];
            f.colleague(&[opacity(theirs, f64::from(u32::try_from(round).unwrap()))]);
            let steps = json!([
                { "command": "timeline.selectClipAtPlayhead", "at": { "time": 7.5 } },
                { "command": "clip.enable" },
            ]);
            let start = Instant::now();
            match f.call("run", json!({ "basis": basis, "steps": steps })).await {
                Ok(ran) => {
                    assert_eq!(ids(&ran["changes"]["changed"]), [mine.to_string()], "{ran}");
                    basis = revision(&ran);
                }
                Err(error) => {
                    assert_eq!(error["error"]["code"], "conflict", "{error}");
                    refused += 1;
                    basis = revision(&error);
                }
            }
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        println!("s8b: --guard {name}: {refused} of {ROUNDS} writes by time refused after an unrelated file change; median {:.1} ms", median(times));
        counts.push(refused);
        f.shutdown().await;
    }
    assert_eq!(counts, [0, ROUNDS], "premise refuses none, epoch every one");
}

/// What the colleague does in a round of [`s10_fifty_rounds_of_mixed_editing`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Theirs {
    /// The opacity of a random clip other than the target.
    Property,
    /// A one-second clip ripple-inserted at a random clip's start before the target (or at 0 s).
    InsertBefore,
    /// The same at a random clip's start after the target (or at the end of V1).
    InsertAfter,
    /// A random clip other than the target deleted, leaving a gap (`edit.delete`).
    Delete,
    /// A random clip other than the target trimmed: its Out point 3 frames earlier, no ripple.
    Trim,
}

/// Which clip is under `t` on V1 of `file`, and the source time it shows there (`t - start +
/// sourceIn`): what a cut at `t` cuts.
fn cut_at(file: &std::path::Path, t: i64) -> Option<(u64, i64)> {
    use kition_kit::KitDocument;
    let doc = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let seen = doc.inspect().unwrap();
    seen["sequence"]["video"][0]["items"].as_array().unwrap().iter().find_map(|clip| {
        let (start, end, source) = (clip["start"].as_i64()?, clip["end"].as_i64()?, clip["sourceIn"].as_i64()?);
        (start <= t && t < end).then(|| (clip["clip"].as_u64().unwrap(), t - start + source))
    })
}

/// Fifty rounds closer to real editing, each on a fresh 24-clip project: the agent inspects, the
/// colleague makes one random change ([`Theirs`], a fixed seed), and the agent, with the revision
/// of its inspect, (A) disables its target by id (`clip.enable` on the 13th clip, declared
/// position-independent) and (B) cuts V1 in the middle of where it saw that clip
/// (`timeline.razor`, `track` V1, `at.time`). For each refusal it says whether it was necessary:
/// for (A), the target deleted or its enabled state changed; for (B), the clip under the cut's time
/// or its source time there changed (what the cut would cut). Prints the table; asserts what the
/// guard is known to get right and wrong: (A) is never refused; (B) is refused exactly when it was
/// necessary, but for the false refusals the counts print (a change of the clip next to the place:
/// a ripple insert at the target's end, a deletion or a trim of a neighbour), and no wrong write
/// is accepted.
#[tokio::test(flavor = "multi_thread")]
async fn s10_fifty_rounds_of_mixed_editing() {
    use std::collections::BTreeMap;
    const ROUNDS: usize = 50;
    const N: usize = 24;
    const MINE: usize = 12;
    let kinds = [Theirs::Property, Theirs::InsertBefore, Theirs::InsertAfter, Theirs::Delete, Theirs::Trim];
    // (kind, write) → (rounds, applied, refused necessary, refused falsely, applied wrongly, reasons)
    let mut table: BTreeMap<(Theirs, char), (usize, usize, usize, usize, usize, BTreeMap<String, usize>)> = BTreeMap::new();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = |below: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % u64::try_from(below).unwrap()).unwrap()
    };
    for _ in 0..ROUNDS {
        let kind = kinds[next(kinds.len())];
        let f = Fixture::new(N);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        let items = sequence["video"][0]["items"].as_array().unwrap().clone();
        let mine = clips[MINE];
        let start = items[MINE]["start"].as_i64().unwrap();
        let t = start + (items[MINE]["duration"].as_i64().unwrap() / 2);
        let seconds = t as f64 / SECOND as f64;
        let other = {
            let k = next(N - 1);
            if k >= MINE { k + 1 } else { k }
        };
        let insert_at = |index: usize| {
            let at = items.get(index).map_or_else(|| items[N - 1]["end"].as_i64().unwrap(), |clip| clip["start"].as_i64().unwrap());
            ("timeline.place", json!({ "item": items[0]["item"], "track": "V1", "time": at, "insert": true }))
        };
        let theirs = match kind {
            Theirs::Property => opacity(clips[other], 30.0),
            Theirs::InsertBefore => insert_at(next(MINE + 1)),
            Theirs::InsertAfter => insert_at(MINE + 1 + next(N - MINE)),
            Theirs::Delete => ("edit.delete", json!({ "clips": [clips[other]] })),
            Theirs::Trim => ("timeline.trim", json!({ "clip": clips[other], "edge": "out", "mode": "regular", "deltaFrames": -3 })),
        };
        let seen_cut = cut_at(&f.file(), t);
        f.colleague(std::slice::from_ref(&theirs));
        let now_cut = cut_at(&f.file(), t);
        // (A) by id.
        let a = f.call("run", json!({ "basis": basis, "steps": [{ "command": "clip.enable", "on": [mine] }] })).await;
        // (B) by place, after (A): the agent's own write does not count against it.
        let b =
            f.call("run", json!({ "basis": basis, "steps": [{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": seconds } }] })).await;
        for (write, answer, necessary) in [('A', a, false), ('B', b, seen_cut != now_cut)] {
            let cell = table.entry((kind, write)).or_default();
            cell.0 += 1;
            match answer {
                Ok(_) if necessary => cell.4 += 1,
                Ok(_) => cell.1 += 1,
                Err(error) => {
                    assert_eq!(error["error"]["code"], "conflict", "{theirs:?}: {error}");
                    let reasons: Vec<String> = error["conflicts"].as_array().unwrap().iter().map(|c| c["reason"].as_str().unwrap().to_owned()).collect();
                    *cell.5.entry(reasons.join("+")).or_default() += 1;
                    if necessary {
                        cell.2 += 1;
                    } else {
                        cell.3 += 1;
                        println!("s10: false refusal of {write} after {theirs:?}: {}", error["conflicts"]);
                    }
                }
            }
        }
        f.shutdown().await;
    }
    println!("s10: their change | write | rounds | applied | refused, necessary | refused, false | applied, wrongly | reasons");
    let mut wrong = 0;
    for ((kind, write), (rounds, applied, needed, false_refusals, wrongly, reasons)) in &table {
        println!("s10: {kind:?} | {write} | {rounds} | {applied} | {needed} | {false_refusals} | {wrongly} | {reasons:?}");
        wrong += wrongly;
        if *write == 'A' {
            assert_eq!(*applied, *rounds, "a position-independent write by id is never refused: {kind:?}");
        }
        if matches!(kind, Theirs::Property | Theirs::InsertBefore) && *write == 'B' {
            assert_eq!(*false_refusals, 0, "{kind:?}");
        }
    }
    assert_eq!(wrong, 0, "no write accepted whose place changed");
}

/// A colleague changes a clip next to the place, not the clip under it, and the agent cuts V1 at
/// 2.5 s (in its target, the third clip) with `basis`: a clip ripple-inserted at the target's end,
/// the clip after it deleted (a gap left), the clip before it trimmed 3 frames shorter. The clip
/// under 2.5 s and its frame there are as they were: applied, the target cut (C8-fix-7: the guard
/// replays which clips covered the place from the clips' times; was refused for the neighbour).
#[tokio::test(flavor = "multi_thread")]
async fn s11_a_change_next_to_the_place_does_not_refuse_a_write_by_place() {
    for change in ["insert at its end", "delete the next", "trim the previous"] {
        let f = Fixture::new(CLIPS);
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        let items = sequence["video"][0]["items"].as_array().unwrap().clone();
        let step = match change {
            "insert at its end" => ("timeline.place", json!({ "item": items[0]["item"], "track": "V1", "time": items[3]["start"], "insert": true })),
            "delete the next" => ("edit.delete", json!({ "clips": [clips[3]] })),
            _ => ("timeline.trim", json!({ "clip": clips[1], "edge": "out", "mode": "regular", "deltaFrames": -3 })),
        };
        let t = items[2]["start"].as_i64().unwrap() + items[2]["duration"].as_i64().unwrap() / 2;
        let seen = cut_at(&f.file(), t);
        f.colleague(&[step]);
        assert_eq!(cut_at(&f.file(), t), seen, "{change}: the clip and frame under the place are as they were");
        let cut = json!({ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": t as f64 / SECOND as f64 } });
        let ran = f.ok("run", json!({ "basis": basis, "steps": [cut] })).await;
        assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(clips[2]), "{change}: {ran}");
        println!("s11: {change}: applied");
        f.shutdown().await;
    }
}

/// The text of caption `id` in `file`, as a new engine lists it.
fn caption_text(file: &std::path::Path, id: u64) -> String {
    use kition_kit::KitDocument;
    let mut doc = kition_film_kit::FilmDocument::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let listed = doc.execute("caption.list", json!({})).unwrap();
    let text = listed.to_string();
    listed["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|track| track["captions"].as_array().cloned().unwrap_or_default())
        .find(|caption| caption["id"] == id)
        .and_then(|caption| caption["text"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("no caption {id} in {text}"))
}

/// A caption has no tool id (a `Caption` in its sequence's `captions` list): the colleague changes
/// caption 1's text, and the agent sets the same caption's text with `basis`, naming it in `on` or
/// in the command's `caption` parameter. The kit states the call's premise, the caption's path
/// inside the sequence's item (`sequence.captions[id=…]`): refused
/// as `changed` on that item, the colleague's text kept (C8-fix-7; was applied over it). A change of
/// another caption does not refuse it.
#[tokio::test(flavor = "multi_thread")]
async fn s12_a_write_to_a_caption_a_colleague_changed_is_refused() {
    for named in ["caption", "on"] {
        let f = Fixture::new(CLIPS);
        let made = f.colleague(&[("caption.add", json!({ "text": "first", "seconds": 1 })), ("caption.add", json!({ "text": "second", "seconds": 6 }))]);
        let caption = made[0]["caption"].as_u64().unwrap_or_else(|| panic!("{made:?}"));
        let other = made[1]["caption"].as_u64().unwrap_or_else(|| panic!("{made:?}"));
        let (_, basis) = f.inspect().await;
        f.colleague(&[("caption.setText", json!({ "caption": caption, "text": "theirs" }))]);
        let step = |id: u64, text: &str| match named {
            "on" => json!({ "command": "caption.setText", "on": [id], "params": { "text": text } }),
            _ => json!({ "command": "caption.setText", "params": { "caption": id, "text": text } }),
        };
        let refused = f.refused("run", json!({ "basis": basis, "steps": [step(caption, "mine")] })).await;
        assert_eq!(refused["error"]["code"], "conflict", "{named}: {refused}");
        assert_eq!(refused["conflicts"][0]["reason"], "changed", "{named}: {refused}");
        assert_eq!(caption_text(&f.file(), caption), "theirs", "{named}: the colleague's text kept");
        println!("s12: caption named in {named}: refused, conflicts {}", refused["conflicts"]);
        let ran = f.ok("run", json!({ "basis": basis, "steps": [step(other, "mine")] })).await;
        assert_eq!(caption_text(&f.file(), other), "mine", "{named}: another caption applies: {ran}");
        f.shutdown().await;
    }
}

/// The colleague's change of the clip under the cut's time T (kition-sdk C8-fix-7, task card
/// C8-time-3), ten rounds each on a fresh 24-clip project whose target's Out point was trimmed 12
/// frames earlier before `basis`: a slip (its source In 3 frames later, start and duration as they
/// were); a trim of its Out point 8 frames earlier, so that T is no longer covered (a gap there);
/// a clip of another item placed over T on V1 (an overwrite, 10 frames from 3 frames before T).
/// (A) enables the target by id, (B) cuts V1 at T (`timeline.razor`, `track`, `at.time`). A
/// refusal is necessary when the clip and source frame under T changed; (A) never needs one.
#[tokio::test(flavor = "multi_thread")]
async fn s10b_changes_of_the_clip_under_the_place() {
    const N: usize = 24;
    const MINE: usize = 12;
    const FRAME: i64 = SECOND / 30;
    println!("s10b: their change | write | rounds | applied | refused, necessary | refused, false | applied, wrongly");
    let mut wrong = 0;
    for change in ["SlipUnder", "TrimUncover", "OverwriteAt"] {
        let mut counts = [(0, 0, 0, 0); 2];
        for _ in 0..10 {
            let f = Fixture::new(N);
            let (sequence, _) = f.inspect().await;
            let clips = v1(&sequence);
            let mine = clips[MINE];
            f.colleague(&[("timeline.trim", json!({ "clip": mine, "edge": "out", "mode": "regular", "deltaFrames": -12 }))]);
            let (sequence, basis) = f.inspect().await;
            let items = sequence["video"][0]["items"].as_array().unwrap().clone();
            let t = items[MINE]["start"].as_i64().unwrap() + items[MINE]["duration"].as_i64().unwrap() / 2;
            let seen = cut_at(&f.file(), t);
            let theirs = match change {
                "SlipUnder" => ("timeline.slip", json!({ "clip": mine, "deltaFrames": 3 })),
                "TrimUncover" => ("timeline.trim", json!({ "clip": mine, "edge": "out", "mode": "regular", "deltaFrames": -8 })),
                _ => ("timeline.place", json!({ "item": items[3]["item"], "track": "V1", "time": t - 3 * FRAME, "duration": 10 * FRAME })),
            };
            f.colleague(&[theirs]);
            let necessary = cut_at(&f.file(), t) != seen;
            let a = f.call("run", json!({ "basis": basis, "steps": [{ "command": "clip.enable", "on": [mine] }] })).await;
            let b = f.call("run", json!({ "basis": basis, "steps": [{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": t as f64 / SECOND as f64 } }] })).await;
            for (cell, (answer, necessary)) in counts.iter_mut().zip([(a, false), (b, necessary)]) {
                match (answer, necessary) {
                    (Ok(_), true) => cell.3 += 1,
                    (Ok(_), false) => cell.0 += 1,
                    (Err(_), true) => cell.1 += 1,
                    (Err(error), false) => {
                        cell.2 += 1;
                        println!("s10b: {change}: needless refusal: {}", error["conflicts"]);
                    }
                }
            }
            f.shutdown().await;
        }
        for (write, (applied, needed, needless, wrongly)) in ['A', 'B'].iter().zip(counts) {
            println!("s10b: {change} | {write} | 10 | {applied} | {needed} | {needless} | {wrongly}");
            wrong += wrongly;
        }
    }
    assert_eq!(wrong, 0, "no write applied wrongly");
}

// ---- Timings ----

/// The median time of an agent's write (dev profile, ten runs each): plain (no `basis`), with
/// `basis` and nothing changed, after an unrelated change made in the file, and refused after a
/// change of its target, on the 8-clip project and on the repository's largest project
/// (`conformance/check-truncated.kfilm`, 103 clips). Printed, not asserted.
#[tokio::test(flavor = "multi_thread")]
async fn timings_of_a_write() {
    let large = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/check-truncated.kfilm")).unwrap();
    for (name, bytes) in [("8 clips", project(CLIPS)), ("check-truncated.kfilm", large)] {
        let f = Fixture::from_bytes(&bytes, CallOptions::default());
        let (sequence, _) = f.inspect().await;
        let clips = v1(&sequence);
        let (mine, theirs) = (clips[2], clips[5]);
        let mut plain = Vec::new();
        let mut based = Vec::new();
        let mut unrelated = Vec::new();
        let mut conflict = Vec::new();
        for round in 0..10u32 {
            let value = f64::from(round);
            let start = Instant::now();
            f.ok("run", json!({ "steps": [set_opacity(mine, value)] })).await;
            plain.push(start.elapsed().as_secs_f64() * 1000.0);
            let (_, basis) = f.inspect().await;
            let start = Instant::now();
            let ran = f.ok("run", json!({ "basis": basis, "steps": [set_opacity(mine, value + 0.5)] })).await;
            based.push(start.elapsed().as_secs_f64() * 1000.0);
            f.colleague(&[opacity(theirs, value)]);
            let start = Instant::now();
            let ran = f.ok("run", json!({ "basis": revision(&ran), "steps": [set_opacity(mine, value + 0.25)] })).await;
            unrelated.push(start.elapsed().as_secs_f64() * 1000.0);
            f.colleague(&[opacity(mine, value + 0.75)]);
            let start = Instant::now();
            let refused = f.refused("run", json!({ "basis": revision(&ran), "steps": [set_opacity(mine, value)] })).await;
            conflict.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(refused["error"]["code"], "conflict", "{refused}");
        }
        println!(
            "timings ({name}): plain {:.1} ms, with basis {:.1} ms, after an unrelated file change {:.1} ms, refused {:.1} ms",
            median(plain),
            median(based),
            median(unrelated),
            median(conflict)
        );
        f.shutdown().await;
    }
}
