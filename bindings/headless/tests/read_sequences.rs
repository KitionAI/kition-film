//! C8-film-read independent writer cases from the blind caption paths.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

fn captions() -> (Fixture, u64, u64, u64) {
    let mut doc = FilmDocument::open(FILE, &project(8)).unwrap();
    let track = doc.execute("captions.newTrack", json!({"name":"Words"})).unwrap()["track"].as_u64().unwrap();
    let a = doc.execute("captions.add", json!({"track":track,"seconds":1,"durationSeconds":1,"text":"one"})).unwrap()["caption"].as_u64().unwrap();
    let b = doc.execute("captions.add", json!({"track":track,"seconds":4,"durationSeconds":1,"text":"two"})).unwrap()["caption"].as_u64().unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), track, a, b)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_caption_track_lock_is_an_eligibility_conflict() {
    for unrelated in [false, true] {
        let (f, track, a, _) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[("captions.setTrack", if unrelated { json!({"track":track,"language":"fr"}) } else { json!({"track":track,"locked":true}) })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"captions.setText","params":{"caption":a,"text":"mine"}}]})).await;
        if unrelated {
            answer.unwrap();
        } else {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_track_patch_holds_assigned_fields_and_leaves_caption_text_unheld() {
    for same_field in [false, true] {
        let (f, track, a, _) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if same_field {
            ("captions.setTrack", json!({"track":track,"language":"fr"}))
        } else {
            ("captions.setText", json!({"caption":a,"text":"colleague"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"captions.setTrack","params":{"track":track,"language":"de"}}]})).await;
        if same_field {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_style_patch_holds_its_field_and_allows_track_name_changes() {
    for same_field in [false, true] {
        let (f, track, _, _) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if same_field {
            ("captions.setStyle", json!({"track":track,"size":31}))
        } else {
            ("captions.setTrack", json!({"track":track,"name":"Theirs"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"captions.setStyle","params":{"track":track,"size":40}}]})).await;
        if same_field {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_trim_reads_neighbour_time_and_does_not_read_neighbour_text() {
    for timing in [false, true] {
        let (f, _, a, b) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if timing {
            ("captions.setTimes", json!({"caption":b,"startSeconds":3.5,"endSeconds":5}))
        } else {
            ("captions.setText", json!({"caption":b,"text":"colleague"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"captions.trim","params":{"caption":a,"edge":"out","deltaFrames":120}}]})).await;
        if timing {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caption_add_holds_the_next_start_that_clamps_its_duration() {
    for timing in [false, true] {
        let (f, track, _, b) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if timing {
            ("captions.setTimes", json!({"caption":b,"startSeconds":3.5,"endSeconds":5}))
        } else {
            ("captions.setText", json!({"caption":b,"text":"colleague"}))
        }]);
        let answer = f
            .call("run", json!({"basis":basis,"steps":[{"command":"captions.add","params":{"track":track,"seconds":3,"durationSeconds":3,"text":"mine"}}]}))
            .await;
        if timing {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn showing_all_captions_holds_the_enabled_fields_it_assigns() {
    for enabled in [false, true] {
        let (f, track, a, _) = captions();
        let (_, basis) = f.inspect().await;
        f.colleague(&[if enabled {
            ("captions.setTrack", json!({"track":track,"enabled":false}))
        } else {
            ("captions.setText", json!({"caption":a,"text":"colleague"}))
        }]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"captions.showAll","params":{}}]})).await;
        if enabled {
            assert_eq!(answer.unwrap_err()["error"]["code"], "conflict");
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_move_by_ticks_does_not_inherit_the_frame_rate() {
    let (f, _, a, _) = captions();
    let (_, basis) = f.inspect().await;
    f.colleague(&[("sequence.settings", json!({"fps":30}))]);
    f.ok("run", json!({"basis":basis,"steps":[{"command":"captions.move","params":{"caption":a,"delta":SECOND/8}}]})).await;
    f.shutdown().await;
}
