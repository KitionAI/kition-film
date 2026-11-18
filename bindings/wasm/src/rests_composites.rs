//! Compound sound placement, import dispatch and voice-over inputs.
use kition_film_engine::{Session, project::ItemId};
use kition_kit::{DerivedValues, Premise, Under};
use serde_json::{Value, json};

fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "file.import" {
        return Some(Under {
            premises: std::iter::once(leaf(json!("project"), &["bins", "settings.ingest", "~importOptions"]))
                .chain(session.project.items.values().map(|item| Premise::on(json!(item.id.0))))
                .collect(),
            ..Default::default()
        });
    }
    if !matches!(command, "timeline.placeMany" | "sound.phrase" | "transition.beatCut" | "audio.bed" | "audio.voiceover.start" | "audio.voiceover.sync") {
        return None;
    }
    let id = session.state.active_sequence?;
    let sequence = session.active_sequence()?;
    let mut answer = Under::default();
    if command.starts_with("audio.voiceover") {
        answer.premises.push(leaf(
            json!(id.0),
            &[
                "sequence.settings.mark_in",
                "sequence.settings.mark_out",
                "sequence.settings.settings.sample_rate",
                "sequence.settings.settings.frame_rate",
                "sequence.settings.settings.drop_frame",
                "~audioTrackOrder",
            ],
        ));
        answer.premises.push(leaf(json!("project"), &["~voiceoverOptions"]));
        answer.premises.extend(sequence.audio_tracks.iter().map(|track| leaf(json!(track.id.0), &["props.locked", "props.mixer.record_arm", "props.name"])));
        return Some(answer);
    }
    // Each sound can grow the lane list and change the next sound's free-lane
    // search. Keep the complete destination plan across all placements.
    answer.premises.push(leaf(json!(id.0), &["sequence"]));
    answer.premises.push(leaf(json!("project"), &["~placementOptions"]));
    let mut sources: Vec<_> = sequence.all_tracks().flat_map(|track| &track.items).map(|clip| clip.item).collect();
    if let Some(item) = params.get("item").and_then(Value::as_u64) {
        sources.push(ItemId(item));
    }
    if let Some(items) = params.get("items") {
        if let Some(items) = items.as_array() {
            sources.extend(items.iter().filter_map(|item| item.get("item").and_then(Value::as_u64)).map(ItemId));
        }
        if let Some(items) = items.as_object() {
            sources.extend(items.values().filter_map(Value::as_u64).map(ItemId));
        }
    }
    if let Some(sfx) = params.get("sfx") {
        if let Some(item) = sfx.as_u64() {
            sources.push(ItemId(item));
        }
        if let Some(items) = sfx.as_array() {
            sources.extend(items.iter().filter_map(Value::as_u64).map(ItemId));
        }
    }
    sources.sort_unstable();
    sources.dedup();
    for source in sources {
        let mut next = Some(source);
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = next.filter(|id| seen.insert(*id)) {
            answer.premises.push(leaf(
                json!(id.0),
                &[
                    "kind",
                    "name",
                    "props.common.label",
                    "props.media",
                    "props.parent",
                    "props.range",
                    "props.restrict_trims",
                    "props.width",
                    "props.height",
                    "props.rate",
                    "sequence",
                    "~sourceGraphicDefinition",
                ],
            ));
            next = match session.project.item(id).map(|item| &item.kind) {
                Some(kition_film_engine::project::ItemKind::Subclip { parent, .. }) => Some(*parent),
                _ => None,
            };
        }
    }
    Some(answer)
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<DerivedValues> {
    if !ids.is_empty() && !ids.iter().any(|id| id == "project") {
        return Vec::new();
    }
    let mut values = serde_json::Map::new();
    for name in ["placementOptions", "importOptions", "voiceoverOptions"] {
        if !names.is_empty() && !names.iter().any(|wanted| wanted == name) {
            continue;
        }
        let value = match name {
            "placementOptions" => json!({
                "media":session.prefs.media,
                "linked":session.state.linked_selection,
                "sequencesAsClips":session.state.sequences_as_clips,
            }),
            "importOptions" => json!({"media":session.prefs.media,"analysis":session.prefs.media_analysis,"labels":session.prefs.labels}),
            _ => json!({"settings":session.prefs.voice_over,"hardware":session.prefs.audio_hardware,"recording":session.voiceover.rec}),
        };
        values.insert(name.to_owned(), value);
    }
    if values.is_empty() { Vec::new() } else { vec![DerivedValues { id: json!("project"), values }] }
}
