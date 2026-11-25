mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::ClipId;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn implicit_speed_retains_neighbour_positions_and_allows_their_names() {
    for related in [true, false] {
        let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
        let item = doc.execute("item.newColorMatte", json!({"seconds":6})).unwrap()["item"].clone();
        let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
        let middle = doc.execute("timeline.razor", json!({"clip":first,"time":SECOND})).unwrap()["clips"][0].clone();
        let next = doc.execute("timeline.razor", json!({"clip":middle,"time":2*SECOND})).unwrap()["clips"][0].as_u64().unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        if related {
            rewrite(&f.file(), |project| {
                for item in project.items.values_mut() {
                    if let Some(sequence) = item.as_sequence_mut()
                        && let Some((_, clip)) = sequence.find_item_mut(ClipId(next))
                    {
                        clip.start.0 += SECOND;
                    }
                }
            });
        } else {
            f.colleague(&[("clip.rename", json!({"clip":next,"name":"Unconsumed"}))]);
        }
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.speedDuration","on":[middle],"params":{"speed":50}}]})).await;
        if related {
            assert_eq!(result.expect_err("implicit speed reads its next boundary")["error"]["code"], "conflict");
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}
