//! Independent identities for scoped computed facts. Eager derived receipts are atomic and
//! may omit large values; a fact object lets the SDK compare exactly the consumed scope.
use kition_film_engine::Session;
use kition_kit::{ContentAsk, Premise, Under, kdm::projection::ProjectedObject};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) fn id(holder: &Value, path: &str) -> String {
    format!("fact:{}:{path}", holder.as_str().map(str::to_owned).unwrap_or_else(|| holder.to_string()))
}

/// These handlers use selection only after their native explicit-id parsers fail.
/// Keep that conditional input separate from the global editor-state declaration.
pub fn selection(session: &Session, command: &str, params: &Value, under: &mut Under) {
    use kition_film_engine::commands::{clip_p, item_p};
    let field = match command {
        "clip.rename" if item_p(params, "item").is_none() && clip_p(params, "clip").is_none() => "~renameSelection",
        "clip.setTimeInterpolation" if params.get("clips").and_then(Value::as_array).is_none() && clip_p(params, "clip").is_none() => "~interpolationSelection",
        _ => return,
    };
    under.premises.push(Premise::on(json!("project")).fields([field]).positions(Vec::<String>::new()));
    if command == "clip.rename"
        && let Some(clip) = session.state.selection.first()
    {
        under.premises.push(super::rests_core::scoped_clip_fields(session, *clip, ["props.name".to_owned()]));
    }
}

pub fn content(ask: &ContentAsk) -> Option<bool> {
    // This callback is asked only after a proven change of the assigned field.
    // Content premises precede destination membership, preserving `changed`.
    if ask.premise.field == "start" && ask.premise.region == "keyboard-assigned-start" {
        return Some(true);
    }
    if ask.premise.field == "~parentBin" {
        let holder = ask.premise.id.as_str().map(str::to_owned).unwrap_or_else(|| ask.premise.id.to_string());
        let parent = |objects: &Value| -> Option<Value> {
            let objects = objects.as_object()?;
            objects.get(&holder)?;
            let mut parents = objects.values().filter(|object| {
                object.get("$type").and_then(Value::as_str) == Some("Bin")
                    && object.get("entries").and_then(Value::as_array).is_some_and(|entries| entries.iter().any(|entry| entry.as_str() == Some(&holder)))
            });
            let result = parents.next().map(|bin| bin.get("binId").cloned()).unwrap_or(Some(Value::Null))?;
            if parents.next().is_some() { None } else { Some(result) }
        };
        for change in ask.before.get("history")?.as_array()? {
            if parent(change.get("before")?.get("objects")?)? != parent(change.get("after")?.get("objects")?)? {
                return Some(true);
            }
        }
        return Some(false);
    }
    if ask.premise.id == "project" && matches!(ask.premise.field.as_str(), "~renameSelection" | "~interpolationSelection") {
        let history = ask.before.get("history")?.as_array()?;
        for change in history {
            let selection = |side: &str| -> Option<Value> {
                let selected = change.get(side)?.get("objects")?.get("film:editor-premises")?.get("selection")?.as_array()?;
                Some(if ask.premise.field == "~renameSelection" { selected.first().cloned().unwrap_or(Value::Null) } else { json!(selected) })
            };
            let (before, after) = (selection("before")?, selection("after")?);
            if before != after {
                return Some(true);
            }
        }
        return Some(false);
    }
    let field = match ask.premise.field.as_str() {
        "~videoTrackNames" => "videoTracks",
        "~audioTrackNames" => "audioTracks",
        "~submixTrackNames" => "submixTracks",
        _ => return None,
    };
    let holder = ask.premise.id.as_u64().map(|id| id.to_string()).or_else(|| ask.premise.id.as_str().map(str::to_owned))?;
    let objects = ask.before.get("objects")?;
    let item = objects.get(&holder)?;
    if item.get("kind").and_then(Value::as_str).is_some_and(|kind| kind != "sequence") {
        return Some(false);
    }
    let mut observed: BTreeSet<String> = track_ids(objects, &holder, field)?.into_iter().map(str::to_owned).collect();
    let mut outside_created = BTreeSet::new();
    let mut previous: Option<&Value> = None;
    let history = ask.before.get("history")?.as_array()?;
    for change in history {
        let before = change.get("before")?.get("objects")?;
        let after = change.get("after")?.get("objects")?;
        let before_ids = track_ids(before, &holder, field)?;
        let after_ids = track_ids(after, &holder, field)?;
        for id in &before_ids {
            // A lane present before the next outside transition can have been
            // created or assigned by this agent after the requested checkpoint.
            if !outside_created.contains(*id) || previous.is_some_and(|last| track_name(last, id) != track_name(before, id)) {
                observed.insert((*id).to_owned());
            }
        }
        for id in &observed {
            // Newly appended tracks were not observed. A removed original lane
            // or any outside assignment to its name still invalidates the input.
            if track_name(before, id) != track_name(after, id) {
                return Some(true);
            }
        }
        outside_created.extend(after_ids.difference(&before_ids).map(|id| (*id).to_owned()));
        previous = Some(after);
    }
    Some(false)
}

fn track_name<'a>(state: &'a Value, id: &str) -> Option<&'a str> {
    state.get(id)?.get("props")?.get("name").and_then(Value::as_str)
}

fn track_ids<'a>(objects: &'a Value, holder: &str, field: &str) -> Option<BTreeSet<&'a str>> {
    let sequence = objects.get(holder)?.get("sequence")?.as_str()?;
    objects.get(sequence)?.get(field)?.as_array()?.iter().map(Value::as_str).collect()
}

pub fn scope(under: &mut Under) {
    let mut facts = Vec::new();
    for need in &mut under.premises {
        let Some(fields) = &mut need.fields else { continue };
        fields.retain(|field| {
            let arrangement = field
                .strip_prefix("/props/common/metadata/Freeform Arrangement: ")
                .map(|name| name.replace("~1", "/").replace("~0", "~"))
                .or_else(|| field.strip_prefix("props.common.metadata.Freeform Arrangement: ").map(str::to_owned));
            if let Some(name) = arrangement {
                let path = format!("arrangements.{}", arrangement_key(&name));
                facts.push(Premise::on(json!("film:item-premises")).fields([format!("items.i{}.{}", need.id, path)]).positions(Vec::<String>::new()));
                false
            } else if field == "~submixDependants" || ["~fontUses.", "~metadataColumns.", "~mixerRoutes."].iter().any(|prefix| field.starts_with(prefix)) {
                facts.push(Premise::on(json!(id(&need.id, field))).fields(["value"]).positions(Vec::<String>::new()));
                false
            } else {
                true
            }
        });
    }
    under.premises.extend(facts);
}

/// A positional field explicitly held as content is an assignment. Preserve the original
/// premise and add a private scalar fact, since the generic position guard excludes it.
pub fn assignments(under: &mut Under, command: &str, params: &Value) {
    let inserts = command == "source.insert"
        || command == "timeline.place" && params.get("insert").and_then(Value::as_bool) == Some(true)
        || command == "clip.automateToSequence" && params.get("method").and_then(Value::as_str) != Some("overwrite");
    if !inserts {
        return;
    }
    let mut extra = Vec::new();
    for need in &under.premises {
        if need.fields.as_ref().is_some_and(|fields| fields.iter().any(|held| held == "start")) {
            extra.push(Premise::on(need.id.clone()).fields(["~assignedStart"]).positions(Vec::<String>::new()));
        }
    }
    under.premises.extend(extra);
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<kition_kit::DerivedValues> {
    if !names.is_empty() && !names.iter().any(|name| name == "assignedStart") {
        return Vec::new();
    }
    let mut out = Vec::new();
    for sequence in session.project.sequences().filter_map(|item| session.project.sequence(item.id)) {
        for track in sequence.all_tracks() {
            for (id, start, _duration) in track
                .items
                .iter()
                .map(|clip| (clip.id.0, clip.start, clip.duration))
                .chain(track.transitions.iter().map(|clip| (clip.id.0, clip.start, clip.duration)))
            {
                if !ids.is_empty() && !ids.iter().any(|value| value.as_u64() == Some(id) || value.as_str().is_some_and(|text| text == id.to_string())) {
                    continue;
                }
                let values = [("assignedStart", start)]
                    .into_iter()
                    .filter(|(name, _)| names.is_empty() || names.iter().any(|wanted| wanted == name))
                    .map(|(name, value)| (name.into(), json!(value.0.to_string())))
                    .collect();
                out.push(kition_kit::DerivedValues { id: json!(id), values });
            }
        }
    }
    out
}

fn leaves(out: &mut Vec<ProjectedObject>, holder: &Value, path: &str, value: &Value) {
    if let Value::Object(members) = value {
        for (key, value) in members {
            leaves(out, holder, &format!("{path}.{key}"), value);
        }
    } else {
        let key = id(holder, path);
        out.push(ProjectedObject {
            id: key.clone(),
            ty: "PremiseFact".into(),
            fields: serde_json::Map::from_iter([("key".into(), json!(key)), ("value".into(), value.clone())]),
            at: None,
        });
    }
}

fn arrangement_key(name: &str) -> String {
    use std::fmt::Write;
    let mut key = String::from("a");
    for byte in name.bytes() {
        let _ = write!(key, "{byte:02x}");
    }
    key
}

pub fn objects(session: &Session) -> Vec<ProjectedObject> {
    // No tool id: this editor-only checkpoint is retained for private fact
    // comparisons and never names a public changed object in receipts.
    let mut out = vec![ProjectedObject {
        id: "film:editor-premises".into(),
        ty: "EditorPremises".into(),
        fields: serde_json::Map::from_iter([("selection".into(), json!(session.state.selection.iter().map(|clip| clip.0).collect::<Vec<_>>()))]),
        at: None,
    }];
    out.push(super::rests_search::object());
    let mut items = serde_json::Map::new();
    for item in session.project.items.values() {
        let arrangements: serde_json::Map<_, _> = item
            .metadata
            .iter()
            .filter_map(|(key, value)| key.strip_prefix("Freeform Arrangement: ").map(|name| (arrangement_key(name), json!(value))))
            .collect();
        items.insert(format!("i{}", item.id.0), json!({"arrangements": arrangements}));
    }
    // One stable checkpoint avoids manufacturing a second deleted object for
    // each public item. Encoded map keys retain exact literal-key comparison.
    out.push(ProjectedObject {
        id: "film:item-premises".into(),
        ty: "ItemPremises".into(),
        fields: serde_json::Map::from_iter([("items".into(), json!(items))]),
        at: None,
    });
    for sequence in session.project.sequences().filter_map(|item| session.project.sequence(item.id)) {
        for track in &sequence.video_tracks {
            for (index, clip) in track.items.iter().enumerate() {
                if !matches!(session.project.item(clip.item).map(|item| &item.kind), Some(kition_film_engine::project::ItemKind::Graphic { .. })) {
                    continue;
                }
                let key = id(&json!(clip.id.0), "~followingClip");
                out.push(ProjectedObject {
                    id: key.clone(),
                    ty: "PremiseFact".into(),
                    fields: serde_json::Map::from_iter([
                        ("key".into(), json!(key)),
                        ("value".into(), json!(track.items.get(index.saturating_add(1)).map(|next| (next.id.0, next.start.0.to_string())))),
                    ]),
                    at: None,
                });
            }
        }
    }
    let facts = super::rests_fonts::derived(session, &[], &["fontUses".into()])
        .into_iter()
        .chain(super::rests_media::derived(session, &[], &["metadataColumns".into()]))
        .chain(super::rests_effects::derived(session, &[], &["mixerRoutes".into(), "submixDependants".into()]));
    for fact in facts {
        for (name, value) in fact.values {
            // Null denotes the existing bounded mixer fallback, not a scoped pair.
            if value.is_object() || name == "submixDependants" {
                leaves(&mut out, &fact.id, &format!("~{name}"), &value);
            }
        }
    }
    out
}
