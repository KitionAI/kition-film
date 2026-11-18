//! Public SDK terminal replies and literal metadata paths, through the real process boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_forced_close_omits_document_and_never_saves_over_the_colleague() {
    for command in ["file.closeProject", "file.closeAllProjects"] {
        for tail in [false, true] {
            let f = Fixture::new(2);
            let (q, basis) = f.inspect().await;
            if !tail {
                f.colleague(&[("clip.rename", json!({"clip":v1(&q)[0],"name":"Colleague"}))]);
            }
            let bytes = std::fs::read(f.file()).unwrap();
            // A guarded close is last, as the SDK contract requires. Without a basis,
            // exercise terminal completion's notRun accounting for trailing steps too.
            let mut steps = vec![json!({"command":command,"params":{"force":true}})];
            if tail {
                steps.push(json!({"command":"file.newBin","params":{"name":"Must not run"}}));
            }
            let mut input = json!({"steps":steps});
            if !tail {
                input["basis"] = json!(basis);
            }
            let answer = f.ok("run", input).await;
            assert_eq!(answer["closed"], true, "{answer}");
            assert_eq!(answer["saved"], false, "{answer}");
            assert!(answer.get("document").is_none(), "{answer}");
            assert_eq!(answer["notRun"].as_u64().unwrap_or(0), u64::from(tail), "{answer}");
            assert_eq!(answer["completed"].as_array().unwrap().len(), 1);
            assert_eq!(std::fs::read(f.file()).unwrap(), bytes);
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn literal_metadata_punctuation_keeps_same_field_protection() {
    for key in ["flag[id=7]", "a.b", "a/b", "a~b"] {
        for related in [false, true] {
            let f = Fixture::new(1);
            let (q, _) = f.inspect().await;
            let item = q["video"][0]["items"][0]["item"].clone();
            f.colleague(&[("metadata.set", json!({"item":item,"field":key,"value":"Observed"}))]);
            let (_, basis) = f.inspect().await;
            f.colleague(&[("metadata.set", json!({"item":item,"field":if related {key} else {"Other"},"value":"Colleague"}))]);
            let bytes = std::fs::read(f.file()).unwrap();
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"metadata.set","params":{"item":item,"field":key,"value":"Agent"}}]})).await;
            if related {
                let error = result.expect_err("an exact literal key changed");
                assert_eq!(error["error"]["code"], "conflict", "{key}: {error}");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|item| item["reason"] == "changed"));
                assert_eq!(std::fs::read(f.file()).unwrap(), bytes);
            } else {
                result.unwrap_or_else(|error| panic!("{key}: {error}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn track_renumbering_guards_observed_names_and_rebases_a_distant_append() {
    for rename in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        if rename {
            f.colleague(&[("timeline.setTrack", json!({"track":"V2","name":"Colleague"}))]);
        } else {
            f.colleague(&[("sequence.addTracks", json!({"video":1,"videoAfter":3}))]);
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":1}}]})).await;
        if rename {
            let error = answer.expect_err("renumbering reads the previously observed name");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
        } else {
            answer.unwrap_or_else(|error| panic!("a distant newly added lane is rebased: {error}"));
            let (q, _) = f.inspect().await;
            assert_eq!(q["video"].as_array().unwrap().len(), 5);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn track_names_keep_intermediate_colleague_assignments_separate_from_our_own() {
    for colleague in [false, true] {
        let f = Fixture::new(2);
        let (q, basis) = f.inspect().await;
        let original = q["video"][1]["name"].clone();
        if colleague {
            f.colleague(&[("timeline.setTrack", json!({"track":"V2","name":"Temporary"}))]);
            let _ = f.inspect().await;
            f.colleague(&[("timeline.setTrack", json!({"track":"V2","name":original}))]);
        } else {
            f.ok("run", json!({"steps":[{"command":"timeline.setTrack","params":{"track":"V2","name":"Our assignment"}}]})).await;
        }
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.addTracks","params":{"video":1,"videoAfter":1}}]})).await;
        if colleague {
            let error = answer.expect_err("restoring a name does not erase the colleague's assignment");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
        } else {
            answer.unwrap_or_else(|error| panic!("our own assignment is not an outside change: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_null_region_reaches_the_content_callback() {
    let f = Fixture::new(1);
    let view = f.kits.open(kition_kits::Caller::Agent, FILE).await.unwrap();
    let answer = f
        .kits
        .context(
            kition_kits::Caller::Agent,
            view.kit_id,
            &view.document_id,
            "context.content",
            json!({"id":"project","field":"~probe","region":null,"before":{}}).as_object().unwrap().clone(),
        )
        .await
        .unwrap_or_else(|error| panic!("a null region is a valid SDK ContentAsk and must reach the callback: {error}"));
    assert_eq!(answer.unwrap(), json!({"changed":null}));
    f.shutdown().await;
}
