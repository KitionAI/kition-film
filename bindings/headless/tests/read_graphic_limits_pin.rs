//! C8-film-pin: graphic defaults consume the destination frame and successor boundary.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::json;

fn fixture() -> (Fixture, u64, u64, u64) {
    let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
    let graphic = doc.execute("graphics.newText", json!({"text":"Title","newClip":true,"track":0,"time":0,"seconds":1})).unwrap()["clip"].as_u64().unwrap();
    let item = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
    let next = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":10})).unwrap()["clips"][0].as_u64().unwrap();
    (Fixture::from_bytes(&doc.save(None).unwrap(), Default::default()), graphic, next, item)
}

#[tokio::test(flavor = "multi_thread")]
async fn graphic_duration_holds_rate_and_the_following_boundary() {
    for change in ["next-start", "nearer-successor", "rate", "next-name", "later-append"] {
        let (f, graphic, next, item) = fixture();
        let (sequence, basis) = f.inspect().await;
        let sequence = ItemId(sequence["id"].as_u64().unwrap());
        match change {
            "next-start" => rewrite(&f.file(), |project| {
                project.sequence_mut(sequence).unwrap().find_item_mut(ClipId(next)).unwrap().1.start.0 = 7 * SECOND;
            }),
            "nearer-successor" => {
                f.colleague(&[("timeline.place", json!({"item":item,"track":"V1","seconds":5}))]);
            }
            "rate" => {
                f.colleague(&[("sequence.settings", json!({"fps":25}))]);
            }
            "next-name" => {
                f.colleague(&[("clip.rename", json!({"clip":next,"name":"Unrelated"}))]);
            }
            "later-append" => {
                f.colleague(&[("timeline.place", json!({"item":item,"track":"V1","seconds":30}))]);
            }
            _ => unreachable!(),
        }
        let before = std::fs::read(f.file()).unwrap();
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"graphics.resetDuration","params":{"clip":graphic,"seconds":20}}]})).await;
        if matches!(change, "next-start" | "nearer-successor" | "rate") {
            assert_eq!(answer.expect_err(change)["error"]["code"], "conflict", "{change}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before, "{change}");
        } else {
            answer.unwrap_or_else(|error| panic!("{change} is unrelated: {error}"));
            let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
            assert_eq!(saved.project.sequence(sequence).unwrap().find_item(ClipId(graphic)).unwrap().1.duration.0, 10 * SECOND);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resetting_graphic_parameters_holds_frame_dimensions() {
    for change in ["width", "height", "unrelated-sample-rate"] {
        let (f, graphic, _, _) = fixture();
        let (_, basis) = f.inspect().await;
        let params = match change {
            "width" => json!({"width":640}),
            "height" => json!({"height":360}),
            _ => json!({"sampleRate":44100}),
        };
        f.colleague(&[("sequence.settings", params)]);
        let before = std::fs::read(f.file()).unwrap();
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"graphics.resetAllParameters","params":{"clip":graphic}}]})).await;
        if change == "unrelated-sample-rate" {
            answer.unwrap_or_else(|error| panic!("sample rate is unrelated: {error}"));
        } else {
            assert_eq!(answer.expect_err(change)["error"]["code"], "conflict", "{change}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before, "{change}");
        }
        f.shutdown().await;
    }
}
