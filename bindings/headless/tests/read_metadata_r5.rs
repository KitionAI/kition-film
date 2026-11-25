//! C8-film-read: custom metadata targets the resolved source and checks conditional fields.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn custom_metadata_holds_its_field_through_every_target_route() {
    let mut failures = Vec::new();
    for route in ["item", "clip", "on-item", "on-clip"] {
        for related in [true, false] {
            let f = Fixture::new(2);
            let (q, _) = f.inspect().await;
            let clip = v1(&q)[0];
            let item = q["video"][0]["items"][0]["item"].as_u64().unwrap();
            rewrite(&f.file(), |p| {
                p.item_mut(ItemId(item)).unwrap().metadata.insert("CustomCount".into(), "1".into());
            });
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                p.item_mut(ItemId(item)).unwrap().metadata.insert(if related { "CustomCount" } else { "Unrelated" }.into(), "3".into());
            });
            let mut step = json!({"command":"metadata.set","at":{"part":{"sequence":q["id"]}},"params":{"field":"CustomCount","value":"2"}});
            match route {
                "item" => step["params"]["item"] = json!(item),
                "clip" => step["params"]["clip"] = json!(clip),
                "on-item" => step["on"] = json!([item]),
                _ => step["on"] = json!([clip]),
            }
            let answer = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            let correct = if related { matches!(answer, Err(ref e) if e["error"]["code"] == "conflict") } else { answer.is_ok() };
            if !correct {
                failures.push(format!("{route}/same={related}: {}", answer.as_ref().map(|_| "accepted".to_owned()).unwrap_or_else(|e| e["error"].to_string())));
            }
            if !related && answer.is_ok() {
                let mut doc = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap();
                let fields = doc.execute("metadata.get", json!({"item":item})).unwrap();
                assert_eq!(fields["metadata"]["CustomCount"], "2");
                assert_eq!(fields["metadata"]["Unrelated"], "3");
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subclips_parent_decides_whether_a_metadata_field_is_editable() {
    for related in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
        let parent = doc.execute("item.newOfflineFile", json!({"name":"Sound","seconds":1,"video":false})).unwrap()["item"].as_u64().unwrap();
        let video = doc.execute("item.newOfflineFile", json!({"name":"Picture","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
        let sub = doc.execute("clip.makeSubclip", json!({"item":parent,"name":"Sub","start":0,"end":SECOND/2})).unwrap()["item"].clone();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            if related {
                let info = p.item(ItemId(video)).unwrap().as_media().unwrap().info.video.clone();
                p.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().info.video = info;
            } else {
                p.item_mut(ItemId(parent)).unwrap().metadata.insert("note".into(), "Unrelated".into());
            }
        });
        let answer =
            f.call("run", json!({"basis":basis,"steps":[{"command":"metadata.set","params":{"item":sub,"field":"Video Codec","value":"Mine"}}]})).await;
        if related {
            assert_eq!(answer.expect_err("a parent video stream makes Video Codec read-only")["error"]["code"], "conflict");
        } else {
            answer.unwrap_or_else(|e| panic!("the parent's metadata does not decide editability: {e}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_editability_holds_the_predicate_instead_of_its_unused_values() {
    for change in ["mark-value", "equivalent-parent"] {
        let mut doc = FilmDocument::open(FILE, &project(2)).unwrap();
        let parent = doc.execute("item.newOfflineFile", json!({"name":"A","seconds":1,"video":false})).unwrap()["item"].as_u64().unwrap();
        let other = doc.execute("item.newOfflineFile", json!({"name":"B","seconds":1,"video":false})).unwrap()["item"].as_u64().unwrap();
        doc.execute("project.setMarks", json!({"item":parent,"in":SECOND/8})).unwrap();
        let sub = doc.execute("clip.makeSubclip", json!({"item":parent,"name":"Sub","start":0,"end":SECOND/2})).unwrap()["item"].as_u64().unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        rewrite(&f.file(), |p| {
            if change == "mark-value" {
                p.item_mut(ItemId(parent)).unwrap().as_media_mut().unwrap().mark_in = Some(serde_json::from_value(json!(SECOND / 4)).unwrap());
            } else if let kition_film_project::ItemKind::Subclip { parent, .. } = &mut p.item_mut(ItemId(sub)).unwrap().kind {
                *parent = ItemId(other);
            } else {
                panic!("fixture is a subclip");
            }
        });
        let (item, field) = if change == "mark-value" { (parent, "In Point") } else { (sub, "Video Codec") };
        f.ok("run", json!({"basis":basis,"steps":[{"command":"metadata.set","params":{"item":item,"field":field,"value":"Mine"}}]})).await;
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn literal_metadata_keys_ignore_other_keys() {
    // Brackets in a literal JSON Pointer segment name this map key, not a selector.
    let f = Fixture::new(2);
    let (q, _) = f.inspect().await;
    let item = q["video"][0]["items"][0]["item"].as_u64().unwrap();
    rewrite(&f.file(), |p| {
        p.item_mut(ItemId(item)).unwrap().metadata.insert("flag[id=7]".into(), "1".into());
    });
    let (_, basis) = f.inspect().await;
    rewrite(&f.file(), |p| {
        p.item_mut(ItemId(item)).unwrap().metadata.insert("Unrelated".into(), "3".into());
    });
    f.ok("run", json!({"basis":basis,"steps":[{"command":"metadata.set","params":{"item":item,"field":"flag[id=7]","value":"2"}}]})).await;
    f.shutdown().await;
}
