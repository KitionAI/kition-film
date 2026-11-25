//! commands.rs:1439-1448,2137-2171; keyboard.rs:66-103;
//! lib.rs:1229-1236 and sequence_tools.rs:252-260 supply snapping and
//! optional linked selection after every successful playhead assignment.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{EditorState, KitDocument, Premise, RelativeOrder, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const COMMANDS: &[&str] = &[
    "playhead.set",
    "playhead.step",
    "playhead.stepForward",
    "playhead.stepBack",
    "playhead.stepForward5",
    "playhead.stepBack5",
    "playhead.start",
    "playhead.end",
    "playhead.nextEdit",
    "playhead.prevEdit",
    "playhead.nextEditAnyTrack",
    "playhead.prevEditAnyTrack",
    "playhead.selectedClipStart",
    "playhead.selectedClipEnd",
    "edit.selectAll",
    "project.selectAll",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    COMMANDS.contains(&command)
        && path == if command.ends_with("selectAll") { if command.starts_with("project") { "all items" } else { "selection" } } else { "navigation" }
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x422d17df7f6d60c9
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && hash(include_str!("../../../../crates/engine/engine/src/lib.rs")) == 0x12037cc25ba5d4c9
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x848ed5aa3b9d96b3
}

pub fn more(command: &str) -> Vec<&'static str> {
    if command.ends_with("selectAll") {
        return vec!["coarse-selection-state", "unconsumed-selection"];
    }
    let mut classes = vec!["coarse-active-state", "coarse-mode-state", "coarse-time-state"];
    if command.contains("selectedClip") {
        classes.push("coarse-selection-state");
        if command.ends_with("Start") {
            classes.push("unused-selected-duration");
        }
    }
    classes
}

fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

#[test]
fn named_targeting_compares_identity_ordinals_and_default_membership() {
    for explicit in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        if explicit {
            doc.execute("timeline.setTargeting", json!({"track":"V1","targeted":true})).unwrap();
        }
        let seen = doc.inspect().unwrap()["sequence"].clone();
        for (kind, field) in [("video", "sequence.videoTracks"), ("audio", "sequence.audioTracks")] {
            for (index, track) in seen[kind].as_array().unwrap().iter().enumerate() {
                for ordinal in [false, true] {
                    let mut expected = Under::default();
                    if !explicit {
                        expected.premises.push(leaf(seen["id"].clone(), &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
                    }
                    let id = track["id"].clone();
                    let mut premise = leaf(id.clone(), &[]);
                    if ordinal {
                        premise = premise.positions([field]);
                    }
                    expected.premises.push(premise);
                    let value = if ordinal { json!(format!("{}{}", if kind == "video" { "V" } else { "A" }, index + 1)) } else { id };
                    for targeting in [json!({}), json!({"targeted":false}), json!({"sourcePatch":true}), json!({"targeted":true,"sourcePatch":false})] {
                        let mut params = targeting;
                        params["track"] = value.clone();
                        assert_eq!(normalized(doc.under("timeline.setTargeting", &params).unwrap().unwrap()), normalized(expected.clone()));
                    }
                }
            }
        }
    }
}

#[test]
fn following_navigation_declares_the_lane_order_used_to_build_selection() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    doc.execute("sequence.selectionFollowsPlayhead", json!({"on":true})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].clone();
    let under = normalized(doc.under("playhead.set", &json!({"time":0})).unwrap().unwrap());
    let held = under.premises.iter().find(|need| need.id == sequence).unwrap();
    for field in ["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"] {
        assert!(held.fields.as_ref().unwrap().iter().any(|held| held == field), "missing selection scan order {field}: {under:?}");
    }
}

fn expected(sequence: u64, command: &str, params: &Value, selected: &[u64], targets: &[u64], all: bool) -> Under {
    let mut out = Under::default();
    if command.ends_with("selectAll") {
        out.premises.push(if command.starts_with("project") { leaf(json!("project"), &["~itemIds"]) } else { leaf(json!(sequence), &["~clipIds"]) });
        return out;
    }
    out.premises.push(leaf(json!(sequence), &["sequence.settings.settings.frame_rate"]));
    if command == "playhead.set"
        && params.get("timecode").is_some()
        && params.get("time").and_then(Value::as_i64).is_none()
        && params.get("frame").and_then(Value::as_i64).is_none()
        && params.get("seconds").and_then(Value::as_f64).is_none()
    {
        out.premises.push(leaf(json!(sequence), &["sequence.settings.settings.drop_frame"]));
    }
    if command == "playhead.end" {
        out.premises.push(leaf(json!(sequence), &["sequence.duration"]));
    }
    if command.contains("selectedClip") {
        for &id in selected {
            out.premises.push(Premise::on(json!(id)).fields(Vec::<String>::new()).positions(["start", "duration"]));
        }
    }
    if command.contains("Edit") {
        if command.ends_with("AnyTrack") || all {
            out.premises.push(leaf(json!(sequence), &["~editPoints"]));
        } else {
            for &track in targets {
                out.premises.push(leaf(json!(track), &["~editPoints"]));
            }
        }
    }
    out
}

#[test]
fn navigation_compares_all_commands_parameters_selections_and_target_modes() {
    const SECOND: i64 = 254_016_000_000;
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let mut clips = Vec::new();
    for (time, track) in [(0, "V1"), (3 * SECOND, "V2")] {
        clips.extend(
            doc.execute("timeline.place", json!({"item":source,"time":time,"track":track})).unwrap()["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_u64().unwrap()),
        );
    }
    for follows in [false, true] {
        doc.execute("sequence.selectionFollowsPlayhead", json!({"on":follows})).unwrap();
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for targeted in [true, false] {
                for track in ["V1", "V2", "V3", "A1", "A2", "A3"] {
                    doc.execute("timeline.setTargeting", json!({"track":track,"targeted":targeted})).unwrap();
                }
                for time in [0, SECOND, 5 * SECOND] {
                    doc.execute("playhead.set", json!({"time":time})).unwrap();
                    for selected in [vec![], vec![clips[0]], clips.clone()] {
                        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                        let q = project.sequence(ItemId(sequence)).unwrap();
                        let targets: Vec<_> = if targeted { q.all_tracks().map(|track| track.id.0).collect() } else { vec![] };
                        for &command in COMMANDS {
                            let path = if command == "project.selectAll" {
                                "all items"
                            } else if command == "edit.selectAll" {
                                "selection"
                            } else {
                                "navigation"
                            };
                            assert!(compared_path(command, path));
                            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                            let mut reads = vec![EditorState::Part];
                            if command.contains("selectedClip") || command == "edit.selectAll" {
                                reads.push(EditorState::Selection);
                            }
                            if command == "project.selectAll" {
                                reads = vec![EditorState::Selection];
                            }
                            if command.starts_with("playhead") {
                                reads.extend([EditorState::Time, EditorState::Mode, EditorState::Active]);
                            }
                            assert_eq!(spec.reads, reads, "{command}");
                            assert_eq!(spec.enabled, !command.contains("selectedClip") || !selected.is_empty());
                            assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                            assert!(
                                spec.places.is_empty()
                                    && spec.name_params.is_empty()
                                    && spec.name_field.is_none()
                                    && spec.index.is_none()
                                    && !spec.index_numbers
                                    && !spec.index_reversed
                            );
                            for params in [
                                json!({}),
                                json!({"time":SECOND}),
                                json!({"frame":12,"frames":-3}),
                                json!({"seconds":1.5,"frames":4}),
                                json!({"timecode":"00:00:01:00"}),
                                json!({"time":null,"frame":null,"seconds":null,"timecode":"00:00:01:00"}),
                                json!({"time":0,"frame":12,"seconds":1.5,"timecode":"00:00:01:00"}),
                            ] {
                                let mut want = expected(sequence, command, &params, &selected, &targets, !targeted);
                                if follows && command.starts_with("playhead") {
                                    for (tracks, field) in [
                                        (&q.video_tracks, "sequence.videoTracks"),
                                        (&q.audio_tracks, "sequence.audioTracks"),
                                        (&q.submix_tracks, "sequence.submixTracks"),
                                    ] {
                                        let objects: Vec<_> =
                                            tracks.iter().filter(|track| targets.contains(&track.id.0)).map(|track| json!(track.id.0)).collect();
                                        if objects.len() > 1 {
                                            want.orders.push(RelativeOrder { parent: json!(sequence), field: field.into(), objects });
                                        }
                                    }
                                    let mut engine = doc.fork_for_premises().unwrap();
                                    let valid_params = Value::Object(
                                        params
                                            .as_object()
                                            .unwrap()
                                            .iter()
                                            .filter(|(key, _)| spec.schema.as_ref().is_some_and(|schema| schema.get(*key).is_some()))
                                            .map(|(key, value)| (key.clone(), value.clone()))
                                            .collect(),
                                    );
                                    if engine.execute(command, valid_params).is_ok() {
                                        let at = engine.inspect().unwrap()["playhead"].as_i64().unwrap();
                                        for track in q.all_tracks().filter(|track| targets.contains(&track.id.0)) {
                                            let from = track.items.iter().take_while(|clip| clip.end() <= Tick(at)).count();
                                            let to = track.items.iter().take_while(|clip| clip.start <= Tick(at)).count().max(from);
                                            want.within.push(Within {
                                                parent: json!(track.id.0),
                                                field: "clips".into(),
                                                from,
                                                to,
                                                time: Some(TimeSpan {
                                                    from: json!(at.to_string()),
                                                    to: json!(at.to_string()),
                                                    start: "start".into(),
                                                    duration: Some("duration".into()),
                                                    ..Default::default()
                                                }),
                                            });
                                            for clip in &track.items[from..to] {
                                                want.premises
                                                    .push(Premise::on(json!(clip.id.0)).fields(["link", "~linkedGroup"]).positions(["start", "duration"]));
                                                if linked && let Some(link) = clip.link {
                                                    let root = q
                                                        .all_tracks()
                                                        .flat_map(|track| &track.items)
                                                        .filter(|peer| peer.link == Some(link))
                                                        .map(|peer| peer.id.0)
                                                        .min()
                                                        .unwrap();
                                                    want.premises.push(leaf(json!(root), &["~linkedMembers"]));
                                                }
                                            }
                                        }
                                    }
                                }
                                assert_eq!(
                                    normalized(doc.under(command, &params).unwrap().unwrap()),
                                    normalized(want),
                                    "{command}/{params}/follows={follows}/linked={linked}/targeted={targeted}/time={time}/selected={selected:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let q = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let clip_ids = q.sequence(ItemId(sequence)).unwrap().all_tracks().flat_map(|track| &track.items).map(|clip| clip.id.0).collect::<Vec<_>>();
    let item_ids = q.items.keys().map(|item| item.0).collect::<Vec<_>>();
    for (id, name, value) in [(json!("project"), "itemIds", json!(item_ids)), (json!(sequence), "clipIds", json!(clip_ids))] {
        let facts = doc.derived(std::slice::from_ref(&id), &[name.into()]).unwrap();
        assert_eq!(facts.iter().find(|fact| fact.id == id).unwrap().values[name], value);
    }
}
