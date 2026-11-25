//! C8-film-pin: a gap does not make the previous trim boundary irrelevant.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn regular_head_trim_holds_the_previous_clip_across_an_empty_gap() {
    for change in ["boundary", "name"] {
        let mut doc = FilmDocument::open(FILE, &project(0)).unwrap();
        let item = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
        let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
        let second = doc.execute("timeline.razor", json!({"clip":first,"time":SECOND})).unwrap()["clips"][0].clone();
        assert!(second.is_number(), "razor result must name its new clip");
        doc.execute("timeline.move", json!({"moves":[{"clip":second,"track":"V1","time":2*SECOND}]})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if change == "boundary" {
            f.colleague(&[("timeline.trim", json!({"clip":first,"edge":"out","delta":SECOND/2}))]);
        } else {
            f.colleague(&[("clip.rename", json!({"clip":first,"name":"Unrelated previous name"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"timeline.trim","params":{"clip":second,"edge":"in","delta":-SECOND}}]})).await;
        if change == "boundary" {
            let error = result.expect_err("the colleague changed the boundary used to clamp this trim");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            assert!(result.is_ok(), "an unused neighbour name must survive: {result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rolling_a_cut_retains_the_transition_start_it_assigns() {
    let mut doc = FilmDocument::open(FILE, &project(0)).unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
    let left = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    let right = doc.execute("timeline.razor", json!({"clip":left,"time":SECOND})).unwrap()["clips"][0].clone();
    doc.execute("sequence.applyVideoTransition", json!({"clip":right,"edge":"in","frames":8})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        project.sequence_mut(kition_film_project::ItemId(sequence)).unwrap().video_tracks[0].transitions[0].start.0 += SECOND / 8;
    });
    let error = f
        .call("run", json!({"basis":basis,"steps":[{"command":"timeline.roll","params":{"left":left,"right":right,"delta":SECOND/4}}]}))
        .await
        .expect_err("rolling assigns the transition start changed by the colleague");
    assert_eq!(error["error"]["code"], "conflict", "{error}");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trim_retains_the_kind_that_made_its_source_unbounded() {
    let mut doc = FilmDocument::open(FILE, &project(0)).unwrap();
    let item = doc.execute("item.newAdjustmentLayer", json!({"seconds":4})).unwrap()["item"].as_u64().unwrap();
    let replacement = doc.execute("item.newOfflineFile", json!({"name":"Finite","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0,"duration":4*SECOND})).unwrap()["clips"][0].clone();
    let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |project| {
        let kind = project.item(kition_film_project::ItemId(replacement)).unwrap().kind.clone();
        project.item_mut(kition_film_project::ItemId(item)).unwrap().kind = kind;
    });
    let error = f
        .call("run", json!({"basis":basis,"steps":[{"command":"timeline.trim","params":{"clip":clip,"edge":"out","delta":SECOND}}]}))
        .await
        .expect_err("a changed source kind changes this trim's media bound");
    assert_eq!(error["error"]["code"], "conflict", "{error}");
    f.shutdown().await;
}
