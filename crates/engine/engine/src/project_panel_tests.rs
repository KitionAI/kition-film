//! Tests of the Project panel commands (`project_panel`): view settings, Metadata Display columns,
//! sorting, view presets, Freeform positions / stacks / arrangements (undoable, saved with the
//! project) and bin renames.

use kition_film_project::{ItemId, ItemKind};
use kition_film_time::TICKS_PER_SECOND;
use serde_json::{Value, json};

use crate::Session;
use crate::project_panel::{self, FREEFORM_POS, FREEFORM_STACK, FontSize, ViewMode};

fn demo() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

fn media(s: &Session) -> Vec<ItemId> {
    let mut v: Vec<ItemId> = s.project.items.values().filter(|i| i.as_media().is_some()).map(|i| i.id).collect();
    v.sort();
    // the items of the first media item's bin (the demo's Footage bin)
    let bin = s.project.root.parent_of(v[0]);
    v.retain(|i| s.project.root.parent_of(*i) == bin);
    v
}

fn bin_of(s: &Session, i: ItemId) -> u64 {
    s.project.root.parent_of(i).unwrap().0
}

fn names(rows: &Value) -> Vec<String> {
    rows["rows"].as_array().unwrap().iter().filter(|r| r.get("item").is_some()).map(|r| r["name"].as_str().unwrap().to_string()).collect()
}

#[test]
fn n35_subclip_project_rows_report_their_actual_parent_streams_and_metadata() {
    let mut s = demo();
    s.execute("sequence.new", json!({"width": 64, "height": 36, "fps": 60})).unwrap();
    let audio = s.project.items.values().find(|i| !i.has_video() && i.has_audio()).unwrap().id;
    let av = s.project.items.values().find(|i| i.has_video() && i.has_audio() && i.as_media().is_some()).unwrap().id;
    let video = ItemId(s.execute("item.newColorMatte", json!({"width": 64, "height": 36, "seconds": 2})).unwrap()["item"].as_u64().unwrap());
    for (parent, has_video, has_audio) in [(audio, false, true), (av, true, true), (video, true, false)] {
        let item = s.execute("clip.makeSubclip", json!({"item": parent.0, "start": TICKS_PER_SECOND / 2, "end": TICKS_PER_SECOND})).unwrap()["item"].clone();
        let rows = s.execute("project.items", json!({"recursive": true})).unwrap();
        let row = rows["rows"].as_array().unwrap().iter().find(|row| row["item"] == item).unwrap();
        let original = rows["rows"].as_array().unwrap().iter().find(|row| row["item"] == parent.0).unwrap();
        assert_eq!(row["hasVideo"], has_video);
        assert_eq!(row["hasAudio"], has_audio);
        assert_eq!(row["info"]["audioInfo"], original["info"]["audioInfo"]);
        assert_eq!(row["info"]["videoInfo"], original["info"]["videoInfo"]);
        assert_eq!(row["info"]["frameRate"], original["info"]["frameRate"]);
        assert_eq!(row["frame"], original["frame"]);
        s.execute("source.open", json!({"item": item})).unwrap();
        let source = s.execute("source.inspect", json!({})).unwrap();
        assert_eq!((source["hasVideo"].clone(), source["hasAudio"].clone()), (json!(has_video), json!(has_audio)));
    }
}

#[test]
fn view_settings_are_preferences() {
    let mut s = demo();
    assert_eq!(s.prefs.project_panel.view.mode, ViewMode::Icon);
    let r = s.execute("project.view.set", json!({"view": "list", "fontSize": "large", "previewArea": true, "iconSize": 1000, "hoverScrub": false})).unwrap();
    assert_eq!(r["view"]["mode"], "list");
    let pp = &s.prefs.project_panel;
    assert_eq!(pp.view.mode, ViewMode::List);
    assert_eq!(pp.view.font_size, FontSize::Large);
    assert!(pp.preview_area && !pp.hover_scrub);
    assert_eq!(pp.view.icon_size, 400.0, "clamped");
    assert!(s.execute("project.view.set", json!({"view": "grid"})).is_err());
    // round-trips through the preferences file format
    let text = serde_json::to_string(&s.prefs).unwrap();
    let back: crate::autosave::Preferences = serde_json::from_str(&text).unwrap();
    assert_eq!(back.project_panel, s.prefs.project_panel);
    // older preference files (no projectPanel key) load with the defaults
    let mut v: Value = serde_json::from_str(&text).unwrap();
    v.as_object_mut().unwrap().remove("projectPanel");
    let old: crate::autosave::Preferences = serde_json::from_value(v).unwrap();
    assert_eq!(old.project_panel, project_panel::ProjectPanelPrefs::default());
}

#[test]
fn metadata_display_chooses_and_orders_columns() {
    let mut s = demo();
    let ids = media(&s);
    s.execute("metadata.set", json!({"item": ids[0].0, "field": "Mood", "value": "calm"})).unwrap();
    let l = s.execute("project.columns.list", json!({})).unwrap();
    let avail: Vec<&str> = l["available"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    for c in ["Name", "Label", "Media Duration", "Video Usage", "Mood"] {
        assert!(avail.contains(&c), "{c} missing from {avail:?}");
    }
    // Freeform bookkeeping keys are not offered
    s.execute("project.freeform.move", json!({"items": [ids[0].0], "x": 40, "y": 40})).unwrap();
    let l = s.execute("project.columns.list", json!({})).unwrap();
    assert!(!l["available"].as_array().unwrap().iter().any(|c| c["name"] == FREEFORM_POS));

    // Name stays first; unknown-case names are canonicalised; widths are kept
    s.execute("project.columns.set", json!({"columns": ["media duration", {"name": "Mood", "width": 90}, "Label"]})).unwrap();
    let cols: Vec<String> = s.prefs.project_panel.view.columns.iter().map(|c| c.name.clone()).collect();
    assert_eq!(cols, ["Name", "Media Duration", "Mood", "Label"]);
    assert_eq!(s.prefs.project_panel.view.columns[2].width, 90.0);
    s.execute("project.columns.resize", json!({"column": "Label", "width": 140})).unwrap();
    assert_eq!(s.prefs.project_panel.view.columns[3].width, 140.0);
    assert!(s.execute("project.columns.resize", json!({"column": "Frame Rate", "width": 140})).is_err(), "not shown");

    // the rows carry the shown columns' text
    let rows = s.execute("project.items", json!({"bin": bin_of(&s, ids[0])})).unwrap();
    let row = rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(ids[0].0)).unwrap();
    assert_eq!(row["cells"]["Mood"], "calm");
    assert!(row["cells"]["Media Duration"].as_str().unwrap().contains(':'));
}

#[test]
fn sorting_by_a_column_and_reversing() {
    let mut s = demo();
    let bin = bin_of(&s, media(&s)[0]);
    let by_name = names(&s.execute("project.items", json!({"bin": bin})).unwrap());
    let mut sorted = by_name.clone();
    sorted.sort_by_key(|n| n.to_lowercase());
    assert!(by_name.len() > 2);
    assert_eq!(by_name, sorted, "Name ascending by default");
    // the same column again reverses
    s.execute("project.sort", json!({"column": "name"})).unwrap();
    assert!(s.prefs.project_panel.view.sort.descending);
    let rev = names(&s.execute("project.items", json!({"bin": bin})).unwrap());
    assert_eq!(rev, sorted.iter().rev().cloned().collect::<Vec<_>>());
    // durations sort numerically, not as text
    s.execute("project.sort", json!({"column": "Media Duration", "descending": false})).unwrap();
    let rows = s.execute("project.items", json!({"bin": bin})).unwrap();
    let durs: Vec<i64> =
        rows["rows"].as_array().unwrap().iter().filter_map(|r| r["item"].as_u64()).map(|i| s.project.item(ItemId(i)).unwrap().duration().0).collect();
    assert!(durs.windows(2).all(|w| w[0] <= w[1]), "{durs:?}");
    assert!(s.execute("project.sort", json!({"column": "Nope"})).is_err());
}

#[test]
fn view_presets_save_restore_and_manage() {
    let mut s = demo();
    assert!(s.execute("project.viewPreset.save", json!({})).is_err(), "no current preset yet");
    assert!(s.execute("project.viewPreset.restore", json!({"slot": 1})).is_err(), "none saved");
    s.execute("project.view.set", json!({"view": "list"})).unwrap();
    s.execute("project.columns.set", json!({"columns": ["Name", "Label"]})).unwrap();
    let r = s.execute("project.viewPreset.saveAs", json!({"name": "Logging"})).unwrap();
    assert_eq!(r["current"], 1);
    assert_eq!(r["presets"][0]["name"], "Logging");
    // change the view, then restore preset 1
    s.execute("project.view.set", json!({"view": "freeform"})).unwrap();
    s.execute("project.columns.set", json!({"columns": ["Name", "Frame Rate", "Video Info"]})).unwrap();
    s.execute("project.viewPreset.saveAs", json!({})).unwrap();
    assert_eq!(s.prefs.project_panel.presets[1].as_ref().unwrap().name, "Project View Preset 2");
    s.execute("project.viewPreset.restore", json!({"slot": 1})).unwrap();
    assert_eq!(s.prefs.project_panel.view.mode, ViewMode::List);
    assert_eq!(s.prefs.project_panel.view.columns.len(), 2);
    // Save Current View Preset overwrites the current slot
    s.execute("project.view.set", json!({"fontSize": "small"})).unwrap();
    s.execute("project.viewPreset.save", json!({})).unwrap();
    assert_eq!(s.prefs.project_panel.presets[0].as_ref().unwrap().settings.font_size, FontSize::Small);
    assert_eq!(s.prefs.project_panel.presets[0].as_ref().unwrap().name, "Logging");
    // Manage: rename and delete
    s.execute("project.viewPreset.rename", json!({"slot": 2, "name": "Grid"})).unwrap();
    assert_eq!(s.prefs.project_panel.presets[1].as_ref().unwrap().name, "Grid");
    s.execute("project.viewPreset.delete", json!({"slot": 1})).unwrap();
    assert!(s.prefs.project_panel.presets[0].is_none());
    assert_eq!(s.prefs.project_panel.current_preset, None);
    assert!(s.execute("project.viewPreset.restore", json!({"slot": 11})).is_err());
    // slots fill up
    for _ in 0..9 {
        s.execute("project.viewPreset.saveAs", json!({})).unwrap();
    }
    assert!(s.execute("project.viewPreset.saveAs", json!({})).is_err(), "all ten used");
}

#[test]
fn view_presets_persist_in_the_preferences_file() {
    let dir = std::env::temp_dir().join(format!("fc-viewpresets-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("preferences.json");
    let mut s = demo();
    s.prefs_path = Some(path.clone());
    s.execute("project.columns.set", json!({"columns": ["Name", "Scene", "Shot"]})).unwrap();
    s.execute("project.viewPreset.saveAs", json!({"name": "Scenes"})).unwrap();
    let loaded = crate::autosave::Preferences::load(&path);
    assert_eq!(loaded.project_panel.presets[0].as_ref().unwrap().name, "Scenes");
    assert_eq!(loaded.project_panel.view.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Name", "Scene", "Shot"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn freeform_positions_are_undoable_and_saved_with_the_project() {
    let mut s = demo();
    let ids = media(&s);
    let bin = bin_of(&s, ids[0]);
    let lay = s.execute("project.freeform.layout", json!({"bin": bin, "width": 600})).unwrap();
    let cards = lay["cards"].as_array().unwrap();
    assert!(cards.len() >= ids.len());
    assert!(cards.iter().all(|c| c["placed"] == false), "nothing placed yet: auto grid");
    // moving two cards keeps their offsets
    let a = cards.iter().find(|c| c["item"] == json!(ids[0].0)).unwrap().clone();
    let b = cards.iter().find(|c| c["item"] == json!(ids[1].0)).unwrap().clone();
    let dx = b["x"].as_f64().unwrap() - a["x"].as_f64().unwrap();
    s.execute("project.freeform.move", json!({"items": [ids[0].0, ids[1].0], "x": 300, "y": 200, "width": 600})).unwrap();
    let pos = |s: &Session, i: ItemId| project_panel::parse_pos(s.project.item(i).unwrap().metadata.get(FREEFORM_POS).unwrap()).unwrap();
    assert_eq!((pos(&s, ids[0]).0, pos(&s, ids[0]).1), (300.0, 200.0));
    assert_eq!(pos(&s, ids[1]).0, (300.0 + dx as f32).round());
    // placed cards come first; the rest go on the grid below them
    let lay = s.execute("project.freeform.layout", json!({"bin": bin, "width": 600})).unwrap();
    let unplaced: Vec<&Value> = lay["cards"].as_array().unwrap().iter().filter(|c| c["placed"] == false).collect();
    assert!(unplaced.iter().all(|c| c["y"].as_f64().unwrap() > 200.0));
    // undo puts the card back on the grid
    s.execute("edit.undo", json!({})).unwrap();
    assert!(!s.project.item(ids[0]).unwrap().metadata.contains_key(FREEFORM_POS));
    s.execute("edit.redo", json!({})).unwrap();
    // snapping and Align to Grid
    s.execute("project.freeform.options", json!({"grid": 50, "snap": true})).unwrap();
    s.execute("project.freeform.move", json!({"items": [ids[2].0], "x": 123, "y": 77})).unwrap();
    assert_eq!((pos(&s, ids[2]).0, pos(&s, ids[2]).1), (100.0, 100.0));
    s.execute("project.freeform.options", json!({"snap": false})).unwrap();
    s.execute("project.freeform.move", json!({"items": [ids[2].0], "x": 133, "y": 77})).unwrap();
    s.execute("project.freeform.alignToGrid", json!({"bin": bin})).unwrap();
    assert_eq!((pos(&s, ids[2]).0, pos(&s, ids[2]).1), (150.0, 100.0));
    assert!(ids.iter().all(|i| s.project.item(*i).unwrap().metadata.contains_key(FREEFORM_POS)), "align pins every card");
    // Clip Size
    s.execute("project.freeform.resize", json!({"items": [ids[0].0], "size": 200})).unwrap();
    assert_eq!(pos(&s, ids[0]).2, Some(200.0));
    s.execute("project.freeform.resize", json!({"items": [ids[0].0], "step": 1})).unwrap();
    assert_eq!(pos(&s, ids[0]).2, Some(250.0));
    // saved with the project (item metadata) and back
    let text = serde_json::to_string(&*s.project).unwrap();
    let p2: kition_film_project::Project = serde_json::from_str(&text).unwrap();
    assert_eq!(p2.item(ids[0]).unwrap().metadata.get(FREEFORM_POS), s.project.item(ids[0]).unwrap().metadata.get(FREEFORM_POS));
    // the Metadata panel doesn't list the bookkeeping keys
    let m = s.execute("metadata.get", json!({"item": ids[0].0})).unwrap();
    assert!(!m["fields"].as_array().unwrap().iter().any(|f| f["name"] == FREEFORM_POS));
    // Reset to Grid
    s.execute("project.freeform.reset", json!({"bin": bin})).unwrap();
    assert!(s.project.items.values().all(|i| !i.metadata.contains_key(FREEFORM_POS)));
}

#[test]
fn freeform_stacks_and_arrangements() {
    let mut s = demo();
    let ids = media(&s);
    assert!(s.execute("project.freeform.stack", json!({"items": [ids[0].0]})).is_err(), "needs two");
    s.execute("project.freeform.move", json!({"items": [ids[0].0], "x": 400, "y": 300})).unwrap();
    s.execute("project.freeform.stack", json!({"items": [ids[0].0, ids[1].0, ids[2].0]})).unwrap();
    let bin = bin_of(&s, ids[0]);
    let lay = s.execute("project.freeform.layout", json!({"bin": bin})).unwrap();
    let card = |i: ItemId| lay["cards"].as_array().unwrap().iter().find(|c| c["item"] == json!(i.0)).unwrap().clone();
    assert_eq!(card(ids[1])["stack"], json!(ids[0].0));
    // stacked cards sit on the first card, offset
    assert!((card(ids[1])["x"].as_f64().unwrap() - 406.0).abs() < 0.01);
    assert!((card(ids[2])["y"].as_f64().unwrap() - 312.0).abs() < 0.01);
    // one undo step
    let n = s.history.undo.len();
    s.execute("project.freeform.unstack", json!({"items": [ids[0].0]})).unwrap();
    assert_eq!(s.history.undo.len(), n + 1);
    assert!(ids[..3].iter().all(|i| !s.project.item(*i).unwrap().metadata.contains_key(FREEFORM_STACK)), "unstacking the first card releases all");
    let lay = s.execute("project.freeform.layout", json!({"bin": bin})).unwrap();
    let xs: Vec<f64> =
        ids[..3].iter().map(|i| lay["cards"].as_array().unwrap().iter().find(|c| c["item"] == json!(i.0)).unwrap()["x"].as_f64().unwrap()).collect();
    assert!(xs[0] < xs[1] && xs[1] < xs[2], "released cards are spread: {xs:?}");

    // arrangements
    s.execute("project.freeform.saveArrangement", json!({"name": "Rough", "bin": bin})).unwrap();
    s.execute("project.freeform.move", json!({"items": [ids[0].0], "x": 20, "y": 20})).unwrap();
    assert_eq!(s.execute("project.freeform.arrangements", json!({"bin": bin})).unwrap()["arrangements"], json!(["Rough"]));
    s.execute("project.freeform.restoreArrangement", json!({"name": "Rough", "bin": bin})).unwrap();
    let x0 = project_panel::parse_pos(s.project.item(ids[0]).unwrap().metadata.get(FREEFORM_POS).unwrap()).unwrap().0;
    assert_eq!(x0, 400.0);
    assert!(s.execute("project.freeform.restoreArrangement", json!({"name": "Nope", "bin": bin})).is_err());
    s.execute("project.freeform.deleteArrangement", json!({"name": "Rough", "bin": bin})).unwrap();
    assert_eq!(s.execute("project.freeform.arrangements", json!({"bin": bin})).unwrap()["arrangements"], json!([]));
}

#[test]
fn bins_rename_nest_and_list() {
    let mut s = demo();
    let b = s.execute("bin.add", json!({"name": "Footage"})).unwrap()["bin"].as_u64().unwrap();
    let inner = s.execute("bin.add", json!({"name": "Day 1", "parent": b})).unwrap()["bin"].as_u64().unwrap();
    let ids = media(&s);
    s.execute("project.moveToBin", json!({"items": [ids[0].0], "bin": inner})).unwrap();
    s.execute("project.renameBin", json!({"bin": b, "name": "Camera"})).unwrap();
    let rows = s.execute("project.items", json!({"recursive": true})).unwrap();
    let r = rows["rows"].as_array().unwrap();
    let cam = r.iter().position(|x| x["bin"] == json!(b)).unwrap();
    assert_eq!(r[cam]["name"], "Camera");
    assert_eq!(r[cam + 1]["bin"], json!(inner));
    assert_eq!(r[cam + 2]["item"], json!(ids[0].0));
    assert_eq!(r[cam + 2]["depth"], 2);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.project.root.find_bin(kition_film_project::BinId(b)).unwrap().name, "Footage");
    assert!(s.execute("project.renameBin", json!({"bin": b, "name": "  "})).is_err());
    // only the bin's rows without `recursive`
    let rows = s.execute("project.items", json!({"bin": inner})).unwrap();
    assert_eq!(names(&rows).len(), 1);
}

#[test]
fn usage_counts_sequence_uses() {
    let s = demo();
    let used = s
        .project
        .sequences()
        .flat_map(|q| q.as_sequence().into_iter().flat_map(|q| q.all_tracks()).flat_map(|t| t.items.iter().map(|i| i.item)).collect::<Vec<_>>())
        .next()
        .expect("the demo sequence uses an item");
    let (v, a) = project_panel::usage(&s.project, used);
    assert!(v + a > 0);
    let it = s.project.item(used).unwrap();
    let (text, _) = project_panel::cell(&s.project, it, if v > 0 { "Video Usage" } else { "Audio Usage" });
    assert_eq!(text, (if v > 0 { v } else { a }).to_string());
    assert!(!matches!(it.kind, ItemKind::Graphic { .. }));
}

#[test]
fn select_all_selects_every_project_item() {
    let mut s = demo();
    assert!(s.project.items.len() >= 3);
    s.state.project_selection.clear();
    let r = s.execute("project.selectAll", json!({})).unwrap();
    assert_eq!(r["selected"].as_u64(), Some(s.project.items.len() as u64));
    assert_eq!(s.state.project_selection.len(), s.project.items.len());
    assert!(s.project.items.keys().all(|i| s.state.project_selection.contains(i)));
    s.execute("project.deselectAll", json!({})).unwrap();
    assert!(s.state.project_selection.is_empty());
    // the timeline Select All still selects timeline clips and leaves the Project panel alone
    s.execute("project.selectAll", json!({})).unwrap();
    let before = s.state.project_selection.clone();
    s.execute("edit.selectAll", json!({})).unwrap();
    assert!(!s.state.selection.is_empty());
    assert_eq!(s.state.project_selection, before);
}

#[test]
fn items_carry_what_the_icon_view_and_preview_area_draw() {
    let mut s = demo();
    let ids = media(&s);
    let bin = bin_of(&s, ids[0]);
    // every row says what the card draws: kind, duration, streams, marks, poster frame, the Preview Area's lines
    s.execute("project.setMarks", json!({"item": ids[0].0, "in": 0, "out": TICKS_PER_SECOND})).unwrap();
    let rows = s.execute("project.items", json!({"bin": bin})).unwrap();
    let row = rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(ids[0].0)).unwrap().clone();
    let it = s.project.item(ids[0]).unwrap();
    assert_eq!(row["type"], it.type_label());
    assert_eq!(row["kind"], "media");
    assert_eq!(row["file"], json!(matches!(&it.kind, ItemKind::Media(m) if matches!(m.media, kition_film_project::MediaRef::File { .. }))));
    assert_eq!(row["matte"], json!(false));
    assert_eq!(row["duration"], json!(it.duration().0));
    assert_eq!(row["hasVideo"], json!(it.has_video()));
    assert_eq!(row["in"], json!(0));
    assert!(row["out"].as_i64().is_some());
    assert!(row["poster"].is_null());
    assert!(row["frame"].as_i64().unwrap() > 0);
    assert_eq!(row["info"]["mediaDuration"], json!(project_panel::cell(&s.project, it, "Media Duration").0));
    assert_eq!(row["usage"].as_array().unwrap().len(), 2);
    // bins say how many items they hold
    let top = s.execute("project.items", json!({})).unwrap();
    let bin_row = top["rows"].as_array().unwrap().iter().find(|r| r["bin"] == json!(bin)).unwrap().clone();
    assert_eq!(bin_row["items"].as_u64().unwrap() as usize, ids.len());
    // the Icon view's order: sub-bins, then every item under the bin in the icon sort, `direct` for the bin's own
    s.execute("project.view.set", json!({"iconSort": {"column": "Name", "descending": true}})).unwrap();
    let icon = s.execute("project.items", json!({"order": "icon"})).unwrap();
    let icon_rows = icon["rows"].as_array().unwrap();
    let first_item = icon_rows.iter().position(|r| r.get("item").is_some()).unwrap();
    assert!(icon_rows[..first_item].iter().all(|r| r.get("bin").is_some()));
    assert!(icon_rows[first_item..].iter().all(|r| r.get("item").is_some()));
    let names: Vec<String> = icon_rows[first_item..].iter().map(|r| r["name"].as_str().unwrap().to_lowercase()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.reverse();
    assert_eq!(names, sorted, "Name descending");
    let nested = icon_rows.iter().find(|r| r["item"] == json!(ids[0].0)).unwrap();
    assert_eq!(nested["direct"], json!(s.project.root.parent_of(ids[0]) == Some(s.project.root.id)));
}

#[test]
fn the_offline_badge_names_missing_media_as_upstream() {
    let mut s = demo();
    let ids = media(&s);
    let bin = bin_of(&s, ids[0]);
    let row = |s: &mut Session, id: ItemId| {
        let rows = s.execute("project.items", json!({"bin": bin})).unwrap();
        rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(id.0)).unwrap().clone()
    };
    let online = row(&mut s, ids[0]);
    assert_eq!(online["offline"], json!(false));
    assert!(online["offlineText"].is_null());
    // a file the project cannot find (upstream `media_badge`: "Media missing")
    s.offline.missing.push(ids[0]);
    let missing = row(&mut s, ids[0]);
    assert_eq!(missing["offline"], json!(true));
    assert_eq!(missing["offlineText"], "Media missing");
    // made offline on purpose: "Offline"
    if let Some(ItemKind::Media(m)) = std::sync::Arc::make_mut(&mut s.project).item_mut(ids[1]).map(|it| &mut it.kind) {
        m.offline = true;
    }
    assert_eq!(row(&mut s, ids[1])["offlineText"], "Offline");
    // a file there but undecodable: "Unreadable"
    s.media.set_offline(ids[2], kition_film_render::offline::OfflineReason::Unreadable, "x.mov", "bad data");
    assert_eq!(row(&mut s, ids[2])["offlineText"], "Unreadable");
    // a subclip shows its parent's state
    s.execute("source.open", json!({"item": ids[0].0})).unwrap();
    let frame = s.project.item(ids[0]).unwrap().frame_rate().frame_duration().0;
    s.execute("project.setMarks", json!({"item": ids[0].0, "in": 0, "out": frame * 4})).unwrap();
    let sub = ItemId(s.execute("clip.makeSubclip", json!({})).unwrap()["item"].as_u64().unwrap());
    let rows = s.execute("project.items", json!({"order": "icon"})).unwrap();
    let sub_row = rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(sub.0)).unwrap().clone();
    assert_eq!(sub_row["kind"], "subclip");
    assert_eq!(sub_row["offlineText"], "Media missing", "{sub_row}");
}

/// The `stamp` a media row carries, as upstream's `item_revision`: it moves when the item's
/// pictures do on this host (made offline, linked again, missing from its folder, a proxy shown),
/// so its thumbnails draw again, and not with any other edit. Its item in `file.inspect`
/// carries the document's part only (made offline, its file, its proxy file), the same on every
/// peer: what this host sees of the files never reaches `inspect()`. A subclip follows its
/// parent; a sequence keeps its own content stamp.
#[test]
fn a_media_row_stamp_follows_its_file_offline_state_and_proxy() {
    let mut s = demo();
    let ids = media(&s);
    let row = |s: &mut Session, item: ItemId| {
        let rows = s.execute("project.items", json!({"recursive": true})).unwrap();
        rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(item.0)).map(|r| r["stamp"].clone()).unwrap()
    };
    let inspected = |s: &Session, item: ItemId| {
        fn find(bin: &Value, item: u64) -> Option<Value> {
            bin["children"].as_array()?.iter().find_map(|c| if c["item"] == json!(item) { Some(c["stamp"].clone()) } else { find(c, item) })
        }
        find(&crate::commands::inspect_project(s)["root"], item.0).unwrap_or(Value::Null)
    };
    let first = (row(&mut s, ids[0]), inspected(&s, ids[0]));
    assert!(first.0.is_string() && first.1.is_string(), "{first:?}");
    // another edit leaves both alone
    s.execute("project.select", json!({"items": [ids[1].0]})).unwrap();
    s.execute("edit.label", json!({"label": "Rose"})).unwrap();
    assert_eq!((row(&mut s, ids[0]), inspected(&s, ids[0])), first);
    // made offline (the document's own change) both move; linked again, both are back
    let set_offline = |s: &mut Session, item: ItemId, offline: bool| {
        if let Some(ItemKind::Media(m)) = std::sync::Arc::make_mut(&mut s.project).item_mut(item).map(|it| &mut it.kind) {
            m.offline = offline;
        }
    };
    set_offline(&mut s, ids[0], true);
    assert_ne!(row(&mut s, ids[0]), first.0);
    assert_ne!(inspected(&s, ids[0]), first.1);
    set_offline(&mut s, ids[0], false);
    assert_eq!((row(&mut s, ids[0]), inspected(&s, ids[0])), first);
    // missing from this host's folder (upstream's "Media missing"): the row moves, inspect() does not
    s.offline.missing.push(ids[0]);
    assert_ne!(row(&mut s, ids[0]), first.0);
    assert_eq!(inspected(&s, ids[0]), first.1, "host-local: not in inspect()");
    s.offline.missing.clear();
    // a proxy attached moves both; shown or not (a preference of this host) moves the row only
    if let Some(ItemKind::Media(m)) = std::sync::Arc::make_mut(&mut s.project).item_mut(ids[0]).map(|it| &mut it.kind) {
        m.proxy = Some(kition_film_project::MediaRef::File { path: "elsewhere/proxy.mov".into() });
    }
    let attached = (row(&mut s, ids[0]), inspected(&s, ids[0]));
    assert_ne!(attached.0, first.0);
    assert_ne!(attached.1, first.1);
    s.media.set_use_proxies(true);
    assert_ne!(row(&mut s, ids[0]), attached.0);
    assert_eq!(inspected(&s, ids[0]), attached.1, "host-local: not in inspect()");
    s.media.set_use_proxies(false);
    assert_eq!(row(&mut s, ids[0]), attached.0);
    // a subclip follows its parent; a sequence keeps its own stamp
    s.execute("source.open", json!({"item": ids[0].0})).unwrap();
    let frame = s.project.item(ids[0]).unwrap().frame_rate().frame_duration().0;
    s.execute("project.setMarks", json!({"item": ids[0].0, "in": 0, "out": frame * 4})).unwrap();
    let sub = ItemId(s.execute("clip.makeSubclip", json!({})).unwrap()["item"].as_u64().unwrap());
    let parent = (row(&mut s, ids[0]), inspected(&s, ids[0]));
    assert_eq!((row(&mut s, sub), inspected(&s, sub)), parent);
    set_offline(&mut s, ids[0], true);
    assert_ne!(row(&mut s, sub), parent.0);
    assert_ne!(inspected(&s, sub), parent.1);
}

/// The `stamp` a sequence row carries (what its poster frame is drawn from): it moves when the
/// sequence (or a sequence it nests) changes, and not when anything else in the project does.
#[test]
fn a_sequence_row_stamp_follows_its_own_content_only() {
    let mut s = demo();
    let stamp = |s: &mut Session, item: ItemId| {
        let rows = s.execute("project.items", json!({"recursive": true})).unwrap();
        rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(item.0)).map(|r| r["stamp"].clone()).unwrap()
    };
    let seq = s.state.active_sequence.unwrap();
    let first = stamp(&mut s, seq);
    assert!(first.is_string(), "a sequence row has a stamp: {first}");
    // Another item's label, a new bin, and the playhead leave it.
    let m = media(&s)[0];
    s.execute("project.select", json!({"items": [m.0]})).unwrap();
    s.execute("edit.label", json!({"label": "Iris"})).unwrap();
    s.execute("bin.add", json!({"name": "Other"})).unwrap();
    s.execute("playhead.set", json!({"seconds": 1.0})).unwrap();
    assert_eq!(stamp(&mut s, seq), first);
    // A clip placed in it moves it.
    s.execute("timeline.place", json!({"item": m.0, "track": "V1", "seconds": 0.0})).unwrap();
    let placed = stamp(&mut s, seq);
    assert_ne!(placed, first);
    // A sequence that nests it follows it too.
    s.execute("sequence.new", json!({"name": "Outer"})).unwrap();
    let outer = s.state.active_sequence.unwrap();
    s.execute("timeline.place", json!({"item": seq.0, "track": "V1", "seconds": 0.0})).unwrap();
    let nesting = stamp(&mut s, outer);
    s.execute("sequence.open", json!({"item": seq.0})).ok();
    s.state.active_sequence = Some(seq);
    s.execute("timeline.place", json!({"item": m.0, "track": "V1", "seconds": 30.0})).unwrap();
    assert_ne!(stamp(&mut s, outer), nesting, "the nested sequence changed");
    // A media item's is its media's (`a_media_row_stamp_follows_its_file_offline_state_and_proxy`).
    assert!(stamp(&mut s, m).is_string());
}

/// What a sequence shows also comes from the items its clips use: Interpret Footage on a placed
/// item moves the sequence's stamp; the same on an item it does not use leaves it.
#[test]
fn a_sequence_row_stamp_follows_the_items_its_clips_use() {
    let mut s = demo();
    let stamp = |s: &mut Session, item: ItemId| {
        let rows = s.execute("project.items", json!({"recursive": true})).unwrap();
        rows["rows"].as_array().unwrap().iter().find(|r| r["item"] == json!(item.0)).map(|r| r["stamp"].clone()).unwrap()
    };
    let items = media(&s);
    let (placed, other) = (items[0], items[1]);
    s.execute("sequence.new", json!({"name": "Uses one"})).unwrap();
    let seq = s.state.active_sequence.unwrap();
    s.execute("timeline.place", json!({"item": placed.0, "track": "V1", "seconds": 0.0})).unwrap();
    let before = stamp(&mut s, seq);
    s.execute("clip.interpretFootage", json!({"items": [other.0], "colorSpace": "slog3-sgamut3cine"})).unwrap();
    assert_eq!(stamp(&mut s, seq), before, "an item the sequence does not use");
    s.execute("clip.interpretFootage", json!({"items": [placed.0], "colorSpace": "slog3-sgamut3cine"})).unwrap();
    let interpreted = stamp(&mut s, seq);
    assert_ne!(interpreted, before, "the placed item's interpretation");
    // Reading again changes nothing.
    assert_eq!(stamp(&mut s, seq), interpreted);
}

#[test]
fn freeform_commands_that_lay_cards_out_declare_their_width() {
    // An agent finds `width` in the schema of every freeform command that reads it (the panel's
    // width the auto-placed cards are laid out for); one that reads none does not list it.
    let specs = project_panel::commands();
    let params = |id: &str| specs.iter().find(|spec| spec.id == id).unwrap_or_else(|| panic!("{id}")).params;
    for id in [
        "project.freeform.layout",
        "project.freeform.move",
        "project.freeform.resize",
        "project.freeform.alignToGrid",
        "project.freeform.reset",
        "project.freeform.stack",
        "project.freeform.unstack",
        "project.freeform.saveArrangement",
        "project.freeform.restoreArrangement",
    ] {
        assert!(params(id).contains("\"width\":f32?"), "{id}: {}", params(id));
    }
    assert!(!params("project.freeform.deleteArrangement").contains("width"));
}

#[test]
fn n39_project_rows_expose_the_absolute_media_range_for_subclip_thumbnails() {
    let mut s = Session::default();
    s.execute("file.newProject", json!({})).unwrap();
    s.execute("sequence.new", json!({"fps": 24, "width": 64, "height": 36})).unwrap();
    let parent = s.execute("item.newColorMatte", json!({"seconds": 1})).unwrap()["item"].clone();
    let item = s.execute("clip.makeSubclip", json!({"item": parent, "startFrame": 13, "endFrame": 17})).unwrap()["item"].clone();
    let row = |s: &mut Session, id: &Value| {
        s.execute("project.items", json!({})).unwrap()["rows"].as_array().unwrap().iter().find(|row| row["item"] == *id).unwrap().clone()
    };
    assert_eq!(row(&mut s, &parent)["start"], 0);
    assert_eq!(row(&mut s, &item)["start"], 13 * TICKS_PER_SECOND / 24);
    assert_eq!(row(&mut s, &item)["duration"], 4 * TICKS_PER_SECOND / 24);
    s.execute("clip.editSubclip", json!({"item": item, "startFrame": 17, "endFrame": 21})).unwrap();
    assert_eq!(row(&mut s, &item)["start"], 17 * TICKS_PER_SECOND / 24);
    s.undo();
    assert_eq!(row(&mut s, &item)["start"], 13 * TICKS_PER_SECOND / 24);
    s.redo();
    assert_eq!(row(&mut s, &item)["start"], 17 * TICKS_PER_SECOND / 24);
}
