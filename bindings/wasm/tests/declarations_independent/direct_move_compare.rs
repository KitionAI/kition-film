//! commands.rs:379-473; edit/lib.rs:477-522. Named moves expand unlocked
//! linked partners, align negative starts and replace destination material.
//! `copy` (Option-drag; edit/lib.rs copy_items) runs the same plan and lands its
//! copies where the move would have put the clips: it reads the listed clips and
//! their partners whole (each is cloned) and the same destination windows, and
//! leaves the originals and their transitions alone. The declaration is the move's,
//! so the transitions at the originals' edges are held without being read (MORE).
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] = &[("timeline.move", "move")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec!["coarse-mode-state", "whole-move-target", "whole-move-insert-neighbourhood", "uncopied-source-transitions"]
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn expected(project: &Project, seq: u64, p: &Value, linked: bool) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    let follow = p["linked"].as_bool().unwrap_or(linked);
    let mut listed = Vec::new();
    for movement in p["moves"].as_array().unwrap() {
        let clip = movement["clip"].as_u64().unwrap();
        let target = if let Some(id) = movement["track"].as_u64() {
            q.all_tracks().find(|t| t.id.0 == id).unwrap()
        } else {
            let name = movement["track"].as_str().unwrap();
            let index = name[1..].parse::<usize>().unwrap() - 1;
            let (tracks, field) = if name.starts_with('V') { (&q.video_tracks, "sequence.videoTracks") } else { (&q.audio_tracks, "sequence.audioTracks") };
            want.premises.push(leaf(tracks[index].id.0, &[]).positions([field]));
            &tracks[index]
        };
        listed.push((clip, target.id, movement["time"].as_i64().unwrap()));
        if follow {
            want.premises.push(leaf(clip, &["link", "~linkedGroup"]));
            if let Some(group) = q.find_item(ClipId(clip)).unwrap().1.link {
                let root = q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(group)).map(|c| c.id.0).min().unwrap();
                want.premises.push(leaf(root, &["~linkedMembers"]));
            }
        }
    }
    let mut moves = listed.clone();
    let mut held = listed.iter().map(|m| m.0).collect::<Vec<_>>();
    for (id, _, at) in &listed {
        let (owner, clip) = q.find_item(ClipId(*id)).unwrap();
        want.premises.push(leaf(owner.0, &["props.kind"]));
        if follow && clip.link.is_some() {
            for track in q.all_tracks().filter(|t| !t.locked) {
                for partner in track.items.iter().filter(|c| c.link == clip.link) {
                    if !held.contains(&partner.id.0) {
                        held.push(partner.id.0);
                    }
                    if !moves.iter().any(|m| m.0 == partner.id.0) {
                        moves.push((partner.id.0, track.id, partner.start.0 + at - clip.start.0));
                    }
                }
            }
        }
    }
    want.premises.extend(held.iter().map(|id| Premise::on(json!(id))));
    let offset = (-moves.iter().map(|m| m.2).min().unwrap()).max(0);
    for m in &mut moves {
        m.2 += offset;
    }
    moves.retain(|m| listed.iter().any(|listed| listed.0 == m.0) || q.find_item(ClipId(m.0)).unwrap().1.start.0 != m.2);
    for (_, track, _) in &listed {
        want.premises.push(leaf(track.0, &["props.kind"]));
    }
    let insert = p["insert"] == true;
    let first = moves.iter().map(|m| m.2).min().unwrap();
    let intervals = if insert {
        q.all_tracks()
            .filter(|t| !t.locked && (t.sync_lock || moves.iter().any(|m| m.1 == t.id)))
            .map(|t| (t.id, first, kition_film_time::Tick::MAX.0))
            .collect::<Vec<_>>()
    } else {
        moves.iter().map(|(id, track, at)| (*track, *at, *at + q.find_item(ClipId(*id)).unwrap().1.duration.0)).collect()
    };
    let mut affected = moves.iter().map(|m| m.0).collect::<Vec<_>>();
    for (owner, start, end) in intervals {
        let track = q.track(owner).unwrap();
        let from = track.items.iter().take_while(|c| c.end().0 <= start).count();
        let to = track.items.iter().take_while(|c| c.start.0 < end).count().max(from);
        for clip in &track.items[from..to] {
            want.objects.push(json!(clip.id.0));
            affected.push(clip.id.0);
        }
        want.within.push(Within {
            parent: json!(owner.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(start.to_string()),
                to: json!(end.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
    }
    want.objects.sort_by_key(|v| v.as_u64());
    want.objects.dedup();
    for track in q.all_tracks() {
        if insert
            || moves.iter().any(|m| m.1 == track.id)
            || track.items.iter().any(|c| {
                listed.iter().any(|m| m.0 == c.id.0) || follow && c.link.is_some() && listed.iter().any(|m| q.find_item(ClipId(m.0)).unwrap().1.link == c.link)
            })
        {
            want.premises.push(leaf(track.id.0, if insert { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
        }
        want.premises.extend(
            track
                .transitions
                .iter()
                .filter(|t| t.from.is_some_and(|id| affected.contains(&id.0)) || t.to.is_some_and(|id| affected.contains(&id.0)))
                .map(|t| Premise::on(json!(t.id.0))),
        );
    }
    want
}
#[test]
fn direct_moves_compare_ordinal_destinations_links_negative_alignment_and_insert_windows() {
    let mut doc = FilmDocument::create("Move.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","time":254_016_000_000i64})).unwrap()["clips"][0].clone();
    doc.execute("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","seconds":4})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for insert in [false, true] {
            for (explicit, copy) in [(false, None), (true, None), (false, Some(true)), (true, Some(true)), (false, Some(false))] {
                for time in [-254_016_000_000i64, 0, 1_016_064_000_000] {
                    let mut p = json!({"moves":[{"clip":clip,"track":"V2","time":time}],"insert":insert});
                    if explicit {
                        p["linked"] = json!(!linked);
                    }
                    if let Some(copy) = copy {
                        p["copy"] = json!(copy);
                    }
                    assert_eq!(normalized(doc.under("timeline.move", &p).unwrap().unwrap()), normalized(expected(&project, seq, &p, linked)), "{p}/{linked}");
                }
            }
        }
    }
}
