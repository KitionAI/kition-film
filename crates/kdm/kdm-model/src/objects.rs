//! The collections a project holds as objects of their own, each written whole, diffed and read
//! here: an effect's parameters (`Effect.params`, a map of `Param` objects by parameter id),
//! markers (`Marker` lists on a sequence, a clip and a media item), caption tracks and captions
//! (a sequence's `CaptionTrack` list, and its `Caption` list, each caption naming its track), a
//! media item's transcript and source graphic, the project's LUTs and search bins.
//!
//! Text a person types (a marker's comment, a caption's text) is a KDM `text` field written as
//! insertions and deletions ([`kition_kit::session::write_text`]), so two people typing in one
//! caption both keep their characters. Every other value is a register of its object, so
//! concurrent edits of different fields, keys, markers or captions all survive a merge.
//!
//! Engine ids kept as data (a marker's, a caption's, a caption track's, a search bin's) are the
//! objects' `id` field: a write finds the object to change by it, never by its index.

use std::collections::{BTreeMap, HashMap};

use kition_film_project::{Caption, CaptionTrack, EffectInstance, Marker, Param, ProjectLut, SearchBin, SourceGraphic, Transcript};
use kition_kit::kdm::{KdmError, ObjectId, Replica, Tx};
use kition_kit::session::{BlobRef, BlobSource, sha256_hex};
use serde_json::{Map, Value, json};

use crate::{kdm_err, tick};

type KdmResult<T> = Result<T, KdmError>;

fn object_of(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> KdmResult<Value> {
    serde_json::to_value(value).map_err(kdm_err)
}

/// Writes `new` over a text field holding `old`, character by character.
fn write_text(tx: &mut Tx<'_>, object: &ObjectId, field: &str, old: &str, new: &str) -> KdmResult<bool> {
    let edits = kition_kit::session::write_text(tx, object, field, old, new).map_err(kdm_err)?;
    Ok(!edits.is_empty())
}

/// Sets every register of `object` whose value differs between `before` and `after` (a register
/// `after` lacks is cleared).
fn set_changed(tx: &mut Tx<'_>, object: &ObjectId, before: &Map<String, Value>, after: &Map<String, Value>) -> KdmResult<bool> {
    let mut wrote = false;
    for (field, value) in after {
        if before.get(field) != Some(value) {
            tx.set(object, field, value.clone())?;
            wrote = true;
        }
    }
    for field in before.keys() {
        if !after.contains_key(field) {
            tx.set(object, field, Value::Null)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Brings the object list `owner.field` to the order of `keys`: an object whose key (`key_of`) is
/// not among them (or repeats one more often than `keys` does) is deleted and removed, a missing
/// key gets a new object from `create`, and the rest are moved into place. Answers whether it
/// wrote, and the (first) object of every key.
fn sync_list<K: Clone + Eq + std::hash::Hash>(
    tx: &mut Tx<'_>,
    owner: &ObjectId,
    field: &str,
    keys: &[K],
    key_of: impl Fn(&Tx<'_>, &ObjectId) -> KdmResult<Option<K>>,
    mut create: impl FnMut(&mut Tx<'_>, &K) -> KdmResult<ObjectId>,
    mut delete: impl FnMut(&mut Tx<'_>, &ObjectId) -> KdmResult<()>,
) -> KdmResult<(bool, HashMap<K, ObjectId>)> {
    let mut wanted: HashMap<&K, usize> = HashMap::new();
    for key in keys {
        *wanted.entry(key).or_default() += 1;
    }
    let mut current = tx.list_items(owner, field)?;
    let mut wrote = false;
    let mut held: HashMap<K, std::collections::VecDeque<ObjectId>> = HashMap::new();
    let mut keep = vec![false; current.len()];
    for (index, object) in current.iter().enumerate() {
        if !tx.exists(object) {
            continue;
        }
        let Some(key) = key_of(&*tx, object)? else { continue };
        let room = wanted.get(&key).copied().unwrap_or(0);
        let objects = held.entry(key).or_default();
        if objects.len() < room {
            objects.push_back(object.clone());
            keep[index] = true;
        }
    }
    for index in (0..current.len()).rev() {
        if keep[index] {
            continue;
        }
        let object = current.remove(index);
        if tx.exists(&object) {
            delete(&mut *tx, &object)?;
        }
        tx.list_remove(owner, field, index)?;
        wrote = true;
    }
    let mut found: HashMap<K, ObjectId> = HashMap::new();
    for (index, key) in keys.iter().enumerate() {
        let object = match held.get_mut(key).and_then(std::collections::VecDeque::pop_front) {
            Some(object) => {
                let at = current.iter().position(|each| *each == object).ok_or_else(|| kdm_err("a kept object is not in its list"))?;
                if at != index {
                    tx.list_move(owner, field, at, index)?;
                    let moved = current.remove(at);
                    current.insert(index, moved);
                    wrote = true;
                }
                object
            }
            None => {
                let object = create(&mut *tx, key)?;
                let at = index.min(current.len());
                tx.list_insert(owner, field, at, &object)?;
                current.insert(at, object.clone());
                wrote = true;
                object
            }
        };
        found.entry(key.clone()).or_insert(object);
    }
    Ok((wrote, found))
}

fn plain_delete(tx: &mut Tx<'_>, object: &ObjectId) -> KdmResult<()> {
    tx.delete(object)
}

fn stored_u64(tx: &Tx<'_>, object: &ObjectId) -> KdmResult<Option<u64>> {
    Ok(tx.get(object, "id")?.as_u64())
}

// --- effects -----------------------------------------------------------------------------------

/// An effect's registers (everything but its parameters).
pub(crate) fn effect_registers(effect: &EffectInstance) -> KdmResult<Map<String, Value>> {
    let mut fields = Map::new();
    fields.insert("def".into(), json!(effect.effect));
    fields.insert("enabled".into(), json!(effect.enabled));
    fields.insert("postFader".into(), json!(effect.post_fader));
    fields.insert("audioMixing".into(), json!(effect.audio_mixing));
    if !effect.masks.is_empty() {
        fields.insert("masks".into(), to_value(&effect.masks)?);
    }
    if let Some(layer) = &effect.layer {
        fields.insert("layer".into(), to_value(layer)?);
    }
    Ok(fields)
}

/// An effect's parameters, by parameter id, as the `params` map holds them.
pub(crate) fn effect_params(effect: &EffectInstance) -> KdmResult<BTreeMap<String, Value>> {
    effect.params.iter().map(|(name, param)| Ok((name.clone(), to_value(param)?))).collect()
}

/// The effect as one comparable value (registers and parameters), as this crate writes it: an
/// "auto" point is `f64::NAN`, never equal to itself, but always the same `null` once serialized.
pub(crate) fn effect_value(effect: &EffectInstance) -> KdmResult<Value> {
    Ok(json!({ "registers": effect_registers(effect)?, "params": effect_params(effect)? }))
}

/// A parameter's registers (`value`, and `keyframes` when it has any), as its `Param` object
/// holds them.
pub(crate) fn param_registers(param: &Param) -> KdmResult<Map<String, Value>> {
    Ok(object_of(to_value(param)?))
}

/// A `Param` object's registers as stored (`keyframes` only when set).
pub(crate) fn stored_param_registers(tx: &Tx<'_>, object: &ObjectId) -> KdmResult<Map<String, Value>> {
    let mut fields = Map::new();
    fields.insert("value".into(), tx.get(object, "value")?);
    let keyframes = tx.get(object, "keyframes")?;
    if !keyframes.is_null() {
        fields.insert("keyframes".into(), keyframes);
    }
    Ok(fields)
}

fn create_param(tx: &mut Tx<'_>, param: &Param) -> KdmResult<ObjectId> {
    tx.create("Param", param_registers(param)?)
}

/// The live `Param` objects an effect's `params` map holds, by parameter id.
pub(crate) fn param_objects(tx: &Tx<'_>, effect: &ObjectId) -> KdmResult<BTreeMap<String, ObjectId>> {
    let mut held = BTreeMap::new();
    for (name, value) in tx.map_entries(effect, "params")? {
        if let Some(object) = value.as_str().map(ObjectId::from_string)
            && tx.exists(&object)
        {
            held.insert(name, object);
        }
    }
    Ok(held)
}

/// Creates an `Effect` object holding `effect`, each parameter a `Param` object in its `params`
/// map.
pub(crate) fn create_effect(tx: &mut Tx<'_>, effect: &EffectInstance) -> KdmResult<ObjectId> {
    let object = tx.create("Effect", effect_registers(effect)?)?;
    for (name, param) in &effect.params {
        let child = create_param(tx, param)?;
        tx.map_set(&object, "params", name, json!(child.as_str()))?;
    }
    Ok(object)
}

/// Writes what differs between `before` and `after` onto the effect's object: a changed
/// parameter's registers on its own `Param` object, so two people editing two parameters (or the
/// value and the keyframes of one) both keep their edit.
pub(crate) fn update_effect(tx: &mut Tx<'_>, object: &ObjectId, before: &EffectInstance, after: &EffectInstance) -> KdmResult<bool> {
    let mut wrote = set_changed(tx, object, &effect_registers(before)?, &effect_registers(after)?)?;
    let held = param_objects(tx, object)?;
    for (name, param) in &after.params {
        let new = param_registers(param)?;
        match held.get(name) {
            Some(child) => {
                let old = match before.params.get(name) {
                    Some(old) => param_registers(old)?,
                    None => stored_param_registers(tx, child)?,
                };
                if old != new {
                    wrote |= set_changed(tx, child, &old, &new)?;
                }
            }
            None => {
                let child = create_param(tx, param)?;
                tx.map_set(object, "params", name, json!(child.as_str()))?;
                wrote = true;
            }
        }
    }
    for (name, child) in &held {
        if !after.params.contains_key(name) {
            tx.map_delete(object, "params", name)?;
            tx.delete(child)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Reads a `Param` object.
fn read_param(replica: &Replica, object: &ObjectId) -> KdmResult<Param> {
    let mut fields = Map::new();
    fields.insert("value".into(), replica.get(object, "value")?);
    let keyframes = replica.get(object, "keyframes")?;
    if !keyframes.is_null() {
        fields.insert("keyframes".into(), keyframes);
    }
    serde_json::from_value(Value::Object(fields)).map_err(kdm_err)
}

/// Reads an `Effect` object. A parameter that does not read as one is an error, never dropped.
pub(crate) fn read_effect(replica: &Replica, object: &ObjectId) -> KdmResult<EffectInstance> {
    let def = replica.get(object, "def")?.as_str().map(str::to_owned).ok_or_else(|| kdm_err("`def` is not a string"))?;
    let mut params = BTreeMap::new();
    for (name, value) in replica.map_entries(object, "params")? {
        let Some(child) = value.as_str().map(ObjectId::from_string) else { return Err(kdm_err(format!("parameter `{name}` names no object"))) };
        if !replica.exists(&child) {
            continue;
        }
        params.insert(name, read_param(replica, &child)?);
    }
    let masks = match replica.get(object, "masks")? {
        Value::Null => Vec::new(),
        value => serde_json::from_value(value).map_err(kdm_err)?,
    };
    let layer = match replica.get(object, "layer")? {
        Value::Null => None,
        value => Some(serde_json::from_value(value).map_err(kdm_err)?),
    };
    Ok(EffectInstance {
        effect: def,
        enabled: replica.get(object, "enabled")?.as_bool().unwrap_or(true),
        params,
        masks,
        post_fader: replica.get(object, "postFader")?.as_bool().unwrap_or(false),
        audio_mixing: replica.get(object, "audioMixing")?.as_bool().unwrap_or(false),
        layer,
    })
}

/// Reads the effects an object list names, skipping deleted ones.
pub(crate) fn read_effects(replica: &Replica, owner: &ObjectId, field: &str) -> KdmResult<Vec<EffectInstance>> {
    let mut effects = Vec::new();
    for object in replica.list(owner, field)? {
        if replica.exists(&object) {
            effects.push(read_effect(replica, &object)?);
        }
    }
    Ok(effects)
}

// --- markers -----------------------------------------------------------------------------------

fn marker_registers(marker: &Marker) -> KdmResult<Map<String, Value>> {
    Ok(object_of(json!({
        "id": marker.id.0,
        "start": tick::to_string(marker.start),
        "duration": tick::to_string(marker.duration),
        "name": marker.name,
        "kind": to_value(&marker.kind)?,
        "color": to_value(&marker.color)?,
    })))
}

fn create_marker(tx: &mut Tx<'_>, marker: &Marker) -> KdmResult<ObjectId> {
    let object = tx.create("Marker", marker_registers(marker)?)?;
    if !marker.comment.is_empty() {
        tx.text_insert(&object, "comment", 0, &marker.comment)?;
    }
    Ok(object)
}

/// Writes `markers` into the empty object list `owner.field`.
pub(crate) fn write_markers(tx: &mut Tx<'_>, owner: &ObjectId, field: &str, markers: &[Marker]) -> KdmResult<()> {
    for (index, marker) in markers.iter().enumerate() {
        let object = create_marker(tx, marker)?;
        tx.list_insert(owner, field, index, &object)?;
    }
    Ok(())
}

/// Writes what differs between `before` and `after` onto the marker list `owner.field`: markers
/// are matched by id, so an edit of one never touches another a peer edits at the same time.
pub(crate) fn diff_markers(tx: &mut Tx<'_>, owner: &ObjectId, field: &str, before: &[Marker], after: &[Marker]) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let keys: Vec<u64> = after.iter().map(|marker| marker.id.0).collect();
    let by_id: HashMap<u64, &Marker> = after.iter().map(|marker| (marker.id.0, marker)).collect();
    let (mut wrote, objects) = sync_list(
        tx,
        owner,
        field,
        &keys,
        stored_u64,
        |tx, key| match by_id.get(key) {
            Some(marker) => create_marker(tx, marker),
            None => Err(kdm_err("a marker to create has no value")),
        },
        plain_delete,
    )?;
    let was: HashMap<u64, &Marker> = before.iter().map(|marker| (marker.id.0, marker)).collect();
    for marker in after {
        let (Some(object), Some(old)) = (objects.get(&marker.id.0), was.get(&marker.id.0)) else { continue };
        if *old == marker {
            continue;
        }
        wrote |= set_changed(tx, object, &marker_registers(old)?, &marker_registers(marker)?)?;
        wrote |= write_text(tx, object, "comment", &old.comment, &marker.comment)?;
    }
    Ok(wrote)
}

/// Reads the markers an object list names, in list order. A marker without an id (made by a
/// batch, not yet numbered by the repair) reads with one from `fresh`.
pub(crate) fn read_markers(replica: &Replica, owner: &ObjectId, field: &str, fresh: &mut dyn FnMut(&ObjectId, Option<u64>) -> u64) -> KdmResult<Vec<Marker>> {
    let mut markers = Vec::new();
    for object in replica.list(owner, field)? {
        if !replica.exists(&object) {
            continue;
        }
        let id = fresh(&object, replica.get(&object, "id")?.as_u64());
        markers.push(Marker {
            id: kition_film_project::MarkerId(id),
            start: tick::from_value(&replica.get(&object, "start")?)?,
            duration: tick::from_value(&replica.get(&object, "duration")?)?,
            name: replica.get(&object, "name")?.as_str().unwrap_or_default().to_owned(),
            comment: replica.text(&object, "comment")?,
            kind: serde_json::from_value(replica.get(&object, "kind")?).map_err(kdm_err)?,
            color: serde_json::from_value(replica.get(&object, "color")?).map_err(kdm_err)?,
        });
    }
    Ok(markers)
}

// --- captions ----------------------------------------------------------------------------------
//
// A sequence's caption tracks are `CaptionTrack` objects in its `captionTracks` list; its captions
// are `Caption` objects in one list of the sequence, `captions`, each naming its track by the
// track's id (`track`). One list for every caption, not one per track: a premise names a caption
// by its id in it (`sequence.captions[id=7]`) and a track's captions by their track
// (`sequence.captions[track=3]`), and a caption another person adds or removes is told as that
// caption alone, so it never touches a premise on another caption. The list's order is not the
// captions' order: a track's captions read in time order (start, then id).

fn caption_track_registers(track: &CaptionTrack) -> KdmResult<Map<String, Value>> {
    let mut fields = object_of(json!({
        "id": track.id.0,
        "name": track.name,
        "format": to_value(&track.format)?,
        "language": track.language,
        "style": to_value(&track.style)?,
        "enabled": track.enabled,
        "locked": track.locked,
        "syncLock": track.sync_lock,
    }));
    if !track.vtt_blocks.is_empty() {
        fields.insert("vttBlocks".into(), to_value(&track.vtt_blocks)?);
    }
    Ok(fields)
}

fn caption_registers(track: u64, caption: &Caption) -> Map<String, Value> {
    let mut fields = object_of(json!({
        "id": caption.id.0,
        "track": track,
        "start": tick::to_string(caption.start),
        "duration": tick::to_string(caption.duration),
        "settings": caption.settings,
    }));
    if let Some(speaker) = &caption.speaker {
        fields.insert("speaker".into(), json!(speaker));
    }
    if let Some(cue) = &caption.cue_id {
        fields.insert("cueId".into(), json!(cue));
    }
    fields
}

fn create_caption(tx: &mut Tx<'_>, track: u64, caption: &Caption) -> KdmResult<ObjectId> {
    let object = tx.create("Caption", caption_registers(track, caption))?;
    if !caption.text.is_empty() {
        tx.text_insert(&object, "text", 0, &caption.text)?;
    }
    Ok(object)
}

/// Every caption of `tracks`, with its track's id, in track order then the track's order.
fn all_captions(tracks: &[CaptionTrack]) -> Vec<(u64, &Caption)> {
    tracks.iter().flat_map(|track| track.captions.iter().map(move |caption| (track.id.0, caption))).collect()
}

/// Writes `tracks` and their captions into the empty `captionTracks` and `captions` lists of a
/// sequence.
pub(crate) fn write_caption_tracks(tx: &mut Tx<'_>, sequence: &ObjectId, tracks: &[CaptionTrack]) -> KdmResult<()> {
    for (index, track) in tracks.iter().enumerate() {
        let object = tx.create("CaptionTrack", caption_track_registers(track)?)?;
        tx.list_insert(sequence, "captionTracks", index, &object)?;
    }
    for (index, (track, caption)) in all_captions(tracks).into_iter().enumerate() {
        let object = create_caption(tx, track, caption)?;
        tx.list_insert(sequence, "captions", index, &object)?;
    }
    Ok(())
}

/// Writes what differs between `before` and `after` onto a sequence's caption tracks and
/// captions: tracks matched by id, captions by id.
pub(crate) fn diff_caption_tracks(tx: &mut Tx<'_>, sequence: &ObjectId, before: &[CaptionTrack], after: &[CaptionTrack]) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let keys: Vec<u64> = after.iter().map(|track| track.id.0).collect();
    let by_id: HashMap<u64, &CaptionTrack> = after.iter().map(|track| (track.id.0, track)).collect();
    let (mut wrote, objects) = sync_list(
        tx,
        sequence,
        "captionTracks",
        &keys,
        stored_u64,
        |tx, key| match by_id.get(key) {
            Some(track) => Ok(tx.create("CaptionTrack", caption_track_registers(track)?)?),
            None => Err(kdm_err("a caption track to create has no value")),
        },
        plain_delete,
    )?;
    let was: HashMap<u64, &CaptionTrack> = before.iter().map(|track| (track.id.0, track)).collect();
    for track in after {
        let (Some(object), Some(old)) = (objects.get(&track.id.0), was.get(&track.id.0)) else { continue };
        wrote |= set_changed(tx, object, &caption_track_registers(old)?, &caption_track_registers(track)?)?;
    }
    wrote |= diff_captions(tx, sequence, &all_captions(before), &all_captions(after))?;
    Ok(wrote)
}

/// Writes what differs between the captions `before` and `after` (each with its track's id) onto
/// a sequence's `captions` list: a caption removed is deleted and taken out, one added is put at
/// the end, one changed has only what changed written (its text character by character).
fn diff_captions(tx: &mut Tx<'_>, sequence: &ObjectId, before: &[(u64, &Caption)], after: &[(u64, &Caption)]) -> KdmResult<bool> {
    let mut wrote = false;
    let was: HashMap<u64, (u64, &Caption)> = before.iter().map(|(track, caption)| (caption.id.0, (*track, *caption))).collect();
    let now: HashMap<u64, (u64, &Caption)> = after.iter().map(|(track, caption)| (caption.id.0, (*track, *caption))).collect();
    // The caption objects the list holds now: the first object of each id.
    let mut held: HashMap<u64, ObjectId> = HashMap::new();
    let mut gone: Vec<usize> = Vec::new();
    for (index, object) in tx.list_items(sequence, "captions")?.into_iter().enumerate() {
        if !tx.exists(&object) {
            continue;
        }
        let Some(id) = tx.get(&object, "id")?.as_u64() else { continue };
        if held.contains_key(&id) {
            continue;
        }
        if was.contains_key(&id) && !now.contains_key(&id) {
            tx.delete(&object)?;
            gone.push(index);
            wrote = true;
            continue;
        }
        held.insert(id, object);
    }
    for index in gone.into_iter().rev() {
        tx.list_remove(sequence, "captions", index)?;
    }
    for (track, caption) in after {
        match (held.get(&caption.id.0), was.get(&caption.id.0)) {
            (Some(object), Some((old_track, old))) => {
                if (*old_track, *old) == (*track, *caption) {
                    continue;
                }
                wrote |= set_changed(tx, object, &caption_registers(*old_track, old), &caption_registers(*track, caption))?;
                wrote |= write_text(tx, object, "text", &old.text, &caption.text)?;
            }
            (Some(object), None) => {
                // Held but not in `before` (defensive): written whole over what it holds.
                let object = object.clone();
                let text = tx.text_len(&object, "text")?;
                if text > 0 {
                    tx.text_delete(&object, "text", 0, text)?;
                }
                if !caption.text.is_empty() {
                    tx.text_insert(&object, "text", 0, &caption.text)?;
                }
                for (field, value) in caption_registers(*track, caption) {
                    tx.set(&object, &field, value)?;
                }
                wrote = true;
            }
            (None, _) => {
                let object = create_caption(tx, *track, caption)?;
                let at = tx.list_items(sequence, "captions")?.len();
                tx.list_insert(sequence, "captions", at, &object)?;
                wrote = true;
            }
        }
    }
    Ok(wrote)
}

/// Reads a sequence's caption tracks and their captions. A track's captions are in time order
/// (start, then id): the order the engine keeps them in, whatever order two replicas added them.
/// A caption whose track is gone (deleted by another person while this one added it) is not read.
pub(crate) fn read_caption_tracks(
    replica: &Replica,
    sequence: &ObjectId,
    fresh: &mut dyn FnMut(&ObjectId, Option<u64>) -> u64,
) -> KdmResult<Vec<CaptionTrack>> {
    let mut tracks = Vec::new();
    for object in replica.list(sequence, "captionTracks")? {
        if !replica.exists(&object) {
            continue;
        }
        let id = fresh(&object, replica.get(&object, "id")?.as_u64());
        let vtt_blocks = match replica.get(&object, "vttBlocks")? {
            Value::Null => Vec::new(),
            value => serde_json::from_value(value).map_err(kdm_err)?,
        };
        tracks.push(CaptionTrack {
            id: kition_film_project::TrackId(id),
            name: replica.get(&object, "name")?.as_str().unwrap_or_default().to_owned(),
            format: serde_json::from_value(replica.get(&object, "format")?).map_err(kdm_err)?,
            language: replica.get(&object, "language")?.as_str().unwrap_or_default().to_owned(),
            style: serde_json::from_value(replica.get(&object, "style")?).map_err(kdm_err)?,
            enabled: replica.get(&object, "enabled")?.as_bool().unwrap_or(true),
            locked: replica.get(&object, "locked")?.as_bool().unwrap_or(false),
            sync_lock: replica.get(&object, "syncLock")?.as_bool().unwrap_or(true),
            captions: Vec::new(),
            vtt_blocks,
        });
    }
    for object in replica.list(sequence, "captions")? {
        if !replica.exists(&object) {
            continue;
        }
        let Some(track) = replica.get(&object, "track")?.as_u64() else { continue };
        let Some(track) = tracks.iter_mut().find(|each| each.id.0 == track) else { continue };
        let id = fresh(&object, replica.get(&object, "id")?.as_u64());
        track.captions.push(Caption {
            id: kition_film_project::ClipId(id),
            start: tick::from_value(&replica.get(&object, "start")?)?,
            duration: tick::from_value(&replica.get(&object, "duration")?)?,
            text: replica.text(&object, "text")?,
            speaker: replica.get(&object, "speaker")?.as_str().map(str::to_owned),
            cue_id: replica.get(&object, "cueId")?.as_str().map(str::to_owned),
            settings: replica.get(&object, "settings")?.as_str().unwrap_or_default().to_owned(),
        });
    }
    for track in &mut tracks {
        track.captions.sort_by_key(|caption| (caption.start, caption.id.0));
    }
    Ok(tracks)
}

// --- a media item's transcript and source graphic ----------------------------------------------

fn transcript_registers(transcript: &Transcript) -> KdmResult<Map<String, Value>> {
    Ok(object_of(json!({
        "language": transcript.language,
        "source": transcript.source,
        "speakers": to_value(&transcript.speakers)?,
        "words": to_value(&transcript.words)?,
    })))
}

/// Writes what differs between an item's transcript `before` and `after` (either absent).
pub(crate) fn diff_transcript(tx: &mut Tx<'_>, item: &ObjectId, before: Option<&Transcript>, after: Option<&Transcript>) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let held = tx.get(item, "transcript")?.as_str().map(ObjectId::from_string).filter(|object| tx.exists(object));
    match (held, after) {
        (Some(object), Some(after)) => {
            let old = match before {
                Some(before) => transcript_registers(before)?,
                None => Map::new(),
            };
            set_changed(tx, &object, &old, &transcript_registers(after)?)
        }
        (None, Some(after)) => {
            let object = tx.create("Transcript", transcript_registers(after)?)?;
            tx.set(item, "transcript", json!(object.as_str()))?;
            Ok(true)
        }
        (Some(object), None) => {
            tx.set(item, "transcript", Value::Null)?;
            tx.delete(&object)?;
            Ok(true)
        }
        (None, None) => Ok(false),
    }
}

pub(crate) fn read_transcript(replica: &Replica, item: &ObjectId) -> KdmResult<Option<Transcript>> {
    let Some(object) = replica.get(item, "transcript")?.as_str().map(ObjectId::from_string) else { return Ok(None) };
    if !replica.exists(&object) {
        return Ok(None);
    }
    Ok(Some(Transcript {
        language: replica.get(&object, "language")?.as_str().unwrap_or_default().to_owned(),
        source: replica.get(&object, "source")?.as_str().unwrap_or_default().to_owned(),
        speakers: serde_json::from_value(replica.get(&object, "speakers")?).map_err(kdm_err)?,
        words: serde_json::from_value(replica.get(&object, "words")?).map_err(kdm_err)?,
    }))
}

fn source_graphic_registers(graphic: &SourceGraphic) -> KdmResult<Map<String, Value>> {
    let mut fields = Map::new();
    if let Some(meta) = &graphic.meta {
        fields.insert("meta".into(), to_value(meta)?);
    }
    Ok(fields)
}

/// Writes what differs between an item's source graphic `before` and `after` (either absent):
/// its layers are effects, diffed in place as a clip's are.
pub(crate) fn diff_source_graphic(tx: &mut Tx<'_>, item: &ObjectId, before: Option<&SourceGraphic>, after: Option<&SourceGraphic>) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let held = tx.get(item, "sourceGraphic")?.as_str().map(ObjectId::from_string).filter(|object| tx.exists(object));
    match (held, after) {
        (Some(object), Some(after)) => {
            let empty = SourceGraphic { layers: Vec::new(), meta: None };
            let before = before.unwrap_or(&empty);
            let mut wrote = set_changed(tx, &object, &source_graphic_registers(before)?, &source_graphic_registers(after)?)?;
            wrote |= crate::write::diff_effects(tx, &object, "layers", &before.layers, &after.layers)?;
            Ok(wrote)
        }
        (None, Some(after)) => {
            let object = tx.create("SourceGraphic", source_graphic_registers(after)?)?;
            for (index, layer) in after.layers.iter().enumerate() {
                let effect = create_effect(tx, layer)?;
                tx.list_insert(&object, "layers", index, &effect)?;
            }
            tx.set(item, "sourceGraphic", json!(object.as_str()))?;
            Ok(true)
        }
        (Some(object), None) => {
            tx.set(item, "sourceGraphic", Value::Null)?;
            for effect in tx.list_items(&object, "layers")? {
                if tx.exists(&effect) {
                    tx.delete(&effect)?;
                }
            }
            tx.delete(&object)?;
            Ok(true)
        }
        (None, None) => Ok(false),
    }
}

pub(crate) fn read_source_graphic(replica: &Replica, item: &ObjectId) -> KdmResult<Option<SourceGraphic>> {
    let Some(object) = replica.get(item, "sourceGraphic")?.as_str().map(ObjectId::from_string) else { return Ok(None) };
    if !replica.exists(&object) {
        return Ok(None);
    }
    let meta = match replica.get(&object, "meta")? {
        Value::Null => None,
        value => Some(serde_json::from_value(value).map_err(kdm_err)?),
    };
    Ok(Some(SourceGraphic { layers: read_effects(replica, &object, "layers")?, meta }))
}

// --- the project's LUTs and search bins --------------------------------------------------------

/// The MIME type a LUT's file text is stored under.
const LUT_MIME: &str = "text/plain";

/// The blob a LUT's file text is stored as.
pub(crate) fn lut_blob(lut: &ProjectLut) -> BlobRef {
    BlobRef { hash: sha256_hex(lut.text.as_bytes()), mime: LUT_MIME.to_owned(), size: lut.text.len() as u64 }
}

fn lut_registers(lut: &ProjectLut) -> KdmResult<Map<String, Value>> {
    let mut fields = object_of(json!({ "id": lut.id, "name": lut.name, "format": lut.format, "data": to_value(&lut_blob(lut))? }));
    if let Some(path) = &lut.source_path {
        fields.insert("sourcePath".into(), json!(path));
    }
    Ok(fields)
}

/// Writes what differs between the project's LUTs `before` and `after`, matched by id.
pub(crate) fn diff_luts(tx: &mut Tx<'_>, project: &ObjectId, before: &[ProjectLut], after: &[ProjectLut]) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let keys: Vec<String> = after.iter().map(|lut| lut.id.clone()).collect();
    let by_id: HashMap<&str, &ProjectLut> = after.iter().map(|lut| (lut.id.as_str(), lut)).collect();
    let (mut wrote, objects) = sync_list(
        tx,
        project,
        "luts",
        &keys,
        |tx, object| Ok(tx.get(object, "id")?.as_str().map(str::to_owned)),
        |tx, key| match by_id.get(key.as_str()) {
            Some(lut) => Ok(tx.create("Lut", lut_registers(lut)?)?),
            None => Err(kdm_err("a LUT to create has no value")),
        },
        plain_delete,
    )?;
    let was: HashMap<&str, &ProjectLut> = before.iter().map(|lut| (lut.id.as_str(), lut)).collect();
    for lut in after {
        let (Some(object), Some(old)) = (objects.get(&lut.id), was.get(lut.id.as_str())) else { continue };
        if *old != lut {
            wrote |= set_changed(tx, object, &lut_registers(old)?, &lut_registers(lut)?)?;
        }
    }
    Ok(wrote)
}

/// Reads the project's LUTs, each one's file text from `blobs`. A LUT whose text is not there is
/// an error: reading it as empty would save a broken LUT over the person's.
pub(crate) fn read_luts(replica: &Replica, project: &ObjectId, blobs: &dyn BlobSource) -> KdmResult<Vec<ProjectLut>> {
    let mut luts = Vec::new();
    for object in replica.list(project, "luts")? {
        if !replica.exists(&object) {
            continue;
        }
        let blob: BlobRef = serde_json::from_value(replica.get(&object, "data")?).map_err(kdm_err)?;
        let bytes = blobs.get(&blob.hash).ok_or_else(|| kdm_err(format!("the text of LUT `{}` is not available", blob.hash)))?;
        let text = std::str::from_utf8(&bytes).map_err(kdm_err)?;
        luts.push(ProjectLut {
            id: replica.get(&object, "id")?.as_str().unwrap_or_default().to_owned(),
            name: replica.get(&object, "name")?.as_str().unwrap_or_default().to_owned(),
            source_path: replica.get(&object, "sourcePath")?.as_str().map(str::to_owned),
            format: replica.get(&object, "format")?.as_str().unwrap_or_default().to_owned(),
            text: std::sync::Arc::from(text),
        });
    }
    Ok(luts)
}

/// The hashes of every LUT text a replica references.
pub(crate) fn lut_hashes(replica: &Replica) -> Vec<String> {
    replica
        .objects_of_type("Lut")
        .into_iter()
        .filter_map(|object| replica.get(&object, "data").ok())
        .filter_map(|value| serde_json::from_value::<BlobRef>(value).ok())
        .map(|blob| blob.hash)
        .collect()
}

fn search_bin_registers(bin: &SearchBin) -> KdmResult<Map<String, Value>> {
    Ok(object_of(json!({ "id": bin.id.0, "name": bin.name, "query": to_value(&bin.query)? })))
}

/// Writes what differs between the project's search bins `before` and `after`, matched by id.
pub(crate) fn diff_search_bins(tx: &mut Tx<'_>, project: &ObjectId, before: &[SearchBin], after: &[SearchBin]) -> KdmResult<bool> {
    if before == after {
        return Ok(false);
    }
    let keys: Vec<u64> = after.iter().map(|bin| bin.id.0).collect();
    let by_id: HashMap<u64, &SearchBin> = after.iter().map(|bin| (bin.id.0, bin)).collect();
    let (mut wrote, objects) = sync_list(
        tx,
        project,
        "searchBins",
        &keys,
        stored_u64,
        |tx, key| match by_id.get(key) {
            Some(bin) => Ok(tx.create("SearchBin", search_bin_registers(bin)?)?),
            None => Err(kdm_err("a search bin to create has no value")),
        },
        plain_delete,
    )?;
    let was: HashMap<u64, &SearchBin> = before.iter().map(|bin| (bin.id.0, bin)).collect();
    for bin in after {
        let (Some(object), Some(old)) = (objects.get(&bin.id.0), was.get(&bin.id.0)) else { continue };
        if *old != bin {
            wrote |= set_changed(tx, object, &search_bin_registers(old)?, &search_bin_registers(bin)?)?;
        }
    }
    Ok(wrote)
}

pub(crate) fn read_search_bins(replica: &Replica, project: &ObjectId, fresh: &mut dyn FnMut(&ObjectId, Option<u64>) -> u64) -> KdmResult<Vec<SearchBin>> {
    let mut bins = Vec::new();
    for object in replica.list(project, "searchBins")? {
        if !replica.exists(&object) {
            continue;
        }
        let id = fresh(&object, replica.get(&object, "id")?.as_u64());
        bins.push(SearchBin {
            id: kition_film_project::BinId(id),
            name: replica.get(&object, "name")?.as_str().unwrap_or_default().to_owned(),
            query: serde_json::from_value(replica.get(&object, "query")?).map_err(kdm_err)?,
        });
    }
    Ok(bins)
}
