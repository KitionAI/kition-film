//! C8-film-pin: caption imports, exports and navigation retain their actual inputs.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn caption_routes_refuse_changed_inputs_and_allow_unrelated_sequence_names() {
    for command in ["caption.next", "caption.goTo", "caption.showActiveOnly"] {
        for related in [false, true] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let track = doc.execute("caption.newTrack", json!({"name":"Observed"})).unwrap()["track"].clone();
            let caption = doc.execute("caption.add", json!({"text":"Observed", "time":SECOND,"durationSeconds":1})).unwrap()["caption"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            let change = if !related {
                ("sequence.settings", json!({"name":"Independent"}))
            } else {
                match command {
                    "caption.goTo" => ("caption.setTimes", json!({"caption":caption,"startTime":2*SECOND,"endTime":3*SECOND})),
                    _ => ("caption.setTrack", json!({"track":track,"enabled":false})),
                }
            };
            f.colleague(&[change]);
            let params = match command {
                "caption.goTo" => json!({"caption":caption}),
                "caption.showActiveOnly" => json!({"track":track}),
                _ => json!({}),
            };
            let before = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if related {
                let error = answer.expect_err("the observed caption input changed");
                assert_eq!(error["error"]["code"], "conflict", "{command}: {error}");
                assert_eq!(std::fs::read(f.file()).unwrap(), before, "{command}");
                assert!(!f.workspace.path().join("Output.srt").exists());
            } else {
                answer.unwrap_or_else(|error| panic!("{command}: a sequence name is independent: {error}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_navigation_holds_frame_snapping_and_following_selection_geometry() {
    for command in ["caption.next", "caption.previous", "caption.goTo"] {
        for geometry in [false, true] {
            if geometry && command == "caption.goTo" {
                continue;
            }
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let clip = v1(&doc.inspect().unwrap()["sequence"])[0];
            let caption = doc.execute("caption.add", json!({"text":"Observed", "time":SECOND,"durationSeconds":1})).unwrap()["caption"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            if geometry {
                let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
                f.kits
                    .execute(
                        kition_kits::Caller::User,
                        view.kit_id,
                        &view.document_id,
                        "sequence.selectionFollowsPlayhead",
                        json!({"on":true}).as_object().unwrap().clone(),
                    )
                    .await
                    .unwrap();
            }
            let (_, basis) = f.inspect().await;
            f.colleague(&[if geometry {
                ("timeline.move", json!({"moves":[{"clip":clip,"track":"V1","time":2*SECOND}]}))
            } else {
                ("sequence.settings", json!({"fps":30}))
            }]);
            let before = std::fs::read(f.file()).unwrap();
            let params = if command == "caption.goTo" { json!({"caption":caption}) } else { json!({}) };
            let error = f
                .refused(
                    "run",
                    json!({"basis":basis,"steps":[{"command":command,"params":params,"at":{"time":if command=="caption.previous" {1.5} else {0.0}}}]}),
                )
                .await;
            assert_eq!(error["error"]["code"], "conflict", "{command}/geometry={geometry}: {error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
            f.shutdown().await;
        }
    }
}
