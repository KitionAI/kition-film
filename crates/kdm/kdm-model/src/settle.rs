//! Settle file precision before batch receipts, and enforce the engine's hard parameter limits.
use kition_film_project::{EffectInstance, ParamKind, ParamValue};
use kition_kit::kdm::{KdmError, ObjectId, Tx};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{kdm_err, props, tick};

fn normalize<T: DeserializeOwned + Serialize>(tx: &mut Tx<'_>, object: &ObjectId, field: &str) -> Result<(), KdmError> {
    let before = tx.get(object, field)?;
    if before.is_null() {
        return Ok(());
    }
    let value: T = serde_json::from_value(before.clone()).map_err(kdm_err)?;
    let after = serde_json::to_value(value).map_err(kdm_err)?;
    if before != after {
        tx.set(object, field, after)?;
    }
    Ok(())
}

fn check_effect(effect: &EffectInstance) -> Result<(), KdmError> {
    let Some(definition) = effect.def() else { return Ok(()) };
    for (name, param) in &effect.params {
        let Some(ParamKind::Float { min, max, .. }) = definition.param(name).map(|param| &param.kind) else { continue };
        for value in std::iter::once(&param.value).chain(param.keyframes.iter().map(|key| &key.value)) {
            if let ParamValue::Float(value) = value
                && (!value.is_finite() || value < min || value > max)
            {
                return Err(kdm_err(format!("{}.{} must be between {min} and {max}", effect.effect, name)));
            }
        }
    }
    Ok(())
}

pub fn settle_batch(tx: &mut Tx<'_>) -> Result<(), KdmError> {
    for object in tx.objects_of_type("Clip") {
        if tx.get(&object, "speed")?.as_f64().is_some_and(|speed| !speed.is_finite() || speed <= 0.0) {
            return Err(kdm_err("clip speed must be finite and greater than zero"));
        }
        normalize::<props::ClipProps>(tx, &object, "props")?;
    }
    for object in tx.objects_of_type("Effect") {
        let value = tx.get(&object, "params")?;
        if !value.is_null() {
            let def = tx.get(&object, "def")?.as_str().unwrap_or_default().to_owned();
            check_effect(&props::effect_from_value(def, value)?)?;
            normalize::<props::EffectParams>(tx, &object, "params")?;
        }
    }
    for object in tx.objects_of_type("Sequence") {
        let mut end = 0i64;
        for field in ["videoTracks", "audioTracks"] {
            for track in tx.list_items(&object, field)? {
                for clip in tx.list_items(&track, "clips")? {
                    let start = tick::from_value(&tx.get(&clip, "start")?)?.0;
                    let duration = tick::from_value(&tx.get(&clip, "duration")?)?.0;
                    end = end.max(start.saturating_add(duration));
                }
            }
        }
        let captions = tx.get(&object, "captionTracks")?;
        if !captions.is_null() {
            for track in props::caption_tracks_from_json(captions)? {
                end = end.max(track.end().0);
            }
        }
        let duration = Value::String(end.to_string());
        if tx.get(&object, "duration")? != duration {
            tx.set(&object, "duration", duration)?;
        }
        let value = tx.get(&object, "mixer")?;
        if !value.is_null() {
            let mixer: props::SeqMixer = serde_json::from_value(value).map_err(kdm_err)?;
            for effect in &mixer.master_effects {
                check_effect(effect)?;
            }
            normalize::<props::SeqMixer>(tx, &object, "mixer")?;
        }
    }
    for object in tx.objects_of_type("Track") {
        normalize::<props::TrackProps>(tx, &object, "props")?;
    }
    for object in tx.objects_of_type("Item") {
        if tx.get(&object, "kind")? == Value::String("media".to_owned()) {
            normalize::<props::MediaProps>(tx, &object, "props")?;
        }
    }
    Ok(())
}
