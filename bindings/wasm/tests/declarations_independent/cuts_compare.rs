//! commands.rs:1696-1726,2561-2606; edit/lib.rs:94-132,279-310.
//! A cut copies the containing clip and reassigns transitions; lock checks
//! choose the participating lanes. Time conversion reads only its own timebase.
use super::{attributes_replace_compare::operands, sync_compare::normalized};
use kition_film_engine::project::{ItemId, Project, Track};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] = &[
    ("sequence.addEdit", "selected-cut"),
    ("sequence.addEdit", "track-cut"),
    ("sequence.addEditAllTracks", "all-cut"),
    ("timeline.razor", "track-cut"),
    ("timeline.razor", "clip-cut"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec![
        "coarse-selection-state",
        "coarse-active-state",
        "coarse-mode-state",
        "whole-cut-transition-list",
        "unconsumed-named-cut-lanes",
        "whole-cut-caption-map",
    ]
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn window(track: &Track, at: i64, want: &mut Under) {
    let from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
    let to = track.items.iter().take_while(|clip| clip.start.0 <= at).count().max(from);
    for clip in &track.items[from..to] {
        want.objects.push(json!(clip.id.0));
        want.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "clipId"]));
    }
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
}
fn expected(project: &Project, seq: u64, command: &str, selected: &[u64], linked: bool, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    let named = p.get("clip").and_then(Value::as_u64);
    let ids = if let Some(id) = named { operands(q, &[id], linked, &mut want) } else { Vec::new() };
    let at = p.get("time").and_then(Value::as_i64).or_else(|| p.get("frame").and_then(Value::as_i64).map(|f| q.settings.frame_rate.tick_of(f).0)).unwrap_or(0);
    if p.get("frame").is_some() {
        want.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate"]));
    }
    let track = p.get("track").and_then(Value::as_str).map(|name| q.video_tracks[name[1..].parse::<usize>().unwrap() - 1].id);
    if let Some(track) = track {
        want.premises.push(leaf(track.0, &[]).positions(["sequence.videoTracks"]));
    }
    let selected_tracks = selected
        .iter()
        .filter_map(|id| {
            q.all_tracks().find(|track| track.items.iter().any(|clip| clip.id.0 == *id && clip.start.0 < at && at < clip.end().0)).map(|track| track.id)
        })
        .collect::<Vec<_>>();
    let no_place = named.is_some() && p.get("time").is_none() && p.get("frame").is_none();
    let addressed = q
        .all_tracks()
        .filter(|lane| {
            if command == "sequence.addEdit" {
                !selected_tracks.is_empty() && selected_tracks.contains(&lane.id) || selected_tracks.is_empty()
            } else {
                track.map_or(!lane.locked, |id| id == lane.id)
            }
        })
        .collect::<Vec<_>>();
    if !no_place {
        for track in addressed {
            window(track, at, &mut want);
        }
    }
    let candidates = q
        .all_tracks()
        .filter(|lane| if named.is_some() { lane.items.iter().any(|clip| ids.contains(&clip.id.0)) } else { track.is_none_or(|id| id == lane.id) })
        .collect::<Vec<_>>();
    for track in candidates {
        want.premises.push(leaf(track.id.0, &["props.locked", "transitions"]));
    }
    if named.is_none() && track.is_none() {
        want.premises.push(leaf(seq, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
    }
    if command == "sequence.addEditAllTracks" {
        want.premises.push(leaf(seq, &["sequence.captionTracks", "sequence.captions"]));
    }
    if linked
        && let Some(id) = named
        && (no_place || !want.objects.contains(&json!(id)))
    {
        want.premises.push(Premise::on(json!(id)));
    }
    want
}
#[test]
fn cuts_compare_selection_fallback_links_locks_timebases_and_named_track_windows() {
    let mut doc = FilmDocument::create("Cut.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let clips = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_u64)
        .collect::<Vec<_>>();
    for locked in [false, true] {
        doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for selected in [vec![], vec![clips[0]], clips.clone()] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for command in ["sequence.addEdit", "sequence.addEditAllTracks", "timeline.razor"] {
                    let mut params = vec![json!({"time":254_016_000_000i64}), json!({"frame":12})];
                    if command == "timeline.razor" {
                        params.extend([
                            json!({"track":"V1","time":254_016_000_000i64}),
                            json!({"clip":clips[0]}),
                            json!({"clip":clips[0],"time":254_016_000_000i64}),
                        ]);
                    }
                    for p in params {
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap()),
                            normalized(expected(&project, seq, command, &selected, linked, &p)),
                            "{command}/{p}/{selected:?}/{linked}/{locked}"
                        );
                    }
                }
            }
        }
    }
}
