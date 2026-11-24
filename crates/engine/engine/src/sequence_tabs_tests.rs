//! The Timeline's sequence tabs: closing the others, reordering, and what the person's view state
//! keeps of them (the open tabs in order, the active one, and each sequence's zoom, scroll and
//! track heights; never the project file). Premiere's behaviour was observed in Premiere Pro 26.5.2.

use super::*;
use kition_film_project::SequenceView;
use serde_json::json;

/// The demo project with two more sequences open: tabs [main, b, c], `c` active.
fn three_tabs() -> (Session, [ItemId; 3]) {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    let main = s.state.active_sequence.unwrap();
    let mut new = |name: &str| ItemId(s.execute("file.newSequence", json!({"name": name})).unwrap()["sequence"].as_u64().unwrap());
    let (b, c) = (new("B"), new("C"));
    assert_eq!(s.state.open_sequences, [main, b, c]);
    assert_eq!(s.state.active_sequence, Some(c));
    (s, [main, b, c])
}

fn view(pps: f64, scroll: f64) -> SequenceView {
    SequenceView { pps, scroll, v_scroll: 12.0, a_scroll: 7.0, video_track_h: 90.0, audio_track_h: 40.0 }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kition-film-tabs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn close_others_keeps_one_tab_and_shows_it() {
    let (mut s, [main, b, c]) = three_tabs();
    // from the active tab
    assert_eq!(s.execute("sequence.closeOthers", json!({})).unwrap()["closed"], json!(2));
    assert_eq!((s.state.open_sequences.clone(), s.state.active_sequence), (vec![c], Some(c)));
    // from another tab: that one becomes the active one
    let (mut s, _) = three_tabs();
    s.drain_events();
    s.execute("sequence.closeOthers", json!({"item": b.0})).unwrap();
    assert_eq!((s.state.open_sequences.clone(), s.state.active_sequence), (vec![b], Some(b)));
    assert!(s.drain_events().contains(&Event::OpenSequence(b)));
    // a sequence that is not open cannot be the one to keep
    s.execute("sequence.close", json!({})).unwrap();
    assert!(s.execute("sequence.closeOthers", json!({"item": main.0})).is_err());
}

#[test]
fn a_tab_moves_to_another_place_among_the_tabs() {
    let (mut s, [main, b, c]) = three_tabs();
    let (revision, steps) = (s.revision, s.history.undo.len());
    s.execute("sequence.moveTab", json!({"item": c.0, "index": 0})).unwrap();
    assert_eq!(s.state.open_sequences, [c, main, b]);
    assert_eq!(s.state.active_sequence, Some(c), "moving a tab does not change which is shown");
    s.execute("sequence.moveTab", json!({"item": c.0, "index": 1})).unwrap();
    assert_eq!(s.state.open_sequences, [main, c, b]);
    // past the end is the end; the active tab is the default
    assert_eq!(s.execute("sequence.moveTab", json!({"index": u64::MAX})).unwrap()["index"], json!(2));
    assert_eq!(s.state.open_sequences, [main, b, c]);
    // not an undo step, not an edit
    assert_eq!((s.revision, s.history.undo.len()), (revision, steps));
    s.execute("sequence.close", json!({"item": b.0})).unwrap();
    assert!(s.execute("sequence.moveTab", json!({"item": b.0, "index": 0})).is_err());
    assert!(s.execute("sequence.moveTab", json!({"item": c.0})).is_err());
}

/// A project file keeps no view: it reopens on its first sequence. What was open (the tabs in
/// order, the active one, each sequence's zoom and scroll) is the person's view state, which
/// `restore_project_view` puts back.
#[test]
fn a_saved_project_reopens_with_its_tabs_and_their_views_from_the_view_state() {
    let (mut s, [main, b, c]) = three_tabs();
    s.execute("sequence.moveTab", json!({"item": c.0, "index": 0})).unwrap();
    s.execute("sequence.open", json!({"item": b.0})).unwrap();
    s.state.timeline_views.insert(main, view(12.5, 3.0));
    s.state.timeline_views.insert(b, view(400.0, 0.25));
    let dir = temp_dir("reopen");
    let path = dir.join("tabs.kfilm").to_string_lossy().to_string();
    s.execute("file.saveAs", json!({"path": path})).unwrap();
    let kept = s.project_view();

    let mut t = Session::default();
    t.execute("file.open", json!({"path": path})).unwrap();
    assert_eq!((t.state.open_sequences.clone(), t.state.active_sequence), (vec![main], Some(main)), "the file keeps no view");
    assert!(t.state.timeline_views.is_empty());
    t.restore_project_view(kept.clone());
    assert_eq!(t.state.open_sequences, [c, main, b]);
    assert_eq!(t.state.active_sequence, Some(b));
    assert_eq!(t.state.timeline_views.get(&main), Some(&view(12.5, 3.0)));
    assert_eq!(t.state.timeline_views.get(&b), Some(&view(400.0, 0.25)));
    assert_eq!(t.state.timeline_views.get(&c), None, "a sequence that was never shown has no view");
    assert!(!t.is_dirty());

    // a view with every tab closed (or of a session that never showed a sequence): the project
    // stays on its first sequence, not on an empty Timeline, and still knows the views
    s.execute("sequence.closeOthers", json!({})).unwrap();
    s.execute("sequence.close", json!({})).unwrap();
    let mut w = Session::default();
    w.execute("file.open", json!({"path": path})).unwrap();
    w.restore_project_view(s.project_view());
    assert_eq!((w.state.open_sequences.clone(), w.state.active_sequence), (vec![main], Some(main)));
    assert_eq!(w.state.timeline_views.get(&b), Some(&view(400.0, 0.25)));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A view state is not trusted: ids of things that are not sequences, repeats and numbers out of
/// range are dropped or brought into range.
#[test]
fn a_damaged_view_state_is_cleaned_up() {
    let (s, [main, b, c]) = three_tabs();
    let footage = s.project.sequence(main).unwrap().video_tracks[0].items[0].item;
    let view: kition_film_project::ProjectView = serde_json::from_value(json!({
        "open_sequences": [c.0, 999_999, footage.0, c.0, b.0],
        "active_sequence": 999_999,
        "sequences": {
            b.0.to_string(): {"pps": 1e300, "scroll": -5.0, "v_scroll": 1e30, "a_scroll": -1.0, "video_track_h": 0.0, "audio_track_h": 1e9},
            "999999": {"pps": 40.0, "scroll": 0.0, "video_track_h": 60.0, "audio_track_h": 56.0},
            footage.0.to_string(): {"pps": 40.0, "scroll": 0.0, "video_track_h": 60.0, "audio_track_h": 56.0},
        },
    }))
    .unwrap();
    let mut t = s;
    t.restore_project_view(view);
    assert_eq!(t.state.open_sequences, [c, b]);
    assert_eq!(t.state.active_sequence, Some(c), "an active tab that is not open: the first tab");
    assert_eq!(t.state.timeline_views.len(), 1);
    let v = t.state.timeline_views[&b];
    assert!(v.pps <= 1e5 && v.scroll == 0.0 && v.v_scroll <= 1e6 && v.a_scroll == 0.0);
    assert!(v.video_track_h >= 8.0 && v.audio_track_h <= 600.0);
}

#[test]
fn the_view_of_a_deleted_sequence_is_forgotten() {
    let (mut s, [main, b, c]) = three_tabs();
    for id in [main, b, c] {
        s.state.timeline_views.insert(id, view(40.0, 0.0));
    }
    s.execute("project.delete", json!({"items": [b.0]})).unwrap();
    assert_eq!(s.state.timeline_views.keys().copied().collect::<Vec<_>>(), [main, c]);
    assert_eq!(s.state.open_sequences, [main, c]);
    // the view state never names it either
    assert_eq!(s.project_view().open_sequences, [main, c]);
}

#[test]
fn n31_history_restores_a_sequence_to_an_empty_timeline_without_reopening_closed_tabs() {
    let mut s = Session::default();
    s.execute("file.newProject", json!({"name": "History tabs"})).unwrap();
    let id = ItemId(s.execute("file.newSequence", json!({"name": "First"})).unwrap()["sequence"].as_u64().unwrap());
    s.execute("edit.undo", json!({})).unwrap();
    assert!(s.state.active_sequence.is_none());
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(s.state.active_sequence, Some(id));
    assert_eq!(s.state.open_sequences, [id]);
    s.execute("project.delete", json!({"items": [id.0]})).unwrap();
    assert!(s.state.active_sequence.is_none());
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.state.active_sequence, Some(id));
    assert_eq!(s.state.open_sequences, [id]);
    s.execute("sequence.close", json!({"item": id.0})).unwrap();
    s.execute("clip.rename", json!({"item": id.0, "name": "Renamed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    s.execute("edit.redo", json!({})).unwrap();
    assert!(s.state.active_sequence.is_none(), "an ordinary history edit must respect a deliberately closed tab");
    assert!(s.state.open_sequences.is_empty());
}
