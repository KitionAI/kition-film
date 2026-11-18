//! Effect masks: `masks.*` commands (add / remove / edit / select / list).
//!
//! A mask lives on an effect instance of a video clip (`effect`: index or id; Opacity masks cut
//! out the clip itself). Commands address it with `clip` (default: the selected mask's clip, else
//! the first selected video clip), `effect` (default: the selected mask's effect, else `opacity`)
//! and `mask` (index, default: the selected mask). Commands take and answer path geometry in frame
//! (sequence) pixels, where the mask is seen; it is stored in the clip's own pixels, mapped through
//! the clip's Motion at the edit's time, so a mask stays on its part of the picture as Motion moves
//! the clip. Edits at the playhead add/replace a keyframe when the parameter is animated, like every effect parameter;
//! keyframe commands (`effects.addKeyframe`, `effects.toggleAnimation`, …) take `"mask": n` to
//! address `path` / `feather` / `opacity` / `expansion`. Every edit is one undo step (`merge`: a
//! key folds a continuous drag into one step).

use kition_film_geom::{Affine, Vec2};
use kition_film_project::{ClipId, EffectInstance, Mask, MaskMode, MaskPath, MaskVertex, ParamValue, TrackKind, TrackMethod};
use kition_film_time::Tick;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

use crate::commands::{CommandSpec, bad, bool_p, clip_p, f64_p, has_seq, str_p, time_p, u64_p};
use crate::{EngineError, Result, Session};

type Run = fn(&mut Session, &Value) -> Result<Value>;

/// The mask selected for on-monitor editing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaskSel {
    pub clip: ClipId,
    pub effect: usize,
    pub mask: usize,
}

fn spec(id: &'static str, label: &'static str, params: &'static str, run: Run) -> CommandSpec {
    CommandSpec { id, label, menu: &[], shortcut: None, params, enabled: has_seq, run, journal: true }
}

pub(crate) fn commands() -> Vec<CommandSpec> {
    vec![
        spec(
            "masks.add",
            "Create Mask",
            r#"{"clip":id?,"effect":index|id?="opacity","shape":"ellipse"|"polygon"|"bezier","path":[[x,y]…]|{vertices}?,"center":[x,y]?,"size":[w,h]?}"#,
            add,
        ),
        spec("masks.remove", "Delete Mask", r#"{"clip":id?,"effect":index|id?,"mask":n?}"#, remove),
        spec(
            "masks.set",
            "Change Mask",
            r#"{"clip":id?,"effect":index|id?,"mask":n?,"name":str?,"inverted":bool?,"mode":"none|add|subtract|intersect|lighten|darken|difference"?,"trackMethod":"position|positionRotation|positionScaleRotation"?,"feather":px?,"opacity":pct?,"expansion":px?,"path":path?,"time":ticks?,"merge":key?}"#,
            set,
        ),
        spec(
            "masks.moveVertex",
            "Move Mask Vertex",
            r#"{"clip":id?,"effect":index|id?,"mask":n?,"vertex":n,"handle":"point"|"in"|"out"?,"to":[x,y]?|"delta":[dx,dy]?,"breakHandles":bool?,"merge":key?}"#,
            move_vertex,
        ),
        spec("masks.translate", "Move Mask", r#"{"clip":id?,"effect":index|id?,"mask":n?,"delta":[dx,dy],"merge":key?}"#, translate),
        spec("masks.addVertex", "Add Mask Vertex", r#"{"clip":id?,"effect":index|id?,"mask":n?,"after":n,"at":[x,y]}"#, add_vertex),
        spec("masks.removeVertex", "Delete Mask Vertex", r#"{"clip":id?,"effect":index|id?,"mask":n?,"vertex":n}"#, remove_vertex),
        spec(
            "masks.track",
            "Track Selected Mask",
            r#"{"clip":id?,"effect":index|id?,"mask":n?,"direction":"forward"|"backward"?,"frames":n?,"method":"position|positionRotation|positionScaleRotation"?,"wait":bool?}"#,
            track,
        ),
        spec("masks.toggleVertexSmooth", "Convert Mask Vertex", r#"{"clip":id?,"effect":index|id?,"mask":n?,"vertex":n}"#, toggle_smooth),
        CommandSpec {
            id: "masks.select",
            label: "Select Mask",
            menu: &[],
            shortcut: None,
            params: r#"{"clip":id,"effect":index|id,"mask":n}|{"none":true}"#,
            enabled: has_seq,
            run: select,
            journal: false,
        },
        CommandSpec {
            id: "masks.list",
            label: "List Masks",
            menu: &[],
            shortcut: None,
            params: r#"{"clip":id?,"time":ticks?}"#,
            enabled: has_seq,
            run: list,
            journal: false,
        },
    ]
}

/// A mask path from JSON: the serialized [`MaskPath`] object, an array of vertices
/// (`{"p":[x,y],"in":[x,y]?,"out":[x,y]?}`), or an array of `[x, y]` / `{"x","y"}` points.
pub fn path_from_json(v: &Value) -> Option<MaskPath> {
    if let Ok(p) = serde_json::from_value::<MaskPath>(v.clone()) {
        return Some(p);
    }
    let arr = v.as_array().or_else(|| v.get("vertices").and_then(Value::as_array))?;
    let closed = v.get("closed").and_then(Value::as_bool).unwrap_or(true);
    let mut vertices = Vec::new();
    for e in arr {
        if let Some(p) = e.get("p") {
            let t_in = e.get("in").or_else(|| e.get("t_in")).and_then(pt).unwrap_or_default();
            let t_out = e.get("out").or_else(|| e.get("t_out")).and_then(pt).unwrap_or_default();
            vertices.push(MaskVertex { p: pt(p)?, t_in, t_out });
        } else {
            vertices.push(MaskVertex::corner(pt(e)?));
        }
    }
    Some(MaskPath { vertices, closed })
}

fn pt(v: &Value) -> Option<Vec2> {
    if let Some(a) = v.as_array() {
        return Some(Vec2::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?));
    }
    Some(Vec2::new(v.get("x")?.as_f64()?, v.get("y")?.as_f64()?))
}

pub fn path_to_json(p: &MaskPath) -> Value {
    json!({
        "closed": p.closed,
        "vertices": p.vertices.iter().map(|v| json!({"p": [v.p.x, v.p.y], "in": [v.t_in.x, v.t_in.y], "out": [v.t_out.x, v.t_out.y]})).collect::<Vec<_>>(),
    })
}

/// Resolve the target clip (and its source size in pixels).
pub(crate) fn target_clip(s: &Session, p: &Value) -> Result<ClipId> {
    if let Some(c) = clip_p(p, "clip") {
        return Ok(c);
    }
    if let Some(sel) = s.state.selected_mask {
        return Ok(sel.clip);
    }
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    s.state
        .selection
        .iter()
        .copied()
        .find(|c| seq.find_item(*c).and_then(|(t, _)| seq.track(t)).is_some_and(|t| t.kind == TrackKind::Video))
        .ok_or_else(|| bad("masks", "select a video clip (or pass `clip`)"))
}

fn effect_index(effects: &[EffectInstance], v: Option<&Value>, sel: Option<MaskSel>, clip: ClipId) -> Option<usize> {
    match v {
        Some(v @ (Value::Number(_) | Value::String(_))) => crate::commands::effect_position(effects, v),
        _ => match sel {
            Some(s) if s.clip == clip && s.effect < effects.len() => Some(s.effect),
            _ => effects.iter().position(|e| e.effect == "opacity"),
        },
    }
}

/// The mask default-shape size resolver (one media parent, unlike rendering's
/// recursive source resolver). Keep its fallback visible to premise selection.
fn picture_size(s: &Session, clip: ClipId) -> Option<(u32, u32)> {
    let it = s.active_sequence().and_then(|q| q.find_item(clip)).map(|(_, i)| i);
    it.and_then(|i| s.project.item(i.item)).and_then(|pi| match &pi.kind {
        kition_film_project::ItemKind::Media(m) => m.info.video.as_ref().map(|v| (v.width, v.height)),
        kition_film_project::ItemKind::Sequence(q) => Some((q.settings.width, q.settings.height)),
        kition_film_project::ItemKind::AdjustmentLayer { width, height, .. } | kition_film_project::ItemKind::Graphic { width, height, .. } => {
            Some((*width, *height))
        }
        kition_film_project::ItemKind::Subclip { parent, .. } => {
            s.project.item(*parent).and_then(|pp| pp.as_media()).and_then(|m| m.info.video.as_ref()).map(|v| (v.width, v.height))
        }
    })
}

/// Clip pixel size of a track item's source.
fn source_size(s: &Session, clip: ClipId) -> (f64, f64) {
    let (w, h) = picture_size(s, clip).or_else(|| s.active_sequence().map(|q| (q.settings.width, q.settings.height))).unwrap_or((1920, 1080));
    (w as f64, h as f64)
}

/// Whether this mapping path consumes the active sequence's dimensions.
/// Motion's resolved position replaces its sequence-centred default; fitting
/// still consumes the frame size. `add` also has a default-shape fallback.
pub(crate) fn uses_sequence_dimensions(s: &Session, clip: ClipId, at: Tick, add: bool) -> bool {
    if add && picture_size(s, clip).is_none() {
        return true;
    }
    let Some((_, it)) = s.active_sequence().and_then(|q| q.find_item(clip)) else { return false };
    if kition_film_render::source_size(&s.project, it.item).is_none() {
        return false;
    }
    it.scale_to_frame
        || it.effect("motion").filter(|m| m.enabled).is_none_or(|m| m.param("position").is_none() || m.vec2_at("position", media_time(s, clip, at)).x.is_nan())
}

/// The map from a clip's own pixels (where mask paths are stored) to frame pixels at media time
/// `mt`: the clip's Motion (and Scale to Frame Size). Identity when the clip has no picture.
fn clip_to_frame(s: &Session, clip: ClipId, mt: Tick) -> Affine {
    let Some(seq) = s.active_sequence() else { return Affine::IDENTITY };
    let Some((_, it)) = seq.find_item(clip) else { return Affine::IDENTITY };
    match kition_film_render::source_size(&s.project, it.item) {
        Some(size) => kition_film_render::motion_matrix(seq, it, size, mt),
        None => Affine::IDENTITY,
    }
}

/// Frame pixels → clip pixels for a clip at media time `mt` (`None` when Motion collapses the clip
/// to nothing, so no frame point names a clip point).
pub(crate) fn frame_to_clip(s: &Session, clip: ClipId, mt: Tick) -> Option<Affine> {
    clip_to_frame(s, clip, mt).inverse()
}

/// Media time of a clip at timeline time `t` (clamped into the clip).
pub(crate) fn media_time(s: &Session, clip: ClipId, t: Tick) -> Tick {
    s.active_sequence().and_then(|q| q.find_item(clip)).map_or(t, |(_, it)| it.source_time_at(t.clamp(it.start, (it.end() - Tick(1)).max(it.start))))
}

/// The linear part of `m` (for offsets and bezier handles).
fn linear(m: &Affine) -> Affine {
    Affine { e: 0.0, f: 0.0, ..*m }
}

fn collapsed(label: &str) -> EngineError {
    bad(label, "the clip's Motion scales it to nothing, so no frame point lies on it")
}

/// Run `f` on the addressed mask as one undoable edit. `f` gets the mask, the clip (media) time
/// of the edit, and the map from frame pixels to clip pixels at that time.
fn edit_mask<R>(s: &mut Session, p: &Value, label: &str, f: impl FnOnce(&mut Mask, Tick, Affine) -> Result<R>) -> Result<R> {
    let clip = target_clip(s, p)?;
    let sel = s.state.selected_mask;
    let ph = time_p(s, p, "").unwrap_or(s.playhead());
    let to_clip = frame_to_clip(s, clip, media_time(s, clip, ph)).ok_or_else(|| collapsed(label))?;
    let eff = p.get("effect").cloned();
    let mask_i = u64_p(p, "mask").map(|m| m as usize).or(sel.filter(|x| x.clip == clip).map(|x| x.mask));
    let seq_id = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
    let body = move |pr: &mut kition_film_project::Project, _: &mut crate::EditorState| -> Result<R> {
        let q = pr.sequence_mut(seq_id).ok_or(EngineError::NoSequence)?;
        let (_, it) = q.find_item_mut(clip).ok_or(kition_film_edit::EditError::NoItem(clip))?;
        let end = it.end();
        if end <= it.start {
            return Err(bad(label, "the clip has no frame (non-positive duration)"));
        }
        let mt = it.source_time_at(ph.clamp(it.start, end - Tick(1)));
        let ei = effect_index(&it.effects, eff.as_ref(), sel, clip).ok_or_else(|| bad(label, "no such effect on clip"))?;
        let e = &mut it.effects[ei];
        let mi = mask_i.ok_or_else(|| bad(label, "need `mask`"))?;
        let m = e.masks.get_mut(mi).ok_or_else(|| bad(label, format!("no mask {mi}")))?;
        f(m, mt, to_clip)
    };
    match str_p(p, "merge") {
        Some(k) => {
            let key = format!("mask:{k}");
            s.edit_merged(label, &key, body)
        }
        None => s.edit(label, body),
    }
}

fn set_path_at(m: &mut Mask, t: Tick, path: MaskPath) {
    m.path.set_at(t, ParamValue::Path(path));
}

fn add(s: &mut Session, p: &Value) -> Result<Value> {
    let clip = target_clip(s, p)?;
    let (w, h) = source_size(s, clip);
    let ph = s.playhead();
    // the shape is drawn in frame pixels, then stored in the clip's pixels
    let to_frame = clip_to_frame(s, clip, media_time(s, clip, ph));
    let to_clip = to_frame.inverse().ok_or_else(|| collapsed("masks.add"))?;
    let shape = str_p(p, "shape").unwrap_or("ellipse").to_ascii_lowercase();
    let center = p.get("center").and_then(pt).unwrap_or_else(|| to_frame.apply(Vec2::new(w / 2.0, h / 2.0)));
    // default size: 40 % of the clip's shorter side, as the clip is seen in the frame
    let r = w.min(h) * 0.2 * to_frame.determinant().abs().sqrt();
    let size = p.get("size").and_then(pt).unwrap_or(Vec2::new(r * 2.0, r * 2.0));
    let path = match p.get("path") {
        Some(v) => path_from_json(v).ok_or_else(|| bad("masks.add", "bad `path`"))?,
        None => match shape.as_str() {
            "ellipse" => MaskPath::ellipse(center, size * 0.5),
            "polygon" | "rectangle" | "rect" | "4-point" => {
                MaskPath::rect(center.x - size.x / 2.0, center.y - size.y / 2.0, center.x + size.x / 2.0, center.y + size.y / 2.0)
            }
            _ => return Err(bad("masks.add", "a bezier mask needs `path` (pen points)")),
        },
    }
    .transformed(&to_clip);
    if path.len() < 3 && path.closed {
        return Err(bad("masks.add", "a mask needs at least 3 vertices"));
    }
    let eff = p.get("effect").cloned();
    let seq_id = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
    let (ei, mi, name) = s.edit("Create Mask", move |pr, st| {
        let q = pr.sequence_mut(seq_id).ok_or(EngineError::NoSequence)?;
        let (_, it) = q.find_item_mut(clip).ok_or(kition_film_edit::EditError::NoItem(clip))?;
        let ei = effect_index(&it.effects, eff.as_ref(), None, clip).ok_or_else(|| bad("masks.add", "no such effect on clip"))?;
        let e = &mut it.effects[ei];
        if e.def().is_none_or(|d| d.kind != kition_film_project::EffectKind::Video) {
            return Err(bad("masks.add", "masks apply to video effects"));
        }
        if e.effect == "motion" {
            return Err(bad("masks.add", "Motion has no masks"));
        }
        let n = e
            .masks
            .iter()
            .filter_map(|m| m.name.strip_prefix("Mask (")?.strip_suffix(')')?.parse::<usize>().ok())
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| bad("masks.add", "the generated mask-name counter is exhausted"))?;
        let name = format!("Mask ({n})");
        e.masks.push(Mask::new(name.clone(), path));
        let mi = e.masks.len() - 1;
        st.selected_mask = Some(MaskSel { clip, effect: ei, mask: mi });
        Ok((ei, mi, name))
    })?;
    Ok(json!({"clip": clip.0, "effect": ei, "mask": mi, "name": name}))
}

fn remove(s: &mut Session, p: &Value) -> Result<Value> {
    let clip = target_clip(s, p)?;
    let sel = s.state.selected_mask;
    let eff = p.get("effect").cloned();
    let mask_i = u64_p(p, "mask").map(|m| m as usize).or(sel.filter(|x| x.clip == clip).map(|x| x.mask)).ok_or_else(|| bad("masks.remove", "need `mask`"))?;
    let seq_id = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
    s.edit("Delete Mask", move |pr, st| {
        let q = pr.sequence_mut(seq_id).ok_or(EngineError::NoSequence)?;
        let (_, it) = q.find_item_mut(clip).ok_or(kition_film_edit::EditError::NoItem(clip))?;
        let ei = effect_index(&it.effects, eff.as_ref(), sel, clip).ok_or_else(|| bad("masks.remove", "no such effect on clip"))?;
        let e = &mut it.effects[ei];
        if mask_i >= e.masks.len() {
            return Err(bad("masks.remove", format!("no mask {mask_i}")));
        }
        e.masks.remove(mask_i);
        if st.selected_mask.is_some_and(|x| x.clip == clip && x.effect == ei) {
            st.selected_mask = None;
        }
        Ok(())
    })?;
    Ok(Value::Null)
}

fn set(s: &mut Session, p: &Value) -> Result<Value> {
    let path = match p.get("path") {
        Some(v) => Some(path_from_json(v).ok_or_else(|| bad("masks.set", "bad `path`"))?),
        None => None,
    };
    let mode = match str_p(p, "mode") {
        Some(m) => Some(MaskMode::from_name(m).ok_or_else(|| bad("masks.set", format!("unknown mode `{m}`")))?),
        None => None,
    };
    let method = match str_p(p, "trackMethod") {
        Some(m) => Some(TrackMethod::from_name(m).ok_or_else(|| bad("masks.set", format!("unknown tracking method `{m}`")))?),
        None => None,
    };
    let name = str_p(p, "name").map(str::to_string);
    let inverted = bool_p(p, "inverted");
    let nums: Vec<(&str, f64)> = ["feather", "opacity", "expansion"].into_iter().filter_map(|k| f64_p(p, k).map(|v| (k, v))).collect();
    edit_mask(s, p, "Change Mask", move |m, t, to_clip| {
        if let Some(n) = name {
            m.name = n;
        }
        if let Some(i) = inverted {
            m.inverted = i;
        }
        if let Some(md) = mode {
            m.mode = md;
        }
        if let Some(me) = method {
            m.track_method = me;
        }
        for (k, v) in nums {
            let v = match k {
                "feather" => v.max(0.0),
                "opacity" => v.clamp(0.0, 100.0),
                _ => v,
            };
            if let Some(prm) = m.param_mut(k) {
                prm.set_at(t, ParamValue::Float(v));
            }
        }
        if let Some(path) = path {
            set_path_at(m, t, path.transformed(&to_clip));
        }
        Ok(())
    })?;
    Ok(Value::Null)
}

fn move_vertex(s: &mut Session, p: &Value) -> Result<Value> {
    let vi = u64_p(p, "vertex").ok_or_else(|| bad("masks.moveVertex", "need `vertex`"))? as usize;
    let handle = str_p(p, "handle").unwrap_or("point").to_string();
    let to = p.get("to").and_then(pt);
    let delta = p.get("delta").and_then(pt);
    let broken = bool_p(p, "breakHandles").unwrap_or(false);
    if to.is_none() && delta.is_none() {
        return Err(bad("masks.moveVertex", "need `to` or `delta`"));
    }
    edit_mask(s, p, "Move Mask Vertex", move |m, t, to_clip| {
        // `to` is a frame point and `delta` a frame offset: both in the clip's pixels here
        let to = to.map(|q| to_clip.apply(q));
        let delta = delta.map(|d| linear(&to_clip).apply(d));
        let mut path = m.path_at(t);
        let v = path.vertices.get_mut(vi).ok_or_else(|| bad("masks.moveVertex", format!("no vertex {vi}")))?;
        match handle.as_str() {
            "in" | "out" => {
                let cur = if handle == "in" { v.p + v.t_in } else { v.p + v.t_out };
                let target = to.unwrap_or_else(|| cur + delta.unwrap_or_default());
                let tan = target - v.p;
                if handle == "in" {
                    v.t_in = tan;
                    if !broken {
                        v.t_out = tan * -1.0;
                    }
                } else {
                    v.t_out = tan;
                    if !broken {
                        v.t_in = tan * -1.0;
                    }
                }
            }
            _ => {
                v.p = to.unwrap_or_else(|| v.p + delta.unwrap_or_default());
            }
        }
        set_path_at(m, t, path);
        Ok(())
    })?;
    Ok(Value::Null)
}

fn translate(s: &mut Session, p: &Value) -> Result<Value> {
    let d = p.get("delta").and_then(pt).ok_or_else(|| bad("masks.translate", "need `delta`"))?;
    edit_mask(s, p, "Move Mask", move |m, t, to_clip| {
        let d = linear(&to_clip).apply(d);
        let path = m.path_at(t).transformed(&Affine::translate(d.x, d.y));
        set_path_at(m, t, path);
        Ok(())
    })?;
    Ok(Value::Null)
}

fn add_vertex(s: &mut Session, p: &Value) -> Result<Value> {
    let after = u64_p(p, "after").ok_or_else(|| bad("masks.addVertex", "need `after`"))? as usize;
    let at = p.get("at").and_then(pt).ok_or_else(|| bad("masks.addVertex", "need `at`"))?;
    edit_mask(s, p, "Add Mask Vertex", move |m, t, to_clip| {
        let at = to_clip.apply(at);
        if m.path.is_animated() && m.path.keyframes.len() > 1 {
            // keep every keyframe interpolable: insert the vertex into all of them
            for k in &mut m.path.keyframes {
                if let ParamValue::Path(path) = &mut k.value {
                    let len = path.vertices.len();
                    if len == 0 {
                        return Err(bad("masks.addVertex", "an animated mask keyframe has no vertices"));
                    }
                    let i = after.saturating_add(1).min(len);
                    let a = path.vertices[after.min(len - 1)].p;
                    let b = path.vertices[i % len].p;
                    path.vertices.insert(i, MaskVertex::corner(a.lerp(b, 0.5)));
                }
            }
        }
        let mut path = m.path_at(t);
        let i = after.saturating_add(1).min(path.vertices.len());
        if m.path.keyframes.len() > 1 {
            let vertex = path.vertices.get_mut(i).ok_or_else(|| bad("masks.addVertex", "the animated mask has no path at this time"))?;
            *vertex = MaskVertex::corner(at);
        } else {
            path.vertices.insert(i, MaskVertex::corner(at));
        }
        set_path_at(m, t, path);
        Ok(())
    })?;
    Ok(Value::Null)
}

fn remove_vertex(s: &mut Session, p: &Value) -> Result<Value> {
    let vi = u64_p(p, "vertex").ok_or_else(|| bad("masks.removeVertex", "need `vertex`"))? as usize;
    edit_mask(s, p, "Delete Mask Vertex", move |m, t, _| {
        if m.path_at(t).len() <= 3 {
            return Err(bad("masks.removeVertex", "a mask keeps at least 3 vertices"));
        }
        let drop = |path: &mut MaskPath| {
            if vi < path.vertices.len() {
                path.vertices.remove(vi);
            }
        };
        drop_all(m, t, drop);
        Ok(())
    })?;
    Ok(Value::Null)
}

/// Apply a topology change to the path value and every path keyframe.
fn drop_all(m: &mut Mask, _t: Tick, f: impl Fn(&mut MaskPath)) {
    if let ParamValue::Path(p) = &mut m.path.value {
        f(p);
    }
    for k in &mut m.path.keyframes {
        if let ParamValue::Path(p) = &mut k.value {
            f(p);
        }
    }
}

fn toggle_smooth(s: &mut Session, p: &Value) -> Result<Value> {
    let vi = u64_p(p, "vertex").ok_or_else(|| bad("masks.toggleVertexSmooth", "need `vertex`"))? as usize;
    edit_mask(s, p, "Convert Mask Vertex", move |m, t, _| {
        let mut path = m.path_at(t);
        let n = path.vertices.len();
        if vi >= n {
            return Err(bad("masks.toggleVertexSmooth", format!("no vertex {vi}")));
        }
        let v = path.vertices[vi];
        if v.is_corner() {
            // smooth: tangent along the neighbours' direction, a third of the way to them
            let prev = path.vertices[(vi + n - 1) % n].p;
            let next = path.vertices[(vi + 1) % n].p;
            let dir = (next - prev) * (1.0 / 6.0);
            path.vertices[vi] = MaskVertex::smooth(v.p, dir);
        } else {
            path.vertices[vi] = MaskVertex::corner(v.p);
        }
        set_path_at(m, t, path);
        Ok(())
    })?;
    Ok(Value::Null)
}

fn select(s: &mut Session, p: &Value) -> Result<Value> {
    if bool_p(p, "none") == Some(true) || p.is_null() || p.as_object().is_some_and(|o| o.is_empty()) {
        s.state.selected_mask = None;
        return Ok(Value::Null);
    }
    let clip = target_clip(s, p)?;
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let (_, it) = seq.find_item(clip).ok_or_else(|| bad("masks.select", "no such clip"))?;
    let ei = effect_index(&it.effects, p.get("effect"), None, clip).ok_or_else(|| bad("masks.select", "no such effect on clip"))?;
    let mi = u64_p(p, "mask").unwrap_or(0) as usize;
    if mi >= it.effects[ei].masks.len() {
        return Err(bad("masks.select", format!("no mask {mi}")));
    }
    s.state.selected_mask = Some(MaskSel { clip, effect: ei, mask: mi });
    Ok(Value::Null)
}

/// Masks of a clip (or every clip with masks) evaluated at the playhead.
fn list(s: &mut Session, p: &Value) -> Result<Value> {
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let ph = time_p(s, p, "").unwrap_or(s.playhead());
    let only = clip_p(p, "clip");
    let mut out = Vec::new();
    for tr in &seq.video_tracks {
        for it in &tr.items {
            if only.is_some_and(|c| c != it.id) {
                continue;
            }
            let end = it.end();
            if end <= it.start {
                return Err(bad("masks.list", format!("clip {} has no frame (non-positive duration)", it.id.0)));
            }
            let mt = it.source_time_at(ph.clamp(it.start, end - Tick(1)));
            let to_frame = match kition_film_render::source_size(&s.project, it.item) {
                Some(size) => kition_film_render::motion_matrix(seq, it, size, mt),
                None => Affine::IDENTITY,
            };
            for (ei, e) in it.effects.iter().enumerate() {
                for (mi, m) in e.masks.iter().enumerate() {
                    out.push(json!({
                        "clip": it.id.0,
                        "effect": ei,
                        "effectId": e.effect,
                        "mask": mi,
                        "name": m.name,
                        "mode": m.mode.label(),
                        "inverted": m.inverted,
                        "trackMethod": m.track_method.label(),
                        "feather": m.feather.f64_at(mt),
                        "opacity": m.opacity.f64_at(mt),
                        "expansion": m.expansion.f64_at(mt),
                        "path": path_to_json(&m.path_at(mt).transformed(&to_frame)),
                        "pathKeyframes": m.path.keyframes.iter().map(|k| k.time.0).collect::<Vec<_>>(),
                        "selected": s.state.selected_mask == Some(MaskSel { clip: it.id, effect: ei, mask: mi }),
                    }));
                }
            }
        }
    }
    Ok(json!({"masks": out}))
}

/// The parameter a keyframe / setParam command addresses: a mask parameter when `mask` is given.
pub(crate) fn target_param<'a>(e: &'a mut EffectInstance, p: &Value, pid: &str) -> Option<&'a mut kition_film_project::Param> {
    match u64_p(p, "mask") {
        Some(mi) => e.masks.get_mut(mi as usize)?.param_mut(pid),
        None => e.params.get_mut(pid),
    }
}

// ---------------------------------------------------------------- tracking

/// A running mask-tracking job: tracked paths are written as Mask Path keyframes as they arrive
/// (one undo step for the whole track), see [`poll`].
pub struct PendingTrack {
    pub job: u64,
    /// A replacement project may reuse the sequence, clip, effect and mask indices.
    epoch: u64,
    input: crate::analysis_input::AnalysisInput,
    effect_id: String,
    effect_count: usize,
    mask_count: usize,
    expected_mask: Mask,
    pub target: MaskSel,
    /// Sequence the clip lives in.
    pub seq: kition_film_project::ItemId,
    /// (media time, path) in tracking order.
    pub keys: Arc<Mutex<Vec<(Tick, MaskPath)>>>,
    applied: usize,
}

/// Longest side of the frames the tracker works on (speed; the result is in clip pixels).
const TRACK_MAX_WIDTH: f64 = 960.0;

fn track(s: &mut Session, p: &Value) -> Result<Value> {
    let clip = target_clip(s, p)?;
    let sel = s.state.selected_mask;
    let seq_id = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let (track_id, it) = seq.find_item(clip).ok_or_else(|| bad("masks.track", "no such clip"))?;
    let it = it.clone();
    let ei = effect_index(&it.effects, p.get("effect"), sel, clip).ok_or_else(|| bad("masks.track", "no such effect on clip"))?;
    let mi = u64_p(p, "mask")
        .map(|m| m as usize)
        .or(sel.filter(|x| x.clip == clip && x.effect == ei).map(|x| x.mask))
        .ok_or_else(|| bad("masks.track", "need `mask`"))?;
    let mask = it.effects[ei].masks.get(mi).cloned().ok_or_else(|| bad("masks.track", format!("no mask {mi}")))?;
    if s.mask_jobs.iter().any(|j| j.target.clip == clip && j.target.effect == ei && j.target.mask == mi) {
        return Err(bad("masks.track", "this mask is already being tracked"));
    }
    let method = match str_p(p, "method") {
        Some(m) => TrackMethod::from_name(m).ok_or_else(|| bad("masks.track", format!("unknown method `{m}`")))?,
        None => mask.track_method,
    };
    let backward = match str_p(p, "direction").unwrap_or("forward") {
        "forward" => false,
        "backward" => true,
        d => return Err(bad("masks.track", format!("direction `{d}`: forward or backward"))),
    };
    let rate = s.project.item(it.item).map(|i| i.frame_rate()).unwrap_or(seq.settings.frame_rate);
    let fd = rate.frame_duration();
    let ph = time_p(s, p, "").unwrap_or(s.playhead());
    let mt0 = it.source_time_at(ph.clamp(it.start, it.end() - Tick(1)));
    let (a, b) = (it.source_time_at(it.start), it.source_time_at(it.end() - Tick(1)));
    let (lo, hi) = (a.min(b), a.max(b));
    let room = if backward { (mt0 - lo).0 / fd.0.max(1) } else { (hi - mt0).0 / fd.0.max(1) };
    let steps = match u64_p(p, "frames") {
        Some(n) => (n as i64).min(room),
        None => room,
    }
    .max(0) as usize;
    if steps == 0 {
        return Err(bad("masks.track", if backward { "already at the clip's first frame" } else { "already at the clip's last frame" }));
    }
    let src = s.source(it.item).ok_or_else(|| EngineError::Other("the clip has no media to track".into()))?;
    let input = crate::analysis_input::AnalysisInput::new(&s.project, seq, track_id, &it, &src);
    let size = kition_film_render::source_size(&s.project, it.item).ok_or_else(|| bad("masks.track", "the clip has no picture"))?;
    let scale = (TRACK_MAX_WIDTH / size.0.max(1) as f64).min(1.0) as f32;
    let id = s.jobs.iter().map(|j| j.id).max().unwrap_or(0) + 1;
    let label = format!("Track {} ({})", mask.name, if backward { "backward" } else { "forward" });
    let job = crate::Job { id, label: label.clone(), progress: Default::default(), result: Default::default() };
    job.progress.total.store(steps as u64, std::sync::atomic::Ordering::Relaxed);
    let keys: Arc<Mutex<Vec<(Tick, MaskPath)>>> = Arc::default();
    let (prog, res, out) = (job.progress.clone(), job.result.clone(), keys.clone());
    let start_path = mask.path_at(mt0);
    let run = move || {
        use std::sync::atomic::Ordering;
        let t0 = web_time::Instant::now();
        let gray = |t: Tick| -> Option<(kition_film_render::track::Prepared, f64)> {
            let f = src.video_frame(kition_film_media::FrameRequest { time: t, scale }).ok()?;
            let g = kition_film_render::track::Gray::from_rgba8(f.width as usize, f.height as usize, &f.to_rgba8());
            Some((kition_film_render::track::Prepared::new(g), f.width as f64 / size.0.max(1) as f64))
        };
        let mut path = start_path;
        let mut err: Option<String> = None;
        let mut done = 0u64;
        match gray(mt0) {
            None => err = Some("can't decode the clip".into()),
            Some((mut prev, mut k_prev)) => {
                lock(&out).push((mt0, path.clone()));
                for step in 1..=steps {
                    if prog.cancel.load(Ordering::Relaxed) {
                        err = Some("stopped".into());
                        break;
                    }
                    let t = if backward { mt0 - Tick(fd.0 * step as i64) } else { mt0 + Tick(fd.0 * step as i64) };
                    let Some((next, k)) = gray(t) else {
                        err = Some(format!("can't decode frame {step}"));
                        break;
                    };
                    let region: Vec<Vec2> = path.flatten(0.5).into_iter().map(|q| q * k_prev).collect();
                    let Some(st) = kition_film_render::track::track_step(&prev, &next, &region, method) else {
                        err = Some(format!("lost track after {} frame(s): not enough detail inside the mask", step - 1));
                        break;
                    };
                    // frame pixels → clip pixels
                    let m = Affine::scale(1.0 / k, 1.0 / k).then_apply(&st.transform).then_apply(&Affine::scale(k_prev, k_prev));
                    path = path.transformed(&m);
                    lock(&out).push((t, path.clone()));
                    done += 1;
                    prog.done.store(done, Ordering::Relaxed);
                    *lock(&prog.status) = format!("Frame {step} of {steps} · {} features", st.inliers);
                    prev = next;
                    k_prev = k;
                }
            }
        }
        let secs = t0.elapsed().as_secs_f64();
        let r = match &err {
            // stopping keeps what was tracked
            Some(e) if e != "stopped" => Err(e.clone()),
            _ => Ok(kition_film_export::Report {
                path: String::new(),
                frames: done,
                seconds: secs,
                bytes: 0,
                render_fps: done as f64 / secs.max(1e-6),
                extra_files: Vec::new(),
            }),
        };
        *lock(&prog.status) = match &err {
            Some(e) => format!("{e} ({done} frame(s) tracked)"),
            None => format!("Tracked {done} frame(s) in {secs:.1}s"),
        };
        prog.finished.store(true, Ordering::Relaxed);
        *lock(&res) = Some(r);
    };
    let run = crate::export_tools::guard_job(job.progress.clone(), job.result.clone(), run);
    s.jobs.push(job);
    s.mask_jobs.push(PendingTrack {
        job: id,
        epoch: s.epoch,
        input,
        effect_id: it.effects[ei].effect.clone(),
        effect_count: it.effects.len(),
        mask_count: it.effects[ei].masks.len(),
        expected_mask: mask,
        target: MaskSel { clip, effect: ei, mask: mi },
        seq: seq_id,
        keys,
        applied: 0,
    });
    let wait = crate::commands::bool_p(p, "wait").unwrap_or(false);
    if wait || cfg!(target_arch = "wasm32") {
        run();
        poll(s);
    } else {
        std::thread::Builder::new().name("kition-film-mask-track".into()).spawn(run).map_err(|e| EngineError::Other(e.to_string()))?;
    }
    let st = s.jobs.iter().find(|j| j.id == id).map(crate::Job::to_json).unwrap_or(Value::Null);
    Ok(json!({"job": id, "frames": steps, "status": st}))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Write newly tracked paths as Mask Path keyframes (one merged undo step per tracking job) and
/// drop finished jobs. Called from [`Session::poll_persistence`] (once per UI frame) and after
/// synchronous runs.
pub fn poll(s: &mut Session) {
    use std::sync::atomic::Ordering;
    let mut i = 0;
    while i < s.mask_jobs.len() {
        let pending = &s.mask_jobs[i];
        let unchanged = pending.epoch == s.epoch
            && s.project.sequence(pending.seq).is_some_and(|sequence| {
                pending.input.matches(s, sequence)
                    && sequence.find_item(pending.target.clip).is_some_and(|(_, clip)| {
                        clip.effects.len() == pending.effect_count
                            && clip.effects.get(pending.target.effect).is_some_and(|effect| {
                                effect.effect == pending.effect_id
                                    && effect.masks.len() == pending.mask_count
                                    && effect.masks.get(pending.target.mask) == Some(&pending.expected_mask)
                            })
                    })
            });
        if !unchanged {
            if let Some(job) = s.jobs.iter().find(|j| j.id == s.mask_jobs[i].job) {
                job.progress.cancel.store(true, Ordering::Relaxed);
            }
            s.mask_jobs.remove(i);
            s.toast("Mask tracking cancelled: the tracked mask, clip or source media changed");
            continue;
        }
        let finished = s.jobs.iter().find(|j| j.id == s.mask_jobs[i].job).is_none_or(|j| j.progress.finished.load(Ordering::Relaxed));
        let new: Vec<(Tick, MaskPath)> = {
            let pj = &s.mask_jobs[i];
            lock(&pj.keys)[pj.applied..].to_vec()
        };
        if !new.is_empty() {
            let n_new = new.len();
            let pj = &s.mask_jobs[i];
            let (target, seq_id, key) = (pj.target, pj.seq, format!("mask-track-{}", pj.job));
            let r = s.edit_merged("Track Mask", &key, move |pr, _| {
                let q = pr.sequence_mut(seq_id).ok_or(EngineError::NoSequence)?;
                let (_, it) = q.find_item_mut(target.clip).ok_or(kition_film_edit::EditError::NoItem(target.clip))?;
                let m = it.effects.get_mut(target.effect).and_then(|e| e.masks.get_mut(target.mask)).ok_or_else(|| bad("masks.track", "the mask is gone"))?;
                for (t, path) in new {
                    m.path.put_keyframe(t, ParamValue::Path(path));
                }
                Ok(m.clone())
            });
            match r {
                Ok(mask) => {
                    s.mask_jobs[i].applied += n_new;
                    s.mask_jobs[i].expected_mask = mask;
                }
                Err(e) => {
                    s.error_toast("masks.track", e.to_string());
                    if let Some(j) = s.jobs.iter().find(|j| j.id == s.mask_jobs[i].job) {
                        j.progress.cancel.store(true, Ordering::Relaxed);
                    }
                    s.mask_jobs.remove(i);
                    continue;
                }
            }
        }
        let total = lock(&s.mask_jobs[i].keys).len();
        if finished && s.mask_jobs[i].applied >= total {
            s.mask_jobs.remove(i);
            continue;
        }
        i += 1;
    }
}
