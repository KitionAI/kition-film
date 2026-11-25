//! commands.rs:1726-1748,1779-1795; edit/lib.rs:313-340,448-473.
//! Range removal copies boundary material and changes transition membership.
//! Close Gap searches edges, validates sync lanes and shifts their suffixes.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{Covers, KitDocument, Premise, Under};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] = &[("sequence.lift", "marked-range"), ("sequence.extract", "marked-range"), ("sequence.closeGap", "gap")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-active-state", "coarse-mode-state", "whole-range-transition-list"];
    if command == "sequence.lift" {
        out.push("removed-clip-start");
    }
    if command == "sequence.closeGap" {
        out.extend(["whole-gap-search-geometry", "whole-gap-track-order"]);
    }
    out
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn expected(project: &Project, seq: u64, command: &str, markers: bool, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    if command == "sequence.closeGap" {
        want.premises.push(leaf(seq, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
        if p.get("frame").is_some() {
            want.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate"]));
        }
        if let Some(name) = p["track"].as_str() {
            let index = name[1..].parse::<usize>().unwrap() - 1;
            let (tracks, field) = if name.starts_with('V') { (&q.video_tracks, "sequence.videoTracks") } else { (&q.audio_tracks, "sequence.audioTracks") };
            want.premises.push(leaf(tracks[index].id.0, &[]).positions([field]));
        }
        for track in q.all_tracks() {
            want.premises.push(leaf(track.id.0, &["props.locked", "props.sync_lock", "~editEdges", "transitions"]));
        }
        if markers {
            want.premises.push(leaf(seq, &["sequence.markers"]));
        }
        return want;
    }
    let extract = command == "sequence.extract";
    let at = q.mark_in.unwrap_or_default();
    let end = q.mark_out.map(|out| out + q.settings.frame_rate.frame_duration()).unwrap_or_else(|| q.duration());
    let mut fields = vec!["sequence.settings.mark_in".into(), "sequence.settings.mark_out".into(), "sequence.settings.settings.frame_rate".into()];
    if extract {
        fields.push("sequence.settings.split".into());
        if markers {
            fields.push("sequence.markers".into());
        }
        fields.push("~markedCaptionMaterial".into());
        for track in &q.caption_tracks {
            let path = format!("sequence.captionTracks[id={}]", track.id.0);
            fields.extend([format!("{path}.locked"), format!("{path}.syncLock")]);
            if track.locked || !track.sync_lock {
                continue;
            }
            for caption in &track.captions {
                let path = format!("sequence.captions[id={}]", caption.id.0);
                if caption.start >= end {
                    fields.push(format!("{path}.start"));
                } else if caption.end() > at {
                    fields.push(path);
                }
            }
            // The captions in the range are held by their identities (`~markedCaptionMaterial`
            // above), not by a time window: time5 `caption-range` requires a caption added,
            // removed, replaced or moved across the range to refuse as `changed`.
        }
    }
    want.premises.push(Premise::on(json!(seq)).fields(fields).positions(if q.mark_out.is_none() { vec!["sequence.duration"] } else { vec![] }));
    want.covers = Some(Covers::default());
    if end <= at {
        return want;
    }
    for track in q.all_tracks() {
        if track.items.iter().any(|clip| clip.end() > at && (extract || clip.start < end)) {
            want.premises.push(leaf(track.id.0, if extract { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
        }
        if track.locked {
            continue;
        }
        // edit/lib.rs:313-340: a lane with neither clips nor transitions has none to remove or
        // shift (time5 `range-lift`/`range-extract` require an empty lane added above to apply).
        if !track.items.is_empty() || !track.transitions.is_empty() {
            want.premises.push(leaf(track.id.0, &["transitions"]));
        }
        for clip in track.items.iter().filter(|clip| clip.start < end && clip.end() > at) {
            want.objects.push(json!(clip.id.0));
            want.premises.push(if clip.start >= at && clip.end() <= end {
                leaf(clip.id.0, &[]).positions(if extract { vec!["clipId"] } else { vec!["start", "clipId"] })
            } else {
                Premise::on(json!(clip.id.0)).positions(["start", "duration", "clipId"])
            });
        }
    }
    want
}
#[test]
fn range_and_gap_compare_marks_boundary_material_transitions_sync_flags_and_marker_assignments() {
    let mut doc = FilmDocument::create("Range.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    for at in [0, 2, 4] {
        let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":at})).unwrap()["clips"][0].clone();
        doc.execute("sequence.applyVideoTransition", json!({"clip":clip,"edge":"in","frames":6})).unwrap();
    }
    for markers in [false, true] {
        doc.execute("marker.rippleSequenceMarkers", json!({"on":markers})).unwrap();
        for locked in [false, true] {
            doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
            for bounds in [(None, None), (Some(0), Some(3)), (Some(1), Some(2))] {
                doc.execute("marker.clearInOut", json!({})).unwrap();
                if let Some(at) = bounds.0 {
                    doc.execute("marker.markIn", json!({"seconds":at})).unwrap();
                }
                if let Some(at) = bounds.1 {
                    doc.execute("marker.markOut", json!({"seconds":at})).unwrap();
                }
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                for &(command, _) in PATHS {
                    for p in
                        if command == "sequence.closeGap" { vec![json!({"track":"V1","seconds":1.5}), json!({"track":1,"frame":40})] } else { vec![json!({})] }
                    {
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap()),
                            normalized(expected(&project, seq, command, markers, &p)),
                            "{command}/{p}/{markers}/{locked}/{bounds:?}"
                        );
                    }
                }
            }
        }
    }
}
