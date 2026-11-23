//! graphic_templates.rs:1040-1140 replaces matching family/style leaves;
//! sequence_extras.rs:176-205 renders the complete mix; color.rs:436-509
//! renders the selected target and the composited reference frame. Source
//! profiles and render effect profiles retain the conservative facts below.
use super::{sound_paths_compare::source, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, Project, TrackItem};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("file.replaceFonts", "global family/style matcher"), ("sequence.normalizeMixTrack", "audio render"), ("color.applyMatch", "render-derived")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/graphic_templates.rs")) == 0xc21099df4545af4a
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_extras.rs")) == 0x6ad34e92a4fc2428
        && hash(include_str!("../../../../crates/engine/engine/src/color.rs")) == 0x338493baffff87a7
}
pub fn more(command: &str) -> Vec<&'static str> {
    match command {
        "file.replaceFonts" => vec![],
        "sequence.normalizeMixTrack" => vec!["coarse-source-profile", "whole-audio-render-profile"],
        _ => vec!["coarse-source-profile", "coarse-selection-state", "whole-video-render-profile"],
    }
}
#[test]
fn render_and_font_contracts_compare_editor_and_object_addresses() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    for &(command, path) in PATHS {
        assert!(compared_path(command, path));
        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
        let matching = command == "color.applyMatch";
        assert!(spec.mutates && spec.objects.is_empty() && spec.name_params.is_empty());
        assert_eq!(spec.targets, matching.then_some("clip"));
        assert_eq!(spec.object_types, if matching { vec![("clip", &["Clip"][..])] } else { vec![] });
        assert_eq!(spec.places, if matching { vec!["referenceTime", "referenceFrame", "referenceTimecode"] } else { vec![] });
        assert_eq!(
            spec.reads,
            match command {
                "file.replaceFonts" => vec![],
                "sequence.normalizeMixTrack" => vec![EditorState::Part],
                _ => vec![EditorState::Part, EditorState::Selection, EditorState::Time],
            }
        );
        assert!(spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
    }
}
fn leaf(id: Value, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}
fn font_key(text: &str) -> String {
    format!("f{}", text.to_ascii_lowercase().bytes().map(|b| format!("{b:02x}")).collect::<String>())
}
#[test]
fn font_replacement_compares_family_style_and_assigned_style_scopes() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    for family in ["Source Sans", "A.B/[C]~", "FONT"] {
        for style in [None, Some("Regular"), Some("Bold/Italic")] {
            for assigned in [false, true] {
                for object in [false, true] {
                    let mut params = json!({"from":family,"to":"Replacement"});
                    if let Some(style) = style {
                        params["from"] = json!({"family":family,"style":style});
                    }
                    if object {
                        params["to"] = if assigned { json!({"family":"Replacement","style":"Bold"}) } else { json!({"family":"Replacement"}) };
                    } else if assigned {
                        params["toStyle"] = json!("Bold");
                    }
                    let mut fields = vec![match style {
                        Some(style) => format!("byStyle.{}.{}", font_key(family), font_key(style)),
                        None => format!("byFamily.{}", font_key(family)),
                    }];
                    if assigned {
                        fields.push(match style {
                            Some(style) => format!("assignedStylesByStyle.{}.{}", font_key(family), font_key(style)),
                            None => format!("assignedStyles.{}", font_key(family)),
                        });
                    }
                    let mut want = Under::default();
                    want.premises.push(leaf(json!("project"), Vec::<String>::new()));
                    for field in fields {
                        want.premises.push(leaf(json!(format!("fact:project:~fontUses.{field}")), ["value"]));
                    }
                    assert_eq!(normalized(doc.under("file.replaceFonts", &params).unwrap().unwrap()), normalized(want), "{params}");
                }
            }
        }
    }
}
fn picture(project: &Project, clip: &TrackItem, want: &mut Under) {
    let mut fields = vec![
        "item",
        "sourceIn",
        "speed",
        "reverse",
        "effects",
        "props.enabled",
        "props.frame_hold",
        "props.hold_filters",
        "props.scale_to_frame",
        "props.time_interpolation",
        "props.multicam",
        "props.graphic",
    ];
    if clip.effects.iter().any(|effect| effect.enabled && effect.effect == "clip_name") {
        fields.push("props.name");
    }
    want.premises.push(leaf(json!(clip.id.0), fields).positions(["start", "duration"]));
    source(want, project, clip.item);
    for effect in clip.effects.iter().filter(|effect| effect.enabled) {
        for param in effect.params.values() {
            if let kition_film_engine::project::ParamValue::Text(value) = &param.value
                && let Some(id) = value.strip_prefix("lib:")
            {
                let field = if id.bytes().all(|b| b.is_ascii_alphanumeric()) { format!("luts[id={id}]") } else { "luts".into() };
                want.premises.push(leaf(json!("project"), [field]));
            }
        }
    }
}
#[test]
fn render_consumers_compare_mix_graph_and_reference_frame_membership() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let clips = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"].as_array().unwrap().clone();
    let target = clips[0].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":item,"track":"V2","seconds":3})).unwrap();
    doc.execute("timeline.select", json!({"clips":[target],"linked":false})).unwrap();
    doc.execute("effects.apply", json!({"clips":[target],"effect":"color"})).unwrap();
    for enabled in [true, false] {
        doc.execute("timeline.setTrack", json!({"track":"V2","enabled":enabled})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        let mut mix = Under::default();
        mix.premises.push(
            leaf(
                json!(sequence),
                [
                    "~audioTrackOrder",
                    "~submixTrackOrder",
                    "sequence.masterVolumeDb",
                    "sequence.masterEffects",
                    "sequence.mixer",
                    "sequence.settings.settings.sample_rate",
                    "sequence.settings.settings.audio_master",
                ],
            )
            .positions(["sequence.duration"]),
        );
        for track in q.audio_tracks.iter().chain(&q.submix_tracks) {
            mix.premises
                .push(leaf(json!(track.id.0), ["volumeDb", "pan", "effects", "props.channels", "props.muted", "props.solo", "props.mixer", "~clipOrder"]));
            mix.premises.extend(track.transitions.iter().map(|tr| Premise::on(json!(tr.id.0))));
            for clip in &track.items {
                mix.premises.push(
                    leaf(
                        json!(clip.id.0),
                        [
                            "item",
                            "sourceIn",
                            "speed",
                            "reverse",
                            "gain",
                            "effects",
                            "props.enabled",
                            "props.frame_hold",
                            "props.audio_mixing.mute",
                            "props.source_channels",
                            "props.audio_stream",
                            "props.multicam",
                        ],
                    )
                    .positions(["start", "duration"]),
                );
                source(&mut mix, &project, clip.item);
            }
        }
        for db in [-12, 0] {
            assert_eq!(normalized(doc.under("sequence.normalizeMixTrack", &json!({"db":db})).unwrap().unwrap()), normalized(mix.clone()));
        }
        for at in [0, 254_016_000_000i64, 1_016_064_000_000i64] {
            let mut want = Under::default();
            want.premises.push(leaf(json!(sequence), ["sequence.settings.settings", "~videoTrackOrder"]));
            picture(&project, q.find_item(ClipId(target)).unwrap().1, &mut want);
            for track in &q.video_tracks {
                want.premises.push(leaf(json!(track.id.0), ["props.enabled"]));
                if !track.enabled {
                    continue;
                }
                for (field, spans) in [
                    ("clips", track.items.iter().map(|clip| (clip.start.0, clip.end().0)).collect::<Vec<_>>()),
                    ("transitions", track.transitions.iter().map(|tr| (tr.start.0, tr.end().0)).collect()),
                ] {
                    let from = spans.iter().take_while(|(_, end)| *end <= at).count();
                    let to = spans.iter().take_while(|(start, _)| *start <= at).count().max(from);
                    want.within.push(Within {
                        parent: json!(track.id.0),
                        field: field.into(),
                        from,
                        to,
                        time: Some(TimeSpan {
                            from: json!(at.to_string()),
                            to: json!((at + 1).to_string()),
                            start: "start".into(),
                            duration: Some("duration".into()),
                            ..Default::default()
                        }),
                    });
                }
                if let Some(clip) = track.items.iter().find(|clip| clip.start.0 <= at && at < clip.end().0) {
                    want.objects.push(json!(clip.id.0));
                    picture(&project, clip, &mut want);
                }
            }
            for explicit in [false, true] {
                for face in [false, true] {
                    let mut params = json!({"referenceTime":at,"faceDetection":face});
                    if explicit {
                        params["clip"] = json!(target)
                    }
                    assert_eq!(normalized(doc.under("color.applyMatch", &params).unwrap().unwrap()), normalized(want.clone()), "{params}");
                }
            }
        }
    }
}
