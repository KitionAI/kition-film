//! Reviewed parameter-resolution checks; these do not certify other dependencies.
//! SDK context.rs accepts finite integral floats as integer parameters. Native
//! commands.rs:180-184,305-307,362-364 uses u64_p through item_p/clip_p; commands.rs:943,
//! 1501-1503,2174,2981 and clip_ops.rs:1421-1423 resolve those scalars that way.
//! presets.rs:440 and color.rs:177 do likewise. Arrays deliberately retain their
//! handler's strict as_u64 semantics. These are post-review rows, not blind ones.
//! Freeform project_panel.rs:603-612 uses item_p/bin_p for its scalar targets.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

#[test]
fn native_scalar_id_spellings_have_identical_premises() {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let source = doc.execute("file.newColorMatte", json!({"name":"Target","seconds":1})).unwrap()["item"].as_u64().unwrap();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V1","seconds":0})).unwrap()["clips"][0].as_u64().unwrap();
    let other = doc.execute("file.newColorMatte", json!({"name":"Other","seconds":1})).unwrap()["item"].as_u64().unwrap();
    let other_clip = doc.execute("timeline.place", json!({"item":other,"track":"V1","seconds":1})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("timeline.select", json!({"clips":[other_clip],"linked":false})).unwrap();
    let bin = doc.execute("file.newBin", json!({"name":"Another bin"})).unwrap()["bin"].as_u64().unwrap();
    let cases = [
        ("file.newSequence", "fromItem", source, json!({"name":"New"})),
        ("project.setMarks", "item", source, json!({"in":0})),
        ("project.matteColor", "item", source, json!({"color":"#000000"})),
        ("source.open", "item", source, json!({})),
        ("clip.rename", "clip", clip, json!({"name":"New"})),
        ("clip.rename", "item", source, json!({"name":"New"})),
        ("clip.setTimeInterpolation", "clip", clip, json!({"mode":"opticalFlow"})),
        ("clip.timeInterpolation.frameSampling", "clip", clip, json!({})),
        ("clip.timeInterpolation.frameBlending", "clip", clip, json!({})),
        ("clip.timeInterpolation.opticalFlow", "clip", clip, json!({})),
        ("presets.save", "clip", clip, json!({"name":"New"})),
        ("color.applyMatch", "clip", clip, json!({"referenceSeconds":1.5})),
        ("project.freeform.stack", "item", source, json!({})),
        ("project.freeform.unstack", "item", source, json!({})),
        ("project.freeform.alignToGrid", "bin", bin, json!({})),
        ("project.freeform.reset", "bin", bin, json!({})),
        ("project.freeform.saveArrangement", "bin", bin, json!({"name":"Layout"})),
        ("project.freeform.restoreArrangement", "bin", bin, json!({"name":"Layout"})),
        ("project.freeform.deleteArrangement", "bin", bin, json!({"name":"Layout"})),
    ];
    let mut differences = Vec::new();
    for (command, parameter, id, mut params) in cases {
        let declaration = doc.commands().into_iter().find(|c| c.id == command).unwrap();
        assert!(declaration.schema.as_ref().and_then(|schema| schema.get(parameter)).is_some(), "{command}/{parameter} must be a public parameter");
        params[parameter] = json!(id);
        let integer = serde_json::to_value(doc.under(command, &params).unwrap()).unwrap();
        params[parameter] = json!(id as f64);
        let floating = serde_json::to_value(doc.under(command, &params).unwrap()).unwrap();
        if integer != floating {
            differences.push(format!("{command}/{parameter}: integer={integer}, floating={floating}"));
        }
        assert!(integer != Value::Null, "the exact target must have an explicit premise: {command}");
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}
