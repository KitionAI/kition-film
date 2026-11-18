//! C8-film-pin: Frame Hold Options consumes the source's snap timebase.
mod common;
use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn frame_hold_options_protects_source_rate_and_timecode_without_holding_names() {
    for mode in ["in", "out", "playhead", "sequenceTime", "sourceTimecode"] {
        for change in ["rate", "origin", "name", "disabled"] {
            let f = Fixture::new(2);
            let (seen, basis) = f.inspect().await;
            let clip = v1(&seen)[0];
            let item = seen["video"][0]["items"][0]["item"].as_u64().unwrap();
            rewrite(&f.file(), |project| {
                let source = project.items.values_mut().find(|source| source.id.0 == item).unwrap();
                if change == "name" {
                    source.name = "Outside name".into();
                } else {
                    let media = source.as_media_mut().unwrap();
                    if change == "origin" {
                        media.info.start_timecode = Some(24);
                    } else {
                        let rate = &mut media.info.video.as_mut().unwrap().frame_rate;
                        rate.num = 30;
                        rate.den = 1;
                    }
                }
            });
            let params = json!({"clips":[clip],"holdOn":mode,"timecode":"00:00:00:01","time":SECOND/2,"enabled":change!="disabled"});
            let result = f.call("run", json!({"basis":basis,"steps":[{"command":"clip.frameHoldOptions","params":params}]})).await;
            if change == "rate" || (change == "origin" && mode == "sourceTimecode") {
                let error = result.expect_err("the source timebase changed");
                assert_conflict(&error, &item.to_string(), "changed");
            } else {
                result.unwrap_or_else(|error| panic!("unused source field refused for {mode}/{change}: {error}"));
            }
            f.shutdown().await;
        }
    }
}
