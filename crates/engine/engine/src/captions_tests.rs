use serde_json::json;

use crate::Session;
use kition_film_project::ClipId;
use kition_film_time::{TICKS_PER_SECOND, Tick};

fn demo() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

#[test]
fn captions_import_edit_export_and_burn_in() {
    let dir = std::env::temp_dir().join(format!("fc-cap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let srt = dir.join("talk.srt");
    std::fs::write(
        &srt,
        "\u{feff}1\r\n00:00:00,500 --> 00:00:02,000\r\nHello there\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,000\r\nSecond line\r\nwith two rows\r\n",
    )
    .unwrap();
    let mut s = demo();
    let r = s.execute("file.import", json!({"paths": [srt.to_string_lossy()]})).unwrap();
    assert_eq!(r["documents"][0]["captions"], 2, "{r}");
    let q = s.active_sequence().unwrap();
    let rate = q.settings.frame_rate;
    let tr = q.caption_tracks[0].clone();
    assert_eq!(tr.name, "talk");
    assert_eq!(tr.captions[0].start, rate.snap_nearest(Tick(TICKS_PER_SECOND / 2)), "snapped to frames");
    let first = tr.captions[0].id;
    let second = tr.captions[1].id;

    // edit text, split, merge, trim, move, add at playhead, delete — each one undoable
    s.execute("captions.setText", json!({"caption": first.0, "text": "Hi!", "speaker": "Ann"})).unwrap();
    let split_at = rate.tick_of(rate.frame_at(tr.captions[1].start) + 10);
    let r = s.execute("captions.split", json!({"caption": second.0, "time": split_at.0})).unwrap();
    let right = ClipId(r["captions"][0].as_u64().unwrap());
    assert_eq!(s.active_sequence().unwrap().caption_tracks[0].captions.len(), 3);
    s.execute("captions.merge", json!({"captions": [second.0, right.0]})).unwrap();
    assert_eq!(s.active_sequence().unwrap().caption_tracks[0].captions.len(), 2);
    s.execute("captions.trim", json!({"caption": second.0, "edge": "out", "deltaFrames": 12})).unwrap();
    s.execute("captions.move", json!({"captions": [second.0], "deltaFrames": 24})).unwrap();
    s.execute("playhead.set", json!({"seconds": 8.0})).unwrap();
    let r = s.execute("captions.add", json!({"text": "Added"})).unwrap();
    let added = ClipId(r["caption"].as_u64().unwrap());
    assert_eq!(s.state.caption_selection, vec![added]);
    s.execute("edit.clear", json!({})).unwrap();
    assert!(s.active_sequence().unwrap().find_caption(added).is_none(), "Clear deletes selected captions");
    s.execute("edit.undo", json!({})).unwrap();
    assert!(s.active_sequence().unwrap().find_caption(added).is_some());
    let list = s.execute("captions.list", json!({})).unwrap();
    assert_eq!(list["tracks"][0]["captions"][0]["text"], "Hi!");
    assert_eq!(list["tracks"][0]["captions"][0]["speaker"], "Ann");
    s.active_sequence().unwrap().check().unwrap();

    // export in all three formats and read back: same texts
    for ext in ["srt", "vtt", "scc"] {
        let path = dir.join(format!("out.{ext}")).to_string_lossy().to_string();
        let r = s.execute("captions.export", json!({"path": path})).unwrap();
        assert_eq!(r["captions"], 3, "{ext}: {r}");
        let back = kition_film_captions::parse(&std::fs::read(&path).unwrap(), kition_film_captions::Format::from_name(ext).unwrap()).unwrap();
        let texts: Vec<String> = back.cues.iter().map(|c| kition_film_project::plain_text(&c.text)).collect();
        assert_eq!(texts.len(), 3, "{ext}");
        assert_eq!(texts[0], "Hi!", "{ext}");
    }

    // the program renders captions; hiding the track removes them
    s.execute("playhead.set", json!({"seconds": 1.0})).unwrap();
    let with = s.render_program(0.25).unwrap();
    s.execute("captions.hideAll", json!({})).unwrap();
    let without = s.render_program(0.25).unwrap();
    let diff = with.px.iter().zip(&without.px).filter(|(a, b)| (*a - *b).abs() > 0.05).count();
    assert!(diff > 200, "captions change the picture ({diff} samples)");
    let half = with.w * 4 * (with.h / 2);
    let top_diff = with.px[..half].iter().zip(&without.px[..half]).filter(|(a, b)| (*a - *b).abs() > 0.05).count();
    assert_eq!(top_diff, 0, "bottom-anchored captions stay in the lower half");
    s.execute("captions.showAll", json!({})).unwrap();
    let plan = kition_film_render::plan::plan_frame(
        &s.project,
        s.state.active_sequence.unwrap(),
        s.playhead(),
        kition_film_render::RenderOptions { scale: 0.25, captions: true, ..Default::default() },
        &s.media.provider(s.project.clone(), s.services.clone()),
    );
    let cpu = kition_film_render::plan::execute_cpu(&plan);
    let pd = cpu.px.iter().zip(&with.px).filter(|(a, b)| (*a - *b).abs() > 0.02).count();
    assert!(pd < cpu.px.len() / 200, "the GPU plan matches the CPU render ({pd})");

    // save/open keeps caption tracks
    let proj = dir.join("cap.kfilm").to_string_lossy().to_string();
    s.execute("file.saveAs", json!({"path": proj})).unwrap();
    let before = s.active_sequence().unwrap().caption_tracks.clone();
    s.execute("file.open", json!({"path": proj})).unwrap();
    assert_eq!(s.active_sequence().unwrap().caption_tracks, before);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn caption_track_follows_sync_locked_insert() {
    let mut s = demo();
    s.execute("captions.newTrack", json!({"format": "CEA-608"})).unwrap();
    s.execute("playhead.set", json!({"seconds": 4.0})).unwrap();
    s.execute("captions.add", json!({"text": "later"})).unwrap();
    let start = s.active_sequence().unwrap().caption_tracks[0].captions[0].start;
    let item = s.project.items.values().find(|i| i.as_media().is_some_and(|m| m.info.has_video())).unwrap().id;
    s.execute("source.open", json!({"item": item.0})).unwrap();
    s.execute("playhead.set", json!({"seconds": 0.0})).unwrap();
    s.execute("source.insert", json!({})).unwrap();
    let after = s.active_sequence().unwrap().caption_tracks[0].captions[0].start;
    assert!(after > start, "caption moved right with the insert");
    s.active_sequence().unwrap().check().unwrap();
}

#[test]
fn caption_commands_need_tracks_and_navigate() {
    let mut s = demo();
    assert!(s.execute("captions.split", json!({})).is_err(), "disabled without captions");
    for (sec, text) in [(1.0, "one"), (3.0, "two"), (6.0, "three")] {
        s.execute("playhead.set", json!({"seconds": sec})).unwrap();
        s.execute("captions.add", json!({"text": text, "durationSeconds": 1.0})).unwrap();
    }
    s.execute("playhead.set", json!({"seconds": 0.0})).unwrap();
    s.execute("captions.next", json!({})).unwrap();
    s.execute("captions.next", json!({})).unwrap();
    let id = s.state.caption_selection[0];
    assert_eq!(s.active_sequence().unwrap().find_caption(id).unwrap().1.text, "two");
    s.execute("captions.previous", json!({})).unwrap();
    let id = s.state.caption_selection[0];
    assert_eq!(s.active_sequence().unwrap().find_caption(id).unwrap().1.text, "one");
    s.execute("captions.setStyle", json!({"color": "#ffff00", "anchor": "top", "size": 40})).unwrap();
    let st = &s.active_sequence().unwrap().caption_tracks[0].style;
    assert_eq!(st.color, [255, 255, 0, 255]);
    assert!(s.execute("captions.setStyle", json!({"anchor": "sideways"})).is_err());
    s.execute("captions.setTimes", json!({"caption": id.0, "startSeconds": 0.5, "endSeconds": 2.5})).unwrap();
    assert!(s.execute("captions.setTimes", json!({"caption": id.0, "endSeconds": 3.5})).is_err(), "would overlap `two`");
    s.execute("captions.deleteTrack", json!({"track": "C1"})).unwrap();
    assert!(s.active_sequence().unwrap().caption_tracks.is_empty());
}

#[test]
fn n29_importing_captions_into_an_empty_project_is_one_complete_undo_step() {
    let root = crate::media_test_util::tmp_dir("caption-first-import");
    let source = root.join("dialogue.srt");
    let output = root.join("roundtrip.srt");
    std::fs::write(&source, "1\n00:00:00,000 --> 00:00:01,001\n你好，世界\nSecond line & more\n\n2\n00:00:02,002 --> 00:00:03,003\n終わり — café\n").unwrap();
    let mut s = Session::default();
    s.execute("file.newProject", json!({"name": "Empty caption project"})).unwrap();
    let before = kition_film_format::encode(&s.project, false);
    let history = s.history.undo.len();
    let imported = s.execute("captions.import", json!({"path": source.to_string_lossy()})).unwrap();
    assert_eq!(imported["captions"], 2);
    let tracks = s.execute("captions.list", json!({})).unwrap()["tracks"].clone();
    assert_eq!(tracks[0]["captions"][0]["text"], "你好，世界\nSecond line & more");
    assert_eq!(s.history.undo.len(), history + 1, "the automatic sequence belongs to the import transaction");
    s.execute("captions.export", json!({"path": output.to_string_lossy(), "format": "srt"})).unwrap();
    let exported = std::fs::read_to_string(&output).unwrap();
    assert!(exported.contains("00:00:00,000 --> 00:00:01,001"), "{exported}");
    assert!(exported.contains("你好，世界\nSecond line & more"), "{exported}");
    assert!(exported.contains("終わり — café"), "{exported}");
    s.execute("edit.undo", json!({})).unwrap();
    assert!(s.project.items.is_empty(), "one undo must also remove the automatic empty sequence");
    assert!(s.state.active_sequence.is_none());
    let mut restored: serde_json::Value = serde_json::from_slice(&kition_film_format::encode(&s.project, false)).unwrap();
    let mut expected: serde_json::Value = serde_json::from_slice(&before).unwrap();
    restored["project"].as_object_mut().unwrap().remove("next_id");
    expected["project"].as_object_mut().unwrap().remove("next_id");
    assert_eq!(restored, expected);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(s.execute("captions.list", json!({})).unwrap()["tracks"], tracks);
    let project = root.join("saved.kfilm");
    s.execute("file.saveAs", json!({"path": project.to_string_lossy()})).unwrap();
    let mut reopened = Session::default();
    reopened.execute("file.open", json!({"path": project.to_string_lossy()})).unwrap();
    assert_eq!(reopened.execute("captions.list", json!({})).unwrap()["tracks"], tracks);
    let _ = std::fs::remove_dir_all(root);
}

/// A new caption track goes after the existing ones, so C1 stays C1; and a caption's In
/// and Out given in seconds both land on the nearest frame.
#[test]
fn new_caption_track_keeps_labels_and_times_snap_to_frames() {
    let mut s = Session::default();
    s.execute("file.newSequence", json!({"name": "Subs", "fps": 24, "width": 320, "height": 180, "video": 1, "audio": 1})).unwrap();
    let en = s.execute("captions.newTrack", json!({"name": "English"})).unwrap()["track"].as_u64().unwrap();
    let r = s.execute("captions.newTrack", json!({"name": "French", "language": "fr"})).unwrap();
    let fr = r["track"].as_u64().unwrap();
    assert_eq!(r["label"], "C2", "{r}");
    let list = s.execute("captions.list", json!({})).unwrap();
    assert_eq!(list["tracks"][0]["id"], en, "C1 is still English: {list}");
    assert_eq!(list["tracks"][0]["label"], "C1");
    assert_eq!(list["tracks"][1]["id"], fr);
    assert_eq!(list["tracks"][1]["label"], "C2");
    // In 3.4 s (frame 81.6: frame 81 shows it) and Out 5.4 s (frame 129.6: frame 129), both
    // snapped the same way (the In used to be floored and the duration rounded)
    let r = s.execute("captions.add", json!({"track": "C1", "seconds": 3.4, "durationSeconds": 2.0, "text": "Bonjour"})).unwrap();
    let id = ClipId(r["caption"].as_u64().unwrap());
    let rate = s.sequence_rate();
    let c = s.active_sequence().unwrap().find_caption(id).unwrap().1.clone();
    assert_eq!(c.start, rate.tick_of(81));
    assert_eq!(c.end(), rate.tick_of(129));
    assert_eq!(s.active_sequence().unwrap().caption_tracks[0].id.0, en, "the caption went to C1 (English)");
}
