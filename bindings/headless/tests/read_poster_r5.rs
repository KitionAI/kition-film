//! C8-film-read: poster commands resolve project/Source items and assign metadata.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

async fn choose(f: &Fixture, route: &str, source: u64) {
    let _ = f.inspect().await;
    let view = f.kits.open(kition_kits::Caller::User, FILE).await.unwrap();
    let (command, params) = if route == "source" { ("source.open", json!({"item":source})) } else { ("project.select", json!({"items":[source]})) };
    f.kits.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn poster_writes_hold_the_resolved_assignment_but_not_other_metadata_or_program_clips() {
    let mut failures = Vec::new();
    for command in ["clip.setPosterFrame", "clip.clearPosterFrame"] {
        for route in ["explicit", "selection", "source"] {
            for change in ["assigned", "metadata", "program"] {
                let f = Fixture::new(2);
                let (q, _) = f.inspect().await;
                let sequence = ItemId(q["id"].as_u64().unwrap());
                let source = q["video"][0]["items"][0]["item"].as_u64().unwrap();
                let clip = ClipId(v1(&q)[0]);
                rewrite(&f.file(), |p| {
                    p.item_mut(ItemId(source)).unwrap().metadata.insert("Poster Frame".into(), SECOND.to_string());
                });
                choose(&f, route, source).await;
                let (_, basis) = f.inspect().await;
                rewrite(&f.file(), |p| match change {
                    "assigned" => {
                        p.item_mut(ItemId(source)).unwrap().metadata.insert("Poster Frame".into(), (SECOND / 2).to_string());
                    }
                    "metadata" => {
                        p.item_mut(ItemId(source)).unwrap().metadata.insert("description".into(), "Colleague".into());
                    }
                    _ => p.sequence_mut(sequence).unwrap().find_item_mut(clip).unwrap().1.enabled = false,
                });
                choose(&f, route, source).await;
                let params = if route == "explicit" { json!({"item":source}) } else { json!({}) };
                let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
                let label = format!("{command}/{route}/{change}");
                if change == "assigned" {
                    if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                        failures.push(format!("{label}: assigned poster metadata changed: {}", result.as_ref().map(|_| "applied").unwrap_or("wrong error")));
                    }
                } else if let Err(error) = result {
                    failures.push(format!("{label}: unrelated change refused: {}", error["error"]));
                } else {
                    let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                    let item = saved.project.item(ItemId(source)).unwrap();
                    if command == "clip.setPosterFrame" {
                        assert_eq!(item.metadata.get("Poster Frame").map(String::as_str), Some("0"), "{label}");
                    } else {
                        assert!(!item.metadata.contains_key("Poster Frame"), "{label}");
                    }
                    if change == "metadata" {
                        assert_eq!(item.metadata["description"], "Colleague", "{label}");
                    }
                    if change == "program" {
                        assert!(!saved.project.sequence(sequence).unwrap().find_item(clip).unwrap().1.enabled, "{label}");
                    }
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn poster_set_holds_the_parent_timebase_while_clear_ignores_it() {
    use kition_film_kit::FilmDocument;
    use kition_kit::KitDocument;
    let mut failures = Vec::new();
    for command in ["clip.setPosterFrame", "clip.clearPosterFrame"] {
        for change in ["parent-rate", "parent-metadata", "subclip-range", "parent-deleted"] {
            let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
            let parent = ItemId(doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap());
            let source =
                ItemId(doc.execute("clip.makeSubclip", json!({"item":parent.0,"name":"Poster","start":0,"end":SECOND/2})).unwrap()["item"].as_u64().unwrap());
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            if change == "parent-deleted" {
                rewrite(&f.file(), |p| {
                    let rate = &mut p.item_mut(parent).unwrap().as_media_mut().unwrap().info.video.as_mut().unwrap().frame_rate;
                    rate.num = 30;
                    rate.den = 1;
                });
            }
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| match change {
                "parent-rate" => {
                    let rate = &mut p.item_mut(parent).unwrap().as_media_mut().unwrap().info.video.as_mut().unwrap().frame_rate;
                    rate.num = 30;
                    rate.den = 1;
                }
                "parent-metadata" => {
                    p.item_mut(parent).unwrap().metadata.insert("description".into(), "Colleague".into());
                }
                "parent-deleted" => {
                    p.items.remove(&parent);
                    p.root.remove_item(parent);
                }
                _ => {
                    let kition_film_project::ItemKind::Subclip { range, .. } = &mut p.item_mut(source).unwrap().kind else { panic!("subclip") };
                    range.duration.0 -= SECOND / 10;
                }
            });
            let mut params = json!({"item":source.0});
            if command == "clip.setPosterFrame" {
                params["time"] = json!(SECOND / 3);
            }
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            let label = format!("{command}/{change}");
            if command == "clip.setPosterFrame" && matches!(change, "parent-rate" | "parent-deleted") {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!("{label}: inherited timebase changed"));
                }
            } else if let Err(error) = result {
                failures.push(format!("{label}: unrelated change refused: {}", error["error"]));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let item = saved.project.item(source).unwrap();
                if command == "clip.clearPosterFrame" {
                    assert!(!item.metadata.contains_key("Poster Frame"), "{label}");
                    if change == "parent-deleted" {
                        assert!(saved.project.item(parent).is_none(), "{label}");
                    }
                } else {
                    let mut time = item.duration();
                    time.0 = SECOND / 3;
                    let expected = saved.project.item(parent).unwrap().frame_rate().snap(time).0.to_string();
                    assert_eq!(item.metadata["Poster Frame"], expected, "{label}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
