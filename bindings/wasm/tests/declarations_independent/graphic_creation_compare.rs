//! graphics.rs:86-165,589-625; graphic_templates.rs:315-345,834-921.
//! Creation reads lane occupancy for the full new duration and reuses a
//! non-shared Graphic source. Unedited source instances cannot propagate.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] = &[
    ("graphics.newText", "new clip placement"),
    ("graphics.newVerticalText", "new clip placement"),
    ("graphics.newShape", "new clip placement"),
    ("graphics.newRectangle", "new clip placement"),
    ("graphics.newEllipse", "new clip placement"),
    ("graphics.newPolygon", "new clip placement"),
    ("graphics.template.apply", "new clip placement"),
    ("graphics.newPolygon", "sides supplied"),
    ("graphics.selectNextGraphic", "editor navigation"),
    ("graphics.selectPreviousGraphic", "editor navigation"),
    ("graphics.template.apply", "named template and controls"),
    ("graphics.upgradeCaption", "selected IDs or point"),
    ("graphics.selectNextGraphic", "post-dispatch existing source graphics"),
    ("graphics.selectPreviousGraphic", "post-dispatch existing source graphics"),
    ("graphics.template.apply", "post-dispatch existing source graphics"),
    ("graphics.upgradeCaption", "post-dispatch existing source graphics"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/graphics.rs")) == 0xaf7908925300a7a2
        && hash(include_str!("../../../../crates/engine/engine/src/graphic_templates.rs")) == 0xecaafa1b22c3dc65
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command.contains("select") {
        vec!["whole-graphic-navigation-sequence", "coarse-selection-state", "coarse-mode-state", "coarse-active-state"]
    } else {
        vec!["whole-graphic-placement-geometry", "all-graphic-source-candidates", "whole-source-graphic-registry", "whole-caption-upgrade-profile"]
    }
}
fn leaf(id: Value, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}
fn expected(p: &Project, seq: u64, command: &str) -> Under {
    let q = p.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    if command.contains("select") {
        want.premises.push(leaf(json!(seq), ["sequence"]));
        for c in q.video_tracks.iter().flat_map(|t| &t.items) {
            want.premises.push(leaf(json!(c.item.0), ["kind"]));
        }
        return want;
    }
    want.premises.push(leaf(
        json!(seq),
        ["sequence.settings.settings.width", "sequence.settings.settings.height", "sequence.settings.settings.frame_rate", "~videoTrackOrder"],
    ));
    want.premises.push(leaf(json!("project"), ["~itemIds", "docState.source_graphics"]));
    for item in p.items.values() {
        want.premises.push(leaf(json!(item.id.0), ["kind", "props.width", "props.height", "props.rate"]));
    }
    for track in &q.video_tracks {
        want.premises.push(leaf(json!(track.id.0), ["props.locked", "~clipOrder"]));
        for clip in &track.items {
            want.premises.push(leaf(json!(clip.id.0), ["item"]).positions(["start", "duration"]));
            want.premises.push(leaf(json!(clip.item.0), ["kind"]));
        }
    }
    if command == "graphics.upgradeCaption" {
        want.premises.push(leaf(json!(seq), ["sequence.captionTracks"]));
    }
    want
}
#[test]
fn graphic_creations_compare_duration_occupancy_source_reuse_caption_styles_and_post_dispatch() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let matte = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":matte,"track":"V1","time":0})).unwrap();
    let graphic = doc.execute("graphics.newText", json!({"newClip":true,"time":2_540_160_000_000i64,"text":"Shared"})).unwrap()["clip"].clone();
    doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":graphic})).unwrap();
    doc.execute("captions.newTrack", json!({})).unwrap();
    let caption = doc.execute("captions.add", json!({"time":0,"text":"Caption","durationSeconds":1})).unwrap()["caption"].clone();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for time in [0, 254_016_000_000i64, 1_270_080_000_000i64] {
        doc.execute("playhead.set", json!({"time":time})).unwrap();
        doc.execute("timeline.select", json!({"clips":[],"linked":false})).unwrap();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path));
            for extra in [json!({}), json!({"track":0,"time":0,"seconds":3}), json!({"track":2,"frame":12,"sides":7}), json!({"captions":[caption]})] {
                let mut params = extra;
                if matches!(command, "graphics.newText" | "graphics.newVerticalText") {
                    params["newClip"] = json!(true);
                }
                assert_eq!(
                    normalized(doc.under(command, &params).unwrap().unwrap()),
                    normalized(expected(&project, seq, command)),
                    "{command}/{path}/{params}"
                );
            }
        }
    }
    // These navigation dispatches must not nominate an unchanged source master.
    for command in ["graphics.selectNextGraphic", "graphics.selectPreviousGraphic"] {
        let mut branch = doc.fork_for_premises().unwrap();
        branch.execute(command, json!({})).unwrap();
        let after = kition_film_format::decode(&branch.save(None).unwrap()).unwrap().project;
        assert_eq!(serde_json::to_value(&after.source_graphics).unwrap(), serde_json::to_value(&project.source_graphics).unwrap());
        assert_eq!(serde_json::to_value(&after.items).unwrap(), serde_json::to_value(&project.items).unwrap());
    }
}
