//! C8-film-pin: splitting captions consumes the sequence frame duration.
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn caption_split_holds_minimum_frame_duration_and_allows_sequence_names() {
    for change_rate in [true, false] {
        let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
        let added = doc.execute("captions.add", json!({"text":"Split this caption", "time":0,"durationSeconds":1})).unwrap();
        let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
        let (_, basis) = f.inspect().await;
        f.colleague(&[("sequence.settings", if change_rate { json!({"fps":30}) } else { json!({"name":"Independent"}) })]);
        let before = std::fs::read(f.file()).unwrap();
        let answer = f
            .call(
                "run",
                json!({"basis":basis,"steps":[{"command":"captions.split","params":{
                    "caption":added["caption"],"time":SECOND/2
                }}]}),
            )
            .await;
        if change_rate {
            let error = answer.expect_err("a split consumes its minimum frame duration");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_eq!(std::fs::read(f.file()).unwrap(), before);
        } else {
            answer.unwrap_or_else(|error| panic!("a sequence name is independent: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_timecodes_hold_drop_frame_but_tick_addresses_do_not() {
    for command in ["captions.add", "captions.setTimes"] {
        for timecode in [true, false] {
            let mut doc = FilmDocument::open(FILE, &project(1)).unwrap();
            doc.execute("sequence.settings", json!({"fps":29.97,"dropFrame":false})).unwrap();
            let caption = doc.execute("captions.add", json!({"text":"Original", "time":0,"durationSeconds":1})).unwrap()["caption"].clone();
            let f = Fixture::from_bytes(&doc.save(None).unwrap(), Default::default());
            let (_, basis) = f.inspect().await;
            f.colleague(&[("sequence.settings", json!({"dropFrame":true}))]);
            let params = if command == "captions.add" {
                if timecode { json!({"text":"New", "timecode":"00:01:01:00"}) } else { json!({"text":"New", "time":61*SECOND}) }
            } else if timecode {
                json!({"caption":caption,"startTimecode":"00:01:01:00","endTimecode":"00:01:02:00"})
            } else {
                json!({"caption":caption,"startTime":61*SECOND,"endTime":62*SECOND})
            };
            let before = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
            if timecode {
                let error = answer.expect_err("caption timecodes consume the sequence's drop-frame setting");
                assert_eq!(error["error"]["code"], "conflict", "{error}");
                assert_eq!(std::fs::read(f.file()).unwrap(), before);
            } else {
                answer.unwrap_or_else(|error| panic!("tick addresses are independent of drop-frame: {error}"));
            }
            f.shutdown().await;
        }
    }
}
