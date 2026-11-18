//! C8-film-pin: a subclip conversion copies the direct parent's media.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn subclip_edits_retain_only_consumed_parent_inputs() {
    for convert in [false, true] {
        for frames in [false, true] {
            for change in ["rate", "media", "name"] {
                let f = Fixture::new(1);
                let (seen, _) = f.inspect().await;
                let parent = seen["video"][0]["items"][0]["item"].as_u64().unwrap();
                let subclip = f.colleague(&[("clip.makeSubclip", json!({"item":parent,"start":0,"end":SECOND}))])[0]["item"].clone();
                let (_, basis) = f.inspect().await;
                rewrite(&f.file(), |project| {
                    let source = project.items.values_mut().find(|source| source.id.0 == parent).unwrap();
                    if change == "name" {
                        source.name = "Outside name".into();
                    } else {
                        let media = source.as_media_mut().unwrap();
                        if change == "rate" {
                            let rate = &mut media.info.video.as_mut().unwrap().frame_rate;
                            rate.num = 30;
                            rate.den = 1;
                        } else {
                            media.offline = !media.offline;
                        }
                    }
                });
                let mut params = json!({"item":subclip,"convertToMaster":convert});
                if frames {
                    params["startFrame"] = json!(0);
                    params["endFrame"] = json!(12);
                } else {
                    params["start"] = json!(0);
                    params["end"] = json!(SECOND / 2);
                }
                let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.editSubclip","params":params}]})).await;
                if (convert && change != "name") || (frames && change == "rate") {
                    assert_conflict(&result.expect_err("the copied parent input changed"), &parent.to_string(), "changed");
                } else {
                    result.unwrap_or_else(|error| panic!("unused parent input refused ({convert}/{frames}/{change}): {error}"));
                }
                f.shutdown().await;
            }
        }
    }
}
