//! C8-film-read: submix routing eligibility consumes both strip positions.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ItemId;
use kition_kit::KitDocument;
use serde_json::json;

async fn routing_pairs(changes: &[&str]) {
    let mut failures = Vec::new();
    for command in ["mixer.setStrip", "mixer.addSend", "mixer.setSend"] {
        for change in changes.iter().copied() {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            let sequence = ItemId(doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap());
            let mut strips = Vec::new();
            for n in 0..5 {
                strips.push(doc.execute("mixer.addSubmix", json!({"name":format!("Bus {n}")})).unwrap()["id"].as_u64().unwrap());
            }
            let (source, target) = (strips[0], strips[2]);
            if command == "mixer.setSend" {
                // The existing send remains valid after the source moves: the
                // fifth bus is still later than its new fourth position.
                doc.execute("mixer.addSend", json!({"strip":source,"target":strips[4]})).unwrap();
            }
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let tracks = &mut p.sequence_mut(sequence).unwrap().submix_tracks;
                match change {
                    // The target stays at index 2 when the source crosses it.
                    "across" => tracks.swap(0, 3),
                    "before" => tracks.swap(0, 1),
                    "target-before" => tracks.swap(2, 3),
                    _ => tracks[0].name = "Colleague".into(),
                }
            });
            // The requested predicate itself changes only for the crossing.
            // This checks the kit's real derived provider on both saved files,
            // independently of the SDK's atomic derived-change bookkeeping.
            let pair = format!("{source}_{target}");
            let original = doc.derived(&[json!(sequence.0)], &["mixerRoutes".into()]).unwrap();
            let current = FilmDocument::open(FILE, &std::fs::read(f.file()).unwrap()).unwrap().derived(&[json!(sequence.0)], &["mixerRoutes".into()]).unwrap();
            assert_eq!(original.iter().find(|values| values.id == sequence.0).unwrap().values["mixerRoutes"][&pair], true);
            assert_eq!(current.iter().find(|values| values.id == sequence.0).unwrap().values["mixerRoutes"][&pair], change != "across");
            let params = match command {
                "mixer.setStrip" => json!({"strip":source,"output":target}),
                "mixer.addSend" => json!({"strip":source,"target":target}),
                _ => json!({"strip":source,"send":0,"target":target}),
            };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if change == "across" {
                if !result.as_ref().is_err_and(|error| error["error"]["code"] == "conflict") {
                    failures.push(format!(
                        "{command}: source order eligibility changed, got {}",
                        result.as_ref().map(|_| "applied".to_owned()).unwrap_or_else(|error| error["error"].to_string())
                    ));
                }
            } else if let Err(error) = result {
                failures.push(format!(
                    "{command}/{change}: selected predicate true -> true; unrelated change refused: {} conflicts={}",
                    error["error"], error["conflicts"]
                ));
            } else {
                let saved = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap();
                let strip = saved.project.sequence(sequence).unwrap().submix_tracks.iter().find(|strip| strip.id.0 == source).unwrap();
                if change == "name" {
                    assert_eq!(strip.name, "Colleague", "{command}");
                }
                if command == "mixer.setStrip" {
                    assert_eq!(strip.mixer.output.map(|id| id.0), Some(target));
                } else {
                    assert_eq!(strip.mixer.sends.last().unwrap().target.0, target, "{command}");
                }
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn submix_routing_holds_changed_source_eligibility_and_allows_names() {
    routing_pairs(&["across", "name"]).await;
}

// Each source/target predicate has its own computed fact identity.
#[tokio::test(flavor = "multi_thread")]
async fn mixer_routing_predicate_subpaths_ignore_other_pairs() {
    routing_pairs(&["before", "target-before"]).await;
}
