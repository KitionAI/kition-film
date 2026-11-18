//! C8-film-read: ripple recipients assign start, even beyond a point address.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn ripple_insert_holds_assigned_suffix_starts_but_not_suffix_names() {
    for related in [false, true] {
        let f = Fixture::new(4);
        let (q, basis) = f.inspect().await;
        let sequence = ItemId(q["id"].as_u64().unwrap());
        let suffix = ClipId(v1(&q)[3]);
        let source = q["video"][0]["items"][0]["item"].clone();
        let initial = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
        let old_start = initial.project.sequence(sequence).unwrap().find_item(suffix).unwrap().1.start;
        rewrite(&f.file(), |p| {
            let clip = p.sequence_mut(sequence).unwrap().find_item_mut(suffix).unwrap().1;
            if related {
                clip.start.0 += SECOND;
            } else {
                clip.name = "Colleague".into();
            }
        });
        let params = json!({"item":source,"track":"V1","time":SECOND/2,"duration":SECOND/4,"insert":true,"audio":false});
        let doc = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
        let under = doc.under("timeline.place", &params).unwrap().unwrap();
        let held = under.premises.iter().find(|held| held.id == suffix.0).expect("the assigned suffix is held");
        assert!(held.fields.as_ref().is_some_and(|fields| fields.iter().any(|field| field == "start")), "{under:?}");
        assert_eq!(held.positions.as_deref(), Some([].as_slice()), "the assignment is a content premise: {under:?}");
        let result = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"timeline.place","params":{
                    "item":source,"track":"V1","time":SECOND/2,"duration":SECOND/4,"insert":true,"audio":false
                }}]}),
            )
            .await;
        if related {
            let error = result.expect_err("insertion assigns the suffix start changed since observation");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert!(
                error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == suffix.0 && conflict["reason"] == "changed"),
                "same-field protection: {error}"
            );
        } else {
            let answer = result.unwrap_or_else(|error| panic!("a suffix name is preserved: {error}"));
            let inserted = answer["completed"][0]["result"]["clips"][0].as_u64().unwrap();
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            let q = saved.project.sequence(sequence).unwrap();
            let clip = q.find_item(suffix).unwrap().1;
            assert_eq!(clip.start, old_start + q.find_item(ClipId(inserted)).unwrap().1.duration);
            assert_eq!(clip.name, "Colleague");
        }
        f.shutdown().await;
    }
}

#[test]
fn ripple_insert_declares_actual_suffix_start_assignments() {
    let doc = FilmDocument::open(FILE, &project(4)).unwrap();
    let q = doc.inspect().unwrap()["sequence"].clone();
    let source = q["video"][0]["items"][0]["item"].clone();
    let params = json!({"item":source,"track":"V1","time":SECOND/2,"duration":SECOND/4,"insert":true,"audio":false});
    let under = doc.under("timeline.place", &params).unwrap().unwrap();
    for id in &v1(&q)[1..] {
        let held = under.premises.iter().find(|held| held.id == *id).expect("assigned suffix");
        assert_eq!(held.fields.as_deref(), Some(["start".to_owned()].as_slice()), "{under:?}");
        assert_eq!(held.positions.as_deref(), Some([].as_slice()), "{under:?}");
    }
}
