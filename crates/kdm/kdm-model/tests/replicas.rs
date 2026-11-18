//! Two-replica merges, through `KitSession<FilmModel>`: concurrent edits that touch different
//! state both survive; a concurrent overlap (a ripple insert, a move into a gap) is repaired the
//! same way on both replicas; a delete beats a concurrent edit of the same clip, and leaves no
//! dangling transition.
//!
//! Every `ItemId`/`ClipId`/... is only valid for the exact `Project` value it came from: a fresh
//! `FilmModel::load` (so every `first`/`peer` session) mints its own ids, never reusing
//! `demo_project`'s or `add_clip`'s. Each test below re-resolves the ids it needs from the
//! session's own `model().project` (`common::sequence_id`/`media_id`, or a clip's position in its
//! track) rather than carrying one over from before the session existed.

mod common;

use common::{add_clip, assert_same_content, demo_project, first, media_id, peer, person, record, sequence_id, sync};
use kition_film_project::ParamValue;
use kition_film_time::Tick;

fn overlaps(items: &[kition_film_project::TrackItem]) -> bool {
    let mut sorted: Vec<_> = items.iter().collect();
    sorted.sort_by_key(|i| i.start);
    sorted.windows(2).any(|w| w[0].end() > w[1].start)
}

#[test]
fn concurrent_trims_of_different_clips_are_both_kept() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(20), rate.tick_of(10));

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);

    let mut after_a = a.model().project.clone();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items[0].duration = rate.tick_of(5);
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items[1].duration = rate.tick_of(6);
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let a_items = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items;
    assert_eq!(a_items[0].duration, rate.tick_of(5), "a's trim kept");
    assert_eq!(a_items[1].duration, rate.tick_of(6), "b's trim reached a");
    let b_items = &b.model().project.sequence(sequence_b).unwrap().video_tracks[0].items;
    assert_eq!(b_items[0].duration, rate.tick_of(5), "a's trim reached b");
    assert_eq!(b_items[1].duration, rate.tick_of(6), "b's own trim stayed");
    assert_same_content(&a.model().project, &b.model().project);
}

#[test]
fn concurrent_ripple_inserts_on_one_track_are_repaired_without_overlap() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let media_a = media_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);
    let media_b = media_id(&b.model().project);

    // Both replicas, unaware of each other, append a new clip right after the first one.
    let mut after_a = a.model().project.clone();
    add_clip(&mut after_a, sequence_a, media_a, rate.tick_of(10), rate.tick_of(5));
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    add_clip(&mut after_b, sequence_b, media_b, rate.tick_of(10), rate.tick_of(7));
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let a_items = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items;
    let b_items = &b.model().project.sequence(sequence_b).unwrap().video_tracks[0].items;
    assert_eq!(a_items.len(), 3, "the first clip and both concurrent inserts all survive");
    assert!(!overlaps(a_items), "repaired without overlap on a: {a_items:?}");
    assert!(!overlaps(b_items), "repaired without overlap on b: {b_items:?}");
    assert_same_content(&a.model().project, &b.model().project);
}

#[test]
fn concurrent_param_edits_of_different_effects_on_one_clip_are_both_kept() {
    let (mut project, media, sequence) = demo_project();
    add_clip(&mut project, sequence, media, Tick::ZERO, Tick(1_000_000));

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);

    let mut after_a = a.model().project.clone();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value =
        ParamValue::Float(50.0);
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items[0].effect_mut("opacity").unwrap().params.get_mut("opacity").unwrap().value =
        ParamValue::Float(40.0);
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let clip = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items[0];
    assert_eq!(clip.effect("motion").unwrap().params["scale"].value, ParamValue::Float(50.0), "a's edit kept");
    assert_eq!(clip.effect("opacity").unwrap().params["opacity"].value, ParamValue::Float(40.0), "b's edit kept");
    assert_same_content(&a.model().project, &b.model().project);
}

/// A inserts a new effect at index 0 of a clip's effect list while, concurrently and unaware of
/// it, B changes a param of that same clip's existing "opacity" effect. Before `diff_effects`
/// kept an edited/inserted/reordered effect's object (any shape change used to rewrite the whole
/// list — deleting every `Effect` object and recreating fresh ones), A's insert would have
/// deleted the very object B's concurrent param edit targets, losing B's change on merge. Both
/// must survive: the inserted effect, and B's edit on the original "opacity" object.
#[test]
fn concurrent_effect_insert_and_param_edit_both_kept() {
    let (mut project, media, sequence) = demo_project();
    add_clip(&mut project, sequence, media, Tick::ZERO, Tick(1_000_000));

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);

    let mut after_a = a.model().project.clone();
    let blur = kition_film_project::find_effect("gaussian_blur").unwrap_or_else(|| panic!("no gaussian_blur effect def")).instance();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items[0].effects.insert(0, blur);
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items[0].effect_mut("opacity").unwrap().params.get_mut("opacity").unwrap().value =
        ParamValue::Float(42.0);
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let clip = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items[0];
    assert_eq!(clip.effects.len(), 4, "3 intrinsic effects plus a's inserted one");
    assert!(clip.effect("gaussian_blur").is_some(), "a's inserted effect survives");
    assert_eq!(clip.effect("opacity").unwrap().params["opacity"].value, ParamValue::Float(42.0), "b's param edit on the original object survives");
    assert_same_content(&a.model().project, &b.model().project);
}

#[test]
fn deleting_a_clip_a_peer_edits_merges_with_no_dangling_transition() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(10), rate.tick_of(10));
    {
        let transition_id = kition_film_project::TransitionId(project.alloc_id());
        let seq = project.sequence_mut(sequence).unwrap();
        let a_id = seq.video_tracks[0].items[0].id;
        let b_id = seq.video_tracks[0].items[1].id;
        seq.video_tracks[0].transitions.push(kition_film_project::Transition {
            id: transition_id,
            effect: kition_film_project::EffectInstance {
                effect: "crossDissolve".into(),
                enabled: true,
                params: Default::default(),
                masks: Vec::new(),
                post_fader: false,
                audio_mixing: false,
                layer: None,
            },
            start: rate.tick_of(8),
            duration: rate.tick_of(4),
            from: Some(a_id),
            to: Some(b_id),
            align: kition_film_project::TransitionAlign::CenterAtCut,
            reverse: false,
        });
    }

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);
    // The clips are already in start order (0 then 10), so position matches identity.
    let b_clip_a = a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items[1].id;
    let b_clip_b = b.model().project.sequence(sequence_b).unwrap().video_tracks[0].items[1].id;
    assert_eq!(a.model().project.sequence(sequence_a).unwrap().video_tracks[0].transitions.len(), 1, "the transition round-tripped");

    let mut after_a = a.model().project.clone();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items.retain(|c| c.id != b_clip_a);
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].transitions.retain(|t| t.to != Some(b_clip_a));
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items.iter_mut().find(|c| c.id == b_clip_b).unwrap().effects.push(
        kition_film_project::EffectInstance {
            effect: "gaussian_blur".into(),
            enabled: true,
            params: Default::default(),
            masks: Vec::new(),
            post_fader: false,
            audio_mixing: false,
            layer: None,
        },
    );
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let track = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0];
    assert!(track.items.iter().all(|c| c.id != b_clip_a), "the deleted clip stays deleted");
    assert!(track.transitions.is_empty(), "no dangling transition to the deleted clip survives repair");
    assert_same_content(&a.model().project, &b.model().project);
}

#[test]
fn concurrent_moves_into_the_same_gap_are_repaired_identically() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    let ten = rate.tick_of(10);
    add_clip(&mut project, sequence, media, Tick::ZERO, ten); // A: 0..10
    add_clip(&mut project, sequence, media, Tick(ten.0 * 2), ten); // B: 20..30 (gap 10..20)
    add_clip(&mut project, sequence, media, Tick(ten.0 * 4), ten); // C: 40..50
    add_clip(&mut project, sequence, media, Tick(ten.0 * 6), ten); // D: 60..70

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let sequence_a = sequence_id(&a.model().project);
    let sequence_b = sequence_id(&b.model().project);
    // Positions match insertion order (already sorted by start): C is index 2, D is index 3.
    let c_in_a = a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items[2].id;
    let d_in_b = b.model().project.sequence(sequence_b).unwrap().video_tracks[0].items[3].id;

    let mut after_a = a.model().project.clone();
    after_a.sequence_mut(sequence_a).unwrap().video_tracks[0].items.iter_mut().find(|c| c.id == c_in_a).unwrap().start = ten;
    record(&mut a, &person("a"), &after_a);

    let mut after_b = b.model().project.clone();
    after_b.sequence_mut(sequence_b).unwrap().video_tracks[0].items.iter_mut().find(|c| c.id == d_in_b).unwrap().start = ten;
    record(&mut b, &person("b"), &after_b);

    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    let a_items = &a.model().project.sequence(sequence_a).unwrap().video_tracks[0].items;
    let b_items = &b.model().project.sequence(sequence_b).unwrap().video_tracks[0].items;
    assert_eq!(a_items.len(), 4);
    assert!(!overlaps(a_items), "repaired without overlap on a: {a_items:?}");
    assert!(!overlaps(b_items), "repaired without overlap on b: {b_items:?}");
    assert_same_content(&a.model().project, &b.model().project);
}

/// Two peers move the same clip to two different tracks at once: a move keeps the clip's object,
/// so the merge lists it on both tracks; the repair keeps it on exactly one (the same one on
/// both replicas), never two copies of one clip.
#[test]
fn concurrent_moves_of_one_clip_to_two_tracks_keep_one_copy() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    for name in ["V2", "V3"] {
        let id = kition_film_project::TrackId(project.alloc_id());
        project.sequence_mut(sequence).unwrap().video_tracks.push(kition_film_project::Track::new(id, kition_film_project::TrackKind::Video, name.into()));
    }

    let mut a = first(&project);
    let mut b = peer(&a, 2);
    for (session, to, origin) in [(&mut a, 1usize, "a"), (&mut b, 2, "b")] {
        let mut after = session.model().project.clone();
        let seq = after.sequence_mut(sequence_id(&session.model().project)).unwrap();
        let clip = seq.video_tracks[0].items.remove(0);
        seq.video_tracks[to].items.push(clip);
        record(session, &person(origin), &after);
    }
    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    let seq = a.model().project.sequence(sequence_id(&a.model().project)).unwrap().clone();
    let clips: usize = seq.video_tracks.iter().map(|t| t.items.len()).sum();
    assert_eq!(clips, 1, "one clip, on one track: {:?}", seq.video_tracks.iter().map(|t| t.items.len()).collect::<Vec<_>>());
    assert!(seq.video_tracks[0].items.is_empty(), "it left V1");
    assert_same_content(&a.model().project, &b.model().project);
}
