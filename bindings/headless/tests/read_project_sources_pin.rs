//! Implicit project creation keeps the inputs that choose its defaults.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn subclip_defaults_refuse_changed_timeline_names_and_allow_other_clip_names() {
    for related in [false, true] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
        let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":5*SECOND})).unwrap()["clips"][0].clone();
        let other = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        f.colleague(&[("clip.rename", json!({"clip":if related {&first}else{&other},"name":"Changed default"}))]);
        let result = f.call("run", json!({"basis":basis,"steps":[{"on":[first],"command":"clip.makeSubclip","params":{}}]})).await;
        if related {
            assert_eq!(result.expect_err("changed copied name must refuse")["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unnamed_bins_refuse_changed_name_candidates_and_allow_unread_media_names() {
    for related in [false, true] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let item = doc.execute("item.newColorMatte", json!({"seconds":3})).unwrap()["item"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if related {
            f.colleague(&[("bin.add", json!({"name":"Bin 01"}))]);
        } else {
            f.colleague(&[("clip.rename", json!({"item":item,"name":"Unread name"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"bin.addFromSelection","params":{"items":[item]}}]})).await;
        if related {
            assert_eq!(result.expect_err("changed free-name candidates must refuse")["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sequences_from_clips_hold_source_defaults_and_allow_existing_timeline_appearance() {
    for related in [true, false] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
        let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if related {
            f.colleague(&[("clip.rename", json!({"item":item,"name":"Copied name"}))]);
        } else {
            f.colleague(&[("effect.setParam", json!({"clip":clip,"effect":"opacity","param":"opacity","value":45}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.newFromClip","params":{"items":[item]}}]})).await;
        if related {
            assert_eq!(result.expect_err("changed copied source must refuse")["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}
