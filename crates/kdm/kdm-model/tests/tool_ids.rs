//! Tool ids (KitObjectModel OM9, task card C8-film): every bin, item, track, clip and transition
//! holds the id the engine gave it (the `.kfilm` file's id) in a read-only field, a replica reads
//! each object with that id, and the repair after an import numbers an object that has none (one
//! a batch or a collaborator created) or shares one with another, the same on every replica.

mod common;

use common::{add_clip, demo_project, first, peer, person, record, sequence_id, sync};
use kition_film_project::{BinEntry, Project};
use kition_film_time::Tick;
use kition_kit::kdm::ObjectId;
use serde_json::{Value, json};

fn clip_ids(project: &Project) -> Vec<u64> {
    let sequence = sequence_id(project);
    project.sequence(sequence).unwrap_or_else(|| panic!("sequence")).video_tracks[0].items.iter().map(|clip| clip.id.0).collect()
}

/// Every id the project holds: bins, items, tracks, clips, transitions.
fn every_id(project: &Project) -> Vec<u64> {
    fn bins(bin: &kition_film_project::Bin, out: &mut Vec<u64>) {
        out.push(bin.id.0);
        for entry in &bin.children {
            if let BinEntry::Bin(child) = entry {
                bins(child, out);
            }
        }
    }
    let mut out = Vec::new();
    bins(&project.root, &mut out);
    for item in project.items.values() {
        out.push(item.id.0);
        if let Some(sequence) = project.sequence(item.id) {
            for track in sequence.all_tracks() {
                out.push(track.id.0);
                out.extend(track.items.iter().map(|clip| clip.id.0));
                out.extend(track.transitions.iter().map(|transition| transition.id.0));
            }
        }
    }
    out
}

/// A replica made from a project stores each object's id, and reading it gives the project's own
/// ids back: none is minted on a read.
#[test]
fn a_replica_reads_every_object_with_the_id_its_project_gave_it() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap_or_else(|| panic!("sequence")).settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(10), rate.tick_of(10));
    let session = first(&project);
    let mut wanted = every_id(&project);
    let mut read = every_id(&session.model().project);
    wanted.sort_unstable();
    read.sort_unstable();
    assert_eq!(read, wanted);
    let (read_again, _, _) = kdm_model::read_document(session.replica(), session.blobs()).unwrap_or_else(|error| panic!("read: {error}"));
    assert_eq!(clip_ids(&read_again), clip_ids(&project));
}

/// A clip a collaborator's replica created without an id (as a batch creates one: the field is
/// read-only) is given one past every id the project holds, written in the replica, and read with
/// it on both replicas.
#[test]
fn a_clip_created_without_an_id_is_numbered_past_every_other() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap_or_else(|| panic!("sequence")).settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let highest = every_id(&a.model().project).into_iter().max().unwrap_or(0);
    let clip = a.replica().objects_of_type("Clip").into_iter().next().unwrap_or_else(|| panic!("a clip"));
    let track = a
        .replica()
        .objects_of_type("Track")
        .into_iter()
        .find(|track| a.replica().list(track, "clips").is_ok_and(|clips| !clips.is_empty()))
        .unwrap_or_else(|| panic!("V1"));
    let mut values = serde_json::Map::new();
    for field in ["item", "duration", "sourceIn", "speed", "reverse", "props"] {
        values.insert(field.to_owned(), a.replica().get(&clip, field).unwrap_or(Value::Null));
    }
    values.insert("start".to_owned(), json!(rate.tick_of(20).0.to_string()));
    b.record(&person("b"), |tx| {
        let made = tx.create("Clip", values.clone())?;
        tx.list_insert(&track, "clips", 1, &made)?;
        Ok(())
    })
    .unwrap_or_else(|error| panic!("b's clip: {error}"));
    sync(&mut a, &mut b);
    let made: Vec<ObjectId> = a.replica().objects_of_type("Clip").into_iter().filter(|object| object != &clip).collect();
    let [made] = made.as_slice() else { panic!("one new clip: {made:?}") };
    let stored = a.replica().get(made, "clipId").unwrap_or(Value::Null).as_u64().unwrap_or_else(|| panic!("the new clip is numbered"));
    assert!(stored > highest, "{stored} is past {highest}");
    assert_eq!(b.replica().get(made, "clipId").unwrap_or(Value::Null), json!(stored), "both replicas write the same id");
    assert!(clip_ids(&a.model().project).contains(&stored), "{:?}", clip_ids(&a.model().project));
    assert!(clip_ids(&b.model().project).contains(&stored), "{:?}", clip_ids(&b.model().project));
}

/// Two replicas, taking turns on one line of changes, each give a new clip the same id (the
/// second writes it without reading the first's): once the second's change reaches the first, the
/// first clip in object-id order keeps it and the other gets a new one, the same on both, so every
/// id names one object.
#[test]
fn two_clips_given_one_id_are_told_apart_after_an_exchange() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap_or_else(|| panic!("sequence")).settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    for (a_writes, start) in [(true, 20), (false, 40)] {
        let (session, other) = if a_writes { (&mut a, &mut b) } else { (&mut b, &mut a) };
        let mut after = session.model().project.clone();
        let sequence = sequence_id(&after);
        let media = after
            .items
            .values()
            .find(|item| matches!(item.kind, kition_film_project::ItemKind::Media(_)))
            .map(|item| item.id)
            .unwrap_or_else(|| panic!("media"));
        add_clip(&mut after, sequence, media, rate.tick_of(start), rate.tick_of(5));
        let made = after.sequence_mut(sequence).unwrap_or_else(|| panic!("sequence")).video_tracks[0].items.last_mut().unwrap_or_else(|| panic!("clip"));
        made.id = kition_film_project::ClipId(9_000);
        record(session, &person("x"), &after);
        sync(session, other);
    }
    let mut ids = clip_ids(&a.model().project);
    ids.sort_unstable();
    let mut unique = ids.clone();
    unique.dedup();
    assert_eq!(ids, unique, "every clip has its own id: {ids:?}");
    assert!(ids.contains(&9_000), "{ids:?}");
    let mut b_ids = clip_ids(&b.model().project);
    b_ids.sort_unstable();
    assert_eq!(ids, b_ids, "both replicas read the same ids");
}
