//! What each command acts on and the editor state it reads besides its parameters
//! (`KitCommand::targets`, `KitCommand::reads`), for kition-sdk's explicit call context: a host
//! sets the open sequence, its playhead and the selection a command reads from a run step's
//! `at.part`, `at.time` and `on`, and puts them back after the call (task card C4-film).
//!
//! `reads` is what the engine's code reads, not what descriptions say: `reads.json` records it,
//! and `tests/acts.rs` follows each command's definition through the engine to the selections, the
//! open sequence and the playheads, and fails when the record says otherwise.
use std::collections::HashMap;
use std::sync::OnceLock;

use kition_kit::EditorState;
use serde_json::Value;

/// The editor state command `id` reads besides its parameters: a selection (the timeline's clips,
/// the caption track's captions, the Project panel's items), the open sequence (`part`), and its
/// playhead (`time`).
pub fn reads(id: &str) -> &'static [EditorState] {
    static TABLE: OnceLock<HashMap<String, Vec<EditorState>>> = OnceLock::new();
    let table = TABLE.get_or_init(|| serde_json::from_str(include_str!("reads.json")).unwrap_or_default());
    table.get(id).map(Vec::as_slice).unwrap_or(&[])
}

/// These handlers consume local settings and host references only. They have
/// no Program place, including when a clip happens to cover the playhead.
pub fn local_settings(id: &str) -> bool {
    matches!(
        id,
        "sequence.snap"
            | "sequence.linkedSelection"
            | "sequence.nestSequences"
            | "sequence.showThroughEdits"
            | "marker.showAllMarkerColors"
            | "marker.filterColors"
            | "marker.rippleSequenceMarkers"
            | "marker.copyPasteIncludesSequenceMarkers"
            | "multicam.audioFollowsVideo"
            | "multicam.selectionTopDown"
            | "multicam.showPreviewMonitor"
            | "multicam.autoAdjustQuality"
            | "multicam.transmitView"
            | "project.columns.resize"
            | "project.freeform.options"
            | "project.viewPreset.save"
            | "project.viewPreset.saveAs"
            | "project.viewPreset.restore"
            | "project.viewPreset.rename"
            | "project.viewPreset.delete"
            | "mediaBrowser.navigate"
            | "mediaBrowser.select"
            | "mediaBrowser.favorite"
            | "mediaBrowser.clearRecent"
            | "mediaBrowser.settings"
            | "preset.delete"
            | "preset.rename"
            | "preset.import"
            | "prefs.set"
            | "prefs.reset"
            | "audio.toggleScrubbing"
            | "audio.voiceover.settings"
            | "audioMixing.deletePreset"
            | "effect.setDefaultTransition"
            | "multicam.gridLayout"
            | "shortcut.set"
            | "shortcut.clear"
            | "shortcut.undo"
            | "shortcut.redo"
            | "shortcut.loadPreset"
            | "shortcut.savePreset"
            | "shortcut.deletePreset"
            | "shortcut.export"
            | "shortcut.import"
            | "export.queue.start"
            | "export.queue.stop"
            | "export.queue.cancel"
            | "export.queue.retry"
            | "export.queue.remove"
            | "export.queue.move"
            | "export.queue.clear"
            | "export.presets.save"
            | "export.presets.delete"
            | "export.presets.favorite"
            | "export.presets.import"
    )
}

/// The parameter that names what command `id` acts on, by the ids `film_inspect` lists, as the
/// engine takes them in place of the selection (`Session::enabled_for`): `clips` or `clip`
/// (timeline clips), else `items` or `item` (project items). A command that takes both kinds
/// declares none: an agent's `on` reaches it through the selections it reads, which `set_context`
/// tells apart. Only where kition-sdk's `schema::check_targets` takes the parameter's schema.
pub fn targets(id: &str, schema: Option<&Value>) -> Option<&'static str> {
    // Place Clip's `item` is what it puts on the timeline, not what it acts on: it acts at its
    // place (`track`, its time), which is its premise (`places`).
    if id == "timeline.place" {
        return None;
    }
    let schema = schema?;
    if id == "clip.rename" {
        return kition_kit::schema::check_targets(schema, "clip").is_ok().then_some("clip");
    }
    let first = |names: [&'static str; 2]| names.into_iter().find(|name| schema.get(*name).is_some());
    let named = match (first(["clips", "clip"]), first(["items", "item"])) {
        (Some(clips), None) => clips,
        (None, Some(items)) => items,
        _ => return None,
    };
    kition_kit::schema::check_targets(schema, named).is_ok().then_some(named)
}

/// Commands whose work is moving the editor (the playhead, the open sequence, a selection, the
/// track targets, the Source monitor): given what they act on, they keep what they set, where every
/// other agent command leaves the editor as it was ([`crate::FilmDocument::execute_as`]). A host
/// still puts an agent's run back afterwards.
pub fn moves_the_editor(id: &str) -> bool {
    id.starts_with("playhead.")
        || id.starts_with("timeline.toggleTarget")
        || id.starts_with("marker.go")
        || id.starts_with("trim.select")
        || id.starts_with("graphics.select")
        || matches!(
            id,
            "sequence.open"
                | "sequence.close"
                | "sequence.closeOthers"
                | "sequence.revealNested"
                | "sequence.revealInProject"
                | "sequence.matchFrame"
                | "sequence.goToNextGap"
                | "sequence.goToPrevGap"
                | "sequence.goToNextGapInTrack"
                | "sequence.goToPrevGapInTrack"
                | "timeline.select"
                | "timeline.selectClipAtPlayhead"
                | "timeline.selectNextClip"
                | "timeline.selectPrevClip"
                | "timeline.setTargeting"
                | "timeline.toggleAllAudioTargets"
                | "timeline.toggleAllVideoTargets"
                | "timeline.moveAudioTargetsDown"
                | "timeline.moveAudioTargetsUp"
                | "timeline.moveVideoTargetsDown"
                | "timeline.moveVideoTargetsUp"
                | "project.select"
                | "project.selectAll"
                | "project.deselectAll"
                | "edit.selectAll"
                | "edit.deselectAll"
                | "edit.selectAllMatching"
                | "edit.selectLabelGroup"
                | "edit.findNext"
                | "caption.select"
                | "caption.goTo"
                | "caption.next"
                | "caption.previous"
                | "clip.revealInProject"
                | "source.open"
                | "source.setPlayhead"
                | "mediaBrowser.openInSource"
                | "mask.select"
                | "transcript.select"
        )
}

/// Whether a call names what it acts on (`clips`, `clip`, `items`, `item`) or when (`time`,
/// `seconds`, `frame`, `timecode`, the keys a command reads in place of the playhead).
pub fn names_what_or_when(params: &Value) -> bool {
    ["clips", "clip", "items", "item", "time", "seconds", "frame", "timecode"].iter().any(|key| params.get(*key).is_some_and(|value| !value.is_null()))
}

/// The parameters of command `id` that name a place rather than an object (kition-sdk
/// `KitCommand::places`, C8-film-2): its track and its own time, where it takes one in place of
/// the playhead (`kition_film_engine::place::places`). With `at.time` for a command that reads the
/// time, a step that names no clip acts on what is under that place, which
/// [`crate::FilmDocument`]'s `under` answers.
pub fn places(id: &str) -> &'static [&'static str] {
    kition_film_engine::place::places(id)
}

/// The type of the objects parameter `name` of command `id` names by id (kition-sdk
/// `KitCommand::objects` and `object_types`, C8-fix-8/9), when it takes integers: timeline clips,
/// project items (a sequence is named by its project item), bins, tracks (a mixer strip, a send's
/// target and a clip mixer's track are audio or submix tracks) and transitions. `None` for a
/// parameter that names no object of the project: a caption track, a caption or a marker (items of
/// the sequence's json without tool ids, which the kit's premises name by their ids,
/// `kition_film_engine::premise`), a graphic's track or layer (positions in the graphic), an
/// export queue entry, a job, a shortcut's command, an event counter, a send by position.
fn object_type(id: &str, name: &str) -> Option<&'static str> {
    Some(match name {
        "moves[].clip" if id == "timeline.move" => "Clip",
        "moves[].track" if id == "timeline.move" => "Track",
        "video" | "audio" if id == "sequence.deleteTracks" => "Track",
        "items[].item" if id == "timeline.placeMany" => "Item",
        "sfx" if id == "transition.beatCut" => "Item",
        "items.riser" | "items.impact" | "items.sparkle" | "items.swoosh" | "items.transition" | "items.click" | "items.hit" | "items.hitAlt"
            if id == "sound.phrase" =>
        {
            "Item"
        }
        "clip" | "clips" | "left" | "right" => "Clip",
        "reference" if id == "clip.synchronize" => "Clip",
        "item" | "items" | "fromItem" | "sequence" | "sequences" => "Item",
        "reference" if id == "clip.addMulticam" => "Item",
        "bin" if matches!(id, "project.searchBinItems" | "project.editSearchBin" | "project.deleteSearchBin") => return None,
        "bin" => "Bin",
        "parent" if id == "bin.add" => "Bin",
        "track" if !id.starts_with("caption.") && !id.starts_with("graphics.") => "Track",
        "strip" if id.starts_with("mixer.") => "Track",
        "target" if matches!(id, "mixer.addSend" | "mixer.setSend") => "Track",
        "output" if id == "mixer.setStrip" => "Track",
        "transition" | "transitions" => "Transition",
        _ => return None,
    })
}

fn object_params(id: &str, schema: &Value, prefix: &str, out: &mut Vec<String>) {
    for (name, node) in schema.as_object().into_iter().flatten() {
        let path = format!("{prefix}{name}");
        if object_type(id, &path).is_some() && takes_integers(node) {
            out.push(path.clone());
        }
        if let Some(properties) = node.get("properties") {
            object_params(id, properties, &format!("{path}."), out);
        }
        if let Some(properties) = node.get("items").and_then(|items| items.get("properties")) {
            object_params(id, properties, &format!("{path}[]."), out);
        }
    }
}

/// Whether a parameter's schema takes integers: alone, in a `oneOf`, or as a list's items.
fn takes_integers(node: &Value) -> bool {
    match node.get("oneOf").and_then(Value::as_array) {
        Some(branches) => branches.iter().any(takes_integers),
        None => match node.get("type").and_then(Value::as_str) {
            Some("integer") => true,
            Some("array") => node.get("items").is_some_and(takes_integers),
            _ => false,
        },
    }
}

/// The parameters of command `id` besides its targets and places that name objects by id
/// (kition-sdk `KitCommand::objects`, C8-fix-8/9): those of [`object_type`] whose schema takes
/// integers. kition-sdk reads a whole number as an object's id only in the targets and these; a
/// write over a colleague's change of the clip, item, bin, track or transition one names is then
/// refused. `tests/ids.rs` checks every integer parameter whose words say id is marked.
pub fn objects(id: &str, schema: Option<&Value>, targets: Option<&str>, places: &[&str]) -> &'static [&'static str] {
    static TABLE: OnceLock<std::sync::Mutex<HashMap<String, &'static [&'static str]>>> = OnceLock::new();
    let mut table = TABLE.get_or_init(|| std::sync::Mutex::new(HashMap::new())).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = table.get(id) {
        return found;
    }
    let mut paths = Vec::new();
    if let Some(schema) = schema {
        object_params(id, schema, "", &mut paths);
    }
    let found: Vec<&'static str> = paths
        .into_iter()
        .filter(|name| Some(name.as_str()) != targets && !places.contains(&name.as_str()))
        .map(|name| &*Box::leak(name.into_boxed_str()))
        .collect();
    let leaked: &'static [&'static str] = Box::leak(found.into_boxed_slice());
    table.insert(id.to_owned(), leaked);
    leaked
}

/// Only the mixer strip resolver accepts project-object display names. Other string track
/// references are ordinals; item/clip/bin readers accept numeric ids, never display names.
pub fn name_params(id: &str, objects: &[&'static str]) -> &'static [(&'static str, &'static str)] {
    if id == "audio.voiceover.start" {
        return &[("track", "props.name")];
    }
    type Names = &'static [(&'static str, &'static str)];
    static TABLE: OnceLock<std::sync::Mutex<HashMap<String, Names>>> = OnceLock::new();
    let mut table = TABLE.get_or_init(|| std::sync::Mutex::new(HashMap::new())).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = table.get(id) {
        return found;
    }
    let found: Vec<_> = objects
        .iter()
        .copied()
        .filter(|name| id.starts_with("mixer.") && matches!(*name, "strip" | "track" | "target" | "output"))
        .map(|name| (name, "props.name"))
        .collect();
    let leaked: Names = Box::leak(found.into_boxed_slice());
    table.insert(id.to_owned(), leaked);
    leaked
}

/// The type each of the targets and object parameters of command `id` names (kition-sdk
/// `KitCommand::object_types`, C8-fix-9): a whole number naming an object of another type there is
/// no premise.
pub fn object_types(id: &str, targets: Option<&str>, objects: &[&str]) -> &'static [(&'static str, &'static [&'static str])] {
    type Types = &'static [(&'static str, &'static [&'static str])];
    static TABLE: OnceLock<std::sync::Mutex<HashMap<String, Types>>> = OnceLock::new();
    let mut table = TABLE.get_or_init(|| std::sync::Mutex::new(HashMap::new())).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = table.get(id) {
        return found;
    }
    let found: Vec<(&'static str, &'static [&'static str])> = targets
        .into_iter()
        .chain(objects.iter().copied())
        .chain((id == "audio.voiceover.start").then_some("track"))
        .filter_map(|name| {
            let ty: &'static str = object_type(id, name)?;
            let types = if matches!(id, "project.delete" | "project.select") && name == "items" { vec!["Item", "Bin"] } else { vec![ty] };
            Some((&*Box::leak(name.to_owned().into_boxed_str()), &*Box::leak(types.into_boxed_slice())))
        })
        .collect();
    let leaked: Types = Box::leak(found.into_boxed_slice());
    table.insert(id.to_owned(), leaked);
    leaked
}
