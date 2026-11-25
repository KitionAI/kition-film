//! Edge decisions are retained without holding distant appearance.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn geometry_commands_refuse_changed_edges_and_allow_distant_opacity() {
    for command in ["timeline.rateStretch", "timeline.slideLeft", "trim.extendPreviousEdit", "trim.previous", "clip.frameHold", "clip.insertFrameHoldSegment"] {
        for change in ["rate", "edge", "opacity"] {
            let mut doc = FilmDocument::create(FILE, 64, 36).unwrap();
            let source = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
            let first = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0,"duration":3*SECOND})).unwrap()["clips"][0].clone();
            let middle = doc.execute("timeline.razor", json!({"clip":first,"time":SECOND})).unwrap()["clips"][0].clone();
            let next = doc.execute("timeline.razor", json!({"clip":middle,"time":2*SECOND})).unwrap()["clips"][0].clone();
            let distant = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":8*SECOND})).unwrap()["clips"][0].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            match change {
                "rate" => {
                    f.colleague(&[("sequence.settings", json!({"fps":30}))]);
                }
                "edge" => {
                    f.colleague(&[("timeline.rateStretch", json!({"clip":next,"edge":"out","delta":SECOND/4}))]);
                }
                _ => {
                    f.colleague(&[("effect.setParam", json!({"clip":distant,"effect":"opacity","param":"opacity","value":55}))]);
                }
            }
            let params = if command == "timeline.rateStretch" {
                json!({"clip":middle,"edge":"out","delta":SECOND/24})
            } else if command == "clip.frameHold" {
                json!({"clips":[middle],"time":SECOND+SECOND/2})
            } else if command.starts_with("clip.") {
                json!({"clip":middle,"time":SECOND+SECOND/2,"seconds":0.5})
            } else {
                json!({})
            };
            let mut step = json!({"at":{"time":1.5},"command":command,"params":params});
            if matches!(command, "timeline.slideLeft" | "trim.previous") {
                step["on"] = json!([middle]);
            }
            let result = f.call("run", json!({"basis":basis,"steps":[step]})).await;
            if change == "opacity" {
                assert!(result.is_ok(), "{command}/{change}: {result:?}");
            } else {
                let error = result.expect_err("a changed edge/timebase must refuse");
                assert_eq!(error["error"]["code"], "conflict", "{command}/{change}: {error}");
            }
            f.shutdown().await;
        }
    }
}
