//! Per-call dependencies from the committed effects handler readings.
use kition_film_engine::project::{ClipId, ItemId, ItemKind, TrackId, mixer::MASTER_STRIP};
use kition_film_engine::{Session, commands::with_links};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

fn fields(id: u64, names: impl IntoIterator<Item = String>) -> Premise {
    Premise { id: json!(id), fields: Some(names.into_iter().collect()), positions: Some(Vec::new()), ..Default::default() }
}

fn content(id: u64, names: &[&str]) -> Premise {
    fields(id, names.iter().map(|s| (*s).to_owned()))
}

fn clip_ids(session: &Session, params: &Value, singular: bool) -> Vec<ClipId> {
    params.get("clips").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_u64().map(ClipId)).collect()).unwrap_or_else(|| {
        if singular && let Some(id) = params.get("clip").and_then(Value::as_u64) { vec![ClipId(id)] } else { session.state.selection.clone() }
    })
}

fn replacement(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "clip.replaceFromSource" | "clip.replaceFromSourceMatchFrame" | "clip.replaceFromBin") {
        return None;
    }
    let sequence = session.active_sequence()?;
    let from_bin = command == "clip.replaceFromBin";
    let match_frame = command == "clip.replaceFromSourceMatchFrame";
    let mut under = Under::default();
    let item = if from_bin {
        if let Some(item) = kition_film_engine::commands::item_p(params, "item") {
            item
        } else {
            // The first accepted Project selection is the source; an earlier
            // entry changing kind can change which item the command copies.
            let mut chosen = None;
            for item in &session.state.project_selection {
                under.premises.push(content(item.0, &["kind"]));
                if kition_film_engine::clip_ops::is_clip_item(&session.project, *item) {
                    chosen = Some(*item);
                    break;
                }
            }
            chosen?
        }
    } else {
        session.state.source_item?
    };
    let source_item = session.project.item(item)?;
    let media = session.project.resolve_media(item).map(|(_, media, _)| media);
    let (video, audio) = media.map_or((source_item.has_video(), source_item.has_audio()), |media| (media.info.has_video(), media.info.has_audio()));
    source(session, item, &mut under);
    under.premises.push(content(item.0, &["name", "props.common.label"]));
    if matches!(source_item.kind, ItemKind::Sequence(_)) {
        under.premises.push(content(item.0, &["duration", "sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate"]));
    }
    // Short-media reporting uses sequence frames. Source range/clamping reads
    // the source's timebase and interpretation, held above through its parents.
    under.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.frame_rate"]));
    let targets = with_links(session, &kition_film_engine::commands::clips_p(session, params));
    for id in targets {
        let Some((owner, _)) = sequence.find_item(id) else { continue };
        let track = sequence.track(owner)?;
        under.premises.push(content(owner.0, &["props.locked", "props.kind"]));
        // Owner locks are checked before incompatible streams are skipped.
        // A skipped explicit target still needs a profile to override the
        // SDK's default whole-object hold, while retaining its owner identity.
        let accepts = match track.kind {
            kition_film_engine::project::TrackKind::Video => video,
            kition_film_engine::project::TrackKind::Audio => audio,
        };
        let mut need = content(id.0, &[]);
        need.positions = Some(vec!["clips".to_owned()]);
        if accepts {
            need.fields = Some(["item", "sourceIn", "props.name", "props.label", "props.frame_hold", "props.multicam", "speed"].map(str::to_owned).to_vec());
            need.positions.get_or_insert_with(Vec::new).push("duration".to_owned());
            if match_frame {
                need.positions.get_or_insert_with(Vec::new).push("start".to_owned());
            }
            if track.kind == kition_film_engine::project::TrackKind::Audio {
                need.fields.get_or_insert_with(Vec::new).push("props.source_channels".to_owned());
            }
        }
        under.premises.push(need);
    }
    Some(under)
}

fn attributes(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "edit.pasteAttributes" | "edit.removeAttributes" | "clip.fitToFrame" | "clip.fillFrame") {
        return None;
    }
    let q = session.active_sequence()?;
    let mut answer = Under::default();
    let sizing = matches!(command, "edit.removeAttributes" | "clip.fitToFrame" | "clip.fillFrame");
    let clips = if command.starts_with("edit.") { linked(session, params, true, &mut answer) } else { clip_ids(session, params, true) };
    for id in clips {
        let Some((track, clip)) = q.find_item(id) else { continue };
        let video = q.video_tracks.iter().any(|t| t.id == track);
        if command.starts_with("clip.") && !video {
            continue;
        }
        let mut need = content(id.0, &["effects"]);
        if sizing {
            need.fields.get_or_insert_with(Vec::new).push("item".to_owned());
        }
        if command.starts_with("clip.") {
            need.fields.get_or_insert_with(Vec::new).push("props.scale_to_frame".to_owned());
        }
        if command == "edit.pasteAttributes" {
            need.fields.get_or_insert_with(Vec::new).extend(["sourceIn", "speed"].map(str::to_owned));
            need.positions = Some(vec!["duration".to_owned(), "clips".to_owned()]);
            answer.premises.push(content(track.0, &["props.kind"]));
        }
        answer.premises.push(need);
        if command.starts_with("clip.") {
            answer.premises.push(content(track.0, &["props.kind"]));
            answer.premises.push(Premise::on(json!(id.0)).fields(Vec::<String>::new()).positions(["clips"]));
        }
        if sizing {
            super::rests_media::dimensions(session, clip.item, &mut answer.premises);
        }
    }
    if sizing {
        answer.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
    }
    Some(answer)
}

fn linked(session: &Session, params: &Value, singular: bool, under: &mut Under) -> Vec<ClipId> {
    let ids = clip_ids(session, params, singular);
    if session.state.linked_selection {
        under.premises.extend(ids.iter().map(|id| content(id.0, &["link"])));
    }
    with_links(session, &ids)
}

fn audio(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let audio_mixing = command.starts_with("audioMixing.") && !matches!(command, "audioMixing.deletePreset" | "audioMixing.inspect");
    if command != "clip.audioGain" && !audio_mixing {
        return None;
    }
    let q = session.active_sequence()?;
    let mut under = Under::default();
    let targets = linked(session, params, audio_mixing, &mut under);
    let normalize = command == "clip.audioGain" && params.get("mode").and_then(Value::as_str).is_some_and(|m| m == "normalizeMax" || m == "normalizeAll");
    for track in &q.audio_tracks {
        for clip in track.items.iter().filter(|clip| targets.contains(&clip.id)) {
            let mut held = content(clip.id.0, if audio_mixing { &["link", "props.audio_mixing", "effects", "gain"] } else { &["link", "gain"] });
            // Audio ownership is an eligibility check for both handlers.
            held.positions = Some(vec!["clips".to_owned()]);
            if audio_mixing || normalize {
                held.fields
                    .get_or_insert_with(Vec::new)
                    .extend(["item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.source_channels", "props.audio_stream"].map(str::to_owned));
                held.positions.get_or_insert_with(Vec::new).extend(["start", "duration"].map(str::to_owned));
                if normalize || matches!(command, "audioMixing.autoMatch" | "audioMixing.generateDucking") {
                    source(session, clip.item, &mut under);
                }
            }
            under.premises.push(held);
        }
    }
    if matches!(command, "audioMixing.autoMatch" | "audioMixing.generateDucking") {
        under.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.sample_rate"]));
    }
    if command == "audioMixing.generateDucking" {
        under.premises.push(content(session.state.active_sequence?.0, &["~audioClipIds"]));
        // The trigger set is selected from every audio clip, not the clip targets.
        for track in &q.audio_tracks {
            for clip in &track.items {
                let mut held = content(
                    clip.id.0,
                    &[
                        "props.enabled",
                        "props.audio_mixing",
                        "item",
                        "sourceIn",
                        "speed",
                        "reverse",
                        "props.frame_hold",
                        "props.source_channels",
                        "props.audio_stream",
                    ],
                );
                held.positions = Some(["start", "duration"].map(str::to_owned).to_vec());
                under.premises.push(held);
                source(session, clip.item, &mut under);
            }
        }
    }
    Some(under)
}

fn keyboard_volume(session: &Session, command: &str) -> Option<Under> {
    if !matches!(
        command,
        "clip.volumeUp"
            | "clip.volumeDown"
            | "clip.volumeUpMany"
            | "clip.volumeDownMany"
            | "clip.nudgeVolumeUp1"
            | "clip.nudgeVolumeUp3"
            | "clip.nudgeVolumeDown1"
            | "clip.nudgeVolumeDown3"
    ) {
        return None;
    }
    let q = session.active_sequence()?;
    let selected = &session.state.selection;
    let mut answer = Under::default();
    if session.state.linked_selection {
        for id in selected {
            answer.premises.push(content(id.0, &["link", "~linkedGroup"]));
            if let Some(link) = q.find_item(*id).and_then(|(_, clip)| clip.link)
                && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).min()
            {
                answer.premises.push(content(root, &["~linkedMembers"]));
            }
        }
    }
    for id in with_links(session, selected) {
        let Some((owner, clip)) = q.find_item(id) else { continue };
        let mut names = Vec::new();
        if q.audio_tracks.iter().any(|track| track.id == owner) {
            let mut found = false;
            for (index, effect) in clip.effects.iter().enumerate() {
                names.push(format!("effects.{index}.def"));
                if effect.effect == "volume" {
                    names.push(format!("effects.{index}.params.level"));
                    found = true;
                    break;
                }
            }
            if !found {
                names.push(format!("effects.{}.def", clip.effects.len()));
            }
        }
        answer.premises.push(Premise::on(json!(id.0)).fields(names).positions(["clips"]));
    }
    Some(answer)
}

pub(super) fn source(session: &Session, id: ItemId, under: &mut Under) {
    let mut next = Some(id);
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = next.filter(|id| seen.insert(*id)) {
        under.premises.push(content(
            id.0,
            &["kind", "props.media", "props.parent", "props.range", "props.restrict_trims", "props.width", "props.height", "props.rate", "sequence"],
        ));
        next = match session.project.item(id).map(|i| &i.kind) {
            Some(ItemKind::Subclip { parent, .. }) => Some(*parent),
            _ => None,
        };
    }
}

fn strip_field(session: &Session, strip: TrackId, name: &str) -> Option<Premise> {
    if strip != MASTER_STRIP {
        return Some(content(strip.0, &[name]));
    }
    let name = match name {
        "volumeDb" => "sequence.masterVolumeDb".to_owned(),
        "effects" => "sequence.masterEffects".to_owned(),
        "props.channels" => "sequence.settings.settings.audio_master".to_owned(),
        n if n.starts_with("props.mixer") => format!("sequence.mixer{}", n.strip_prefix("props.mixer").unwrap_or_default()),
        n if n.starts_with("effects.") => format!("sequence.masterEffects.{}", n.strip_prefix("effects.").unwrap_or_default()),
        _ => return None,
    };
    Some(fields(session.state.active_sequence?.0, [name]))
}

fn add_strip(session: &Session, under: &mut Under, strip: TrackId, name: &str) {
    if let Some(premise) = strip_field(session, strip, name) {
        under.premises.push(premise);
    }
}

fn lane_fields(session: &Session, under: &mut Under, strip: TrackId, lane: &str) {
    use kition_film_engine::project::mixer::{parse_fx_lane, parse_send_lane};
    if let Some((slot, param)) = parse_fx_lane(lane) {
        add_strip(session, under, strip, &format!("effects.{slot}.def"));
        add_strip(session, under, strip, &format!("effects.{slot}.params.{param}"));
    } else {
        let lane_field = if lane.contains('.') { "props.mixer.lanes".to_owned() } else { format!("props.mixer.lanes.{lane}") };
        add_strip(session, under, strip, &lane_field);
        let stat = match lane {
            "volume" => "volumeDb".to_owned(),
            "pan" => "pan".to_owned(),
            "mute" => "props.muted".to_owned(),
            key if parse_send_lane(key).is_some() => format!("props.mixer.sends.{}", parse_send_lane(key).unwrap_or_default()),
            _ => "props.channels".to_owned(),
        };
        add_strip(session, under, strip, &stat);
    }
}

fn recording(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command != "mixer.recordStop" && command != "clipMixer.release" {
        return None;
    }
    let mut answer = Under::default();
    if command == "clipMixer.release" {
        let q = session.active_sequence()?;
        let strip = kition_film_engine::mixer::strip_ref(q, params.get("track")?)?;
        answer.premises.push(content(strip.0, &[]));
        if !session.mixrec.active() {
            let time = kition_film_engine::commands::time_p(session, params, "").unwrap_or(session.playhead());
            if let Some(track) = q.audio_tracks.iter().find(|track| track.id == strip) {
                answer.premises.push(content(strip.0, &["~clipOrder"]));
                for clip in track.items.iter().filter(|clip| clip.start <= time && time < clip.end()) {
                    answer.premises.push(content(clip.id.0, &["effects", "sourceIn", "speed", "reverse", "props.frame_hold"]).positions(["start", "duration"]));
                }
            }
        }
        return Some(answer);
    }
    let Some(sequence) = session.mixrec.seq.filter(|_| !session.mixrec.gestures.is_empty()) else { return Some(answer) };
    let Some(q) = session.project.sequence(sequence) else {
        answer.premises.push(content(sequence.0, &[]));
        return Some(answer);
    };
    answer.premises.push(content(sequence.0, &["sequence.settings.settings.sample_rate", "~audioTrackOrder", "~submixTrackOrder"]));
    // The pass may address another open sequence. Helpers below resolve master
    // storage through the active part, so spell its recorded owner explicitly.
    let on_strip = |strip: TrackId, field: &str| -> Option<Premise> {
        if strip != MASTER_STRIP {
            Some(content(strip.0, &[field]))
        } else {
            strip_field(session, strip, field).map(|mut need| {
                need.id = json!(sequence.0);
                need
            })
        }
    };
    if session.prefs.audio.switch_to_touch_after_write {
        for strip in q.strip_ids() {
            answer.premises.extend(on_strip(strip, "props.mixer.mode"));
        }
    }
    for gesture in &session.mixrec.gestures {
        answer.premises.extend(on_strip(gesture.strip, "props.mixer.mode"));
        if kition_film_engine::mixer::is_clip_lane(&gesture.lane) {
            if let Some(track) = q.audio_tracks.iter().find(|track| track.id == gesture.strip) {
                answer.premises.push(content(track.id.0, &["~clipOrder"]));
                answer.premises.extend(
                    track
                        .items
                        .iter()
                        .map(|clip| content(clip.id.0, &["effects", "sourceIn", "speed", "reverse", "props.frame_hold"]).positions(["start", "duration"])),
                );
            }
        } else {
            let mut lane = Under::default();
            lane_fields(session, &mut lane, gesture.strip, &gesture.lane);
            for mut need in lane.premises {
                if gesture.strip == MASTER_STRIP {
                    need.id = json!(sequence.0);
                }
                answer.premises.push(need);
            }
        }
    }
    Some(answer)
}

fn mixer(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !command.starts_with("mixer.") {
        return None;
    }
    let q = session.active_sequence()?;
    let sequence_id = session.state.active_sequence?.0;
    if command == "mixer.addSubmix" {
        return Some(Under { premises: vec![content(sequence_id, &["~submixTrackOrder"])], ..Default::default() });
    }
    let strip = kition_film_engine::mixer::strip_ref(q, params.get("strip").or_else(|| params.get("track"))?)?;
    let mut under = Under::default();
    under.premises.push(content(if strip == MASTER_STRIP { sequence_id } else { strip.0 }, &[]));
    if strip != MASTER_STRIP && params.get("strip").or_else(|| params.get("track")).is_some_and(Value::is_string) {
        under.objects.push(json!(strip.0));
        // Existing name/ordinal address matrices require the observed stack
        // place as well as the resolved identity (time5::mixer_name_time_matrix).
        under.premises.push(Premise::on(json!(strip.0)).fields(Vec::<String>::new()));
    }
    match command {
        "mixer.setStrip" => {
            for (param, field) in [
                ("name", "props.name"),
                ("volumeDb", "volumeDb"),
                ("pan", "pan"),
                ("muted", "props.muted"),
                ("solo", "props.solo"),
                ("recordArm", "props.mixer.record_arm"),
                ("soloSafe", "props.mixer.solo_safe"),
                ("mode", "props.mixer.mode"),
                ("inputMap", "props.mixer.input_map"),
                ("channels", "props.channels"),
                ("output", "props.mixer.output"),
            ] {
                if params.get(param).is_some() {
                    add_strip(session, &mut under, strip, field);
                }
            }
        }
        "mixer.deleteSubmix" => {
            under.premises.push(Premise::on(json!(strip.0)));
            under.premises.push(content(strip.0, &["~submixDependants"]));
            // Deleting a bus rewrites routes and removes sends (and shifts send lanes).
            for sid in q.strip_ids() {
                let Some(track) = q.strip(sid) else { continue };
                if track.mixer.output == Some(strip) {
                    add_strip(session, &mut under, sid, "props.mixer.output");
                }
                if let Some(first) = track.mixer.sends.iter().position(|send| send.target == strip) {
                    for at in first..track.mixer.sends.len() {
                        add_strip(session, &mut under, sid, &format!("props.mixer.sends.{at}"));
                    }
                    add_strip(session, &mut under, sid, "props.mixer.lanes");
                }
            }
        }
        "mixer.addInsert" | "mixer.removeInsert" => add_strip(session, &mut under, strip, "effects"),
        "mixer.setInsert" => {
            let slot = params.get("slot").and_then(Value::as_u64)?;
            add_strip(session, &mut under, strip, &format!("effects.{slot}.def"));
            for key in ["enabled", "postFader"] {
                if params.get(key).is_some() {
                    add_strip(session, &mut under, strip, &format!("effects.{slot}.{key}"));
                }
            }
            for key in params.get("params").and_then(Value::as_object).into_iter().flatten().map(|(k, _)| k) {
                add_strip(session, &mut under, strip, &format!("effects.{slot}.params.{key}.value"));
            }
        }
        "mixer.addSend" | "mixer.removeSend" => {
            add_strip(session, &mut under, strip, "props.mixer.sends");
            if command == "mixer.removeSend" {
                add_strip(session, &mut under, strip, "props.mixer.lanes");
            }
        }
        "mixer.setSend" => {
            let send = params.get("send").and_then(Value::as_u64)?;
            add_strip(session, &mut under, strip, &format!("props.mixer.sends.{send}.target"));
            for (param, field) in [("target", "target"), ("levelDb", "level_db"), ("pan", "pan"), ("preFader", "pre_fader"), ("muted", "muted")] {
                if params.get(param).is_some() {
                    add_strip(session, &mut under, strip, &format!("props.mixer.sends.{send}.{field}"));
                }
            }
        }
        "mixer.setValue"
        | "mixer.release"
        | "mixer.setKeyframe"
        | "mixer.deleteKeyframe"
        | "mixer.moveKeyframe"
        | "mixer.clearLane"
        | "mixer.writeAutomation" => {
            let lane = params.get("lane").and_then(Value::as_str).unwrap_or("volume");
            lane_fields(session, &mut under, strip, lane);
            if matches!(command, "mixer.setValue" | "mixer.release" | "mixer.clearLane" | "mixer.writeAutomation") {
                add_strip(session, &mut under, strip, "props.mixer.mode");
            }
            if command == "mixer.writeAutomation" {
                under.premises.push(content(sequence_id, &["sequence.settings.settings.sample_rate"]));
            }
        }
        _ => return None,
    }
    for key in ["output", "target"] {
        if let Some(other) = params.get(key).and_then(|v| kition_film_engine::mixer::strip_ref(q, v)) {
            let id = if other == MASTER_STRIP { sequence_id } else { other.0 };
            under.premises.push(content(id, &[]));
            let named = params.get(key).is_some_and(Value::is_string);
            if named {
                under.objects.push(json!(id));
            }
            if other != MASTER_STRIP {
                if routing_profile_fits(q) {
                    under.premises.push(fields(sequence_id, [format!("~mixerRoutes.{}_{}", strip.0, other.0)]));
                } else if q.submix_tracks.iter().any(|track| track.id == strip) {
                    // Bound the quadratic projection. Large mixer graphs keep
                    // the conservative ordering hold instead of allocating an
                    // input-sized pair matrix without a limit.
                    under.premises.push(Premise::on(json!(strip.0)).fields(Vec::<String>::new()).positions(["sequence.submixTracks"]));
                }
                if (named || !routing_profile_fits(q)) && q.submix_tracks.iter().any(|track| track.id == other) {
                    under.premises.push(Premise::on(json!(other.0)).fields(Vec::<String>::new()).positions(["sequence.submixTracks"]));
                }
            }
        }
    }
    Some(under)
}

fn graphic_placement(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let navigation = matches!(command, "graphics.selectNextGraphic" | "graphics.selectPreviousGraphic");
    let new_layer = matches!(
        command,
        "graphics.newText" | "graphics.newVerticalText" | "graphics.newShape" | "graphics.newRectangle" | "graphics.newEllipse" | "graphics.newPolygon"
    );
    let forced = matches!(command, "graphics.newText" | "graphics.newVerticalText") && params.get("newClip").and_then(Value::as_bool) == Some(true);
    if !navigation
        && !matches!(command, "graphics.template.apply" | "graphics.upgradeCaption")
        && !(new_layer && (forced || kition_film_engine::graphics::target_clip(session, params).is_none()))
    {
        return None;
    }
    let sequence = session.active_sequence()?;
    let id = session.state.active_sequence?.0;
    let mut under = Under::default();
    if navigation {
        under.premises.push(content(id, &["sequence"]));
        for clip in sequence.video_tracks.iter().flat_map(|track| &track.items) {
            under.premises.push(content(clip.item.0, &["kind"]));
        }
        return Some(under);
    }
    under.premises.push(content(
        id,
        &["sequence.settings.settings.width", "sequence.settings.settings.height", "sequence.settings.settings.frame_rate", "~videoTrackOrder"],
    ));
    under.premises.push(Premise::on(json!("project")).fields(["~itemIds"]).positions(Vec::<String>::new()));
    for id in session.project.items.keys() {
        under.premises.push(content(id.0, &["sourceGraphic"]));
    }
    // graphic_source reuses the first matching non-shared source. Lane choice
    // examines occupancy across the new duration, beyond the insertion point.
    for item in session.project.items.values() {
        under.premises.push(content(item.id.0, &["kind", "props.width", "props.height", "props.rate"]));
    }
    for track in &sequence.video_tracks {
        under.premises.push(content(track.id.0, &["props.locked", "~clipOrder"]));
        for clip in &track.items {
            under.premises.push(Premise::on(json!(clip.id.0)).fields(["item"]).positions(["start", "duration"]));
            under.premises.push(content(clip.item.0, &["kind"]));
        }
    }
    if command == "graphics.upgradeCaption" {
        under.premises.push(content(id, &["sequence.captionTracks"]));
    }
    Some(under)
}

fn graphic(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !command.starts_with("graphics.")
        || params.get("newClip").and_then(Value::as_bool) == Some(true)
        || matches!(
            command,
            "graphics.selectNextGraphic"
                | "graphics.selectPreviousGraphic"
                | "graphics.upgradeCaption"
                | "graphics.template.apply"
                | "graphics.template.install"
                | "graphics.template.remove"
                | "graphics.template.list"
                | "graphics.template.thumbnail"
        )
    {
        return None;
    }
    let clip = kition_film_engine::graphics::target_clip(session, params)?;
    let q = session.active_sequence()?;
    let (_, target) = q.find_item(clip)?;
    let mut under = Under::default();
    if command == "graphics.setText" {
        // target_clip checks only the item's Graphic kind. set_props uses the
        // clip's source-time mapping and layer values, not the source frame.
        under.premises.push(content(target.item.0, &["kind"]));
    } else {
        source(session, target.item, &mut under);
    }
    under.premises.push(Premise::on(json!(target.item.0)).fields(["~sourceGraphic"]).positions(Vec::<String>::new()));
    if params.get("clip").is_none() {
        for selected in &session.state.selection {
            if let Some((_, selected)) = q.find_item(*selected) {
                under.premises.push(content(selected.id.0, &["item"]));
                under.premises.push(content(selected.item.0, &["kind"]));
            }
        }
    }
    if command != "graphics.setText" {
        // Preserve the previous target hold until each layout/property path has
        // its own leaf projection. Peer/source additions must not weaken it.
        under.premises.push(Premise::on(json!(target.id.0)));
    }
    let mut targets = vec![target];
    if session.project.source_graphics.contains_key(&target.item) {
        for item in session.project.sequences() {
            if let ItemKind::Sequence(sequence) = &item.kind {
                for tr in &sequence.video_tracks {
                    targets.extend(tr.items.iter().filter(|it| it.item == target.item && it.id != clip));
                }
            }
        }
    }
    for it in targets {
        let mut names = vec!["item".to_owned(), "props.graphic".to_owned()];
        // Dispatch copies complete layer instances to every peer. Intrinsic
        // effects and unrelated clip fields are preserved by reconciliation.
        names.extend(it.effects.iter().enumerate().filter(|(_, e)| kition_film_engine::project::graphic::is_layer(e)).map(|(i, _)| format!("effects.{i}")));
        under.premises.push(fields(it.id.0, names));
    }
    // Existing layer commands can read the source-time mapping even when their
    // input names a clip directly; layout also uses sequence dimensions.
    under.premises.push(content(target.id.0, &["sourceIn", "speed", "reverse", "props.frame_hold"]));
    under.premises.push(Premise::on(json!(target.id.0)).fields(Vec::<String>::new()).positions(["start", "duration"]));
    if command.contains("align") || command.contains("distribute") || command.starts_with("graphics.new") || command == "graphics.resetAllParameters" {
        under.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
    }
    if command == "graphics.resetDuration" {
        under.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.frame_rate"]));
        under.premises.push(Premise::on(json!(super::facts::id(&json!(target.id.0), "~followingClip"))).fields(["value"]).positions(Vec::<String>::new()));
    }
    let duration_keys: &[&str] = match command {
        "graphics.setRoll" => &["preroll", "easeIn", "easeOut", "postroll"],
        "graphics.setResponsiveTime" => &["intro", "outro"],
        _ => &[],
    };
    if duration_keys.iter().any(|key| params.get(format!("{key}Frames")).and_then(Value::as_f64).is_some()) {
        under.premises.push(content(session.state.active_sequence?.0, &["sequence.settings.settings.frame_rate"]));
    }
    Some(under)
}

fn motion_nudge(session: &Session, command: &str) -> Option<Under> {
    if !command.starts_with("graphics.nudge") {
        return None;
    }
    let sequence = session.active_sequence()?;
    if kition_film_engine::graphics::target_clip(session, &Value::Null).is_some()
        && session.state.selection.iter().all(|id| kition_film_engine::graphics::is_graphic(session, sequence, *id))
    {
        return None;
    }
    let mut under = Under::default();
    for id in &session.state.selection {
        let Some((track, clip)) = sequence.find_item(*id) else { continue };
        under.premises.push(content(id.0, &["item"]));
        under.premises.push(content(clip.item.0, &["kind"]));
        if !sequence.video_tracks.iter().any(|candidate| candidate.id == track) {
            // A former video recipient may now be on audio. Keep its owner
            // dependency even though the current handler skips that clip.
            under.premises.push(Premise::on(json!(id.0)).fields(Vec::<String>::new()).positions(["clips"]));
            continue;
        }
        let mut need = content(id.0, &["sourceIn", "speed", "reverse", "props.frame_hold"]);
        need.positions = Some(vec!["clips".into(), "start".into(), "duration".into()]);
        let first_motion = clip.effects.iter().position(|effect| effect.effect == "motion");
        for index in 0..=first_motion.unwrap_or(clip.effects.len()) {
            need.fields.get_or_insert_with(Vec::new).push(format!("effects.{index}.def"));
        }
        if let Some(index) = first_motion {
            need.fields.get_or_insert_with(Vec::new).push(format!("effects.{index}.params.position"));
        }
        under.premises.push(need);
    }
    Some(under)
}

// At most 64 ordinary strips: the complete pair projection is bounded to
// 65 * 64 booleans including the Master source. Larger graphs use index holds.
fn routing_profile_fits(sequence: &kition_film_engine::project::Sequence) -> bool {
    sequence.audio_tracks.len().saturating_add(sequence.submix_tracks.len()) <= 64
}

fn routing_values(item: &kition_film_engine::project::ProjectItem) -> Value {
    let ItemKind::Sequence(sequence) = &item.kind else { return Value::Null };
    if !routing_profile_fits(sequence) {
        return Value::Null;
    }
    let mut pairs = serde_json::Map::new();
    for source in sequence.audio_tracks.iter().chain(&sequence.submix_tracks).map(|track| track.id).chain(std::iter::once(MASTER_STRIP)) {
        for target in &sequence.submix_tracks {
            pairs.insert(format!("{}_{}", source.0, target.id.0), json!(kition_film_engine::mixer::submix_routing_allowed(sequence, source, target.id)));
        }
    }
    Value::Object(pairs)
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<kition_kit::DerivedValues> {
    if !names.is_empty()
        && !names.iter().any(|name| name == "sourceGraphic" || name == "sourceGraphicDefinition" || name == "mixerRoutes" || name == "submixDependants")
    {
        return Vec::new();
    }
    let mut values = Vec::new();
    if names.is_empty() || names.iter().any(|name| name == "submixDependants") {
        for q in session.project.sequences().filter_map(|item| item.as_sequence()) {
            for bus in &q.submix_tracks {
                if !ids.is_empty() && !ids.iter().any(|id| *id == json!(bus.id.0)) {
                    continue;
                }
                let users: Vec<_> = q
                    .strip_ids()
                    .into_iter()
                    .filter_map(|id| {
                        let strip = q.strip(id)?;
                        let sends: Vec<_> = strip.mixer.sends.iter().enumerate().filter(|(_, send)| send.target == bus.id).map(|(index, _)| index).collect();
                        let output = strip.mixer.output == Some(bus.id);
                        (output || !sends.is_empty()).then(|| json!({"strip":id.0,"output":output,"sends":sends}))
                    })
                    .collect();
                values.push(kition_kit::DerivedValues { id: json!(bus.id.0), values: serde_json::Map::from_iter([("submixDependants".into(), json!(users))]) });
            }
        }
    }
    for item in session.project.items.values() {
        if !ids.is_empty() && !ids.iter().any(|id| id.as_u64() == Some(item.id.0) || id.as_str().is_some_and(|id| id == item.id.0.to_string())) {
            continue;
        }
        let source = session
            .project
            .source_graphics
            .get(&item.id)
            .map(|definition| {
                let mut recipients: Vec<_> = session
                    .project
                    .sequences()
                    .filter_map(|item| session.project.sequence(item.id))
                    .flat_map(|q| &q.video_tracks)
                    .flat_map(|track| &track.items)
                    .filter(|clip| clip.item == item.id)
                    .map(|clip| clip.id.0)
                    .collect();
                recipients.sort_unstable();
                json!({"definition":definition,"recipients":recipients})
            })
            .unwrap_or(Value::Null);
        let mut facts = serde_json::Map::new();
        if names.is_empty() || names.iter().any(|name| name == "sourceGraphic") {
            facts.insert("sourceGraphic".to_owned(), source);
        }
        if names.is_empty() || names.iter().any(|name| name == "sourceGraphicDefinition") {
            // make_track_item copies the definition, without reading the
            // recipients that graphic editing must propagate to.
            facts.insert("sourceGraphicDefinition".to_owned(), json!(session.project.source_graphics.get(&item.id)));
        }
        if names.is_empty() || names.iter().any(|name| name == "mixerRoutes") {
            facts.insert("mixerRoutes".to_owned(), routing_values(item));
        }
        values.push(kition_kit::DerivedValues { id: json!(item.id.0), values: facts });
    }
    values
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if let Some(answer) = recording(session, command, params) {
        return Some(answer);
    }
    if let Some(fonts) = super::rests_fonts::under(command, params) {
        return Some(fonts);
    }
    if let Some(picture) = super::rests_render::under(session, command, params) {
        return Some(picture);
    }
    let mut answer = replacement(session, command, params)
        .or_else(|| attributes(session, command, params))
        .or_else(|| audio(session, command, params))
        .or_else(|| keyboard_volume(session, command))
        .or_else(|| mixer(session, command, params))
        .or_else(|| motion_nudge(session, command))
        .or_else(|| graphic_placement(session, command, params))
        .or_else(|| graphic(session, command, params))?;
    super::facts::scope(&mut answer);
    // The pinned SDK uses the last premise of each id. Emit each id once so
    // source mapping, assigned fields and eligibility all remain held.
    let mut merged: Vec<Premise> = Vec::new();
    for premise in answer.premises {
        if let Some(previous) = merged.iter_mut().find(|p| p.id == premise.id) {
            for (into, more) in [(&mut previous.fields, premise.fields), (&mut previous.positions, premise.positions)] {
                match (into.as_mut(), more) {
                    (Some(into), Some(more)) => {
                        for name in more {
                            if !into.contains(&name) {
                                into.push(name);
                            }
                        }
                    }
                    _ => *into = None,
                }
            }
        } else {
            merged.push(premise);
        }
    }
    answer.premises = merged;
    Some(answer)
}
