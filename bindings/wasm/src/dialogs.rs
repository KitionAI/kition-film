//! What upstream's clip dialogs open with (`panels/clip_dialogs.rs` `defaults()`), for the dialogs
//! whose draft reads session state `inspect()` does not show: the copied clips (Paste
//! Attributes), the standard effects of the clips a dialog acts on (Paste and Remove
//! Attributes), a clip's frame hold (Frame Hold Options), and, for the clip structure dialogs
//! (Task 12), what upstream reads from the session for Nest, Make and Edit Subclip, Audio
//! Channels, Modify Timecode, New and Edit Offline File, Synchronize, and Merge Clips, and (Task
//! 13) the sequence settings Sequence Settings, New Sequence, and Color Management open with and
//! compare with. [`FilmDocument::dialog_defaults`]
//! answers upstream's two values, the draft (`params`, the JSON the command takes) and what the
//! dialog shows beside it (`info`), as upstream's `ClipDialogDraft` keeps them. It reads and never
//! changes anything.

use kition_film_color::{ColorPipeline, WorkingSpace};
use kition_film_engine::Session;
use kition_film_engine::clip_ops::subclip_defaults;
use kition_film_engine::commands::next_nested_name;
use kition_film_engine::project::graphic::is_layer_id;
use kition_film_engine::project::{AudioChannelMap, AudioChannels, EffectInstance, ItemKind, MediaRef, SequenceSettings, TrackKind};
use kition_film_engine::project_tools::{OFFLINE_FIELDS, RENDERER_GPU, RENDERER_SOFTWARE, general_json};
use kition_film_engine::time::{FrameRate, TimeDisplay, format_timecode_frames};
use kition_film_media::Generator;
use serde_json::{Value, json};

use crate::FilmDocument;

/// The commands [`FilmDocument::dialog_defaults`] answers for.
pub const DIALOG_DEFAULTS: &[&str] = &[
    "edit.pasteAttributes",
    "edit.removeAttributes",
    "clip.frameHoldOptions",
    "clip.fieldOptions",
    // Task 12: clip structure dialogs
    "clip.nest",
    "clip.makeSubclip",
    "clip.editSubclip",
    "clip.audioChannels",
    "clip.setTimecode",
    "item.newOfflineFile",
    "clip.editOffline",
    "clip.synchronize",
    "clip.mergeClips",
    // Task 13: Sequence Settings, New Sequence, and Sequence ▸ Color Management
    "sequence.settings",
    "sequence.new",
    "sequence.colorSettings",
    // Task 14: Add Tracks, Simplify Sequence, New Color Matte, and Color Matte Color
    "sequence.addTracks",
    "sequence.simplify",
    "item.newColorMatte",
    "project.matteColor",
    // Task 15: Find and Automate to Sequence
    "edit.find",
    "clip.automateToSequence",
    // Task 16: Project Settings (General, and Ingest Settings on its tab)
    "file.projectSettings.general",
    "project.ingestSettings",
];

impl FilmDocument {
    /// Upstream's `defaults()` for `command`'s dialog on the document as it is: `{params, info}`.
    ///
    /// - `edit.pasteAttributes` and `edit.removeAttributes`: the intrinsic attributes checked by
    ///   the kinds of clip copied (Paste) or selected (Remove), video (`motion`, `opacity`,
    ///   `timeRemapping`) and audio (`volume`, `channelVolume`, `panner`), every standard effect
    ///   of those clips in `effects` (Paste also `scaleTimes`: true); `info` is `{video, audio,
    ///   effects: [[id, name]]}`, each effect once, graphic layers left out.
    /// - `clip.frameHoldOptions`: `enabled` (the first selected clip holds a frame, or no clip is
    ///   selected), `holdOn` `"in"`, `timecode` (the held frame, else the clip's source In, at its
    ///   media's rate), and `holdFilters`; `info` is null.
    /// - `clip.fieldOptions`: `{reverseFieldDominance: false, processing: "none"}`; `info` is null.
    /// - `clip.nest`: the next free `Nested Sequence NN` name.
    /// - `clip.makeSubclip`: the name, `startFrame`, and `endFrame` of what would be subclipped
    ///   (engine `subclip_defaults`, null each without one) and `restrictTrims`; `info` `{fps}`.
    /// - `clip.editSubclip`: the Project panel's first subclip, `{item, startFrame, endFrame,
    ///   restrictTrims, convertToMaster: false}` at its parent's media rate; `info` `{name, fps}`
    ///   (`{}` and null without one).
    /// - `clip.audioChannels`: the first selected item with audio, its `format` and `clips` (its
    ///   own map, else stereo pairs), `info` `{channels, items: true}`; else `{channels: [0, 1]}`
    ///   for the timeline's audio clips, `info` `{channels: 2, items: false}`.
    /// - `clip.setTimecode`: the first selected media item's start `timecode` and `tapeName`.
    /// - `item.newOfflineFile`: upstream's file, the active sequence's size and rate, 10 s.
    /// - `clip.editOffline`: the first selected item, its `mediaName` and offline fields.
    /// - `clip.synchronize` and `clip.mergeClips`: upstream's `SyncDraft` (`items` the Project
    ///   selection, `name` `"<first> - Merged"` for Merge, `method` `"audio"`, …); `info`
    ///   `{names}`, the items' names.
    /// - `sequence.settings` and `sequence.new` (upstream `sequence_settings.rs` `open` and
    ///   `open_new`): the draft `{tab, name, newSequence, video, audio, fpsNum, fpsDen, width,
    ///   height, scaleMotion, dropFrame, mix, sampleRate, maxRenderQuality, workingSpace,
    ///   wideGamut, autoToneMap}` of the active sequence (New Sequence: the default settings,
    ///   named as `sequence.new` names one); `info` is what `show()` compares the draft with
    ///   (`current`: the same keys and the name, blank for New Sequence) and what the greyed rows
    ///   show (`par`, `previewCodec`, `maxBitDepth`, `audioDisplaySamples`), with the
    ///   `timebases` (`{num, den, label, dropFrame}`, upstream's 15 and the draft's own rate
    ///   first when it is not one of them) and the `workingSpaces` (`[id, label]`).
    /// - `sequence.colorSettings` (upstream `color_dialogs.rs` `open_sequence`): the active
    ///   sequence's `{workingSpace, wideGamut, autoToneMap}` (Rec. 709 without one); `info`
    ///   `{workingSpaces}`.
    /// - `sequence.addTracks` (upstream `menus.rs`' route and `dialogs.rs` `add_tracks`): one video
    ///   and one audio track (standard) after the last ones, no submix track (stereo), `{video,
    ///   videoAfter, audio, audioAfter, audioType, submix, submixAfter, submixType}`; `info` is
    ///   `{tracks: {video, audio, submix}}` (the active sequence's track names, which Placement
    ///   lists) and `current` (`{videoAfter, audioAfter, submixAfter}`, what the draft was read
    ///   against).
    /// - `sequence.simplify` (upstream `menu_dialogs.rs` `defaults`): `name` `"<sequence>
    ///   (Simplified)"` (blank without one) and upstream's remove options, `keep` `"both"`; `info`
    ///   `{current: {name}}`.
    /// - `item.newColorMatte`: black, named "Color Matte", the active sequence's size (the
    ///   default settings' without one), 5 s; `info` is null.
    /// - `project.matteColor`: the one Color Matte selected in the Project panel, `{item, color}`
    ///   (`#rrggbb`); `info` `{current: {color}}`. With anything else selected it is upstream's
    ///   error, "select one Color Matte".
    /// - `edit.find` (upstream `menu_dialogs.rs` `defaults`): `{scope: "project", rows, matchAll:
    ///   true, caseSensitive: false, in: "all"}`, the rows the last project Find searched (blank
    ///   Name / contains rows otherwise), at least two; `info` is `{}`. The editor picks the scope:
    ///   upstream opens on the Timeline while the Timeline panel has focus and a sequence is open.
    /// - `clip.automateToSequence`: upstream's draft (sort order, sequentially, insert, 30 frames of
    ///   overlap, 150 frames per still, both default transitions, nothing ignored); `info`
    ///   `{sequence}`, the active sequence's name (null without one).
    /// - `file.projectSettings.general` and `project.ingestSettings` (upstream `menu_dialogs.rs`
    ///   `defaults` for `project.settings`): `{tab, renderer, videoDisplay, audioDisplay,
    ///   captureFormat, titleSafe, actionSafe, ingest}`, the tab `general` or `ingest` by the
    ///   command, the rest as `file.projectSettings.general` answers them and the project's
    ///   ingest settings (`{enabled, action, destination, preset}`); `info` is `{project,
    ///   ingest, renderers, videoDisplays, current}`, `current` the same keys without the tab
    ///   (what OK compares with). Scratch Disks is hidden on the web, so its folders are not read.
    ///
    /// Any other command is an error.
    pub fn dialog_defaults(&self, command: &str) -> Result<Value, String> {
        let s = &self.session;
        let (params, info) = match command {
            "edit.pasteAttributes" | "edit.removeAttributes" => attributes(s, command == "edit.pasteAttributes"),
            "clip.frameHoldOptions" => (frame_hold(s), Value::Null),
            "clip.fieldOptions" => (json!({ "reverseFieldDominance": false, "processing": "none" }), Value::Null),
            "clip.nest" => (json!({ "name": next_nested_name(s) }), Value::Null),
            "clip.makeSubclip" => {
                let d = subclip_defaults(s, &json!({})).unwrap_or_else(|| json!({}));
                (json!({ "name": d["name"], "startFrame": d["startFrame"], "endFrame": d["endFrame"], "restrictTrims": true }), json!({ "fps": d["fps"] }))
            }
            "clip.editSubclip" => edit_subclip(s),
            "clip.audioChannels" => audio_channels(s),
            "clip.setTimecode" => (modify_timecode(s), Value::Null),
            "item.newOfflineFile" => (offline_file(s), Value::Null),
            "clip.editOffline" => (edit_offline(s), Value::Null),
            "clip.synchronize" | "clip.mergeClips" => sync_draft(s, command == "clip.mergeClips"),
            "sequence.settings" | "sequence.new" => sequence_settings(s, command == "sequence.new"),
            "sequence.colorSettings" => colour_settings(s),
            "sequence.addTracks" => add_tracks(s),
            "sequence.simplify" => simplify(s),
            "item.newColorMatte" => new_color_matte(s),
            "project.matteColor" => matte_color(s)?,
            "edit.find" => (find(s), json!({})),
            "clip.automateToSequence" => automate(s),
            "file.projectSettings.general" | "project.ingestSettings" => project_settings(s, command == "project.ingestSettings"),
            _ => return Err(format!("`{command}` has no dialog defaults here (only {})", DIALOG_DEFAULTS.join(", "))),
        };
        Ok(json!({ "params": params, "info": info }))
    }
}

/// Paste (`paste`) or Remove Attributes: the clipboard's or the selection's kinds and standard effects.
fn attributes(s: &Session, paste: bool) -> (Value, Value) {
    let mut names: Vec<(String, String)> = Vec::new();
    let mut add = |effect: &EffectInstance| {
        if let Some(def) = effect.def().filter(|def| !def.intrinsic && !is_layer_id(def.id))
            && !names.iter().any(|name| name.0 == def.id)
        {
            names.push((def.id.to_string(), def.name.to_string()));
        }
    };
    let mut video = false;
    let mut audio = false;
    if paste {
        for (kind, _, item) in &s.state.clipboard {
            video |= *kind == TrackKind::Video;
            audio |= *kind == TrackKind::Audio;
            item.effects.iter().for_each(&mut add);
        }
    } else if let Some(sequence) = s.active_sequence() {
        for clip in &s.state.selection {
            if let Some((track, item)) = sequence.find_item(*clip) {
                let on_video = sequence.video_tracks.iter().any(|t| t.id == track);
                video |= on_video;
                audio |= !on_video;
                item.effects.iter().for_each(&mut add);
            }
        }
    }
    let mut params = json!({
        "motion": video, "opacity": video, "timeRemapping": video,
        "volume": audio, "channelVolume": audio, "panner": audio,
        "effects": names.iter().map(|name| name.0.clone()).collect::<Vec<_>>(),
    });
    if paste {
        params["scaleTimes"] = json!(true);
    }
    (params, json!({ "video": video, "audio": audio, "effects": names.iter().map(|(id, name)| json!([id, name])).collect::<Vec<_>>() }))
}

/// Frame Hold Options: the first selected clip's hold, as upstream reads it.
fn frame_hold(s: &Session) -> Value {
    let clip = s.active_sequence().and_then(|sequence| s.state.selection.iter().find_map(|c| sequence.find_item(*c).map(|found| found.1.clone())));
    let enabled = clip.as_ref().is_none_or(|it| it.frame_hold.is_some());
    let hold_filters = clip.as_ref().is_some_and(|it| it.hold_filters);
    let timecode = clip.as_ref().map_or_else(
        || "00:00:00:00".to_string(),
        |it| {
            let rate = s.project.item(it.item).and_then(|item| item.as_media()).map(|media| media.frame_rate()).unwrap_or_default();
            format_timecode_frames(rate.frame_at(it.frame_hold.unwrap_or(it.source_in)), rate, false)
        },
    );
    json!({ "enabled": enabled, "holdOn": "in", "timecode": timecode, "holdFilters": hold_filters })
}

/// Edit Subclip: the Project panel's first subclip, in its parent's media frames.
fn edit_subclip(s: &Session) -> (Value, Value) {
    let sub = s.state.project_selection.iter().find_map(|i| s.project.item(*i).filter(|it| matches!(it.kind, ItemKind::Subclip { .. })));
    let Some(it) = sub else { return (json!({}), Value::Null) };
    let ItemKind::Subclip { parent, range, restrict_trims } = &it.kind else { return (json!({}), Value::Null) };
    let rate = s.project.item(*parent).and_then(|p| p.as_media()).map(|m| m.frame_rate()).unwrap_or_default();
    (
        json!({ "item": it.id.0, "startFrame": rate.frame_at(range.start), "endFrame": rate.frame_at(range.end()), "restrictTrims": restrict_trims, "convertToMaster": false }),
        json!({ "name": it.name, "fps": rate.as_f64() }),
    )
}

/// Upstream's `format_name`.
fn format_name(format: AudioChannels) -> &'static str {
    match format {
        AudioChannels::Mono => "mono",
        AudioChannels::Stereo => "stereo",
        AudioChannels::Surround51 => "5.1",
        AudioChannels::Adaptive => "adaptive",
    }
}

/// Audio Channels: the first selected item with audio and its map, else the timeline clips' form.
fn audio_channels(s: &Session) -> (Value, Value) {
    let item = s.state.project_selection.iter().find_map(|i| s.project.item(*i).and_then(|it| it.as_media()).filter(|m| m.info.has_audio()));
    match item {
        Some(m) => {
            let n = m.info.audio().map_or(2, |a| a.channels) as u16;
            let map = m.interpret.audio_channels.clone().unwrap_or_else(|| AudioChannelMap::for_format(AudioChannels::Stereo, n));
            (json!({ "format": format_name(map.format), "clips": map.clips }), json!({ "channels": n, "items": true }))
        }
        None => (json!({ "channels": [0, 1] }), json!({ "channels": 2, "items": false })),
    }
}

/// Modify Timecode: the first selected media item's start timecode and tape name.
fn modify_timecode(s: &Session) -> Value {
    let it = s.state.project_selection.iter().find_map(|i| s.project.item(*i).and_then(|it| Some((it, it.as_media()?))));
    let (timecode, tape) = it
        .map(|(it, m)| {
            (format_timecode_frames(m.info.start_timecode.unwrap_or(0), m.frame_rate(), false), it.metadata.get("Tape Name").cloned().unwrap_or_default())
        })
        .unwrap_or_else(|| ("00:00:00:00".into(), String::new()));
    json!({ "timecode": timecode, "tapeName": tape })
}

/// New Offline File: upstream's file name and the active sequence's picture.
fn offline_file(s: &Session) -> Value {
    let st = s.active_sequence().map(|q| q.settings.clone()).unwrap_or_default();
    json!({
        "fileName": "Offline.mov", "name": "", "tapeName": "", "description": "", "video": true, "audio": true,
        "width": st.width, "height": st.height, "fps": st.frame_rate.as_f64(), "timecode": "00:00:00:00", "seconds": 10.0,
    })
}

/// Edit Offline File: the first selected item's name and offline fields.
fn edit_offline(s: &Session) -> Value {
    let mut p = json!({});
    if let Some(it) = s.state.project_selection.first().and_then(|i| s.project.item(*i)) {
        p["item"] = json!(it.id.0);
        p["mediaName"] = json!(it.name);
        for (key, field) in OFFLINE_FIELDS {
            p[key] = json!(it.metadata.get(field).cloned().unwrap_or_default());
        }
    }
    p
}

/// Synchronize and Merge Clips (`multicam.rs` `route`): upstream's `SyncDraft` for the Project selection.
fn sync_draft(s: &Session, merge: bool) -> (Value, Value) {
    let items: Vec<u64> = s.state.project_selection.iter().map(|i| i.0).collect();
    let names: Vec<String> = s.state.project_selection.iter().filter_map(|i| s.project.item(*i).map(|it| it.name.clone())).collect();
    let first = s.state.project_selection.first().and_then(|i| s.project.item(*i)).map(|it| it.name.clone()).unwrap_or_default();
    let name = if merge { format!("{first} - Merged") } else { String::new() };
    (
        json!({ "items": items, "name": name, "method": "audio", "ignoreHours": false, "marker": "", "offset": 0, "track": "", "removeVideoAudio": false }),
        json!({ "names": names }),
    )
}

/// Upstream's Timebase list (`sequence_settings.rs` `TIMEBASES`), frames per second as num/den.
const TIMEBASES: [(i64, i64); 15] = [
    (10, 1),
    (12, 1),
    (25, 2),
    (15, 1),
    (24_000, 1001),
    (24, 1),
    (25, 1),
    (30_000, 1001),
    (30, 1),
    (48, 1),
    (50, 1),
    (60_000, 1001),
    (60, 1),
    (120_000, 1001),
    (120, 1),
];

/// The working colour spaces, `[id, label]` (upstream's `WorkingSpace::ALL`).
fn working_spaces() -> Value {
    json!(WorkingSpace::ALL.iter().map(|w| json!([w.id(), w.label()])).collect::<Vec<_>>())
}

/// The draft's keys upstream's `changes()` compares, for `st` named `name`.
fn settings_keys(st: &SequenceSettings, name: &str) -> Value {
    let rate = st.frame_rate.sane();
    json!({
        "name": name, "fpsNum": rate.num, "fpsDen": rate.den, "width": st.width, "height": st.height,
        "dropFrame": st.drop_frame && rate.supports_drop_frame(), "mix": channels_name(st.audio_master), "sampleRate": st.sample_rate,
        "maxRenderQuality": st.max_render_quality, "workingSpace": st.color.working.id(), "wideGamut": st.color.wide_gamut, "autoToneMap": st.color.auto_tone_map,
    })
}

/// Upstream's `mix_name`.
fn channels_name(c: AudioChannels) -> &'static str {
    match c {
        AudioChannels::Mono => "Mono",
        AudioChannels::Stereo => "Stereo",
        AudioChannels::Surround51 => "5.1",
        AudioChannels::Adaptive => "Adaptive",
    }
}

/// Sequence Settings (`new_sequence` false) and New Sequence: upstream's `open` and `open_new`.
fn sequence_settings(s: &Session, new_sequence: bool) -> (Value, Value) {
    let (st, name, current_name) = if new_sequence {
        (SequenceSettings::default(), format!("Sequence {:02}", s.project.sequences().count() + 1), String::new())
    } else {
        let st = s.active_sequence().map(|q| q.settings.clone()).unwrap_or_default();
        let name = s.state.active_sequence.and_then(|id| s.project.item(id)).map(|i| i.name.clone()).unwrap_or_default();
        (st, name.clone(), name)
    };
    let mut params = settings_keys(&st, &name);
    params["tab"] = json!("general");
    params["newSequence"] = json!(new_sequence);
    params["video"] = json!(3);
    params["audio"] = json!(3);
    params["scaleMotion"] = json!(true);
    let rate = st.frame_rate.sane();
    let mut rates: Vec<FrameRate> = TIMEBASES.iter().map(|&(num, den)| FrameRate { num, den }).collect();
    if !rates.iter().any(|r| (r.num, r.den) == (rate.num, rate.den)) {
        rates.insert(0, rate);
    }
    let timebases: Vec<Value> = rates.iter().map(|r| json!({ "num": r.num, "den": r.den, "label": r.label(), "dropFrame": r.supports_drop_frame() })).collect();
    let info = json!({
        "current": settings_keys(&st, &current_name),
        "par": [st.par.0, st.par.1],
        "previewCodec": st.preview_codec,
        "maxBitDepth": st.max_bit_depth,
        "audioDisplaySamples": s.project.settings.audio_display_samples,
        "timebases": timebases,
        "workingSpaces": working_spaces(),
    });
    (params, info)
}

/// Sequence ▸ Color Management (upstream `color_dialogs.rs` `open_sequence`).
fn colour_settings(s: &Session) -> (Value, Value) {
    let c = s.active_sequence().map(|q| q.settings.color).unwrap_or(ColorPipeline::REC709);
    (json!({ "workingSpace": c.working.id(), "wideGamut": c.wide_gamut, "autoToneMap": c.auto_tone_map }), json!({ "workingSpaces": working_spaces() }))
}

/// Add Tracks: upstream's `AddTracksDraft` placed after the active sequence's last tracks, and their names.
fn add_tracks(s: &Session) -> (Value, Value) {
    let names = |tracks: &[kition_film_engine::project::Track]| tracks.iter().map(|t| t.name.clone()).collect::<Vec<_>>();
    let (video, audio, submix) =
        s.active_sequence().map_or_else(Default::default, |q| (names(&q.video_tracks), names(&q.audio_tracks), names(&q.submix_tracks)));
    let after = json!({ "videoAfter": video.len(), "audioAfter": audio.len(), "submixAfter": submix.len() });
    (
        json!({
            "video": 1, "videoAfter": video.len(), "audio": 1, "audioAfter": audio.len(), "audioType": "standard",
            "submix": 0, "submixAfter": submix.len(), "submixType": "stereo",
        }),
        json!({ "tracks": { "video": video, "audio": audio, "submix": submix }, "current": after }),
    )
}

/// Simplify Sequence: the copy's name and upstream's remove options.
fn simplify(s: &Session) -> (Value, Value) {
    let name = s.state.active_sequence.and_then(|q| s.project.item(q)).map(|i| format!("{} (Simplified)", i.name)).unwrap_or_default();
    (
        json!({
            "name": name, "removeDisabled": true, "removeEmptyTracks": true, "closeGaps": false, "moveClipsDown": false,
            "removeVideoEffects": false, "removeAudioEffects": false, "removeText": false, "keep": "both",
        }),
        json!({ "current": { "name": name } }),
    )
}

/// New Color Matte: black, at the active sequence's size, 5 s.
fn new_color_matte(s: &Session) -> (Value, Value) {
    let st = s.active_sequence().map(|q| q.settings.clone()).unwrap_or_default();
    (json!({ "color": "#000000", "name": "Color Matte", "width": st.width, "height": st.height, "seconds": 5.0 }), Value::Null)
}

/// Color Matte Color: the one Color Matte selected in the Project panel and its colour, or upstream's error.
fn matte_color(s: &Session) -> Result<(Value, Value), String> {
    let matte = match s.state.project_selection.as_slice() {
        [id] => s.project.item(*id).and_then(|it| match &it.kind {
            ItemKind::Media(m) => match &m.media {
                MediaRef::Generator(Generator::ColorMatte { color }) => Some((it.id, *color)),
                _ => None,
            },
            _ => None,
        }),
        _ => None,
    };
    let (id, color) = matte.ok_or("select one Color Matte")?;
    let hex = kition_film_color::to_hex(color);
    Ok((json!({ "item": id.0, "color": hex }), json!({ "current": { "color": hex } })))
}

/// Find: the last project Find's rows (blank Name / contains rows otherwise), at least two.
fn find(s: &Session) -> Value {
    let blank = || json!({ "column": "Name", "operator": "contains", "text": "" });
    let mut rows: Vec<Value> = match &s.state.find {
        Some(f) if f.scope == "project" => f.query.rows.iter().map(|r| json!({ "column": r.column, "operator": r.op.name(), "text": r.text })).collect(),
        _ => vec![blank()],
    };
    while rows.len() < 2 {
        rows.push(blank());
    }
    json!({ "scope": "project", "rows": rows, "matchAll": true, "caseSensitive": false, "in": "all" })
}

/// Automate to Sequence: upstream's draft, and the sequence it places into.
fn automate(s: &Session) -> (Value, Value) {
    let sequence = s.active_sequence().map(|_| s.state.active_sequence.and_then(|q| s.project.item(q)).map(|i| i.name.clone()).unwrap_or_default());
    (
        json!({
            "ordering": "sort", "placement": "sequentially", "method": "insert", "overlapFrames": 30, "stillFrames": 150,
            "videoTransition": true, "audioTransition": true, "ignoreAudio": false, "ignoreVideo": false,
        }),
        json!({ "sequence": sequence }),
    )
}

/// Project Settings: the General tab's settings and Ingest's, opened on `ingest` or General.
fn project_settings(s: &Session, ingest: bool) -> (Value, Value) {
    let settings = &s.project.settings;
    let mut current = general_json(settings);
    if let Some(fields) = current.as_object_mut() {
        fields.remove("renderers");
    }
    let ingest_settings = serde_json::to_value(&settings.ingest).unwrap_or_default();
    current["ingest"] = ingest_settings.clone();
    let mut params = current.clone();
    params["tab"] = json!(if ingest { "ingest" } else { "general" });
    let displays: Vec<&str> = TimeDisplay::ALL.iter().map(|display| display.label()).collect();
    let info = json!({
        "project": s.project.name, "ingest": ingest_settings, "renderers": [RENDERER_GPU, RENDERER_SOFTWARE],
        "videoDisplays": displays, "current": current,
    });
    (params, info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{HOST_ROOT, tone_wav};
    use kition_kit::KitDocument;
    use std::sync::PoisonError;

    /// What a read must leave alone: the replica version, the history, the inspected state, and the revision.
    fn state(doc: &mut FilmDocument) -> (Vec<u8>, Value, Value, u64) {
        let history = doc.session.execute("history.list", json!({})).unwrap();
        (doc.version().unwrap(), history, doc.inspect().unwrap(), doc.session.revision)
    }

    /// A 64 × 36 project with a 4 s red matte on V1 (selected) and one second of tone on A1.
    fn with_clips(body: impl FnOnce(&mut FilmDocument, u64, u64)) {
        let _lock = HOST_ROOT.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-film-dialogs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tone.wav"), tone_wav()).unwrap();
        kition_kit::host::set_root(Some(dir.clone()));
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let matte = doc.execute("item.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": ["tone.wav"] })).unwrap();
        doc.execute("timeline.place", json!({ "item": imported["items"][0], "track": "A1", "seconds": 0.0 })).unwrap();
        let inspected = doc.inspect().unwrap();
        let video = inspected["sequence"]["video"][0]["items"][0]["clip"].as_u64().unwrap();
        let audio = inspected["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
        body(&mut doc, video, audio);
        kition_kit::host::set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn paste_attributes_offers_the_copied_clips_kinds_and_standard_effects() {
        with_clips(|doc, video, _| {
            doc.execute("effect.apply", json!({ "clips": [video], "effect": "gaussian_blur" })).unwrap();
            doc.execute("timeline.select", json!({ "clips": [video], "linked": false })).unwrap();
            doc.execute("edit.copy", json!({})).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("edit.pasteAttributes").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let params = &shown["params"];
            for key in ["motion", "opacity", "timeRemapping", "scaleTimes"] {
                assert_eq!(params[key], true, "{key} in {shown}");
            }
            for key in ["volume", "channelVolume", "panner"] {
                assert_eq!(params[key], false, "{key} in {shown}");
            }
            assert_eq!(params["effects"], json!(["gaussian_blur"]));
            assert_eq!(shown["info"]["video"], true);
            assert_eq!(shown["info"]["audio"], false);
            assert_eq!(shown["info"]["effects"], json!([["gaussian_blur", "Gaussian Blur"]]), "each effect once, no intrinsic one");
        });
    }

    #[test]
    fn paste_attributes_with_nothing_copied_offers_nothing() {
        with_clips(|doc, _, _| {
            let shown = doc.dialog_defaults("edit.pasteAttributes").unwrap();
            assert_eq!(shown["info"], json!({ "video": false, "audio": false, "effects": [] }));
            assert_eq!(shown["params"]["motion"], false);
            assert_eq!(shown["params"]["scaleTimes"], true);
        });
    }

    #[test]
    fn remove_attributes_reads_the_selected_clips_without_scale_times() {
        with_clips(|doc, video, audio| {
            doc.execute("effect.apply", json!({ "clips": [audio], "effect": "parametric_eq" })).unwrap();
            doc.execute("timeline.select", json!({ "clips": [audio], "linked": false })).unwrap();
            let shown = doc.dialog_defaults("edit.removeAttributes").unwrap();
            assert_eq!(shown["params"]["volume"], true);
            assert_eq!(shown["params"]["motion"], false);
            assert!(shown["params"].get("scaleTimes").is_none(), "{shown}");
            assert_eq!(shown["info"]["effects"].as_array().map(Vec::len), Some(1), "{shown}");
            assert_eq!(shown["info"]["effects"][0][0], "parametric_eq");
            doc.execute("timeline.select", json!({ "clips": [video, audio], "linked": false })).unwrap();
            let both = doc.dialog_defaults("edit.removeAttributes").unwrap();
            assert_eq!((both["info"]["video"].clone(), both["info"]["audio"].clone()), (json!(true), json!(true)));
        });
    }

    #[test]
    fn frame_hold_options_read_the_first_selected_clips_hold() {
        with_clips(|doc, video, _| {
            doc.execute("timeline.select", json!({ "clips": [], "linked": false })).unwrap();
            let none = doc.dialog_defaults("clip.frameHoldOptions").unwrap();
            assert_eq!(
                none["params"],
                json!({ "enabled": true, "holdOn": "in", "timecode": "00:00:00:00", "holdFilters": false }),
                "no clip: upstream's defaults"
            );
            doc.execute("timeline.select", json!({ "clips": [video], "linked": false })).unwrap();
            let unheld = doc.dialog_defaults("clip.frameHoldOptions").unwrap();
            assert_eq!(unheld["params"]["enabled"], false, "a clip that holds nothing opens unchecked");
            assert_eq!(unheld["params"]["holdFilters"], false);
            doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
            doc.execute("clip.frameHoldOptions", json!({ "clips": [video], "holdOn": "playhead", "holdFilters": true })).unwrap();
            let held = doc.dialog_defaults("clip.frameHoldOptions").unwrap();
            assert_eq!(held["params"]["enabled"], true);
            assert_eq!(held["params"]["holdFilters"], true);
            assert_eq!(held["params"]["holdOn"], "in");
            let timecode = held["params"]["timecode"].as_str().unwrap();
            assert!(timecode.starts_with("00:00:01:") || timecode.starts_with("00:00:00:"), "the held frame, about 1 s in: {timecode}");
            assert_ne!(timecode, "00:00:00:00", "the held frame, not the source In: {held}");
        });
    }

    // ---- Task 12: clip structure dialogs

    /// `with_clips`'s tone item (the second in the project).
    fn tone_item(doc: &FilmDocument, audio: u64) -> u64 {
        doc.session.active_sequence().unwrap().find_item(kition_film_engine::project::ClipId(audio)).unwrap().1.item.0
    }

    #[test]
    fn nest_opens_on_the_next_free_nested_sequence_name() {
        with_clips(|doc, video, _| {
            doc.execute("timeline.select", json!({ "clips": [video], "linked": false })).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("clip.nest").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(shown, json!({ "params": { "name": "Nested Sequence 01" }, "info": null }));
            doc.execute("clip.nest", json!({})).unwrap();
            assert_eq!(doc.dialog_defaults("clip.nest").unwrap()["params"]["name"], "Nested Sequence 02");
        });
    }

    #[test]
    fn make_subclip_opens_on_the_selected_clips_range_and_edit_subclip_on_the_subclips() {
        with_clips(|doc, _, audio| {
            doc.execute("timeline.select", json!({ "clips": [audio], "linked": false })).unwrap();
            let before = state(doc);
            let made = doc.dialog_defaults("clip.makeSubclip").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let engine = subclip_defaults(&doc.session, &json!({})).unwrap();
            assert_eq!(made["params"]["name"], engine["name"], "what the engine would subclip: {made}");
            assert!(made["params"]["name"].as_str().unwrap().ends_with(".Subclip"));
            assert_eq!(made["params"]["startFrame"], 0);
            assert!(made["params"]["endFrame"].as_i64().unwrap() > 0, "{made}");
            assert_eq!(made["params"]["restrictTrims"], true);
            assert!(made["info"]["fps"].as_f64().unwrap() > 0.0, "{made}");
            // Nothing to subclip (a new document): upstream's empty answer, Restrict Trims still on.
            let empty = FilmDocument::create("Empty.kfilm", 64, 36).unwrap();
            let none = empty.dialog_defaults("clip.makeSubclip").unwrap();
            assert_eq!(none["params"], json!({ "name": null, "startFrame": null, "endFrame": null, "restrictTrims": true }));
            // Edit Subclip: the Project panel's first subclip.
            let tone = tone_item(doc, audio);
            let sub = doc
                .execute("clip.makeSubclip", json!({ "item": tone, "startFrame": 4, "endFrame": 20, "name": "Short", "restrictTrims": false }))
                .unwrap()["item"]
                .as_u64()
                .unwrap();
            doc.execute("project.select", json!({ "items": [sub] })).unwrap();
            let edit = doc.dialog_defaults("clip.editSubclip").unwrap();
            assert_eq!(edit["params"], json!({ "item": sub, "startFrame": 4, "endFrame": 20, "restrictTrims": false, "convertToMaster": false }), "{edit}");
            assert_eq!(edit["info"]["name"], "Short");
            doc.execute("project.select", json!({ "items": [tone] })).unwrap();
            assert_eq!(doc.dialog_defaults("clip.editSubclip").unwrap(), json!({ "params": {}, "info": null }), "no subclip selected");
        });
    }

    #[test]
    fn audio_channels_open_on_the_items_map_or_the_timeline_clips_channels() {
        with_clips(|doc, _, audio| {
            let tone = tone_item(doc, audio);
            doc.execute("project.select", json!({ "items": [tone] })).unwrap();
            let before = state(doc);
            let item = doc.dialog_defaults("clip.audioChannels").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(
                item,
                json!({ "params": { "format": "stereo", "clips": [[0]] }, "info": { "channels": 1, "items": true } }),
                "a mono file, mapped as stereo by default"
            );
            doc.execute("clip.audioChannels", json!({ "items": [tone], "format": "mono", "clips": [[0]] })).unwrap();
            assert_eq!(doc.dialog_defaults("clip.audioChannels").unwrap()["params"]["format"], "mono", "the item's own map");
            doc.execute("project.select", json!({ "items": [] })).unwrap();
            assert_eq!(
                doc.dialog_defaults("clip.audioChannels").unwrap(),
                json!({ "params": { "channels": [0, 1] }, "info": { "channels": 2, "items": false } })
            );
        });
    }

    #[test]
    fn modify_timecode_and_offline_files_open_on_upstreams_drafts() {
        with_clips(|doc, _, audio| {
            let tone = tone_item(doc, audio);
            doc.execute("project.select", json!({ "items": [tone] })).unwrap();
            let before = state(doc);
            assert_eq!(doc.dialog_defaults("clip.setTimecode").unwrap(), json!({ "params": { "timecode": "00:00:00:00", "tapeName": "" }, "info": null }));
            let offline = doc.dialog_defaults("item.newOfflineFile").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let params = &offline["params"];
            assert_eq!(
                (params["fileName"].clone(), params["name"].clone(), params["timecode"].clone(), params["seconds"].clone()),
                (json!("Offline.mov"), json!(""), json!("00:00:00:00"), json!(10.0))
            );
            assert_eq!(
                (params["video"].clone(), params["audio"].clone(), params["width"].clone(), params["height"].clone()),
                (json!(true), json!(true), json!(64), json!(36))
            );
            assert!(params["fps"].as_f64().unwrap() > 0.0);
            let lost = doc.execute("item.newOfflineFile", json!({ "name": "Lost", "tapeName": "T1" })).unwrap()["item"].as_u64().unwrap();
            doc.execute("project.select", json!({ "items": [lost] })).unwrap();
            let edit = doc.dialog_defaults("clip.editOffline").unwrap();
            assert_eq!(
                edit["params"],
                json!({ "item": lost, "mediaName": "Lost", "tapeName": "T1", "description": "", "scene": "", "shot": "", "logNote": "" }),
                "{edit}"
            );
        });
    }

    #[test]
    fn synchronize_and_merge_clips_open_on_upstreams_sync_draft() {
        with_clips(|doc, video, audio| {
            let tone = tone_item(doc, audio);
            let matte = doc.session.active_sequence().unwrap().find_item(kition_film_engine::project::ClipId(video)).unwrap().1.item.0;
            doc.execute("project.select", json!({ "items": [matte, tone] })).unwrap();
            let before = state(doc);
            let merge = doc.dialog_defaults("clip.mergeClips").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let name = doc.session.project.item(kition_film_engine::project::ItemId(matte)).unwrap().name.clone();
            assert_eq!(
                merge["params"],
                json!({ "items": [matte, tone], "name": format!("{name} - Merged"), "method": "audio", "ignoreHours": false, "marker": "", "offset": 0, "track": "", "removeVideoAudio": false })
            );
            assert_eq!(merge["info"]["names"], json!([name, "tone.wav"]));
            let sync = doc.dialog_defaults("clip.synchronize").unwrap();
            assert_eq!(sync["params"]["name"], "", "Synchronize has no name");
            assert_eq!(sync["params"]["method"], "audio");
        });
    }

    #[test]
    fn sequence_settings_opens_on_the_active_sequence_as_upstreams_open() {
        with_clips(|doc, _, _| {
            doc.execute(
                "sequence.settings",
                json!({ "fps": 30_000.0 / 1001.0, "dropFrame": true, "mix": "5.1", "sampleRate": 44_100, "maxRenderQuality": true, "autoToneMap": false }),
            )
            .unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("sequence.settings").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let name = doc.session.state.active_sequence.and_then(|id| doc.session.project.item(id)).unwrap().name.clone();
            assert_eq!(
                shown["params"],
                json!({
                    "tab": "general", "name": name, "newSequence": false, "video": 3, "audio": 3, "fpsNum": 30_000, "fpsDen": 1001,
                    "width": 64, "height": 36, "scaleMotion": true, "dropFrame": true, "mix": "5.1", "sampleRate": 44_100,
                    "maxRenderQuality": true, "workingSpace": "rec709", "wideGamut": false, "autoToneMap": false,
                })
            );
            let info = &shown["info"];
            // What changes() compares the draft with: the sequence as it is, and its name.
            assert_eq!(info["current"]["name"], json!(name));
            assert_eq!(
                (info["current"]["fpsNum"].clone(), info["current"]["dropFrame"].clone(), info["current"]["mix"].clone()),
                (json!(30_000), json!(true), json!("5.1"))
            );
            // What the greyed rows show: the pixel aspect, the codec, the bit depth, and the audio display.
            assert_eq!(
                (info["par"].clone(), info["previewCodec"].clone(), info["maxBitDepth"].clone(), info["audioDisplaySamples"].clone()),
                (json!([1, 1]), json!("ProRes 422"), json!(false), json!(true))
            );
            assert_eq!(info["workingSpaces"], json!([["rec709", "Rec. 709"], ["rec2100-pq", "Rec. 2100 PQ"], ["rec2100-hlg", "Rec. 2100 HLG"]]));
            // Upstream's 15 timebases, each with its label and whether it has drop-frame timecode.
            let timebases = info["timebases"].as_array().unwrap();
            assert_eq!(timebases.len(), 15, "29.97 is one of upstream's own: nothing added");
            assert_eq!(timebases[0], json!({ "num": 10, "den": 1, "label": "10", "dropFrame": false }));
            assert_eq!(timebases[2], json!({ "num": 25, "den": 2, "label": "12.5", "dropFrame": false }));
            assert_eq!(timebases[4], json!({ "num": 24_000, "den": 1001, "label": "23.976", "dropFrame": false }));
            assert_eq!(timebases[7], json!({ "num": 30_000, "den": 1001, "label": "29.97", "dropFrame": true }));
            assert_eq!(timebases[14], json!({ "num": 120, "den": 1, "label": "120", "dropFrame": false }));
        });
    }

    #[test]
    fn sequence_settings_lists_a_rate_upstream_does_not_first_and_drop_frame_only_where_it_applies() {
        with_clips(|doc, _, _| {
            // A stored drop-frame flag on a rate without it reads as off, as upstream's open().
            doc.execute("sequence.settings", json!({ "fps": 23.0 })).unwrap();
            let shown = doc.dialog_defaults("sequence.settings").unwrap();
            assert_eq!(
                (shown["params"]["fpsNum"].clone(), shown["params"]["fpsDen"].clone(), shown["params"]["dropFrame"].clone()),
                (json!(23), json!(1), json!(false))
            );
            let timebases = shown["info"]["timebases"].as_array().unwrap();
            assert_eq!(timebases.len(), 16);
            assert_eq!(timebases[0], json!({ "num": 23, "den": 1, "label": "23", "dropFrame": false }), "the sequence's own rate first");
        });
    }

    #[test]
    fn new_sequence_opens_on_the_default_settings_named_as_the_command_names_it() {
        with_clips(|doc, _, _| {
            doc.execute("sequence.settings", json!({ "width": 1280, "height": 720 })).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("sequence.new").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let count = doc.session.project.sequences().count();
            assert_eq!(
                shown["params"],
                json!({
                    "tab": "general", "name": format!("Sequence {:02}", count + 1), "newSequence": true, "video": 3, "audio": 3, "fpsNum": 24_000, "fpsDen": 1001,
                    "width": 1920, "height": 1080, "scaleMotion": true, "dropFrame": false, "mix": "Stereo", "sampleRate": 48_000,
                    "maxRenderQuality": false, "workingSpace": "rec709", "wideGamut": false, "autoToneMap": true,
                }),
                "the defaults, never the active sequence's"
            );
            // New Sequence compares with the defaults and a blank name (upstream's show()).
            assert_eq!(shown["info"]["current"]["name"], "");
            assert_eq!((shown["info"]["current"]["width"].clone(), shown["info"]["current"]["mix"].clone()), (json!(1920), json!("Stereo")));
            assert_eq!(shown["info"]["timebases"].as_array().unwrap().len(), 15);
            // The name is the one the command gives with no name.
            let made = doc.execute("sequence.new", json!({})).unwrap()["sequence"].as_u64().unwrap();
            assert_eq!(doc.session.project.item(kition_film_engine::project::ItemId(made)).unwrap().name, shown["params"]["name"].as_str().unwrap());
        });
    }

    #[test]
    fn colour_settings_opens_on_the_active_sequences_pipeline() {
        with_clips(|doc, _, _| {
            doc.execute("sequence.colorSettings", json!({ "workingSpace": "rec2100-hlg", "wideGamut": true })).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("sequence.colorSettings").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(shown["params"], json!({ "workingSpace": "rec2100-hlg", "wideGamut": true, "autoToneMap": true }));
            assert_eq!(shown["info"]["workingSpaces"].as_array().unwrap().len(), 3);
        });
    }

    #[test]
    fn field_options_open_with_upstreams_defaults_and_others_are_errors() {
        with_clips(|doc, _, _| {
            assert_eq!(doc.dialog_defaults("clip.fieldOptions").unwrap()["params"], json!({ "reverseFieldDominance": false, "processing": "none" }));
            assert!(doc.dialog_defaults("clip.speedDuration").is_err());
            assert!(doc.dialog_defaults("").is_err());
        });
    }

    #[test]
    fn add_tracks_opens_after_the_last_tracks_with_their_names() {
        with_clips(|doc, _, _| {
            doc.execute("sequence.addTracks", json!({ "video": 0, "submix": 1 })).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("sequence.addTracks").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let inspected = doc.inspect().unwrap();
            let (video, audio) = (inspected["sequence"]["video"].as_array().unwrap().len(), inspected["sequence"]["audio"].as_array().unwrap().len());
            assert_eq!(
                shown["params"],
                json!({ "video": 1, "videoAfter": video, "audio": 1, "audioAfter": audio, "audioType": "standard", "submix": 0, "submixAfter": 1, "submixType": "stereo" })
            );
            assert_eq!(shown["info"]["tracks"]["video"][0], "Video 1");
            assert_eq!(shown["info"]["tracks"]["audio"].as_array().unwrap().len(), audio);
            assert_eq!(shown["info"]["tracks"]["submix"], json!(["Submix 1"]));
            assert_eq!(shown["info"]["current"], json!({ "videoAfter": video, "audioAfter": audio, "submixAfter": 1 }));
            // OK with the draft as it opened adds one video and one audio track after the last ones.
            doc.execute("sequence.addTracks", shown["params"].clone()).unwrap();
            let after = doc.inspect().unwrap();
            assert_eq!(after["sequence"]["video"].as_array().unwrap().len(), video + 1);
            assert_eq!(after["sequence"]["audio"].as_array().unwrap().len(), audio + 1);
        });
    }

    #[test]
    fn simplify_names_the_copy_after_the_active_sequence() {
        with_clips(|doc, _, _| {
            let name = doc.inspect().unwrap()["sequence"]["name"].as_str().unwrap().to_string();
            let before = state(doc);
            let shown = doc.dialog_defaults("sequence.simplify").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(shown["params"]["name"], format!("{name} (Simplified)"));
            assert_eq!(shown["params"]["keep"], "both");
            for (key, on) in [
                ("removeDisabled", true),
                ("removeEmptyTracks", true),
                ("closeGaps", false),
                ("moveClipsDown", false),
                ("removeVideoEffects", false),
                ("removeAudioEffects", false),
                ("removeText", false),
            ] {
                assert_eq!(shown["params"][key], on, "{key}");
            }
            assert_eq!(shown["info"]["current"]["name"], shown["params"]["name"]);
        });
    }

    #[test]
    fn new_color_matte_opens_black_at_the_sequence_size() {
        with_clips(|doc, _, _| {
            let shown = doc.dialog_defaults("item.newColorMatte").unwrap();
            assert_eq!(shown["params"], json!({ "color": "#000000", "name": "Color Matte", "width": 64, "height": 36, "seconds": 5.0 }));
        });
    }

    #[test]
    fn matte_color_reads_the_one_selected_matte_or_says_to_select_one() {
        with_clips(|doc, _, _| {
            let root = doc.inspect().unwrap()["project"]["root"].clone();
            let items: Vec<(u64, String)> =
                root["children"].as_array().unwrap().iter().filter_map(|c| Some((c["item"].as_u64()?, c["name"].as_str()?.to_string()))).collect();
            let matte = items.iter().find(|(_, name)| name == "Color Matte").unwrap().0;
            let tone = items.iter().find(|(_, name)| name != "Color Matte" && !name.starts_with("Sequence")).unwrap().0;
            doc.execute("project.select", json!({ "items": [matte] })).unwrap();
            let before = state(doc);
            let shown = doc.dialog_defaults("project.matteColor").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(shown["params"], json!({ "item": matte, "color": "#ff0000" }));
            assert_eq!(shown["info"]["current"], json!({ "color": "#ff0000" }));
            for selected in [json!([tone]), json!([matte, tone]), json!([])] {
                doc.execute("project.select", json!({ "items": selected })).unwrap();
                assert_eq!(doc.dialog_defaults("project.matteColor").unwrap_err(), "select one Color Matte", "{selected}");
            }
        });
    }
    #[test]
    fn find_opens_on_the_last_project_find_padded_to_two_rows() {
        with_clips(|doc, _, _| {
            let blank = json!({ "column": "Name", "operator": "contains", "text": "" });
            let before = state(doc);
            let shown = doc.dialog_defaults("edit.find").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(shown["params"], json!({ "scope": "project", "rows": [blank, blank], "matchAll": true, "caseSensitive": false, "in": "all" }));
            assert_eq!(shown["info"], json!({}));
            // The last project Find's rows come back (upstream's `s.state.find`); its match and case do not.
            let rows = json!([{ "column": "Name", "operator": "beginsWith", "text": "tone" }]);
            doc.execute("edit.find", json!({ "rows": rows, "matchAll": false, "caseSensitive": true })).unwrap();
            let shown = doc.dialog_defaults("edit.find").unwrap();
            assert_eq!(shown["params"]["rows"], json!([rows[0], blank]));
            assert_eq!((shown["params"]["matchAll"].clone(), shown["params"]["caseSensitive"].clone()), (json!(true), json!(false)));
            // A timeline Find's rows are not a project query: the dialog opens blank.
            doc.execute("edit.find", json!({ "scope": "timeline", "text": "Color" })).unwrap();
            assert_eq!(doc.dialog_defaults("edit.find").unwrap()["params"]["rows"], json!([blank, blank]));
        });
    }

    #[test]
    fn automate_to_sequence_opens_on_upstreams_defaults_naming_the_sequence() {
        with_clips(|doc, _, _| {
            let name = doc.inspect().unwrap()["sequence"]["name"].clone();
            let before = state(doc);
            let shown = doc.dialog_defaults("clip.automateToSequence").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            assert_eq!(
                shown["params"],
                json!({ "ordering": "sort", "placement": "sequentially", "method": "insert", "overlapFrames": 30, "stillFrames": 150, "videoTransition": true, "audioTransition": true, "ignoreAudio": false, "ignoreVideo": false })
            );
            assert_eq!(shown["info"], json!({ "sequence": name }));
        });
    }

    #[test]
    fn project_settings_open_on_the_projects_general_and_ingest_settings() {
        with_clips(|doc, _, _| {
            let before = state(doc);
            let shown = doc.dialog_defaults("file.projectSettings.general").unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let ingest = json!({ "enabled": false, "action": "createProxies", "destination": null, "preset": "" });
            let general = json!({
                "renderer": "Kition Film GPU Acceleration (wgpu)", "videoDisplay": "Timecode", "audioDisplay": "Audio Samples",
                "captureFormat": "DV", "titleSafe": [20.0, 20.0], "actionSafe": [10.0, 10.0],
            });
            let mut params = general.clone();
            params["tab"] = json!("general");
            params["ingest"] = ingest.clone();
            assert_eq!(shown["params"], params);
            let mut current = general;
            current["ingest"] = ingest.clone();
            assert_eq!(shown["info"]["current"], current, "what OK compares with");
            assert_eq!(shown["info"]["ingest"], ingest);
            assert_eq!(shown["info"]["project"], doc.inspect().unwrap()["project"]["name"]);
            assert_eq!(shown["info"]["renderers"], json!(["Kition Film GPU Acceleration (wgpu)", "Kition Film Software Only (CPU)"]));
            assert_eq!(shown["info"]["videoDisplays"], json!(["Timecode", "Feet + Frames 35mm", "Feet + Frames 16mm", "Frames", "Audio Samples", "Seconds"]));
            // Ingest Settings… opens the same dialog on its Ingest tab, with the project's settings.
            doc.execute("project.ingestSettings", json!({ "enabled": true, "action": "copy" })).unwrap();
            doc.execute("file.projectSettings.general", json!({ "audioDisplay": "milliseconds", "actionSafe": [15, 12] })).unwrap();
            let shown = doc.dialog_defaults("project.ingestSettings").unwrap();
            assert_eq!(shown["params"]["tab"], "ingest");
            assert_eq!(shown["params"]["ingest"], json!({ "enabled": true, "action": "copy", "destination": null, "preset": "" }));
            assert_eq!((shown["params"]["audioDisplay"].clone(), shown["params"]["actionSafe"].clone()), (json!("Milliseconds"), json!([15.0, 12.0])));
        });
    }
}
