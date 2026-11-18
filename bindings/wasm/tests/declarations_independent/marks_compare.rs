//! Full mark/split scopes, including parameter precedence and Source kinds.
//! ReviewCorrection: the later target=source rows overstate range/rate and
//! opposite-mark reads. commands.rs:2980-3021 assigns only supplied marks and
//! same-side splits; it never edits a subclip range or clears an opposite mark.
//! source_monitor.rs:128-139 delegates Clear with null marks. The eager
//! source_view values do not participate in those assignments.
use std::collections::BTreeSet;

use kition_film_engine::project::{ItemKind, Project, Sequence};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("markers.markIn", "program"),
    ("markers.markIn", "source"),
    ("markers.markIn", "target=source"),
    ("markers.markOut", "program"),
    ("markers.markOut", "source"),
    ("markers.markOut", "target=source"),
    ("markers.clearIn", "program"),
    ("markers.clearIn", "target=source"),
    ("markers.clearOut", "program"),
    ("markers.clearOut", "target=source"),
    ("markers.clearInOut", "program"),
    ("markers.clearInOut", "target=source"),
    ("markers.markSplitVideoIn", "program"),
    ("markers.markSplitVideoIn", "source"),
    ("markers.markSplitVideoOut", "program"),
    ("markers.markSplitVideoOut", "source"),
    ("markers.markSplitAudioIn", "program"),
    ("markers.markSplitAudioIn", "source"),
    ("markers.markSplitAudioOut", "program"),
    ("markers.markSplitAudioOut", "source"),
    ("project.setMarks", "source/sequence"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    if !PATHS.contains(&(command, path)) {
        return false;
    }
    let commands = include_str!("../../../../crates/engine/engine/src/commands.rs");
    let sequence = include_str!("../../../../crates/engine/engine/src/sequence_tools.rs");
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    hash(commands) == 0x4a909853df5c55f6 && hash(sequence) == 0x9c4a17d3fd68bdd4
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    let mut more = vec!["coarse-active-state"];
    if path != "program" && command != "project.setMarks" {
        more.push("source-only-part");
    }
    if path == "program" && !command.contains("Split") {
        more.push("unconsumed-program-material");
    }
    if !command.starts_with("markers.clear") && command != "project.setMarks" {
        more.push("coarse-time-state");
    }
    more
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

fn normalize(mut under: Under) -> Under {
    for held in &mut under.premises {
        for fields in [&mut held.fields, &mut held.positions].into_iter().flatten() {
            *fields = fields.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
        }
    }
    under.premises.sort_by_key(|held| held.id.to_string());
    under
}

pub(super) fn program_material(sequence: &Sequence, at: i64, under: &mut Under) {
    for track in sequence.all_tracks() {
        let before = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
        let under_count = track.items.iter().filter(|clip| clip.end().0 > at && clip.start.0 <= at).count();
        under.objects.extend(track.items.iter().filter(|clip| clip.end().0 > at && clip.start.0 <= at).map(|clip| json!(clip.id.0)));
        under.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".into(),
            from: before,
            to: before + under_count,
            time: Some(TimeSpan {
                from: json!(at.to_string()),
                to: json!(at.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
    }
}

fn source_fields(project: &Project, source: u64, mark_in: bool, mark_out: bool) -> Vec<String> {
    let mut fields = Vec::new();
    if mark_in || mark_out {
        fields.push("kind".to_owned());
    }
    for (set, side) in [(mark_in, "in"), (mark_out, "out")] {
        if !set {
            continue;
        }
        for channel in ["video", "audio"] {
            fields.push(format!("props.common.split.{channel}{}", if side == "in" { "In" } else { "Out" }));
        }
        match &project.item(kition_film_engine::project::ItemId(source)).unwrap().kind {
            ItemKind::Media(_) => fields.push(format!("props.media.mark_{side}")),
            ItemKind::Sequence(_) => {
                fields.push(format!("sequence.settings.mark_{side}"));
                for channel in ["video", "audio"] {
                    fields.push(format!("sequence.settings.split.{channel}{}", if side == "in" { "In" } else { "Out" }));
                }
            }
            _ => {}
        }
    }
    fields
}

#[test]
fn mark_paths_compare_all_source_kinds_time_spellings_and_assigned_sides() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let media = doc.execute("file.newColorMatte", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    let project = &loaded.project;
    let sequence_id = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let sequence = project.sequence(kition_film_engine::project::ItemId(sequence_id)).unwrap();
    for source in [media, subclip, sequence_id] {
        doc.execute("source.open", json!({"item":source})).unwrap();
        let specs = doc.commands();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path), "source review expired: {command}/{path}");
            let spec = specs.iter().find(|spec| spec.id == command).unwrap();
            assert!(spec.enabled && spec.mutates);
            let timed = !command.starts_with("markers.clear") && command != "project.setMarks";
            assert_eq!(
                spec.reads,
                if command == "project.setMarks" {
                    vec![EditorState::Active]
                } else if timed {
                    vec![EditorState::Part, EditorState::Time, EditorState::Active]
                } else {
                    vec![EditorState::Part, EditorState::Active]
                },
                "{command}"
            );
            assert_eq!(spec.targets, (command == "project.setMarks").then_some("item"));
            assert!(
                spec.objects.is_empty()
                    && spec.name_params.is_empty()
                    && spec.name_field.is_none()
                    && spec.index.is_none()
                    && !spec.index_numbers
                    && !spec.index_reversed
            );
            assert_eq!(spec.object_types, if command == "project.setMarks" { vec![("item", &["Item"][..])] } else { vec![] });
            assert_eq!(spec.places, if timed { vec!["time", "seconds", "frame", "timecode"] } else { vec![] });
            if command == "project.setMarks" {
                for explicit in [false, true] {
                    for sides in 0..4 {
                        let mut params = json!({});
                        if explicit {
                            params["item"] = json!(source);
                        }
                        for (mask, side) in [(1, "in"), (2, "out")] {
                            if sides & mask != 0 {
                                params[side] = Value::Null;
                            }
                        }
                        let expected =
                            Under { premises: vec![leaf(source, source_fields(project, source, sides & 1 != 0, sides & 2 != 0))], ..Default::default() };
                        assert_eq!(normalize(doc.under(command, &params).unwrap().unwrap()), normalize(expected), "{command}/{params}/{source}");
                    }
                }
                continue;
            }
            let split = command.contains("Split");
            let program = path == "program";
            for (mut params, at, rate, drop_frame) in [
                (json!({}), 0, false, false),
                (json!({"time":1}), 1, false, false),
                (json!({"frame":1}), sequence.settings.frame_rate.tick_of(1).0, true, false),
                (json!({"seconds":0.5}), 127_008_000_000, false, false),
                (json!({"timecode":"00:00:00:01"}), sequence.settings.frame_rate.tick_of(1).0, true, true),
                (json!({"time":1,"frame":9,"seconds":2,"timecode":"00:00:00:08"}), 1, false, false),
            ] {
                if (!timed && params != json!({}))
                    || (!program && params.get("frame").is_some() && !split)
                    || (!program && params.get("timecode").is_some() && !split)
                {
                    continue;
                }
                if !program {
                    params["target"] = json!("source");
                }
                let target = if program { sequence_id } else { source };
                let mut fields = Vec::<String>::new();
                if split {
                    let base = if program { "sequence.settings.split" } else { "props.common.split" };
                    let channel = if command.contains("Video") { "video" } else { "audio" };
                    fields.extend([format!("{base}.{channel}In"), format!("{base}.{channel}Out")]);
                } else if program {
                    if command != "markers.clearOut" {
                        fields.push("sequence.settings.mark_in".into());
                    }
                    if command != "markers.clearIn" {
                        fields.push("sequence.settings.mark_out".into());
                    }
                    for side in ["In", "Out"] {
                        if command.ends_with(side) || command == "markers.clearInOut" {
                            fields.extend([format!("sequence.settings.split.video{side}"), format!("sequence.settings.split.audio{side}")]);
                        }
                    }
                } else {
                    fields = source_fields(project, source, command.ends_with("In") || command.ends_with("InOut"), command.ends_with("Out"));
                }
                if program && timed && rate {
                    fields.push("sequence.settings.settings.frame_rate".into());
                }
                if program && timed && drop_frame {
                    fields.push("sequence.settings.settings.drop_frame".into());
                }
                let mut expected = Under { premises: vec![leaf(target, fields)], ..Default::default() };
                if program && !split {
                    program_material(sequence, at, &mut expected);
                }
                assert_eq!(normalize(doc.under(command, &params).unwrap().unwrap()), normalize(expected), "{command}/{path}/{params}/{source}");
            }
        }
    }
}
