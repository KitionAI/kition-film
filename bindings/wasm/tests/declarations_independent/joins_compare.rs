//! sequence_tools.rs:328-349; edit/through.rs:160-199. Joins test mapping
//! predicates before copying lengths, and retain removed pieces as whole writes.
use super::{attributes_replace_compare::operands, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, Project, TrackItem};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{Covers, KitDocument, Premise, Under};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const PATHS: &[(&str, &str)] = &[("sequence.joinThroughEdits", "explicit clips / selection"), ("sequence.joinThroughEdits", "all")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec!["coarse-selection-state", "coarse-mode-state", "whole-large-join-order", "whole-removed-join-content", "historical-join-candidates"]
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn continues(left: &TrackItem, right: &TrackItem) -> bool {
    if left.end() != right.start || left.item != right.item || left.speed != right.speed || left.reverse != right.reverse || left.multicam != right.multicam {
        return false;
    }
    match (left.frame_hold, right.frame_hold) {
        (Some(a), Some(b)) => a == b,
        (None, None) => {
            if left.reverse {
                (right.source_out().0 - left.source_in.0).abs() <= 2
            } else {
                (left.source_out().0 - right.source_in.0).abs() <= 2
            }
        }
        _ => false,
    }
}
fn pair(left: &TrackItem, right: &TrackItem, facts: &mut BTreeMap<u64, (BTreeSet<&'static str>, BTreeSet<&'static str>)>) {
    facts.entry(left.id.0).or_default().1.extend(["start", "duration"]);
    facts.entry(right.id.0).or_default().1.insert("start");
    if left.end() != right.start {
        return;
    }
    for (field, equal) in [
        ("item", left.item == right.item),
        ("speed", left.speed == right.speed),
        ("reverse", left.reverse == right.reverse),
        ("props.multicam", left.multicam == right.multicam),
    ] {
        facts.entry(left.id.0).or_default().0.insert(field);
        facts.entry(right.id.0).or_default().0.insert(field);
        if !equal {
            return;
        }
    }
    facts.entry(left.id.0).or_default().0.insert("props.frame_hold");
    facts.entry(right.id.0).or_default().0.insert("props.frame_hold");
    if left.frame_hold.is_some() || right.frame_hold.is_some() {
        return;
    }
    facts.entry(left.id.0).or_default().0.insert("sourceIn");
    facts.entry(right.id.0).or_default().0.insert("sourceIn");
    if left.reverse {
        facts.entry(right.id.0).or_default().1.insert("duration");
    }
}
fn expected(project: &Project, seq: u64, selection: &[u64], linked: bool, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let all = p.get("all").and_then(Value::as_bool) == Some(true) || (p.get("clips").is_none() && p.get("clip").is_none() && selection.is_empty());
    let named = p
        .get("clips")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        .or_else(|| p.get("clip").and_then(Value::as_u64).map(|id| vec![id]))
        .unwrap_or_else(|| selection.to_vec());
    let mut want = Under::default();
    let only = if all { Vec::new() } else { operands(q, &named, linked, &mut want) };
    let mut removed = BTreeSet::new();
    for track in q.all_tracks().filter(|track| !track.locked) {
        let mut surviving = track.items.clone();
        let mut index = 0;
        while index + 1 < surviving.len() {
            let (left, right) = (&surviving[index], &surviving[index + 1]);
            if (only.is_empty() || only.contains(&left.id.0) || only.contains(&right.id.0)) && continues(left, right) {
                let right = surviving.remove(index + 1);
                removed.insert(right.id.0);
                surviving[index].duration += right.duration;
                if surviving[index].reverse {
                    surviving[index].source_in = right.source_in;
                }
            } else {
                index += 1;
            }
        }
    }
    if only.is_empty() {
        want.premises.push(leaf(seq, ["~allJoinPlan"]));
    }
    if let [id] = only.as_slice() {
        want.premises.push(leaf(*id, ["~singleJoinPlan"]));
        let (owner, clip) = q.find_item(ClipId(*id)).unwrap();
        let track = q.track(owner).unwrap();
        let index = track.items.iter().position(|clip| clip.id.0 == *id).unwrap();
        let absorbed = index.checked_sub(1).and_then(|i| track.items.get(i)).is_some_and(|previous| continues(previous, clip));
        if !track.locked && !absorbed && removed.len() > 128 {
            want.premises.push(leaf(owner.0, ["~clipOrder"]));
        }
    }
    for track in q.all_tracks().filter(|track| only.is_empty() || track.items.iter().any(|clip| only.contains(&clip.id.0))) {
        want.premises.push(leaf(track.id.0, ["props.locked"]));
        let mut facts = BTreeMap::new();
        for adjacent in track.items.windows(2) {
            let (left, right) = (&adjacent[0], &adjacent[1]);
            if only.is_empty() || only.contains(&left.id.0) || only.contains(&right.id.0) || removed.contains(&left.id.0) || removed.contains(&right.id.0) {
                pair(left, right, &mut facts);
            }
        }
        let mut candidates = BTreeSet::new();
        for (index, clip) in track.items.iter().enumerate() {
            if only.is_empty() || only.contains(&clip.id.0) || removed.contains(&clip.id.0) {
                candidates.insert(index);
                if let Some(before) = index.checked_sub(1) {
                    candidates.insert(before);
                }
                if index + 1 < track.items.len() {
                    candidates.insert(index + 1);
                }
            }
        }
        for index in candidates {
            let clip = &track.items[index];
            if removed.contains(&clip.id.0) {
                want.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "duration"]));
            } else {
                let (mut fields, positions) = facts.remove(&clip.id.0).unwrap_or_default();
                if !all && only.contains(&clip.id.0) {
                    fields.insert("link");
                }
                want.premises.push(Premise::on(json!(clip.id.0)).fields(fields).positions(positions));
            }
        }
        want.premises.extend(
            track
                .transitions
                .iter()
                .filter(|transition| transition.from.is_some_and(|id| removed.contains(&id.0)) || transition.to.is_some_and(|id| removed.contains(&id.0)))
                .map(|transition| Premise::on(json!(transition.id.0))),
        );
    }
    want.objects = removed.into_iter().map(|id| json!(id)).collect();
    want.covers = Some(Covers { fields: vec!["~joinInput".into(), "~joinLock".into()] });
    want
}
#[test]
fn joins_compare_predicate_short_circuits_selection_links_chains_locks_and_fallbacks() {
    for scenario in ["through", "gap", "source", "speed", "reverse", "camera", "hold", "large"] {
        let mut doc = FilmDocument::create("Join.kfilm", 64, 36).unwrap();
        let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let item = doc.execute("item.newColorMatte", json!({"seconds":200})).unwrap()["item"].clone();
        let alternate = doc.execute("item.newColorMatte", json!({"seconds":200,"color":"#448844"})).unwrap()["item"].as_u64().unwrap();
        let first =
            doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0,"duration":200*254_016_000_000i64})).unwrap()["clips"][0].as_u64().unwrap();
        let mut ids = vec![first];
        let length = if scenario == "large" { 132 } else { 4 };
        for index in 1..length {
            ids.push(doc.execute("timeline.razor", json!({"clip":ids[index-1],"time":index as i64*254_016_000_000})).unwrap()["clips"][0].as_u64().unwrap());
        }
        let mut project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let second = project.sequence_mut(ItemId(seq)).unwrap().find_item_mut(ClipId(ids[1])).unwrap().1;
        match scenario {
            "gap" => {
                second.start.0 += 1;
                second.duration.0 -= 1;
            }
            "source" => second.item = ItemId(alternate),
            "speed" => second.speed = 2.0,
            "reverse" => second.reverse = true,
            "hold" => second.frame_hold = Some(Tick(0)),
            "camera" => second.multicam = Some(Default::default()),
            _ => {}
        }
        // Use a normal saved project for each independent predicate variant.
        let bytes = kition_film_format::encode(&project, false);
        let mut doc = FilmDocument::open("Join.kfilm", &bytes).unwrap();
        for locked in [false, true] {
            doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for linked in [false, true] {
                doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
                for selection in [vec![], vec![ids[0]], vec![ids[1]], vec![ids[0], ids[2]]] {
                    doc.execute("timeline.select", json!({"clips":selection,"linked":false})).unwrap();
                    for params in [json!({}), json!({"all":true}), json!({"clips":[]}), json!({"clip":ids[0]}), json!({"clips":[ids[0],ids[2]]})] {
                        assert_eq!(
                            normalized(doc.under("sequence.joinThroughEdits", &params).unwrap().unwrap()),
                            normalized(expected(&project, seq, &selection, linked, &params)),
                            "{scenario}/{locked}/{linked}/{selection:?}/{params}"
                        );
                    }
                }
            }
        }
    }
}
