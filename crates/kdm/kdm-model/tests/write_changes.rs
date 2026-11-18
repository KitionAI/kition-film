//! `write_changes`: a trim writes only that clip's timing, and a ripple delete writes only the
//! shifted clips' starts. Also effect identity (`diff_effects`): removing or reordering effects
//! keeps the surviving ones' own objects, not just the common "params only" case.

mod common;

use common::{add_clip, demo_project};
use kition_kit::kdm::{ActorId, DocId, Origin, Replica};
use kition_kit::session::KitModel;

fn new_replica(project: &kition_film_project::Project) -> (Replica, kdm_model::Ids, kdm_model::Nodes) {
    let mut ids = kdm_model::Ids::default();
    let mut nodes = kdm_model::Nodes::default();
    let (replica, ()) = Replica::create_with(kdm_model::FilmModel::schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        kdm_model::write_document(tx, project, &mut ids, &mut nodes).map(|_| ())
    })
    .unwrap_or_else(|error| panic!("create: {error}"));
    (replica, ids, nodes)
}

#[test]
fn trim_writes_only_that_clips_timing() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, rate.tick_of(24));
    add_clip(&mut project, sequence, media, rate.tick_of(24), rate.tick_of(24));
    let before = project.clone();
    let (mut replica, mut ids, mut nodes) = new_replica(&project);
    replica.take_changed();

    // Trim the first clip's duration (a handle drag), leaving the second clip untouched (no
    // ripple: its own start stays where it was).
    let mut after = before.clone();
    after.sequence_mut(sequence).unwrap().video_tracks[0].items[0].duration = rate.tick_of(12);

    let first_clip_object = ids.clips.object(before.sequence(sequence).unwrap().video_tracks[0].items[0].id).unwrap().clone();
    let second_clip_object = ids.clips.object(before.sequence(sequence).unwrap().video_tracks[0].items[1].id).unwrap().clone();

    let wrote = replica
        .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &before, &after, &mut ids, &mut nodes))
        .unwrap_or_else(|error| panic!("write_changes: {error}"));
    assert!(wrote);

    let changed = replica.take_changed();
    assert_eq!(changed, std::collections::BTreeSet::from([first_clip_object.clone()]), "only the trimmed clip's object changed");

    assert_eq!(replica.get(&first_clip_object, "duration").unwrap(), serde_json::json!(rate.tick_of(12).0.to_string()));
    assert_eq!(replica.get(&second_clip_object, "start").unwrap(), serde_json::json!(rate.tick_of(24).0.to_string()), "the second clip did not move");
    assert_eq!(replica.get(&second_clip_object, "duration").unwrap(), serde_json::json!(rate.tick_of(24).0.to_string()));
}

#[test]
fn ripple_delete_writes_the_shifted_starts() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    let frame = rate.tick_of(1);
    let ten = rate.tick_of(10);
    add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, ten);
    add_clip(&mut project, sequence, media, ten, ten);
    add_clip(&mut project, sequence, media, ten + ten, ten);
    let before = project.clone();
    let (mut replica, mut ids, mut nodes) = new_replica(&project);
    replica.take_changed();

    let a_id = before.sequence(sequence).unwrap().video_tracks[0].items[0].id;
    let b_id = before.sequence(sequence).unwrap().video_tracks[0].items[1].id;
    let c_id = before.sequence(sequence).unwrap().video_tracks[0].items[2].id;
    let a_object = ids.clips.object(a_id).unwrap().clone();
    let b_object = ids.clips.object(b_id).unwrap().clone();
    let c_object = ids.clips.object(c_id).unwrap().clone();

    // Ripple-delete the middle clip: it is removed, and everything after it shifts left by its
    // duration. The first clip is entirely unaffected.
    let mut after = before.clone();
    let track = &mut after.sequence_mut(sequence).unwrap().video_tracks[0];
    track.items.retain(|item| item.id != b_id);
    for item in &mut track.items {
        if item.id == c_id {
            item.start -= ten;
        }
    }

    let wrote = replica
        .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &before, &after, &mut ids, &mut nodes))
        .unwrap_or_else(|error| panic!("write_changes: {error}"));
    assert!(wrote);

    let changed = replica.take_changed();
    assert!(!changed.contains(&a_object), "the untouched first clip was not written");
    assert!(changed.contains(&c_object), "the shifted clip was written");
    assert!(!replica.exists(&b_object), "the deleted clip is gone");

    assert_eq!(replica.get(&a_object, "start").unwrap(), serde_json::json!("0"));
    assert_eq!(replica.get(&a_object, "duration").unwrap(), serde_json::json!(ten.0.to_string()));
    assert_eq!(replica.get(&c_object, "start").unwrap(), serde_json::json!(ten.0.to_string()), "the clip after the deletion shifted left exactly one duration");
    let _ = frame;
}

/// A clip moved to another track and back keeps its one object (a move, not a delete and a
/// create): the replica holds it on the track it is on after each move. Tracks are diffed in
/// `after`'s order, so the move back used to look like "a known clip that is not in this track's
/// `before`" on V1 (skipped) and "a clip gone from its track" on V2 (deleted), losing it.
#[test]
fn a_clip_moved_across_tracks_keeps_its_object() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, rate.tick_of(24));
    add_clip(&mut project, sequence, media, rate.tick_of(24), rate.tick_of(24));
    let v2 = kition_film_project::TrackId(project.alloc_id());
    project.sequence_mut(sequence).unwrap().video_tracks.push(kition_film_project::Track::new(v2, kition_film_project::TrackKind::Video, "V2".into()));
    let (mut replica, mut ids, mut nodes) = new_replica(&project);
    let moved = project.sequence(sequence).unwrap().video_tracks[0].items[0].id;
    let object = ids.clips.object(moved).unwrap().clone();

    let mut before = project;
    for (from, to) in [(0usize, 1usize), (1, 0), (0, 1)] {
        let mut after = before.clone();
        let seq = after.sequence_mut(sequence).unwrap();
        let index = seq.video_tracks[from].items.iter().position(|c| c.id == moved).unwrap();
        let clip = seq.video_tracks[from].items.remove(index);
        seq.video_tracks[to].items.push(clip);
        replica
            .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &before, &after, &mut ids, &mut nodes))
            .unwrap_or_else(|error| panic!("write_changes: {error}"));
        let (read, _, _) = kdm_model::read_document(&replica).unwrap();
        common::assert_same_content(&read, &after);
        assert!(replica.exists(&object), "V{} -> V{}: the moved clip keeps its object", from + 1, to + 1);
        assert_eq!(ids.clips.object(moved), Some(&object), "V{} -> V{}: and its id mapping", from + 1, to + 1);
        before = after;
    }
}

/// Each item's bin, by bin name path (`"Root/New/Inner"`), in a stable order.
fn item_bins(project: &kition_film_project::Project) -> Vec<(String, String)> {
    fn walk(bin: &kition_film_project::Bin, path: &str, project: &kition_film_project::Project, out: &mut Vec<(String, String)>) {
        let path = format!("{path}/{}", bin.name);
        for entry in &bin.children {
            match entry {
                kition_film_project::BinEntry::Item(id) => out.push((project.item(*id).unwrap().name.clone(), path.clone())),
                kition_film_project::BinEntry::Bin(child) => walk(child, &path, project, out),
            }
        }
    }
    let mut out = Vec::new();
    walk(&project.root, "", project, &mut out);
    out.sort();
    out
}

/// A new bin made in the same edit that files items into it (New Bin From Selection, an import
/// that brings its own bins) writes those items into it — also into a new bin inside the new bin.
/// A new bin used to be diffed against itself, so its entries were never written: the items left
/// their old bin and were in no bin at all in the replica.
#[test]
fn a_new_bin_writes_the_items_filed_into_it() {
    let (project, media, sequence) = demo_project();
    let (mut replica, mut ids, mut nodes) = new_replica(&project);
    let mut after = project.clone();
    let outer = after.add_bin("New", None);
    let inner = after.add_bin("Inner", Some(outer));
    after.move_to_bin(&[media], Some(outer)).unwrap();
    after.move_to_bin(&[sequence], Some(inner)).unwrap();
    replica
        .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &project, &after, &mut ids, &mut nodes))
        .unwrap_or_else(|error| panic!("write_changes: {error}"));
    let (read, _, _) = kdm_model::read_document(&replica).unwrap();
    assert_eq!(item_bins(&read), item_bins(&after), "every item is in its new bin in the replica");
}

/// `read_document`'s `next_id` is past every id the project holds, also those kept only as data
/// in an opaque register (markers, links, groups, caption tracks and captions, LUTs, search
/// bins): a reload must never hand one of them out again.
#[test]
fn next_id_after_a_read_is_past_ids_kept_as_data() {
    use kition_film_project::{Marker, MarkerId};
    let marker = |id: u64| Marker {
        id: MarkerId(id),
        start: kition_film_time::Tick::ZERO,
        duration: kition_film_time::Tick::ZERO,
        name: "m".into(),
        comment: String::new(),
        kind: Default::default(),
        color: kition_film_project::Label::Iris,
    };
    let edits: Vec<(&str, Box<dyn Fn(&mut kition_film_project::Project, kition_film_project::ItemId, kition_film_project::ItemId)>)> = vec![
        ("sequence marker", Box::new(move |p, _, seq| p.sequence_mut(seq).unwrap().markers.push(marker(50_000)))),
        ("clip marker", Box::new(move |p, _, seq| p.sequence_mut(seq).unwrap().video_tracks[0].items[0].markers.push(marker(50_000)))),
        (
            "media marker",
            Box::new(move |p, media, _| {
                if let kition_film_project::ItemKind::Media(m) = &mut p.items.get_mut(&media).unwrap().kind {
                    m.markers.push(marker(50_000));
                }
            }),
        ),
        ("link", Box::new(|p, _, seq| p.sequence_mut(seq).unwrap().video_tracks[0].items[0].link = Some(50_000))),
        ("group", Box::new(|p, _, seq| p.sequence_mut(seq).unwrap().video_tracks[0].items[0].group = Some(50_000))),
        (
            "caption track",
            Box::new(|p, _, seq| {
                let track = kition_film_project::caption::CaptionTrack::new(kition_film_project::TrackId(50_000), "Subtitles".into(), Default::default());
                p.sequence_mut(seq).unwrap().caption_tracks.push(track);
            }),
        ),
        (
            "caption",
            Box::new(|p, _, seq| {
                let mut track =
                    kition_film_project::caption::CaptionTrack::new(kition_film_project::TrackId(p.alloc_id()), "Subtitles".into(), Default::default());
                track.captions.push(kition_film_project::caption::Caption {
                    id: kition_film_project::ClipId(50_000),
                    start: kition_film_time::Tick::ZERO,
                    duration: kition_film_time::Tick(1000),
                    text: "Hi".into(),
                    speaker: None,
                    cue_id: None,
                    settings: String::new(),
                });
                p.sequence_mut(seq).unwrap().caption_tracks.push(track);
            }),
        ),
        (
            "lut",
            Box::new(|p, _, _| {
                p.luts.push(kition_film_project::ProjectLut {
                    id: "lut50000".into(),
                    name: "Look".into(),
                    source_path: None,
                    format: "cube".into(),
                    text: "".into(),
                })
            }),
        ),
        (
            "search bin",
            Box::new(|p, _, _| {
                p.search_bins.push(kition_film_project::find::SearchBin {
                    id: kition_film_project::BinId(50_000),
                    name: "Find".into(),
                    query: kition_film_project::find::FindQuery { rows: Vec::new(), match_all: true, case_sensitive: false },
                })
            }),
        ),
    ];
    for (what, edit) in edits {
        let (mut project, media, sequence) = demo_project();
        let rate = project.sequence(sequence).unwrap().settings.frame_rate;
        add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, rate.tick_of(24));
        edit(&mut project, media, sequence);
        let (replica, _, _) = new_replica(&project);
        let (read, _, _) = kdm_model::read_document(&replica).unwrap();
        assert!(read.next_id > 50_000, "{what}: next_id {} is past the id it keeps", read.next_id);
    }
}

/// Removing the middle of a clip's three (intrinsic) effects deletes exactly that effect's own
/// object; the other two keep theirs (`diff_effects` no longer rewrites the whole list on any
/// shape change).
#[test]
fn removing_the_middle_effect_deletes_only_that_object() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, rate.tick_of(24));
    let before = project.clone();
    let (mut replica, mut ids, mut nodes) = new_replica(&project);

    let clip_id = before.sequence(sequence).unwrap().video_tracks[0].items[0].id;
    let clip_object = ids.clips.object(clip_id).unwrap().clone();
    let effects_before = replica.list(&clip_object, "effects").unwrap();
    assert_eq!(effects_before.len(), 3, "motion, opacity, time_remap");

    let mut after = before.clone();
    after.sequence_mut(sequence).unwrap().video_tracks[0].items[0].effects.remove(1); // drop "opacity"

    let wrote = replica
        .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &before, &after, &mut ids, &mut nodes))
        .unwrap_or_else(|error| panic!("write_changes: {error}"));
    assert!(wrote);

    let effects_after = replica.list(&clip_object, "effects").unwrap();
    assert_eq!(effects_after.len(), 2);
    assert_eq!(effects_after[0], effects_before[0], "motion kept its object");
    assert_eq!(effects_after[1], effects_before[2], "time_remap kept its object");
    assert!(!replica.exists(&effects_before[1]), "the removed opacity effect's object is gone");
}

/// Reordering a clip's effects keeps every one of their objects (just moved), rather than
/// deleting and recreating the whole list.
#[test]
fn reordering_effects_keeps_all_their_ids() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, kition_film_time::Tick::ZERO, rate.tick_of(24));
    let before = project.clone();
    let (mut replica, mut ids, mut nodes) = new_replica(&project);

    let clip_id = before.sequence(sequence).unwrap().video_tracks[0].items[0].id;
    let clip_object = ids.clips.object(clip_id).unwrap().clone();
    let effects_before = replica.list(&clip_object, "effects").unwrap();
    assert_eq!(effects_before.len(), 3);

    let mut after = before.clone();
    after.sequence_mut(sequence).unwrap().video_tracks[0].items[0].effects.reverse();

    let wrote = replica
        .transact(&Origin::person("user:test"), |tx| kdm_model::write_changes(tx, &before, &after, &mut ids, &mut nodes))
        .unwrap_or_else(|error| panic!("write_changes: {error}"));
    assert!(wrote);

    let effects_after = replica.list(&clip_object, "effects").unwrap();
    assert_eq!(effects_after.len(), 3);
    let mut reversed = effects_before.clone();
    reversed.reverse();
    assert_eq!(effects_after, reversed, "same three objects, in reverse order");
    for object in &effects_before {
        assert!(replica.exists(object), "every effect object survives a pure reorder");
    }
}
