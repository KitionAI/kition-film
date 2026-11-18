//! C8-film-read: a through join reads its adjacent piece and owner lock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

fn through() -> (Fixture, u64, u64, u64, u64) {
    let mut doc = FilmDocument::open(FILE, &project(6)).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"].clone();
    let left = v1(&sequence)[1];
    let right = doc.execute("timeline.razor", json!({"clip":left,"time":3*SECOND/2})).unwrap()["clips"][0].as_u64().unwrap();
    let track = sequence["video"][0]["id"].as_u64().unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), left, right, track, v1(&sequence)[5])
}

#[tokio::test(flavor = "multi_thread")]
async fn a_through_join_holds_neighbour_shape_deleted_content_and_owner_lock_and_allows_a_distant_rename() {
    for change in ["duration", "source-in", "deleted-name", "lock", "unrelated-name"] {
        let (f, left, right, track, distant) = through();
        let (sequence, basis) = f.inspect().await;
        match change {
            "duration" | "source-in" => rewrite(&f.file(), |p| {
                let q = p.sequence_mut(ItemId(sequence["id"].as_u64().unwrap())).unwrap();
                let clip = &mut q.find_item_mut(ClipId(right)).unwrap().1;
                if change == "duration" {
                    clip.duration.0 -= SECOND / 8;
                } else {
                    clip.source_in.0 += SECOND / 8;
                }
            }),
            "deleted-name" => {
                f.colleague(&[("clip.rename", json!({"clip":right,"name":"theirs"}))]);
            }
            "lock" => {
                f.colleague(&[("timeline.setTrack", json!({"track":track,"locked":true}))]);
            }
            "unrelated-name" => {
                f.colleague(&[("clip.rename", json!({"clip":distant,"name":"theirs"}))]);
            }
            _ => panic!("test change"),
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.joinThroughEdits","params":{"clips":[left]}}]})).await;
        if change == "unrelated-name" {
            answer.unwrap_or_else(|error| panic!("{change}: {error}"));
        } else {
            assert_eq!(answer.expect_err(change)["error"]["code"], "conflict");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_named_through_join_replays_the_adjacent_member_that_was_deleted() {
    let (f, left, right, _, _) = through();
    let (_, basis) = f.inspect().await;
    f.colleague(&[("edit.clear", json!({"clips":[right]}))]);
    let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.joinThroughEdits","params":{"clips":[left]}}]})).await;
    assert_eq!(answer.expect_err("observed adjacent member was deleted")["error"]["code"], "conflict");
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_non_through_neighbour_does_not_refuse_the_join() {
    for index in [0, 3] {
        let (f, left, _, _, _) = through();
        let (sequence, basis) = f.inspect().await;
        let clips = v1(&sequence);
        f.colleague(&[("edit.clear", json!({"clips":[clips[index]]}))]);
        f.ok("run", json!({"basis":basis,"steps":[{"command":"sequence.joinThroughEdits","params":{"clips":[left]}}]})).await;
        f.shutdown().await;
    }
}
