//! Channel numbers are not project-object identities.
mod common;
use common::*;
use kition_film_project::{ClipId, ItemId};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn project_channel_maps_accept_channel_numbers_and_preserve_same_field_conflicts() {
    for changed in [false, true] {
        let f = Fixture::new(0);
        let source = f.colleague(&[("file.newBarsAndTone", json!({"seconds":2}))])[0]["item"].as_u64().unwrap();
        let (_, basis) = f.inspect().await;
        if changed {
            f.colleague(&[("clip.audioChannels", json!({"items":[source],"format":"stereo","clips":[[1,0]]}))]);
        }
        let result = f
            .call("run", json!({"basis":basis,"steps":[{"command":"clip.audioChannels","params":{"items":[source],"format":"mono","clips":[[0],[1]]}}]}))
            .await;
        if changed {
            let error = result.expect_err("a channel map assigned after observation must refuse");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            assert!(result.is_ok(), "channel indices must not be resolved as Clip ids: {result:?}");
            let project = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap().project;
            let map = project.item(ItemId(source)).unwrap().as_media().unwrap().interpret.audio_channels.as_ref().unwrap();
            assert_eq!(map.clips, vec![vec![0], vec![1]]);
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn timeline_channels_refuse_changed_source_streams_but_allow_source_names() {
    for related in [false, true] {
        let f = Fixture::new(0);
        let source = f.colleague(&[("file.newBarsAndTone", json!({"seconds":2}))])[0]["item"].as_u64().unwrap();
        let placed = f.colleague(&[("timeline.place", json!({"item":source,"track":"V1","time":0}))]);
        let audio = placed[0]["clips"][1].as_u64().unwrap();
        let (seen, basis) = f.inspect().await;
        let sequence = ItemId(seen["id"].as_u64().unwrap());
        rewrite(&f.file(), |project| {
            let item = project.item_mut(ItemId(source)).unwrap();
            if related {
                item.as_media_mut().unwrap().info.audio_streams[0].channels = 1;
            } else {
                item.name = "Unused name".into();
            }
        });
        let result =
            f.call("run", json!({"basis":basis,"steps":[{"command":"clip.audioChannels","on":[audio],"params":{"channels":[1],"format":"stereo"}}]})).await;
        if related {
            let error = result.expect_err("the source stream is a channel validation input");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
        } else {
            assert!(result.is_ok(), "the source name is not consumed: {result:?}");
            let project = kition_film_format::decode(&std::fs::read(f.file()).unwrap()).unwrap().project;
            assert_eq!(project.sequence(sequence).unwrap().find_item(ClipId(audio)).unwrap().1.source_channels, [1]);
        }
        f.shutdown().await;
    }
}
