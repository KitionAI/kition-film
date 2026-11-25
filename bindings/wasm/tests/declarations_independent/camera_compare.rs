//! multicam.rs:682-780,1002-1110 and project/src/multicam.rs:83-176.
//! Camera names are display metadata; effective identities, flags and ordinal
//! membership are inputs even when the source changes representation.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, Project, TrackItem};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::json;

#[path = "camera_recording_compare.rs"]
mod recording;

pub const SWITCHES: &[&str] = &[
    "multicam.switchAngle",
    "multicam.cut",
    "multicam.selectCamera1",
    "multicam.selectCamera2",
    "multicam.selectCamera3",
    "multicam.selectCamera4",
    "multicam.selectCamera5",
    "multicam.selectCamera6",
    "multicam.selectCamera7",
    "multicam.selectCamera8",
    "multicam.selectCamera9",
    "multicam.cutToCamera",
    "multicam.cutToCamera1",
    "multicam.cutToCamera2",
    "multicam.cutToCamera3",
    "multicam.cutToCamera4",
    "multicam.cutToCamera5",
    "multicam.cutToCamera6",
    "multicam.cutToCamera7",
    "multicam.cutToCamera8",
    "multicam.cutToCamera9",
];
pub const EXTRA: &[(&str, &str)] = &[
    ("clip.multicamEnable", "toggle/absolute"),
    ("multicam.editCameras", "explicit/default"),
    ("multicam.page", "editor"),
    ("multicam.nextPage", "editor"),
    ("multicam.prevPage", "editor"),
];
pub const PATH_COUNT: usize = 2 * SWITCHES.len() + EXTRA.len();

fn recording_command(command: &str) -> bool {
    command == "multicam.recordStop" || command != "multicam.switchAngle" && SWITCHES.contains(&command)
}

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    (SWITCHES.contains(&command) && path == "stopped switch/cut" || EXTRA.contains(&(command, path)) || path == "recording" && recording_command(command))
        && hash(include_str!("../../../../crates/engine/engine/src/multicam.rs")) == 0xca49dbd431e8f30e
        && hash(include_str!("../../../../crates/engine/project/src/multicam.rs")) == 0x4f7b7179149ec391
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    if path == "recording" {
        let mut classes = vec!["coarse-mode-state", "coarse-time-state", "whole-recorded-lane-material"];
        if command != "multicam.recordStop" {
            classes.extend(["coarse-selection-state", "coarse-active-state", "coarse-camera-map", "coarse-camera-lookup", "unconsumed-audio-candidates"]);
        }
        return classes;
    }
    let page = matches!(command, "multicam.page" | "multicam.nextPage" | "multicam.prevPage");
    let mut classes = vec!["coarse-mode-state"];
    if !page && command != "multicam.editCameras" {
        classes.push("coarse-selection-state");
    }
    if command == "clip.multicamEnable" {
        classes.extend(["coarse-camera-map", "unused-camera-link"]);
    } else {
        classes.extend(["coarse-active-state", "coarse-time-state", "coarse-camera-lookup"]);
        if command != "multicam.editCameras" {
            classes.push("coarse-camera-map");
            if !page {
                classes.push("unconsumed-audio-candidates");
            }
        } else {
            classes.push("unconsumed-camera-video-track");
        }
    }
    if SWITCHES.contains(&command) && command != "multicam.switchAngle" {
        classes.push("unconsumed-program-material");
    }
    classes
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

fn window(track: &kition_film_engine::project::Track, time: i64) -> Within {
    let from = track.items.iter().take_while(|clip| clip.end().0 <= time).count();
    let to = track.items.iter().take_while(|clip| clip.start.0 <= time).count().max(from);
    Within {
        parent: json!(track.id.0),
        field: "clips".into(),
        from,
        to,
        time: Some(TimeSpan {
            from: json!(time.to_string()),
            to: json!(time.to_string()),
            start: "start".into(),
            duration: Some("duration".into()),
            ..Default::default()
        }),
    }
}

fn at(track: &kition_film_engine::project::Track, time: i64) -> Option<&TrackItem> {
    track.items.iter().find(|clip| clip.start.0 <= time && time < clip.end().0)
}

fn winner(project: &Project, sequence: u64, time: i64, targeted: &[u64], top_down: bool) -> Option<u64> {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let mut tracks: Vec<_> = q.video_tracks.iter().collect();
    if top_down {
        tracks.reverse();
    }
    tracks.iter().filter(|track| targeted.contains(&track.id.0)).chain(&tracks).find_map(|track| {
        at(track, time).filter(|clip| clip.multicam.is_some_and(|camera| camera.enabled) && project.sequence(clip.item).is_some()).map(|clip| clip.id.0)
    })
}

fn fixture(explicit: bool) -> (FilmDocument, u64, u64, Vec<u64>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("sequence.new", json!({"name":"Cameras","video":9,"audio":2})).unwrap()["sequence"].as_u64().unwrap();
    let bars = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":bars,"track":"V1","time":0})).unwrap();
    doc.execute("sequence.open", json!({"item":sequence})).unwrap();
    let clips = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0,"duration":508_032_000_000i64})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect::<Vec<_>>();
    let second =
        doc.execute("timeline.place", json!({"item":source,"track":"V2","audio":false,"time":0,"duration":508_032_000_000i64})).unwrap()["clips"][0].clone();
    doc.execute("clip.multicamEnable", json!({"clips":clips,"enabled":true})).unwrap();
    doc.execute("clip.multicamEnable", json!({"clips":[second],"enabled":true})).unwrap();
    let ordinary = doc.execute("item.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":ordinary,"track":"V3","time":0})).unwrap();
    if explicit {
        let mut loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
        let q = loaded.project.sequence_mut(ItemId(source)).unwrap();
        let mut map = q.cameras();
        map.cameras[2].enabled = false;
        q.multicam = Some(map);
        doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&loaded.project, true)).unwrap();
    }
    (doc, sequence, source, clips)
}

fn lookup(project: &Project, sequence: u64, time: i64, out: &mut Under) {
    let q = project.sequence(ItemId(sequence)).unwrap();
    out.premises.push(leaf(sequence, ["~videoTrackOrder"]));
    for track in &q.video_tracks {
        out.within.push(window(track, time));
        if let Some(clip) = at(track, time) {
            out.premises.push(leaf(clip.id.0, ["item", "props.multicam"]));
            out.premises.push(leaf(clip.item.0, ["kind"]));
        }
    }
}

#[test]
fn camera_switch_and_enable_compare_addresses_link_modes_sources_and_all_fixed_keys() {
    for explicit_source in [false, true] {
        let (mut doc, sequence, source, clips) = fixture(explicit_source);
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for top_down in [false, true] {
                doc.execute("multicam.selectionTopDown", json!({"enabled":top_down})).unwrap();
                for follows in [false, true] {
                    doc.execute("multicam.audioFollowsVideo", json!({"enabled":follows})).unwrap();
                    for targeted in [vec![], vec![q.video_tracks[0].id.0], q.all_tracks().map(|track| track.id.0).collect()] {
                        for track in q.all_tracks() {
                            doc.execute("timeline.setTargeting", json!({"track":track.id.0,"targeted":targeted.contains(&track.id.0)})).unwrap();
                        }
                        for requested in [0, 254_016_000_000i64, 762_048_000_000i64] {
                            doc.execute("playhead.set", json!({"time":requested})).unwrap();
                            let time = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                            doc.execute("timeline.select", json!({"clips":[clips[0]],"linked":false})).unwrap();
                            for command in SWITCHES.iter().copied().chain(["clip.multicamEnable"]) {
                                assert!(compared_path(command, if command == "clip.multicamEnable" { "toggle/absolute" } else { "stopped switch/cut" }));
                                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                                assert!(spec.enabled && spec.mutates && spec.objects.is_empty());
                                assert_eq!(
                                    spec.reads,
                                    if command == "clip.multicamEnable" {
                                        vec![EditorState::Part, EditorState::Selection, EditorState::Mode]
                                    } else {
                                        vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode, EditorState::Active]
                                    }
                                );
                                let named_targets = matches!(command, "clip.multicamEnable" | "multicam.switchAngle");
                                assert_eq!(spec.targets, named_targets.then_some("clips"));
                                assert_eq!(spec.object_types, if named_targets { vec![("clips", &["Clip"][..])] } else { vec![] });
                                assert_eq!(spec.places, if matches!(command, "multicam.cut" | "multicam.cutToCamera") { vec!["time"] } else { vec![] });
                                assert!(
                                    spec.name_params.is_empty()
                                        && spec.name_field.is_none()
                                        && spec.index.is_none()
                                        && !spec.index_numbers
                                        && !spec.index_reversed
                                );
                                for named in [false, true] {
                                    if named && command != "multicam.switchAngle" && command != "clip.multicamEnable" {
                                        continue;
                                    }
                                    for audio_only in [false, true] {
                                        for video_only in [false, true] {
                                            let mut params = json!({});
                                            if matches!(command, "multicam.switchAngle" | "multicam.cut" | "multicam.cutToCamera") {
                                                params["camera"] = json!(2);
                                            }
                                            if command == "multicam.switchAngle" {
                                                params["audioOnly"] = json!(audio_only);
                                            }
                                            if command == "clip.multicamEnable" {
                                                params["enabled"] = json!(!audio_only);
                                            } else {
                                                params["videoOnly"] = json!(video_only);
                                            }
                                            if named {
                                                params["clips"] = json!([clips[0]]);
                                            }
                                            let keyboard = command != "multicam.switchAngle" && command != "clip.multicamEnable";
                                            let mut expected = Under::default();
                                            if !named && command != "clip.multicamEnable" {
                                                lookup(&project, sequence, time, &mut expected);
                                            }
                                            if keyboard {
                                                for track in q.all_tracks() {
                                                    expected.within.push(window(track, time));
                                                    if let Some(clip) = at(track, time) {
                                                        expected.objects.push(json!(clip.id.0));
                                                    }
                                                }
                                            }
                                            let mut ids = if command == "clip.multicamEnable" || named {
                                                vec![clips[0]]
                                            } else {
                                                winner(&project, sequence, time, &targeted, top_down).into_iter().collect()
                                            };
                                            if command == "clip.multicamEnable" && linked {
                                                ids = clips.clone();
                                            }
                                            if command != "clip.multicamEnable" && (audio_only && command == "multicam.switchAngle" || follows && !video_only) {
                                                let links: Vec<_> = ids.iter().filter_map(|id| q.find_item(ClipId(*id)).unwrap().1.link).collect();
                                                for clip in q.audio_tracks.iter().flat_map(|track| &track.items) {
                                                    expected.premises.push(leaf(clip.id.0, ["link", "props.multicam"]));
                                                    if clip.link.is_some_and(|link| links.contains(&link)) && clip.multicam.is_some() {
                                                        ids.push(clip.id.0);
                                                    }
                                                }
                                            }
                                            for id in ids {
                                                let (owner, clip) = q.find_item(ClipId(id)).unwrap();
                                                expected.premises.push(leaf(id, ["item", "props.multicam", "link"]));
                                                if command != "clip.multicamEnable" {
                                                    expected.premises.push(leaf(owner.0, ["props.locked"]));
                                                }
                                                expected.premises.push(leaf(clip.item.0, ["kind", "~cameraMap"]));
                                                if command.starts_with("multicam.cutToCamera") {
                                                    expected.premises.push(Premise::on(json!(id)));
                                                }
                                            }
                                            if command == "clip.multicamEnable" && linked {
                                                expected.premises.push(leaf(clips[0], ["link", "~linkedGroup"]));
                                                expected.premises.push(leaf(*clips.iter().min().unwrap(), ["~linkedMembers"]));
                                            }
                                            assert_eq!(
                                                normalized(doc.under(command, &params).unwrap().unwrap()),
                                                normalized(expected),
                                                "{command}/{params}/time={time}/linked={linked}/follows={follows}/top_down={top_down}/targets={targeted:?}"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let source_sequence = project.sequence(ItemId(source)).unwrap();
        let expected: Vec<_> = if let Some(map) = &source_sequence.multicam {
            map.cameras
                .iter()
                .map(|camera| {
                    json!([camera.video_track.map(|track| track.0), camera.audio_tracks.iter().map(|track| track.0).collect::<Vec<_>>(), camera.enabled])
                })
                .collect()
        } else {
            source_sequence
                .video_tracks
                .iter()
                .enumerate()
                .map(|(index, track)| json!([track.id.0, source_sequence.audio_tracks.get(index).map(|track| vec![track.id.0]).unwrap_or_default(), true]))
                .collect()
        };
        let values = doc.derived(&[json!(source)], &["cameraMap".into()]).unwrap();
        assert_eq!(values[0].values["cameraMap"], json!(expected));
    }
}

#[test]
fn camera_metadata_compares_explicit_and_default_sources_and_every_assignment_subset() {
    let (mut doc, sequence, source, _) = fixture(true);
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    let targeted: Vec<_> = q.all_tracks().map(|track| track.id.0).collect();
    assert!(compared_path("multicam.editCameras", "explicit/default"));
    let spec = doc.commands().into_iter().find(|spec| spec.id == "multicam.editCameras").unwrap();
    assert!(spec.enabled && spec.mutates && spec.targets.is_none());
    assert_eq!(spec.reads, [EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active]);
    assert_eq!(spec.objects, ["sequence"]);
    assert_eq!(spec.object_types, [("sequence", &["Item"][..])]);
    assert!(
        spec.places.is_empty()
            && spec.name_params.is_empty()
            && spec.name_field.is_none()
            && spec.index.is_none()
            && !spec.index_numbers
            && !spec.index_reversed
    );
    for top_down in [false, true] {
        doc.execute("multicam.selectionTopDown", json!({"enabled":top_down})).unwrap();
        for requested in [0, 254_016_000_000i64] {
            doc.execute("playhead.set", json!({"time":requested})).unwrap();
            let time = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
            for explicit in [false, true] {
                for mask in 0..8 {
                    for angle in [0, 2, 8] {
                        let mut params = json!({"cameras":[{"angle":angle}]});
                        if explicit {
                            params["sequence"] = json!(source);
                        }
                        let mut expected = Under::default();
                        if !explicit {
                            lookup(&project, sequence, time, &mut expected);
                            let clip = winner(&project, sequence, time, &targeted, top_down).unwrap();
                            expected.premises.push(Premise::on(json!(clip)).fields(["item", "props.multicam"]).positions(["start", "duration"]));
                        }
                        let mut fields = vec!["kind".to_owned(), format!("sequence.settings.multicam.cameras.{angle}.video_track")];
                        if mask & 1 != 0 {
                            params["cameras"][0]["name"] = json!("Assigned");
                            fields.push(format!("sequence.settings.multicam.cameras.{angle}.name"));
                        }
                        if mask & 2 != 0 {
                            params["cameras"][0]["enabled"] = json!(false);
                            fields.push(format!("sequence.settings.multicam.cameras.{angle}.enabled"));
                        }
                        if mask & 4 != 0 {
                            params["audio"] = json!("switch");
                            fields.push("sequence.settings.multicam.audio".into());
                        }
                        expected.premises.push(leaf(source, fields));
                        assert_eq!(
                            normalized(doc.under("multicam.editCameras", &params).unwrap().unwrap()),
                            normalized(expected),
                            "{params}/time={time}/top_down={top_down}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn camera_pages_compare_lookup_sources_layouts_and_destination_forms() {
    for explicit in [false, true] {
        let (mut doc, sequence, _, _) = fixture(explicit);
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        let targeted: Vec<_> = q.all_tracks().map(|track| track.id.0).collect();
        for top_down in [false, true] {
            doc.execute("multicam.selectionTopDown", json!({"enabled":top_down})).unwrap();
            for layout in ["auto", "2x2", "3x3", "4x4"] {
                doc.execute("multicam.gridLayout", json!({"layout":layout})).unwrap();
                for requested in [0, 254_016_000_000i64, 762_048_000_000i64] {
                    doc.execute("playhead.set", json!({"time":requested})).unwrap();
                    let time = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                    let mut expected = Under::default();
                    lookup(&project, sequence, time, &mut expected);
                    if let Some(id) = winner(&project, sequence, time, &targeted, top_down) {
                        expected.premises.push(leaf(q.find_item(ClipId(id)).unwrap().1.item.0, ["kind", "~cameraMap"]));
                    }
                    for command in ["multicam.page", "multicam.nextPage", "multicam.prevPage"] {
                        assert!(compared_path(command, "editor"));
                        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                        assert!(
                            spec.enabled
                                && spec.mutates
                                && spec.targets.is_none()
                                && spec.objects.is_empty()
                                && spec.object_types.is_empty()
                                && spec.places.is_empty()
                        );
                        assert_eq!(spec.reads, [EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active]);
                        assert!(
                            spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed
                        );
                        for page in [json!(0), json!(1), json!(100), json!("next"), json!("prev")] {
                            let params = if command == "multicam.page" { json!({"page":page}) } else { json!({}) };
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap()),
                                normalized(expected.clone()),
                                "{command}/{params}/time={time}/layout={layout}/top_down={top_down}"
                            );
                        }
                    }
                }
            }
        }
    }
}
