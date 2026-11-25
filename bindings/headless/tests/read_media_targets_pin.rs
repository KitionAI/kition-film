mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn timeline_footage_interpretation_refuses_changed_source_assignment_but_allows_names() {
    for related in [false, true] {
        let f = Fixture::new(0);
        let source = f.colleague(&[("item.newBarsAndTone", json!({"seconds":2}))])[0]["item"].as_u64().unwrap();
        let clip = f.colleague(&[("timeline.place", json!({"item":source,"track":"V1","time":0}))])[0]["clips"][0].as_u64().unwrap();
        f.ok(
            "run",
            json!({"steps":[{"command":"timeline.select","params":{"clips":[clip],"linked":false}},{"command":"project.select","params":{"items":[]}}]}),
        )
        .await;
        let (_, basis) = f.inspect().await;
        if related {
            rewrite(&f.file(), |project| {
                project.item_mut(kition_film_project::ItemId(source)).unwrap().as_media_mut().unwrap().interpret.color_space =
                    Some(serde_json::from_value(json!("Srgb")).unwrap());
            });
        } else {
            f.colleague(&[("clip.rename", json!({"item":source,"name":"Unused name"}))]);
        }
        let result = f
            .call(
                "run",
                json!({"basis":basis,"steps":[
                    {"command":"timeline.select","params":{"clips":[clip],"linked":false}},
                    {"command":"project.select","params":{"items":[]}},
                    {"command":"clip.interpretFootage","params":{"colorSpace":"auto"}}
                ]}),
            )
            .await;
        if related {
            let error = result.expect_err("the source interpretation was assigned after observation");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            assert!(result.is_ok(), "a source name is not consumed: {result:?}");
        }
        f.shutdown().await;
    }
}
