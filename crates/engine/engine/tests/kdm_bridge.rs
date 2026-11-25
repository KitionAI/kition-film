//! The command bridge to the project's KDM replica (Kition phase 3b, Task 2): every mutating
//! command replicates as one transaction, a second session that imports it reproduces the
//! project, undo after a remote edit keeps the remote edit and reverts only the local one, a
//! coalesced drag is one undo step, playhead and selection changes write nothing, two sessions
//! that take turns editing one line of changes hold the same project, an undo the replica passes
//! over keeps the history in step with it, and a replica the write depth limit refuses is left (a
//! visible reset) and rebuilt by the next edit that fits.

use kition_film_engine::{Origin, Session, UndoScope};
use kition_film_project::ClipId;
use serde_json::{Value, json};

fn new_session() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

/// A second session holding a replica of `a`'s active project, open on the same sequence
/// (`open_snapshot` resets per-person state, including which sequence is active, to its usual
/// defaults: this picks one so the peer can run sequence-targeted commands too).
fn peer(a: &mut Session) -> Session {
    let mut b = Session::default();
    b.open_snapshot(&a.snapshot().unwrap()).unwrap();
    let seq = b.project.sequences().next().map(|i| i.id);
    b.state.active_sequence = seq;
    b.state.open_sequences = seq.into_iter().collect();
    b
}

/// Sends `from`'s changes that `to` lacks to `to`.
fn send(from: &mut Session, to: &mut Session) {
    let since = to.version().unwrap();
    let bytes = from.export_changes(&since).unwrap();
    to.import_changes(&bytes).unwrap();
}

/// Exchanges changes both ways until the two hold the same version (or panics after a generous
/// number of rounds): the side that wrote since the last exchange hands its changes over.
fn sync(a: &mut Session, b: &mut Session) {
    for _ in 0..8 {
        send(a, b);
        send(b, a);
        if a.version().unwrap() == b.version().unwrap() {
            return;
        }
    }
    panic!("the replicas did not converge");
}

/// `a` and `b` hold the same replicated state and the same project content (ids aside).
fn assert_same(a: &mut Session, b: &mut Session, what: &str) {
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap(), "{what}: replicas differ");
    let left = serde_json::to_value(kdm_model::normalize(&a.project)).unwrap();
    let right = serde_json::to_value(kdm_model::normalize(&b.project)).unwrap();
    assert_eq!(left, right, "{what}: projects differ");
}

fn first_video_clip(s: &Session) -> ClipId {
    s.active_sequence().unwrap().video_tracks[0].items.first().unwrap().id
}

fn scale_of(s: &Session, clip: u64) -> f64 {
    s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1.effect("motion").unwrap().param("scale").unwrap().value.as_f64().unwrap()
}

#[test]
fn one_command_one_transaction_reproduces_in_a_peer() {
    let cases: Vec<(&str, fn(&mut Session))> = vec![
        ("timeline.trim", |s| {
            let c = first_video_clip(s).0;
            s.execute("timeline.trim", json!({"clip": c, "edge": "in", "mode": "regular", "deltaFrames": 3})).unwrap();
        }),
        ("edit.rippleDelete", |s| {
            // Ripple shifts every sync-locked track; unlock the others first so it is not
            // refused by a clip the ripple would have to overlap elsewhere.
            for name in ["V2", "V3", "A1", "A2", "A3"] {
                let _ = s.execute("timeline.setTrack", json!({"track": name, "syncLock": false}));
            }
            let c = s.active_sequence().unwrap().video_tracks[0].items[1].id.0;
            s.execute("edit.rippleDelete", json!({"clips": [c]})).unwrap();
        }),
        ("sequence.addEditAllTracks (split)", |s| {
            let item = s.active_sequence().unwrap().find_item(first_video_clip(s)).unwrap().1.clone();
            s.set_playhead(kition_film_time::Tick(item.start.0 + item.duration.0 / 2));
            s.execute("sequence.addEditAllTracks", json!({})).unwrap();
        }),
        ("timeline.move", |s| {
            let c = first_video_clip(s).0;
            let end = s.active_sequence().unwrap().duration();
            s.execute("timeline.move", json!({"moves": [{"clip": c, "track": "V1", "time": end.0}], "linked": false})).unwrap();
        }),
        ("effects.setParam", |s| {
            let c = first_video_clip(s).0;
            s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 50.0})).unwrap();
        }),
        ("sequence.addTracks", |s| {
            s.execute("sequence.addTracks", json!({})).unwrap();
        }),
    ];
    for (name, run) in cases {
        let mut a = new_session();
        let mut b = peer(&mut a);
        let version = a.version().unwrap();
        run(&mut a);
        assert_ne!(a.version().unwrap(), version, "{name}: wrote a change");
        assert_eq!(a.history.undo.last().unwrap().2, 1, "{name}: exactly one replica undo step");
        send(&mut a, &mut b);
        assert_same(&mut a, &mut b, name);
    }
}

#[test]
fn undo_after_a_remote_edit_keeps_it_and_reverts_only_the_local_one() {
    let mut a = new_session();
    let mut b = peer(&mut a);
    // `a` and `b` are two views of the same replicated content, but each minted its own local
    // ids for it (a peer's `open_snapshot` does not know `a`'s): find "the second clip on V1" on
    // each side separately rather than assuming the same `ClipId` names it on both.
    let shared = first_video_clip(&a).0;
    let other_on_a = a.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    let other_on_b = b.active_sequence().unwrap().video_tracks[0].items[1].id.0;
    let scale_before = scale_of(&a, shared);
    // The demo project's first clip is not cut in at its source's zero (see `demo.rs`'s
    // `cuts`): compare the trim's undo against this clip's own actual starting point, not 0.
    let source_in_before = a.active_sequence().unwrap().find_item(ClipId(shared)).unwrap().1.source_in;

    // One line of changes: the local trim reaches `b`, then `b`'s edit reaches `a`.
    a.execute("timeline.trim", json!({"clip": shared, "edge": "in", "mode": "regular", "deltaFrames": 3})).unwrap();
    sync(&mut a, &mut b);
    b.execute("effects.setParam", json!({"clip": other_on_b, "effect": "motion", "param": "scale", "value": 42.0})).unwrap();
    sync(&mut a, &mut b);
    assert_same(&mut a, &mut b, "exchanged");
    assert_eq!(scale_of(&a, other_on_a), 42.0, "the remote change arrived");

    assert!(a.undo().is_some(), "the local trim undoes");
    assert_eq!(a.active_sequence().unwrap().find_item(ClipId(shared)).unwrap().1.source_in, source_in_before, "the local trim is gone");
    assert_eq!(scale_of(&a, other_on_a), 42.0, "the remote change survives the local undo");
    assert_eq!(scale_of(&a, shared), scale_before);

    sync(&mut a, &mut b);
    assert_same(&mut a, &mut b, "after the undo");
}

#[test]
fn a_coalesced_drag_is_one_undo_step() {
    let mut s = new_session();
    let c = first_video_clip(&s).0;
    let before = scale_of(&s, c);
    let past = s.history.undo.len();
    for v in [90.0, 70.0, 50.0, 30.0] {
        s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": v, "merge": true})).unwrap();
    }
    assert_eq!(s.history.undo.len(), past + 1, "one history step");
    assert_eq!(s.history.undo.last().unwrap().2, 1, "one replica undo step for the whole drag");
    assert!(s.undo().is_some());
    assert_eq!(scale_of(&s, c), before, "one undo takes the whole drag back");
    assert!(s.redo().is_some());
    assert_eq!(scale_of(&s, c), 30.0);
}

#[test]
fn playhead_and_selection_changes_write_nothing() {
    let mut a = new_session();
    let mut b = peer(&mut a);
    let version = a.version().unwrap();
    let hash = a.state_hash().unwrap();
    a.execute("playhead.set", json!({"seconds": 2.0})).unwrap();
    let c = first_video_clip(&a).0;
    a.execute("timeline.select", json!({"clips": [c]})).unwrap();
    assert_eq!(a.version().unwrap(), version, "no transaction");
    assert_eq!(a.state_hash().unwrap(), hash);
    assert!(!a.state.selection.is_empty());
    assert!(b.state.selection.is_empty(), "the peer's own state is untouched");
    send(&mut a, &mut b);
    assert_same(&mut a, &mut b, "after exporting (nothing to export)");
}

/// Kition platform KitModel 1.1 M12a: on one replica, the person's undo and an agent's undo each
/// take back only their own steps and keep the other's.
#[test]
fn agent_edits_record_their_origin_and_undo_in_their_own_scope() {
    let mut s = new_session();
    let agent = Origin::agent("test");
    let c = first_video_clip(&s).0;
    let before = scale_of(&s, c);
    s.execute_as("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 55.0}), &agent).unwrap();
    assert_eq!(s.origin(), kition_film_engine::kdm_bridge::local_person(), "the origin is restored after the call");
    assert_eq!(scale_of(&s, c), 55.0);
    assert!(s.undo().is_none(), "the person has no step of their own to undo");
    assert_eq!(scale_of(&s, c), 55.0, "and the person's undo keeps the agent's edit");
    s.execute_as("edit.undo", json!({}), &agent).unwrap();
    assert_eq!(scale_of(&s, c), before, "the agent's undo takes it back");
    assert_same_as_replica(&mut s);
}

/// M12a: an agent's undo of a step under the person's later edit (of another clip: a later write
/// to the same register keeps what it wrote) keeps the person's edit, and `edit.undo`'s `scope`
/// (engine rule E14a) names whose step to undo.
#[test]
fn an_agent_undo_under_the_persons_later_step_keeps_the_persons_edit() {
    let mut s = new_session();
    let agent = Origin::agent("test");
    let items = &s.active_sequence().unwrap().video_tracks[0].items;
    let (c, d) = (items[0].id.0, items[1].id.0);
    let before = scale_of(&s, c);
    s.execute_as("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": 55.0}), &agent).unwrap();
    s.execute("effects.setParam", json!({"clip": d, "effect": "motion", "param": "rotation", "value": 30.0})).unwrap();
    s.execute("edit.undo", json!({"scope": "agent"})).unwrap();
    assert_eq!(scale_of(&s, c), before, "the agent's step is undone");
    assert_eq!(rotation_of(&s, d), 30.0, "the person's later edit stays");
    s.execute_as("edit.redo", json!({}), &agent).unwrap();
    assert_eq!(scale_of(&s, c), 55.0, "the agent's redo brings its step back");
    assert_eq!(rotation_of(&s, d), 30.0);
    assert!(s.execute("edit.undo", json!({"scope": "other"})).is_err(), "an unknown scope is refused");
    assert_same_as_replica(&mut s);
}

/// The Motion parameters of `clip`, as JSON (an automatic point is `null`).
fn motion_params(s: &Session, clip: u64) -> Value {
    serde_json::to_value(&s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1.effect("motion").unwrap().params).unwrap()
}

/// A drag that changes two Motion parameters (the anchor point, automatic until then, and the
/// position, merged by the drag's key as the Program monitor sends them) is one undo step: one
/// undo puts both back, on the project and on its replica, and one redo brings the drag's end back.
#[test]
fn a_merged_drag_of_two_parameters_undoes_as_one_step() {
    let mut s = new_session();
    let c = first_video_clip(&s).0;
    s.execute("timeline.setTrack", json!({"track": "V3", "name": "Before"})).unwrap();
    let before = motion_params(&s, c);
    let past = s.history.undo.len();
    for (i, step) in [1.0, 2.0, 3.0, 4.0].into_iter().enumerate() {
        for (k, param) in ["anchor", "position"].into_iter().enumerate() {
            let value = json!([100.0 + step, 50.0 + step]);
            s.execute("effects.setParam", json!({"clip": c, "effect": "motion", "param": param, "value": value, "merge": "drag", "begin": i == 0 && k == 0}))
                .unwrap();
        }
    }
    let after = motion_params(&s, c);
    assert_ne!(after, before);
    assert_eq!(s.history.undo.len(), past + 1, "one history step");
    assert_eq!(s.history.undo.last().unwrap().2, 1, "one replica undo step");
    assert_same_as_replica(&mut s);
    assert!(s.undo().is_some());
    assert_eq!(motion_params(&s, c), before, "one undo puts both parameters back");
    assert_same_as_replica(&mut s);
    assert!(s.redo().is_some());
    assert_eq!(motion_params(&s, c), after, "one redo brings the drag's end back");
    assert_same_as_replica(&mut s);
    assert_eq!(s.kdm_resets(), 0);
}

/// The effects of `clip`, in order.
fn effect_order(s: &Session, clip: u64) -> Vec<String> {
    s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1.effects.iter().map(|effect| effect.effect.clone()).collect()
}

/// A standard effect moved before another (Effect Controls' drag) undoes to its place among the
/// fixed effects, on the project and on its replica.
#[test]
fn an_effect_moved_among_the_standard_ones_undoes_to_its_place() {
    let mut s = new_session();
    let c = first_video_clip(&s).0;
    for effect in ["gaussian_blur", "invert"] {
        s.execute("effects.apply", json!({"clips": [c], "effect": effect})).unwrap();
    }
    let before = effect_order(&s, c);
    let at = |name: &str| before.iter().position(|effect| effect == name).unwrap();
    let (blur, invert) = (at("gaussian_blur"), at("invert"));
    assert!(blur < invert, "{before:?}");
    s.execute("effects.move", json!({"clip": c, "index": invert, "to": blur})).unwrap();
    let moved = effect_order(&s, c);
    assert_eq!(moved.iter().position(|effect| effect == "invert"), Some(blur), "{moved:?}");
    assert_same_as_replica(&mut s);
    assert!(s.undo().is_some());
    assert_eq!(effect_order(&s, c), before, "one undo puts the effect back where it was");
    assert_same_as_replica(&mut s);
    assert!(s.redo().is_some());
    assert_eq!(effect_order(&s, c), moved);
    assert_same_as_replica(&mut s);
    assert_eq!(s.kdm_resets(), 0);
}

/// The name of the active sequence's first video track.
fn first_track_name(s: &Session) -> String {
    s.active_sequence().unwrap().video_tracks[0].name.clone()
}

/// The person renames V1, adds a track and renames it; an agent deletes that track. The replica
/// has nothing left of the person's last two steps (their track is gone) and passes over them,
/// taking back the step below: the engine's history takes the entries the replica took with it,
/// so undoing to the end and redoing to the end never asks the replica for a step it no longer
/// holds (which left the replica, a reset) and the project is what the replica holds throughout.
#[test]
fn undos_the_replica_passes_over_keep_the_history_in_step_with_it() {
    let mut s = new_session();
    let original = first_track_name(&s);
    let tracks = s.active_sequence().unwrap().video_tracks.len();
    s.execute("timeline.setTrack", json!({"track": "V1", "name": "Base"})).unwrap();
    s.execute("sequence.addTracks", json!({"video": 1, "audio": 0})).unwrap();
    let added = format!("V{}", tracks + 1);
    s.execute("timeline.setTrack", json!({"track": added, "name": "Mine"})).unwrap();
    let doc = s.kdm().unwrap().replica().doc_id();
    s.execute_as("sequence.deleteTrack", json!({"track": added}), &Origin::agent("test")).unwrap();
    assert_eq!(s.active_sequence().unwrap().video_tracks.len(), tracks, "the agent deleted the added track");
    let mut undos = 0;
    while s.undo().is_some() {
        undos += 1;
        assert_eq!(s.kdm_resets(), 0, "undo {undos}: the replica stays");
        assert_same_as_replica(&mut s);
        assert!(undos <= 3, "at most the person's three steps undo");
    }
    assert!(undos < 3, "the replica took the passed-over steps with another: {undos} undos");
    assert_eq!(first_track_name(&s), original, "every step of the person's is taken back");
    assert!(!s.kdm().unwrap().can_undo_in(UndoScope::Person), "as in the replica's own history");
    assert_eq!(s.kdm().unwrap().replica().doc_id(), doc, "the same document");
    assert_eq!(s.active_sequence().unwrap().video_tracks.len(), tracks, "the deleted track stays deleted");
    let mut redos = 0;
    while s.redo().is_some() {
        redos += 1;
        assert_eq!(s.kdm_resets(), 0, "redo {redos}: the replica stays");
        assert_same_as_replica(&mut s);
        assert!(redos <= undos, "no more redos than undos");
    }
    assert_eq!(first_track_name(&s), "Base", "the person's rename is back");
    s.execute("timeline.setTrack", json!({"track": "V2", "name": "After"})).unwrap();
    assert_eq!(s.kdm_resets(), 0);
    assert_same_as_replica(&mut s);
}

fn rotation_of(s: &Session, clip: u64) -> f64 {
    s.active_sequence().unwrap().find_item(ClipId(clip)).unwrap().1.effect("motion").unwrap().param("rotation").unwrap().value.as_f64().unwrap()
}

/// The session's project is the replica's: no undo detached it (a refused replica step resets it
/// and leaves the engine's snapshot instead).
fn assert_same_as_replica(s: &mut Session) {
    let replica = replica_project(s);
    assert!(same_content(&s.project, &replica), "the project is the replica's");
}

/// A tiny deterministic generator (no extra dependency).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

#[test]
fn a_write_the_replica_refuses_resets_it_and_the_next_edit_rebuilds_it() {
    let mut s = new_session();
    s.execute("sequence.addTracks", json!({})).unwrap();
    assert!(s.kdm().is_some());
    assert_eq!(s.kdm_resets(), 0);

    // Bins nested past the replica's depth limit: the write is refused and the project leaves
    // its replica (a reset hosts see), keeping the edits and their undo.
    let mut parent: Option<u64> = None;
    for i in 0..70 {
        let r = s.execute("file.newBin", json!({"name": format!("G{i}"), "parent": parent})).unwrap();
        parent = r["bin"].as_u64();
    }
    assert!(s.kdm().is_none(), "the project left its replica");
    assert_eq!(s.kdm_resets(), 1);

    // Undo still works, from the engine's own history snapshots.
    for _ in 0..70 {
        assert!(s.undo().is_some(), "undo works without a replica");
    }
    assert!(s.kdm().is_none(), "still no replica: nothing has written to one since the reset");

    // An edit that fits again makes a fresh replica (a new KDM document).
    s.execute("sequence.addTracks", json!({})).unwrap();
    assert!(s.kdm().is_some(), "a fresh replica");
    assert_eq!(s.kdm_resets(), 1, "exactly one reset, not one per refused write");
    let mut peer_of_fresh = peer(&mut s);
    assert_same(&mut s, &mut peer_of_fresh, "a peer joins the fresh replica");
}

/// The project as read back fresh from the session's replica (not the session's own view of it),
/// as it is: without flushing anything the session has not written yet (`ensure_kdm` would).
fn replica_project(s: &mut Session) -> kition_film_project::Project {
    let kdm = s.kdm().expect("an edit made the replica");
    kdm_model::read_document(kdm.replica(), &kdm.blobs()).unwrap().0
}

fn same_content(a: &kition_film_project::Project, b: &kition_film_project::Project) -> bool {
    serde_json::to_value(kdm_model::normalize(a)).unwrap() == serde_json::to_value(kdm_model::normalize(b)).unwrap()
}

fn clip_count(p: &kition_film_project::Project) -> usize {
    p.sequences()
        .filter_map(|i| if let kition_film_project::ItemKind::Sequence(q) = &i.kind { Some(q) } else { None })
        .map(|q| q.video_tracks.iter().chain(q.audio_tracks.iter()).map(|t| t.items.len()).sum::<usize>())
        .sum()
}

/// A clip moved to another track and back is still in the replica (it used to be deleted from
/// it by the move back), so it survives an unrelated edit's undo (which reloads the project from
/// the replica) and reaches a peer.
#[test]
fn a_clip_moved_across_tracks_and_back_stays_in_the_replica() {
    let mut s = new_session();
    let q = s.active_sequence().unwrap().clone();
    let c = q.video_tracks[0].items[0].id.0;
    let end = q.duration();
    let clips = clip_count(&s.project);
    for track in ["V2", "V1", "V2", "V1"] {
        s.execute("timeline.move", json!({"moves": [{"clip": c, "track": track, "time": end.0}], "linked": false})).unwrap();
        let r = replica_project(&mut s);
        assert_eq!(clip_count(&r), clips, "moved to {track}: the replica keeps every clip");
        assert!(same_content(&s.project, &r), "moved to {track}: the replica holds the project");
    }
    s.execute("timeline.setTrack", json!({"track": "V3", "name": "Zed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(clip_count(&s.project), clips, "the undo of an unrelated edit keeps the moved clip");
    assert!(s.active_sequence().unwrap().find_item(ClipId(c)).is_some(), "under its own id");
    let mut b = peer(&mut s);
    assert_same(&mut s, &mut b, "a peer gets the moved clip");
}

/// How many items the bin tree files (an item in no bin is invisible in the Project panel).
fn items_in_tree(p: &kition_film_project::Project) -> usize {
    fn walk(b: &kition_film_project::Bin, n: &mut usize) {
        for e in &b.children {
            match e {
                kition_film_project::BinEntry::Item(_) => *n += 1,
                kition_film_project::BinEntry::Bin(c) => walk(c, n),
            }
        }
    }
    let mut n = 0;
    walk(&p.root, &mut n);
    n
}

/// New Bin From Selection writes the moved items into the new bin, so they are still filed in
/// the replica, after a reload (an unrelated edit's undo) and in a peer.
#[test]
fn new_bin_from_selection_files_its_items_in_the_replica() {
    let mut s = new_session();
    let items: Vec<u64> = s.project.items.values().filter(|i| i.as_media().is_some()).take(2).map(|i| i.id.0).collect();
    s.execute("project.select", json!({"items": items})).unwrap();
    s.execute("file.newBinFromSelection", json!({})).unwrap();
    let filed = items_in_tree(&s.project);
    assert_eq!(filed, s.project.items.len(), "every item is filed in the project");
    assert_eq!(items_in_tree(&replica_project(&mut s)), filed, "and in the replica");
    s.execute("timeline.setTrack", json!({"track": "V3", "name": "Zed"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(items_in_tree(&s.project), filed, "a reload keeps them filed");
    let b = peer(&mut s);
    assert_eq!(items_in_tree(&b.project), filed, "a peer gets them filed");
}

fn track_name(p: &kition_film_project::Project, index: usize) -> Option<String> {
    p.sequences().find_map(|i| if let kition_film_project::ItemKind::Sequence(q) = &i.kind { q.video_tracks.get(index).map(|t| t.name.clone()) } else { None })
}

/// At the history limit a new step drops the oldest one, so the undo stack's length does not
/// change: every command must still replicate as its own step (it used to be taken for a live
/// gesture and deferred, so nothing replicated), and undo must revert exactly the last one.
#[test]
fn every_command_replicates_at_the_history_limit() {
    let mut s = new_session();
    s.history.limit = 3;
    for i in 0..6 {
        s.execute("timeline.setTrack", json!({"track": "V3", "name": format!("N{i}")})).unwrap();
        assert_eq!(track_name(&replica_project(&mut s), 2).as_deref(), Some(format!("N{i}").as_str()), "edit {i} replicated");
        assert_eq!(s.history.undo.last().unwrap().2, 1, "edit {i}: one replica undo step");
    }
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(track_name(&s.project, 2).as_deref(), Some("N4"), "undo reverts the last edit only");
    s.execute("timeline.setTrack", json!({"track": "V2", "name": "X"})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
    let q = s.active_sequence().unwrap();
    assert_eq!(q.video_tracks[2].name, "N4", "undo/edit/undo keeps the earlier undo's result");
    assert_ne!(q.video_tracks[1].name, "X", "and reverts the new edit");
    let r = replica_project(&mut s);
    assert!(same_content(&s.project, &r), "the replica holds the project");
}

/// An edit and its undo: the undo reloads the project from the replica.
fn reload(s: &mut Session, tag: &str) {
    s.execute("timeline.setTrack", json!({"track": "V3", "name": tag})).unwrap();
    s.execute("edit.undo", json!({})).unwrap();
}

/// Links `clips` (unlinking them first if they already all are), answering their shared link id.
fn link(s: &mut Session, clips: [u64; 2]) -> u64 {
    for _ in 0..2 {
        if s.execute("clip.link", json!({"clips": clips})).unwrap()["linked"] == true {
            break;
        }
    }
    let q = s.active_sequence().unwrap();
    let ids: Vec<Option<u64>> = clips.iter().map(|c| q.find_item(ClipId(*c)).unwrap().1.link).collect();
    assert!(ids[0].is_some() && ids[0] == ids[1], "linked: {ids:?}");
    ids[0].unwrap()
}

/// Ids kept only as data inside the replica (a marker's, a link's) are never handed out again
/// after a reload: the replica's own `next_id` hint did not count them, and a reload lowered the
/// counter to it, so two markers shared one id and a new link joined an unrelated linked pair.
#[test]
fn ids_kept_as_data_are_not_reused_after_a_reload() {
    let mut s = new_session();
    reload(&mut s, "a");
    s.execute("markers.add", json!({"target": "program", "name": "A", "time": 0})).unwrap();
    reload(&mut s, "b");
    s.execute("markers.add", json!({"target": "program", "name": "B", "time": 25_401_600_000i64})).unwrap();
    let markers: Vec<u64> = s.active_sequence().unwrap().markers.iter().map(|m| m.id.0).collect();
    let distinct: std::collections::BTreeSet<u64> = markers.iter().copied().collect();
    assert_eq!(distinct.len(), markers.len(), "every marker has its own id: {markers:?}");

    let v: Vec<u64> = s.active_sequence().unwrap().video_tracks[0].items.iter().map(|i| i.id.0).collect();
    let first = link(&mut s, [v[0], v[1]]);
    reload(&mut s, "c");
    let second = link(&mut s, [v[2], v[3]]);
    assert_ne!(first, second, "a new link is not an existing one");
    let q = s.active_sequence().unwrap();
    assert_eq!(q.find_item(ClipId(v[0])).unwrap().1.link, Some(first), "the first pair keeps its own link");
}

/// A stored replica that does not hold what its `.kfilm` holds (the file was saved past it):
/// the file wins. Its content is recorded onto the replica (one `import` transaction, the
/// replica's own document identity kept), so the project, its replica and a peer that still holds
/// the older replica all agree with the file.
#[test]
fn a_file_newer_than_its_stored_replica_wins_on_open() {
    let mut a = new_session();
    a.execute("sequence.addTracks", json!({})).unwrap();
    let snapshot = a.snapshot().unwrap();
    let doc = a.kdm().unwrap().replica().doc_id();
    a.execute("timeline.setTrack", json!({"track": "V3", "name": "Newer"})).unwrap();
    let file = kition_film_format::encode(&a.project, false);

    let mut b = Session::default();
    b.open_with_replica(&file, &snapshot).unwrap();
    assert_eq!(track_name(&b.project, 2).as_deref(), Some("Newer"), "the file's content");
    assert!(same_content(&b.project, &a.project), "the whole file");
    assert!(same_content(&replica_project(&mut b), &a.project), "recorded onto the replica");
    assert_eq!(b.kdm().unwrap().replica().doc_id(), doc, "the replica's own identity");
    assert!(!b.is_dirty(), "the project is the file's");
    let kdm = b.kdm().unwrap();
    assert!(!kdm.can_undo_in(UndoScope::Person) && !kdm.can_undo_in(UndoScope::Agent) && !b.history.can_undo(), "opening is not an undo step");
    assert!(b.state.active_sequence.is_some(), "the project opens on its first sequence");

    let mut c = Session::default();
    c.open_snapshot(&snapshot).unwrap();
    send(&mut b, &mut c);
    assert!(same_content(&c.project, &a.project), "a peer of the older replica gets the file's content");
    assert_eq!(c.state_hash().unwrap(), b.state_hash().unwrap());

    // A file its replica does hold opens as the replica, writing nothing.
    let current = b.snapshot().unwrap();
    let version = b.version().unwrap();
    let mut d = Session::default();
    d.open_with_replica(&file, &current).unwrap();
    assert_eq!(d.version().unwrap(), version, "nothing written");
}

/// A collaborator's changes that the repair after the import refuses (made here by hand, raw on
/// a replica of `a`'s: a clip whose `start` is not a number): a collaborator's rename of the
/// project rides along. `listed` puts the bad clip on one of the sequence's own tracks (so the
/// project cannot be read back either), otherwise on a track no sequence lists (the repair still
/// visits it, the reader never does).
fn changes_the_repair_refuses(a: &mut Session, listed: bool) -> Vec<u8> {
    use kdm_model::kition_kit::kdm::{ActorId, ObjectId, Origin as KdmOrigin, Replica};
    use kdm_model::kition_kit::session::KitModel;
    let mut raw = Replica::load(kdm_model::FilmModel::schema(), &a.snapshot().unwrap(), ActorId::from_u64(77).unwrap()).unwrap();
    let since = raw.version();
    raw.transact(&KdmOrigin::person("user:collaborator"), |tx| {
        tx.set(&ObjectId::from_string("project"), "name", json!("Collab"))?;
        let item = tx.objects_of_type("Item").into_iter().next().unwrap();
        let track = if listed {
            tx.objects_of_type("Track").into_iter().next().unwrap()
        } else {
            let fields = json!({}).as_object().cloned().unwrap();
            tx.create("Track", fields)?
        };
        let clip = json!({"item": item.as_str(), "start": "not a tick", "duration": "1", "sourceIn": "0", "speed": 1.0, "reverse": false});
        let clip = tx.create("Clip", clip.as_object().cloned().unwrap())?;
        tx.list_insert(&track, "clips", 0, &clip)?;
        Ok(())
    })
    .unwrap();
    raw.export_changes(&since).unwrap()
}

/// An import whose repair step fails has still imported the changes, and the project's view
/// was loaded from them: the project follows the replica anyway, so the next local edit does not
/// write the collaborator's changes back out of it.
#[test]
fn a_failed_repair_after_an_import_still_follows_the_replica() {
    let mut a = new_session();
    a.execute("sequence.addTracks", json!({})).unwrap();
    let bytes = changes_the_repair_refuses(&mut a, false);
    assert!(a.import_changes(&bytes).is_err(), "the repair fails");
    assert_eq!(a.project.name, "Collab", "the project follows the imported changes");
    a.execute("timeline.setTrack", json!({"track": "V1", "name": "Local"})).unwrap();
    assert_eq!(replica_project(&mut a).name, "Collab", "the next local edit keeps the collaborator's rename");
    assert_eq!(a.kdm_resets(), 0);
}

/// An import the project cannot even be read back from leaves the replica (a visible reset)
/// rather than let the next local edit diff against a view the replica no longer matches.
#[test]
fn an_import_the_view_cannot_load_leaves_the_replica() {
    let mut a = new_session();
    a.execute("sequence.addTracks", json!({})).unwrap();
    let name = a.project.name.clone();
    let bytes = changes_the_repair_refuses(&mut a, true);
    assert!(a.import_changes(&bytes).is_err());
    assert!(a.kdm().is_none(), "the project left its replica");
    assert_eq!(a.kdm_resets(), 1);
    assert_eq!(a.project.name, name, "the project is as it was");
    a.execute("timeline.setTrack", json!({"track": "V1", "name": "Local"})).unwrap();
    assert!(a.kdm().is_some(), "the next edit makes a fresh replica");
}

/// `p`'s content, id-blind, in the replica reader's own shape: each bin's sub-bins first, then
/// its items (the replica does not keep how a person interleaved the two, by design).
fn canonical(p: &kition_film_project::Project) -> Value {
    fn reorder(bin: &mut kition_film_project::Bin) {
        let (mut bins, items): (Vec<_>, Vec<_>) =
            std::mem::take(&mut bin.children).into_iter().partition(|e| matches!(e, kition_film_project::BinEntry::Bin(_)));
        for entry in &mut bins {
            if let kition_film_project::BinEntry::Bin(child) = entry {
                reorder(child);
            }
        }
        bin.children = bins.into_iter().chain(items).collect();
    }
    let mut p = p.clone();
    reorder(&mut p.root);
    serde_json::to_value(kdm_model::normalize(&p)).unwrap()
}

/// The first few paths at which two JSON values differ (for a readable failure).
fn differences(a: &Value, b: &Value) -> Vec<String> {
    fn walk(a: &Value, b: &Value, path: String, out: &mut Vec<String>) {
        if out.len() >= 5 || a == b {
            return;
        }
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for key in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                    walk(x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null), format!("{path}.{key}"), out);
                }
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                for (i, (p, q)) in x.iter().zip(y).enumerate() {
                    walk(p, q, format!("{path}[{i}]"), out);
                }
            }
            _ => out.push(format!("{path}: {} vs {}", short(a), short(b))),
        }
    }
    fn short(v: &Value) -> String {
        let s = v.to_string();
        if s.len() > 300 { format!("{}…", &s[..300]) } else { s }
    }
    let mut out = Vec::new();
    walk(a, b, String::new(), &mut out);
    out
}

/// One random command of a wide mix: trims, ripple deletes, clips moved across tracks, New Bin
/// From Selection, renames, markers, links, undo and redo.
fn random_wide_command(s: &mut Session, rng: &mut Rng) -> String {
    let Some(seq) = s.active_sequence() else { return "no sequence".into() };
    let ids: Vec<u64> = seq.video_tracks.iter().chain(seq.audio_tracks.iter()).flat_map(|t| t.items.iter().map(|i| i.id.0)).collect();
    let video: Vec<String> = (1..=seq.video_tracks.len()).map(|n| format!("V{n}")).collect();
    let end = seq.duration().0.max(1);
    let pick = |rng: &mut Rng| ids.get(rng.below(ids.len().max(1) as u64) as usize).copied();
    let (id, params) = match rng.below(14) {
        0 => match pick(rng) {
            Some(c) => (
                "timeline.trim",
                json!({"clip": c, "edge": if rng.below(2) == 0 {"in"} else {"out"}, "mode": "regular", "deltaFrames": rng.below(20) as i64 - 10}),
            ),
            None => return "no clip".into(),
        },
        1 => match pick(rng) {
            Some(c) => ("edit.rippleDelete", json!({"clips": [c]})),
            None => return "no clip".into(),
        },
        2..=4 => match pick(rng) {
            Some(c) => {
                let track = video[rng.below(video.len() as u64) as usize].clone();
                ("timeline.move", json!({"moves": [{"clip": c, "track": track, "time": rng.below(end as u64 + 254_016_000_000)}], "linked": rng.below(2) == 0}))
            }
            None => return "no clip".into(),
        },
        5 => match pick(rng) {
            Some(c) => ("effects.setParam", json!({"clip": c, "effect": "motion", "param": "scale", "value": rng.below(200) as f64})),
            None => return "no clip".into(),
        },
        6 => {
            let media: Vec<u64> = s.project.items.values().filter(|i| i.as_media().is_some()).map(|i| i.id.0).collect();
            let n = rng.below(2) as usize + 1;
            let start = rng.below(media.len().max(1) as u64) as usize;
            let chosen: Vec<u64> = media.iter().cycle().skip(start).take(n.min(media.len())).copied().collect();
            let _ = s.execute("project.select", json!({"items": chosen}));
            ("file.newBinFromSelection", json!({}))
        }
        7 => ("timeline.setTrack", json!({"track": video[rng.below(video.len() as u64) as usize], "name": format!("T{}", rng.below(1000))})),
        8 => ("markers.add", json!({"target": "program", "name": format!("M{}", rng.below(1000)), "time": rng.below(end as u64)})),
        9 => match (pick(rng), pick(rng)) {
            (Some(a), Some(b)) if a != b => ("clip.link", json!({"clips": [a, b]})),
            _ => return "no pair".into(),
        },
        10 => ("sequence.addEditAllTracks", json!({})),
        11 => ("edit.redo", json!({})),
        _ => ("edit.undo", json!({})),
    };
    let r = s.execute(id, params.clone());
    format!("{id} {params} -> {}", if r.is_ok() { "ok" } else { "refused" })
}

/// Two sessions run 250 random commands between them (moves across tracks, new bins from the
/// selection, undo and redo with a history limit small enough to wrap), taking turns on one line
/// of changes: five commands of one, then the exchange, then five of the other. After every
/// command the project is exactly what its own replica holds; after every exchange both sessions
/// hold the same replicated state and the same project.
#[test]
fn random_wide_commands_keep_project_and_replica_equal_on_one_line() {
    for seed in [3u64, 11, 2026] {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut a = new_session();
        a.history.limit = 4;
        a.execute("sequence.addTracks", json!({})).unwrap();
        let mut b = peer(&mut a);
        b.history.limit = 4;
        let mut log: Vec<String> = Vec::new();
        for step in 0..250 {
            let turn = if (step / 5) % 2 == 0 { [("a", &mut a)] } else { [("b", &mut b)] };
            for (name, s) in turn {
                let steps_before: Vec<u32> = s.history.undo.iter().map(|e| e.2).collect();
                let what = random_wide_command(s, &mut rng);
                let what = format!(
                    "{what} [steps {steps_before:?} -> {:?}, pushed {} dropped {} labels {:?}]",
                    s.history.undo.iter().map(|e| e.2).collect::<Vec<_>>(),
                    s.history.pushed,
                    s.history.dropped,
                    s.history.undo.iter().map(|e| e.0.clone()).collect::<Vec<_>>()
                );
                log.push(format!("{name}: {what}"));
                let context = || format!("seed {seed}, step {step}, {name}; last commands:\n{}", log[log.len().saturating_sub(6)..].join("\n"));
                assert_eq!(s.kdm_resets(), 0, "{}", context());
                let Some(kdm) = s.kdm() else { panic!("no replica: {}", context()) };
                let replica = kdm_model::read_document(kdm.replica(), &kdm.blobs()).unwrap_or_else(|e| panic!("read: {e}: {}", context())).0;
                let (mine, held) = (canonical(&s.project), canonical(&replica));
                assert!(mine == held, "the project is not what its replica holds: {}\n{:#?}", context(), differences(&mine, &held));
                if let Some(q) = s.active_sequence() {
                    q.check().unwrap_or_else(|e| panic!("overlap {e}: {}", context()));
                }
            }
            if step % 5 == 4 {
                sync(&mut a, &mut b);
                assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap(), "seed {seed}, step {step}: replicas differ");
                let (left, right) = (canonical(&a.project), canonical(&b.project));
                assert!(left == right, "seed {seed}, step {step}: projects differ: {:#?}", differences(&left, &right));
            }
        }
        sync(&mut a, &mut b);
        assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap(), "seed {seed}: final replicas differ");
        assert!(canonical(&a.project) == canonical(&b.project), "seed {seed}: final projects differ");
    }
}

/// A step that changed nothing the replica keeps (a rename to the same name) is worth no replica
/// undo step. Undoing it after a collaborator's edit arrived keeps that edit: the project is the
/// replica's view, not the step's own snapshot (which predates the import, and silently dropped
/// the collaborator's edit from this project while the replica kept it).
#[test]
fn undoing_a_step_the_replica_holds_nothing_of_keeps_imported_edits() {
    let mut a = new_session();
    let mut b = peer(&mut a);
    let same = track_name(&b.project, 2).unwrap();
    b.execute("timeline.setTrack", json!({"track": "V3", "name": same})).unwrap();
    assert_eq!(b.history.undo.last().unwrap().2, 0, "nothing replicated changed");
    a.execute("timeline.setTrack", json!({"track": "V1", "name": "Remote"})).unwrap();
    send(&mut a, &mut b);
    assert!(b.undo().is_some());
    assert_eq!(track_name(&b.project, 0).as_deref(), Some("Remote"), "the collaborator's edit survives the undo");
    let held = replica_project(&mut b);
    assert!(same_content(&b.project, &held), "the project is what its replica holds");
    assert!(b.redo().is_some());
    assert_eq!(track_name(&b.project, 0).as_deref(), Some("Remote"));
}

/// After a reset, the steps taken before it were the dropped replica's: undoing them never steps
/// the fresh replica (whose undo steps are its own), so it is neither reset again nor left
/// holding something the project does not.
#[test]
fn steps_from_before_a_reset_never_step_the_fresh_replica() {
    let mut s = new_session();
    s.execute("timeline.setTrack", json!({"track": "V3", "name": "Before"})).unwrap();
    let mut parent: Option<u64> = None;
    for i in 0..70 {
        let r = s.execute("file.newBin", json!({"name": format!("G{i}"), "parent": parent})).unwrap();
        parent = r["bin"].as_u64();
    }
    assert_eq!(s.kdm_resets(), 1);
    for _ in 0..70 {
        assert!(s.undo().is_some());
    }
    s.execute("timeline.setTrack", json!({"track": "V2", "name": "After"})).unwrap();
    assert!(s.kdm().is_some(), "a fresh replica");
    assert!(s.undo().is_some(), "the fresh replica's own step");
    assert!(s.undo().is_some(), "a step from before the reset");
    assert_eq!(s.kdm_resets(), 1, "the fresh replica was not stepped for it");
    let held = replica_project(&mut s);
    assert!(same_content(&s.project, &held), "the project is what its replica holds");
}
