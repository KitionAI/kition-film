use super::*;

#[test]
fn invalid_preview_scales_are_rejected_without_allocating() {
    let mut s = Session::default();
    s.execute("file.newSequence", serde_json::json!({"width":160,"height":90})).unwrap();
    for scale in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::MAX] {
        assert!(s.render_program(scale).is_none());
        assert!(s.render_program_working(scale).is_none());
    }
    assert!(s.try_render_program_at(f32::NAN, Tick::ZERO).unwrap_err().to_string().contains("finite"), "the reason is reported");
    assert_eq!(s.render_program(0.5).unwrap().w, 80);
}
use serde_json::json;

fn demo() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

fn clip_ids(s: &Session, track: usize) -> Vec<u64> {
    s.active_sequence().unwrap().video_tracks[track].items.iter().map(|i| i.id.0).collect()
}

#[test]
fn demo_project_is_valid_and_renders() {
    let s = demo();
    let q = s.active_sequence().unwrap();
    q.check().unwrap();
    assert_eq!(q.video_tracks[0].items.len(), 6);
    assert!(q.duration() > Tick::ZERO);
    let img = s.render_program(0.125).unwrap();
    assert_eq!((img.w, img.h), (240, 135));
    assert!(img.px.chunks(4).any(|p| p[3] > 0.9));
}

#[test]
fn add_edit_undo_redo() {
    let mut s = demo();
    let before = clip_ids(&s, 0).len();
    s.execute("playhead.set", json!({"seconds": 2.0})).unwrap();
    s.execute("sequence.addEditAllTracks", json!({})).unwrap();
    assert_eq!(clip_ids(&s, 0).len(), before + 1);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(clip_ids(&s, 0).len(), before);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(clip_ids(&s, 0).len(), before + 1);
    assert!(s.execute("edit.redo", json!({})).is_err(), "disabled when nothing to redo");
}

#[test]
fn source_insert_three_point() {
    let mut s = demo();
    let item = s
        .project
        .root
        .children
        .iter()
        .find_map(|c| {
            if let kition_film_project::BinEntry::Bin(b) = c {
                b.children.first().and_then(|e| if let kition_film_project::BinEntry::Item(i) = e { Some(*i) } else { None })
            } else {
                None
            }
        })
        .unwrap();
    s.execute("source.open", json!({"item": item.0})).unwrap();
    let r = s.sequence_rate();
    s.execute("project.setMarks", json!({"item": item.0, "in": r.tick_of(24).0, "out": r.tick_of(47).0})).unwrap();
    s.execute("playhead.set", json!({"frame": 0})).unwrap();
    let dur0 = s.active_sequence().unwrap().duration();
    s.execute("source.insert", json!({})).unwrap();
    let dur1 = s.active_sequence().unwrap().duration();
    assert_eq!(dur1 - dur0, r.tick_of(24), "one second inserted, sequence rippled");
    assert_eq!(s.playhead(), r.tick_of(24), "playhead moves to end of edit");
    s.active_sequence().unwrap().check().unwrap();
}

#[test]
fn trim_linked_and_ripple_delete() {
    let mut s = demo();
    let first = s.active_sequence().unwrap().video_tracks[0].items[0].clone();
    s.execute("timeline.trim", json!({"clip": first.id.0, "edge": "out", "mode": "regular", "deltaFrames": -12})).unwrap();
    let q = s.active_sequence().unwrap();
    assert_eq!(q.video_tracks[0].items[0].duration, first.duration - s.sequence_rate().tick_of(12));
    let a = q.audio_tracks[0].items.iter().find(|i| i.link == first.link).unwrap();
    assert_eq!(a.duration, q.video_tracks[0].items[0].duration, "linked audio trimmed too");
    s.execute("timeline.select", json!({"clips": [first.id.0]})).unwrap();
    assert_eq!(s.state.selection.len(), 2, "linked selection adds audio");
    assert!(s.execute("edit.rippleDelete", json!({})).is_err(), "music on sync-locked A2 blocks the ripple");
    s.execute("timeline.setTrack", json!({"track": "A2", "syncLock": false})).unwrap();
    s.execute("edit.rippleDelete", json!({})).unwrap();
    let q = s.active_sequence().unwrap();
    assert_eq!(q.video_tracks[0].items[0].start, s.sequence_rate().tick_of(12), "the trim gap remains");
}

/// The Timeline's Alt-click selects one side of a link: `timeline.select` with `linked: false`
/// leaves the partner out while Linked Selection is on.
#[test]
fn select_without_linked_partners() {
    let mut s = demo();
    let first = s.active_sequence().unwrap().video_tracks[0].items[0].clone();
    assert!(s.state.linked_selection && first.link.is_some());
    s.execute("timeline.select", json!({"clips": [first.id.0], "linked": false})).unwrap();
    assert_eq!(s.state.selection, vec![first.id], "only the picture is selected");
    s.execute("timeline.select", json!({"clips": [first.id.0], "linked": true})).unwrap();
    assert_eq!(s.state.selection.len(), 2, "linked: true keeps the partners");
}

#[test]
fn slide_moves_linked_audio_with_the_video() {
    let mut s = demo();
    let v = s.active_sequence().unwrap().video_tracks[0].items[1].clone();
    s.execute("timeline.slide", json!({"clip": v.id.0, "deltaFrames": 5})).unwrap();
    let q = s.active_sequence().unwrap();
    let (_, nv) = q.find_item(v.id).unwrap();
    let a = q.audio_tracks[0].items.iter().find(|i| i.link == v.link).unwrap();
    assert_eq!(nv.start, v.start + s.sequence_rate().tick_of(5));
    assert_eq!((a.start, a.source_in), (nv.start, nv.source_in), "linked audio slides too and stays in sync");
}

#[test]
fn sequence_parameters_are_bounded_and_failed_changes_are_atomic() {
    let mut s = demo();
    let before = (*s.project).clone();
    let history = s.history.undo.len();
    for command in ["file.newSequence", "sequence.settings"] {
        for params in [
            json!({"width":0}),
            json!({"height":0}),
            json!({"sampleRate":0}),
            json!({"width":4_294_967_360_u64}),
            json!({"height":u64::MAX}),
            json!({"sampleRate":u64::MAX}),
            json!({"width":-1}),
            json!({"width":1.5}),
            json!({"width":32768,"height":16384}),
            json!({"width":1920.25}),
            json!({"fps":1001}),
            json!({"sampleRate":384001}),
        ] {
            assert!(s.execute(command, params.clone()).is_err(), "{command} {params}");
            assert_eq!(*s.project, before);
            assert_eq!(s.history.undo.len(), history);
        }
    }
    for params in [json!({"video":u64::MAX}), json!({"audio":u64::MAX}), json!({"video":257}), json!({"audio":-1})] {
        assert!(s.execute("file.newSequence", params.clone()).is_err(), "{params}");
        assert_eq!(*s.project, before);
    }
    s.execute("file.newSequence", json!({"width":7680,"height":4320,"video":0,"audio":0})).unwrap();
    assert_eq!(s.active_sequence().unwrap().settings.width, 7680, "standard 8K remains supported");
    s.execute("file.newSequence", json!({"width":15360.0,"height":8640.0,"sampleRate":48000.0,"video":1.0,"audio":0})).unwrap();
    assert_eq!(s.active_sequence().unwrap().settings.width, 15360, "16K, and integer-valued floats, are accepted");
    s.execute("sequence.settings", json!({"width":16384,"height":8192})).unwrap();
    assert_eq!(s.active_sequence().unwrap().settings.height, 8192, "a 16384x8192 panorama is accepted");
}

/// The first video clip's Motion Position and Scale (static values).
fn first_motion(s: &Session) -> (u64, (f64, f64), f64) {
    let q = s.active_sequence().unwrap();
    let it = q.video_tracks.iter().flat_map(|t| &t.items).find(|i| i.effect("motion").is_some()).unwrap();
    let m = it.effect("motion").unwrap();
    let p = match m.param("position").unwrap().value {
        kition_film_project::ParamValue::Vec2(v) => (v.x, v.y),
        _ => panic!("position is a point"),
    };
    let sc = match m.param("scale").unwrap().value {
        kition_film_project::ParamValue::Float(v) => v,
        _ => panic!("scale is a number"),
    };
    (it.id.0, p, sc)
}

#[test]
fn sequence_settings_scales_motion_with_the_frame_size_in_one_undo_step() {
    let mut s = demo();
    let before = (*s.project).clone();
    let (id, p0, s0) = first_motion(&s);
    assert_eq!((s.active_sequence().unwrap().settings.width, s.active_sequence().unwrap().settings.height), (1920, 1080));
    let r = s.execute("sequence.settings", json!({"width":1280,"height":720,"scaleMotion":true})).unwrap();
    assert!(r["scaledClips"].as_u64().unwrap() >= 1, "{r}");
    let (id1, p1, s1) = first_motion(&s);
    assert_eq!(id1, id);
    assert!((p1.0 - p0.0 * 2.0 / 3.0).abs() < 1e-9 && (p1.1 - p0.1 * 2.0 / 3.0).abs() < 1e-9, "{p0:?} -> {p1:?}");
    assert!((s1 - s0 * 2.0 / 3.0).abs() < 1e-9, "{s0} -> {s1}");
    let after = (*s.project).clone();
    s.execute("edit.undo", json!({})).unwrap();
    // `next_id` can differ across the KDM replica round trip (see `ignoring_next_id`); everything
    // else must come back exactly.
    assert_eq!(ignoring_next_id((*s.project).clone(), &before), before, "size and Motion come back in one undo step");
    s.execute("edit.redo", json!({})).unwrap();
    // `next_id` can differ across the KDM replica round trip (see `ignoring_next_id`); everything
    // else must come back exactly.
    assert_eq!(ignoring_next_id((*s.project).clone(), &after), after);
    // without the option the frame size changes alone (the command's default, as before)
    let r = s.execute("sequence.settings", json!({"width":3840,"height":2160})).unwrap();
    assert_eq!(r["scaledClips"], json!(0));
    assert_eq!(first_motion(&s), (id, p1, s1));
    assert_eq!(s.active_sequence().unwrap().settings.width, 3840);
}

#[test]
fn sequence_settings_timecode_render_quality_and_colour() {
    let mut s = demo();
    s.execute("sequence.settings", json!({"fps":29.97,"dropFrame":true,"maxRenderQuality":true})).unwrap();
    let st = s.active_sequence().unwrap().settings.clone();
    assert_eq!(st.frame_rate, FrameRate::FPS_29_97);
    assert!(st.drop_frame && st.max_render_quality);
    s.execute("sequence.settings", json!({"dropFrame":false})).unwrap();
    assert!(!s.active_sequence().unwrap().settings.drop_frame);
    // drop-frame only exists for the NTSC rates; a refused change leaves everything as it was
    let before = (*s.project).clone();
    let history = s.history.undo.len();
    for params in [json!({"fps":25,"dropFrame":true}), json!({"workingSpace":"rec2020-log"}), json!({"fps":25,"dropFrame":true,"width":1280})] {
        assert!(s.execute("sequence.settings", params.clone()).is_err(), "{params}");
        assert_eq!(*s.project, before, "{params}");
        assert_eq!(s.history.undo.len(), history);
    }
    s.execute("sequence.settings", json!({"workingSpace":"rec2100-pq","wideGamut":true,"autoToneMap":true})).unwrap();
    let st = s.active_sequence().unwrap().settings.clone();
    assert_eq!(st.color.working, kition_film_color::WorkingSpace::Rec2100Pq);
    assert!(st.color.wide_gamut && st.color.auto_tone_map);
    assert_eq!(st.working_space, "Rec. 2100 PQ");
    // disabled without a sequence
    let mut empty = Session::default();
    assert!(empty.execute("sequence.settings", json!({"width":1280})).is_err());
}

#[test]
fn zero_fps_is_refused() {
    let mut s = demo();
    let rate = s.sequence_rate();
    assert!(s.execute("file.newSequence", json!({"name": "z", "fps": 0})).is_err());
    assert!(s.execute("sequence.settings", json!({"fps": 0})).is_err());
    assert!(s.execute("sequence.settings", json!({"fps": -24})).is_err());
    assert_eq!(s.sequence_rate(), rate, "the active sequence keeps its rate");
    s.execute("markers.markIn", json!({"time": 0})).unwrap();
}

#[test]
fn effects_and_keyframes() {
    let mut s = demo();
    let c = s.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    s.execute("effects.apply", json!({"clips": [c], "effect": "Gaussian Blur"})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "gaussian_blur", "param": "blurriness", "value": 25.0})).unwrap();
    let q = s.active_sequence().unwrap();
    let it = q.find_item(kition_film_project::ClipId(c)).unwrap().1;
    assert_eq!(it.effects[0].effect, "gaussian_blur", "standard effects render before intrinsics");
    assert_eq!(it.effects[0].params["blurriness"].value, kition_film_project::ParamValue::Float(25.0));
    s.execute("effects.toggleAnimation", json!({"clip": c, "effect": "motion", "param": "scale"})).unwrap();
    let it = s.active_sequence().unwrap().find_item(kition_film_project::ClipId(c)).unwrap().1.clone();
    assert!(it.effect("motion").unwrap().params["scale"].is_animated());
}

/// `effects.addKeyframe` is the keyframe diamond of Effect Controls and Properties: it adds a
/// keyframe at the playhead or removes the one there, and the value then follows the keyframes
/// that are left (Premiere's Add/Remove Keyframe), unlike the stopwatch, which drops them all.
#[test]
fn add_keyframe_toggles_the_keyframe_at_the_playhead() {
    let mut s = demo();
    let c = s.active_sequence().unwrap().video_tracks[0].items[0].id.0;
    let scale = |s: &Session| {
        let it = s.active_sequence().unwrap().find_item(kition_film_project::ClipId(c)).unwrap().1;
        let p = &it.effect("motion").unwrap().params["scale"];
        (p.keyframes.len(), p.f64_at(it.source_time_at(s.playhead())))
    };
    let key = json!({"clip": c, "effect": "motion", "param": "scale"});
    s.execute("playhead.set", json!({"seconds": 0.5})).unwrap();
    s.execute("effects.addKeyframe", key.clone()).unwrap();
    assert_eq!(scale(&s), (1, 100.0), "the first keyframe turns animation on");
    s.execute("playhead.set", json!({"seconds": 2.5})).unwrap();
    s.execute("effects.addKeyframe", key.clone()).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 50.0})).unwrap();
    assert_eq!(scale(&s), (2, 50.0));
    // on a keyframe: only that keyframe goes, and Scale is the other keyframe's 100 again
    s.execute("effects.addKeyframe", key.clone()).unwrap();
    assert_eq!(scale(&s), (1, 100.0));
    s.undo();
    assert_eq!(scale(&s), (2, 50.0));
    s.redo();
    assert_eq!(scale(&s), (1, 100.0));
    // parameters that name nothing are errors and change nothing
    for bad in [
        json!({}),
        json!({"clip": c}),
        json!({"clip": u64::MAX, "param": "scale"}),
        json!({"clip": c, "effect": "nope", "param": "scale"}),
        json!({"clip": c, "effect": u64::MAX, "param": "scale"}),
        json!({"clip": c, "effect": "motion", "param": "nope"}),
        json!({"clip": c, "effect": "motion", "param": "scale", "mask": 7}),
    ] {
        assert!(s.execute("effects.addKeyframe", bad.clone()).is_err(), "{bad}");
    }
    assert_eq!(scale(&s), (1, 100.0));
    // the stopwatch ends the animation and keeps the value at the playhead
    s.execute("effects.toggleAnimation", key).unwrap();
    assert_eq!(scale(&s), (0, 100.0));
}

#[test]
fn transitions_and_markers() {
    let mut s = demo();
    let q = s.active_sequence().unwrap();
    let cut = q.video_tracks[0].items[2].start;
    s.execute("playhead.set", json!({"time": cut.0})).unwrap();
    s.execute("sequence.applyVideoTransition", json!({"effect": "wipe"})).unwrap();
    let q = s.active_sequence().unwrap();
    assert!(q.video_tracks[0].transitions.iter().any(|t| t.effect.effect == "wipe"));
    let n = q.markers.len();
    s.execute("markers.add", json!({"name": "Test"})).unwrap();
    assert_eq!(s.active_sequence().unwrap().markers.len(), n + 1);
}

#[test]
fn every_video_transition_applies_via_command() {
    let mut s = demo();
    let cut = s.active_sequence().unwrap().video_tracks[0].items[2].start;
    s.execute("playhead.set", json!({"time": cut.0})).unwrap();
    let defs: Vec<_> = kition_film_project::effect_defs()
        .iter()
        .filter(|d| d.kind == kition_film_project::EffectKind::VideoTransition && d.category[0] != "Obsolete")
        .collect();
    assert_eq!(defs.len(), 84 + 21);
    for (i, d) in defs.iter().enumerate() {
        // alternate id and display-name lookups
        let name = if i % 2 == 0 { d.id } else { d.name };
        let r = s.execute("sequence.applyVideoTransition", json!({"effect": name})).unwrap_or_else(|e| panic!("{}: {e}", d.id));
        let q = s.active_sequence().unwrap();
        let tr = q.video_tracks[0].transitions.iter().find(|t| t.id.0 == r["transition"].as_u64().unwrap()).unwrap();
        assert_eq!(tr.effect.effect, d.id);
        // rendering the middle of the transition works through the engine
        let mid = tr.start + tr.duration.mul_ratio(1, 2);
        s.execute("playhead.set", json!({"time": mid.0})).unwrap();
        s.execute("edit.undo", json!({})).unwrap();
        assert!(s.active_sequence().unwrap().video_tracks[0].transitions.iter().all(|t| t.id.0 != r["transition"].as_u64().unwrap()));
        s.execute("playhead.set", json!({"time": cut.0})).unwrap();
    }
    // names shared with video effects resolve to the transition here
    let r = s.execute("sequence.applyVideoTransition", json!({"effect": "Mosaic"})).unwrap();
    let q = s.active_sequence().unwrap();
    assert!(q.video_tracks[0].transitions.iter().any(|t| t.id.0 == r["transition"].as_u64().unwrap() && t.effect.effect == "mosaic_transition"));
    assert!(s.execute("sequence.applyVideoTransition", json!({"effect": "Constant Power"})).is_err());
}

#[test]
fn transition_params_and_reverse_via_commands() {
    let mut s = demo();
    let cut = s.active_sequence().unwrap().video_tracks[0].items[2].start;
    s.execute("playhead.set", json!({"time": cut.0})).unwrap();
    let r = s
        .execute(
            "sequence.applyVideoTransition",
            json!({"effect": "Iris Round", "params": {"border_width": 12.0, "border_color": "#ff0000", "antialias": "High"}, "reverse": true}),
        )
        .unwrap();
    let id = r["transition"].as_u64().unwrap();
    let find = |s: &Session| s.active_sequence().unwrap().video_tracks[0].transitions.iter().find(|t| t.id.0 == id).cloned().unwrap();
    let tr = find(&s);
    assert!(tr.reverse);
    assert_eq!(tr.effect.params["border_width"].value, kition_film_project::ParamValue::Float(12.0));
    assert_eq!(tr.effect.params["antialias"].value, kition_film_project::ParamValue::Choice(3));
    s.execute("sequence.setTransition", json!({"transition": id, "params": {"center": [100.0, 50.0], "border_width": 9999.0}, "reverse": false})).unwrap();
    let tr = find(&s);
    assert!(!tr.reverse);
    assert_eq!(tr.effect.params["border_width"].value, kition_film_project::ParamValue::Float(200.0), "clamped to the range");
    assert!(s.execute("sequence.setTransition", json!({"transition": id, "params": {"nope": 1}})).is_err());
    assert!(s.execute("sequence.setTransition", json!({"transition": id, "params": {"antialias": "Ultra"}})).is_err());
    s.execute("edit.undo", json!({})).unwrap();
    assert!(find(&s).reverse, "setTransition is one undo step");
    s.execute("sequence.setTransition", json!({"transition": id, "reset": true})).unwrap();
    assert_eq!(find(&s).effect.params["border_width"].value, kition_film_project::ParamValue::Float(0.0));
    let seq = s.execute("sequence.inspect", json!({})).unwrap();
    let js = seq["video"][0]["transitions"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!(js["effect"], "iris_round");
    assert!(js["params"]["border_width"].is_object() || js["params"]["border_width"].is_number(), "{js}");
}

#[test]
fn effects_list_reports_transition_folders() {
    let s = demo();
    let mut s = s;
    let all = s.execute("effects.list", json!({"kind": "VideoTransition"})).unwrap();
    let all = all.as_array().unwrap();
    assert!(all.iter().all(|e| e["kind"] == "VideoTransition" && e["folder"].is_string()));
    let wipes = s.execute("effects.list", json!({"folder": "Video Transitions/Wipe", "detail": true})).unwrap();
    let wipes = wipes.as_array().unwrap();
    assert_eq!(wipes.len(), 9);
    let lw = wipes.iter().find(|e| e["id"] == "linear_wipe").unwrap();
    assert_eq!(lw["folder"], "Wipe");
    assert_eq!(lw["path"], "Video Transitions/Wipe");
    let aa = lw["paramInfo"].as_array().unwrap().iter().find(|p| p["id"] == "antialias").unwrap();
    assert_eq!(aa["type"], "choice");
    assert_eq!(aa["options"].as_array().unwrap().len(), 4);
    let legacy = s.execute("effects.list", json!({"folder": "Legacy/Video Transitions"})).unwrap();
    assert_eq!(legacy.as_array().unwrap().len(), 21);
    // the default transition accepts names shared with video effects
    s.execute("effects.setDefaultTransition", json!({"effect": "Mosaic"})).unwrap();
    assert_eq!(s.state.default_video_transition, "mosaic_transition");
}

#[test]
fn commands_are_unique_and_described() {
    let mut ids = std::collections::HashSet::new();
    for c in command_specs() {
        assert!(ids.insert(c.id), "duplicate {}", c.id);
    }
    assert!(command_specs().len() > 90, "{}", command_specs().len());
    let s = demo();
    let list = commands::inspect_project(&s);
    assert!(list["root"]["children"].as_array().unwrap().len() >= 4);
}

#[test]
fn save_and_open_roundtrip() {
    let dir = std::env::temp_dir().join(format!("fc-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("demo.kfilm").to_string_lossy().to_string();
    let mut s = demo();
    s.execute("file.saveAs", json!({"path": path})).unwrap();
    assert!(!s.is_dirty());
    let mut t = Session::default();
    t.execute("file.open", json!({"path": path})).unwrap();
    assert_eq!(*t.project, *s.project);
    // media re-created from generator refs
    assert!(t.render_program(0.1).is_some());
    std::fs::remove_dir_all(dir).ok();
}

/// Demo project with sync lock off on every track except V1/A1 (the A2 score spans every cut).
fn demo_unlocked() -> Session {
    let mut s = demo();
    for t in ["V2", "V3", "A2", "A3"] {
        let _ = s.execute("timeline.setTrack", json!({"track": t, "syncLock": false}));
    }
    s
}

fn v1(s: &Session) -> Vec<(u64, Tick, Tick)> {
    s.active_sequence().unwrap().video_tracks[0].items.iter().map(|i| (i.id.0, i.start, i.end())).collect()
}

#[test]
fn trim_mode_roll_ripple_and_toggle() {
    let mut s = demo_unlocked();
    let rate = s.sequence_rate();
    let clips = v1(&s);
    // park near the first V1 cut and pick it as a roll
    let cut = clips[0].2;
    s.execute("playhead.set", json!({"time": (cut + rate.tick_of(2)).0})).unwrap();
    let r = s.execute("trim.selectNearest", json!({"kind": "roll"})).unwrap();
    assert!(!r["editPoints"].as_array().unwrap().is_empty());
    let dur_before = s.active_sequence().unwrap().duration();
    s.execute("trim.forwardMany", json!({})).unwrap();
    let after = v1(&s);
    let left = after.iter().find(|c| c.0 == clips[0].0).unwrap();
    assert_eq!(left.2, cut + rate.tick_of(5), "roll moved the cut 5 frames later");
    assert_eq!(s.active_sequence().unwrap().duration(), dur_before, "roll keeps the duration");
    // toggle Roll -> Trim -> Ripple; ripple backward shortens the sequence
    s.execute("trim.toggleType", json!({})).unwrap();
    s.execute("trim.toggleType", json!({})).unwrap();
    assert_eq!(s.state.edit_points[0].kind, crate::trim::TrimKind::Ripple);
    let d0 = s.active_sequence().unwrap().duration();
    s.execute("trim.backward", json!({})).unwrap();
    assert!(s.active_sequence().unwrap().duration() <= d0, "ripple trim back must not lengthen");
    s.execute("trim.clear", json!({})).unwrap();
    assert!(s.execute("trim.forward", json!({})).is_err(), "disabled without edit points");
}

#[test]
fn ripple_trim_to_playhead_q_w() {
    let mut s = demo_unlocked();
    let rate = s.sequence_rate();
    let clips = v1(&s);
    let (id, start, end) = clips[1];
    let d0 = s.active_sequence().unwrap().duration();
    // W: ripple trim the end of the clip under the playhead to the playhead
    let ph = start + rate.tick_of(10);
    s.execute("playhead.set", json!({"time": ph.0})).unwrap();
    s.execute("trim.rippleNext", json!({})).unwrap();
    let c = v1(&s).into_iter().find(|c| c.0 == id).unwrap();
    assert_eq!(c.2, ph, "clip now ends at the playhead");
    assert_eq!(s.active_sequence().unwrap().duration(), d0 - (end - ph), "later material rippled left");
    // Q: ripple trim the start of the (new) clip under the playhead to the playhead
    let (_, start2, end2) = v1(&s)[2];
    let d1 = s.active_sequence().unwrap().duration();
    let ph2 = start2 + rate.tick_of(6);
    s.execute("playhead.set", json!({"time": ph2.0})).unwrap();
    s.execute("trim.ripplePrevious", json!({})).unwrap();
    let c2 = v1(&s).into_iter().find(|c| c.1 == start2).expect("a clip still starts at the old edit");
    assert_eq!(c2.2, end2 - rate.tick_of(6), "its head (6 frames) was removed");
    assert_eq!(s.active_sequence().unwrap().duration(), d1 - rate.tick_of(6));
    assert_eq!(s.playhead(), start2, "playhead parks on the new edit");
}

#[test]
fn interchange_roundtrip_through_files() {
    let dir = std::env::temp_dir().join(format!("fc-ix-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = demo();
    let n0 = clip_ids(&s, 0).len();
    for (cmd, ext) in [("file.exportFcp7Xml", "xml"), ("file.exportOtio", "otio"), ("file.exportFcpxml", "fcpxml"), ("file.exportEdl", "edl")] {
        let path = dir.join(format!("demo.{ext}")).to_string_lossy().to_string();
        s.execute(cmd, json!({"path": path})).unwrap();
        let r = s.execute("file.import", json!({"paths": [path]})).unwrap();
        let seq = r["sequences"][0].as_u64().unwrap_or_else(|| panic!("{ext}: no sequence in {r}"));
        assert_eq!(s.state.active_sequence, Some(ItemId(seq)), "{ext}: imported sequence is opened");
        // FCP7 XML and OTIO carry our generator (synthetic) media; FCPXML/EDL only file media.
        if matches!(ext, "xml" | "otio") {
            assert_eq!(clip_ids(&s, 0).len(), n0, "{ext}: V1 clip count survives the round trip");
        }
        s.execute("sequence.open", json!({"item": s.state.open_sequences[0].0})).unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// `file.exportInterchange {format: "<unknown>"}` used to write FCP7 XML without a word.
#[test]
fn export_interchange_refuses_an_unknown_format() {
    let d = std::env::temp_dir().join(format!("fc-ix-format-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let path = |n: &str| d.join(n).to_string_lossy().to_string();
    let mut s = demo();
    // unknown names, values that are not names, and spellings that are not the documented ones
    for bad in [json!("premiere"), json!("mp4"), json!(""), json!(7), json!(["xml"]), json!(".xml"), json!("fcpxmld"), json!("omfi"), json!("xml ")] {
        let e = s.execute("file.exportInterchange", json!({"format": bad, "path": path("bad.out")})).unwrap_err();
        assert!(matches!(&e, EngineError::BadParams { cmd, .. } if cmd == "file.exportInterchange"), "{bad}: {e:?}");
        let e = e.to_string();
        assert!(e.contains("unknown format") && e.ends_with("use one of edl, xml, fcpxml, otio, aaf, omf"), "the error lists exactly the accepted names: {e}");
        assert!(!d.join("bad.out").exists(), "nothing is written for {bad}");
    }
    // the documented formats still export (in either case), and no format still means FCP7 XML
    let text = |n: &str| String::from_utf8_lossy(&std::fs::read(d.join(n)).unwrap()).into_owned();
    s.execute("file.exportInterchange", json!({"path": path("default.xml")})).unwrap();
    s.execute("file.exportInterchange", json!({"format": "xml", "path": path("a.xml")})).unwrap();
    assert!(text("default.xml").contains("<xmeml") && text("a.xml").contains("<xmeml"));
    s.execute("file.exportInterchange", json!({"format": "fcpxml", "path": path("a.fcpxml")})).unwrap();
    assert!(text("a.fcpxml").contains("<fcpxml"));
    s.execute("file.exportInterchange", json!({"format": "otio", "path": path("a.otio")})).unwrap();
    assert!(text("a.otio").contains("OTIO_SCHEMA"));
    s.execute("file.exportInterchange", json!({"format": "EDL", "path": path("a.edl")})).unwrap();
    assert!(text("a.edl").contains("TITLE:"));
    for (format, magic) in [("aaf", "aaf"), ("omf", "omf")] {
        let r = s.execute("file.exportInterchange", json!({"format": format, "path": path(&format!("a.{magic}"))})).unwrap();
        assert!(r["bytes"].as_u64().unwrap() > 0, "{format}");
    }
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn move_items_to_bin_and_back_with_undo() {
    let mut s = demo();
    let bin = s.execute("file.newBin", json!({"name": "Selects"})).unwrap()["bin"].as_u64().unwrap();
    let mut items = Vec::new();
    s.project.root.all_items(&mut items);
    let item = items[0];
    let home = s.project.root.parent_of(item);
    let r = s.execute("project.moveToBin", json!({"items": [item.0], "bin": bin})).unwrap();
    assert_eq!(r["moved"], 1);
    assert_eq!(s.project.root.parent_of(item), Some(kition_film_project::BinId(bin)));
    // the item is in the tree exactly once
    let mut all = Vec::new();
    s.project.root.all_items(&mut all);
    assert_eq!(all.iter().filter(|i| **i == item).count(), 1);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.project.root.parent_of(item), home);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(s.project.root.parent_of(item), Some(kition_film_project::BinId(bin)));
    // back to the root with `bin: null`
    s.execute("project.moveToBin", json!({"items": [item.0], "bin": null})).unwrap();
    assert_eq!(s.project.root.parent_of(item), Some(s.project.root.id));
    // an unknown bin is an error, and so is no items and no selection
    assert!(s.execute("project.moveToBin", json!({"items": [item.0], "bin": 999_999})).is_err());
    s.state.project_selection.clear();
    assert!(s.execute("project.moveToBin", json!({})).is_err());
}

#[test]
fn fps_validation_keeps_real_rates_and_refuses_degenerate_ones() {
    let mut s = demo();
    // real rates still work, through both commands
    for fps in [23.976, 25.0, 29.97, 59.94, 120.0] {
        s.execute("file.newSequence", json!({"name": format!("r{fps}"), "fps": fps})).unwrap_or_else(|e| panic!("{fps}: {e}"));
        let r = s.sequence_rate();
        assert!((r.as_f64() - fps).abs() < 0.01, "{fps} -> {}", r.as_f64());
        s.execute("sequence.settings", json!({"fps": 24})).unwrap();
        assert!((s.sequence_rate().as_f64() - 24.0).abs() < 1e-9);
    }
    // a rate that rounds to nothing is refused, and nothing changes
    let before = s.sequence_rate();
    let n = s.execute("project.inspect", json!({})).unwrap().to_string().len();
    assert!(s.execute("file.newSequence", json!({"name": "tiny", "fps": 1e-12})).is_err());
    assert!(s.execute("sequence.settings", json!({"fps": -0.0})).is_err());
    assert_eq!(s.sequence_rate(), before);
    assert_eq!(s.execute("project.inspect", json!({})).unwrap().to_string().len(), n, "no sequence was created");
}

/// With a clip selected, Q/W trim only its tracks (and its linked sound), not every
/// targeted track under the playhead (the music on A2 used to be cut too).
#[test]
fn ripple_trim_to_playhead_follows_the_selection() {
    let mut s = demo_unlocked();
    let rate = s.sequence_rate();
    let a2 = |s: &Session| s.active_sequence().unwrap().audio_tracks[1].items.iter().map(|i| (i.start, i.duration)).collect::<Vec<_>>();
    let music = a2(&s);
    assert!(!music.is_empty(), "the demo has music on A2");
    let (id, start, _) = v1(&s)[1];
    s.execute("timeline.select", json!({"clips": [id]})).unwrap();
    let ph = start + rate.tick_of(10);
    s.execute("playhead.set", json!({"time": ph.0})).unwrap();
    s.execute("trim.rippleNext", json!({})).unwrap();
    assert_eq!(v1(&s).into_iter().find(|c| c.0 == id).unwrap().2, ph, "the selected clip ends at the playhead");
    assert_eq!(a2(&s), music, "the music on A2 is untouched");
    let linked = s.active_sequence().unwrap().audio_tracks[0].items.iter().find(|i| i.start == start).map(|i| i.end());
    assert_eq!(linked, Some(ph), "its linked sound on A1 is trimmed with it");
}

#[test]
fn empty_items_do_not_panic_keyframe_commands() {
    let mut s = demo();
    let seq = s.state.active_sequence.unwrap();
    let clip = {
        let item = &mut std::sync::Arc::make_mut(&mut s.project).sequence_mut(seq).unwrap().video_tracks[0].items[0];
        item.duration = Tick::ZERO;
        item.id
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        s.execute("effects.toggleAnimation", json!({"clip":clip.0,"effect":"motion","param":"position"}))
    }));
    assert!(result.is_ok(), "an empty clip must not supply reversed clamp bounds");
    let error = result.unwrap().unwrap_err();
    assert!(error.to_string().contains("non-positive duration"), "expected the ordinary invariant error, got: {error}");
}

/// A drag of an effect parameter (`merge`, starting with `begin`) is one undo step, and the
/// next drag is another.
#[test]
fn dragging_an_effect_parameter_is_one_undo_step() {
    let mut s = demo_unlocked();
    let id = v1(&s)[0].0;
    let opacity = |s: &Session| {
        let q = s.active_sequence().unwrap();
        let it = q.find_item(ClipId(id)).unwrap().1;
        let e = it.effects.iter().find(|e| e.effect == "opacity").unwrap();
        e.params["opacity"].value.as_f64().unwrap()
    };
    let start = opacity(&s);
    let set = |s: &mut Session, v: f64, begin: bool| {
        s.execute("effects.setParam", json!({"clip": id, "effect": "opacity", "param": "opacity", "value": v, "merge": true, "begin": begin})).unwrap();
    };
    set(&mut s, 90.0, true);
    set(&mut s, 70.0, false);
    set(&mut s, 30.0, false);
    set(&mut s, 50.0, true); // a second drag
    set(&mut s, 60.0, false);
    assert_eq!(opacity(&s), 60.0);
    s.undo();
    assert_eq!(opacity(&s), 30.0, "undo takes back the whole second drag");
    s.undo();
    assert_eq!(opacity(&s), start, "and then the whole first one");
}

#[test]
fn a_scratch_session_edits_a_copy_without_a_replica_history_or_journal() {
    let mut s = demo();
    s.execute("sequence.addTracks", json!({})).unwrap();
    assert!(s.kdm().is_some(), "the document's edit made its replica");
    let clip = s.active_sequence().unwrap().video_tracks[0].items[0].id;
    s.execute("timeline.select", json!({"clips": [clip.0]})).unwrap();
    let project = s.project.clone();
    let (revision, steps, journal, version) = (s.revision, s.history.undo.len(), s.journal.len(), s.version().unwrap());

    let mut scratch = s.scratch();
    assert!(scratch.is_scratch() && !s.is_scratch());
    assert!(Arc::ptr_eq(&scratch.project, &s.project), "the same project, shared");
    assert!(!Arc::ptr_eq(&scratch.media, &s.media), "a media pool of its own");
    assert_eq!((scratch.playhead(), scratch.state.selection.clone()), (s.playhead(), s.state.selection.clone()));
    assert_eq!(scratch.revision, s.revision);
    assert!(scratch.kdm().is_none() && scratch.persistence.is_none() && scratch.prefs_path.is_none());
    assert!(scratch.history.undo.is_empty() && scratch.journal.is_empty() && scratch.jobs.is_empty());

    scratch.execute("clip.speedDuration", json!({"speed": 50.0})).unwrap();
    scratch.execute("sequence.addTracks", json!({})).unwrap();
    scratch.poll_persistence();
    assert!(scratch.kdm().is_none(), "a scratch session never makes a replica");
    assert!(!Arc::ptr_eq(&scratch.project, &project), "the copy changed");
    assert!(Arc::ptr_eq(&s.project, &project), "the document did not");
    assert_eq!((s.revision, s.history.undo.len(), s.journal.len()), (revision, steps, journal));
    assert_eq!(s.version().unwrap(), version, "the document's replica did not move");
}

#[test]
fn a_scratch_session_has_its_own_media_pool_over_the_same_decoded_sources() {
    let s = demo();
    s.render_program(0.125).unwrap();
    let items: Vec<ItemId> = s.project.items.keys().copied().filter(|id| s.media.cached(*id).is_some()).collect();
    assert!(!items.is_empty(), "the render opened sources");
    let scratch = s.scratch();
    for id in &items {
        assert!(Arc::ptr_eq(&scratch.media.cached(*id).unwrap(), &s.media.cached(*id).unwrap()), "the same decoded source, not a new decode");
    }
    scratch.media.remove(items[0]);
    scratch.media.clear();
    scratch.media.set_use_proxies(!s.media.use_proxies());
    assert!(s.media.cached(items[0]).is_some(), "what the copy evicts stays in the document's pool");
    assert!(!s.media.use_proxies(), "the copy's proxy switch is its own");
    let fresh = Session::default();
    assert_eq!(scratch.media.openers.read().unwrap().len(), fresh.media.openers.read().unwrap().len(), "the same openers");
}

#[test]
fn undo_and_redo_on_a_scratch_session_make_no_replica() {
    let mut s = demo();
    s.execute("sequence.addTracks", json!({})).unwrap();
    let mut scratch = s.scratch();
    scratch.execute("sequence.addTracks", json!({})).unwrap();
    assert!(scratch.undo().is_some());
    assert!(scratch.kdm().is_none(), "undo makes no replica");
    assert!(scratch.redo().is_some());
    assert!(scratch.kdm().is_none(), "redo makes no replica");
}

#[test]
fn a_scratch_session_deletes_no_file_and_ingests_nothing() {
    use crate::media_test_util::{make_movie, session_with, tmp_dir};
    let root = tmp_dir("scratch-files");
    let (a, b) = (root.join("A.mov"), root.join("B.mov"));
    make_movie(&a, kition_film_media::DemoScene::Forest, 64, 36, 4);
    make_movie(&b, kition_film_media::DemoScene::Forest, 64, 36, 4);
    let (mut s, items, _) = session_with(&[a.as_path()]);
    let dest = root.join("Ingest");
    s.execute("project.ingestSettings", json!({"enabled": true, "action": "copy", "destination": dest.to_string_lossy()})).unwrap();

    let mut scratch = s.scratch();
    let r = scratch.execute("media.makeOffline", json!({"items": [items[0].0], "deleteFiles": true})).unwrap();
    assert_eq!(r["deleted"], json!([]), "{r}");
    assert!(a.exists(), "a scratch session deletes no media file");
    let r = scratch.execute("file.import", json!({"paths": [b.to_string_lossy()]})).unwrap();
    assert!(r["ingest"].is_null(), "{r}");
    assert!(!dest.exists(), "a scratch session copies no file to ingest");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_scratch_session_settles_the_documents_live_trim_on_the_copy() {
    let mut s = demo();
    let first = s.active_sequence().unwrap().video_tracks[0].items[0].id.0;
    s.execute("trim.selectEditPoint", json!({"clip": first, "edge": "out", "kind": "roll"})).unwrap();
    s.execute("trim.shuttle", json!({"direction": "forward", "clock": 10.0})).unwrap();
    s.execute("trim.tick", json!({"clock": 10.5})).unwrap();
    let (project, steps) = (s.project.clone(), s.history.undo.len());

    let mut scratch = s.scratch();
    assert!(scratch.trim_play.dynamic.is_some(), "the copy has the live trim");
    scratch.execute("sequence.addTracks", json!({})).unwrap();
    let labels: Vec<&str> = scratch.history.undo.iter().map(|step| step.0.as_str()).collect();
    assert_eq!(labels, ["Dynamic Rolling Edit", "Add Tracks"], "the copy settles the trim first, as execute does on the document");
    assert!(s.trim_play.dynamic.is_some(), "the document's trim is still live");
    assert!(Arc::ptr_eq(&s.project, &project) && s.history.undo.len() == steps);
}

/// `effects.setParam` (and the keyframe commands) take an effect by its display name as
/// well as its id or index, and a choice by its option's name as well as its index; an unknown
/// option is refused with the options it has.
#[test]
fn set_param_takes_effect_names_and_choice_names() {
    use kition_film_project::ParamValue;
    let mut s = demo();
    let c = s.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    s.execute("effects.apply", json!({"clips": [c], "effect": "Gaussian Blur"})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "Gaussian Blur", "param": "blurriness", "value": 12.0})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "Gaussian Blur", "param": "dimensions", "value": "Horizontal"})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "opacity", "param": "blend", "value": "Screen"})).unwrap();
    s.execute("effects.toggleAnimation", json!({"clip": c, "effect": "Gaussian Blur", "param": "blurriness"})).unwrap();
    let it = s.active_sequence().unwrap().find_item(kition_film_project::ClipId(c)).unwrap().1.clone();
    let blur = it.effect("gaussian_blur").unwrap();
    assert_eq!(blur.params["blurriness"].value, ParamValue::Float(12.0));
    assert!(blur.params["blurriness"].is_animated());
    assert_eq!(blur.params["dimensions"].value, ParamValue::Choice(1));
    let modes = kition_film_project::find_effect("opacity").unwrap().param("blend").unwrap().kind.clone();
    let kition_film_project::ParamKind::Choice(names) = modes else { panic!("blend is a choice") };
    let screen = names.iter().position(|n| *n == "Screen").unwrap() as u32;
    assert_eq!(it.effect("opacity").unwrap().params["blend"].value, ParamValue::Choice(screen));
    let err = s.execute("effects.setParam", json!({"clip": c, "effect": "Gaussian Blur", "param": "dimensions", "value": "Sideways"})).unwrap_err();
    assert!(err.to_string().contains("Horizontal"), "{err}");
}

/// `timeline.razor` answers the clips its cuts made (`clips`, the right-hand pieces) and
/// the clips each was cut from (`pieces`), as its description promises.
#[test]
fn razor_answers_the_new_clip_ids() {
    let mut s = demo();
    let first = s.active_sequence().unwrap().video_tracks[0].items[0].clone();
    let t = first.start + Tick(first.duration.0 / 2);
    let r = s.execute("timeline.razor", json!({"time": t.0, "track": "V1"})).unwrap();
    assert_eq!(r["cuts"], 1, "{r}");
    let new = kition_film_project::ClipId(r["clips"][0].as_u64().unwrap_or_else(|| panic!("no new clip ids: {r}")));
    let q = s.active_sequence().unwrap();
    let (_, right) = q.find_item(new).unwrap();
    assert_eq!(right.start, t, "the new clip starts at the cut");
    assert_eq!(r["pieces"][0]["left"], first.id.0);
    assert_eq!(r["pieces"][0]["right"], new.0);
    // every unlocked track: one new id per cut
    let t2 = t + Tick(first.duration.0 / 4);
    let r = s.execute("timeline.razor", json!({"time": t2.0})).unwrap();
    let n = r["cuts"].as_u64().unwrap() as usize;
    assert!(n >= 1);
    assert_eq!(r["clips"].as_array().unwrap().len(), n, "{r}");
    for id in r["clips"].as_array().unwrap() {
        let (_, it) = s.active_sequence().unwrap().find_item(kition_film_project::ClipId(id.as_u64().unwrap())).unwrap();
        assert_eq!(it.start, t2);
    }
}

/// Marker commands take marker colour names (Red, Orange, Cyan…) as well as label names,
/// refuse an unknown colour instead of saving Green, and take `seconds` (snapped to a frame) like
/// `timeline.place`.
#[test]
fn markers_take_colour_names_and_seconds() {
    use kition_film_project::Label;
    let mut s = demo();
    let rate = s.sequence_rate();
    let r = s.execute("markers.add", json!({"seconds": 3.4, "color": "Red", "name": "Hit"})).unwrap();
    let id = r["marker"].as_u64().unwrap();
    let m = s.active_sequence().unwrap().markers.iter().find(|m| m.id.0 == id).unwrap().clone();
    assert_eq!(m.color, Label::Rose, "Red is the red marker colour");
    assert_eq!(m.start, rate.snap(Tick::from_seconds_f64(3.4)), "seconds land on a frame");
    assert_eq!(m.color.marker_rgb(), [0xc1, 0x3c, 0x3d]);
    for (name, want) in [
        ("orange", Label::Mango),
        ("Cyan", Label::Teal),
        ("Purple", Label::Purple),
        ("Blue", Label::Blue),
        ("Yellow", Label::Yellow),
        ("Green", Label::Green),
        ("Lavender", Label::Lavender),
    ] {
        s.execute("markers.edit", json!({"marker": id, "color": name})).unwrap();
        let m = s.active_sequence().unwrap().markers.iter().find(|m| m.id.0 == id).unwrap().clone();
        assert_eq!(m.color, want, "{name}");
    }
    let n = s.active_sequence().unwrap().markers.len();
    let err = s.execute("markers.add", json!({"seconds": 1, "color": "Chartreuse"})).unwrap_err();
    assert!(err.to_string().contains("Red"), "the error lists the colours: {err}");
    assert_eq!(s.active_sequence().unwrap().markers.len(), n, "nothing was added");
    assert!(s.execute("markers.edit", json!({"marker": id, "color": "Chartreuse"})).is_err());
    let r = s.execute("markers.addRange", json!({"seconds": 2, "durationSeconds": 1.5, "color": "Cyan"})).unwrap();
    let m = s.active_sequence().unwrap().markers.iter().find(|m| m.id.0 == r["marker"].as_u64().unwrap()).unwrap().clone();
    assert_eq!((m.start, m.duration, m.color), (rate.snap(Tick::from_seconds_f64(2.0)), rate.snap_nearest(Tick::from_seconds_f64(1.5)), Label::Teal));
    let r = s.execute("markers.addChapter", json!({"seconds": 5, "color": "Orange"})).unwrap();
    assert!(r["marker"].is_u64());
    assert!(s.execute("markers.addFlashCue", json!({"seconds": 6, "color": "nope"})).is_err());
}

/// `sequence.inspect` (and the document's `inspect`) answers parameter values as JSON
/// (numbers, [x, y], "#rrggbb", choice indexes with their option), keyframes with their times,
/// values and interpolation, frame holds, and each audio track's volume and pan.
#[test]
fn inspect_answers_json_values_keyframes_holds_and_track_mix() {
    let mut s = demo();
    let q = s.active_sequence().unwrap().clone();
    let it = q.video_tracks[0].items[1].clone();
    let c = it.id.0;
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "position", "value": [100.0, 200.0]})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "opacity", "param": "blend", "value": 1})).unwrap();
    let rate = s.sequence_rate();
    let (t0, t1) = (it.start, it.start + rate.tick_of(12));
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 50.0, "time": t0.0})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 80.0, "time": t1.0})).unwrap();
    s.execute("timeline.setTrack", json!({"track": "A1", "volumeDb": -6.0, "pan": 25.0})).unwrap();
    let r =
        s.execute("clip.insertFrameHoldSegment", json!({"clip": c, "time": (it.start + rate.tick_of(30)).0, "seconds": 1})).unwrap_or(serde_json::Value::Null);
    let seq = s.execute("sequence.inspect", json!({})).unwrap();
    let clip = seq["video"][0]["items"].as_array().unwrap().iter().find(|i| i["clip"] == c).unwrap().clone();
    let effect = |id: &str| clip["effects"].as_array().unwrap().iter().find(|e| e["effect"] == id).unwrap().clone();
    let motion = effect("motion");
    assert_eq!(motion["params"]["position"]["value"], json!([100.0, 200.0]), "{motion}");
    let scale = &motion["params"]["scale"];
    let keys = scale["keyframes"].as_array().unwrap_or_else(|| panic!("keyframes are listed: {scale}"));
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0]["value"], json!(50.0));
    assert_eq!(keys[1]["value"], json!(80.0));
    assert_eq!(keys[0]["time"], json!(t0.0));
    assert_eq!(keys[1]["time"], json!(t1.0));
    assert_eq!(keys[1]["mediaTime"], json!(it.source_time_at(t1).0));
    assert_eq!(keys[0]["interpolation"], "linear");
    let opacity = effect("opacity");
    assert_eq!(opacity["params"]["blend"]["value"], json!(1));
    assert!(opacity["params"]["blend"]["option"].is_string(), "{opacity}");
    assert!(opacity["params"]["opacity"]["value"].is_number());
    let a1 = &seq["audio"][0];
    assert_eq!(a1["volumeDb"], json!(-6.0), "{a1}");
    assert_eq!(a1["pan"], json!(25.0));
    // the frame-hold segment says it is one
    if !r.is_null() {
        let holds: Vec<&serde_json::Value> = seq["video"][0]["items"].as_array().unwrap().iter().filter(|i| i["frameHold"].is_object()).collect();
        assert_eq!(holds.len(), 1, "one frame-hold segment: {r}");
        assert!(holds[0]["frameHold"]["mediaTime"].is_i64());
    } else {
        panic!("clip.insertFrameHoldSegment failed");
    }
}

/// `effects.list {effect}` answers the exact id first (`dynamics` before Dynamics,
/// whose id is `dynamics_rack`); the keyframe commands document `mask`; and an unknown
/// interpolation is refused instead of becoming linear.
#[test]
fn effects_list_ranks_the_exact_id_and_keyframe_commands_take_mask() {
    let mut s = demo();
    let list = s.execute("effects.list", json!({"effect": "dynamics"})).unwrap();
    assert_eq!(list[0]["id"], "dynamics", "{list}");
    assert_eq!(kition_film_project::effect::find_effect_by_name("dynamics").unwrap().id, "dynamics");
    for id in ["effects.setInterpolation", "effects.deleteKeyframe", "effects.moveKeyframe", "effects.setKeyframe", "effects.addKeyframe"] {
        let spec = crate::commands::command_specs().iter().find(|c| c.id == id).unwrap();
        assert!(spec.params.contains("\"mask\""), "{id} documents `mask`: {}", spec.params);
    }
    let c = s.active_sequence().unwrap().video_tracks[0].items[1].clone();
    let t = c.start;
    s.execute("effects.setParam", json!({"clip": c.id.0, "effect": "motion", "param": "scale", "value": 50.0, "time": t.0})).unwrap();
    let mt = c.source_time_at(t).0;
    let err = s.execute("effects.setInterpolation", json!({"clip": c.id.0, "effect": "motion", "param": "scale", "mediaTime": mt, "interpolation": "wobbly"}));
    assert!(err.is_err(), "an unknown interpolation is refused");
    s.execute("effects.setInterpolation", json!({"clip": c.id.0, "effect": "motion", "param": "scale", "mediaTime": mt, "interpolation": "Ease In"})).unwrap();
    let it = s.active_sequence().unwrap().find_item(c.id).unwrap().1.clone();
    assert_eq!(it.effect("motion").unwrap().params["scale"].keyframes[0].interp, kition_film_project::Interpolation::EaseIn);
}

/// The sequence's preset name follows `sequence.settings` (a 1280x720 23.976 sequence
/// changed to 24 fps reads `1280x720 24`); Scale Width is refused while Uniform Scale is on (it
/// would do nothing), and works once Uniform Scale is off.
#[test]
fn settings_preset_follows_and_scale_width_needs_uniform_scale_off() {
    let mut s = Session::default();
    s.execute("file.newSequence", json!({"name": "P", "fps": 23.976, "width": 1280, "height": 720, "video": 1, "audio": 1})).unwrap();
    let preset = |s: &mut Session| s.execute("sequence.inspect", json!({})).unwrap()["settings"]["preset"].as_str().unwrap().to_string();
    assert_eq!(preset(&mut s), "1280x720 23.976");
    s.execute("sequence.settings", json!({"fps": 24})).unwrap();
    assert_eq!(preset(&mut s), "1280x720 24");
    s.execute("sequence.settings", json!({"width": 1920, "height": 1080})).unwrap();
    assert_eq!(preset(&mut s), "1920x1080 24");
    let m = s.execute("file.newColorMatte", json!({"color": "#ffffff", "seconds": 2})).unwrap();
    let r = s.execute("timeline.place", json!({"item": m["item"], "track": "V1", "seconds": 0})).unwrap();
    let c = r["clips"][0].as_u64().unwrap();
    let err = s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale_width", "value": 50.0})).unwrap_err();
    assert!(err.to_string().contains("uniform_scale"), "{err}");
    let err = s.execute("effects.toggleAnimation", json!({"clip": c, "effect": "motion", "param": "scale_width"})).unwrap_err();
    assert!(err.to_string().contains("uniform_scale"), "{err}");
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "uniform_scale", "value": false})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale_width", "value": 50.0})).unwrap();
    let img = s.render_program(0.25).unwrap();
    // half as wide: the matte covers the middle half of the frame only
    assert!(img.get(img.w / 2, img.h / 2)[0] > 0.9);
    assert!(img.get(img.w / 8, img.h / 2)[0] < 0.05, "{:?}", img.get(img.w / 8, img.h / 2));
}

/// A transition by hand (the Timeline, Effect Controls): applied with an alignment, moved over its
/// cut, resized from either end or by its alignment, and cleared, each one undo step; a drag's
/// steps share one with `merge`; hostile spans are refused and change nothing.
#[test]
fn transitions_align_move_resize_and_clear() {
    use kition_film_project::TransitionAlign;
    let mut s = demo();
    let rate = s.sequence_rate();
    let f = |n: i64| rate.tick_of(n).0;
    let q = s.active_sequence().unwrap();
    let (a, b) = (q.video_tracks[0].items[1].clone(), q.video_tracks[0].items[2].clone());
    assert_eq!(a.end(), b.start, "the demo's clips 1 and 2 meet");
    let cut = b.start;
    let span = |s: &Session, id: u64| {
        let t = s.active_sequence().unwrap().video_tracks[0].transitions.iter().find(|t| t.id.0 == id).cloned();
        t.map(|t| (t.start.0, t.duration.0, t.align))
    };
    // applied Start at Cut and End at Cut
    let id = s.execute("sequence.applyVideoTransition", json!({"clip": b.id.0, "edge": "in", "frames": 10, "align": "start"})).unwrap()["transition"]
        .as_u64()
        .unwrap();
    assert_eq!(span(&s, id), Some((cut.0, f(10), TransitionAlign::StartAtCut)));
    let id = s.execute("sequence.applyVideoTransition", json!({"clip": b.id.0, "edge": "in", "frames": 10, "align": "end"})).unwrap()["transition"]
        .as_u64()
        .unwrap();
    assert_eq!(span(&s, id), Some((cut.0 - f(10), f(10), TransitionAlign::EndAtCut)));
    assert!(s.execute("sequence.applyVideoTransition", json!({"clip": b.id.0, "edge": "in", "align": "middle"})).is_err());
    // a duration longer than the clips is clamped to them
    let id = s.execute("sequence.applyVideoTransition", json!({"clip": b.id.0, "edge": "in", "frames": 100_000})).unwrap()["transition"].as_u64().unwrap();
    let room = (cut - a.start).min(b.end() - cut).0 * 2;
    assert_eq!(span(&s, id).unwrap().1, room);
    let id = s.execute("sequence.applyVideoTransition", json!({"clip": b.id.0, "edge": "in", "frames": 20})).unwrap()["transition"].as_u64().unwrap();
    assert_eq!(span(&s, id), Some((cut.0 - f(10), f(20), TransitionAlign::CenterAtCut)));
    let inspected = s.execute("sequence.inspect", json!({})).unwrap();
    let js = inspected["video"][0]["transitions"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!(js["align"], "center");
    // moved over the cut (its body dragged), one undo step for the whole drag
    let undo = s.history.undo.len();
    for (i, d) in [2, 4, 6].into_iter().enumerate() {
        let r = s.execute("sequence.setTransition", json!({"transition": id, "start": cut.0 - f(10) + f(d), "merge": true, "begin": i == 0})).unwrap();
        assert_eq!(r["start"], cut.0 - f(10) + f(d));
    }
    assert_eq!(s.history.undo.len(), undo + 1, "a drag is one undo step");
    assert_eq!(span(&s, id), Some((cut.0 - f(4), f(20), TransitionAlign::CenterAtCut)));
    // its end dragged: start and duration together
    let r = s.execute("sequence.setTransition", json!({"transition": id, "start": cut.0 - f(4), "duration": f(30)})).unwrap();
    assert_eq!((r["start"].as_i64(), r["duration"].as_i64(), r["align"].as_str()), (Some(cut.0 - f(4)), Some(f(30)), Some("custom")));
    // re-aligned, and resized by its alignment
    s.execute("sequence.setTransition", json!({"transition": id, "align": "start"})).unwrap();
    assert_eq!(span(&s, id), Some((cut.0, f(30), TransitionAlign::StartAtCut)));
    s.execute("sequence.setTransition", json!({"transition": id, "frames": 12})).unwrap();
    assert_eq!(span(&s, id), Some((cut.0, f(12), TransitionAlign::StartAtCut)), "Start at Cut keeps its start");
    // refused: off the cut, past the clips, both start and align, no frames, hostile numbers
    let before = s.active_sequence().unwrap().clone();
    for bad in [
        json!({"transition": id, "start": cut.0 + f(1)}),
        json!({"transition": id, "start": a.start.0 - f(1)}),
        json!({"transition": id, "duration": (b.end() - a.start).0 + 1}),
        json!({"transition": id, "frames": 0}),
        json!({"transition": id, "frames": 3, "duration": f(3)}),
        json!({"transition": id, "start": cut.0, "align": "end"}),
        json!({"transition": id, "align": "custom"}),
        json!({"transition": id, "start": i64::MAX, "duration": i64::MAX}),
        json!({"transition": id, "start": i64::MIN}),
        json!({"transition": id, "frames": i64::MIN}),
        json!({"transition": u64::MAX, "frames": 3}),
    ] {
        assert!(s.execute("sequence.setTransition", bad.clone()).is_err(), "{bad}");
        assert_eq!(s.active_sequence().unwrap(), &before, "{bad}");
    }
    // cleared, one undo step; again is an error
    let undo = s.history.undo.len();
    assert_eq!(s.execute("sequence.removeTransition", json!({"transitions": [id]})).unwrap()["removed"], 1);
    assert_eq!(span(&s, id), None);
    assert_eq!(s.history.undo.len(), undo + 1);
    assert!(s.execute("sequence.removeTransition", json!({"transitions": [id]})).is_err());
    for bad in [json!({}), json!({"transitions": []}), json!({"transitions": "x"}), json!({"transitions": [-1]})] {
        assert!(s.execute("sequence.removeTransition", bad.clone()).is_err(), "{bad}");
    }
    s.undo();
    assert!(span(&s, id).is_some(), "undo brings it back");
    // a locked track refuses
    s.edit_sequence("lock", |q, _, _| {
        q.video_tracks[0].locked = true;
        Ok(())
    })
    .unwrap();
    assert!(s.execute("sequence.removeTransition", json!({"transitions": [id]})).is_err());
    assert!(s.execute("sequence.setTransition", json!({"transition": id, "frames": 4})).is_err());
}

/// `effects.move` reorders a clip's standard effects (Effect Controls' drag), one undo step;
/// fixed effects keep their places.
#[test]
fn effects_move_reorders_standard_effects() {
    let mut s = demo();
    let c = s.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    s.execute("effects.apply", json!({"clips": [c], "effect": "Gaussian Blur"})).unwrap();
    s.execute("effects.apply", json!({"clips": [c], "effect": "Invert"})).unwrap();
    let names = |s: &Session| -> Vec<String> {
        s.active_sequence().unwrap().find_item(kition_film_project::ClipId(c)).unwrap().1.effects.iter().map(|e| e.effect.clone()).collect()
    };
    let before = names(&s);
    assert_eq!(&before[..2], ["gaussian_blur", "invert"]);
    let undo = s.history.undo.len();
    s.execute("effects.move", json!({"clip": c, "index": 1, "to": 0})).unwrap();
    assert_eq!(&names(&s)[..2], ["invert", "gaussian_blur"]);
    assert_eq!(names(&s)[2..], before[2..], "the fixed effects stay");
    assert_eq!(s.history.undo.len(), undo + 1);
    s.undo();
    assert_eq!(names(&s), before);
    let motion = before.iter().position(|e| e == "motion").unwrap() as u64;
    for bad in [
        json!({"clip": c, "index": 0, "to": motion}),
        json!({"clip": c, "index": motion, "to": 0}),
        json!({"clip": c, "index": 0, "to": 0}),
        json!({"clip": c, "index": 0, "to": 99}),
        json!({"clip": c, "index": u64::MAX, "to": 0}),
        json!({"clip": c, "index": 0}),
        json!({"clip": u64::MAX, "index": 0, "to": 1}),
    ] {
        assert!(s.execute("effects.move", bad.clone()).is_err(), "{bad}");
        assert_eq!(names(&s), before, "{bad}");
    }
}

/// A drag that changes two parameters (the Program monitor's edge handles: Scale Height and
/// Width; the anchor point: Anchor Point and Position) is one undo step with a shared `merge` key.
#[test]
fn set_param_merge_key_joins_parameters() {
    let mut s = demo();
    let c = s.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    let undo = s.history.undo.len();
    for (i, v) in [10.0, 20.0, 30.0].into_iter().enumerate() {
        s.execute("effects.setParam", json!({"clip": c, "param": "position", "value": [v, v], "merge": "anchor", "begin": i == 0})).unwrap();
        s.execute("effects.setParam", json!({"clip": c, "param": "anchor", "value": [v, v], "merge": "anchor"})).unwrap();
    }
    assert_eq!(s.history.undo.len(), undo + 1, "one undo step for both parameters");
    // a new drag (`begin`) is a new step
    s.execute("effects.setParam", json!({"clip": c, "param": "position", "value": [1.0, 1.0], "merge": "anchor", "begin": true})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 2);
    // a boolean merge still merges one parameter only
    s.execute("effects.setParam", json!({"clip": c, "param": "scale", "value": 50.0, "merge": true, "begin": true})).unwrap();
    s.execute("effects.setParam", json!({"clip": c, "param": "rotation", "value": 5.0, "merge": true})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 4);
}

/// `timeline.move` with `copy` (the Timeline's Option-drag) copies the clips where the move would
/// have put them and leaves the originals: one undo step, the copies selected and named in the
/// answer; refused moves change nothing.
#[test]
fn move_copy_leaves_the_originals_in_one_undo_step() {
    let mut s = demo_unlocked();
    let q = s.active_sequence().unwrap().clone();
    let first = q.video_tracks[0].items[0].clone();
    let end = q.duration();
    let before = s.active_sequence().unwrap().all_tracks().map(|t| t.items.len()).sum::<usize>();
    let undo = s.history.undo.len();
    let r = s.execute("timeline.move", json!({"moves": [{"clip": first.id.0, "track": "V2", "time": end.0}], "linked": false, "copy": true})).unwrap();
    let copied: Vec<u64> = r["copied"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    assert_eq!(copied.len(), 1, "{r}");
    assert!(r.get("moved").is_none(), "a copy moves nothing: {r}");
    assert_eq!(s.history.undo.len(), undo + 1, "one undo step");
    let q2 = s.active_sequence().unwrap();
    assert_eq!(q2.find_item(first.id).unwrap().1.start, first.start, "the original stays");
    let (track, copy) = q2.find_item(kition_film_project::ClipId(copied[0])).unwrap();
    assert_eq!((track, copy.start, copy.duration, copy.item, copy.source_in), (q2.video_tracks[1].id, end, first.duration, first.item, first.source_in));
    assert_eq!(q2.all_tracks().map(|t| t.items.len()).sum::<usize>(), before + 1);
    s.undo();
    assert_eq!(s.active_sequence().unwrap().all_tracks().map(|t| t.items.len()).sum::<usize>(), before, "undo takes the copy away");
    // with its linked partner, the two copies are linked to each other
    let link = q.all_tracks().flat_map(|t| &t.items).find(|i| i.link.is_some()).cloned();
    if let Some(linked) = link {
        let r = s
            .execute(
                "timeline.move",
                json!({"moves": [{"clip": linked.id.0, "track": q.find_item(linked.id).unwrap().0.0, "time": end.0}], "linked": true, "copy": true}),
            )
            .unwrap();
        let ids: Vec<_> = r["copied"].as_array().unwrap().iter().map(|v| kition_film_project::ClipId(v.as_u64().unwrap())).collect();
        assert!(ids.len() >= 2, "the partner is copied too: {r}");
        let q3 = s.active_sequence().unwrap();
        let links: Vec<_> = ids.iter().map(|id| q3.find_item(*id).unwrap().1.link).collect();
        assert!(links.iter().all(|l| l.is_some() && *l == links[0] && *l != linked.link), "{links:?}");
        assert_eq!(q3.find_item(linked.id).unwrap().1.link, linked.link);
        s.undo();
    }
    let before = s.active_sequence().unwrap().clone();
    for bad in [
        json!({"moves": [{"clip": first.id.0, "track": "V1", "time": 0}], "copy": "yes"}),
        json!({"moves": [{"clip": first.id.0, "track": "V1", "time": 0}], "copy": 1}),
        json!({"moves": [{"clip": u64::MAX, "track": "V1", "time": 0}], "copy": true}),
        json!({"moves": [{"clip": first.id.0, "track": "V99", "time": 0}], "copy": true}),
        json!({"moves": [{"clip": first.id.0, "track": "A1", "time": 0}], "copy": true}),
        json!({"moves": [{"clip": first.id.0, "track": "V1", "time": i64::MAX}], "copy": true}),
        json!({"moves": [], "copy": true}),
    ] {
        assert!(s.execute("timeline.move", bad.clone()).is_err(), "{bad}");
        assert_eq!(s.active_sequence().unwrap(), &before, "{bad}");
    }
    // a locked destination refuses
    s.edit_sequence("lock", |q, _, _| {
        q.video_tracks[1].locked = true;
        Ok(())
    })
    .unwrap();
    assert!(s.execute("timeline.move", json!({"moves": [{"clip": first.id.0, "track": "V2", "time": end.0}], "copy": true})).is_err());
}

/// `markers.edit` moves a sequence marker with `time` (ticks; a drag along the ruler), one undo
/// step, the markers kept in time order; hostile times are refused.
#[test]
fn markers_edit_moves_a_marker_in_time() {
    let mut s = demo();
    let rate = s.sequence_rate();
    let a = s.execute("markers.add", json!({"frame": 10, "name": "A"})).unwrap()["marker"].as_u64().unwrap();
    let b = s.execute("markers.add", json!({"frame": 40, "name": "B"})).unwrap()["marker"].as_u64().unwrap();
    let starts = |s: &Session| s.active_sequence().unwrap().markers.iter().map(|m| (m.id.0, m.start)).collect::<Vec<_>>();
    let undo = s.history.undo.len();
    s.execute("markers.edit", json!({"marker": a, "time": rate.tick_of(60).0})).unwrap();
    assert_eq!(s.history.undo.len(), undo + 1);
    let now = starts(&s);
    assert_eq!(now.iter().find(|m| m.0 == a).unwrap().1, rate.tick_of(60));
    let ia = now.iter().position(|m| m.0 == a).unwrap();
    let ib = now.iter().position(|m| m.0 == b).unwrap();
    assert!(ib < ia, "kept in time order: {now:?}");
    s.execute("markers.edit", json!({"marker": a, "time": rate.tick_of(5).0, "name": "A2"})).unwrap();
    let m = s.active_sequence().unwrap().markers.iter().find(|m| m.id.0 == a).unwrap().clone();
    assert_eq!((m.start, m.name.as_str()), (rate.tick_of(5), "A2"));
    s.undo();
    assert_eq!(s.active_sequence().unwrap().markers.iter().find(|m| m.id.0 == a).unwrap().start, rate.tick_of(60));
    let before = starts(&s);
    for bad in [
        json!({"marker": a, "time": -1}),
        json!({"marker": a, "time": "soon"}),
        json!({"marker": a, "time": 1.5}),
        json!({"marker": a, "time": i64::MAX, "durationFrames": 10}),
        json!({"marker": u64::MAX, "time": 0}),
        json!({"marker": a, "time": 0, "target": "source"}),
    ] {
        assert!(s.execute("markers.edit", bad.clone()).is_err(), "{bad}");
        assert_eq!(starts(&s), before, "{bad}");
    }
}
