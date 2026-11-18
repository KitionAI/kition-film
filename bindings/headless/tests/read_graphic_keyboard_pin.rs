//! C8-film-pin: mixed-selection nudges edit Motion on every selected video.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn mixed_selection_nudges_hold_each_motion_position_and_allow_unrelated_opacity() {
    for command in ["graphics.nudgeRight", "graphics.nudgeDown5"] {
        for changed_position in [false, true] {
            let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
            let clip = v1(&doc.inspect().unwrap()["sequence"])[0];
            let graphic = doc.execute("graphics.newText", json!({"newClip":true,"text":"Graphic","track":1,"time":0})).unwrap()["clip"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            f.colleague(&[(
                "effects.setParam",
                if changed_position {
                    json!({"clip":clip,"effect":"motion","param":"position","value":[30,40]})
                } else {
                    json!({"clip":clip,"effect":"opacity","param":"opacity","value":25})
                },
            )]);
            let before = std::fs::read(f.file()).unwrap();
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"on":[graphic,clip]}]})).await;
            if changed_position {
                let error = result.expect_err("the nudge reads and assigns each selected Motion position");
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
                assert_eq!(std::fs::read(f.file()).unwrap(), before);
            } else {
                result.unwrap_or_else(|error| panic!("{command}: Opacity is independent: {error}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn text_layer_creation_holds_graphics_defaults() {
    for command in ["graphics.newText", "graphics.newVerticalText"] {
        let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
        let graphic = doc.execute("graphics.newText", json!({"newClip":true,"text":"Graphic","track":1,"time":0})).unwrap()["clip"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
        f.kits
            .execute(
                kition_kits::Caller::User,
                view.kit_id,
                &view.document_id,
                "prefs.set",
                json!({"key":"graphics.defaultFont","value":"Assigned font"}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let before = std::fs::read(f.file()).unwrap();
        let error = f.refused("run", json!({"basis":basis,"steps":[{"command":command,"params":{"clip":graphic,"text":"Assigned text"}}]})).await;
        assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn motion_nudge_holds_the_lane_kind_of_skipped_audio_clips() {
    let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
    let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap();
    let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let q = loaded.project.sequence(kition_film_project::ItemId(sequence)).unwrap();
    let video = q.video_tracks[0].items[0].id;
    let audio = q.audio_tracks[0].items[0].id;
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        let q = project.sequence_mut(kition_film_project::ItemId(sequence)).unwrap();
        let clip = q.audio_tracks[0].items.remove(0);
        q.video_tracks[1].items.push(clip);
    });
    let before = std::fs::read(f.file()).unwrap();
    let error = f.refused("run", json!({"basis":basis,"steps":[{"command":"graphics.nudgeRight","on":[video.0,audio.0]}]})).await;
    assert_eq!(error["error"]["code"], "conflict", "{error}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn motion_nudge_retains_video_recipients_that_moved_to_audio() {
    let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
    let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let first = doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"][0].clone();
    let second = doc.execute("timeline.place", json!({"item":source,"track":"V2","audioTrack":"A2","time":0})).unwrap()["clips"][0].clone();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        let q = project.sequence_mut(kition_film_project::ItemId(sequence)).unwrap();
        let mut clip = q.video_tracks[0].items.remove(0);
        clip.start.0 = 3 * SECOND;
        q.audio_tracks[0].items.push(clip);
    });
    let before = std::fs::read(f.file()).unwrap();
    let error = f.refused("run", json!({"basis":basis,"steps":[{"command":"graphics.nudgeRight","on":[first,second]}]})).await;
    assert_eq!(error["error"]["code"], "conflict", "{error}");
    assert_eq!(std::fs::read(f.file()).unwrap(), before);
    f.shutdown().await;
}
