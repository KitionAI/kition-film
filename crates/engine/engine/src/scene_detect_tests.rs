//! Scene Edit Detection on generated footage with known cut points: a movie made with our own
//! ProRes encoder from two demo scenes (no ffmpeg needed), and an H.264 file that ffmpeg (fixture
//! generator only) builds from three lavfi sources.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kition_film_media::generators::GeneratorSource;
use kition_film_media::{DemoScene, Generator, MediaSource};
use kition_film_project::{ItemId, ItemKind, Label, MediaClip, MediaRef, Project, SequenceSettings, TrackKind};
use kition_film_time::{FrameRate, Tick, TimeRange};
use serde_json::json;

use crate::Session;
use crate::media_test_util::{session_with, tmp_dir};

/// Write a 24 fps ProRes movie of demo scenes played one after the other: `shots` = (scene,
/// frames). The cuts are at the running sums of the frame counts.
fn make_cut_movie(path: &Path, shots: &[(DemoScene, i64)], w: u32, h: u32) {
    let rate = FrameRate::FPS_24;
    let mut p = Project::new("fixture");
    let seq = p.new_sequence("s", SequenceSettings { width: w, height: h, frame_rate: rate, ..Default::default() }, 1, 1, None);
    let mut sources: Vec<(ItemId, kition_film_media::SharedSource)> = Vec::new();
    let mut at = Tick::ZERO;
    for (k, (scene, frames)) in shots.iter().enumerate() {
        let dur = rate.tick_of(*frames);
        // each shot starts at a different point of its scene
        let src = GeneratorSource::new(Generator::Demo(*scene), w, h, rate, rate.tick_of(200));
        let clip = MediaClip {
            media: MediaRef::Generator(Generator::Demo(*scene)),
            info: src.info().clone(),
            interpret: Default::default(),
            mark_in: None,
            mark_out: None,
            markers: vec![],
            offline: false,
            proxy: None,
            identity: None,
        };
        let item = p.add_item(&format!("shot{k}"), Label::Iris, ItemKind::Media(clip), None);
        let mut v = p.make_track_item(item, TrackKind::Video, at, TimeRange::new(rate.tick_of(10 * k as i64), dur), rate).unwrap();
        for e in &mut v.effects {
            kition_film_project::resolve_auto_points(e, (w, h), (w, h));
        }
        p.sequence_mut(seq).unwrap().video_tracks[0].items.push(v);
        sources.push((item, Arc::new(src)));
        at += dur;
    }
    let settings =
        kition_film_export::ExportSettings { format: kition_film_export::Format::ProRes, path: path.to_string_lossy().into_owned(), ..Default::default() };
    let provider = move |id: ItemId| sources.iter().find(|(i, _)| *i == id).map(|(_, s)| s.clone());
    kition_film_export::export(&Arc::new(p), seq, &settings, &provider, &Default::default()).unwrap();
}

fn select_v1(s: &mut Session) -> kition_film_project::ClipId {
    let c = s.active_sequence().unwrap().video_tracks[0].items[0].id;
    s.execute("timeline.select", json!({"clips": [c.0]})).unwrap();
    c
}

#[test]
fn pending_scene_analysis_does_not_edit_a_reopened_project() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let root = tmp_dir("scene-project-context");
    let movie = root.join("two-shots.mov");
    let project = root.join("saved.kfilm");
    make_cut_movie(&movie, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, _) = session_with(&[&movie]);
    select_v1(&mut s);
    s.execute("file.saveAs", json!({"path": project.to_string_lossy()})).unwrap();
    let started = s.execute("clip.sceneEditDetection", json!({"generateMarkers": true, "createSubclips": true})).unwrap();
    let job = s.jobs.iter().find(|job| json!(job.id) == started["job"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !job.progress.finished.load(Ordering::Relaxed) || job.result.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline, "scene analysis did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(job.result.lock().unwrap().as_ref().unwrap().is_ok());
    assert_eq!(s.scene_jobs[0].results.lock().unwrap().as_ref().unwrap()[0].cuts.len(), 1, "real analysis found the known cut");
    s.execute("file.open", json!({"path": project.to_string_lossy()})).unwrap();
    let before = (*s.project).clone();
    let history = s.history.undo.len();
    s.poll_persistence();
    assert_eq!(*s.project, before, "old analysis cannot edit a newly opened project, even with identical IDs");
    assert_eq!(s.history.undo.len(), history);
    assert!(s.scene_jobs.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn n26_pending_scene_analysis_cannot_overwrite_changed_source_edits() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let root = tmp_dir("scene-input-changes");
    let movie = root.join("two-shots.mov");
    let replacement = root.join("single-shot.mov");
    make_cut_movie(&movie, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    make_cut_movie(&replacement, &[(DemoScene::Dunes, 36)], 128, 72);
    let mut violations = Vec::new();
    for change in ["move", "delete", "relink"] {
        let (mut s, sources, _) = session_with(&[&movie]);
        let clip = select_v1(&mut s);
        let started = s.execute("clip.sceneEditDetection", json!({"generateMarkers": true, "createSubclips": true})).unwrap();
        let job = s.jobs.iter().find(|job| json!(job.id) == started["job"]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !job.progress.finished.load(Ordering::Relaxed) || job.result.lock().unwrap().is_none() {
            assert!(Instant::now() < deadline, "scene analysis did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(job.result.lock().unwrap().as_ref().unwrap().is_ok());
        assert_eq!(s.scene_jobs[0].results.lock().unwrap().as_ref().unwrap()[0].cuts.len(), 1);
        match change {
            "move" => {
                s.execute("timeline.move", json!({"moves": [{"clip": clip.0, "track": "V1", "time": FrameRate::FPS_24.tick_of(12).0}]})).unwrap();
            }
            "delete" => {
                s.execute("project.select", json!({"items": [sources[0].0]})).unwrap();
                s.execute("project.delete", json!({})).unwrap();
            }
            "relink" => {
                s.execute("media.relink", json!({"item": sources[0].0, "path": replacement.to_string_lossy(), "force": true, "relinkOthers": false})).unwrap();
            }
            _ => unreachable!(),
        }
        let before = kition_film_format::encode(&s.project, false);
        let history = s.history.undo.len();
        s.poll_persistence();
        if kition_film_format::encode(&s.project, false) != before || s.history.undo.len() != history {
            violations.push(format!("{change}: obsolete cuts/markers/subclips changed the project or history"));
        }
        assert!(s.scene_jobs.is_empty());
    }
    let _ = std::fs::remove_dir_all(root);
    assert!(violations.is_empty(), "{}", violations.join("; "));
}

#[test]
fn n28_scene_results_survive_unrelated_edits_and_active_sequence_switch() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let root = tmp_dir("scene-valid-inputs");
    let movie = root.join("two-shots.mov");
    make_cut_movie(&movie, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, original) = session_with(&[&movie]);
    select_v1(&mut s);
    let started = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    let job = s.jobs.iter().find(|job| json!(job.id) == started["job"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !job.progress.finished.load(Ordering::Relaxed) || job.result.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(job.result.lock().unwrap().as_ref().unwrap().is_ok());
    s.execute("timeline.setTrack", json!({"track": "V1", "name": "Renamed during analysis"})).unwrap();
    let other = s.execute("file.newSequence", json!({"name": "Another edit", "width": 64, "height": 36})).unwrap()["sequence"].as_u64().unwrap();
    let history = s.history.undo.len();
    s.poll_persistence();
    let track = &s.project.sequence(original).unwrap().video_tracks[0];
    assert_eq!(track.name, "Renamed during analysis");
    assert_eq!(
        track.items.iter().map(|clip| (clip.start, clip.duration)).collect::<Vec<_>>(),
        vec![(Tick::ZERO, FrameRate::FPS_24.tick_of(18)), (FrameRate::FPS_24.tick_of(18), FrameRate::FPS_24.tick_of(18))]
    );
    assert_eq!(s.state.active_sequence, Some(ItemId(other)));
    assert_eq!(s.history.undo.len(), history + 1);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.project.sequence(original).unwrap().video_tracks[0].items.len(), 1);
    assert_eq!(s.project.sequence(original).unwrap().video_tracks[0].name, "Renamed during analysis");
    assert!(s.project.sequence(ItemId(other)).is_some());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn detects_cuts_in_our_own_render_and_applies_cuts_markers_and_subclips() {
    let dir = tmp_dir("scene-own");
    let path = dir.join("cuts.mov");
    // Ocean Sunset 20 frames, City Night 16, Forest 14: cuts at frames 20 and 36
    make_cut_movie(&path, &[(DemoScene::OceanSunset, 20), (DemoScene::CityNight, 16), (DemoScene::Forest, 14)], 160, 90);
    let (mut s, items, _) = session_with(&[&path]);
    let rate = s.sequence_rate();
    assert!(!s.is_enabled("clip.sceneEditDetection"), "nothing selected");
    select_v1(&mut s);
    assert!(s.is_enabled("clip.sceneEditDetection"));
    let n_undo = s.history.undo.len();
    let r = s.execute("clip.sceneEditDetection", json!({"wait": true, "applyCuts": true, "generateMarkers": true, "createSubclips": true})).unwrap();
    assert_eq!(r["clips"][0]["cuts"], json!([rate.tick_of(20).0, rate.tick_of(36).0]), "{r}");
    assert_eq!(s.history.undo.len(), n_undo + 1, "one undo step");
    assert_eq!(s.history.undo.last().unwrap().0, "Scene Edit Detection");
    // cuts: V1 and the linked A1 are in three pieces
    let q = s.active_sequence().unwrap();
    let starts: Vec<Tick> = q.video_tracks[0].items.iter().map(|i| i.start).collect();
    assert_eq!(starts, vec![Tick::ZERO, rate.tick_of(20), rate.tick_of(36)]);
    q.check().unwrap();
    // markers on the master clip, in media time
    let m = s.project.item(items[0]).unwrap().as_media().unwrap();
    assert_eq!(m.markers.iter().map(|x| x.start).collect::<Vec<_>>(), vec![rate.tick_of(20), rate.tick_of(36)]);
    // one subclip per shot in a "<clip> Scenes" bin
    let subs: Vec<TimeRange> = s
        .project
        .items
        .values()
        .filter_map(|i| match &i.kind {
            ItemKind::Subclip { parent, range, .. } if *parent == items[0] => Some(*range),
            _ => None,
        })
        .collect();
    assert_eq!(
        subs,
        vec![
            TimeRange::new(Tick::ZERO, rate.tick_of(20)),
            TimeRange::new(rate.tick_of(20), rate.tick_of(16)),
            TimeRange::new(rate.tick_of(36), rate.tick_of(14))
        ]
    );
    assert!(s.project.root.children.iter().any(|c| matches!(c, kition_film_project::BinEntry::Bin(b) if b.name == "cuts.mov Scenes" && b.children.len() == 3)));
    // undo restores everything
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1);
    assert!(s.project.item(items[0]).unwrap().as_media().unwrap().markers.is_empty());
    assert!(!s.project.items.values().any(|i| matches!(i.kind, ItemKind::Subclip { .. })));
    // sensitivity 0 still finds these hard cuts; nothing chosen to do is an error
    select_v1(&mut s);
    let r = s.execute("clip.sceneEditDetection", json!({"wait": true, "applyCuts": false, "generateMarkers": true, "sensitivity": 0})).unwrap();
    assert_eq!(r["clips"][0]["cuts"].as_array().unwrap().len(), 2);
    assert!(s.execute("clip.sceneEditDetection", json!({"applyCuts": false})).is_err());
}

#[test]
fn background_job_reports_progress_and_cancel_changes_nothing() {
    let dir = tmp_dir("scene-job");
    let path = dir.join("job.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, _) = session_with(&[&path]);
    select_v1(&mut s);
    let r = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    let job = r["job"].as_u64().unwrap();
    let t0 = std::time::Instant::now();
    loop {
        s.poll_persistence();
        let j = s.execute("jobs.list", json!({})).unwrap();
        let j = j.as_array().unwrap().iter().find(|x| x["id"] == job).unwrap().clone();
        if j["finished"] == true && s.scene_jobs.is_empty() {
            assert_eq!(j["total"], 36);
            assert_eq!(j["done"], 36);
            break;
        }
        assert!(t0.elapsed().as_secs() < 120, "job never finished");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2, "cut applied when the job finished");
    // a cancelled job leaves the project alone
    s.execute("edit.undo", json!({})).unwrap();
    select_v1(&mut s);
    let rev = s.revision;
    let r = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    s.execute("jobs.cancel", json!({"job": r["job"]})).unwrap();
    let t0 = std::time::Instant::now();
    while !s.scene_jobs.is_empty() {
        s.poll_persistence();
        assert!(t0.elapsed().as_secs() < 120);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(s.revision, rev);
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1);
}

/// A background job's cuts are applied by `poll_persistence`, outside any command: they are
/// replicated as their own step there, so undoing the next, unrelated command keeps them (it used
/// to undo them too: they reached the replica only with that command's own diff).
#[test]
fn cuts_applied_in_the_background_survive_the_next_commands_undo() {
    let path = kition_film_testkit::fixtures_dir("engine/scene-kdm").join("job.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, _) = session_with(&[&path]);
    select_v1(&mut s);
    s.execute("sequence.addTracks", json!({})).unwrap();
    assert!(s.kdm().is_some(), "replica-backed");
    s.execute("clip.sceneEditDetection", json!({})).unwrap();
    let t0 = std::time::Instant::now();
    while !s.scene_jobs.is_empty() {
        s.poll_persistence();
        assert!(t0.elapsed().as_secs() < 120, "job never finished");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2, "cut applied");
    s.execute("timeline.setTrack", json!({"track": "V1", "name": "Zed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2, "the next command's undo keeps the cut");
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1, "its own undo takes it back");
}

fn ffmpeg_fixture() -> Option<PathBuf> {
    let ffmpeg = kition_film_testkit::oracle::ffmpeg_or_skip("scene_detect")?;
    let out = kition_film_testkit::fixtures_dir("engine/scene").join("three_shots.mp4");
    kition_film_testkit::fixtures::generate(&out, |tmp| {
        std::process::Command::new(&ffmpeg)
            .args(["-y", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i", "testsrc2=size=192x108:rate=24:duration=1"])
            .args(["-f", "lavfi", "-i", "smptebars=size=192x108:rate=24:duration=1.5"])
            .args(["-t", "1", "-f", "lavfi", "-i", "mandelbrot=size=192x108:rate=24"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.5"])
            .args(["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-map", "3:a"])
            .args(["-c:v", "libx264", "-preset", "fast", "-g", "30", "-c:a", "aac", "-shortest"])
            .arg(tmp)
            .status()
            .is_ok_and(|s| s.success())
    })
}

/// ffmpeg-made H.264 + AAC: testsrc2 (24 frames), SMPTE bars (36), Mandelbrot zoom (24). The cuts
/// are at frames 24 and 60; the moving test pattern and the zoom don't trigger.
#[test]
fn detects_the_cuts_of_an_ffmpeg_concat_and_cuts_linked_audio() {
    let Some(src) = ffmpeg_fixture() else { return };
    let dir = tmp_dir("scene-ff");
    let media = dir.join("three_shots.mp4");
    std::fs::copy(&src, &media).unwrap();
    let (mut s, _, _) = session_with(&[&media]);
    let rate = s.sequence_rate();
    assert_eq!(rate, FrameRate::FPS_24);
    // link the V1 / A1 pair, as an edit from the Source monitor would
    let mut p = (*s.project).clone();
    let seq = s.state.active_sequence.unwrap();
    let q = p.sequence_mut(seq).unwrap();
    q.video_tracks[0].items[0].link = Some(7777);
    q.audio_tracks[0].items[0].link = Some(7777);
    s.project = Arc::new(p);
    s.reset_kdm();
    select_v1(&mut s);
    for sensitivity in [20.0, 50.0, 80.0] {
        let r = s.execute("clip.sceneEditDetection", json!({"wait": true, "applyCuts": false, "generateMarkers": true, "sensitivity": sensitivity})).unwrap();
        assert_eq!(r["clips"][0]["cuts"], json!([rate.tick_of(24).0, rate.tick_of(60).0]), "sensitivity {sensitivity}: {r}");
        s.execute("edit.undo", json!({})).unwrap();
    }
    s.execute("clip.sceneEditDetection", json!({"wait": true})).unwrap();
    let q = s.active_sequence().unwrap();
    let v: Vec<Tick> = q.video_tracks[0].items.iter().map(|i| i.start).collect();
    let a: Vec<Tick> = q.audio_tracks[0].items.iter().map(|i| i.start).collect();
    assert_eq!(v, vec![Tick::ZERO, rate.tick_of(24), rate.tick_of(60)]);
    assert_eq!(a, v, "linked audio is cut too");
    // each piece keeps a link to its partner
    for (x, y) in q.video_tracks[0].items.iter().zip(&q.audio_tracks[0].items) {
        assert!(x.link.is_some() && x.link == y.link);
    }
}

/// A scratch session (a dialog's preview) analyses a frame at a time on its own thread-less job
/// list, as WebAssembly must (no threads): the command returns before any frame is read,
/// `pump_jobs` advances it with its progress, and the result is applied in one undo step on the
/// copy when it ends; a cancel mid-job changes nothing. The document's own run is untouched.
#[test]
fn a_scratch_sessions_detection_is_a_stepped_job_that_pump_jobs_advances() {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let dir = tmp_dir("scene-stepped");
    let path = dir.join("stepped.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, items, _) = session_with(&[&path]);
    select_v1(&mut s);
    let (revision, steps) = (s.revision, s.history.undo.len());
    let mut copy = s.scratch();
    let r = copy.execute("clip.sceneEditDetection", json!({"applyCuts": true, "generateMarkers": true})).unwrap();
    assert_eq!(r["frames"], 36, "{r}");
    assert_eq!(copy.stepped.len(), 1, "a stepped job, no thread");
    let progress = copy.jobs.iter().find(|j| j.id == r["job"].as_u64().unwrap()).unwrap().progress.clone();
    assert_eq!(progress.done.load(Ordering::Relaxed), 0, "the command reads no frame");
    // A budget of nothing still makes one step: one frame.
    assert!(copy.pump_jobs(Duration::ZERO));
    assert_eq!(progress.done.load(Ordering::Relaxed), 1);
    assert!(progress.status.lock().unwrap().contains("frame 1 of 36"));
    let mut seen = vec![progress.fraction()];
    let t0 = std::time::Instant::now();
    while !copy.stepped.is_empty() || !copy.scene_jobs.is_empty() {
        copy.pump_jobs(Duration::ZERO);
        copy.poll_persistence();
        seen.push(progress.fraction());
        assert!(t0.elapsed().as_secs() < 120, "job never finished");
    }
    assert!(seen.windows(2).all(|w| w[0] <= w[1]) && seen.len() >= 36, "{seen:?}");
    assert!(progress.finished.load(Ordering::Relaxed));
    let q = copy.active_sequence().unwrap();
    assert_eq!(q.video_tracks[0].items.len(), 2, "the cut is applied on the copy");
    assert_eq!(copy.project.item(items[0]).unwrap().as_media().unwrap().markers.len(), 1, "and its marker");
    assert_eq!(copy.history.undo.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), vec!["Scene Edit Detection"], "one step");
    // the document is untouched
    assert_eq!((s.revision, s.history.undo.len()), (revision, steps));
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1);
    assert!(s.jobs.is_empty() && s.stepped.is_empty());

    // a cancel mid-job: nothing changes on the copy
    let mut copy = s.scratch();
    let r = copy.execute("clip.sceneEditDetection", json!({})).unwrap();
    let progress = copy.jobs.iter().find(|j| j.id == r["job"].as_u64().unwrap()).unwrap().progress.clone();
    for _ in 0..5 {
        copy.pump_jobs(Duration::ZERO);
    }
    progress.cancel.store(true, Ordering::Relaxed);
    while !copy.stepped.is_empty() || !copy.scene_jobs.is_empty() {
        copy.pump_jobs(Duration::ZERO);
        copy.poll_persistence();
    }
    assert_eq!(progress.done.load(Ordering::Relaxed), 5, "it stops at the next step");
    assert_eq!(*progress.status.lock().unwrap(), "Stopped: nothing was changed");
    assert_eq!(copy.active_sequence().unwrap().video_tracks[0].items.len(), 1);
    assert!(copy.history.undo.is_empty());
}

/// The document's own Scene Edit Detection (a native session, not a copy) still runs on its
/// thread, and in one undo step when it waits.
#[test]
fn the_documents_detection_runs_on_its_thread_and_never_steps() {
    let dir = tmp_dir("scene-thread");
    let path = dir.join("thread.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, _) = session_with(&[&path]);
    select_v1(&mut s);
    s.execute("clip.sceneEditDetection", json!({})).unwrap();
    assert!(s.stepped.is_empty(), "a thread, not a stepped job");
    let t0 = std::time::Instant::now();
    while !s.scene_jobs.is_empty() {
        s.poll_persistence();
        assert!(t0.elapsed().as_secs() < 120, "job never finished");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2);
    s.execute("edit.undo", json!({})).unwrap();
    select_v1(&mut s);
    let steps = s.history.undo.len();
    s.execute("clip.sceneEditDetection", json!({"wait": true})).unwrap();
    assert!(s.stepped.is_empty());
    assert_eq!(s.history.undo.len(), steps + 1, "one undo step");
}

/// A document whose host has no threads (`Session::step_jobs`, which the WebAssembly binding sets)
/// steps its own Scene Edit Detection as upstream's thread runs it: the command returns at once,
/// `pump_jobs` reads the frames, and `poll_persistence` applies the cut in one "Scene Edit
/// Detection" history step that the replica records as its own (its version moves, and the next
/// command's undo keeps the cut). A cancel mid-job changes nothing.
#[test]
fn a_document_without_threads_steps_its_detection_and_replicates_the_one_step() {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let path = kition_film_testkit::fixtures_dir("engine/scene-stepped-doc").join("job.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 18), (DemoScene::Plasma, 18)], 128, 72);
    let (mut s, _, _) = session_with(&[&path]);
    s.step_jobs = true;
    select_v1(&mut s);
    s.execute("sequence.addTracks", json!({})).unwrap();
    let version = s.kdm().expect("replica-backed").version();
    let steps = s.history.undo.len();
    let r = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    assert_eq!(s.stepped.len(), 1, "a stepped job on the document");
    assert_eq!(s.history.undo.len(), steps, "nothing applied yet");
    let progress = s.jobs.iter().find(|j| j.id == r["job"].as_u64().unwrap()).unwrap().progress.clone();
    assert_eq!(progress.done.load(Ordering::Relaxed), 0);
    let t0 = std::time::Instant::now();
    while !s.stepped.is_empty() || !s.scene_jobs.is_empty() {
        s.pump_jobs(Duration::from_millis(1));
        s.poll_persistence();
        assert!(t0.elapsed().as_secs() < 120, "job never finished");
    }
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2, "the cut applied");
    assert_eq!(s.history.undo.len(), steps + 1);
    assert_eq!(s.history.undo.last().unwrap().0, "Scene Edit Detection");
    assert_ne!(s.kdm().unwrap().version(), version, "the replica records it");
    s.execute("timeline.setTrack", json!({"track": "V1", "name": "Zed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 2, "the next command's undo keeps the cut");
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1, "its own undo takes it back");

    // jobs.cancel mid-job: nothing changes.
    select_v1(&mut s);
    let revision = s.revision;
    let r = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    s.pump_jobs(Duration::ZERO);
    s.execute("jobs.cancel", json!({"job": r["job"]})).unwrap();
    while !s.stepped.is_empty() || !s.scene_jobs.is_empty() {
        s.pump_jobs(Duration::ZERO);
        s.poll_persistence();
    }
    assert_eq!(s.revision, revision);
    assert_eq!(s.active_sequence().unwrap().video_tracks[0].items.len(), 1);
}

/// A panic inside a stepped frame fails the job (upstream's `guard_job`), it does not unwind
/// through `pump_jobs`.
#[test]
fn a_panicking_step_fails_its_job() {
    use std::sync::atomic::Ordering;
    let dir = tmp_dir("scene-panic");
    let path = dir.join("panic.mov");
    make_cut_movie(&path, &[(DemoScene::Dunes, 6)], 64, 36);
    let (mut s, _, _) = session_with(&[&path]);
    s.step_jobs = true;
    select_v1(&mut s);
    let r = s.execute("clip.sceneEditDetection", json!({})).unwrap();
    let job = s.jobs.iter().find(|j| j.id == r["job"].as_u64().unwrap()).unwrap().clone();
    if let Some(crate::SteppedJob { work: crate::SteppedWork::Scene(steps), .. }) = s.stepped.first_mut() {
        steps.poison_for_test();
    }
    s.pump_jobs(std::time::Duration::ZERO);
    s.poll_persistence();
    assert!(s.stepped.is_empty() && s.scene_jobs.is_empty());
    assert!(job.progress.finished.load(Ordering::Relaxed));
    assert!(matches!(&*job.result.lock().unwrap(), Some(Err(e)) if e.contains("internal error")), "{:?}", job.result.lock().unwrap());
}
