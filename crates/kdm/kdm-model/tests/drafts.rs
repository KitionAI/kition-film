//! A draft's merge (data model 6.6, rules D1 to D9), through `KitSession<FilmModel>`: an agent's
//! draft forked from the document at version v, the document edited meanwhile, the draft's changes
//! taken in as one step of the person. These are the states the two-replica tests built by
//! merging (`replicas.rs`, `collections.rs` and `actor_id_ranges.rs`, gone with the move to one
//! line of changes), built through the entry that still produces them: the edits that merge keep
//! both sides', the repairs run on what the merge leaves (a clip whose media item the other side
//! deleted, a transition whose neighbour it deleted, clips put in one place, one clip on two
//! tracks), and the ids a draft mints never meet the document's. Edits the rules refuse (both
//! typed in one text, one side changed an object the other deleted) change nothing.
//!
//! Every `ItemId`/`ClipId`/... is only valid for the exact `Project` value it came from: each
//! session reads its own view, so a test resolves the ids it needs from the session's own
//! `model().project` (a clip's position in its track, `common::sequence_id`/`media_id`).

mod common;

use common::{
    add_clip, assert_same_content, assert_view_is_replica, demo_project, draft, first, media_id, merge, merge_scope, person, record, sequence_id, try_merge,
};
use kition_film_project::caption::{Caption, CaptionTrack};
use kition_film_project::{ClipId, EffectInstance, ItemKind, Label, Marker, MarkerId, ParamValue, Project, TrackId};
use kition_film_time::Tick;
use kition_kit::kdm::UndoScope;

type Session = common::Session;

fn overlaps(items: &[kition_film_project::TrackItem]) -> bool {
    let mut sorted: Vec<_> = items.iter().collect();
    sorted.sort_by_key(|i| i.start);
    sorted.windows(2).any(|w| w[0].end() > w[1].start)
}

fn caption(id: u64, start: i64, text: &str) -> Caption {
    Caption { id: ClipId(id), start: Tick(start), duration: Tick(1_000), text: text.into(), speaker: None, cue_id: None, settings: String::new() }
}

fn marker(id: u64, start: i64, comment: &str) -> Marker {
    Marker {
        id: MarkerId(id),
        start: Tick(start),
        duration: Tick::ZERO,
        name: format!("m{id}"),
        comment: comment.into(),
        kind: Default::default(),
        color: Label::Iris,
    }
}

fn effect(id: &str) -> EffectInstance {
    EffectInstance { effect: id.into(), enabled: true, params: Default::default(), masks: Vec::new(), post_fader: false, audio_mixing: false, layer: None }
}

/// A project with one clip, one caption track holding two captions, and a sequence marker.
fn captioned() -> Project {
    let (mut project, media, sequence) = demo_project();
    add_clip(&mut project, sequence, media, Tick::ZERO, Tick(10_000));
    let mut track = CaptionTrack::new(TrackId(900), "Subtitles".into(), Default::default());
    track.captions = vec![caption(901, 0, "Hello world"), caption(902, 2_000, "Second")];
    let seq = project.sequence_mut(sequence).unwrap();
    seq.caption_tracks.push(track);
    seq.markers.push(marker(903, 0, "Check the cut"));
    project.next_id = project.next_id.max(1_000);
    project
}

/// Records `change` of the session's view as one transaction of `who`.
fn edit(session: &mut Session, who: &str, change: impl FnOnce(&mut Project, kition_film_project::ItemId)) {
    let mut after = session.model().project.clone();
    let sequence = sequence_id(&after);
    change(&mut after, sequence);
    record(session, &person(who), &after);
}

fn v1(session: &Session) -> Vec<kition_film_project::TrackItem> {
    let project = &session.model().project;
    project.sequence(sequence_id(project)).unwrap().video_tracks[0].items.clone()
}

// --- the edits that merge keep both sides' ------------------------------------------------------

#[test]
fn trims_of_different_clips_are_both_kept() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(20), rate.tick_of(10));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().video_tracks[0].items[1].duration = rate.tick_of(6));
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().video_tracks[0].items[0].duration = rate.tick_of(5));
    merge(&mut doc, &agent, &base);
    let items = v1(&doc);
    assert_eq!(items[0].duration, rate.tick_of(5), "the document's trim kept");
    assert_eq!(items[1].duration, rate.tick_of(6), "the draft's trim merged");
}

/// The draft and the document each put a new clip right after the first one: both clips are
/// there, and the repair moves the later one so nothing overlaps. One undo of the person takes
/// the draft back, to exactly the document's state before the merge.
#[test]
fn clips_put_in_one_place_are_repaired_without_overlap_and_the_merge_undoes() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        let media = media_id(p);
        add_clip(p, s, media, rate.tick_of(10), rate.tick_of(7));
    });
    edit(&mut doc, "doc", |p, s| {
        let media = media_id(p);
        add_clip(p, s, media, rate.tick_of(10), rate.tick_of(5));
    });
    let before = doc.model().project.clone();
    merge(&mut doc, &agent, &base);
    let items = v1(&doc);
    assert_eq!(items.len(), 3, "the first clip and both inserts all survive");
    assert!(!overlaps(&items), "repaired without overlap: {items:?}");
    let mut durations: Vec<Tick> = items.iter().skip(1).map(|clip| clip.duration).collect();
    durations.sort();
    assert_eq!(durations, [rate.tick_of(5), rate.tick_of(7)]);
    assert!(doc.undo_in(UndoScope::Person).unwrap().0);
    assert_same_content(&doc.model().project, &before);
    assert_view_is_replica(&doc);
}

/// The length of a sequence (`Sequence.duration`) follows from its clips: a draft that adds a
/// clip at the end and the document that adds another at the end both lengthen the sequence, and
/// they merge (the draft's write of the length is left out, the repair inside the merge step sets
/// it from the merged clips), the length the later clip's end, on the replica as on the view.
#[test]
fn clips_added_at_the_end_on_both_sides_merge_and_the_length_follows() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        let media = media_id(p);
        add_clip(p, s, media, rate.tick_of(30), rate.tick_of(10));
    });
    edit(&mut doc, "doc", |p, s| {
        let media = media_id(p);
        add_clip(p, s, media, rate.tick_of(10), rate.tick_of(5));
    });
    // The draft's preview (`FilmSession::merged_state`, `compareChanges`), before accepting it: the
    // repair runs on its copy, so its length is the merged one, not the person's 15 frames.
    let changes = agent.export_changes(&base).unwrap_or_else(|error| panic!("export: {error}"));
    let changes = kdm_model::draft_changes(doc.replica(), &changes).unwrap_or_else(|error| panic!("draft changes: {error}"));
    let preview = doc.merged_state(&changes).unwrap_or_else(|error| panic!("preview: {error}"));
    let unrepaired = doc.replica().merged_state(&changes).unwrap_or_else(|error| panic!("merged state: {error}"));
    assert_ne!(preview, unrepaired, "without the repair the preview's length would be stale");
    merge(&mut doc, &agent, &base);
    let starts: Vec<Tick> = v1(&doc).iter().map(|clip| clip.start).collect();
    assert_eq!(starts, [Tick::ZERO, rate.tick_of(10), rate.tick_of(30)], "both clips are there");
    let project = &doc.model().project;
    assert_eq!(project.sequence(sequence_id(project)).unwrap().duration(), rate.tick_of(40));
    let replica = doc.replica();
    let lengths: Vec<serde_json::Value> = replica.objects_of_type("Sequence").iter().map(|object| replica.get(object, "duration").unwrap()).collect();
    assert_eq!(lengths, [serde_json::json!(rate.tick_of(40).0.to_string())], "the replica holds the merged length");
    assert_eq!(preview, replica.state_json().unwrap(), "the draft's preview is the state accepting it gave, the merged length included");
}

#[test]
fn param_edits_of_different_effects_on_one_clip_are_both_kept() {
    let (mut project, media, sequence) = demo_project();
    add_clip(&mut project, sequence, media, Tick::ZERO, Tick(1_000_000));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("opacity").unwrap().params.get_mut("opacity").unwrap().value = ParamValue::Float(40.0)
    });
    edit(&mut doc, "doc", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value = ParamValue::Float(50.0)
    });
    merge(&mut doc, &agent, &base);
    let clip = &v1(&doc)[0];
    assert_eq!(clip.effect("motion").unwrap().params["scale"].value, ParamValue::Float(50.0), "the document's edit kept");
    assert_eq!(clip.effect("opacity").unwrap().params["opacity"].value, ParamValue::Float(40.0), "the draft's edit merged");
}

/// The draft inserts an effect at the top of a clip's list while the document changes a
/// parameter of the clip's opacity: both survive, the parameter on the original effect object.
#[test]
fn an_effect_insert_and_a_param_edit_are_both_kept() {
    let (mut project, media, sequence) = demo_project();
    add_clip(&mut project, sequence, media, Tick::ZERO, Tick(1_000_000));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        let blur = kition_film_project::find_effect("gaussian_blur").unwrap_or_else(|| panic!("no gaussian_blur effect def")).instance();
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effects.insert(0, blur);
    });
    edit(&mut doc, "doc", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("opacity").unwrap().params.get_mut("opacity").unwrap().value = ParamValue::Float(42.0)
    });
    merge(&mut doc, &agent, &base);
    let clip = &v1(&doc)[0];
    assert_eq!(clip.effects.len(), 4, "3 intrinsic effects plus the draft's inserted one");
    assert!(clip.effect("gaussian_blur").is_some(), "the draft's inserted effect survives");
    assert_eq!(clip.effect("opacity").unwrap().params["opacity"].value, ParamValue::Float(42.0), "the document's param edit survives");
}

/// The draft and the document each move a different clip into the same gap: the repair leaves no
/// overlap.
#[test]
fn moves_into_the_same_gap_are_repaired() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    let ten = rate.tick_of(10);
    for at in [0, 2, 4, 6] {
        add_clip(&mut project, sequence, media, Tick(ten.0 * at), ten); // 0..10, 20..30 (gap 10..20), 40..50, 60..70
    }
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().video_tracks[0].items[3].start = ten);
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().video_tracks[0].items[2].start = ten);
    merge(&mut doc, &agent, &base);
    let items = v1(&doc);
    assert_eq!(items.len(), 4);
    assert!(!overlaps(&items), "repaired without overlap: {items:?}");
}

/// The draft moves a clip to V3 while the document moves it to V2: a move keeps the clip's
/// object, and each track's list was changed by one side only, so the merge lists it on both; the
/// repair keeps it on exactly one, never two copies of one clip.
#[test]
fn one_clip_moved_to_two_tracks_keeps_one_copy() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    for name in ["V2", "V3"] {
        let id = TrackId(project.alloc_id());
        project.sequence_mut(sequence).unwrap().video_tracks.push(kition_film_project::Track::new(id, kition_film_project::TrackKind::Video, name.into()));
    }
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    for (session, to, who) in [(&mut agent, 2usize, "agent"), (&mut doc, 1, "doc")] {
        edit(session, who, |p, s| {
            let seq = p.sequence_mut(s).unwrap();
            let clip = seq.video_tracks[0].items.remove(0);
            seq.video_tracks[to].items.push(clip);
        });
    }
    // The repair keeps the clip on the track first by object id. When that is the document's,
    // the merge leaves the document as it was and records nothing (no change, no step, the
    // version stays); otherwise it is one step of the person.
    let (hash, version, depth) = (doc.state_hash().unwrap(), doc.version(), doc.replica().undo_depth(UndoScope::Person));
    let (scope, _) = merge_scope(&mut doc, &agent, &base).unwrap_or_else(|error| panic!("merge: {error}"));
    assert_view_is_replica(&doc);
    if doc.state_hash().unwrap() == hash {
        assert_eq!(scope, None, "a merge that changes nothing records no step");
        assert_eq!(doc.version(), version, "and keeps the version");
        assert_eq!(doc.replica().undo_depth(UndoScope::Person), depth);
    } else {
        assert_eq!(scope, Some(UndoScope::Person), "a merged draft is a step of the person");
        assert_eq!(doc.replica().undo_depth(UndoScope::Person), depth + 1);
    }
    let project = &doc.model().project;
    let seq = project.sequence(sequence_id(project)).unwrap();
    let clips: usize = seq.video_tracks.iter().map(|t| t.items.len()).sum();
    assert_eq!(clips, 1, "one clip, on one track: {:?}", seq.video_tracks.iter().map(|t| t.items.len()).collect::<Vec<_>>());
    assert!(seq.video_tracks[0].items.is_empty(), "it left V1");
}

// --- repairs after the other side deleted what an object refers to ------------------------------

/// The draft deletes a clip's right neighbour while the document puts a transition between the
/// two: the transition names a clip that is gone, and the repair removes it. (The two-replica
/// form, one side deleting a clip the other edits, is refused: rule D8.)
#[test]
fn a_transition_whose_neighbour_the_draft_deleted_is_removed() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    add_clip(&mut project, sequence, media, Tick::ZERO, rate.tick_of(10));
    add_clip(&mut project, sequence, media, rate.tick_of(10), rate.tick_of(10));
    let mut doc = first(&project);

    // Refused: the document deletes the clip the draft gives an effect.
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().video_tracks[0].items[1].effects.push(effect("gaussian_blur")));
    edit(&mut doc, "doc", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items.remove(1);
    });
    let version = doc.version();
    assert!(try_merge(&mut doc, &agent, &base).is_err(), "the draft changes a clip the document deleted (D8)");
    assert_eq!(doc.version(), version, "a refused merge changes nothing");

    // Merges: the draft deletes the right clip, the document adds a transition at the cut.
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items.remove(1);
    });
    edit(&mut doc, "doc", |p, s| {
        let id = kition_film_project::TransitionId(p.alloc_id());
        let seq = p.sequence_mut(s).unwrap();
        let (from, to) = (seq.video_tracks[0].items[0].id, seq.video_tracks[0].items[1].id);
        seq.video_tracks[0].transitions.push(kition_film_project::Transition {
            id,
            effect: effect("crossDissolve"),
            start: rate.tick_of(8),
            duration: rate.tick_of(4),
            from: Some(from),
            to: Some(to),
            align: kition_film_project::TransitionAlign::CenterAtCut,
            reverse: false,
        });
    });
    assert_eq!(doc.model().project.sequence(sequence_id(&doc.model().project)).unwrap().video_tracks[0].transitions.len(), 1);
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let track = &project.sequence(sequence_id(project)).unwrap().video_tracks[0];
    assert_eq!(track.items.len(), 1, "the deleted clip stays deleted");
    assert!(track.transitions.is_empty(), "no transition to the deleted clip survives the repair");
}

/// The draft deletes a media item while the document puts a clip of it on V1: the clip's source
/// is gone, and the repair removes the clip.
#[test]
fn a_clip_whose_media_item_the_draft_deleted_is_removed() {
    let (project, _, _) = demo_project();
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, _| {
        let media = media_id(p);
        p.items.remove(&media);
        p.root.children.retain(|entry| !matches!(entry, kition_film_project::BinEntry::Item(id) if *id == media));
    });
    edit(&mut doc, "doc", |p, s| {
        let media = media_id(p);
        add_clip(p, s, media, Tick::ZERO, Tick(1_000_000));
    });
    assert_eq!(v1(&doc).len(), 1);
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    assert!(!project.items.values().any(|item| matches!(item.kind, ItemKind::Media(_))), "the media item stays deleted");
    assert!(v1(&doc).is_empty(), "the clip of the deleted item is removed");
}

/// A caption added to a caption track the other side deleted is not read (no caption is left over
/// in a track that is gone), whichever side added it.
#[test]
fn a_caption_added_to_a_track_the_other_side_deleted_is_not_left_over() {
    for draft_adds in [true, false] {
        let mut doc = first(&captioned());
        let (mut agent, base) = draft(&doc, 2);
        let add = |p: &mut Project, s: kition_film_project::ItemId| {
            p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "Third"))
        };
        let delete = |p: &mut Project, s: kition_film_project::ItemId| p.sequence_mut(s).unwrap().caption_tracks.clear();
        if draft_adds {
            edit(&mut agent, "agent", add);
            edit(&mut doc, "doc", delete);
        } else {
            edit(&mut agent, "agent", delete);
            edit(&mut doc, "doc", add);
        }
        merge(&mut doc, &agent, &base);
        let project = &doc.model().project;
        assert!(project.sequence(sequence_id(project)).unwrap().caption_tracks.is_empty(), "draft adds: {draft_adds}");
    }
}

// --- collections: both sides' pieces are kept ---------------------------------------------------

#[test]
fn a_caption_added_and_another_retimed_both_survive() {
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "Third")));
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[1].start = Tick(2_500));
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let captions = &project.sequence(sequence_id(project)).unwrap().caption_tracks[0].captions;
    assert_eq!(captions.iter().map(|c| (c.id.0, c.start.0)).collect::<Vec<_>>(), [(901, 0), (902, 2_500), (5_000_000_001, 4_000)]);
}

#[test]
fn captions_added_to_two_tracks_stay_in_their_tracks() {
    let mut project = captioned();
    let sequence = sequence_id(&project);
    project.sequence_mut(sequence).unwrap().caption_tracks.push(CaptionTrack::new(TrackId(910), "Second".into(), Default::default()));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().caption_tracks[1].captions.push(caption(6_000_000_001, 500, "Second track")));
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "First track")));
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let tracks = &project.sequence(sequence_id(project)).unwrap().caption_tracks;
    assert_eq!(tracks[0].captions.iter().map(|c| c.id.0).collect::<Vec<_>>(), [901, 902, 5_000_000_001]);
    assert_eq!(tracks[1].captions.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["Second track"]);
}

/// Each side adds a marker and the draft edits the existing marker's comment: every marker
/// survives under its own id, with the draft's comment.
#[test]
fn markers_added_on_both_sides_and_a_comment_edit_all_survive() {
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        let seq = p.sequence_mut(s).unwrap();
        seq.markers.push(marker(6_000_000_001, 200, "b"));
        seq.markers[0].comment = "Check the cut again".into();
    });
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().markers.push(marker(5_000_000_001, 100, "a")));
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let markers = &project.sequence(sequence_id(project)).unwrap().markers;
    let mut ids: Vec<u64> = markers.iter().map(|m| m.id.0).collect();
    ids.sort_unstable();
    assert_eq!(ids, [903, 5_000_000_001, 6_000_000_001]);
    assert_eq!(markers.iter().find(|m| m.id.0 == 903).unwrap().comment, "Check the cut again");
}

/// Both sides typing in one text (a caption's, a marker's comment) is a collision (rule D5): the
/// merge is refused and changes nothing. (The two-replica tests merged such typing by character;
/// that state cannot arise any more.)
#[test]
fn typing_in_one_text_on_both_sides_is_refused() {
    type Change = fn(&mut Project, kition_film_project::ItemId);
    let cases: [(Change, Change); 2] = [
        (
            |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[0].text = "Hello brave world".into(),
            |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[0].text = "Hello world!".into(),
        ),
        (
            |p, s| p.sequence_mut(s).unwrap().markers[0].comment = "Please check the cut".into(),
            |p, s| p.sequence_mut(s).unwrap().markers[0].comment = "Check the cut again".into(),
        ),
    ];
    for (mine, theirs) in cases {
        let mut doc = first(&captioned());
        let (mut agent, base) = draft(&doc, 2);
        edit(&mut agent, "agent", theirs);
        edit(&mut doc, "doc", mine);
        let (version, before) = (doc.version(), doc.model().project.clone());
        assert!(try_merge(&mut doc, &agent, &base).is_err());
        assert_eq!(doc.version(), version, "a refused merge changes nothing");
        assert_same_content(&doc.model().project, &before);
    }
}

/// Markers on one clip and on a media item, added on both sides, all survive, each under the id
/// its side gave it: the draft mints in its own range, so no id is given twice.
#[test]
fn clip_and_source_markers_from_both_sides_all_survive_under_their_own_ids() {
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    let mut minted = Vec::new();
    for (session, who) in [(&mut agent, "agent"), (&mut doc, "doc")] {
        let mut after = session.model().project.clone();
        let (sequence, media) = (sequence_id(&after), media_id(&after));
        let (on_clip, on_media) = (after.alloc_id(), after.alloc_id());
        after.sequence_mut(sequence).unwrap().video_tracks[0].items[0].markers.push(marker(on_clip, 0, who));
        if let ItemKind::Media(clip) = &mut after.items.get_mut(&media).unwrap().kind {
            clip.markers.push(marker(on_media, 0, who));
        }
        minted.extend([on_clip, on_media]);
        record(session, &person(who), &after);
    }
    let mut unique = minted.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 4, "the draft and the document never mint one id: {minted:?}");
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let mut on_clip: Vec<u64> = project.sequence(sequence_id(project)).unwrap().video_tracks[0].items[0].markers.iter().map(|m| m.id.0).collect();
    let ItemKind::Media(clip) = &project.item(media_id(project)).unwrap().kind else { panic!("media") };
    let mut on_media: Vec<u64> = clip.markers.iter().map(|m| m.id.0).collect();
    on_clip.sort_unstable();
    on_media.sort_unstable();
    let mut expected_clip = vec![minted[0], minted[2]];
    let mut expected_media = vec![minted[1], minted[3]];
    expected_clip.sort_unstable();
    expected_media.sort_unstable();
    assert_eq!(on_clip, expected_clip);
    assert_eq!(on_media, expected_media);
}

/// The draft links two clips and the document links two others, each under an id it mints: the
/// two links stay two after the merge (one id minted on both sides would have linked all four, and
/// no repair could tell the pairs apart).
#[test]
fn links_made_on_both_sides_stay_apart() {
    let (mut project, media, sequence) = demo_project();
    let rate = project.sequence(sequence).unwrap().settings.frame_rate;
    for at in 0..4 {
        add_clip(&mut project, sequence, media, rate.tick_of(10 * at), rate.tick_of(10));
    }
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    for (session, pair, who) in [(&mut agent, [2usize, 3], "agent"), (&mut doc, [0, 1], "doc")] {
        edit(session, who, |p, s| {
            let link = p.alloc_id();
            for at in pair {
                p.sequence_mut(s).unwrap().video_tracks[0].items[at].link = Some(link);
            }
        });
    }
    merge(&mut doc, &agent, &base);
    let links: Vec<Option<u64>> = v1(&doc).iter().map(|clip| clip.link).collect();
    assert!(links.iter().all(Option::is_some), "{links:?}");
    assert_eq!(links[0], links[1], "{links:?}");
    assert_eq!(links[2], links[3], "{links:?}");
    assert_ne!(links[0], links[2], "two links, not one: {links:?}");
}

#[test]
fn two_params_of_one_effect_are_both_kept() {
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("rotation").unwrap().value = ParamValue::Float(15.0)
    });
    edit(&mut doc, "doc", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value = ParamValue::Float(50.0)
    });
    merge(&mut doc, &agent, &base);
    let motion = v1(&doc)[0].effect("motion").unwrap().clone();
    assert_eq!(motion.params["scale"].value, ParamValue::Float(50.0));
    assert_eq!(motion.params["rotation"].value, ParamValue::Float(15.0));
}

#[test]
fn the_value_and_the_keyframes_of_one_param_are_both_kept() {
    use kition_film_project::Keyframe;
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    let keys = vec![Keyframe::new(Tick::ZERO, ParamValue::Float(100.0)), Keyframe::new(Tick(5_000), ParamValue::Float(200.0))];
    let draft_keys = keys.clone();
    edit(&mut agent, "agent", move |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().keyframes = draft_keys
    });
    edit(&mut doc, "doc", |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value = ParamValue::Float(50.0)
    });
    merge(&mut doc, &agent, &base);
    let motion = v1(&doc)[0].effect("motion").unwrap().clone();
    assert_eq!(motion.params["scale"].value, ParamValue::Float(50.0));
    assert_eq!(motion.params["scale"].keyframes, keys);
}

#[test]
fn a_master_effect_added_and_another_turned_off_are_both_kept() {
    let mut project = captioned();
    let sequence = sequence_id(&project);
    project.sequence_mut(sequence).unwrap().master_effects.push(effect("hard_limiter"));
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    edit(&mut agent, "agent", |p, s| p.sequence_mut(s).unwrap().master_effects.push(effect("studio_reverb")));
    edit(&mut doc, "doc", |p, s| p.sequence_mut(s).unwrap().master_effects[0].enabled = false);
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    let master = &project.sequence(sequence_id(project)).unwrap().master_effects;
    assert_eq!(master.iter().map(|e| (e.effect.as_str(), e.enabled)).collect::<Vec<_>>(), [("hard_limiter", false), ("studio_reverb", true)]);
}

#[test]
fn transcripts_of_two_items_are_both_kept() {
    let mut project = captioned();
    let media = media_id(&project);
    let kind = project.item(media).unwrap().kind.clone();
    project.add_item("Second.mp4", Label::Iris, kind, None);
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    for (session, name, who) in [(&mut agent, "Second.mp4", "b"), (&mut doc, "Ocean_Sunset.mp4", "a")] {
        let mut after = session.model().project.clone();
        let item = after.items.values().find(|item| item.name == name).unwrap().id;
        let mut transcript = kition_film_project::Transcript { language: "en".into(), source: "manual".into(), ..Default::default() };
        transcript.words.push(kition_film_project::Word::new(who, Tick(0), Tick(1_000)));
        after.transcripts.insert(item, std::sync::Arc::new(transcript));
        record(session, &person(who), &after);
    }
    merge(&mut doc, &agent, &base);
    let mut words: Vec<String> = doc.model().project.transcripts.values().map(|t| t.words[0].text.clone()).collect();
    words.sort();
    assert_eq!(words, ["a", "b"]);
}

#[test]
fn search_bins_from_both_sides_are_both_kept() {
    let mut doc = first(&captioned());
    let (mut agent, base) = draft(&doc, 2);
    for (session, who) in [(&mut agent, "b"), (&mut doc, "a")] {
        let mut after = session.model().project.clone();
        let id = after.alloc_id();
        after.search_bins.push(kition_film_project::find::SearchBin {
            id: kition_film_project::BinId(id),
            name: who.into(),
            query: kition_film_project::find::FindQuery { rows: Vec::new(), match_all: true, case_sensitive: false },
        });
        record(session, &person(who), &after);
    }
    merge(&mut doc, &agent, &base);
    let mut names: Vec<&str> = doc.model().project.search_bins.iter().map(|bin| bin.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["a", "b"]);
}

/// A LUT imported on each side: both are kept, the document reading the draft's LUT text from the
/// blobs handed to it before the merge.
#[test]
fn luts_from_both_sides_are_both_kept_with_their_text() {
    let lut =
        |id: &str, text: &str| kition_film_project::ProjectLut { id: id.into(), name: id.into(), source_path: None, format: "cube".into(), text: text.into() };
    let mut doc = kdm_model::FilmSession::create(&captioned()).unwrap();
    let base = doc.version();
    let mut agent = kdm_model::FilmSession::open_snapshot(&doc.snapshot().unwrap(), doc.blobs()).unwrap();
    let mut after = agent.project().clone();
    let id = after.alloc_id();
    after.luts.push(lut(&format!("lut{id}"), "LUT_3D_SIZE 2\n# b"));
    agent.record(&person("b"), &after).unwrap();
    let mut after = doc.project().clone();
    let id = after.alloc_id();
    after.luts.push(lut(&format!("lut{id}"), "LUT_3D_SIZE 2\n# a"));
    doc.record(&person("a"), &after).unwrap();
    doc.add_blobs(&agent.blobs());
    let (scope, _) = doc.merge_changes(&agent.export_changes(&base).unwrap(), &person("a")).unwrap();
    assert_eq!(scope, Some(UndoScope::Person));
    let mut texts: Vec<&str> = doc.project().luts.iter().map(|lut| &*lut.text).collect();
    texts.sort_unstable();
    assert_eq!(texts, ["LUT_3D_SIZE 2\n# a", "LUT_3D_SIZE 2\n# b"]);
    // Without the text, a replica refuses to read rather than lose the LUT.
    assert!(kdm_model::FilmSession::open_snapshot(&doc.snapshot().unwrap(), Default::default()).is_err());
    // The blobs travel as bytes.
    let decoded = kdm_model::decode_blobs(&kdm_model::encode_blobs(&doc.blobs())).unwrap();
    assert_eq!(decoded.0.len(), 2);
    assert!(kdm_model::decode_blobs(&[1, 2, 3]).is_err());
}

#[test]
fn source_graphics_of_two_items_are_both_kept() {
    let (mut project, _, _) = demo_project();
    let rate = kition_film_time::FrameRate::FPS_24;
    for name in ["Title A", "Title B"] {
        project.add_item(name, Label::Iris, ItemKind::Graphic { width: 64, height: 36, rate }, None);
    }
    let mut doc = first(&project);
    let (mut agent, base) = draft(&doc, 2);
    for (session, name, who) in [(&mut agent, "Title B", "b"), (&mut doc, "Title A", "a")] {
        let mut after = session.model().project.clone();
        let item = after.items.values().find(|item| item.name == name).unwrap().id;
        after.source_graphics.insert(item, kition_film_project::SourceGraphic { layers: vec![effect("opacity")], meta: None });
        record(session, &person(who), &after);
    }
    merge(&mut doc, &agent, &base);
    let project = &doc.model().project;
    assert_eq!(project.source_graphics.len(), 2);
    assert!(project.source_graphics.values().all(|graphic| graphic.layers.len() == 1));
}
