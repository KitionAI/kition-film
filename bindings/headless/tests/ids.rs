//! One id space (task card C8-film): the object model, receipts and `others` name a project's
//! bins, items, tracks, clips and transitions by the numbers `film_inspect` lists and commands
//! take (KitObjectModel OM9 tool ids, no prefix: the project hands every one of them out from
//! one counter), stored in the `.kfilm` file, so they survive saving, reopening, and another
//! program rewriting the file. A change inside a clip (an effect's parameter, a keyframe) is told
//! as a change of the clip at a path; a ripple edit names every clip whose start moved.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use kition_kits::tools::CallOptions;
use serde_json::{Value, json};

/// The object model's ids for V1's clips, read by following the sequence's item (its tool id is
/// the id `film_inspect` lists) to its sequence, its first video track and that track's clips.
async fn model_clip_ids(f: &Fixture) -> Vec<String> {
    let (sequence, _) = f.inspect().await;
    let item = load(f, &sequence["id"].as_u64().unwrap().to_string()).await;
    let seq = load(f, &id_text(&item["fields"]["sequence"]).unwrap()).await;
    let track = load(f, &id_text(&seq["fields"]["videoTracks"][0]).unwrap()).await;
    track["fields"]["clips"].as_array().unwrap().iter().map(|id| id_text(id).unwrap()).collect()
}

/// One object as `film_query` answers it.
async fn load(f: &Fixture, id: &str) -> Value {
    let answer = f.ok("query", json!({ "objects": [id] })).await;
    answer["objects"][0].clone()
}

/// The ids of the clips a change list names.
fn clips_in(list: &Value) -> Vec<String> {
    let mut found: Vec<String> = list.as_array().into_iter().flatten().filter(|item| item["type"] == "Clip").filter_map(|item| id_text(&item["id"])).collect();
    found.sort();
    found
}

/// The ids `film_inspect` lists are the ids `film_query` answers for the same objects: a clip
/// `9` is the object `9`, of type `Clip`; its track and the sequence's item likewise.
#[tokio::test(flavor = "multi_thread")]
async fn the_object_model_names_objects_by_the_ids_inspect_lists() {
    let f = Fixture::new(3);
    let (sequence, _) = f.inspect().await;
    let clips: Vec<String> = v1(&sequence).iter().map(u64::to_string).collect();
    assert_eq!(model_clip_ids(&f).await, clips);
    let track = sequence["video"][0]["id"].as_u64().unwrap().to_string();
    let loaded = load(&f, &track).await;
    assert_eq!((id_text(&loaded["id"]), loaded["type"].as_str()), (Some(track.clone()), Some("Track")), "{loaded}");
    let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap().to_string();
    let loaded = load(&f, &item).await;
    assert_eq!((id_text(&loaded["id"]), loaded["type"].as_str()), (Some(item.clone()), Some("Item")), "{loaded}");
    f.shutdown().await;
}

/// The ids survive saving and reopening the file, and another program rewriting it.
#[tokio::test(flavor = "multi_thread")]
async fn ids_survive_a_save_a_reopen_and_another_program_rewriting_the_file() {
    let f = Fixture::new(3);
    let before = model_clip_ids(&f).await;
    let (sequence, _) = f.inspect().await;
    f.ok("run", json!({ "steps": [set_opacity(v1(&sequence)[1], 40.0)] })).await;
    let bytes = std::fs::read(f.file()).unwrap();
    f.shutdown().await;
    let g = Fixture::from_bytes(&bytes, CallOptions::default());
    assert_eq!(model_clip_ids(&g).await, before, "after a reopen");
    rewrite(&g.file(), |project| project.name = "Renamed elsewhere".to_owned());
    assert_eq!(model_clip_ids(&g).await, before, "after another program rewrote the file");
    g.shutdown().await;
}

/// A receipt names a clip's effect parameter change under the clip, by its id, at the path to the
/// effect's parameters; a keyframe added there is told the same way.
#[tokio::test(flavor = "multi_thread")]
async fn a_receipt_names_an_effect_or_keyframe_change_under_its_clip() {
    let f = Fixture::new(3);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[1];
    let ran = f.ok("run", json!({ "steps": [set_opacity(clip, 50.0)] })).await;
    let changed = &ran["changes"]["changed"];
    assert_eq!(ids(changed), [clip.to_string()], "{ran}");
    let told = entry(changed, &clip.to_string());
    assert_eq!(told["type"], "Clip", "{ran}");
    assert_eq!(told["fields"], json!(["effects.1.params.opacity.value.Float"]), "{ran}");
    for list in ["created", "moved", "deleted"] {
        assert!(ids(&ran["changes"][list]).is_empty(), "{ran}");
    }
    println!("receipt of one opacity change: {} bytes", ran["changes"].to_string().len());
    let keyed = f
        .ok("run", json!({ "steps": [{ "command": "effects.setParam", "params": { "clip": clip, "effect": "opacity", "param": "opacity", "value": 20, "seconds": 1.5 } }] }))
        .await;
    assert_eq!(ids(&keyed["changes"]["changed"]), [clip.to_string()], "{keyed}");
    assert_eq!(entry(&keyed["changes"]["changed"], &clip.to_string())["fields"], json!(["effects.1.params.opacity.keyframes"]), "{keyed}");
    f.shutdown().await;
}

/// The clips of a track are listed in time order: a clip inserted before others is created at its
/// place in time, and a ripple names every later clip whose start moved, by id, with its start
/// before and after. Prints the receipt's size for a 5-clip and a 200-clip sequence.
#[tokio::test(flavor = "multi_thread")]
async fn a_ripple_delete_names_every_clip_whose_start_moved() {
    for clips in [5usize, 200] {
        let f = Fixture::new(clips);
        let (sequence, _) = f.inspect().await;
        let ids_before = v1(&sequence);
        let first = ids_before[0];
        let ran = f.ok("run", json!({ "changes": "all", "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [first] } }] })).await;
        let changes = &ran["changes"];
        assert_eq!(ids(&changes["deleted"]), [first.to_string()], "{changes}");
        let moved = clips_in(&changes["changed"]);
        let mut later: Vec<String> = ids_before[1..].iter().map(u64::to_string).collect();
        later.sort();
        assert_eq!(moved, later, "every later clip, and only them");
        for id in &ids_before[1..] {
            let told = entry(&changes["changed"], &id.to_string());
            assert_eq!(told["fields"], json!(["start"]), "{told}");
            let edit = &told["edits"][0];
            let (before, after): (i64, i64) = (edit["before"].as_str().unwrap().parse().unwrap(), edit["after"].as_str().unwrap().parse().unwrap());
            assert_eq!(before - after, SECOND, "{told}");
        }
        assert!(ids(&changes["moved"]).is_empty(), "no clip changed its place among the others: {changes}");
        let all = changes.to_string().len();
        let capped = f.ok("run", json!({ "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [ids_before[1]] } }] })).await;
        println!(
            "ripple delete of the first of {clips} clips: receipt {all} bytes with changes: \"all\" ({} changed); default cap {} bytes (truncated {})",
            changes["changed"].as_array().unwrap().len(),
            capped["changes"].to_string().len(),
            capped["changes"]["truncated"]
        );
        f.shutdown().await;
    }
}

/// A clip placed before the others with a ripple insert is created where it is in time, at index 0
/// of its track's clips, and every clip after it is named with its new start.
#[tokio::test(flavor = "multi_thread")]
async fn a_ripple_insert_creates_the_clip_at_its_place_in_time() {
    let f = Fixture::new(4);
    let (sequence, _) = f.inspect().await;
    let item = sequence["video"][0]["items"][2]["item"].clone();
    let ran = f.ok("run", json!({ "steps": [{ "command": "timeline.place", "params": { "item": item, "track": "V1", "seconds": 0, "insert": true } }] })).await;
    let changes = &ran["changes"];
    let created = changes["created"].as_array().unwrap();
    let clip = created.iter().find(|object| object["type"] == "Clip").unwrap_or_else(|| panic!("{changes}"));
    assert_eq!(clip["at"]["field"], "clips", "{changes}");
    assert_eq!(clip["at"]["index"], 0, "{changes}");
    let (after, _) = f.inspect().await;
    assert_eq!(clip["id"], json!(v1(&after)[0]), "named by the id inspect lists, a number as commands take it");
    // The four clips after it moved later by its duration: one footprint (kition-sdk C8-fix-5),
    // and each by name with `changes: "all"`.
    assert_eq!(
        changes["changed"],
        json!([{
            "id": sequence["id"], "type":"Item", "fields":["sequence.duration"],
            "edits":[{"field":"sequence.duration","before":sequence["duration"].as_i64().unwrap().to_string(),"after":after["duration"].as_i64().unwrap().to_string()}]
        }]),
        "{changes}"
    );
    let print = &changes["footprint"][0];
    assert_eq!(
        (print["field"].clone(), print["from"].clone(), print["count"].clone(), print["shift"]["field"].clone()),
        (json!("clips"), json!(1), json!(4), json!("start")),
        "{changes}"
    );
    let undone = f.ok("run", json!({ "steps": [{ "command": "edit.undo" }] })).await;
    assert!(undone["changes"].is_object(), "{undone}");
    let ran = f
        .ok(
            "run",
            json!({ "changes": "all", "steps": [{ "command": "timeline.place", "params": { "item": item, "track": "V1", "seconds": 0, "insert": true } }] }),
        )
        .await;
    let moved = clips_in(&ran["changes"]["changed"]);
    let mut later: Vec<String> = v1(&sequence).iter().map(u64::to_string).collect();
    later.sort();
    assert_eq!(moved, later, "{}", ran["changes"]);
    f.shutdown().await;
}

/// `agent.parts` declares the sequence: a run's `target` and a step's `at.part` name a sequence by
/// its item id, as `film_inspect` lists it.
#[tokio::test(flavor = "multi_thread")]
async fn a_part_is_a_sequence_named_by_its_item_id() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let id = sequence["id"].as_u64().unwrap();
    let clip = v1(&sequence)[1];
    let ran =
        f.ok("run", json!({ "target": { "sequence": id }, "steps": [{ "command": "clip.enable", "on": [clip], "at": { "part": { "sequence": id } } }] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), [clip.to_string()], "{ran}");
    let seen = f.ok("inspect", json!({ "target": { "sequence": id } })).await;
    assert_eq!(seen["details"]["sequence"]["id"], json!(id), "{seen}");
    f.shutdown().await;
}

/// What the object model answers for a type that names no tool id field is never an engine id:
/// an effect is told under its clip, never by an object id of its own.
#[tokio::test(flavor = "multi_thread")]
async fn no_receipt_names_an_object_id_minted_on_a_read() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let ran = f.ok("run", json!({ "steps": [set_opacity(v1(&sequence)[0], 10.0), { "command": "clip.enable", "on": [v1(&sequence)[1]] }] })).await;
    for list in ["created", "changed", "moved", "deleted"] {
        for id in ids(&ran["changes"][list]) {
            assert!(id.parse::<u64>().is_ok(), "{list} names {id}: {ran}");
        }
    }
    let _: Value = ran;
    f.shutdown().await;
}

/// A tool id is a number in receipts and `others`, as `film_inspect` lists it and every command
/// takes it (kition-sdk C8-fix-5); `on` takes it as a number or as a numeric string, which names
/// the same clip, and so does a command's own id parameter since kition-sdk C8-fix-9 (`clip: "9"`
/// reaches the engine as 9; before, it was refused "expected a whole number (an id), got a string").
#[tokio::test(flavor = "multi_thread")]
async fn a_tool_id_written_as_a_string_is_taken_in_on_and_in_a_clip_parameter() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let clip = v1(&sequence)[1].to_string();
    let step = json!({ "command": "effects.setParam", "params": { "clip": clip, "effect": "opacity", "param": "opacity", "value": 25 } });
    let ran = f.ok("run", json!({ "steps": [step] })).await;
    assert_eq!(ran["changes"]["changed"][0]["id"], json!(v1(&sequence)[1]), "{ran}");
    assert_eq!(opacity_on_disk(&f.file(), v1(&sequence)[1]), 25.0, "{ran}");
    let ran = f.ok("run", json!({ "steps": [{ "command": "clip.enable", "on": [clip] }] })).await;
    assert_eq!(ran["changes"]["changed"][0]["id"], json!(v1(&sequence)[1]), "{ran}");
    f.shutdown().await;
}

/// A sequence marker is no object of its own: adding one is told as a change of the sequence's
/// item, at `sequence.markers`, with the whole list before and after.
#[tokio::test(flavor = "multi_thread")]
async fn a_marker_is_told_under_its_sequences_item() {
    let f = Fixture::new(2);
    let (sequence, _) = f.inspect().await;
    let item = sequence["id"].as_u64().unwrap().to_string();
    let ran = f.ok("run", json!({ "steps": [{ "command": "markers.add", "at": { "time": 1.5 } }] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), std::slice::from_ref(&item), "{ran}");
    let told = entry(&ran["changes"]["changed"], &item);
    assert_eq!((told["type"].as_str(), told["fields"].clone()), (Some("Item"), json!(["sequence.markers"])), "{ran}");
    f.shutdown().await;
}

/// A step's `at.part` names a sequence other than the open one by its item id: a razor cut there
/// at `at.time`, the open sequence left open (the guide's example 4).
#[tokio::test(flavor = "multi_thread")]
async fn a_step_cuts_another_sequence_named_in_at_part() {
    let f = Fixture::new(2);
    let (main, _) = f.inspect().await;
    let made = f.ok("run", json!({ "steps": [{ "command": "file.newSequence", "params": { "name": "Other", "width": 320, "height": 180 } }] })).await;
    let other: u64 = made["changes"]["created"]
        .as_array()
        .unwrap()
        .iter()
        .find(|object| object["type"] == "Item")
        .and_then(|object| object["id"].as_u64())
        .unwrap_or_else(|| panic!("{made}"));
    let item = main["video"][0]["items"][0]["item"].clone();
    f.ok(
        "run",
        json!({ "steps": [{ "command": "timeline.place", "at": { "part": { "sequence": other } }, "params": { "item": item, "track": "V1", "seconds": 0 } }] }),
    )
    .await;
    let ran = f
        .ok("run", json!({ "steps": [{ "command": "timeline.razor", "at": { "part": { "sequence": other }, "time": 0.5 }, "params": { "track": "V1" } }] }))
        .await;
    assert_eq!(ran["completed"][0]["result"]["cuts"], 1, "{ran}");
    let (open, _) = f.inspect().await;
    assert_eq!(open["id"], main["id"], "the open sequence is put back");
    assert_eq!(v1(&open).len(), 2, "the open sequence is not cut");
    f.shutdown().await;
}

/// The receipt of a ripple delete of the first clip, by default (the clips after it stated once,
/// `footprint`) and with `changes: "all"` (each by name), on 5 and 200 clips. Printed sizes; the
/// footprint asserted.
#[tokio::test(flavor = "multi_thread")]
async fn a_ripple_delete_receipt_states_the_shift_once() {
    for clips in [5usize, 200] {
        let mut sizes = Vec::new();
        for changes in [json!(true), json!("all")] {
            let f = Fixture::new(clips);
            let (sequence, _) = f.inspect().await;
            let first = v1(&sequence)[0];
            let ran = f.ok("run", json!({ "changes": changes, "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [first] } }] })).await;
            if changes == true {
                let print = &ran["changes"]["footprint"][0];
                assert_eq!(
                    (print["from"].clone(), print["count"].clone(), print["shift"]["field"].clone()),
                    (json!(0), json!(clips - 1), json!("start")),
                    "{ran}"
                );
            } else {
                assert!(ran["changes"].get("footprint").is_none_or(Value::is_null), "{ran}");
                assert_eq!(clips_in(&ran["changes"]["changed"]).len(), clips - 1, "{ran}");
            }
            sizes.push(ran["changes"].to_string().len());
            f.shutdown().await;
        }
        println!("receipt of a ripple delete of the first of {clips} clips: default {} bytes, changes \"all\" {} bytes", sizes[0], sizes[1]);
    }
}

/// Every integer parameter whose name or description says it is an id is a target, an object
/// parameter or a place (kition-sdk `testing::check_id_params`): since kition-sdk C8-fix-8 a whole
/// number elsewhere names no object, and a write over a colleague's change of it would apply.
#[test]
fn every_integer_id_parameter_is_marked() {
    let doc = <kition_film_kit::FilmDocument as kition_kit::KitDocument>::open(FILE, &project(2)).unwrap();
    let commands = kition_kit::KitDocument::commands(&doc);
    if let Err(problems) = kition_kit::testing::check_id_params(&commands, ALLOWED_IDS) {
        panic!("{} unmarked:\n{}", problems.len(), problems.join("\n"));
    }
}

/// Integer parameters whose words say id but that name no object of the object model, each with why.
const ALLOWED_IDS: &[(&str, &str)] = &[
    // A search bin is a `SearchBin` in Project.searchBins, without a tool id: `under` holds it by its `id`.
    ("project.searchBinItems", "bin"),
    ("project.editSearchBin", "bin"),
    ("project.deleteSearchBin", "bin"),
    // A render job of the session: not in the file.
    ("jobs.cancel", "job"),
    // A marker is a `Marker` in the sequence's `markers` list, without a tool id; the kit's premise holds it in the sequence's item.
    ("markers.edit", "marker"),
    // A caption track is a `CaptionTrack` in the sequence's `captionTracks` list, without a tool id: no object to hold.
    ("captions.deleteTrack", "track"),
    ("captions.setTrack", "track"),
    ("captions.setStyle", "track"),
    ("captions.showActiveOnly", "track"),
    ("captions.export", "track"),
    ("captions.list", "track"),
    // A caption is an item of a caption track's json, no tool id; the kit's premise holds it in the sequence's item.
    ("captions.split", "caption"),
    ("captions.setText", "caption"),
    ("captions.setTimes", "caption"),
    ("captions.trim", "caption"),
    ("captions.goTo", "caption"),
    // A keyboard shortcut's command: the editor's settings, not the file.
    ("shortcuts.get", "command"),
    ("shortcuts.set", "command"),
    ("shortcuts.clear", "command"),
    // An entry of the export queue: the session's, not in the file.
    ("export.queue.cancel", "id"),
    ("export.queue.retry", "id"),
    ("export.queue.remove", "id"),
    ("export.queue.move", "id"),
    // An event counter: a number of events seen, no object.
    ("events.list", "since"),
];

/// The object model's schema gives kition-sdk's kit-env (and any reader) the kit's words
/// (kition-sdk C8-fix-9): a clip is named by its name (`"label": "props.name"`), its times are
/// shown as times (`"display": { "kind": "time" }` in ticks per second), and an item's `kind`,
/// whose change remakes the item, is no field to sample (`"sample": false`).
#[tokio::test(flavor = "multi_thread")]
async fn the_object_model_says_how_its_objects_are_named_and_shown() {
    let f = Fixture::new(2);
    let described = f.ok("query", json!({ "describe": "*" })).await;
    let text = described.to_string();
    let types = &described["describe"]["types"];
    assert_eq!(types["Clip"]["label"], "props.name", "{text}");
    for field in ["start", "duration", "sourceIn"] {
        assert_eq!(types["Clip"]["fields"][field]["display"], json!({ "kind": "time", "perSecond": SECOND }), "{field}: {text}");
    }
    assert_eq!(types["Item"]["fields"]["kind"]["sample"], false, "{text}");
    f.shutdown().await;
}
