//! C8-film-pin: automation boundary evaluation consumes the strip mode.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn writing_automation_holds_the_mode_used_to_sample_preserved_boundaries() {
    for change in ["mode", "pan"] {
        let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
        let strip = doc.inspect().unwrap()["sequence"]["audio"][0]["id"].clone();
        doc.execute("mixer.setStrip", json!({"strip":strip,"volumeDb":-6,"mode":"Read"})).unwrap();
        for (time, value) in [(0, -12), (3 * SECOND, -24)] {
            doc.execute("mixer.setKeyframe", json!({"strip":strip,"time":time,"value":value})).unwrap();
        }
        let fixture = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = fixture.inspect().await;
        fixture.colleague(&[("mixer.setStrip", if change == "mode" { json!({"strip":strip,"mode":"Off"}) } else { json!({"strip":strip,"pan":25}) })]);
        let result = fixture
            .call("run", json!({"basis":basis,"steps":[{"command":"mixer.writeAutomation","params":{"strip":strip,"points":[[SECOND,-9],[2*SECOND,-18]]}}]}))
            .await;
        if change == "mode" {
            let error = result.expect_err("a changed evaluation mode must refuse the stale boundary samples");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["reason"] == "changed"), "{error}");
        } else {
            assert!(result.is_ok(), "unrelated pan must survive: {result:?}");
            let saved = FilmDocument::open(FILE, &std::fs::read(fixture.file()).unwrap()).unwrap().execute("mixer.inspect", json!({})).unwrap();
            assert_eq!(saved["strips"][0]["pan"], 25.0);
        }
        fixture.shutdown().await;
    }
}
