//! C8-land-13t: model creations survive the saved-file reread.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn creating_a_top_level_bin_preserves_it_under_the_fixed_root() {
    let f = Fixture::new(1);
    let answer = f
        .ok(
            "batch",
            json!({"ops":[
                {"op":"create","type":"Bin","in":"root.bins","parent":null,"ref":"$new","fields":{"name":"Risks"}},
                {"op":"tree.move","target":"root","field":"bins","item":"$new","parent":null},
                {"op":"tree.move","target":"root","field":"bins","item":"0","parent":null}
            ]}),
        )
        .await;
    let created = answer["changes"]["created"].as_array().unwrap();
    assert_eq!(created.len(), 1, "{answer}");
    assert_eq!(created[0]["at"]["parent"], "0", "the saved format has one root: {answer}");
    let reopened = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
    assert!(reopened.inspect().unwrap().to_string().contains("Risks"));
    f.shutdown().await;
}
