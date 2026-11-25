//! C8-film-pin: fixed keyboard commands retain the fields they assign.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn targeted_track_toggles_retain_assigned_flags_but_not_names() {
    for (command, track, flag) in [
        ("timeline.toggleMuteTargetedAudio", "A2", "muted"),
        ("timeline.toggleSoloTargetedAudio", "A2", "solo"),
        ("timeline.toggleOutputTargetedVideo", "V2", "enabled"),
    ] {
        for related in [false, true] {
            let f = Fixture::new(1);
            let (_, basis) = f.inspect().await;
            let mut params = json!({"track":track});
            if related {
                params[flag] = json!(flag != "enabled");
            } else {
                params["name"] = json!("Colleague's name");
            }
            f.colleague(&[("timeline.setTrack", params)]);
            let before = std::fs::read(f.file()).unwrap();
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":{}}]})).await;
            if related {
                assert!(result.is_err(), "changed assigned track flag accepted: {command}: {result:?}");
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
async fn volume_shortcuts_retain_linked_audio_levels_but_not_names() {
    for command in [
        "clip.volumeUp",
        "clip.volumeDown",
        "clip.volumeUpMany",
        "clip.volumeDownMany",
        "clip.nudgeVolumeUp1",
        "clip.nudgeVolumeUp3",
        "clip.nudgeVolumeDown1",
        "clip.nudgeVolumeDown3",
    ] {
        for related in [false, true] {
            let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
            let item = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
            let placed = doc.execute("timeline.place", json!({"item":item,"time":SECOND,"track":"V1"})).unwrap();
            let video = placed["clips"][0].clone();
            let audio = placed["clips"][1].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            f.colleague(&[if related {
                ("effect.setParam", json!({"clip":audio,"effect":"volume","param":"level","value":-12}))
            } else {
                ("clip.rename", json!({"clip":audio,"name":"Colleague's name"}))
            }]);
            let before = std::fs::read(f.file()).unwrap();
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"on":[video],"params":{}}]})).await;
            if related {
                assert!(result.is_err(), "changed linked audio level accepted: {command}: {result:?}");
                assert_eq!(result.unwrap_err()["error"]["code"], "conflict");
                assert_eq!(std::fs::read(f.file()).unwrap(), before);
            } else {
                result.unwrap();
            }
            f.shutdown().await;
        }
    }
}
