//! C8-film-read: recheck unencoded core paths against their retained blind rows.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn replacing_the_project_holds_its_contents_and_allows_a_format_only_rewrite() {
    for command in ["file.newProject", "file.openDemoProject"] {
        for related in [true, false] {
            let f = Fixture::new(2);
            let (seq, basis) = f.inspect().await;
            if related {
                f.colleague(&[("clip.rename", json!({"clip":v1(&seq)[1],"name":"Theirs"}))]);
            } else {
                let mut bytes = std::fs::read(f.file()).unwrap();
                bytes.push(b'\n');
                std::fs::write(f.file(), bytes).unwrap();
            }
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":{}}]})).await;
            if related {
                assert_eq!(answer.expect_err("replacement assigns all project contents")["error"]["code"], "conflict", "{command}");
            } else {
                answer.unwrap_or_else(|e| panic!("a format-only save preserves every assigned fact ({command}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn offline_file_defaults_hold_inherited_size_and_explicit_size_does_not() {
    for explicit in [false, true] {
        for related in [true, false] {
            let f = Fixture::new(2);
            let (_, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", if related { json!({"width":640}) } else { json!({"name":"Unrelated"}) })]);
            let params = if explicit { json!({"width":64,"height":36,"fps":24}) } else { json!({}) };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"file.newOfflineFile","params":params}]})).await;
            if related && !explicit {
                assert_eq!(answer.expect_err("the offline file inherits the active frame size")["error"]["code"], "conflict");
            } else {
                answer.unwrap_or_else(|e| panic!("unused sequence fields are unrelated (explicit={explicit}, size={related}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn source_mark_assignments_hold_the_source_side_but_not_source_metadata() {
    for command in ["project.setMarks", "markers.markIn", "markers.clearIn"] {
        for related in [true, false] {
            let f = Fixture::new(2);
            let (seq, _) = f.inspect().await;
            let item = seq["video"][0]["items"][0]["item"].as_u64().unwrap();

            let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
            f.kits
                .execute(kition_kits::Caller::User, view.kit_id, &view.document_id, "source.open", json!({"item":item}).as_object().unwrap().clone())
                .await
                .unwrap();
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let source = p.item_mut(ItemId(item)).unwrap();
                if related {
                    source.as_media_mut().unwrap().mark_in = Some(serde_json::from_value(json!(SECOND / 2)).unwrap());
                } else {
                    source.metadata.insert("note".into(), "Unrelated".into());
                }
            });
            let params = match command {
                "project.setMarks" => json!({"in":SECOND/4}),
                "markers.markIn" => json!({"target":"source","time":SECOND/4}),
                _ => json!({"target":"source"}),
            };
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if related {
                assert_eq!(answer.expect_err("same Source mark was independently assigned")["error"]["code"], "conflict", "{command}");
            } else {
                answer.unwrap_or_else(|e| panic!("Source metadata is preserved by a mark assignment ({command}): {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn program_in_marks_preserve_the_unassigned_out_split_and_clear_in_preserves_out() {
    for command in ["markers.markIn", "markers.clearIn"] {
        let f = Fixture::new(2);
        let (seq, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(ItemId(seq["id"].as_u64().unwrap())).unwrap();
            if command == "markers.markIn" {
                q.split.video_out = Some(serde_json::from_value(json!(SECOND)).unwrap());
            } else {
                q.mark_out = Some(serde_json::from_value(json!(SECOND)).unwrap());
            }
        });
        f.ok(
            "run",
            json!({"basis":basis,"steps":[{"command":command,"params":if command == "markers.markIn" { json!({"time":SECOND/4}) } else { json!({}) }}]}),
        )
        .await;
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn nesting_retains_a_departed_link_partner_and_allows_uncopied_names() {
    for related in [true, false] {
        let f = Fixture::new(3);
        let (seq, _) = f.inspect().await;
        let clips = v1(&seq);
        let id = ItemId(seq["id"].as_u64().unwrap());
        rewrite(&f.file(), |p| {
            for clip in &clips[..2] {
                p.sequence_mut(id).unwrap().find_item_mut(ClipId(*clip)).unwrap().1.link = Some(910);
            }
        });
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            let q = p.sequence_mut(id).unwrap();
            if related {
                q.find_item_mut(ClipId(clips[1])).unwrap().1.link = None;
            } else {
                q.find_item_mut(ClipId(clips[2])).unwrap().1.name = "Unrelated".into();
            }
        });
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.nest","on":[clips[0]],"params":{"name":"Mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("the linked copied recipient departed")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("the name outside the copied selection is preserved: {e}"));
        }
        f.shutdown().await;
    }
}
