//! The collections a person edits a piece at a time are objects and containers of their own
//! (schema-freeze): two replicas edit the same collection at the same time, merge, keep both
//! edits, and end identical. Captions and their text, markers and their comments (on a sequence, a
//! clip and a media item), an effect's parameters, master effects, transcripts, source graphics,
//! LUTs and search bins.

mod common;

use common::{add_clip, assert_same_content, demo_project, first, media_id, peer, person, record, sequence_id, sync};
use kition_film_project::caption::{Caption, CaptionTrack};
use kition_film_project::{ClipId, EffectInstance, ItemKind, Label, Marker, MarkerId, ParamValue, Project, TrackId};
use kition_film_time::Tick;

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

/// A project with one caption track holding two captions, and a sequence marker.
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

fn edit(session: &common::Session, change: impl FnOnce(&mut Project, kition_film_project::ItemId)) -> Project {
    let mut after = session.model().project.clone();
    let sequence = sequence_id(&after);
    change(&mut after, sequence);
    after
}

fn converge(a: &mut common::Session, b: &mut common::Session) {
    sync(a, b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap(), "the replicas are identical");
    assert_same_content(&a.model().project, &b.model().project);
}

/// Two people type in one caption at once: both keep their characters (`Caption.text`).
#[test]
fn concurrent_typing_in_one_caption_merges_by_character() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[0].text = "Hello brave world".into());
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[0].text = "Hello world!".into());
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    assert_eq!(project.sequence(sequence_id(project)).unwrap().caption_tracks[0].captions[0].text, "Hello brave world!");
}

/// One person adds a caption while another retimes a different one: both survive.
#[test]
fn concurrent_caption_add_and_retime_both_survive() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "Third")));
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions[1].start = Tick(2_500));
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let captions = &project.sequence(sequence_id(project)).unwrap().caption_tracks[0].captions;
    assert_eq!(captions.iter().map(|c| (c.id.0, c.start.0)).collect::<Vec<_>>(), [(901, 0), (902, 2_500), (5_000_000_001, 4_000)]);
}

/// One person adds a caption to a track while another deletes the track: the replicas end
/// identical, without the track and without a caption left over in it.
#[test]
fn concurrent_caption_add_and_track_delete_converge() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "Third")));
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| p.sequence_mut(s).unwrap().caption_tracks.clear());
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    assert!(project.sequence(sequence_id(project)).unwrap().caption_tracks.is_empty());
}

/// Captions added to two tracks at once, one by each person: each lands in its own track.
#[test]
fn concurrent_captions_on_two_tracks_stay_in_their_tracks() {
    let mut project = captioned();
    let sequence = sequence_id(&project);
    project.sequence_mut(sequence).unwrap().caption_tracks.push(CaptionTrack::new(TrackId(910), "Second".into(), Default::default()));
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| p.sequence_mut(s).unwrap().caption_tracks[0].captions.push(caption(5_000_000_001, 4_000, "First track")));
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| p.sequence_mut(s).unwrap().caption_tracks[1].captions.push(caption(6_000_000_001, 500, "Second track")));
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let tracks = &project.sequence(sequence_id(project)).unwrap().caption_tracks;
    assert_eq!(tracks[0].captions.iter().map(|c| c.id.0).collect::<Vec<_>>(), [901, 902, 5_000_000_001]);
    assert_eq!(tracks[1].captions.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["Second track"]);
}

/// Two people add a marker each, and one edits the comment of the existing marker while the
/// other types in it too: every marker and every character survives.
#[test]
fn concurrent_markers_and_comment_edits_all_survive() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| {
        let seq = p.sequence_mut(s).unwrap();
        seq.markers.push(marker(5_000_000_001, 100, "a"));
        seq.markers[0].comment = "Please check the cut".into();
    });
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| {
        let seq = p.sequence_mut(s).unwrap();
        seq.markers.push(marker(6_000_000_001, 200, "b"));
        seq.markers[0].comment = "Check the cut again".into();
    });
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let markers = &project.sequence(sequence_id(project)).unwrap().markers;
    let mut ids: Vec<u64> = markers.iter().map(|m| m.id.0).collect();
    ids.sort_unstable();
    assert_eq!(ids, [903, 5_000_000_001, 6_000_000_001]);
    let first = markers.iter().find(|m| m.id.0 == 903).unwrap();
    assert_eq!(first.comment, "Please check the cut again");
}

/// Markers on one clip and on a media item, added by two people at once, all survive.
#[test]
fn concurrent_clip_and_source_markers_all_survive() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    for (session, id, who) in [(&mut a, 5_000_000_001u64, "a"), (&mut b, 6_000_000_001u64, "b")] {
        let mut after = session.model().project.clone();
        let (sequence, media) = (sequence_id(&after), media_id(&after));
        after.sequence_mut(sequence).unwrap().video_tracks[0].items[0].markers.push(marker(id, 0, who));
        if let ItemKind::Media(clip) = &mut after.items.get_mut(&media).unwrap().kind {
            clip.markers.push(marker(id + 1, 0, who));
        }
        record(session, &person(who), &after);
    }
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let on_clip: Vec<u64> = project.sequence(sequence_id(project)).unwrap().video_tracks[0].items[0].markers.iter().map(|m| m.id.0).collect();
    assert_eq!(on_clip.len(), 2, "{on_clip:?}");
    let ItemKind::Media(clip) = &project.item(media_id(project)).unwrap().kind else { panic!("media") };
    assert_eq!(clip.markers.len(), 2, "{:?}", clip.markers);
}

/// Two people change two parameters of one effect at once (`Effect.params`, a map by parameter
/// id): both values are kept.
#[test]
fn concurrent_edits_of_two_params_of_one_effect_are_both_kept() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value = ParamValue::Float(50.0)
    });
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("rotation").unwrap().value = ParamValue::Float(15.0)
    });
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let motion = project.sequence(sequence_id(project)).unwrap().video_tracks[0].items[0].effect("motion").unwrap().clone();
    assert_eq!(motion.params["scale"].value, ParamValue::Float(50.0));
    assert_eq!(motion.params["rotation"].value, ParamValue::Float(15.0));
}

/// One person changes a parameter's value while another keys the same parameter (each a
/// register of its `Param` object in `Effect.params`): both edits are kept.
#[test]
fn concurrent_value_and_keyframes_of_one_param_are_both_kept() {
    use kition_film_project::Keyframe;
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().value = ParamValue::Float(50.0)
    });
    record(&mut a, &person("a"), &after);
    let keys = vec![Keyframe::new(Tick::ZERO, ParamValue::Float(100.0)), Keyframe::new(Tick(5_000), ParamValue::Float(200.0))];
    let after = edit(&b, |p, s| {
        p.sequence_mut(s).unwrap().video_tracks[0].items[0].effect_mut("motion").unwrap().params.get_mut("scale").unwrap().keyframes = keys.clone()
    });
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let motion = project.sequence(sequence_id(project)).unwrap().video_tracks[0].items[0].effect("motion").unwrap().clone();
    assert_eq!(motion.params["scale"].value, ParamValue::Float(50.0));
    assert_eq!(motion.params["scale"].keyframes, keys);
}

/// One person adds a master effect while another turns the existing one off
/// (`Sequence.masterEffects`): both edits are kept.
#[test]
fn concurrent_master_effect_edits_are_both_kept() {
    let mut project = captioned();
    let sequence = sequence_id(&project);
    let fx = |id: &str| EffectInstance {
        effect: id.into(),
        enabled: true,
        params: Default::default(),
        masks: Vec::new(),
        post_fader: false,
        audio_mixing: false,
        layer: None,
    };
    project.sequence_mut(sequence).unwrap().master_effects.push(fx("hard_limiter"));
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    let after = edit(&a, |p, s| p.sequence_mut(s).unwrap().master_effects.push(fx("studio_reverb")));
    record(&mut a, &person("a"), &after);
    let after = edit(&b, |p, s| p.sequence_mut(s).unwrap().master_effects[0].enabled = false);
    record(&mut b, &person("b"), &after);
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let master = &project.sequence(sequence_id(project)).unwrap().master_effects;
    assert_eq!(master.iter().map(|e| (e.effect.as_str(), e.enabled)).collect::<Vec<_>>(), [("hard_limiter", false), ("studio_reverb", true)]);
}

/// Two people transcribe two different media items at once (each item's own `Transcript`): both
/// transcripts are kept.
#[test]
fn concurrent_transcripts_of_two_items_are_both_kept() {
    let mut project = captioned();
    let media = media_id(&project);
    let kind = project.item(media).unwrap().kind.clone();
    project.add_item("Second.mp4", Label::Iris, kind, None);
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    for (session, name, who) in [(&mut a, "Ocean_Sunset.mp4", "a"), (&mut b, "Second.mp4", "b")] {
        let mut after = session.model().project.clone();
        let item = after.items.values().find(|item| item.name == name).unwrap().id;
        let mut transcript = kition_film_project::Transcript { language: "en".into(), source: "manual".into(), ..Default::default() };
        transcript.words.push(kition_film_project::Word::new(who, Tick(0), Tick(1_000)));
        after.transcripts.insert(item, std::sync::Arc::new(transcript));
        record(session, &person(who), &after);
    }
    converge(&mut a, &mut b);
    let project = &a.model().project;
    let mut words: Vec<String> = project.transcripts.values().map(|t| t.words[0].text.clone()).collect();
    words.sort();
    assert_eq!(words, ["a", "b"]);
}

/// Two people add a search bin each at once (`Project.searchBins`): both are kept.
#[test]
fn concurrent_search_bins_are_both_kept() {
    let mut a = first(&captioned());
    let mut b = peer(&a, 2);
    for (session, id, who) in [(&mut a, 5_000_000_001u64, "a"), (&mut b, 6_000_000_001u64, "b")] {
        let mut after = session.model().project.clone();
        after.search_bins.push(kition_film_project::find::SearchBin {
            id: kition_film_project::BinId(id),
            name: who.into(),
            query: kition_film_project::find::FindQuery { rows: Vec::new(), match_all: true, case_sensitive: false },
        });
        record(session, &person(who), &after);
    }
    converge(&mut a, &mut b);
    let mut names: Vec<&str> = a.model().project.search_bins.iter().map(|bin| bin.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["a", "b"]);
}

/// Two people import a LUT each at once (`Project.luts`, the text a blob): both are kept, and a
/// peer reads the other's LUT text from the blobs it was handed.
#[test]
fn concurrent_luts_are_both_kept_with_their_text() {
    let lut =
        |id: &str, text: &str| kition_film_project::ProjectLut { id: id.into(), name: id.into(), source_path: None, format: "cube".into(), text: text.into() };
    let mut a = kdm_model::FilmSession::create(&captioned()).unwrap();
    let mut b = kdm_model::FilmSession::open_snapshot(&a.snapshot().unwrap(), a.blobs()).unwrap();
    let mut after = a.project().clone();
    after.luts.push(lut("lut5000000001", "LUT_3D_SIZE 2\n# a"));
    a.record(&person("a"), &after).unwrap();
    let mut after = b.project().clone();
    after.luts.push(lut("lut6000000001", "LUT_3D_SIZE 2\n# b"));
    b.record(&person("b"), &after).unwrap();
    // A host hands each side the other's blobs before its changes.
    b.add_blobs(&a.blobs());
    a.add_blobs(&b.blobs());
    for _ in 0..4 {
        a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
        b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
    }
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    for session in [&a, &b] {
        let mut texts: Vec<&str> = session.project().luts.iter().map(|lut| &*lut.text).collect();
        texts.sort_unstable();
        assert_eq!(texts, ["LUT_3D_SIZE 2\n# a", "LUT_3D_SIZE 2\n# b"]);
    }
    // Without the text, a peer refuses to read the replica rather than lose the LUT.
    assert!(kdm_model::FilmSession::open_snapshot(&a.snapshot().unwrap(), Default::default()).is_err());
    // The blobs travel as bytes.
    let decoded = kdm_model::decode_blobs(&kdm_model::encode_blobs(&a.blobs())).unwrap();
    assert_eq!(decoded.0.len(), 2);
    assert!(kdm_model::decode_blobs(&[1, 2, 3]).is_err());
}

/// Two people upgrade a graphic each to a source graphic at once (`Item.sourceGraphic`): both
/// are kept, each with its layers.
#[test]
fn concurrent_source_graphics_of_two_items_are_both_kept() {
    let (mut project, _, _) = demo_project();
    let rate = kition_film_time::FrameRate::FPS_24;
    for name in ["Title A", "Title B"] {
        project.add_item(name, Label::Iris, ItemKind::Graphic { width: 64, height: 36, rate }, None);
    }
    let mut a = first(&project);
    let mut b = peer(&a, 2);
    for (session, name, who) in [(&mut a, "Title A", "a"), (&mut b, "Title B", "b")] {
        let mut after = session.model().project.clone();
        let item = after.items.values().find(|item| item.name == name).unwrap().id;
        let layer = EffectInstance {
            effect: "opacity".into(),
            enabled: true,
            params: Default::default(),
            masks: Vec::new(),
            post_fader: false,
            audio_mixing: false,
            layer: None,
        };
        after.source_graphics.insert(item, kition_film_project::SourceGraphic { layers: vec![layer], meta: None });
        record(session, &person(who), &after);
    }
    converge(&mut a, &mut b);
    let project = &a.model().project;
    assert_eq!(project.source_graphics.len(), 2);
    assert!(project.source_graphics.values().all(|graphic| graphic.layers.len() == 1));
}
