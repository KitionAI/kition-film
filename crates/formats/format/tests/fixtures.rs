//! A hand-made project file opens: the edit in `tests/fixtures/edit.kfilm` (format version 1).

use kition_film_format::{SCHEMA_VERSION, decode, encode};
use kition_film_project::{ClipId, ItemId, ItemKind, Project};
use kition_film_time::Tick;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}

#[test]
fn the_fixture_loads() {
    let l = decode(&fixture("edit.kfilm")).unwrap();
    assert_eq!(l.schema_version, SCHEMA_VERSION);
    let p = &l.project;
    assert_eq!(p.name, "Legacy Edit");
    assert_eq!(p.next_id, 48);
    let media = p.item(ItemId(5)).unwrap();
    assert_eq!(media.name, "Ocean_Sunset.mp4");
    assert!(media.metadata.is_empty());
    let seq = p.sequence(ItemId(21)).unwrap();
    assert_eq!(seq.video_tracks.len(), 1);
    assert_eq!(seq.audio_tracks.len(), 1);
    assert_eq!(seq.markers.len(), 1);
    let clip = &seq.video_tracks[0].items[0];
    assert_eq!(clip.id, ClipId(29));
    assert_eq!(clip.source_in, Tick(243_675_432_000));
    assert!(!clip.reverse && clip.link.is_none() && clip.gain_db == 0.0 && !clip.scale_to_frame);
    assert_eq!(clip.effects.len(), 3);
    assert!(seq.audio_tracks[0].effects.is_empty());
    seq.check().unwrap();
    // resaved, losslessly
    let again = decode(&encode(p, true)).unwrap();
    assert_eq!(&again.project, p);
}

#[test]
fn legacy_audio_field_becomes_primary_stream_and_clip_defaults_to_zero() {
    let p = decode(&fixture("edit.kfilm")).unwrap().project;
    let media = p.item(ItemId(5)).unwrap().as_media().unwrap();
    assert_eq!(media.info.audio_streams.len(), 1);
    assert!(media.info.has_audio());
    let clip = &p.sequence(ItemId(21)).unwrap().audio_tracks[0].items[0];
    assert_eq!(clip.audio_stream, 0);
    let again = decode(&encode(&p, false)).unwrap();
    assert_eq!(again.project.item(ItemId(5)).unwrap().as_media().unwrap().info.audio_streams, media.info.audio_streams);
}

/// Out-of-range audio stream data is repaired on load, never a reason to refuse the project.
#[test]
fn hostile_audio_stream_counts_and_indices_are_repaired_not_rejected() {
    let mut p = decode(&fixture("edit.kfilm")).unwrap().project;
    let seq = ItemId(21);
    for bad in [kition_film_media::MAX_AUDIO_STREAMS, usize::MAX] {
        p.sequence_mut(seq).unwrap().audio_tracks[0].items[0].audio_stream = bad;
        let loaded = decode(&encode(&p, false)).unwrap().project;
        assert_eq!(loaded.sequence(seq).unwrap().audio_tracks[0].items[0].audio_stream, 0);
    }
    p.sequence_mut(seq).unwrap().audio_tracks[0].items[0].audio_stream = kition_film_media::MAX_AUDIO_STREAMS - 1;
    let loaded = decode(&encode(&p, false)).unwrap().project;
    assert_eq!(loaded.sequence(seq).unwrap().audio_tracks[0].items[0].audio_stream, kition_film_media::MAX_AUDIO_STREAMS - 1, "in range: kept");
    let media = p.item_mut(ItemId(5)).unwrap().as_media_mut().unwrap();
    let stream = media.info.audio_streams[0].clone();
    media.info.audio_streams.resize(kition_film_media::MAX_AUDIO_STREAMS + 1, stream);
    let loaded = decode(&encode(&p, false)).unwrap().project;
    assert_eq!(loaded.item(ItemId(5)).unwrap().as_media().unwrap().info.audio_streams.len(), kition_film_media::MAX_AUDIO_STREAMS);
}

/// Build a project with `n` clips (half video, half linked audio) on 4+4 tracks.
pub fn big_project(n: usize) -> Project {
    let mut p = decode(&fixture("edit.kfilm")).unwrap().project;
    let seq_id = ItemId(21);
    let mut next = 1_000_000u64;
    let seq = match &mut p.items.get_mut(&seq_id).unwrap().kind {
        ItemKind::Sequence(s) => s,
        _ => unreachable!(),
    };
    let v0 = seq.video_tracks[0].items[0].clone();
    let a0 = seq.audio_tracks[0].items[0].clone();
    for t in seq.video_tracks.iter_mut().chain(seq.audio_tracks.iter_mut()) {
        t.items.clear();
    }
    let mut vt = seq.video_tracks[0].clone();
    let mut at = seq.audio_tracks[0].clone();
    for k in 1..4 {
        vt.id = kition_film_project::TrackId(500 + k);
        vt.name = format!("Video {}", k + 1);
        seq.video_tracks.push(vt.clone());
        at.id = kition_film_project::TrackId(600 + k);
        at.name = format!("Audio {}", k + 1);
        seq.audio_tracks.push(at.clone());
    }
    let dur = Tick(254_016_000_000); // 1 s each
    for i in 0..n / 2 {
        let track = i % 4;
        let slot = (i / 4) as i64;
        let mut v = v0.clone();
        v.id = ClipId(next);
        v.start = Tick(dur.0 * slot);
        v.duration = dur;
        v.link = Some(next);
        let mut a = a0.clone();
        a.id = ClipId(next + 1);
        a.start = v.start;
        a.duration = dur;
        a.link = Some(next);
        next += 2;
        seq.video_tracks[track].items.push(v);
        seq.audio_tracks[track].items.push(a);
    }
    p.next_id = next;
    p
}

#[test]
fn large_project_roundtrip_and_timing() {
    let p = big_project(2000);
    let clips: usize = p.sequence(ItemId(21)).unwrap().all_tracks().map(|t| t.items.len()).sum();
    assert_eq!(clips, 2000);
    let reps = 5;
    let t0 = std::time::Instant::now();
    let mut pretty = Vec::new();
    for _ in 0..reps {
        pretty = encode(&p, true);
    }
    let pretty_ms = t0.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    let t0 = std::time::Instant::now();
    let mut compact = Vec::new();
    for _ in 0..reps {
        compact = encode(&p, false);
    }
    let compact_ms = t0.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    let t0 = std::time::Instant::now();
    let back = decode(&compact).unwrap();
    let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(back.project, p);
    let t0 = std::time::Instant::now();
    let dir = std::env::temp_dir().join(format!("kition-film-big-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    kition_film_format::atomic_write(&dir.join("big.kfilm"), &compact).unwrap();
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    std::fs::remove_dir_all(&dir).unwrap();
    println!(
        "2000-clip project: pretty {:.1} KB in {pretty_ms:.2} ms, compact {:.1} KB in {compact_ms:.2} ms, decode {decode_ms:.2} ms, atomic write+fsync {write_ms:.2} ms",
        pretty.len() as f64 / 1024.0,
        compact.len() as f64 / 1024.0
    );
}

/// A transcript is kept in the file.
#[test]
fn transcripts_round_trip() {
    let mut p = decode(&fixture("edit.kfilm")).unwrap().project;
    let mut t = kition_film_project::Transcript { language: "en".into(), source: "manual".into(), ..Default::default() };
    t.words.push(kition_film_project::Word::new("Hello", Tick(0), Tick(1000)));
    t.words[0].speaker = Some(0);
    t.normalize();
    p.transcripts.insert(ItemId(5), std::sync::Arc::new(t));
    let again = decode(&encode(&p, true)).unwrap();
    assert_eq!(again.project, p);
    assert_eq!(again.project.transcripts[&ItemId(5)].speakers[0].name, "Speaker 1");
}
