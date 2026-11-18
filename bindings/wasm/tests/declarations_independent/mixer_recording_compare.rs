//! mixer.rs:245-447,530-545,702-744,1022-1045. A recording pass
//! addresses its own sequence and can switch every Write strip to Touch.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("mixer.setValue", "no automation pass"),
    ("mixer.setValue", "active pass"),
    ("mixer.release", "outside pass held control"),
    ("mixer.release", "active pass"),
    ("mixer.recordStop", "track lanes"),
    ("mixer.recordStop", "clip lanes"),
    ("clipMixer.set", "static/keyframe"),
    ("clipMixer.release", "outside pass"),
    ("clipMixer.release", "active pass"),
    ("mixer.addSubmix", "append"),
    ("mixer.deleteSubmix", "reroute dependants"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path)) && hash(include_str!("../../../../crates/engine/engine/src/mixer.rs")) == 0x7ae1144863e26736
}
pub fn more(command: &str) -> Vec<&'static str> {
    match command {
        "mixer.addSubmix" => vec!["submix-reference-order"],
        "mixer.deleteSubmix" => vec!["named-strip-position", "whole-removed-send-suffix"],
        "clipMixer.set" => vec!["whole-clip-mixer-target"],
        "clipMixer.release" => vec!["coarse-mode-state", "whole-clip-mixer-effect-profile", "whole-recorded-clip-order"],
        "mixer.recordStop" => vec!["coarse-mode-state", "whole-recorded-clip-lane", "whole-mixer-lane", "coarse-recording-track-order"],
        _ => vec!["named-strip-position", "coarse-mode-state", "whole-mixer-lane", "whole-mixer-static-value"],
    }
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn stored(sequence: u64, strip: Option<u64>, field: &str) -> Premise {
    let field = if strip.is_some() {
        field.to_owned()
    } else {
        match field {
            "volumeDb" => "sequence.masterVolumeDb".into(),
            "pan" => return leaf(sequence, Vec::<String>::new()),
            "props.muted" => return leaf(sequence, Vec::<String>::new()),
            field => field.replacen("props.mixer", "sequence.mixer.master_mixer", 1),
        }
    };
    leaf(strip.unwrap_or(sequence), [field])
}
fn lane(sequence: u64, strip: Option<u64>, name: &str, want: &mut Under) {
    want.premises.push(stored(sequence, strip, &format!("props.mixer.lanes.{name}")));
    want.premises.push(stored(
        sequence,
        strip,
        match name {
            "pan" => "pan",
            "mute" => "props.muted",
            _ => "volumeDb",
        },
    ));
}
fn fixture() -> (FilmDocument, u64, u64, u64, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seen = doc.inspect().unwrap();
    let sequence = seen["sequence"]["id"].as_u64().unwrap();
    let audio = seen["sequence"]["audio"][0]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"audioTrack":"A1","time":0,"video":false})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_u64()
        .unwrap();
    let bus = doc.execute("mixer.addSubmix", json!({"name":"Bus"})).unwrap()["id"].as_u64().unwrap();
    (doc, sequence, audio, bus, clip)
}

#[test]
fn mixer_controls_compare_named_master_and_numeric_addresses_with_and_without_passes() {
    for active in [false, true] {
        let (mut doc, sequence, audio, bus, clip) = fixture();
        for id in [audio, bus] {
            doc.execute("mixer.setStrip", json!({"strip":id,"mode":"Touch"})).unwrap();
        }
        if active {
            doc.execute("mixer.recordStart", json!({"time":0})).unwrap();
        }
        for command in ["mixer.setValue", "mixer.release"] {
            for (strip, address) in [(Some(audio), json!(audio)), (Some(audio), json!("A1")), (Some(bus), json!(bus)), (None, json!("Mix"))] {
                for key in ["strip", "track"] {
                    for name in ["volume", "pan", "mute"] {
                        let mut p = json!({"lane":name,"value":-6,"time":0});
                        p[key] = address.clone();
                        let mut want = Under::default();
                        want.premises.push(leaf(strip.unwrap_or(sequence), Vec::<String>::new()));
                        if let Some(strip) = strip.filter(|_| address.is_string()) {
                            want.objects.push(json!(strip));
                            want.premises.push(Premise::on(json!(strip)).fields(Vec::<String>::new()));
                        }
                        lane(sequence, strip, name, &mut want);
                        want.premises.push(stored(sequence, strip, "props.mixer.mode"));
                        let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                        assert_eq!(spec.reads, vec![EditorState::Part, EditorState::Time, EditorState::Mode]);
                        assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/active={active}");
                    }
                }
            }
        }
        for keyframe in [false, true] {
            let spec = doc.commands().into_iter().find(|s| s.id == "clipMixer.set").unwrap();
            assert_eq!(spec.targets, Some("clip"));
            assert_eq!(spec.reads, vec![EditorState::Part, EditorState::Time]);
            assert_eq!(doc.under("clipMixer.set", &json!({"clip":clip,"value":-6,"keyframe":keyframe,"time":0})).unwrap(), Some(Under::default()));
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
            let mut want = Under::default();
            want.premises.push(leaf(audio, Vec::<String>::new()));
            if !active {
                want.premises.push(leaf(audio, ["~clipOrder"]));
                for clip in q.audio_tracks[0].items.iter().filter(|clip| clip.start.0 <= time && time < clip.end().0) {
                    want.premises.push(leaf(clip.id.0, ["effects", "sourceIn", "speed", "reverse", "props.frame_hold"]).positions(["start", "duration"]));
                }
            }
            let spec = doc.commands().into_iter().find(|s| s.id == "clipMixer.release").unwrap();
            assert_eq!(spec.reads, vec![EditorState::Part, EditorState::Time, EditorState::Mode]);
            assert_eq!(normalized(doc.under("clipMixer.release", &json!({"track":audio,"time":time})).unwrap().unwrap()), normalized(want));
        }
    }
}

#[test]
fn recorded_lanes_compare_modes_sampling_and_clip_source_mappings() {
    for clip_lane in [false, true] {
        let (mut doc, sequence, audio, _, _) = fixture();
        doc.execute("mixer.setStrip", json!({"strip":audio,"mode":"Touch"})).unwrap();
        doc.execute("clipMixer.setMode", json!({"track":audio,"mode":"Touch"})).unwrap();
        doc.execute("mixer.recordStart", json!({"time":0})).unwrap();
        let mut touch = json!({"lane":"volume","value":-6,"time":1});
        touch[if clip_lane { "track" } else { "strip" }] = json!(audio);
        doc.execute(if clip_lane { "clipMixer.touch" } else { "mixer.touch" }, touch).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        let mut want = Under::default();
        want.premises.push(leaf(sequence, ["sequence.settings.settings.sample_rate", "~audioTrackOrder", "~submixTrackOrder"]));
        for id in q.strip_ids() {
            want.premises.push(stored(sequence, (id.0 != u64::MAX).then_some(id.0), "props.mixer.mode"));
        }
        if clip_lane {
            want.premises.push(leaf(audio, ["~clipOrder"]));
            for clip in &q.audio_tracks[0].items {
                want.premises.push(leaf(clip.id.0, ["effects", "sourceIn", "speed", "reverse", "props.frame_hold"]).positions(["start", "duration"]));
            }
        } else {
            lane(sequence, Some(audio), "volume", &mut want);
        }
        assert_eq!(normalized(doc.under("mixer.recordStop", &json!({"time":254_016_000_000i64})).unwrap().unwrap()), normalized(want));
        assert_eq!(doc.fork_for_premises().unwrap().editor_state()["mode"], doc.editor_state()["mode"]);
    }
}

#[test]
fn submix_append_and_removal_compare_references_removed_content_and_all_dependants() {
    let (mut doc, sequence, audio, bus, _) = fixture();
    doc.execute("mixer.setStrip", json!({"strip":audio,"output":bus})).unwrap();
    doc.execute("mixer.addSend", json!({"strip":audio,"target":bus})).unwrap();
    for name in [Value::Null, json!("Named")] {
        assert_eq!(
            doc.under("mixer.addSubmix", &json!({"name":name})).unwrap(),
            Some(Under { premises: vec![leaf(sequence, ["~submixTrackOrder"])], ..Default::default() })
        );
    }
    let mut want = Under::default();
    want.premises.push(Premise::on(json!(bus)));
    want.premises.push(leaf(audio, ["props.mixer.output", "props.mixer.sends.0", "props.mixer.lanes"]));
    want.premises.push(Premise::on(json!(format!("fact:{bus}:~submixDependants"))).fields(["value"]).positions(Vec::<String>::new()));
    assert_eq!(normalized(doc.under("mixer.deleteSubmix", &json!({"strip":bus})).unwrap().unwrap()), normalized(want));
    let facts = doc.derived(&[json!(bus)], &["submixDependants".into()]).unwrap();
    assert_eq!(facts.iter().find(|fact| fact.id == bus).unwrap().values["submixDependants"], json!([{"strip":audio,"output":true,"sends":[0]}]));
    for &(command, path) in PATHS {
        assert!(compared_path(command, path));
    }
}
