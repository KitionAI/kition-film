//! Color patches retain both assigned color fields and the normalized legacy label.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn color_settings_refuse_same_field_changes_and_preserve_unassigned_fields() {
    for same_field in [false, true] {
        let f = Fixture::new(1);
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.colorSettings", if same_field { json!({"wideGamut":true}) } else { json!({"autoToneMap":false}) })]);
        let before = std::fs::read(f.file()).unwrap();
        let result = f.call("run", json!({"basis":basis,"steps":[{"command":"sequence.colorSettings","params":{"wideGamut":false}}]})).await;
        if same_field {
            let error = result.expect_err("a same-field color assignment must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            result.unwrap_or_else(|error| panic!("tone mapping is independent of the wide-gamut patch: {error}"));
        }
        f.shutdown().await;
    }
}
