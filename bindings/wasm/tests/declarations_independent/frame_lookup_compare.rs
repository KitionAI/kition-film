//! commands.rs:1632-1645,1916-1927; keyboard.rs:113-134;
//! sequence_tools.rs:263-304. Lookup order and time mapping choose an identity.
use super::{sound_paths_compare::source, sync_compare::normalized};
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] = &[
    ("clip.revealInProject", "reveal"),
    ("sequence.matchFrame", "point"),
    ("sequence.revealNested", "navigation"),
    ("sequence.reverseMatchFrame", "source frame"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x95526b4360647be4
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x9c4a17d3fd68bdd4
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["whole-frame-lookup-geometry", "coarse-selection-state", "unused-lookup-source-kind"];
    if command == "sequence.revealNested" {
        out.push("whole-nested-navigation-source");
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &kition_film_engine::project::Project, seq: u64, command: &str, params: &Value, selected: &[u64]) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut out = Under::default();
    if command == "clip.revealInProject" {
        let candidates = params["clips"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
            .unwrap_or_else(|| params["clip"].as_u64().map(|id| vec![id]).unwrap_or_else(|| selected.to_vec()));
        for id in &candidates {
            out.premises.push(leaf(*id, ["item"]));
            if let Some((_, clip)) = q.find_item(kition_film_engine::project::ClipId(*id)) {
                out.premises.push(leaf(clip.item.0, Vec::<String>::new()));
                return out;
            }
        }
    }
    out.premises.push(leaf(seq, ["~videoTrackOrder", "~audioTrackOrder", "sequence.settings.settings.frame_rate"]));
    for track in q.video_tracks.iter().chain(&q.audio_tracks) {
        out.premises.push(leaf(track.id.0, ["~clipOrder"]));
        for clip in &track.items {
            out.premises.push(
                leaf(clip.id.0, ["item", "sourceIn", "speed", "reverse", "props.frame_hold", "link", "~linkedGroup"]).positions(["start", "duration", "clips"]),
            );
            if let Some(link) = clip.link {
                let root = q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(link)).map(|c| c.id.0).min().unwrap();
                out.premises.push(leaf(root, ["~linkedMembers"]));
            }
            if command == "sequence.revealNested" {
                source(&mut out, project, clip.item);
            } else {
                out.premises.push(leaf(clip.item.0, ["kind"]));
            }
        }
    }
    out
}
#[test]
fn frame_lookups_compare_source_routes_explicit_selection_empty_tracks_order_and_following_modes() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let nested = doc.execute("sequence.new", json!({"name":"Nested","fromItem":source})).unwrap()["sequence"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap();
    doc.execute("sequence.open", json!({"item":seq})).unwrap();
    let mut clips = Vec::new();
    for (item, track, at) in [(source, "V1", 0), (nested, "V2", 254_016_000_000i64)] {
        clips.extend(
            doc.execute("timeline.place", json!({"item":item,"track":track,"time":at})).unwrap()["clips"].as_array().unwrap().iter().filter_map(Value::as_u64),
        );
    }
    doc.execute("source.open", json!({"item":source})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for follows in [false, true] {
        doc.execute("sequence.selectionFollowsPlayhead", json!({"on":follows})).unwrap();
        for selected in [vec![], vec![clips[0]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for time in [0, 254_016_000_000i64, 1_270_080_000_000i64] {
                doc.execute("playhead.set", json!({"time":time})).unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    for params in [json!({}), json!({"clip":clips[0]}), json!({"clip":clips[2]}), json!({"clips":[]})] {
                        // Setting the playhead can replace selection in follow mode.
                        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(expected(&project, seq, command, &params, &selected)),
                            "{command}/{params}/{selected:?}/{follows}/{time}"
                        );
                    }
                }
            }
        }
    }
}
