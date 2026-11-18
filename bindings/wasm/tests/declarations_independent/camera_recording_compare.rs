//! multicam.rs:880-1064; edit/multicam.rs:116-160. Replay restores its
//! provisional patch, then splits, assigns and heals recorded lanes. The
//! declaration holds all lane material, including untouched off-pass clips.
use super::super::sync_compare::normalized;
use super::{at, fixture, leaf, lookup, recording_command, window, winner};
use kition_film_engine::project::{ClipId, ItemId, Project, Sequence};
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

fn first_tracks(project: &Project, sequence: u64, time: i64, targeted: &[u64], top_down: bool, follows: bool) -> Vec<u64> {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let Some(id) = winner(project, sequence, time, targeted, top_down) else { return vec![] };
    let clip = q.find_item(ClipId(id)).unwrap().1;
    let mut tracks: Vec<_> = q
        .video_tracks
        .iter()
        .filter(|track| at(track, time).is_some_and(|candidate| candidate.item == clip.item && candidate.multicam.is_some()))
        .take(1)
        .map(|track| track.id.0)
        .collect();
    if follows && let Some(link) = clip.link {
        tracks.extend(
            q.audio_tracks
                .iter()
                .filter(|track| track.items.iter().any(|candidate| candidate.link == Some(link) && candidate.multicam.is_some()))
                .map(|track| track.id.0),
        );
    }
    tracks
}

fn replay(q: &Sequence, tracks: &[u64], want: &mut Under) {
    for &id in tracks {
        want.premises.push(leaf(id, ["props.locked", "~clipOrder", "transitions"]));
        if let Some(track) = q.track(kition_film_engine::project::TrackId(id)) {
            want.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
            want.premises.extend(track.transitions.iter().map(|transition| Premise::on(json!(transition.id.0))));
        }
    }
}

#[test]
fn recording_paths_compare_new_and_provisional_passes_lookup_audio_and_replay_material() {
    const QUARTER: i64 = 63_504_000_000;
    for explicit in [false, true] {
        for top_down in [false, true] {
            for follows in [false, true] {
                for primed in [false, true] {
                    for targeted_only in [false, true] {
                        let (mut doc, sequence, source, _) = fixture(explicit);
                        doc.execute("multicam.selectionTopDown", json!({"enabled":top_down})).unwrap();
                        doc.execute("multicam.audioFollowsVideo", json!({"enabled":follows})).unwrap();
                        let base = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                        let q = base.sequence(ItemId(sequence)).unwrap();
                        let targeted: Vec<_> =
                            q.all_tracks().filter(|track| !targeted_only || track.id == q.video_tracks[1].id).map(|track| track.id.0).collect();
                        for track in q.all_tracks() {
                            doc.execute("timeline.setTargeting", json!({"track":track.id.0,"targeted":targeted.contains(&track.id.0)})).unwrap();
                        }
                        doc.execute("multicam.recordStart", json!({"time":0})).unwrap();
                        let fixed = if primed { first_tracks(&base, sequence, QUARTER, &targeted, top_down, follows) } else { vec![] };
                        if primed {
                            doc.execute("multicam.cut", json!({"camera":2,"time":QUARTER})).unwrap();
                        }
                        assert_eq!(
                            doc.editor_state()["mode"]["multicamRecording"],
                            json!({"sequence":sequence,"start":"0","tracks":fixed,"source":primed.then_some(source),"cuts":if primed {json!([[QUARTER.to_string(),1]])} else {json!([])}})
                        );
                        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                        let q = project.sequence(ItemId(sequence)).unwrap();
                        for requested in [QUARTER, 2 * QUARTER, 4 * QUARTER, 12 * QUARTER] {
                            doc.execute("playhead.set", json!({"time":requested})).unwrap();
                            let time = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                            for command in super::SWITCHES.iter().copied().chain(["multicam.recordStop"]).filter(|command| recording_command(command)) {
                                assert!(super::compared_path(command, "recording"));
                                let stop = command == "multicam.recordStop";
                                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                                assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                                assert_eq!(
                                    spec.reads,
                                    if stop {
                                        vec![EditorState::Part, EditorState::Time, EditorState::Mode]
                                    } else {
                                        vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode, EditorState::Active]
                                    }
                                );
                                assert_eq!(
                                    spec.places,
                                    if matches!(command, "multicam.cut" | "multicam.cutToCamera" | "multicam.recordStop") { vec!["time"] } else { vec![] }
                                );
                                assert!(
                                    spec.name_params.is_empty()
                                        && spec.name_field.is_none()
                                        && spec.index.is_none()
                                        && !spec.index_numbers
                                        && !spec.index_reversed
                                );
                                for video_only in [false, true] {
                                    let params = if stop {
                                        json!({})
                                    } else if matches!(command, "multicam.cut" | "multicam.cutToCamera") {
                                        json!({"camera":2,"videoOnly":video_only})
                                    } else {
                                        json!({"videoOnly":video_only})
                                    };
                                    let mut want = Under::default();
                                    if !stop {
                                        lookup(&project, sequence, time, &mut want);
                                        for track in q.all_tracks() {
                                            want.within.push(window(track, time));
                                            want.objects.extend(at(track, time).map(|clip| json!(clip.id.0)));
                                        }
                                        let chosen = winner(&project, sequence, time, &targeted, top_down);
                                        let mut targets: Vec<_> = chosen.into_iter().collect();
                                        if follows && !video_only {
                                            let link = chosen.and_then(|id| q.find_item(ClipId(id)).unwrap().1.link);
                                            for clip in q.audio_tracks.iter().flat_map(|track| &track.items) {
                                                want.premises.push(leaf(clip.id.0, ["link", "props.multicam"]));
                                                if link.is_some() && clip.link == link && clip.multicam.is_some() {
                                                    targets.push(clip.id.0);
                                                }
                                            }
                                        }
                                        for id in targets {
                                            let (owner, clip) = q.find_item(ClipId(id)).unwrap();
                                            want.premises.push(leaf(id, ["item", "props.multicam", "link"]));
                                            want.premises.push(leaf(owner.0, ["props.locked"]));
                                            want.premises.push(leaf(clip.item.0, ["kind", "~cameraMap"]));
                                            if command.starts_with("multicam.cutToCamera") {
                                                want.premises.push(Premise::on(json!(id)));
                                            }
                                        }
                                    }
                                    let tracks = if stop || primed {
                                        fixed.clone()
                                    } else {
                                        first_tracks(&project, sequence, time, &targeted, top_down, follows && !video_only)
                                    };
                                    replay(q, &tracks, &mut want);
                                    assert_eq!(
                                        normalized(doc.under(command, &params).unwrap().unwrap()),
                                        normalized(want),
                                        "{command}/{params}/time={time}/primed={primed}/top_down={top_down}/targeted={targeted:?}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
