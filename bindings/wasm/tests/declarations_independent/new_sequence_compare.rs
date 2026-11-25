//! commands.rs:943-1009 creates an empty destination before placing the source.
//! The source supplies stored duration, optional inherited MediaInfo settings,
//! copied clip defaults, dimensions and channel mapping; old destinations do not.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("sequence.new", "plain"), ("sequence.new", "from-item")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x95526b4360647be4
        && hash(include_str!("../../../../crates/engine/project/src/lib.rs")) == 0x784d4865cb75caf9
}
pub fn more() -> Vec<&'static str> {
    vec!["coarse-mode-state"]
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
pub(super) fn expected(project: &Project, params: &Value, flattening: bool, facts: &[kition_kit::DerivedValues]) -> Under {
    let mut want = Under::default();
    if params.get("name").and_then(Value::as_str).is_none() {
        want.premises.push(Premise::on(json!("project")).fields(["~sequenceCount"]).positions(Vec::<String>::new()));
    }
    let Some(source) = params.get("fromItem").and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n as u64))).and_then(|id| project.item(ItemId(id))) else {
        return want;
    };
    let video = params["video"].as_f64() != Some(0.0);
    let audio = params["audio"].as_f64() != Some(0.0);
    let flattened = flattening && matches!(&source.kind,ItemKind::Sequence(q) if q.multicam.is_none());
    let mut fields = vec!["kind"];
    if !flattened {
        fields.extend(["name", "props.common.label"]);
        if video {
            fields.push("~sourceGraphicDefinition");
        }
    }
    match &source.kind {
        ItemKind::Media(_) => {
            fields.push("props.media.info.duration");
            for (key, field) in [
                ("width", "props.media.info.video.width"),
                ("height", "props.media.info.video.height"),
                ("fps", "props.media.info.video.frame_rate"),
                ("sampleRate", "props.media.info.audio_streams.0.sample_rate"),
            ] {
                if !params.get(key).is_some_and(Value::is_number) {
                    fields.push(field);
                }
            }
        }
        ItemKind::Subclip { .. } => fields.push("props.range.duration"),
        ItemKind::Sequence(_) => {
            fields.extend(["sequence.duration", "sequence.settings.multicam"]);
            if !flattened && audio {
                fields.push("~sourceHasAudio");
            }
        }
        ItemKind::AdjustmentLayer { .. } => fields.push("props.duration"),
        ItemKind::Graphic { .. } => {}
    }
    want.premises.push(leaf(source.id.0, fields));
    if flattened {
        let q = source.as_sequence().unwrap();
        for (enabled, tracks, field, name) in [
            (video, &q.video_tracks, "~newSequenceVideoMaterial", "newSequenceVideoMaterial"),
            (audio, &q.audio_tracks, "~newSequenceAudioMaterial", "newSequenceAudioMaterial"),
        ] {
            if !enabled {
                continue;
            }
            want.premises.push(leaf(source.id.0, [field]));
            // The full source range is [0,duration); nonempty lanes are copied
            // consecutively, retaining only transitions with copied endpoints.
            let end = q.duration();
            let mut lanes = Vec::new();
            for track in tracks {
                let clips: Vec<_> = track.items.iter().filter(|c| c.start < end && c.end().0 > 0).map(|c| c.id).collect();
                if clips.is_empty() {
                    continue;
                }
                let transitions: Vec<_> = track
                    .transitions
                    .iter()
                    .filter(|t| {
                        t.start.0 >= 0 && t.start + t.duration <= end && t.from.is_none_or(|c| clips.contains(&c)) && t.to.is_none_or(|c| clips.contains(&c))
                    })
                    .map(|t| t.id.0)
                    .collect();
                want.premises.extend(clips.iter().map(|id| Premise::on(json!(id.0))));
                want.premises.extend(transitions.iter().map(|id| Premise::on(json!(id))));
                lanes.push(json!({"clips":clips.iter().map(|c|c.0).collect::<Vec<_>>(),"transitions":transitions}));
            }
            assert_eq!(facts.iter().find(|fact| fact.id == json!(source.id.0)).unwrap().values[name], json!(lanes));
        }
        return want;
    }
    let mut current = source.id;
    for _ in 0..16 {
        let item = project.item(current).unwrap();
        let mut fields = vec!["kind"];
        let next = match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                fields.push("props.parent");
                Some(*parent)
            }
            ItemKind::Media(_) => {
                if video {
                    fields.extend(["props.media.info.video.width", "props.media.info.video.height"]);
                }
                if audio {
                    fields.push("~sourceAudioPlacement");
                }
                None
            }
            ItemKind::Sequence(_) => {
                if video {
                    fields.extend(["sequence.settings.settings.width", "sequence.settings.settings.height"]);
                }
                None
            }
            _ => {
                if video {
                    fields.extend(["props.width", "props.height"]);
                }
                None
            }
        };
        want.premises.push(leaf(current.0, fields));
        let Some(next) = next else { break };
        current = next;
    }
    want
}
#[test]
fn new_sequences_compare_empty_destinations_all_sources_parameter_overrides_and_flattened_material() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let nested = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let finite = doc.execute("item.newOfflineFile", json!({"name":"Finite","seconds":4})).unwrap()["item"].as_u64().unwrap();
    let first = doc.execute("timeline.place", json!({"item":finite,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    let second = doc.execute("timeline.razor", json!({"clip":first,"time":254_016_000_000i64})).unwrap()["clips"][0].clone();
    doc.execute("sequence.applyVideoTransition", json!({"clip":second,"edge":"in","frames":8})).unwrap();
    let adjustment = doc.execute("item.newAdjustmentLayer", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let synthetic = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let restricted = doc.execute("clip.makeSubclip", json!({"item":finite,"start":0,"end":508_032_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let open =
        doc.execute("clip.makeSubclip", json!({"item":restricted,"start":0,"end":254_016_000_000i64,"restrictTrims":false})).unwrap()["item"].as_u64().unwrap();
    let audio_only = doc.execute("item.newOfflineFile", json!({"name":"Audio","video":false,"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let graphic_clip = doc.execute("graphics.newText", json!({"newClip":true,"text":"Graphic","time":1_524_096_000_000i64})).unwrap()["clip"].as_u64().unwrap();
    let interim = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let graphic = interim.sequence(ItemId(nested)).unwrap().find_item(kition_film_engine::project::ClipId(graphic_clip)).unwrap().1.item.0;
    doc.execute("sequence.new", json!({"name":"Current"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let facts = doc.derived(&[json!(nested)], &["newSequenceVideoMaterial".into(), "newSequenceAudioMaterial".into()]).unwrap();
    for flatten in [false, true] {
        doc.execute("sequence.nestSequences", json!({"on":!flatten})).unwrap();
        for source in [None, Some(finite), Some(restricted), Some(open), Some(adjustment), Some(synthetic), Some(nested), Some(graphic), Some(audio_only)] {
            for name in [Value::Null, json!("Named")] {
                for video in [0, 1, 3] {
                    for audio in [0, 1, 3] {
                        for overrides in 0..16 {
                            let mut params = json!({"name":name,"video":video,"audio":audio});
                            if let Some(source) = source {
                                params["fromItem"] = json!(source);
                            }
                            for (n, (key, value)) in
                                [("width", json!(128)), ("height", json!(72)), ("fps", json!(30)), ("sampleRate", json!(44100))].into_iter().enumerate()
                            {
                                if overrides & (1 << n) != 0 {
                                    params[key] = value;
                                }
                            }
                            let spec = doc.commands().into_iter().find(|s| s.id == "sequence.new").unwrap();
                            assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.places.is_empty());
                            assert_eq!(spec.objects, vec!["fromItem"]);
                            assert_eq!(spec.object_types, vec![("fromItem", &["Item"][..])]);
                            assert_eq!(spec.reads, vec![EditorState::Mode]);
                            assert_eq!(
                                normalized(doc.under("sequence.new", &params).unwrap().unwrap()),
                                normalized(expected(&project, &params, flatten, &facts)),
                                "{params}/flatten={flatten}"
                            );
                        }
                    }
                }
            }
        }
    }
    for &(command, path) in PATHS {
        assert!(compared_path(command, path));
    }
}
