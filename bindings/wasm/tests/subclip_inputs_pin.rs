//! C8-film-pin: Edit Subclip reads its parent's timebase or copies its media.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn edit_subclip_retains_parent_rate_for_frame_inputs_and_media_for_conversion() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let parent = doc.execute("item.newOfflineFile", json!({"seconds":3})).unwrap()["item"].clone();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":parent,"start":0,"end":254_016_000_000i64})).unwrap()["item"].clone();
    for convert in [false, true] {
        let under = doc.under("clip.editSubclip", &json!({"item":subclip,"startFrame":0,"endFrame":12,"convertToMaster":convert})).unwrap().unwrap();
        let need = under.premises.iter().find(|need| need.id == parent).expect("parent media premise");
        let fields = need.fields.as_ref().expect("scoped parent premise");
        assert!(fields.iter().any(|field| field == if convert { "props.media" } else { "props.media.interpret.frame_rate" }), "{under:?}");
    }
}
