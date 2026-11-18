//! C8-film-pin: camera addresses retain the effective source map and lookup winner.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ItemId, MulticamSource};
use kition_kit::KitDocument;
use serde_json::json;

fn cameras() -> (Fixture, u64, u64, u64) {
    let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newSequence", json!({"name":"Cameras","video":2,"audio":1})).unwrap()["sequence"].as_u64().unwrap();
    for track in ["V1", "V2"] {
        let item = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":item,"track":track,"time":0})).unwrap();
    }
    doc.execute("sequence.open", json!({"item":sequence})).unwrap();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V2","time":0,"duration":2*SECOND})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("clip.multicamEnable", json!({"clips":[clip],"enabled":true})).unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), sequence, source, clip)
}

#[tokio::test(flavor = "multi_thread")]
async fn camera_switch_preserves_effective_map_across_explicit_source_conversion() {
    for related in [false, true] {
        let (f, sequence, source, clip) = cameras();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |project| {
            let source = project.sequence_mut(ItemId(source)).unwrap();
            let mut map: MulticamSource = source.cameras();
            if related {
                map.cameras.reverse();
            } else {
                map.cameras[0].name = "Display name only".into();
            }
            source.multicam = Some(map);
        });
        let before = std::fs::read(f.file()).unwrap();
        let result = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"multicam.switchAngle","params":{"clips":[clip],"camera":2},"at":{"part":{"sequence":sequence}}}]}),
            )
            .await;
        if related {
            assert!(result.is_err(), "changed effective camera map accepted: {result:?}");
            assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            result.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn implicit_camera_switch_preserves_the_observed_lookup_winner() {
    for reordered in [false, true] {
        let (f, sequence, source, first) = cameras();
        let second = f.colleague(&[("timeline.place", json!({"item":source,"track":"V3","time":0,"duration":2*SECOND}))])[0]["clips"][0].clone();
        f.colleague(&[("clip.multicamEnable", json!({"clips":[second],"enabled":true}))]);
        let (_, basis) = f.inspect().await;
        if reordered {
            rewrite(&f.file(), |project| project.sequence_mut(ItemId(sequence)).unwrap().video_tracks.swap(1, 2));
        }
        let before = std::fs::read(f.file()).unwrap();
        let result = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"multicam.switchAngle","params":{"camera":2},"at":{"part":{"sequence":sequence},"time":0.5}}]}),
            )
            .await;
        if reordered {
            assert!(result.is_err(), "changed camera lookup winner accepted: {result:?}");
            assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            result.unwrap();
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            assert_eq!(saved.project.sequence(ItemId(sequence)).unwrap().find_item(kition_film_project::ClipId(first)).unwrap().1.multicam.unwrap().angle, 1);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn camera_page_navigation_retains_the_shown_camera_count() {
    for command in ["multicam.page", "multicam.nextPage", "multicam.prevPage"] {
        let (f, sequence, source, _) = cameras();
        f.colleague(&[
            ("sequence.open", json!({"item":source})),
            ("sequence.addTracks", json!({"video":7,"audio":0})),
            ("sequence.open", json!({"item":sequence})),
        ]);
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "multicam.gridLayout", json!({"layout":"2x2"}).as_object().unwrap().clone())
            .await
            .unwrap();
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |project| {
            let q = project.sequence_mut(ItemId(source)).unwrap();
            let mut map = q.cameras();
            for camera in map.cameras.iter_mut().skip(4) {
                camera.enabled = false;
            }
            q.multicam = Some(map);
        });
        let params = if command == "multicam.page" { json!({"page":1}) } else { json!({}) };
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"part":{"sequence":sequence},"time":0.5}}]})).await;
        assert!(result.is_err(), "changed camera page count accepted: {command}: {result:?}");
        let error = result.unwrap_err();
        assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn live_camera_switch_retains_its_source_map() {
    for command in ["multicam.cut", "multicam.selectCamera2", "multicam.cutToCamera", "multicam.cutToCamera2"] {
        for related in [false, true] {
            let (f, _, source, _) = cameras();
            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "multicam.recordStart", Default::default()).await.unwrap();
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |project| {
                let q = project.sequence_mut(ItemId(source)).unwrap();
                if related {
                    q.video_tracks.reverse();
                } else {
                    q.video_tracks[0].name = "Display name".into();
                }
            });
            let before = std::fs::read(f.file()).unwrap();
            let params = if matches!(command, "multicam.cut" | "multicam.cutToCamera") { json!({"camera":2}) } else { json!({}) };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"time":0.5}}]})).await;
            if related {
                assert!(result.is_err(), "changed live camera map accepted: {command}: {result:?}");
                assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
                assert_eq!(std::fs::read(f.file()).unwrap(), before);
            } else {
                result.unwrap();
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn live_camera_switch_retains_later_pass_recipients() {
    let (f, sequence, source, _) = cameras();
    let later = f.colleague(&[("timeline.place", json!({"item":source,"track":"V2","time":2*SECOND,"duration":2*SECOND,"audio":false}))])[0]["clips"][0]
        .as_u64()
        .unwrap();
    f.colleague(&[("clip.multicamEnable", json!({"clips":[later],"enabled":true}))]);
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "multicam.recordStart", Default::default()).await.unwrap();
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        project.sequence_mut(ItemId(sequence)).unwrap().find_item_mut(kition_film_project::ClipId(later)).unwrap().1.multicam.as_mut().unwrap().angle = 1;
    });
    let before = std::fs::read(f.file()).unwrap();
    let result = f.call("run", json!({"basis":basis,"steps":[{"command":"multicam.cut","params":{"camera":2},"at":{"time":0.5}}]})).await;
    assert!(result.is_err(), "changed later camera assignment accepted: {result:?}");
    assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn camera_stop_retains_the_observed_recording_pass() {
    let (f, _, _, _) = cameras();
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    for (command, params) in [("multicam.recordStart", json!({})), ("multicam.cut", json!({"camera":2,"time":SECOND/2}))] {
        f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
    }
    f.kits.save(kition_kits::Caller::User, view.kit_id, &view.document_id).await.unwrap();
    let (_, basis) = f.inspect().await;
    f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "multicam.recordStart", Default::default()).await.unwrap();
    let before = std::fs::read(f.file()).unwrap();
    let result = f.call("run", json!({"basis":basis,"steps":[{"command":"multicam.recordStop","params":{"time":SECOND}}]})).await;
    assert!(result.is_err(), "replaced recording pass accepted: {result:?}");
    assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}
