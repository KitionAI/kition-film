//! An agent's call says which sequence, time and clips it acts on, and leaves the editor as it was
//! (task card C4-film). The kit's editor-state hooks (`editor_state`, `set_context`,
//! `restore_editor_state`) are driven here as `kition-kits` drives them for a `film_run`: save the
//! state, set each step's `at.part` (`{sequence}`), `at.time` (seconds) and `on` (ids) before it,
//! run it as the agent, and put the state back after the run.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use kition_film_engine::Origin;
use kition_film_kit::FilmDocument;
use kition_kit::{CallContext, EditorState, KitDocument};
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

/// What an agent's step runs through: `executeAs` with an agent's origin.
fn agent(doc: &mut FilmDocument, command: &str, params: Value) -> Result<Value, String> {
    doc.execute_as(command, params, &Origin::agent("agent:test"))
}

fn context(on: &[u64], sequence: Option<u64>, time: Option<f64>) -> CallContext {
    CallContext { on: on.iter().map(|id| json!(id)).collect(), part: sequence.map(|id| json!({ "sequence": id })), time }
}

/// Two 24 fps sequences. "Main" (open): a red matte 0-2 s and a blue one 2-4 s on V1. "Other": a
/// green matte 0-3 s on V1. The playhead of Main is at 1 s, the red clip is selected, and no
/// project item.
struct Fixture {
    doc: FilmDocument,
    main: u64,
    other: u64,
    red: u64,
    blue: u64,
    green: u64,
    green_item: u64,
}

fn fixture() -> Fixture {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let other = run(&mut doc, "file.newSequence", json!({ "name": "Other", "width": 320, "height": 180, "fps": 24 }))["sequence"].as_u64().unwrap();
    let green_item = run(&mut doc, "file.newColorMatte", json!({ "color": "#00ff00", "seconds": 3 }))["item"].as_u64().unwrap();
    let green = run(&mut doc, "timeline.place", json!({ "item": green_item, "track": "V1", "seconds": 0 }))["clips"][0].as_u64().unwrap();
    let main = run(&mut doc, "file.newSequence", json!({ "name": "Main", "width": 320, "height": 180, "fps": 24 }))["sequence"].as_u64().unwrap();
    let mut clips = Vec::new();
    for (color, seconds) in [("#ff0000", 0), ("#0000ff", 2)] {
        let matte = run(&mut doc, "file.newColorMatte", json!({ "color": color, "seconds": 2 }))["item"].clone();
        clips.push(run(&mut doc, "timeline.place", json!({ "item": matte, "track": "V1", "seconds": seconds }))["clips"][0].as_u64().unwrap());
    }
    run(&mut doc, "playhead.set", json!({ "seconds": 1 }));
    run(&mut doc, "timeline.select", json!({ "clips": [clips[0]] }));
    run(&mut doc, "project.select", json!({ "items": [] }));
    Fixture { doc, main, other, red: clips[0], blue: clips[1], green, green_item }
}

/// The open sequence, its playhead, and the timeline selection, as `inspect` answers them.
fn editor(doc: &FilmDocument) -> (Value, Value, Value) {
    let inspected = doc.inspect().unwrap();
    (inspected["sequence"]["id"].clone(), inspected["playhead"].clone(), inspected["sequence"]["selection"].clone())
}

/// The clips on V1 of the open sequence, as (clip, start, duration) in ticks.
fn v1(doc: &FilmDocument) -> Vec<(u64, i64, i64)> {
    doc.inspect().unwrap()["sequence"]["video"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|clip| (clip["clip"].as_u64().unwrap(), clip["start"].as_i64().unwrap(), clip["duration"].as_i64().unwrap()))
        .collect()
}

/// Setting a context the document is already in and restoring the state saved before change
/// nothing in the document, what `inspect` answers, or the editor state (kition-sdk's check).
#[test]
fn the_hooks_are_no_edit() {
    let mut f = fixture();
    let now = context(&[f.red], Some(f.main), Some(1.0));
    kition_kit::testing::check_context(&mut f.doc, &now, kition_film_kit::EDITOR_STATE).unwrap();
    // Project items select in the Project panel.
    run(&mut f.doc, "timeline.select", json!({ "clips": [] }));
    run(&mut f.doc, "project.select", json!({ "items": [f.green_item] }));
    kition_kit::testing::check_context(&mut f.doc, &context(&[f.green_item], None, None), kition_film_kit::EDITOR_STATE).unwrap();
}

/// A context that moves the editor: another sequence, a time in it and its clip; restoring puts
/// back the open sequence, both playheads and the selection, and no hook is an edit.
#[test]
fn a_context_moves_the_editor_and_restoring_puts_it_back() {
    let mut f = fixture();
    let saved = f.doc.editor_state();
    assert!(!saved.is_null(), "the kit keeps editor state");
    let (revision, dirty, history) = (f.doc.revision(), f.doc.dirty(), f.doc.inspect().unwrap()["canUndo"].clone());
    f.doc.set_context(&context(&[f.green], Some(f.other), Some(2.5))).unwrap();
    assert_eq!(editor(&f.doc), (json!(f.other), json!(SECOND * 5 / 2), json!([f.green])));
    assert_eq!((f.doc.revision(), f.doc.dirty()), (revision, dirty), "setting the context is no edit");
    f.doc.restore_editor_state(&saved).unwrap();
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])));
    assert_eq!((f.doc.revision(), f.doc.dirty(), f.doc.inspect().unwrap()["canUndo"].clone()), (revision, dirty, history));
    assert_eq!(f.doc.editor_state(), saved);
}

/// `at.time` is seconds from the sequence's start; the playhead goes to the start of the frame
/// showing that time (23.976 fps: 3.5 s is frame 83).
#[test]
fn a_time_is_seconds_on_the_sequences_frames() {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let matte = run(&mut doc, "file.newColorMatte", json!({ "color": "#ff0000", "seconds": 5 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": matte, "track": "V1", "seconds": 0 }));
    doc.set_context(&context(&[], None, Some(3.5))).unwrap();
    let rate = kition_film_engine::time::FrameRate::new(24_000, 1_001);
    assert_eq!(doc.inspect().unwrap()["playhead"], json!(rate.tick_of(83).0));
    assert_eq!(kition_film_engine::context::playhead_at(3.5, rate), rate.tick_of(83));
}

/// A playhead-default command (Razor) given `at.time` cuts at that time, and the playhead is where
/// it was after the run.
#[test]
fn razor_at_a_time_leaves_the_playhead() {
    let mut f = fixture();
    let saved = f.doc.editor_state();
    f.doc.set_context(&context(&[], None, Some(3.5))).unwrap();
    let cut = agent(&mut f.doc, "timeline.razor", json!({ "track": "V1" })).unwrap();
    f.doc.restore_editor_state(&saved).unwrap();
    assert_eq!(cut["cuts"], json!(1), "{cut}");
    let clips = v1(&f.doc);
    assert_eq!(clips.iter().map(|(_, start, _)| *start).collect::<Vec<_>>(), [0, 2 * SECOND, SECOND * 7 / 2], "{clips:?}");
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])));
}

/// Two steps at two times in one run: a marker at each, and the playhead where it was.
#[test]
fn two_steps_at_two_times() {
    let mut f = fixture();
    let saved = f.doc.editor_state();
    for time in [0.5, 3.0] {
        f.doc.set_context(&context(&[], None, Some(time))).unwrap();
        agent(&mut f.doc, "markers.add", json!({})).unwrap();
    }
    f.doc.restore_editor_state(&saved).unwrap();
    let markers: Vec<i64> = f.doc.inspect().unwrap()["sequence"]["markers"].as_array().unwrap().iter().map(|m| m["start"].as_i64().unwrap()).collect();
    assert_eq!(markers, [SECOND / 2, 3 * SECOND]);
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])));
}

/// A step whose `at.part` names another sequence acts there; the open sequence is still Main after
/// the run, and Main is untouched.
#[test]
fn a_step_in_another_sequence_leaves_the_open_one() {
    let mut f = fixture();
    let saved = f.doc.editor_state();
    let main_before = v1(&f.doc);
    f.doc.set_context(&context(&[], Some(f.other), Some(1.0))).unwrap();
    agent(&mut f.doc, "timeline.razor", json!({ "track": "V1" })).unwrap();
    f.doc.restore_editor_state(&saved).unwrap();
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])));
    assert_eq!(v1(&f.doc), main_before, "Main is untouched");
    run(&mut f.doc, "sequence.open", json!({ "item": f.other }));
    let other: Vec<i64> = v1(&f.doc).iter().map(|(_, start, _)| *start).collect();
    assert_eq!(other, [0, SECOND], "Other's green matte is cut at 1 s");
}

/// A command that acts only on the selection (Nudge Clip Selection Right) driven by `on`.
#[test]
fn a_selection_command_acts_on_the_ids_given() {
    let mut f = fixture();
    // Room after the blue clip, so it can move.
    let saved = f.doc.editor_state();
    f.doc.set_context(&context(&[f.blue], None, None)).unwrap();
    agent(&mut f.doc, "timeline.nudgeRight", json!({})).unwrap();
    f.doc.restore_editor_state(&saved).unwrap();
    let clips = v1(&f.doc);
    let frame = SECOND / 24;
    assert_eq!(clips.iter().find(|(clip, ..)| *clip == f.blue).map(|(_, start, _)| *start), Some(2 * SECOND + frame), "{clips:?}");
    assert_eq!(clips.iter().find(|(clip, ..)| *clip == f.red).map(|(_, start, _)| *start), Some(0), "the person's selection is not what moved");
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])));
}

/// What a call names that the project lacks, or a time outside the sequence, is refused with what
/// is valid, and nothing changes.
#[test]
fn unknown_ids_and_times_out_of_range_are_refused() {
    let mut f = fixture();
    let before = f.doc.editor_state();
    let refused = |doc: &mut FilmDocument, context: CallContext| doc.set_context(&context).unwrap_err();
    let unknown = refused(&mut f.doc, context(&[9_999], None, None));
    assert!(unknown.contains("9999") && unknown.contains("film_inspect"), "{unknown}");
    let elsewhere = refused(&mut f.doc, context(&[f.green], None, None));
    assert!(elsewhere.contains(&format!("\"sequence\": {}", f.other)), "a clip of another sequence says which: {elsewhere}");
    let late = refused(&mut f.doc, context(&[], None, Some(9.0)));
    assert!(late.contains("from 0 to 4 s"), "{late}");
    let sequence = refused(&mut f.doc, context(&[], Some(9_999), None));
    assert!(sequence.contains(&format!("{} (\"Main\")", f.main)) && sequence.contains(&format!("{} (\"Other\")", f.other)), "{sequence}");
    for part in [json!({ "slide": 1 }), json!({ "sequence": "Main" }), json!({ "sequence": 1, "slide": 1 })] {
        let wrong = f.doc.set_context(&CallContext { part: Some(part.clone()), ..CallContext::default() }).unwrap_err();
        assert!(wrong.contains("{\"sequence\": id}"), "{part}: {wrong}");
    }
    // All or nothing: a good part with a bad clip changes nothing either.
    refused(&mut f.doc, context(&[9_999], Some(f.other), Some(1.0)));
    assert_eq!(f.doc.editor_state(), before);
}

/// An agent's command given its clips, item or time leaves the open sequence, the playhead and the
/// selection as they were; a command whose work is moving them keeps its effect.
#[test]
fn an_agent_command_given_what_it_acts_on_leaves_the_editor() {
    let mut f = fixture();
    let blue_item = f.doc.inspect().unwrap()["sequence"]["video"][0]["items"][1]["item"].clone();
    // Placing selects the clips it made, for a person.
    agent(&mut f.doc, "timeline.place", json!({ "item": blue_item, "track": "V2", "seconds": 0 })).unwrap();
    assert_eq!(editor(&f.doc), (json!(f.main), json!(SECOND), json!([f.red])), "timeline.place moved the editor");
    // Navigation keeps its effect.
    agent(&mut f.doc, "timeline.select", json!({ "clips": [f.red] })).unwrap();
    agent(&mut f.doc, "playhead.set", json!({ "seconds": 3 })).unwrap();
    agent(&mut f.doc, "sequence.open", json!({ "item": f.other })).unwrap();
    assert_eq!(editor(&f.doc), (json!(f.other), json!(0), json!([])));
}

/// What each command declares: `targets` where kition-sdk's `check_targets` takes the parameter,
/// and `reads` for the commands that default to the playhead or act on the selection.
#[test]
fn commands_declare_what_they_act_on_and_read() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let commands = doc.commands();
    let find = |id: &str| commands.iter().find(|command| command.id == id).unwrap_or_else(|| panic!("no {id}"));
    for command in &commands {
        if let Some(name) = command.targets {
            kition_kit::schema::check_targets(command.schema.as_ref().unwrap(), name).unwrap_or_else(|error| panic!("{}: {error}", command.id));
        }
    }
    assert_eq!(find("timeline.razor").reads, [EditorState::Part, EditorState::Time, EditorState::Mode]);
    assert!(find("timeline.nudgeRight").reads.contains(&EditorState::Selection));
    assert_eq!(find("timeline.select").targets, Some("clips"));
    assert_eq!(find("clip.enable").targets, Some("clips"));
    assert!(find("file.render").reads.is_empty() && find("file.render").targets.is_none(), "the preview names its view");
}
