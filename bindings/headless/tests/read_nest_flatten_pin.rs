//! Copy edits retain destination eligibility and camera ordinal inputs.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;
#[tokio::test(flavor = "multi_thread")]
async fn nest_and_flatten_refuse_changed_destination_locks_and_allow_uncopied_names() {
    for command in ["clip.nest", "clip.multicamFlatten"] {
        for related in [true, false] {
            let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
            let seq = doc.inspect().unwrap()["sequence"]["id"].clone();
            let source = doc.execute("file.newSequence", json!({"name":"Camera","video":2,"audio":1})).unwrap()["sequence"].clone();
            let item = doc.execute("file.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
            doc.execute("sequence.open", json!({"item":seq})).unwrap();
            let clips = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"].clone();
            doc.execute("clip.multicamEnable", json!({"clips":clips,"enabled":true})).unwrap();
            let distant = doc.execute("timeline.place", json!({"item":item,"track":"V2","time":6*SECOND})).unwrap()["clips"][0].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            if related {
                f.colleague(&[("timeline.setTrack", json!({"track":"V1","locked":true}))]);
            } else {
                f.colleague(&[("clip.rename", json!({"clip":distant,"name":"Uncopied"}))]);
            }
            let step = if command == "clip.nest" {
                json!({"command":command,"on":[clips[0]],"params":{"name":"Given"}})
            } else {
                json!({"command":command,"params":{"clips":[clips[0]]}})
            };
            let result = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            if related {
                assert_eq!(result.expect_err("changed destination eligibility must refuse")["error"]["code"], "conflict");
            } else {
                assert!(result.is_ok(), "{command}: {result:?}");
            }
            f.shutdown().await;
        }
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn flatten_retains_the_default_camera_track_order() {
    let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].clone();
    let source = doc.execute("file.newSequence", json!({"name":"Camera","video":2,"audio":1})).unwrap()["sequence"].as_u64().unwrap();
    let item = doc.execute("file.newColorMatte", json!({"seconds":3})).unwrap()["item"].clone();
    for track in ["V1", "V2"] {
        doc.execute("timeline.place", json!({"item":item,"track":track,"time":0})).unwrap();
    }
    doc.execute("sequence.open", json!({"item":seq})).unwrap();
    let clips = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"].clone();
    doc.execute("clip.multicamEnable", json!({"clips":clips,"enabled":true})).unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| project.sequence_mut(ItemId(source)).unwrap().video_tracks.swap(0, 1));
    let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.multicamFlatten","params":{"clips":[clips[0]]}}]})).await;
    assert_eq!(result.expect_err("the copied default angle changed")["error"]["code"], "conflict");
    f.shutdown().await;
}
