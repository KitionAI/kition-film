//! Reset replaces assigned preference fields even when it does not read them.
mod common;
use common::*;
use kition_kits::Caller;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn preference_reset_holds_fields_assigned_since_observation() {
    for category in [None, Some("graphics")] {
        let f = Fixture::new(1);
        let (_, basis) = f.inspect().await;
        let view = f.kits.open(Caller::User, FILE).await.unwrap();
        f.kits
            .execute(
                Caller::User,
                view.kit_id,
                &view.document_id,
                "prefs.set",
                json!({"key":"graphics.defaultFont","value":"Assigned font"}).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let before = std::fs::read(f.file()).unwrap();
        let params = category.map_or_else(|| json!({}), |category| json!({"category":category}));
        let error = f.refused("run", json!({"basis":basis,"steps":[{"command":"prefs.reset","params":params}]})).await;
        assert_eq!(error["error"]["code"], "conflict", "{error}");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}
