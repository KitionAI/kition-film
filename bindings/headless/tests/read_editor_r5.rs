//! C8-film-read: helper placement consumes the step's observed time.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn delegated_shapes_use_the_steps_time_after_an_independent_save() {
    for command in ["graphics.newRectangle", "graphics.newEllipse"] {
        for related in [true, false] {
            let f = Fixture::new(4);
            let (q, basis) = f.inspect().await;
            if related {
                f.colleague(&[("sequence.settings", json!({"width":640}))]);
            } else {
                f.colleague(&[("clip.rename", json!({"clip":v1(&q)[0],"name":"Unrelated"}))]);
            }
            let result = f
                .call(
                    "run",
                    json!({"basis":basis,"steps":[{
                    "command":command,"at":{"part":{"sequence":q["id"]},"time":3.0},"params":{"track":1}
                    }]}),
                )
                .await;
            if related {
                let error = result.expect_err("the inherited frame size changed");
                assert_eq!(error["error"]["code"], "conflict", "{error}");
            } else {
                result.unwrap_or_else(|e| panic!("the other clip's name is unrelated ({command}): {e}"));
                let doc = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
                let seen = doc.inspect().unwrap();
                let graphic = &seen["sequence"]["video"][1]["items"][0];
                assert!(graphic["start"].as_i64().unwrap() > 2 * SECOND, "the delegated command must consume at.time: {graphic}");
            }
            f.shutdown().await;
        }
    }
}
