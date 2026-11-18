//! Compound placement retains its free-lane and source-channel decisions.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn compound_sound_placement_refuses_changed_lanes_and_sources() {
    for command in ["timeline.placeMany", "sound.phrase", "audio.bed"] {
        for change in ["lane", "channels", "unrelated"] {
            let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
            let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            match change {
                "lane" => {
                    f.colleague(&[("timeline.setTrack", json!({"track":"A1","locked":true}))]);
                }
                "channels" => {
                    f.colleague(&[("clip.audioChannels", json!({"items":[item],"format":"mono","clips":[[0],[1]]}))]);
                }
                _ => rewrite(&f.file(), |project| project.name = "Unrelated".into()),
            }
            let params = match command {
                "timeline.placeMany" => json!({"items":[{"item":item,"seconds":0}]}),
                "sound.phrase" => json!({"preset":"click","seconds":0,"items":{"click":item}}),
                _ => json!({"item":item,"seconds":0}),
            };
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if change == "unrelated" {
                assert!(result.is_ok(), "{command}/{change}: {result:?}");
            } else {
                let error = result.expect_err("a changed compound-placement input must refuse");
                assert_eq!(error["error"]["code"], "conflict", "{command}/{change}: {error}");
            }
            f.shutdown().await;
        }
    }
}
