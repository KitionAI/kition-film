//! Replay subset-join membership from the SDK's bounded historical predicate values.
use kition_film_engine::{
    Session,
    project::{ClipId, Track, TrackId, TrackItem, TrackKind},
};
use kition_kit::{Covered, CoveredAsk, CoveredAt};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::Arc;

pub fn input(clip: &TrackItem) -> Value {
    // Positions stay in the SDK’s positional history, so this predicate fact does
    // not turn an unrelated trim or move into a content edit on every clip.
    json!([clip.item.0, clip.source_in.0, clip.speed, clip.reverse, clip.frame_hold, clip.multicam, clip.link])
}

pub fn members(session: &Session, params: &Value) -> BTreeSet<u64> {
    let mut preview = session.scratch();
    if preview.execute("sequence.joinThroughEdits", params.clone()).is_err() {
        return BTreeSet::new();
    }
    session
        .active_sequence()
        .into_iter()
        .flat_map(|q| q.all_tracks())
        .flat_map(|track| &track.items)
        .filter(|clip| preview.active_sequence().is_some_and(|q| q.find_item(clip.id).is_none()))
        .map(|clip| clip.id.0)
        .collect()
}

fn historical_clip(id: u64, owner: TrackId, start: Value, duration: Value, input: &Value) -> Option<(TrackId, TrackItem)> {
    let value = json!({
        "id":id,"item":input.get(0)?,"source_in":input.get(1)?,"speed":input.get(2)?,
        "reverse":input.get(3)?,"frame_hold":input.get(4)?,"multicam":input.get(5)?,"link":input.get(6)?,
        "start":start,"duration":duration,"name":"","label":"Lavender","enabled":true,"effects":[]
    });
    Some((owner, serde_json::from_value(value).ok()?))
}

pub fn covered(session: &Session, params: &Value, asks: &[CoveredAsk]) -> Option<CoveredAt> {
    let sequence_id = session.state.active_sequence?;
    let mut historical = session.scratch();
    let sequence = Arc::make_mut(&mut historical.project).sequence_mut(sequence_id)?;
    let mut known = true;
    for ask in asks {
        if ask.unknown.iter().any(|field| field == "~joinInput" || field == "~joinLock") {
            known = false;
        }
        let Some(id) = ask.id.as_u64().or_else(|| ask.id.as_str().and_then(|id| id.parse().ok())) else { continue };
        if let Some(locked) = ask.before.get("~joinLock").and_then(Value::as_bool) {
            if sequence.track(TrackId(id)).is_none() && !ask.created {
                sequence.video_tracks.push(Track::new(TrackId(id), TrackKind::Video, String::new()));
            }
            if let Some(track) = sequence.track_mut(TrackId(id)) {
                track.locked = locked;
            }
        }
        let now = sequence.find_item(ClipId(id));
        let numeric = |value: &Value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()));
        let owner = ask.before.get("$at").and_then(|at| at.get("parent")).and_then(numeric).map(TrackId).or(now.map(|(owner, _)| owner));
        let tick = |field: &str, fallback: Option<i64>| {
            ask.before
                .get(field)
                .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
                .or(fallback)
                .map(|value| json!(value))
        };
        let predicate = ask.before.get("~joinInput").cloned().or_else(|| now.map(|(_, clip)| input(clip)));
        let old = owner.zip(predicate).and_then(|(owner, predicate)| {
            historical_clip(id, owner, tick("start", now.map(|(_, clip)| clip.start.0))?, tick("duration", now.map(|(_, clip)| clip.duration.0))?, &predicate)
        });
        let is_clip = old.is_some() || sequence.find_item(ClipId(id)).is_some();
        if !is_clip {
            continue;
        }
        if ask.deleted && old.is_none() {
            known = false;
        }
        if old.is_some() || ask.created {
            for track in sequence.all_tracks_mut() {
                track.items.retain(|clip| clip.id != ClipId(id));
            }
        }
        if !ask.created
            && let Some((owner, clip)) = old
        {
            if sequence.track(owner).is_none() {
                sequence.video_tracks.push(Track::new(owner, TrackKind::Video, String::new()));
            }
            sequence.track_mut(owner)?.items.push(clip);
        }
    }
    for track in sequence.all_tracks_mut() {
        track.items.sort_by_key(|clip| (clip.start, clip.id));
    }
    let under = members(&historical, params);
    Some(CoveredAt {
        under: under.iter().map(|id| json!(id)).collect(),
        covered: asks
            .iter()
            .map(|ask| {
                let id = ask.id.as_u64().or_else(|| ask.id.as_str().and_then(|id| id.parse().ok()));
                Covered { id: ask.id.clone(), covered: known.then(|| id.is_some_and(|id| under.contains(&id))), gone: ask.deleted, ..Default::default() }
            })
            .collect(),
    })
}
