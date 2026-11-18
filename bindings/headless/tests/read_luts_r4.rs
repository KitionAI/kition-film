//! C8-film-read: string LUT references resolve project-owned values.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::ProjectLut;
use serde_json::json;

async fn named_lut_pair() {
    let command = "lut.remove";
    for related in [true, false] {
        let f = Fixture::new(1);
        rewrite(&f.file(), |p| {
            for id in ["mine", "other"] {
                p.luts.push(ProjectLut {
                    id: id.into(),
                    name: id.into(),
                    source_path: None,
                    format: "cube".into(),
                    text: "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n".into(),
                });
            }
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let lut = p.luts.iter_mut().find(|lut| lut.id == if related { "mine" } else { "other" }).unwrap();
            lut.name = "Theirs".into();
        });
        let params = json!({"id":"lib:mine"});
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
        if related {
            let error = answer.expect_err("the named LUT's consumed or removed value changed");
            assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
        } else {
            answer.unwrap_or_else(|e| panic!("another LUT is independent of {command}: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn named_lut_removal_holds_the_referenced_entry_only() {
    named_lut_pair().await;
}
