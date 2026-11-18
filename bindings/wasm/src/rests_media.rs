//! C8-film-read: project-setting facts from the independently committed media rows.
//! Paths are the KDM Project.settings shape (ProjectSettings and ScratchDisks serde).

use kition_film_engine::Session;
use kition_film_engine::project::{BinEntry, ClipId, ItemId, ItemKind};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

fn need(id: Value, fields: impl IntoIterator<Item = String>) -> Premise {
    Premise { id, fields: Some(fields.into_iter().collect()), positions: Some(Vec::new()), ..Default::default() }
}

fn item_need(id: ItemId, fields: &[&str]) -> Premise {
    need(json!(id.0), fields.iter().map(|s| (*s).to_owned()))
}

// Each predicate is a separate derived fact: the SDK pin treats a derived
// object as atomic, so a single map would hold unrelated metadata predicates.
const METADATA_RULES: [(&str, &[&str]); 4] = [
    ("metadataVideoReadOnly", &["Video Info", "Color Space"]),
    ("metadataVideoCodecReadOnly", &["Video Codec"]),
    ("metadataAudioReadOnly", &["Audio Info", "Audio Codec"]),
    ("metadataMarksReadOnly", &["In Point", "Out Point"]),
];

/// The exact editability predicates from panels::metadata_fields. Subclips use
/// only their immediate media parent; their own marks never create In/Out rows.
fn metadata_read_only(session: &Session, id: ItemId) -> [bool; 4] {
    let Some(item) = session.project.item(id) else { return [false; 4] };
    let media = match &item.kind {
        ItemKind::Media(media) => Some(media),
        ItemKind::Subclip { parent, .. } => session.project.item(*parent).and_then(|item| item.as_media()),
        _ => None,
    };
    let video = media.is_some_and(|media| media.info.video.is_some());
    let audio = media.is_some_and(|media| media.info.audio().is_some());
    let marks = match &item.kind {
        ItemKind::Media(media) => media.mark_in.is_some() && media.mark_out.is_some(),
        ItemKind::Sequence(q) => q.mark_in.is_some() && q.mark_out.is_some(),
        _ => false,
    };
    [video || matches!(item.kind, ItemKind::Sequence(_)), video, audio, marks]
}

fn metadata_eligibility(item: ItemId, keys: &[&str]) -> Vec<Premise> {
    let fields: Vec<_> = METADATA_RULES
        .iter()
        .filter(|(_, labels)| keys.iter().any(|key| labels.iter().any(|label| key.eq_ignore_ascii_case(label))))
        .map(|(name, _)| format!("~{name}"))
        .collect();
    if fields.is_empty() { Vec::new() } else { vec![need(json!(item.0), fields)] }
}

fn column_key(name: &str) -> String {
    // Metadata names may contain dots and selector punctuation. Hex preserves
    // the engine's ASCII-insensitive matching as one unambiguous path segment.
    let mut key = String::from("c");
    for byte in name.trim().to_ascii_lowercase().bytes() {
        use std::fmt::Write;
        let _ = write!(key, "{byte:02x}");
    }
    key
}

fn freeform(session: &Session, command: &str, params: &Value) -> Option<Under> {
    use kition_film_engine::project_panel::{ARRANGEMENT_PREFIX, FREEFORM_POS, FREEFORM_STACK, listed};
    if !matches!(
        command,
        "project.freeform.move"
            | "project.freeform.resize"
            | "project.freeform.alignToGrid"
            | "project.freeform.reset"
            | "project.freeform.stack"
            | "project.freeform.unstack"
            | "project.freeform.saveArrangement"
            | "project.freeform.restoreArrangement"
            | "project.freeform.deleteArrangement"
    ) {
        return None;
    }
    if command == "project.freeform.move" && params.get("positions").is_some() {
        return None;
    }
    let selected = kition_film_engine::project_panel::items_p(session, params);
    let relative = matches!(command, "project.freeform.move" | "project.freeform.resize" | "project.freeform.stack" | "project.freeform.unstack");
    let bin = if relative { selected.first().and_then(|i| session.project.root.parent_of(*i)) } else { kition_film_engine::project_panel::bin_p(params) };
    let bin = bin.and_then(|id| session.project.root.find_bin(id)).unwrap_or(&session.project.root);
    let mut premises = vec![need(json!(bin.id.0), ["~entryOrder".to_owned()])];
    let arrangement = params.get("name").and_then(Value::as_str).map(|name| {
        let key = format!("{ARRANGEMENT_PREFIX}{}", if command == "project.freeform.saveArrangement" { name.trim() } else { name });
        if key.contains(['.', '[', ']', '/', '~']) {
            format!("/props/common/metadata/{}", key.replace('~', "~0").replace('/', "~1"))
        } else {
            format!("props.common.metadata.{key}")
        }
    });
    let layout = !matches!(command, "project.freeform.reset" | "project.freeform.restoreArrangement" | "project.freeform.deleteArrangement");
    let pos = format!("props.common.metadata.{FREEFORM_POS}");
    let stack = format!("props.common.metadata.{FREEFORM_STACK}");
    for entry in &bin.children {
        let BinEntry::Item(id) = entry else { continue };
        let Some(item) = session.project.item(*id) else { continue };
        // A graphic's listing depends on whether it has been upgraded to a
        // source graphic. Other kinds always participate in this bin's layout.
        let mut fields = vec!["kind".to_owned()];
        if matches!(item.kind, ItemKind::Graphic { .. }) {
            premises.push(need(json!("project"), ["docState.source_graphics".to_owned()]));
        }
        if listed(&session.project, item) {
            if layout || command == "project.freeform.reset" || command == "project.freeform.restoreArrangement" {
                fields.push(pos.clone());
            }
            if layout || command == "project.freeform.reset" {
                fields.push(stack.clone());
            }
            if let Some(key) = &arrangement {
                fields.push(key.clone());
            }
        }
        premises.push(need(json!(id.0), fields));
    }
    for id in &selected {
        if !premises.iter().any(|p| p.id == json!(id.0)) {
            premises.push(item_need(*id, &["props.common.metadata.Freeform Position", "props.common.metadata.Freeform Stack"]));
        }
    }
    if relative && let Some(first) = selected.first() {
        // Resolving the first card's parent chooses which siblings form the
        // implicit layout; its entry address is therefore part of that read.
        if let Some(premise) = premises.iter_mut().find(|p| p.id == json!(first.0)) {
            premise.positions = Some(vec!["entries".to_owned()]);
        }
    }
    if command == "project.freeform.unstack" {
        for item in session.project.items.values() {
            let mut fields = vec![stack.clone()];
            if selected.contains(&item.id)
                || item.metadata.get(FREEFORM_STACK).and_then(|v| v.parse::<u64>().ok()).is_some_and(|id| selected.contains(&ItemId(id)))
            {
                fields.push(pos.clone());
            }
            premises.push(need(json!(item.id.0), fields));
        }
    }
    Some(Under { premises, ..Default::default() })
}

pub(super) fn dimensions(session: &Session, mut id: ItemId, out: &mut Vec<Premise>) {
    let source = id;
    for _ in 0..16 {
        let Some(item) = session.project.item(id) else { break };
        let fields = match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                out.push(item_need(id, &["kind", "props.parent"]));
                id = *parent;
                continue;
            }
            ItemKind::Media(_) => vec!["kind", "props.media.info.video.width", "props.media.info.video.height"],
            ItemKind::Sequence(_) => vec!["kind", "sequence.settings.settings.width", "sequence.settings.settings.height"],
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => vec!["kind", "props.width", "props.height"],
        };
        out.push(item_need(id, &fields));
        break;
    }
    if session.project.source_size(source).is_none()
        && let Some(id) = session.state.active_sequence
    {
        out.push(item_need(id, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
    }
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<kition_kit::DerivedValues> {
    let mut out = Vec::new();
    let wanted = |id: &Value| ids.is_empty() || ids.iter().any(|requested| requested == id || requested.as_str() == Some(id.to_string().as_str()));
    if names.is_empty() || METADATA_RULES.iter().any(|(name, _)| names.iter().any(|wanted| wanted == name)) {
        for item in session.project.items.values().filter(|item| wanted(&json!(item.id.0))) {
            let values = METADATA_RULES
                .iter()
                .zip(metadata_read_only(session, item.id))
                .filter(|((name, _), _)| names.is_empty() || names.iter().any(|wanted| wanted == name))
                .map(|((name, _), value)| ((*name).to_owned(), json!(value)))
                .collect();
            out.push(kition_kit::DerivedValues { id: json!(item.id.0), values });
        }
    }
    if names.is_empty() || names.iter().any(|name| name == "sourceAudioPlacement") {
        for item in session.project.items.values().filter(|item| wanted(&json!(item.id.0))) {
            // Use the handler's planner: format is unused; absent/empty maps
            // produce the same default channels, and supported limits match.
            let placement = item.as_media().map(|media| {
                if !media.info.has_audio() {
                    return Vec::new();
                }
                let clips = media.interpret.audio_channels.as_ref().map_or(&[][..], |map| map.clips.as_slice());
                kition_film_engine::commands::audio_placement_specs(clips, media.info.audio_streams.len())
                    .into_iter()
                    .map(|spec| {
                        let channels =
                            if spec.audio_stream > 0 { Vec::new() } else { spec.source_channels.unwrap_or_else(|| clips.first().cloned().unwrap_or_default()) };
                        json!({"stream":spec.audio_stream,"channels":channels})
                    })
                    .collect::<Vec<_>>()
            });
            let value =
                kition_kit::DerivedValues { id: json!(item.id.0), values: serde_json::Map::from_iter([("sourceAudioPlacement".to_owned(), json!(placement))]) };
            if let Some(existing) = out.iter_mut().find(|values| values.id == value.id) {
                existing.values.extend(value.values);
            } else {
                out.push(value);
            }
        }
    }
    if wanted(&json!("project")) {
        let mut values = serde_json::Map::new();
        if names.is_empty() || names.iter().any(|n| n == "sequenceCount") {
            values.insert("sequenceCount".to_owned(), json!(session.project.sequences().count()));
        }
        if names.is_empty() || names.iter().any(|n| n == "processedBin") {
            let bin = session.project.root.children.iter().find_map(|entry| match entry {
                BinEntry::Bin(bin) if bin.name == "Processed Clips" => Some(bin.id.0),
                _ => None,
            });
            values.insert("processedBin".to_owned(), json!(bin));
        }
        if !values.is_empty() {
            out.push(kition_kit::DerivedValues { id: json!("project"), values });
        }
    }
    if wanted(&json!("project")) && (names.is_empty() || names.iter().any(|name| name == "metadataColumns")) {
        let mut columns = serde_json::Map::new();
        for column in kition_film_engine::project_panel::all_columns(&session.project) {
            columns.entry(column_key(&column)).or_insert(json!(column));
        }
        if let Some(project) = out.iter_mut().find(|values| values.id == json!("project")) {
            project.values.insert("metadataColumns".to_owned(), Value::Object(columns));
        } else {
            out.push(kition_kit::DerivedValues {
                id: json!("project"),
                values: serde_json::Map::from_iter([("metadataColumns".to_owned(), Value::Object(columns))]),
            });
        }
    }
    let mut bins = vec![&session.project.root];
    while let Some(bin) = bins.pop() {
        let id = json!(bin.id.0);
        if wanted(&id) && (names.is_empty() || names.iter().any(|name| name == "entryOrder")) {
            out.push(kition_kit::DerivedValues {
                id,
                values: serde_json::Map::from_iter([(
                    "entryOrder".to_owned(),
                    json!(
                        bin.children
                            .iter()
                            .filter_map(|entry| match entry {
                                BinEntry::Item(id) => Some(id.0),
                                BinEntry::Bin(_) => None,
                            })
                            .collect::<Vec<_>>()
                    ),
                )]),
            });
        }
        bins.extend(bin.children.iter().filter_map(|entry| match entry {
            BinEntry::Bin(bin) => Some(bin),
            _ => None,
        }));
    }
    out
}

fn presets(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "presets.save" | "presets.apply") {
        return None;
    }
    let seq = session.active_sequence()?;
    // Capture stores source_size even for scalar effects. Applying a preset
    // consumes size only when instantiate can scale a point parameter or mask.
    let size_used = command == "presets.save"
        || params
            .get("preset")
            .and_then(Value::as_str)
            .or_else(|| params.get("name").and_then(Value::as_str))
            .and_then(|name| session.presets.find(name))
            .is_none_or(|preset| {
                preset.effects.iter().any(|effect| {
                    !effect.masks.is_empty()
                        || effect.def().is_some_and(|definition| {
                            definition
                                .params
                                .iter()
                                .any(|param| matches!(param.kind, kition_film_engine::project::ParamKind::Point) && effect.params.contains_key(param.id))
                        })
                })
            });
    let clips: Vec<ClipId> = if command == "presets.save" {
        kition_film_engine::commands::clip_p(params, "clip")
            .or_else(|| session.state.selection.iter().copied().find(|c| seq.video_tracks.iter().any(|t| t.item(*c).is_some())))
            .or_else(|| session.state.selection.first().copied())
            .into_iter()
            .collect()
    } else {
        params
            .get("clips")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(ClipId).collect())
            .unwrap_or_else(|| session.state.selection.clone())
    };
    let mut premises = Vec::new();
    for id in clips {
        let Some((track, clip)) = seq.find_item(id) else { continue };
        let mut premise = need(json!(id.0), ["effects", "item", "sourceIn", "speed"].map(str::to_owned));
        premise.positions = Some(vec!["duration".to_owned(), "clips".to_owned()]);
        if command == "presets.save" && params.get("keyframes").and_then(Value::as_str).is_some_and(|k| k.eq_ignore_ascii_case("none")) {
            premise.fields.get_or_insert_with(Vec::new).extend(["reverse", "props.frame_hold"].map(str::to_owned));
            premise.positions.get_or_insert_with(Vec::new).push("start".to_owned());
        }
        premises.push(premise);
        premises.push(need(json!(track.0), ["props.kind".to_owned()]));
        if size_used {
            dimensions(session, clip.item, &mut premises);
        }
    }
    Some(Under { premises, ..Default::default() })
}

fn source_rate(session: &Session, mut source: ItemId, origin: bool, answer: &mut Under) {
    for _ in 0..16 {
        let Some(item) = session.project.item(source) else { break };
        let mut fields = vec!["kind"];
        match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                fields.push("props.parent");
                answer.premises.push(item_need(source, &fields));
                source = *parent;
                continue;
            }
            ItemKind::Media(media) => {
                fields.push("props.media.interpret.frame_rate");
                if media.interpret.frame_rate.is_none() {
                    fields.push("props.media.info.video.frame_rate");
                }
                if origin {
                    fields.push("props.media.info.start_timecode");
                }
            }
            ItemKind::Sequence(_) => fields.push("sequence.settings.settings.frame_rate"),
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => fields.push("props.rate"),
        }
        answer.premises.push(item_need(source, &fields));
        break;
    }
}

fn edit_subclip(session: &Session, params: &Value) -> Under {
    let item = kition_film_engine::commands::item_p(params, "item").or_else(|| {
        session.state.project_selection.iter().copied().find(|id| session.project.item(*id).is_some_and(|item| matches!(item.kind, ItemKind::Subclip { .. })))
    });
    let mut answer = Under::default();
    let Some(item) = item else { return answer };
    answer.premises.push(item_need(item, &["kind", "props.parent", "props.range", "props.restrict_trims"]));
    let Some(ItemKind::Subclip { parent, .. }) = session.project.item(item).map(|item| &item.kind) else { return answer };
    if params.get("convertToMaster").and_then(Value::as_bool) == Some(true) {
        // Conversion clones the direct parent's complete MediaClip.
        answer.premises.push(item_need(*parent, &["kind", "props.media"]));
    } else if ["start", "end"]
        .iter()
        .any(|key| params.get(*key).and_then(Value::as_i64).is_none() && params.get(format!("{key}Frame")).and_then(Value::as_i64).is_some())
    {
        source_rate(session, *parent, false, &mut answer);
    }
    answer
}

fn frame_hold(session: &Session, params: &Value) -> Option<Under> {
    let q = session.active_sequence()?;
    let mut answer = Under::default();
    let enabled = params.get("enabled").and_then(Value::as_bool) != Some(false);
    let mode = params.get("holdOn").and_then(Value::as_str).unwrap_or("in");
    for id in kition_film_engine::commands::clips_p(session, params) {
        // Retain the default clip hold, including video-track eligibility.
        answer.premises.push(Premise::on(json!(id.0)));
        let Some(clip) = q.video_tracks.iter().find_map(|track| track.item(id)).filter(|_| enabled) else { continue };
        source_rate(session, clip.item, mode == "sourceTimecode" && params.get("timecode").and_then(Value::as_str).is_some(), &mut answer);
    }
    if enabled && mode == "sequenceTime" && params.get("time").and_then(Value::as_i64).is_none() {
        let frame = params.get("frame").and_then(Value::as_i64).is_some();
        let timecode = !frame && params.get("seconds").and_then(Value::as_f64).is_none() && params.get("timecode").and_then(Value::as_str).is_some();
        if (frame || timecode)
            && let Some(sequence) = session.state.active_sequence
        {
            let mut fields = vec!["sequence.settings.settings.frame_rate"];
            if timecode {
                fields.push("sequence.settings.settings.drop_frame");
            }
            answer.premises.push(item_need(sequence, &fields));
        }
    }
    Some(answer)
}

fn audio_channels(session: &Session, params: &Value) -> Under {
    let candidates = kition_film_engine::clip_ops::items_p(session, params);
    let eligible: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|id| session.project.item(*id).and_then(|item| item.as_media()).is_some_and(|media| media.info.has_audio()))
        .collect();
    let timeline = params.get("channels").is_some() || eligible.is_empty();
    let mut answer = Under::default();
    for id in candidates {
        let mut fields = Vec::new();
        if params.get("channels").is_none() {
            fields.push("kind");
            if matches!(session.project.item(id).map(|item| &item.kind), Some(ItemKind::Media(_))) {
                fields.push("props.media.info.audio_streams");
            }
            if eligible.contains(&id) {
                fields.push("props.media.interpret.audio_channels");
            }
        }
        answer.premises.push(item_need(id, &fields));
    }
    if !timeline {
        return answer;
    }
    let Some(sequence) = session.active_sequence() else { return answer };
    let named = params.get("clips").and_then(Value::as_array).filter(|values| values.iter().all(Value::is_u64));
    let targets: Vec<_> = if let Some(named) = named {
        named.iter().filter_map(Value::as_u64).map(ClipId).collect()
    } else {
        for id in &session.state.selection {
            answer.premises.push(Premise::on(json!(id.0)).fields(Vec::<String>::new()).positions(["clips"]));
            if let Some((owner, _)) = sequence.find_item(*id) {
                answer.premises.push(need(json!(owner.0), ["props.kind".to_owned()]));
            }
        }
        session.state.selection.iter().copied().filter(|id| sequence.audio_tracks.iter().any(|track| track.item(*id).is_some())).collect()
    };
    for id in targets {
        let Some((_, clip)) = sequence.find_item(id) else { continue };
        answer.premises.push(need(json!(id.0), ["item", "props.audio_stream", "props.source_channels"].map(str::to_owned)));
        super::rests_effects::source(session, clip.item, &mut answer);
    }
    answer
}

fn media_targets(session: &Session, command: &str, params: &Value) -> Under {
    let interpret = command == "clip.interpretFootage";
    let mut candidates = if interpret {
        params
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(ItemId).collect())
            .unwrap_or_else(|| session.state.project_selection.clone())
    } else {
        kition_film_engine::clip_ops::items_p(session, params)
    };
    let mut answer = Under::default();
    if interpret
        && params.get("items").and_then(Value::as_array).is_none()
        && !candidates.iter().any(|id| session.project.item(*id).and_then(|item| item.as_media()).is_some())
        && let Some(sequence) = session.active_sequence()
    {
        for id in &session.state.selection {
            answer.premises.push(need(json!(id.0), ["item".to_owned()]));
            if let Some((_, clip)) = sequence.find_item(*id) {
                candidates.push(clip.item);
            }
        }
    }
    for id in candidates {
        let media = session.project.item(id).and_then(|item| item.as_media());
        let mut fields = vec!["kind"];
        if interpret {
            if media.is_some() {
                fields.push("props.media.interpret.color_space");
            }
            answer.premises.push(item_need(id, &fields));
        } else {
            if media.is_some() {
                fields.push("props.media.info.audio_streams");
            }
            let eligible = media.is_some_and(|media| media.info.has_audio());
            if eligible {
                fields.extend(["name", "props.common.label", "props.media"]);
            }
            let premise = item_need(id, &fields);
            answer.premises.push(if eligible { premise.positions(["entries"]) } else { premise });
        }
    }
    answer
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if matches!(command, "clip.interpretFootage" | "clip.breakoutToMono") {
        return Some(media_targets(session, command, params));
    }
    if command == "clip.audioChannels" {
        return Some(audio_channels(session, params));
    }
    if command == "clip.editSubclip" {
        return Some(edit_subclip(session, params));
    }
    if command == "clip.frameHoldOptions" {
        return frame_hold(session, params);
    }
    if let Some(under) = freeform(session, command, params).or_else(|| presets(session, command, params)) {
        return Some(under);
    }
    let columns: Vec<&str> = match command {
        "project.sort" => params.get("column").and_then(Value::as_str).into_iter().collect(),
        "project.view.set" => params.get("iconSort").and_then(|v| v.as_str().or_else(|| v.get("column").and_then(Value::as_str))).into_iter().collect(),
        "project.columns.set" => params
            .get("columns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().or_else(|| v.get("name").and_then(Value::as_str)))
            .collect(),
        _ => Vec::new(),
    };
    if !columns.is_empty() {
        return Some(Under {
            premises: vec![need(json!("project"), columns.into_iter().map(|name| format!("~metadataColumns.{}", column_key(name))))],
            ..Default::default()
        });
    }
    if matches!(command, "project.view.set" | "project.columns.set" | "project.sort") {
        return Some(Under::default());
    }
    if command == "metadata.set" {
        let item = kition_film_engine::panels::metadata_target(session, params)?;
        let keys: Vec<&str> = params
            .get("field")
            .and_then(Value::as_str)
            .into_iter()
            .chain(params.get("fields").and_then(Value::as_object).into_iter().flat_map(|fields| fields.keys().map(String::as_str)))
            .collect();
        if keys.is_empty() {
            return None;
        }
        let fields = keys
            .iter()
            .map(|key| {
                if key.eq_ignore_ascii_case("name") {
                    "name".to_owned()
                } else if key.eq_ignore_ascii_case("label") {
                    "props.common.label".to_owned()
                } else if key.contains(['.', '[', ']', '/', '~']) {
                    format!("/props/common/metadata/{}", key.replace('~', "~0").replace('/', "~1"))
                } else {
                    format!("props.common.metadata.{key}")
                }
            })
            .collect();
        let mut premises = vec![Premise { id: json!(item.0), fields: Some(fields), positions: Some(Vec::new()), ..Default::default() }];
        let clip = if kition_film_engine::commands::item_p(params, "item").is_some() {
            None
        } else if let Some(clip) = kition_film_engine::commands::clip_p(params, "clip") {
            Some(clip)
        } else if session.state.project_selection.is_empty() {
            session.state.selection.first().copied()
        } else {
            None
        };
        if let Some(clip) = clip {
            premises.push(Premise { id: json!(clip.0), fields: Some(vec!["item".to_owned()]), positions: Some(Vec::new()), ..Default::default() });
        }
        premises.extend(metadata_eligibility(item, &keys));
        return Some(Under { premises, ..Default::default() });
    }
    if command == "project.freeform.move"
        && let Some(positions) = params.get("positions").and_then(Value::as_object)
    {
        // project_panel::freeform_move parses each map key as an ItemId, then
        // preserves the size stored beside the assigned x/y in this metadata leaf.
        // Its source bin position, name and other metadata are not consumed.
        return Some(Under {
            premises: positions
                .keys()
                .filter_map(|key| key.parse::<u64>().ok())
                .map(|id| Premise {
                    id: json!(id),
                    fields: Some(vec!["props.common.metadata.Freeform Position".to_owned()]),
                    positions: Some(Vec::new()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });
    }
    let (prefix, keys): (&str, &[(&str, &str)]) = match command {
        "file.projectSettings.general" => (
            "settings",
            &[
                ("renderer", "renderer"),
                ("videoDisplay", "video_display"),
                ("audioDisplay", "audio_display_samples"),
                ("captureFormat", "capture_format"),
                ("titleSafe", "title_safe"),
                ("actionSafe", "action_safe"),
            ],
        ),
        "file.projectSettings.scratchDisks" => {
            ("settings.scratch", &[("captured", "captured"), ("videoPreviews", "videoPreviews"), ("audioPreviews", "audioPreviews"), ("autoSave", "autoSave")])
        }
        "project.ingestSettings" => ("settings.ingest", &[("enabled", "enabled"), ("action", "action"), ("destination", "destination"), ("preset", "preset")]),
        _ => return None,
    };
    let fields = keys.iter().filter(|(key, _)| params.get(*key).is_some()).map(|(_, field)| format!("{prefix}.{field}")).collect();
    Some(Under {
        premises: vec![Premise { id: json!("project"), fields: Some(fields), positions: Some(Vec::new()), ..Default::default() }],
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_film_engine::time::Tick;

    #[test]
    fn metadata_predicates_match_the_handlers_rows_for_every_item_kind() {
        let mut session = Session::default();
        session.execute("file.newSequence", json!({"name":"Sequence","width":64,"height":36})).unwrap();
        let sequence = session.state.active_sequence.unwrap();
        let media = ItemId(session.execute("file.newOfflineFile", json!({"name":"Source","seconds":1})).unwrap()["item"].as_u64().unwrap());
        let sub = ItemId(session.execute("clip.makeSubclip", json!({"item":media.0,"name":"Sub"})).unwrap()["item"].as_u64().unwrap());
        let nested = {
            let project = std::sync::Arc::make_mut(&mut session.project);
            project.add_item(
                "Sub of sub",
                kition_film_engine::project::Label::Iris,
                ItemKind::Subclip { parent: sub, range: kition_film_engine::time::TimeRange::new(Tick::ZERO, Tick(1)), restrict_trims: true },
                None,
            )
        };
        let adjustment = ItemId(session.execute("file.newAdjustmentLayer", json!({})).unwrap()["item"].as_u64().unwrap());
        session.execute("graphics.newText", json!({"text":"Example","track":0,"time":0})).unwrap();
        let graphic = session.project.items.values().find(|item| matches!(item.kind, ItemKind::Graphic { .. })).unwrap().id;
        let original = session.project.item(media).unwrap().as_media().unwrap().info.clone();
        for bits in 0..16 {
            let project = std::sync::Arc::make_mut(&mut session.project);
            let source = project.item_mut(media).unwrap().as_media_mut().unwrap();
            source.info.video = if bits & 1 != 0 { original.video.clone() } else { None };
            source.info.audio_streams = if bits & 2 != 0 { original.audio_streams.clone() } else { Vec::new() };
            source.mark_in = (bits & 4 != 0).then_some(Tick(0));
            source.mark_out = (bits & 8 != 0).then_some(Tick(1));
            for id in [media, sub, nested, sequence, adjustment, graphic] {
                let rows = kition_film_engine::panels::metadata_fields(&session.project, id);
                for ((name, labels), value) in METADATA_RULES.iter().zip(metadata_read_only(&session, id)) {
                    for label in *labels {
                        let actual = rows.iter().any(|row| row.name.eq_ignore_ascii_case(label) && !row.editable);
                        assert_eq!(value, actual, "{name}/{label}, item={id:?}, bits={bits}");
                    }
                }
            }
        }
    }
}
