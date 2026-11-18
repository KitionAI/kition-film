//! Per-actor id ranges (Phase 3c Task 2): ids kept only as data (markers, links, groups,
//! captions, caption tracks, `lutN`, search bins — everything `Project::alloc_id` hands out) are
//! never individually replicated, so two sessions that each mint one without exchanging first
//! must not mint the *same* one — unlike a `Bin`/`Item`/`Track`/`Clip`/`Transition`, whose own
//! object identity would survive the collision, only one of the two markers would survive a
//! plain last-writer-wins merge of an id-as-data field. Giving each actor its own slot of the id
//! space (`FilmSession`'s doc comment) prevents the collision outright, rather than repairing it
//! after the fact.

mod common;

use common::{add_clip, demo_project, first, peer, person, record, sequence_id, sync};
use kition_film_project::{Marker, MarkerId};
use kition_film_time::Tick;

fn marker(id: u64) -> Marker {
    Marker {
        id: MarkerId(id),
        start: Tick::ZERO,
        duration: Tick::ZERO,
        name: "m".into(),
        comment: String::new(),
        kind: Default::default(),
        color: kition_film_project::Label::Iris,
    }
}

/// Two sessions open the very same starting project under two different actors and each adds a
/// marker to its own clip (so the two edits never touch the very same opaque `json` register —
/// that is a separate, already-documented last-writer-wins tradeoff this test is not about),
/// without exchanging anything first: the ids they mint must differ (each actor mints past its
/// own id slot), and once they do exchange, both markers must exist, each still under its own id.
#[test]
fn concurrent_markers_from_different_actors_get_different_ids() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(10), rate.tick_of(10));

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);

    let mut after_a = a.model().project.clone();
    let marker_a_id = after_a.alloc_id();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items[0].markers.push(marker(marker_a_id));
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    let marker_b_id = after_b.alloc_id();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items[1].markers.push(marker(marker_b_id));
    record(&mut b, &person("b"), &after_b);

    assert_ne!(marker_a_id, marker_b_id, "two actors never mint the same id-as-data without exchanging first");

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    let items = &a.model().project.sequence(sequence_id(&a.model().project)).unwrap().video_tracks[0].items;
    let all_markers: Vec<MarkerId> = items.iter().flat_map(|c| c.markers.iter().map(|m| m.id)).collect();
    assert_eq!(all_markers.len(), 2, "both markers exist after the exchange: {all_markers:?}");
    assert!(all_markers.contains(&MarkerId(marker_a_id)), "a's marker survives under its own id");
    assert!(all_markers.contains(&MarkerId(marker_b_id)), "b's marker survives under its own id");
}
