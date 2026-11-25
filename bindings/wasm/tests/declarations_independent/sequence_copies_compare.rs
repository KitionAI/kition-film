//! sequence_tools.rs:363-455 copies selected/ranged clips and eligible
//! transitions, preserving source track names/channels and sequence settings.
//! sequence_extras.rs:299-459 clones the sequence before applying its filters.
use super::{attributes_replace_compare::operands, sync_compare::normalized};
use kition_film_engine::project::{ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("sequence.makeSubsequence", "selected clips"), ("sequence.makeSubsequence", "empty selection with range"), ("sequence.simplify", "clone")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x848ed5aa3b9d96b3
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_extras.rs")) == 0xdc0de290f29296a5
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "sequence.simplify" {
        vec!["whole-copied-track-profile", "whole-copy-source-positions"]
    } else {
        vec!["coarse-selection-state", "coarse-active-state", "coarse-mode-state", "whole-copy-source-positions", "unconsumed-layout-channels"]
    }
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, command: &str, selected: &[u64], linked: bool, params: &Value) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let simplify = command == "sequence.simplify";
    let mut fields = if simplify {
        vec![
            "sequence.settings",
            "sequence.masterVolumeDb",
            "sequence.masterEffects",
            "sequence.mixer",
            "sequence.captionTracks",
            "sequence.captions",
            "props.common.label",
        ]
    } else {
        vec!["sequence.settings.settings", "sequence.settings.mark_in", "sequence.settings.mark_out"]
    };
    if params.get("name").is_none() {
        fields.push("name");
    }
    let mut want = Under { premises: vec![leaf(sequence, fields), leaf(sequence, ["~videoTrackOrder", "~audioTrackOrder"])], ..Default::default() };
    let selected = if simplify { selected.to_vec() } else { operands(q, selected, linked, &mut want) };
    for (tracks, position) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks")] {
        for track in tracks {
            want.premises.push(leaf(track.id.0, ["props.name", "props.channels"]).positions([position]));
        }
    }
    let mut copied = Vec::new();
    let from = q.mark_in.unwrap_or_default().0;
    let end = q.mark_out.map(|t| t.0 + q.settings.frame_rate.frame_duration().0).unwrap_or_else(|| q.duration().0);
    for track in q.all_tracks() {
        if simplify {
            want.premises.push(Premise::on(json!(track.id.0)));
        }
        for clip in &track.items {
            // Without a saved targeting map the constructor targets all tracks.
            let candidate = simplify || selected.is_empty() || selected.contains(&clip.id.0);
            if candidate {
                want.premises.push(leaf(clip.id.0, ["link"]).positions(["start", "duration"]));
                let inside = (q.mark_in.is_none() && q.mark_out.is_none()) || clip.start.0 < end && clip.end().0 > from;
                if simplify || inside {
                    want.premises.push(Premise::on(json!(clip.id.0)));
                    copied.push(clip.id);
                    if simplify && params.get("removeText").and_then(Value::as_bool) == Some(true) {
                        want.premises.push(leaf(clip.item.0, ["kind"]));
                    }
                }
            } else if linked && !simplify {
                want.premises.push(leaf(clip.id.0, ["link"]));
            }
        }
        for transition in &track.transitions {
            if simplify || transition.from.is_none_or(|id| copied.contains(&id)) && transition.to.is_none_or(|id| copied.contains(&id)) {
                want.premises.push(Premise::on(json!(transition.id.0)));
            }
        }
    }
    if !simplify && params.get("name").is_none() {
        want.premises.extend(project.items.values().map(|item| leaf(item.id.0, ["name"])));
    }
    want
}
#[test]
fn sequence_copy_paths_compare_selection_range_settings_layout_transitions_and_filters() {
    for linked in [false, true] {
        for marked in [false, true] {
            let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
            let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            let source = doc.execute("item.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].clone();
            let mut clips = Vec::new();
            for time in [0i64, 1_270_080_000_000] {
                clips.extend(
                    doc.execute("timeline.place", json!({"item":source,"track":"V1","time":time})).unwrap()["clips"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_u64),
                );
            }
            doc.execute("sequence.applyVideoTransition", json!({"clip":clips[0],"edge":"in","frames":8})).unwrap();
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            if marked {
                doc.execute("marker.markIn", json!({"time":254_016_000_000i64})).unwrap();
                doc.execute("marker.markOut", json!({"time":762_048_000_000i64})).unwrap();
            }
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for selected in [vec![], vec![clips[0]], vec![clips[2]], clips.clone()] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                    let simplify = command == "sequence.simplify";
                    assert_eq!(
                        spec.reads,
                        if simplify {
                            vec![EditorState::Part]
                        } else {
                            vec![EditorState::Part, EditorState::Selection, EditorState::Mode, EditorState::Active]
                        }
                    );
                    assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    for mask in 0..32 {
                        let mut params = json!({"removeText":mask&1!=0,"removeDisabled":mask&2!=0,"closeGaps":mask&4!=0,"removeEmptyTracks":mask&8!=0,"keep":if mask&16!=0 {"audio"}else{"both"}});
                        if mask & 1 != 0 {
                            params["name"] = json!("Assigned");
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(expected(&project, sequence, command, &selected, linked, &params)),
                            "{command}/{params}/selected={selected:?}/marked={marked}/linked={linked}"
                        );
                    }
                }
            }
        }
    }
}
