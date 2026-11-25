//! commands.rs:1490-1565,2550-2750; edit/lib.rs:528-927. Direct edits
//! consume the named or implicit recipients, source limits and adjacent/ripple
//! geometry. A selection is an operand list even when the playhead is elsewhere.
use super::{attributes_replace_compare::operands, sync_compare::normalized, trim_edits_compare::source_limits};
use kition_film_engine::project::{ClipId, ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] =
    &[("clip.speedDuration", "speed"), ("timeline.trim", "regular/ripple"), ("timeline.roll", "adjacent"), ("timeline.slide", "slide")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "coarse-mode-state", "whole-direct-edit-target", "whole-direct-edit-source-limits"];
    if matches!(command, "timeline.roll" | "timeline.slide") {
        out.push("whole-direct-edit-transition-list");
    } else {
        out.push("whole-direct-edit-neighbour-positions");
    }
    out
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn expected(project: &Project, seq: u64, command: &str, selected: &[u64], linked: bool, markers: bool, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    let roll = command == "timeline.roll";
    let slide = command == "timeline.slide";
    let base = if roll {
        [p["left"].as_u64().unwrap(), p["right"].as_u64().unwrap()].to_vec()
    } else {
        p.get("clips")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
            .unwrap_or_else(|| p.get("clip").and_then(Value::as_u64).map(|id| vec![id]).unwrap_or_else(|| selected.to_vec()))
    };
    let ids = if roll { base.clone() } else { operands(q, &base, linked, &mut want) };
    want.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate"]));
    let mut bounded = ids.clone();
    if slide {
        for id in &ids {
            let (owner, _) = q.find_item(ClipId(*id)).unwrap();
            let track = q.track(owner).unwrap();
            let index = track.items.iter().position(|clip| clip.id.0 == *id).unwrap();
            for clip in index.checked_sub(1).and_then(|i| track.items.get(i)).into_iter().chain(track.items.get(index + 1)) {
                bounded.push(clip.id.0);
                if !ids.contains(&clip.id.0) {
                    want.premises.push(Premise::on(json!(clip.id.0)));
                }
            }
        }
    }
    for id in bounded {
        source_limits(project, q.find_item(ClipId(id)).unwrap().1.item, &mut want);
    }
    if roll || slide {
        for track in q.all_tracks().filter(|track| track.items.iter().any(|clip| ids.contains(&clip.id.0))) {
            want.premises.push(leaf(track.id.0, &["transitions"]));
        }
        if slide && linked {
            want.premises.extend(base.iter().map(|id| Premise::on(json!(id))));
        }
        return want;
    }
    want.premises.extend(ids.iter().map(|id| Premise::on(json!(id))));
    let Some(first) = ids.iter().filter_map(|id| q.find_item(ClipId(*id))).map(|(_, clip)| clip.start.0).min() else { return want };
    let ripple = if command == "timeline.trim" { p["mode"] == "ripple" } else { p["ripple"] == true };
    let mut affected = Vec::new();
    for track in q.all_tracks() {
        let member = track.items.iter().any(|clip| ids.contains(&clip.id.0));
        if !member && (!ripple || track.locked || !track.sync_lock) {
            continue;
        }
        let mut at = first.saturating_sub(1).max(0);
        let mut end = Tick::MAX.0;
        let mut from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
        let mut to = track.items.len();
        if !ripple {
            let head = track.items.iter().position(|clip| ids.contains(&clip.id.0)).unwrap();
            from = from.min(head.saturating_sub(1));
            at = at.min(track.items[from].start.0);
            let tail = track.items.iter().rposition(|clip| ids.contains(&clip.id.0)).unwrap();
            to = to.min(tail + 2);
            end = track.items[to - 1].end().0;
        }
        for clip in &track.items[from..to] {
            want.objects.push(json!(clip.id.0));
            affected.push(clip.id);
            if !ids.contains(&clip.id.0) {
                want.premises.push(Premise::on(json!(clip.id.0)).fields(["link"]));
            }
        }
        want.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(at.to_string()),
                to: json!(end.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
    }
    for track in q.all_tracks() {
        want.premises.push(leaf(track.id.0, &["props.locked", "props.sync_lock"]));
        want.premises.extend(
            track
                .transitions
                .iter()
                .filter(|transition| transition.from.is_some_and(|id| affected.contains(&id)) || transition.to.is_some_and(|id| affected.contains(&id)))
                .map(|transition| Premise::on(json!(transition.id.0))),
        );
    }
    if command == "timeline.trim" && markers {
        want.premises.push(leaf(seq, &["sequence.markers"]));
    }
    want
}
#[test]
fn direct_edits_compare_implicit_operands_links_source_bounds_neighbours_and_ripple_windows() {
    let mut doc = FilmDocument::create("Direct.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":6})).unwrap()["item"].clone();
    let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    let second = doc.execute("timeline.razor", json!({"clip":first,"time":254_016_000_000i64})).unwrap()["clips"][0].as_u64().unwrap();
    let third = doc.execute("timeline.razor", json!({"clip":second,"time":2*254_016_000_000i64})).unwrap()["clips"][0].as_u64().unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for markers in [false, true] {
            doc.execute("marker.rippleSequenceMarkers", json!({"on":markers})).unwrap();
            for selected in [vec![second], vec![third], vec![second, third]] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for command in ["clip.speedDuration", "timeline.trim", "timeline.roll", "timeline.slide"] {
                    for ripple in [false, true] {
                        for explicit in [false, true] {
                            // commands.rs:2373,2528 require one named clip; only
                            // Speed/Duration falls back to the selection.
                            if !explicit && matches!(command, "timeline.trim" | "timeline.slide") {
                                continue;
                            }
                            let mut p = match command {
                                "clip.speedDuration" => json!({"speed":1.2,"ripple":ripple}),
                                "timeline.trim" => json!({"edge":"in","delta":1,"mode":if ripple{"ripple"}else{"regular"}}),
                                "timeline.roll" => json!({"left":first,"right":second,"delta":1}),
                                _ => json!({"delta":1}),
                            };
                            if explicit && command != "timeline.roll" {
                                if command == "clip.speedDuration" {
                                    p["clips"] = json!(selected);
                                } else {
                                    p["clip"] = json!(selected[0]);
                                }
                            }
                            assert_eq!(
                                normalized(doc.under(command, &p).unwrap().unwrap_or_default()),
                                normalized(expected(&project, seq, command, &selected, linked, markers, &p)),
                                "{command}/{p}/{selected:?}/{linked}/{markers}"
                            );
                        }
                    }
                }
            }
        }
    }
}
