//! C8-film-pin: a frame hold is snapped in the source timebase.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn frame_hold_options_retains_source_timebase_and_timecode_origin() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let source = doc.execute("file.newOfflineFile", json!({"seconds":3})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    for mode in ["in", "out", "playhead", "sequenceTime", "sourceTimecode"] {
        let under = doc.under("clip.frameHoldOptions", &json!({"clips":[clip],"holdOn":mode,"timecode":"00:00:00:01"})).unwrap().unwrap();
        let need = under.premises.iter().find(|need| need.id == source).expect("source timebase premise");
        let fields = need.fields.as_ref().expect("scoped source fields");
        assert!(fields.iter().any(|field| field == "props.media.interpret.frame_rate"), "{mode}: {under:?}");
        assert!(fields.iter().any(|field| field == "props.media.info.video.frame_rate"), "{mode}: {under:?}");
        if mode == "sourceTimecode" {
            assert!(fields.iter().any(|field| field == "props.media.info.start_timecode"), "{mode}: {under:?}");
        }
    }
}
