//! Membership premises must not create quadratic-sized snapshots from a linear project.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ClipId;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn large_link_and_through_memberships_have_bounded_profile_payloads() {
    const COUNT: usize = 256;
    let mut p = kition_film_format::decode(&project(2)).unwrap().project;
    let sequence = p.sequences().next().unwrap().id;
    let base = p.sequence(sequence).unwrap().video_tracks[0].items[0].clone();
    let mut clips = Vec::new();
    for index in 0..COUNT {
        let mut clip = base.clone();
        clip.id = ClipId(p.alloc_id());
        clip.start = serde_json::from_value(json!(index as i64 * 100)).unwrap();
        clip.duration = serde_json::from_value(json!(100)).unwrap();
        clip.source_in = clip.start;
        clip.link = Some(910_000);
        clips.push(clip);
    }
    p.sequence_mut(sequence).unwrap().video_tracks[0].items = clips;
    let bytes = kition_film_format::encode(&p, true);
    let doc = FilmDocument::open(FILE, &bytes).unwrap();
    let profile = doc.derived(&[], &[]).unwrap();
    let bytes = serde_json::to_vec(&profile).unwrap().len();
    assert!(bytes <= COUNT * 1024, "a {COUNT}-clip project expands to {bytes} bytes of guard facts");
}
