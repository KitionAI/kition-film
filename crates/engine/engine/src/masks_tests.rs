use serde_json::json;

use crate::Session;
use kition_film_project::ClipId;
use kition_film_time::Tick;

fn demo() -> (Session, ClipId) {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    let q = s.active_sequence().unwrap();
    let it = q.video_tracks[0].items[0].clone();
    // middle of the first V1 clip (past its fade from black)
    s.set_playhead(it.start + Tick(it.duration.0 / 2));
    s.state.selection = vec![it.id];
    (s, it.id)
}

fn px(img: &kition_film_render::Image, fx: f32, fy: f32) -> [f32; 4] {
    img.get(((img.w as f32 * fx) as usize).min(img.w - 1), ((img.h as f32 * fy) as usize).min(img.h - 1))
}

fn dist(a: [f32; 4], b: [f32; 4]) -> f32 {
    (0..3).map(|k| (a[k] - b[k]).abs()).fold(0.0, f32::max)
}

#[test]
fn masked_effect_applies_only_inside_the_mask() {
    let (mut s, clip) = demo();
    let plain = s.render_program(0.25).unwrap();
    s.execute("effects.apply", json!({"effect": "invert"})).unwrap();
    let inverted = s.render_program(0.25).unwrap();
    // ellipse mask on Invert, in the left half of the frame
    let r = s.execute("masks.add", json!({"effect": "invert", "shape": "ellipse", "center": [480, 540], "size": [600, 600]})).unwrap();
    assert_eq!(r["name"], "Mask (1)");
    assert_eq!(r["mask"], 0);
    let masked = s.render_program(0.25).unwrap();
    // inside: inverted; outside: untouched
    assert!(dist(px(&masked, 0.25, 0.5), px(&inverted, 0.25, 0.5)) < 1e-4);
    assert!(dist(px(&masked, 0.8, 0.5), px(&plain, 0.8, 0.5)) < 1e-4);
    assert!(dist(px(&plain, 0.25, 0.5), px(&inverted, 0.25, 0.5)) > 0.05, "invert changes the picture");
    // inverted mask swaps the regions
    s.execute("masks.set", json!({"clip": clip.0, "effect": "invert", "mask": 0, "inverted": true})).unwrap();
    let inv = s.render_program(0.25).unwrap();
    assert!(dist(px(&inv, 0.25, 0.5), px(&plain, 0.25, 0.5)) < 1e-4);
    assert!(dist(px(&inv, 0.8, 0.5), px(&inverted, 0.8, 0.5)) < 1e-4);
    // undo ×2 → no mask
    s.undo();
    s.undo();
    let back = s.render_program(0.25).unwrap();
    assert_eq!(back.px, inverted.px);
    assert!(s.state.selected_mask.is_none(), "selection follows undo");
}

#[test]
fn opacity_mask_cuts_out_the_clip() {
    let (mut s, clip) = demo();
    // V1 only: an opacity mask leaves black outside
    s.execute("masks.add", json!({"clip": clip.0, "shape": "polygon", "center": [960, 540], "size": [960, 540]})).unwrap();
    s.execute("masks.set", json!({"feather": 0})).unwrap();
    let img = s.render_program(0.25).unwrap();
    assert!(px(&img, 0.5, 0.5)[3] > 0.99, "inside opaque");
    let corner = px(&img, 0.05, 0.05);
    assert!(corner[0] + corner[1] + corner[2] < 1e-4, "outside cut: {corner:?}");
    let list = s.execute("masks.list", json!({})).unwrap();
    let m = &list["masks"][0];
    assert_eq!(m["effectId"], "opacity");
    assert_eq!(m["path"]["vertices"].as_array().unwrap().len(), 4);
    assert_eq!(m["selected"], true);
}

#[test]
fn keyframed_mask_path_interpolates() {
    let (mut s, clip) = demo();
    let it = s.active_sequence().unwrap().find_item(clip).unwrap().1.clone();
    s.set_playhead(it.start);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "polygon", "center": [400, 400], "size": [200, 200]})).unwrap();
    s.execute("effects.toggleAnimation", json!({"clip": clip.0, "effect": "opacity", "mask": 0, "param": "path"})).unwrap();
    let rate = s.active_sequence().unwrap().settings.frame_rate;
    let t1 = it.start + rate.tick_of(10);
    s.set_playhead(t1);
    s.execute("masks.translate", json!({"delta": [100, -50]})).unwrap();
    // feather keyframes too, through the generic keyframe command
    s.execute("effects.toggleAnimation", json!({"clip": clip.0, "effect": "opacity", "mask": 0, "param": "feather"})).unwrap();
    s.execute("effects.setParam", json!({"clip": clip.0, "effect": "opacity", "mask": 0, "param": "feather", "value": 30.0})).unwrap();
    let mid = it.start + rate.tick_of(5);
    let l = s.execute("masks.list", json!({"time": mid.0})).unwrap();
    let v0 = &l["masks"][0]["path"]["vertices"][0]["p"];
    assert!((v0[0].as_f64().unwrap() - 350.0).abs() < 1e-6, "{v0}");
    assert!((v0[1].as_f64().unwrap() - 275.0).abs() < 1e-6, "{v0}");
    assert_eq!(l["masks"][0]["pathKeyframes"].as_array().unwrap().len(), 2);
    let end = s.execute("masks.list", json!({"time": t1.0})).unwrap();
    assert_eq!(end["masks"][0]["feather"], 30.0);
    // vertex edit at a keyframe replaces that keyframe; handles mirror unless broken
    s.execute("masks.moveVertex", json!({"vertex": 1, "handle": "out", "delta": [0, 40]})).unwrap();
    let e = s.execute("masks.list", json!({})).unwrap();
    let v1 = &e["masks"][0]["path"]["vertices"][1];
    assert_eq!(v1["out"], json!([0.0, 40.0]));
    assert_eq!(v1["in"], json!([-0.0, -40.0]));
    assert_eq!(e["masks"][0]["pathKeyframes"].as_array().unwrap().len(), 2);
    // add / remove vertices keep all keyframes interpolable
    s.execute("masks.addVertex", json!({"after": 0, "at": [500, 220]})).unwrap();
    let a = s.execute("masks.list", json!({"time": mid.0})).unwrap();
    assert_eq!(a["masks"][0]["path"]["vertices"].as_array().unwrap().len(), 5);
    s.execute("masks.removeVertex", json!({"vertex": 1})).unwrap();
    let a = s.execute("masks.list", json!({"time": mid.0})).unwrap();
    assert_eq!(a["masks"][0]["path"]["vertices"].as_array().unwrap().len(), 4);
}

#[test]
fn merged_drag_is_one_undo_step_and_project_round_trips() {
    let (mut s, _) = demo();
    s.execute("effects.apply", json!({"effect": "gaussian_blur"})).unwrap();
    s.execute("masks.add", json!({"effect": "gaussian_blur", "shape": "ellipse"})).unwrap();
    let n = s.history.undo.len();
    for _ in 0..5 {
        s.execute("masks.translate", json!({"delta": [3, 1], "merge": "drag-1"})).unwrap();
    }
    assert_eq!(s.history.undo.len(), n + 1);
    s.execute("masks.set", json!({"mode": "subtract", "trackMethod": "position", "expansion": -4})).unwrap();
    let bytes = kition_film_format::encode(&s.project, false);
    let back = kition_film_format::decode(&bytes).unwrap().project;
    assert_eq!(&back, &*s.project);
    let l = s.execute("masks.list", json!({})).unwrap();
    assert_eq!(l["masks"][0]["mode"], "Subtract");
    assert_eq!(l["masks"][0]["trackMethod"], "Position");
    assert!(s.execute("masks.add", json!({"effect": "motion"})).is_err(), "Motion has no masks");
}

#[test]
fn hostile_vertex_index_and_mask_name_counters_do_not_panic() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    let mut panics = Vec::new();
    let (mut s, clip) = demo();
    s.execute("masks.add", json!({"clip":clip.0,"shape":"polygon"})).unwrap();
    let result = catch_unwind(AssertUnwindSafe(|| {
        (crate::commands::find("masks.addVertex").unwrap().run)(&mut s, &json!({"clip":clip.0,"effect":"opacity","mask":0,"after":u64::MAX,"at":[500,220]}))
    }));
    if let Ok(result) = result {
        result.expect("out-of-range indices append, as ordinary large indices do");
        let list = s.execute("masks.list", json!({"clip":clip.0})).unwrap();
        assert_eq!(list["masks"][0]["path"]["vertices"].as_array().unwrap().len(), 5);
    } else {
        panics.push("untrusted insertion index");
    }
    let (mut s, clip) = demo();
    s.execute("masks.add", json!({"clip":clip.0,"shape":"polygon"})).unwrap();
    s.execute("masks.set", json!({"clip":clip.0,"effect":"opacity","mask":0,"name":format!("Mask ({})",usize::MAX)})).unwrap();
    let before = s.project.clone();
    let result = catch_unwind(AssertUnwindSafe(|| (crate::commands::find("masks.add").unwrap().run)(&mut s, &json!({"clip":clip.0,"shape":"polygon"}))));
    if let Ok(result) = result {
        assert!(result.is_err(), "an exhausted generated-name counter reports an error");
        assert_eq!(s.project, before, "a refused mask allocation preserves the project");
    } else {
        panics.push("exhausted generated-name counter");
    }
    assert!(panics.is_empty(), "these inputs must never panic: {panics:?}");
}

#[test]
fn an_empty_animated_mask_path_reports_an_error_without_panicking() {
    use kition_film_project::{MaskPath, ParamValue};
    use std::panic::{AssertUnwindSafe, catch_unwind};
    let (mut s, clip) = demo();
    s.execute("masks.add", json!({"clip":clip.0,"shape":"polygon"})).unwrap();
    s.execute("effects.toggleAnimation", json!({"clip":clip.0,"effect":"opacity","mask":0,"param":"path"})).unwrap();
    let seq = s.state.active_sequence.unwrap();
    let p = std::sync::Arc::make_mut(&mut s.project);
    let item = p.sequence_mut(seq).unwrap().find_item_mut(clip).unwrap().1;
    let mask = &mut item.effects.iter_mut().find(|e| e.effect == "opacity").unwrap().masks[0];
    let empty = ParamValue::Path(MaskPath { vertices: vec![], closed: false });
    mask.path.value = empty.clone();
    mask.path.keyframes[0].value = empty;
    let mut later = mask.path.keyframes[0].clone();
    later.time = Tick(later.time.0 + 1);
    mask.path.keyframes.push(later);
    let before = s.project.clone();
    let result = catch_unwind(AssertUnwindSafe(|| {
        (crate::commands::find("masks.addVertex").unwrap().run)(&mut s, &json!({"clip":clip.0,"effect":"opacity","mask":0,"after":0,"at":[500,220]}))
    }));
    assert!(result.is_ok(), "a malformed animated path must never underflow or index an empty vector");
    assert!(result.unwrap().is_err());
    assert_eq!(s.project, before, "malformed geometry cannot partially mutate the project");
}

#[test]
fn a_zero_duration_clip_cannot_panic_mask_commands() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    for command in ["masks.set", "masks.list"] {
        let (mut s, clip) = demo();
        s.execute("masks.add", json!({"clip":clip.0,"shape":"polygon"})).unwrap();
        let seq = s.state.active_sequence.unwrap();
        std::sync::Arc::make_mut(&mut s.project).sequence_mut(seq).unwrap().find_item_mut(clip).unwrap().1.duration = Tick::ZERO;
        let before = s.project.clone();
        let result = catch_unwind(AssertUnwindSafe(|| {
            (crate::commands::find(command).unwrap().run)(&mut s, &json!({"clip":clip.0,"effect":"opacity","mask":0,"name":"Mine"}))
        }));
        assert!(result.is_ok(), "{command} must not clamp with reversed bounds");
        assert!(result.unwrap().is_err(), "a clip without a frame reports an actionable error");
        assert_eq!(s.project, before);
    }
}

// ---------------------------------------------------------------- tracking

/// A 320×240 24 fps clip of a textured disc moving under a known similarity motion over a static
/// textured background.
struct Moving {
    info: kition_film_media::MediaInfo,
}

fn texture(u: f64, v: f64) -> f64 {
    let s = (u * 0.21).sin() * (v * 0.17).cos() + 0.5 * ((u + v) * 0.43).sin() + 0.35 * ((u * 0.9 - v * 0.6).sin() * (v * 0.75).cos());
    let (iu, iv) = ((u / 6.0).floor() as i64, (v / 6.0).floor() as i64);
    let mut x = (iu.wrapping_mul(73_856_093) ^ iv.wrapping_mul(19_349_663)) as u64;
    x ^= x >> 13;
    x = x.wrapping_mul(0x5bd1_e995);
    let h = (x >> 40) as f64 / (1u64 << 24) as f64;
    (0.5 + 0.22 * s + 0.12 * h).clamp(0.0, 1.0)
}

/// Ground-truth pose of the disc at frame `k`: translation, 1.5°/frame rotation, +1 %/frame scale.
fn truth(k: f64) -> kition_film_geom::Affine {
    kition_film_geom::Affine::motion(
        kition_film_geom::Vec2::new(120.0 + 3.0 * k, 110.0 + 1.2 * k),
        kition_film_geom::Vec2::new(1.0 + 0.01 * k, 1.0 + 0.01 * k),
        1.5 * k,
        kition_film_geom::Vec2::ZERO,
    )
}

impl kition_film_media::MediaSource for Moving {
    fn info(&self) -> &kition_film_media::MediaInfo {
        &self.info
    }
    fn video_frame(&self, req: kition_film_media::FrameRequest) -> kition_film_media::Result<std::sync::Arc<kition_film_frame::VideoFrame>> {
        let rate = kition_film_time::FrameRate::FPS_24;
        let k = rate.frame_at(req.time) as f64;
        let inv = truth(k).inverse().unwrap();
        let (w, h) = (320usize, 240usize);
        let mut px = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0;
                for (ox, oy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                    let p = kition_film_geom::Vec2::new(x as f64 + ox, y as f64 + oy);
                    let o = inv.apply(p);
                    acc += if o.length() < 70.0 { texture(o.x + 200.0, o.y + 300.0) } else { 0.25 + 0.1 * texture(p.x * 0.5 + 900.0, p.y * 0.5) };
                }
                let v = (acc / 4.0 * 255.0).round() as u8;
                px[(y * w + x) * 4..][..4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        Ok(std::sync::Arc::new(kition_film_frame::VideoFrame::rgba8(w as u32, h as u32, px)))
    }
    fn audio(&self, _start: i64, frames: usize, sample_rate: u32) -> kition_film_media::Result<kition_film_frame::AudioBuffer> {
        Ok(kition_film_frame::AudioBuffer::silence(sample_rate, 2, frames))
    }
}

fn tracking_session() -> (Session, ClipId) {
    use kition_film_media::MediaSource;
    let rate = kition_film_time::FrameRate::FPS_24;
    let g = kition_film_media::generators::GeneratorSource::new(
        kition_film_media::Generator::ColorMatte { color: [0.5, 0.5, 0.5, 1.0] },
        320,
        240,
        rate,
        rate.tick_of(48),
    );
    let info = g.info().clone();
    let mut p = kition_film_project::Project::new("track");
    let item = p.add_item(
        "moving",
        kition_film_project::Label::Iris,
        kition_film_project::ItemKind::Media(kition_film_project::MediaClip {
            media: kition_film_project::MediaRef::Generator(g.generator.clone()),
            info: info.clone(),
            interpret: Default::default(),
            mark_in: None,
            mark_out: None,
            markers: vec![],
            offline: false,
            proxy: None,
            identity: None,
        }),
        None,
    );
    let seq = p.new_sequence("s", kition_film_project::SequenceSettings { width: 320, height: 240, frame_rate: rate, ..Default::default() }, 1, 0, None);
    let ti = p
        .make_track_item(item, kition_film_project::TrackKind::Video, Tick::ZERO, kition_film_time::TimeRange::new(Tick::ZERO, rate.tick_of(48)), rate)
        .unwrap();
    let clip = ti.id;
    p.sequence_mut(seq).unwrap().video_tracks[0].items.push(ti);
    let mut s = Session { project: std::sync::Arc::new(p), ..Default::default() };
    s.state.active_sequence = Some(seq);
    s.state.selection = vec![clip];
    s.media.insert(item, std::sync::Arc::new(Moving { info }));
    (s, clip)
}

#[test]
fn pending_mask_tracking_does_not_edit_a_reopened_project() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let root = crate::media_test_util::tmp_dir("mask-project-context");
    let project = root.join("saved.kfilm");
    let (mut s, _) = tracking_session();
    let rate = kition_film_time::FrameRate::FPS_24;
    s.set_playhead(rate.tick_of(10));
    let center = truth(10.0).apply(kition_film_geom::Vec2::ZERO);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "ellipse", "center": [center.x, center.y], "size": [90, 90]})).unwrap();
    s.execute("file.saveAs", json!({"path": project.to_string_lossy()})).unwrap();
    let started = s.execute("masks.track", json!({"direction": "forward", "frames": 3})).unwrap();
    let job = s.jobs.iter().find(|job| json!(job.id) == started["job"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !job.progress.finished.load(Ordering::Relaxed) || job.result.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline, "mask tracking did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(job.result.lock().unwrap().as_ref().unwrap().is_ok());
    assert_eq!(s.mask_jobs[0].keys.lock().unwrap().len(), 4, "real tracker produced the start and three tracked paths");
    s.execute("file.open", json!({"path": project.to_string_lossy()})).unwrap();
    // The procedural fixture keeps NaN auto-position sentinels; their PartialEq is false even
    // against themselves. Encoding preserves those sentinels and compares all saved content.
    let before = kition_film_format::encode(&s.project, false);
    let history = s.history.undo.len();
    s.poll_persistence();
    assert!(kition_film_format::encode(&s.project, false) == before, "old paths cannot edit a newly opened project, even with identical IDs");
    assert_eq!(s.history.undo.len(), history);
    assert!(s.mask_jobs.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn n27_pending_tracking_cannot_write_into_a_mask_that_reused_its_index() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let (mut s, clip) = tracking_session();
    let center = truth(0.0).apply(kition_film_geom::Vec2::ZERO);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "ellipse", "center": [center.x, center.y], "size": [90, 90]})).unwrap();
    s.execute("masks.add", json!({"effect": "opacity", "shape": "rectangle", "center": [200, 100], "size": [30, 40]})).unwrap();
    let started = s.execute("masks.track", json!({"clip": clip.0, "effect": "opacity", "mask": 0, "direction": "forward", "frames": 3})).unwrap();
    let job = s.jobs.iter().find(|job| json!(job.id) == started["job"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !job.progress.finished.load(Ordering::Relaxed) || job.result.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline, "mask tracking did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(job.result.lock().unwrap().as_ref().unwrap().is_ok());
    assert_eq!(s.mask_jobs[0].keys.lock().unwrap().len(), 4);
    s.execute("masks.remove", json!({"clip": clip.0, "effect": "opacity", "mask": 0})).unwrap();
    let before = s.execute("masks.list", json!({})).unwrap();
    assert_eq!(before["masks"].as_array().unwrap().len(), 1);
    let history = s.history.undo.len();
    s.poll_persistence();
    assert_eq!(s.execute("masks.list", json!({})).unwrap(), before, "removing the tracked mask must not redirect its paths into the next mask");
    assert_eq!(s.history.undo.len(), history);
    assert!(s.mask_jobs.is_empty());
}

#[test]
fn tracking_follows_known_motion_forward_and_backward() {
    let (mut s, _) = tracking_session();
    let rate = kition_film_time::FrameRate::FPS_24;
    s.set_playhead(rate.tick_of(10));
    // a circle of radius 45 inside the disc at frame 10
    let c = truth(10.0).apply(kition_film_geom::Vec2::ZERO);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "ellipse", "center": [c.x, c.y], "size": [90, 90]})).unwrap();
    let path0 = s.execute("masks.list", json!({})).unwrap()["masks"][0]["path"].clone();
    let p0 = crate::masks::path_from_json(&path0).unwrap();
    // object coordinates of the mask vertices (they ride on the disc)
    let inv10 = truth(10.0).inverse().unwrap();
    let obj: Vec<kition_film_geom::Vec2> = p0.vertices.iter().map(|v| inv10.apply(v.p)).collect();
    let r = s.execute("masks.track", json!({"direction": "forward", "frames": 12, "wait": true})).unwrap();
    assert_eq!(r["frames"], 12, "{r}");
    assert!(s.mask_jobs.is_empty());
    let r = s.execute("masks.track", json!({"direction": "backward", "frames": 8, "wait": true, "method": "positionScaleRotation"})).unwrap();
    assert_eq!(r["frames"], 8);
    let l = s.execute("masks.list", json!({})).unwrap();
    let keys: Vec<i64> = l["masks"][0]["pathKeyframes"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    assert_eq!(keys.len(), 21, "frames 2..=22: {keys:?}");
    let mut worst = 0.0f64;
    for f in [2i64, 6, 10, 14, 18, 22] {
        let t = rate.tick_of(f);
        let m = s.execute("masks.list", json!({"time": t.0})).unwrap();
        let path = crate::masks::path_from_json(&m["masks"][0]["path"]).unwrap();
        for (v, o) in path.vertices.iter().zip(&obj) {
            worst = worst.max((v.p - truth(f as f64).apply(*o)).length());
        }
    }
    eprintln!("mask tracking: max vertex error {worst:.3} px over -8..+12 frames");
    assert!(worst < 1.5, "max vertex error {worst} px");
    // the two tracking runs are two undo steps
    let h = s.execute("history.list", json!({})).unwrap();
    let undo: Vec<&str> = h["undo"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(&undo[undo.len() - 2..], ["Track Mask", "Track Mask"], "{undo:?}");
}

#[test]
fn tracking_runs_in_the_background_and_can_be_cancelled() {
    let (mut s, _) = tracking_session();
    let c = truth(0.0).apply(kition_film_geom::Vec2::ZERO);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "ellipse", "center": [c.x, c.y], "size": [90, 90]})).unwrap();
    let r = s.execute("masks.track", json!({"direction": "forward"})).unwrap();
    let job = r["job"].as_u64().unwrap();
    assert_eq!(r["frames"], 47);
    assert!(s.execute("masks.track", json!({})).is_err(), "one job per mask");
    s.execute("jobs.cancel", json!({"job": job})).unwrap();
    let t0 = std::time::Instant::now();
    while !s.mask_jobs.is_empty() && t0.elapsed().as_secs() < 60 {
        s.poll_persistence();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(s.mask_jobs.is_empty());
    let jobs = s.execute("jobs.list", json!({})).unwrap();
    let j = jobs.as_array().unwrap().iter().find(|j| j["id"] == job).unwrap().clone();
    assert_eq!(j["finished"], true);
    let n = s.execute("masks.list", json!({})).unwrap()["masks"][0]["pathKeyframes"].as_array().unwrap().len();
    assert!(n < 48, "stopped early ({n} keyframes)");
    assert!(s.execute("masks.track", json!({"direction": "backward"})).is_err(), "nothing before the first frame");
}

/// A background tracking job's keyframes are written by `poll_persistence`, outside any
/// command: they are replicated there (one step for the whole job), so undoing the next,
/// unrelated command keeps them.
#[test]
fn background_tracking_survives_the_next_commands_undo() {
    let (mut s, _) = tracking_session();
    let c = truth(0.0).apply(kition_film_geom::Vec2::ZERO);
    s.execute("masks.add", json!({"effect": "opacity", "shape": "ellipse", "center": [c.x, c.y], "size": [90, 90]})).unwrap();
    assert!(s.kdm().is_some(), "replica-backed");
    s.execute("masks.track", json!({"direction": "forward", "frames": 12})).unwrap();
    let t0 = std::time::Instant::now();
    while !s.mask_jobs.is_empty() && t0.elapsed().as_secs() < 60 {
        s.poll_persistence();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let keys = |s: &mut Session| s.execute("masks.list", json!({})).unwrap()["masks"][0]["pathKeyframes"].as_array().map_or(0, Vec::len);
    let tracked = keys(&mut s);
    assert!(tracked > 1, "tracked ({tracked} keyframes)");
    s.execute("timeline.setTrack", json!({"track": "V1", "name": "Zed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(keys(&mut s), tracked, "the next command's undo keeps the tracked path");
    s.execute("edit.undo", json!({})).unwrap();
    assert!(keys(&mut s) < tracked, "its own undo takes it back");
}

/// `masks.add` takes frame pixels, so a mask lands where it is asked for even when
/// Motion moves and scales the clip; `masks.list` answers the same frame pixels.
#[test]
fn masks_are_placed_in_frame_pixels() {
    let (mut s, clip) = demo();
    let seq = s.active_sequence().unwrap().settings.clone();
    let (fw, fh) = (seq.width as f64, seq.height as f64);
    // the clip at half size, its centre a quarter of the way into the frame
    let (cx, cy) = (fw * 0.25, fh * 0.25);
    s.execute("effects.setParam", json!({"clip": clip.0, "effect": "motion", "param": "scale", "value": 50.0})).unwrap();
    s.execute("effects.setParam", json!({"clip": clip.0, "effect": "motion", "param": "position", "value": [cx, cy]})).unwrap();
    s.execute("masks.add", json!({"clip": clip.0, "shape": "polygon", "center": [cx, cy], "size": [fw * 0.1, fh * 0.1]})).unwrap();
    s.execute("masks.set", json!({"feather": 0})).unwrap();
    let img = s.render_program(0.25).unwrap();
    assert!(px(&img, 0.25, 0.25)[3] > 0.99, "the mask's centre shows the clip: {:?}", px(&img, 0.25, 0.25));
    let off = px(&img, 0.15, 0.15);
    assert!(off[0] + off[1] + off[2] < 1e-4, "outside the frame-pixel mask the clip is cut: {off:?}");
    let list = s.execute("masks.list", json!({})).unwrap();
    let vs = list["masks"][0]["path"]["vertices"].as_array().unwrap();
    let (mx, my) = vs.iter().fold((0.0, 0.0), |(x, y), v| (x + v["p"][0].as_f64().unwrap() / 4.0, y + v["p"][1].as_f64().unwrap() / 4.0));
    assert!((mx - cx).abs() < 1e-6 && (my - cy).abs() < 1e-6, "masks.list answers frame pixels: ({mx}, {my})");
    // moving a vertex and the mask is in frame pixels too
    s.execute("masks.translate", json!({"delta": [10, 20]})).unwrap();
    s.execute("masks.moveVertex", json!({"vertex": 0, "to": [cx - 100.0, cy - 100.0]})).unwrap();
    let list = s.execute("masks.list", json!({})).unwrap();
    let v0 = &list["masks"][0]["path"]["vertices"][0]["p"];
    assert!((v0[0].as_f64().unwrap() - (cx - 100.0)).abs() < 1e-6 && (v0[1].as_f64().unwrap() - (cy - 100.0)).abs() < 1e-6, "{v0}");
    let v2 = &list["masks"][0]["path"]["vertices"][2]["p"];
    assert!((v2[0].as_f64().unwrap() - (cx + fw * 0.05 + 10.0)).abs() < 1e-6 && (v2[1].as_f64().unwrap() - (cy + fh * 0.05 + 20.0)).abs() < 1e-6, "{v2}");
}
