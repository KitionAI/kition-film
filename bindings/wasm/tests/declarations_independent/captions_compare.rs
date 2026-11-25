//! captions.rs and edit/captions.rs: a caption is a `Caption` in its sequence's `captions` list,
//! named by its stable id. Timing edits consume peer ranges, not peer text.
use super::sync_compare::normalized;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("caption.deleteTrack", "track"),
    ("caption.setTrack", "patch"),
    ("caption.setStyle", "patch/reset"),
    ("caption.setText", "text/speaker"),
    ("caption.setTimes", "absolute/partial times"),
    ("caption.trim", "edge"),
    ("caption.move", "delta"),
    ("caption.split", "explicit caption"),
    ("caption.split", "no caption"),
    ("caption.merge", "consecutive"),
    ("caption.delete", "nonripple"),
    ("caption.delete", "ripple"),
    ("caption.add", "existing track, text/time"),
    ("caption.add", "words"),
    ("caption.showAll", "all tracks"),
    ("caption.hideAll", "all tracks"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/captions.rs")) == 0x57c045636b31d654
        && hash(include_str!("../../../../crates/engine/edit/src/captions.rs")) == 0x01ae5c658db31a4e
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    match command {
        "caption.split" => vec!["whole-caption-tracks", "unused-caption-playhead"],
        "caption.merge" | "caption.delete" => vec!["whole-caption-tracks", "coarse-selection-state", "unused-caption-playhead"],
        "caption.setText" => vec!["whole-implicit-caption", "coarse-selection-state", "unused-caption-playhead"],
        "caption.setTimes" | "caption.trim" | "caption.move" => vec!["all-peer-caption-timing", "coarse-selection-state", "unused-caption-playhead"],
        "caption.add" => {
            if path == "words" {
                vec!["all-peer-caption-timing", "unconsumed-program-material", "unused-caption-playhead"]
            } else {
                vec!["all-peer-caption-timing", "unconsumed-program-material"]
            }
        }
        "caption.showAll" | "caption.hideAll" => vec!["unconsumed-program-material"],
        _ => vec![],
    }
}

fn leaf(sequence: u64, fields: Vec<String>) -> Under {
    Under { premises: vec![Premise::on(json!(sequence)).fields(fields).positions(Vec::<String>::new())], ..Default::default() }
}

fn fixture() -> (FilmDocument, u64, Vec<u64>, Vec<Vec<u64>>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let mut tracks = Vec::new();
    let mut captions = Vec::new();
    for n in 0..2 {
        let track = doc.execute("caption.newTrack", json!({"name":format!("Captions {n}")})).unwrap()["track"].as_u64().unwrap();
        tracks.push(track);
        let mut ids = Vec::new();
        for index in 0..3 {
            ids.push(doc.execute("caption.add", json!({"track":track,"time":254_016_000_000i64 * index * 2,"durationSeconds":1,"text":"Caption"})).unwrap()["caption"].as_u64().unwrap());
        }
        captions.push(ids);
    }
    (doc, sequence, tracks, captions)
}

#[test]
fn caption_track_patches_compare_all_subsets_resets_and_native_track_addresses() {
    let (doc, sequence, tracks, _) = fixture();
    let settings = [
        ("name", "name", json!("Assigned")),
        ("format", "format", json!("CEA-608")),
        ("language", "language", json!("zh")),
        ("enabled", "enabled", json!(false)),
        ("locked", "locked", json!(true)),
        ("syncLock", "syncLock", json!(false)),
    ];
    let style = [
        ("font", "font", json!("Sans")),
        ("size", "size", json!(40)),
        ("color", "color", json!("#ffffff")),
        ("background", "background", json!(true)),
        ("backgroundColor", "background_color", json!("#000000ff")),
        ("align", "align", json!("left")),
        ("anchor", "anchor", json!("top")),
        ("margin", "margin", json!(0.1)),
        ("lineSpacing", "line_spacing", json!(1.2)),
        ("outline", "outline", json!(2)),
        ("outlineColor", "outline_color", json!("#000000")),
        ("highlightColor", "highlight_color", json!("#ffff00")),
        ("highlightScale", "highlight_scale", json!(1.2)),
    ];
    for command in ["caption.deleteTrack", "caption.setTrack", "caption.setStyle"] {
        let fields = if command == "caption.setStyle" {
            &style[..]
        } else if command == "caption.setTrack" {
            &settings[..]
        } else {
            &[]
        };
        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
        assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
        assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
        assert_eq!(spec.reads, [EditorState::Part]);
        for (index, track) in tracks.iter().enumerate() {
            for address in [json!(track), json!(format!("C{}", index + 1)), json!(format!("c{}", index + 1)), Value::Null] {
                let chosen = if address.is_null() { tracks[0] } else { *track };
                let ordinal = if address.is_null() { 0 } else { index };
                for reset in [false, true] {
                    for subset in 0..(1usize << fields.len()) {
                        let mut params = json!({"track":address,"reset":reset});
                        let prefix = format!("sequence.captionTracks[id={chosen}]");
                        let mut expected = Vec::new();
                        if command == "caption.deleteTrack" {
                            expected.extend([prefix.clone(), format!("sequence.captions[track={chosen}]")]);
                        } else if reset && command == "caption.setStyle" {
                            expected.push(format!("{prefix}.style"));
                        }
                        for (n, (param, field, value)) in fields.iter().enumerate() {
                            if subset & (1 << n) != 0 {
                                params[*param] = value.clone();
                                if !reset || command != "caption.setStyle" {
                                    expected.push(format!("{prefix}.{}{field}", if command == "caption.setStyle" { "style." } else { "" }));
                                }
                            }
                        }
                        expected.push(format!("{prefix}.id"));
                        if !address.is_number() {
                            expected.push(format!("sequence.captionTracks.{ordinal}.id"));
                        }
                        assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(leaf(sequence, expected)), "{command}/{params}");
                    }
                }
            }
        }
    }
}

#[test]
fn caption_edits_compare_explicit_selection_and_point_targets_all_tracks_and_timing_peers() {
    let (mut doc, sequence, tracks, captions) = fixture();
    for selected in [vec![], vec![captions[1][1]], vec![captions[0][0], captions[1][1]]] {
        doc.execute("caption.select", json!({"captions":selected})).unwrap();
        for &(command, path) in PATHS.iter().filter(|(id, _)| !matches!(*id, "caption.deleteTrack" | "caption.setTrack" | "caption.setStyle")) {
            assert!(compared_path(command, path));
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
            assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
            assert_eq!(
                spec.reads,
                if matches!(command, "caption.add" | "caption.split") {
                    vec![EditorState::Part, EditorState::Time]
                } else if matches!(command, "caption.showAll" | "caption.hideAll") {
                    vec![EditorState::Part]
                } else {
                    vec![EditorState::Part, EditorState::Selection, EditorState::Time]
                }
            );
            assert_eq!(
                spec.places,
                if command == "caption.add" {
                    vec!["track", "time", "seconds", "frame", "timecode"]
                } else if command == "caption.split" {
                    vec!["time"]
                } else {
                    vec![]
                }
            );
            for address in [Value::Null, json!(captions[0][1]), json!([captions[0][1], captions[1][1]])] {
                for timing in [
                    json!({}),
                    json!({"delta":1,"time":1}),
                    json!({"deltaFrames":1,"frame":1}),
                    json!({"startTime":1,"endTime":2}),
                    json!({"startTimecode":"00:00:00:01"}),
                    json!({"timecode":"00:00:00:01"}),
                ] {
                    for patch in 1..4 {
                        let mut params = timing.clone();
                        params["track"] = json!(tracks[0]);
                        params["ripple"] = json!(path == "ripple");
                        if !address.is_null() {
                            params[if address.is_array() { "captions" } else { "caption" }] = address.clone();
                        }
                        if patch & 1 != 0 {
                            params["text"] = json!("Assigned");
                        }
                        if patch & 2 != 0 {
                            params["speaker"] = Value::Null;
                        }
                        if path == "words" {
                            params["words"] = json!([{"text":"Word","start":1,"end":2}]);
                        }
                        let ids = if address.is_array() {
                            address.as_array().unwrap().iter().map(|id| id.as_u64().unwrap()).collect()
                        } else if let Some(id) = address.as_u64() {
                            vec![id]
                        } else if !selected.is_empty() {
                            selected.clone()
                        } else {
                            vec![captions[0][0]]
                        };
                        let mut expected = Vec::new();
                        match command {
                            "caption.setText" => {
                                for (index, track) in tracks.iter().enumerate() {
                                    for caption in captions[index].iter().filter(|id| ids.contains(id)) {
                                        let prefix = format!("sequence.captions[id={caption}]");
                                        if address.is_null() {
                                            expected.push(prefix);
                                        } else {
                                            if patch & 1 != 0 {
                                                expected.push(format!("{prefix}.text"));
                                            }
                                            if patch & 2 != 0 {
                                                expected.push(format!("{prefix}.speaker"));
                                            }
                                        }
                                    }
                                    if captions[index].iter().any(|id| ids.contains(id)) {
                                        expected.push(format!("sequence.captionTracks[id={track}].locked"));
                                    }
                                }
                            }
                            "caption.add" | "caption.setTimes" | "caption.trim" | "caption.move" => {
                                if command != "caption.move" || params.get("delta").is_none() {
                                    expected.push("sequence.settings.settings.frame_rate".into());
                                }
                                if (command == "caption.add" && params.get("timecode").is_some())
                                    || (command == "caption.setTimes" && params.get("startTimecode").is_some())
                                {
                                    expected.push("sequence.settings.settings.drop_frame".into());
                                }
                                for (index, track) in tracks.iter().enumerate() {
                                    if if command == "caption.add" { index != 0 } else { !captions[index].iter().any(|id| ids.contains(id)) } {
                                        continue;
                                    }
                                    let prefix = format!("sequence.captionTracks[id={track}]");
                                    expected.extend([format!("{prefix}.locked"), format!("sequence.captions[track={track}].id")]);
                                    for caption in &captions[index] {
                                        expected
                                            .extend([format!("sequence.captions[id={caption}].start"), format!("sequence.captions[id={caption}].duration")]);
                                    }
                                }
                            }
                            "caption.showAll" | "caption.hideAll" => {
                                expected.extend(tracks.iter().map(|track| format!("sequence.captionTracks[id={track}].enabled")))
                            }
                            _ => {
                                expected.extend(["sequence.captionTracks".into(), "sequence.captions".into()]);
                                if command == "caption.split" {
                                    expected.push("sequence.settings.settings.frame_rate".into());
                                }
                            }
                        }
                        let mut under = leaf(sequence, expected);
                        if matches!(command, "caption.add" | "caption.showAll" | "caption.hideAll") {
                            // This fixture's Program tracks are empty. The retained windows
                            // show the unrelated Program place is still declared.
                            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                            let q = project.sequence(kition_film_engine::project::ItemId(sequence)).unwrap();
                            super::marks_compare::program_material(
                                q,
                                if params.get("time").is_some() {
                                    1
                                } else if params.get("frame").is_some() || params.get("timecode").is_some() {
                                    q.settings.frame_rate.tick_of(1).0
                                } else {
                                    0
                                },
                                &mut under,
                            );
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(under),
                            "{command}/{path}/{params}/selection={selected:?}"
                        );
                    }
                }
            }
        }
    }
}
