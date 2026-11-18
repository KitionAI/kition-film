//! sequence_tools.rs:598-769. Add Tracks inserts at independent kind-specific
//! gaps and renumbers default names. Delete Tracks retains one lane per kind,
//! deletes complete descendants, and repairs local targeting destinations.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Track};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("sequence.addTracks", "insertion gaps"), ("sequence.deleteTracks", "explicit"), ("sequence.deleteTracks", "empty")];

pub fn compared_path(command: &str, path: &str) -> bool {
    let source = include_str!("../../../../crates/engine/engine/src/sequence_tools.rs");
    PATHS.contains(&(command, path)) && source.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3)) == 0x9c4a17d3fd68bdd4
}

pub fn more() -> Vec<&'static str> {
    vec!["whole-track-order"]
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

fn fixture(populated: bool, lanes: usize) -> (FilmDocument, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    doc.execute("file.newSequence", json!({"name":"Layout","video":lanes,"audio":lanes})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    doc.execute("sequence.addTracks", json!({"video":0,"submix":2})).unwrap();
    if populated {
        let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
    }
    (doc, sequence)
}

#[test]
fn track_insertions_compare_every_kind_amount_gap_spelling_and_channel_layout() {
    for populated in [false, true] {
        let (doc, sequence) = fixture(populated, 3);
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        let spec = doc.commands().into_iter().find(|spec| spec.id == "sequence.addTracks").unwrap();
        assert!(compared_path(&spec.id, "insertion gaps") && spec.enabled && spec.mutates && spec.targets.is_none());
        assert_eq!(spec.reads, [EditorState::Part]);
        assert_eq!(spec.places, ["videoAfter", "audioAfter", "submixAfter"]);
        assert!(
            spec.objects.is_empty()
                && spec.object_types.is_empty()
                && spec.name_params.is_empty()
                && spec.name_field.is_none()
                && spec.index.is_none()
                && !spec.index_numbers
                && !spec.index_reversed
        );
        for mask in 0..27 {
            for gap_mode in 0..10 {
                for channels in ["stereo", "5.1", "adaptive", "mono"] {
                    let mut params = json!({"audioType":if channels == "stereo" {"standard"} else {channels},"submixType":channels});
                    let mut want = Under::default();
                    for (index, (key, letter, tracks, field)) in [
                        ("video", "V", &q.video_tracks, "sequence.videoTracks"),
                        ("audio", "A", &q.audio_tracks, "sequence.audioTracks"),
                        ("submix", "S", &q.submix_tracks, "sequence.submixTracks"),
                    ]
                    .into_iter()
                    .enumerate()
                    {
                        let amount = (mask / 3usize.pow(index as u32)) % 3;
                        if amount != 2 {
                            params[key] = json!(amount);
                        }
                        let amount = if amount == 2 { usize::from(key == "video") } else { amount };
                        let after = format!("{key}After");
                        let (value, position) = match gap_mode {
                            0 => (None, tracks.len()),
                            1 => (Some(Value::Null), tracks.len()),
                            2 => (Some(json!("first")), 0),
                            3 => (Some(json!("beforefirst")), 0),
                            4 => (Some(json!("end")), tracks.len()),
                            5 => (Some(json!("last")), tracks.len()),
                            6 => (Some(json!(0)), 0),
                            7 => (Some(json!(tracks.len())), tracks.len()),
                            8 => (Some(json!(format!("{letter}1"))), 1),
                            _ => (Some(json!(format!("{}1", letter.to_ascii_lowercase()))), 1),
                        };
                        if let Some(value) = value {
                            params[&after] = value;
                        }
                        if amount == 0 {
                            continue;
                        }
                        want.within.push(Within { parent: json!(sequence), field: field.into(), from: position, to: position, ..Default::default() });
                        want.premises.push(leaf(sequence, [format!("~{key}TrackNames")]));
                        if gap_mode < 2 {
                            want.premises.push(leaf(sequence, [format!("~{key}TrackOrder")]));
                        }
                    }
                    assert_eq!(normalized(doc.under("sequence.addTracks", &params).unwrap().unwrap()), normalized(want), "{params}/populated={populated}");
                }
            }
        }
    }
}

fn deletion(want: &mut Under, sequence: u64, tracks: &[Track], kind: &str, value: &Value) {
    if value.is_null() {
        return;
    }
    let empty = value.as_str().is_some_and(|text| matches!(text, "empty" | "allEmpty" | "all-empty"));
    let id = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.get(1..)?.parse::<usize>().ok()).and_then(|n| tracks.get(n.checked_sub(1)?)).map(|track| track.id.0));
    let doomed: Vec<_> = tracks.iter().filter(|track| if empty { track.items.is_empty() } else { Some(track.id.0) == id }).map(|track| track.id).collect();
    let keep_first = doomed.len() == tracks.len();
    for track in tracks {
        if empty {
            want.premises.push(leaf(track.id.0, ["~clipOrder"]).positions([format!("sequence.{kind}Tracks")]));
        }
        if doomed.contains(&track.id) && !(keep_first && tracks.first().is_some_and(|first| first.id == track.id)) {
            want.premises.push(Premise::on(json!(track.id.0)));
            want.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
            want.premises.extend(track.transitions.iter().map(|transition| Premise::on(json!(transition.id.0))));
        }
    }
    want.premises.push(leaf(sequence, [format!("~{kind}TrackOrder")]));
}

#[test]
fn track_deletions_compare_whole_recipients_id_and_ordinal_addresses_and_empty_keep_first_rules() {
    for (populated, lanes) in [(false, 1), (false, 3), (true, 1), (true, 3)] {
        let (doc, sequence) = fixture(populated, lanes);
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for path in ["explicit", "empty"] {
            assert!(compared_path("sequence.deleteTracks", path));
        }
        let spec = doc.commands().into_iter().find(|spec| spec.id == "sequence.deleteTracks").unwrap();
        assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.places.is_empty());
        assert_eq!(spec.reads, [EditorState::Part, EditorState::Active]);
        assert_eq!(spec.objects, ["audio", "video"]);
        assert_eq!(spec.object_types, [("audio", &["Track"][..]), ("video", &["Track"][..])]);
        assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
        let choices = |tracks: &[Track], letter: &str| -> Vec<Value> {
            let mut out = vec![Value::Null, json!("empty"), json!("allEmpty"), json!("all-empty")];
            for (index, track) in tracks.iter().enumerate() {
                out.push(json!(track.id.0));
                out.push(json!(format!("{letter}{}", index + 1)));
            }
            out
        };
        for video in choices(&q.video_tracks, "V") {
            for audio in choices(&q.audio_tracks, "A") {
                let mut want = Under::default();
                deletion(&mut want, sequence, &q.video_tracks, "video", &video);
                deletion(&mut want, sequence, &q.audio_tracks, "audio", &audio);
                let params = json!({"video":video,"audio":audio});
                assert_eq!(normalized(doc.under("sequence.deleteTracks", &params).unwrap().unwrap()), normalized(want), "{params}/populated={populated}");
            }
        }
    }
}
