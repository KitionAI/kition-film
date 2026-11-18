//! Independent-writer checks from the committed C8-film-read project/media rows.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use serde_json::{Value, json};

async fn patch_case(command: &str, mine: Value, related: Value, unrelated: Value, executable: bool) {
    for same_field in [true, false] {
        let f = Fixture::new(2);
        let (_, basis) = f.inspect().await;
        f.colleague(&[(command, if same_field { related.clone() } else { unrelated.clone() })]);
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":mine}]})).await;
        if same_field {
            let error = answer.expect_err("a supplied project-setting field changed");
            assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
        } else if executable {
            answer.unwrap_or_else(|error| panic!("an unrelated setting must apply ({command}): {error}"));
        } else {
            // files::refuse_for_agent excludes this entire folder-setting command,
            // even a call without a folder. Here only the guard is exercised: an
            // unrelated change passes it and reaches the established host-only error.
            let error = answer.expect_err("folder-setting commands remain host-only");
            assert_eq!(error["error"]["code"], "command-failed", "{command}: {error}");
            assert!(error.to_string().contains("not available to the agent"), "{error}");
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn project_general_settings_protect_supplied_fields_only() {
    patch_case("file.projectSettings.general", json!({"titleSafe":[0.2,0.2]}), json!({"titleSafe":[0.12,0.14]}), json!({"captureFormat":"HDV"}), true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn scratch_settings_protect_supplied_fields_only() {
    patch_case("file.projectSettings.scratchDisks", json!({"captured":"mine"}), json!({"captured":"theirs"}), json!({"audioPreviews":"unrelated"}), false)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ingest_settings_protect_supplied_fields_only() {
    patch_case("project.ingestSettings", json!({"enabled":false}), json!({"enabled":true}), json!({"preset":"h264_half"}), false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn freeform_position_object_keys_name_the_items_the_write_replaces() {
    for position in [true, false] {
        let f = Fixture::new(2);
        let (sequence, basis) = f.inspect().await;
        let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
        f.colleague(&[if position {
            ("project.freeform.move", json!({"positions":{item.to_string():[70,80]},"snap":false}))
        } else {
            ("clip.rename", json!({"item":item,"name":"colleague"}))
        }]);
        let answer = f
            .call("run", json!({"basis":basis,"steps":[{"command":"project.freeform.move","params":{"positions":{item.to_string():[100,120]},"snap":false}}]}))
            .await;
        if position {
            assert_eq!(answer.expect_err("the named item's position changed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|error| panic!("item name is unrelated to an explicit card position: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_log_patch_holds_the_resolved_source_field_for_clip_and_item() {
    for via_clip in [true, false] {
        for description in [true, false] {
            let f = Fixture::new(2);
            let (sequence, basis) = f.inspect().await;
            let clip = sequence["video"][0]["items"][0]["clip"].as_u64().unwrap();
            let item = sequence["video"][0]["items"][0]["item"].as_u64().unwrap();
            f.colleague(&[("metadata.set", json!({"item":item,"field":if description {"Description"} else {"Scene"},"value":"theirs"}))]);
            let mut params = json!({"field":"Description","value":"mine"});
            params[if via_clip { "clip" } else { "item" }] = json!(if via_clip { clip } else { item });
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"metadata.set","params":params}]})).await;
            if description {
                assert_eq!(answer.expect_err("the resolved source Description changed")["error"]["code"], "conflict");
            } else {
                answer.unwrap_or_else(|error| panic!("Scene is unrelated to a Description patch (via_clip={via_clip}): {error}"));
            }
            f.shutdown().await;
        }
    }
}
