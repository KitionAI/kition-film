//! mixer.rs:640-1015 and project/mixer.rs:243-270,320-390.
//! Inserts own their effect parameters and automation. Review correction to
//! effects.rs's removeInsert row: remove_insert:320-328 changes only effects;
//! its automation is stored inside each effect, not the strip lane map.
use super::sync_compare::normalized;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("mixer.setStrip", "settings assignment"),
    ("mixer.addInsert", "insertion index/gap"),
    ("mixer.removeInsert", "slot index"),
    ("mixer.setInsert", "slot/params"),
    ("mixer.addSend", "target and append gap"),
    ("mixer.setSend", "send index"),
    ("mixer.removeSend", "send index"),
    ("mixer.setKeyframe", "key at time"),
    ("mixer.deleteKeyframe", "key at exact time"),
    ("mixer.moveKeyframe", "key at time and adjacent key bounds"),
    ("mixer.clearLane", "evaluated value at playhead"),
    ("mixer.writeAutomation", "range replacement"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/mixer.rs")) == 0x7ae1144863e26736
        && hash(include_str!("../../../../crates/engine/project/src/mixer.rs")) == 0xc73eabe828c4cf9b
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut more = vec!["named-strip-position"];
    match command {
        "mixer.setStrip" => more.extend(["unused-strip-playhead", "unpersisted-master-fields", "coarse-mode-state"]),
        "mixer.addInsert" | "mixer.removeInsert" => more.push("whole-insert-list"),
        "mixer.setSend" => more.push("unassigned-send-target"),
        "mixer.addSend" => more.push("whole-send-list"),
        "mixer.removeSend" => more.extend(["whole-send-list", "whole-mixer-lane-map"]),
        "mixer.setKeyframe" | "mixer.deleteKeyframe" | "mixer.moveKeyframe" | "mixer.clearLane" | "mixer.writeAutomation" => {
            more.extend(["whole-mixer-lane", "whole-mixer-static-value"]);
            if matches!(command, "mixer.deleteKeyframe" | "mixer.moveKeyframe") {
                more.push("unused-strip-playhead");
            }
        }
        _ => {}
    }
    more
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

fn strip_field(sequence: u64, strip: Option<u64>, name: &str) -> Option<Premise> {
    if let Some(strip) = strip {
        return Some(leaf(strip, [name]));
    }
    let physical = match name {
        "volumeDb" => "sequence.masterVolumeDb".into(),
        "props.channels" => "sequence.settings.settings.audio_master".into(),
        "effects" => "sequence.mixer.master_effects".into(),
        s if s.starts_with("effects.") => s.replacen("effects.", "sequence.mixer.master_effects.", 1),
        s if s.starts_with("props.mixer") => s.replacen("props.mixer", "sequence.mixer.master_mixer", 1),
        _ => return None,
    };
    Some(leaf(sequence, [physical]))
}

fn addressed(sequence: u64, strip: Option<u64>, spelling: &Value) -> Under {
    let mut want = Under::default();
    want.premises.push(leaf(strip.unwrap_or(sequence), Vec::<String>::new()));
    if let Some(strip) = strip.filter(|_| spelling.is_string()) {
        want.objects.push(json!(strip));
        want.premises.push(Premise::on(json!(strip)).fields(Vec::<String>::new()));
    }
    want
}

fn fixture() -> (FilmDocument, u64, u64, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seen = doc.inspect().unwrap()["sequence"].clone();
    let sequence = seen["id"].as_u64().unwrap();
    let audio = seen["audio"][0]["id"].as_u64().unwrap();
    doc.execute("mixer.setStrip", json!({"strip":audio,"name":"Dialogue"})).unwrap();
    let bus = doc.execute("mixer.addSubmix", json!({"name":"Bus"})).unwrap()["id"].as_u64().unwrap();
    for strip in [json!(audio), json!(bus), json!("Mix")] {
        for _ in 0..2 {
            doc.execute("mixer.addInsert", json!({"strip":strip,"effect":"studio_reverb"})).unwrap();
        }
        if strip == json!(audio) {
            doc.execute("mixer.addSend", json!({"strip":strip,"target":bus})).unwrap();
        }
    }
    (doc, sequence, audio, bus)
}

fn spec(doc: &FilmDocument, command: &str) {
    let s = doc.commands().into_iter().find(|s| s.id == command).unwrap();
    assert!(s.enabled && s.mutates && s.targets.is_none() && s.name_field.is_none() && s.index.is_none() && !s.index_numbers && !s.index_reversed);
    let timed = matches!(command, "mixer.setStrip" | "mixer.setKeyframe" | "mixer.deleteKeyframe" | "mixer.moveKeyframe" | "mixer.clearLane");
    assert_eq!(
        s.reads,
        if command == "mixer.setStrip" {
            vec![EditorState::Part, EditorState::Time, EditorState::Mode]
        } else if timed {
            vec![EditorState::Part, EditorState::Time]
        } else {
            vec![EditorState::Part]
        }
    );
    let placed = matches!(command, "mixer.setKeyframe" | "mixer.deleteKeyframe" | "mixer.moveKeyframe");
    assert_eq!(s.places, if placed { vec!["time"] } else { vec![] });
    let objects = match command {
        "mixer.setStrip" => vec!["output", "strip", "track"],
        "mixer.addSend" | "mixer.setSend" => vec!["strip", "target", "track"],
        _ => vec!["strip", "track"],
    };
    assert_eq!(s.objects, objects);
    assert_eq!(s.object_types, objects.iter().map(|key| (*key, &["Track"][..])).collect::<Vec<_>>());
    assert_eq!(s.name_params, objects.iter().map(|key| (*key, "props.name")).collect::<Vec<_>>());
}

#[test]
fn mixer_patches_compare_all_assignments_aliases_master_storage_and_routing() {
    let (doc, sequence, audio, bus) = fixture();
    let patches = [
        ("name", "props.name", json!("Assigned")),
        ("volumeDb", "volumeDb", json!(-12)),
        ("pan", "pan", json!(25)),
        ("muted", "props.muted", json!(true)),
        ("solo", "props.solo", json!(true)),
        ("recordArm", "props.mixer.record_arm", json!(true)),
        ("soloSafe", "props.mixer.solo_safe", json!(true)),
        ("mode", "props.mixer.mode", json!("Off")),
        ("inputMap", "props.mixer.input_map", json!("Swap")),
        ("channels", "props.channels", json!("Mono")),
        ("output", "props.mixer.output", Value::Null),
    ];
    spec(&doc, "mixer.setStrip");
    assert!(compared_path("mixer.setStrip", "settings assignment"));
    for (strip, addresses) in [
        (Some(audio), vec![json!(audio), json!("A1"), json!("a1"), json!("DIALOGUE")]),
        (Some(bus), vec![json!(bus), json!("S1"), json!("bus")]),
        (None, vec![json!("Mix"), json!("master"), json!(u64::MAX)]),
    ] {
        for address in addresses {
            for key in ["strip", "track"] {
                for mask in 0..1usize << patches.len() {
                    let mut p = json!({});
                    p[key] = address.clone();
                    let mut want = addressed(sequence, strip, &address);
                    for (index, (param, physical, value)) in patches.iter().enumerate() {
                        if mask & (1 << index) != 0 {
                            p[param] = value.clone();
                            want.premises.extend(strip_field(sequence, strip, physical));
                        }
                    }
                    assert_eq!(normalized(doc.under("mixer.setStrip", &p).unwrap().unwrap()), normalized(want), "{p}");
                }
            }
        }
    }
    for command in ["mixer.setStrip", "mixer.addSend", "mixer.setSend"] {
        for (target, named) in [(json!(bus), false), (json!("S1"), true), (json!("BUS"), true)] {
            let mut p = json!({"strip":audio,"send":0});
            p[if command == "mixer.setStrip" { "output" } else { "target" }] = target;
            let mut want = addressed(sequence, Some(audio), &json!(audio));
            let fields = match command {
                "mixer.setStrip" => vec!["props.mixer.output"],
                "mixer.addSend" => vec!["props.mixer.sends"],
                _ => vec!["props.mixer.sends.0.target"],
            };
            want.premises.push(leaf(audio, fields));
            want.premises.push(leaf(bus, Vec::<String>::new()));
            // The scoped routing projection retains its owner's identity.
            want.premises.push(leaf(sequence, Vec::<String>::new()));
            want.premises.push(Premise::on(json!(format!("fact:{sequence}:~mixerRoutes.{audio}_{bus}"))).fields(["value"]).positions(Vec::<String>::new()));
            if named {
                want.objects.push(json!(bus));
                want.premises.push(Premise::on(json!(bus)).fields(Vec::<String>::new()).positions(["sequence.submixTracks"]));
            }
            assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}");
        }
    }
}

#[test]
fn inserts_sends_and_lanes_compare_index_fields_parameter_types_and_keyframe_routes() {
    let (doc, sequence, audio, bus) = fixture();
    for &(command, path) in &PATHS[1..] {
        assert!(compared_path(command, path));
        spec(&doc, command);
        for (strip, addresses) in
            [(Some(audio), vec![json!(audio), json!("Dialogue")]), (Some(bus), vec![json!(bus), json!("S1")]), (None, vec![json!("Mix"), json!("master")])]
        {
            for address in addresses {
                for index in [0, 1, 2, 99] {
                    for lane in ["volume", "pan", "mute", "pan51.x", "send.0.level", "send.1.level", "fx.0.wet", "fx.1.room"] {
                        for mask in 0..8 {
                            let mut p = json!({"strip":address,"slot":index,"send":index,"lane":lane,"time":1,"newTime":2,"value":-9,"effect":"studio_reverb","points":[[1,-9],[2,-6]]});
                            let mut want = addressed(sequence, strip, &address);
                            let mut fields = Vec::new();
                            match command {
                                "mixer.addInsert" | "mixer.removeInsert" => fields.push("effects".into()),
                                "mixer.setInsert" => {
                                    fields.push(format!("effects.{index}.def"));
                                    let prefix = if strip.is_none() { "" } else { "params." };
                                    if mask & 1 != 0 {
                                        p["enabled"] = json!(false);
                                        fields.push(format!("effects.{index}.{prefix}enabled"));
                                    }
                                    if mask & 2 != 0 {
                                        p["postFader"] = json!(true);
                                        fields.push(format!("effects.{index}.{prefix}post_fader"));
                                    }
                                    if mask & 4 != 0 {
                                        p["params"] = json!({"wet":15,"room":25});
                                        fields.extend(["wet", "room"].map(|param| format!("effects.{index}.{prefix}params.{param}.value")));
                                    }
                                }
                                "mixer.addSend" | "mixer.removeSend" => {
                                    fields.push("props.mixer.sends".into());
                                    if command == "mixer.removeSend" {
                                        fields.push("props.mixer.lanes".into());
                                    }
                                }
                                "mixer.setSend" => {
                                    fields.push(format!("props.mixer.sends.{index}.target"));
                                    for (bit, param, physical, value) in
                                        [(1, "levelDb", "level_db", json!(-9)), (2, "pan", "pan", json!(25)), (4, "preFader", "pre_fader", json!(true))]
                                    {
                                        if mask & bit != 0 {
                                            p[param] = value;
                                            fields.push(format!("props.mixer.sends.{index}.{physical}"));
                                        }
                                    }
                                    p["muted"] = json!(false);
                                    fields.push(format!("props.mixer.sends.{index}.muted"));
                                }
                                _ => {
                                    if let Some(rest) = lane.strip_prefix("fx.") {
                                        let (slot, param) = rest.split_once('.').unwrap();
                                        fields.push(format!("effects.{slot}.def"));
                                        fields.push(format!("effects.{slot}.{}params.{param}", if strip.is_none() { "" } else { "params." }));
                                    } else {
                                        fields.push(if lane.contains('.') { "props.mixer.lanes".into() } else { format!("props.mixer.lanes.{lane}") });
                                        fields.push(match lane {
                                            "volume" => "volumeDb".into(),
                                            "pan" => "pan".into(),
                                            "mute" => "props.muted".into(),
                                            s if s.starts_with("send.") => format!("props.mixer.sends.{}", s.split('.').nth(1).unwrap()),
                                            _ => "props.channels".into(),
                                        });
                                    }
                                    if matches!(command, "mixer.clearLane" | "mixer.writeAutomation") {
                                        fields.push("props.mixer.mode".into());
                                    }
                                    if command == "mixer.writeAutomation" {
                                        want.premises.push(leaf(sequence, ["sequence.settings.settings.sample_rate"]));
                                    }
                                }
                            }
                            for physical in fields {
                                want.premises.extend(strip_field(sequence, strip, &physical));
                            }
                            assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}");
                        }
                    }
                }
            }
        }
    }
}
