//! Machine projections of the committed blind effects readings, pinned after declaration review.
//! The baseline is 446de07. Groups record verified path differences, not a complete audit of
//! every path of the effects family. Membership was checked against handlers and operations;
//! no blind row or comparison equivalence was changed to agree with a declaration.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

// Pinned from graphic layer selection and eligibility reads, not from the
// declaration: graphics.rs:75,446-449,631-649,823; keyboard.rs:424-496.
// This also exposes omissions in the original raw editor column. Those blind
// rows stay intact; these reviewed requirements are reported separately.
pub const GRAPHIC_LAYER_ACTIVE: &[&str] = &[
    "graphics.align",
    "graphics.alignFrame.bottom",
    "graphics.alignFrame.hcenter",
    "graphics.alignFrame.left",
    "graphics.alignFrame.right",
    "graphics.alignFrame.top",
    "graphics.alignFrame.vcenter",
    "graphics.alignGroup.bottom",
    "graphics.alignGroup.hcenter",
    "graphics.alignGroup.left",
    "graphics.alignGroup.right",
    "graphics.alignGroup.top",
    "graphics.alignGroup.vcenter",
    "graphics.alignSelection.bottom",
    "graphics.alignSelection.hcenter",
    "graphics.alignSelection.left",
    "graphics.alignSelection.right",
    "graphics.alignSelection.top",
    "graphics.alignSelection.vcenter",
    "graphics.alignTextCenter",
    "graphics.alignTextLeft",
    "graphics.alignTextRight",
    "graphics.arrangeLayer",
    "graphics.bringForward",
    "graphics.bringToFront",
    "graphics.deleteLayer",
    "graphics.distribute",
    "graphics.distributeHorizontally",
    "graphics.distributeSpaceHorizontally",
    "graphics.distributeSpaceVertically",
    "graphics.distributeVertically",
    "graphics.fontSizeDown",
    "graphics.fontSizeDown5",
    "graphics.fontSizeUp",
    "graphics.fontSizeUp5",
    "graphics.leadingDown",
    "graphics.leadingDown5",
    "graphics.leadingUp",
    "graphics.leadingUp5",
    "graphics.newPolygon",
    "graphics.nudgeDown",
    "graphics.nudgeDown5",
    "graphics.nudgeLeft",
    "graphics.nudgeLeft5",
    "graphics.nudgeRight",
    "graphics.nudgeRight5",
    "graphics.nudgeUp",
    "graphics.nudgeUp5",
    "graphics.pin",
    "graphics.resetAllParameters",
    "graphics.selectNextLayer",
    "graphics.selectPreviousLayer",
    "graphics.sendBackward",
    "graphics.sendToBack",
    "graphics.set",
    "graphics.setCharStyle",
    "graphics.setText",
    "graphics.setTextType",
];

// Pinned from commands.rs:3750-3770 and mixer.rs:140-141,284,1148-1161;
// this is reviewed source tracing, not an additional blind reading.
pub const TRANSITION_MIXER_MODE: &[&str] = &[
    "clipMixer.touch",
    "effects.setDefaultTransition",
    "mixer.inspect",
    "mixer.recordStart",
    "mixer.setValue",
    "mixer.touch",
    "sequence.applyAudioTransition",
    "sequence.applyVideoTransition",
];

#[derive(Debug)]
pub struct BaselineGroup {
    pub side: &'static str,
    pub kind: &'static str,
    pub class: &'static str,
    pub commands: &'static [&'static str],
    pub proof: &'static str,
}

// Historical baseline classifications; fixes are tested separately below and headless.
pub const BASELINE_GROUPS: &[BaselineGroup] = &[
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "implicit replacement source name and label copied without a source hold",
        commands: &["clip.replaceFromSource", "clip.replaceFromSourceMatchFrame", "clip.replaceFromBin"],
        proof: "clip_ops.rs:1749-1767 resolves Source or the first eligible Project item; 1803-1805 copies that item's name and label. issue-c8-film-read-r5-replacement-source rewrites each copied field independently and proves all three commands accepted it before correction",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "replacement holds unrelated target effects that the handler preserves",
        commands: &["clip.replaceFromSource", "clip.replaceFromSourceMatchFrame", "clip.replaceFromBin"],
        proof: "clip_ops.rs:1784-1812 replaces item/name/label/source-in/hold/multicam/audio mapping, preserves effects and unrelated target properties. issue-c8-film-read-r5-replacement-source proves false refusals for target opacity before correction",
    },
    BaselineGroup {
        side: "less",
        kind: "engine",
        class: "unrelated source graphics reconciled after dispatch",
        commands: &[
            "graphics.align",
            "graphics.alignFrame.bottom",
            "graphics.alignFrame.hcenter",
            "graphics.alignFrame.left",
            "graphics.alignFrame.right",
            "graphics.alignFrame.top",
            "graphics.alignFrame.vcenter",
            "graphics.alignGroup.bottom",
            "graphics.alignGroup.hcenter",
            "graphics.alignGroup.left",
            "graphics.alignGroup.right",
            "graphics.alignGroup.top",
            "graphics.alignGroup.vcenter",
            "graphics.alignSelection.bottom",
            "graphics.alignSelection.hcenter",
            "graphics.alignSelection.left",
            "graphics.alignSelection.right",
            "graphics.alignSelection.top",
            "graphics.alignSelection.vcenter",
            "graphics.arrangeLayer",
            "graphics.bringForward",
            "graphics.bringToFront",
            "graphics.deleteLayer",
            "graphics.distribute",
            "graphics.distributeHorizontally",
            "graphics.distributeSpaceHorizontally",
            "graphics.distributeSpaceVertically",
            "graphics.distributeVertically",
            "graphics.newEllipse",
            "graphics.newFromFile",
            "graphics.newPolygon",
            "graphics.newRectangle",
            "graphics.newShape",
            "graphics.newText",
            "graphics.newVerticalText",
            "graphics.pin",
            "graphics.resetAllParameters",
            "graphics.resetDuration",
            "graphics.selectLayer",
            "graphics.selectNextGraphic",
            "graphics.selectNextLayer",
            "graphics.selectPreviousGraphic",
            "graphics.selectPreviousLayer",
            "graphics.sendBackward",
            "graphics.sendToBack",
            "graphics.set",
            "graphics.setCharStyle",
            "graphics.setResponsiveTime",
            "graphics.setRoll",
            "graphics.setText",
            "graphics.setTextType",
            "graphics.template.apply",
            "graphics.template.export",
            "graphics.template.install",
            "graphics.template.remove",
            "graphics.template.set",
            "graphics.upgradeCaption",
            "graphics.upgradeToSourceGraphic",
        ],
        proof: "engine/src/lib.rs:903; engine/src/graphic_templates.rs:936",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "source item eligibility unheld",
        commands: &[
            "graphics.align",
            "graphics.alignFrame.bottom",
            "graphics.alignFrame.hcenter",
            "graphics.alignFrame.left",
            "graphics.alignFrame.right",
            "graphics.alignFrame.top",
            "graphics.alignFrame.vcenter",
            "graphics.alignGroup.bottom",
            "graphics.alignGroup.hcenter",
            "graphics.alignGroup.left",
            "graphics.alignGroup.right",
            "graphics.alignGroup.top",
            "graphics.alignGroup.vcenter",
            "graphics.alignSelection.bottom",
            "graphics.alignSelection.hcenter",
            "graphics.alignSelection.left",
            "graphics.alignSelection.right",
            "graphics.alignSelection.top",
            "graphics.alignSelection.vcenter",
            "graphics.arrangeLayer",
            "graphics.bringForward",
            "graphics.bringToFront",
            "graphics.deleteLayer",
            "graphics.distribute",
            "graphics.distributeHorizontally",
            "graphics.distributeSpaceHorizontally",
            "graphics.distributeSpaceVertically",
            "graphics.distributeVertically",
            "graphics.newEllipse",
            "graphics.newPolygon",
            "graphics.newRectangle",
            "graphics.newShape",
            "graphics.newText",
            "graphics.newVerticalText",
            "graphics.pin",
            "graphics.resetAllParameters",
            "graphics.resetDuration",
            "graphics.selectLayer",
            "graphics.sendBackward",
            "graphics.sendToBack",
            "graphics.set",
            "graphics.setCharStyle",
            "graphics.setResponsiveTime",
            "graphics.setRoll",
            "graphics.setText",
            "graphics.setTextType",
            "graphics.template.export",
            "graphics.template.set",
            "graphics.upgradeToSourceGraphic",
        ],
        proof: "engine/src/graphics.rs:40-59; engine/src/premise.rs baseline has no graphics branches",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "source/frame dimensions or media input unheld",
        commands: &[
            "masks.add",
            "masks.addVertex",
            "masks.moveVertex",
            "masks.removeVertex",
            "masks.set",
            "masks.toggleVertexSmooth",
            "masks.track",
            "masks.translate",
        ],
        proof: "engine/src/masks.rs:175-231,580-726",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "linked partner omitted",
        commands: &[
            "edit.pasteAttributes",
            "edit.removeAttributes",
            "clip.audioGain",
            "audioMixing.setType",
            "audioMixing.clearType",
            "audioMixing.set",
            "audioMixing.applyPreset",
            "audioMixing.savePreset",
            "audioMixing.autoMatch",
            "audioMixing.generateDucking",
        ],
        proof: "engine/src/clip_ops.rs:1079,1113; mixer.rs:1079; audio_mixing.rs:34-46",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "rendered reference unheld",
        commands: &["color.applyMatch"],
        proof: "engine/src/color.rs:436-460",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "LUT string resolves external document value",
        commands: &["color.setInputLut", "color.setLook", "lut.import", "lut.remove"],
        proof: "engine/src/color.rs:100-170,208-220",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "global font read/write omitted",
        commands: &["file.replaceFonts"],
        proof: "engine/src/graphic_templates.rs:1040; baseline no targets/part/time/under",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "dependent strips omitted",
        commands: &["mixer.deleteSubmix"],
        proof: "engine/src/mixer.rs:716-737; wasm/src/lib.rs mixer early return",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "sample-rate default omitted",
        commands: &["mixer.writeAutomation"],
        proof: "engine/src/mixer.rs:1000-1015; wasm/src/lib.rs mixer early return",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "source/frame dimension defaults omitted",
        commands: &["clip.fitToFrame", "clip.fillFrame", "edit.removeAttributes"],
        proof: "engine/src/clip_ops.rs:1115-1132,1589-1624",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole graphic clip vs graphic operation",
        commands: &[
            "graphics.align",
            "graphics.alignFrame.bottom",
            "graphics.alignFrame.hcenter",
            "graphics.alignFrame.left",
            "graphics.alignFrame.right",
            "graphics.alignFrame.top",
            "graphics.alignFrame.vcenter",
            "graphics.alignGroup.bottom",
            "graphics.alignGroup.hcenter",
            "graphics.alignGroup.left",
            "graphics.alignGroup.right",
            "graphics.alignGroup.top",
            "graphics.alignGroup.vcenter",
            "graphics.alignSelection.bottom",
            "graphics.alignSelection.hcenter",
            "graphics.alignSelection.left",
            "graphics.alignSelection.right",
            "graphics.alignSelection.top",
            "graphics.alignSelection.vcenter",
            "graphics.arrangeLayer",
            "graphics.bringForward",
            "graphics.bringToFront",
            "graphics.deleteLayer",
            "graphics.distribute",
            "graphics.distributeHorizontally",
            "graphics.distributeSpaceHorizontally",
            "graphics.distributeSpaceVertically",
            "graphics.distributeVertically",
            "graphics.newEllipse",
            "graphics.newPolygon",
            "graphics.newRectangle",
            "graphics.newShape",
            "graphics.newText",
            "graphics.newVerticalText",
            "graphics.pin",
            "graphics.resetAllParameters",
            "graphics.resetDuration",
            "graphics.selectLayer",
            "graphics.sendBackward",
            "graphics.sendToBack",
            "graphics.set",
            "graphics.setCharStyle",
            "graphics.setResponsiveTime",
            "graphics.setRoll",
            "graphics.setText",
            "graphics.setTextType",
            "graphics.template.export",
            "graphics.template.set",
            "graphics.upgradeToSourceGraphic",
        ],
        proof: "wasm/src/acts.rs targets; wasm/src/lib.rs under by_id default; graphics handlers ignore clip enabled",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole mask target vs mask leaves",
        commands: &[
            "masks.add",
            "masks.addVertex",
            "masks.moveVertex",
            "masks.remove",
            "masks.removeVertex",
            "masks.set",
            "masks.toggleVertexSmooth",
            "masks.track",
            "masks.translate",
        ],
        proof: "engine/src/masks.rs:205-470; baseline no masks premises",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole mixer strip vs mixer leaves",
        commands: &[
            "mixer.setStrip",
            "mixer.setValue",
            "mixer.release",
            "mixer.addInsert",
            "mixer.removeInsert",
            "mixer.setInsert",
            "mixer.addSend",
            "mixer.setSend",
            "mixer.removeSend",
            "mixer.setKeyframe",
            "mixer.deleteKeyframe",
            "mixer.moveKeyframe",
            "mixer.clearLane",
            "mixer.writeAutomation",
        ],
        proof: "wasm/src/lib.rs:457-474; engine/src/mixer.rs:632-1015",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole clip vs assigned metadata fields",
        commands: &[
            "edit.label.blue",
            "edit.label.brown",
            "edit.label.caribbean",
            "edit.label.cerulean",
            "edit.label.forest",
            "edit.label.green",
            "edit.label.iris",
            "edit.label.lavender",
            "edit.label.magenta",
            "edit.label.mango",
            "edit.label.purple",
            "edit.label.rose",
            "edit.label.tan",
            "edit.label.teal",
            "edit.label.violet",
            "edit.label.yellow",
            "clip.fieldOptions",
            "clip.setTimeInterpolation",
            "clip.timeInterpolation.frameSampling",
            "clip.timeInterpolation.frameBlending",
            "clip.timeInterpolation.opticalFlow",
        ],
        proof: "engine/src/clip_ops.rs:881,1554-1587; baseline no branches",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole clip vs motion assignment",
        commands: &["clip.fitToFrame", "clip.fillFrame"],
        proof: "engine/src/clip_ops.rs:1589-1624; baseline no branches",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole clip vs colour operation",
        commands: &["color.setInputLut", "color.setLook", "color.setSection", "color.applyPreset", "color.applyMatch"],
        proof: "engine/src/color.rs:172-253,370-396,436-480; baseline no branches",
    },
];

// lib.rs invokes reconciliation for every successful journaled graphics.* command.
// This includes the keyboard family outside effects.rs; keep the scopes distinct.
pub const BASELINE_GRAPHICS_DISPATCH: &[&str] = &[
    "graphics.align",
    "graphics.alignFrame.bottom",
    "graphics.alignFrame.hcenter",
    "graphics.alignFrame.left",
    "graphics.alignFrame.right",
    "graphics.alignFrame.top",
    "graphics.alignFrame.vcenter",
    "graphics.alignGroup.bottom",
    "graphics.alignGroup.hcenter",
    "graphics.alignGroup.left",
    "graphics.alignGroup.right",
    "graphics.alignGroup.top",
    "graphics.alignGroup.vcenter",
    "graphics.alignSelection.bottom",
    "graphics.alignSelection.hcenter",
    "graphics.alignSelection.left",
    "graphics.alignSelection.right",
    "graphics.alignSelection.top",
    "graphics.alignSelection.vcenter",
    "graphics.alignTextCenter",
    "graphics.alignTextLeft",
    "graphics.alignTextRight",
    "graphics.arrangeLayer",
    "graphics.bringForward",
    "graphics.bringToFront",
    "graphics.deleteLayer",
    "graphics.distribute",
    "graphics.distributeHorizontally",
    "graphics.distributeSpaceHorizontally",
    "graphics.distributeSpaceVertically",
    "graphics.distributeVertically",
    "graphics.fontSizeDown",
    "graphics.fontSizeDown5",
    "graphics.fontSizeUp",
    "graphics.fontSizeUp5",
    "graphics.leadingDown",
    "graphics.leadingDown5",
    "graphics.leadingUp",
    "graphics.leadingUp5",
    "graphics.newEllipse",
    "graphics.newFromFile",
    "graphics.newPolygon",
    "graphics.newRectangle",
    "graphics.newShape",
    "graphics.newText",
    "graphics.newVerticalText",
    "graphics.nudgeDown",
    "graphics.nudgeDown5",
    "graphics.nudgeLeft",
    "graphics.nudgeLeft5",
    "graphics.nudgeRight",
    "graphics.nudgeRight5",
    "graphics.nudgeUp",
    "graphics.nudgeUp5",
    "graphics.pin",
    "graphics.resetAllParameters",
    "graphics.resetDuration",
    "graphics.selectLayer",
    "graphics.selectNextGraphic",
    "graphics.selectNextLayer",
    "graphics.selectPreviousGraphic",
    "graphics.selectPreviousLayer",
    "graphics.sendBackward",
    "graphics.sendToBack",
    "graphics.set",
    "graphics.setCharStyle",
    "graphics.setResponsiveTime",
    "graphics.setRoll",
    "graphics.setText",
    "graphics.setTextType",
    "graphics.template.apply",
    "graphics.template.export",
    "graphics.template.install",
    "graphics.template.remove",
    "graphics.template.set",
    "graphics.upgradeCaption",
    "graphics.upgradeToSourceGraphic",
];

#[test]
fn reviewed_effects_groups_name_registered_blind_paths() {
    use std::collections::BTreeSet;
    let specs = kition_film_engine::command_specs();
    for group in BASELINE_GROUPS {
        assert!(!group.proof.is_empty());
        for command in group.commands {
            assert!(super::effects::ROWS.iter().any(|row| row.command == *command && row.blind), "{command}: {group:?}");
            assert!(specs.iter().any(|spec| spec.id == *command && spec.journal), "{command}: {group:?}");
        }
    }
    let actual: BTreeSet<_> = specs.iter().filter(|spec| spec.journal && spec.id.starts_with("graphics.")).map(|spec| spec.id).collect();
    assert_eq!(actual, BASELINE_GRAPHICS_DISPATCH.iter().copied().collect());
    let held = |side| BASELINE_GROUPS.iter().filter(|group| group.side == side).flat_map(|group| group.commands.iter().copied()).collect::<BTreeSet<_>>();
    let less = held("less");
    let more = held("more");
    println!(
        "VERIFIED BASELINE effects scope={} less={} more={} differing={} (lower bounds; not every path compared)",
        super::effects::ROWS.iter().map(|row| row.command).collect::<BTreeSet<_>>().len(),
        less.len(),
        more.len(),
        less.union(&more).count()
    );
}

#[test]
fn mask_projection_matches_the_committed_source_and_mapping_reading() {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let source = doc.execute("file.newColorMatte", json!({"color":"#557799","seconds":1})).unwrap()["item"].as_u64().unwrap();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    // Reviewed correction, not a blind-row edit: the original fixture had neither
    // fitting nor a mask. render/src/lib.rs:338-363 consumes sequence dimensions
    // for fitting/default position; placement resolves position. Exercise the
    // fitting branch with an actual addressed mask (masks.rs:206-243).
    doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
    doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
    doc.execute("masks.add", json!({"clip":clip,"shape":"ellipse"})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    for command in ["masks.add", "masks.set", "masks.moveVertex", "masks.translate", "masks.addVertex", "masks.removeVertex", "masks.toggleVertexSmooth"] {
        let held = doc.under(command, &json!({"clip":clip,"effect":"opacity","mask":0})).unwrap().expect("geometry premises");
        let target = held.premises.iter().find(|premise| premise.id == json!(clip)).expect("target mapping premise");
        let wanted = ["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"];
        assert_eq!(target.fields.as_deref(), Some(wanted.map(str::to_owned).as_slice()), "{command}: {held:?}");
        assert_eq!(target.positions.as_deref(), Some(["start".to_owned(), "duration".to_owned()].as_slice()), "{command}");
        for (id, fields) in [
            (source, ["props.media.info.video.width", "props.media.info.video.height"]),
            (sequence, ["sequence.settings.settings.width", "sequence.settings.settings.height"]),
        ] {
            let premise = held.premises.iter().find(|premise| premise.id == json!(id)).expect("dimension premise");
            assert_eq!(premise.fields.as_deref(), Some(fields.map(str::to_owned).as_slice()), "{command}: {held:?}");
        }
    }
    let held = doc.under("masks.remove", &json!({"clip":clip,"effect":"opacity","mask":0})).unwrap().expect("remove premise");
    let target = held.premises.iter().find(|premise| premise.id == json!(clip)).unwrap();
    assert_eq!(target.fields.as_deref(), Some(["effects".to_owned()].as_slice()));
    assert_eq!(target.positions.as_deref(), Some([].as_slice()));
}

#[test]
fn submix_routing_projection_holds_relative_eligibility_instead_of_absolute_indices() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let ids: Vec<_> = (0..5).map(|i| doc.execute("mixer.addSubmix", json!({"name":format!("Bus {i}")})).unwrap()["id"].as_u64().unwrap()).collect();
    let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    let mut permutations = Vec::new();
    fn permute(order: &mut [usize], at: usize, out: &mut Vec<Vec<usize>>) {
        if at == order.len() {
            out.push(order.to_vec());
            return;
        }
        for i in at..order.len() {
            order.swap(at, i);
            permute(order, at + 1, out);
            order.swap(at, i);
        }
    }
    permute(&mut [0, 1, 2, 3, 4], 0, &mut permutations);
    for order in permutations {
        let mut project = loaded.project.clone();
        let q = project.sequence_mut(kition_film_engine::project::ItemId(sequence)).unwrap();
        let original = q.submix_tracks.clone();
        q.submix_tracks = order.iter().map(|i| original[*i].clone()).collect();
        let doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&project, false)).unwrap();
        let values = doc.derived(&[json!(sequence)], &["mixerRoutes".into()]).unwrap();
        let facts = values.iter().find(|values| values.id == sequence).and_then(|values| values.values.get("mixerRoutes")).cloned().unwrap_or_default();
        for (from, source) in ids.iter().enumerate() {
            for (to, target) in ids.iter().enumerate() {
                let source_index = order.iter().position(|i| *i == from).unwrap();
                let target_index = order.iter().position(|i| *i == to).unwrap();
                let key = format!("{source}_{target}");
                assert_eq!(facts[&key], json!(source_index < target_index), "{order:?}/{key}");
            }
        }
        for command in ["mixer.setStrip", "mixer.addSend", "mixer.setSend"] {
            let params = if command == "mixer.setStrip" { json!({"strip":ids[0],"output":ids[2]}) } else { json!({"strip":ids[0],"target":ids[2],"send":0}) };
            let under = doc.under(command, &params).unwrap().unwrap();
            assert!(under.objects.is_empty(), "stable numeric strip ids are not Program places: {command}/{under:?}");
            assert!(under.premises.iter().all(|premise| premise.positions.as_ref().is_some_and(Vec::is_empty)), "{command}/{under:?}");
            let scoped = format!("fact:{sequence}:~mixerRoutes.{}_{}", ids[0], ids[2]);
            let held = under.premises.iter().find(|premise| premise.id == scoped).unwrap_or_else(|| panic!("{command}/{under:?}"));
            assert_eq!(held.fields.as_deref(), Some(["value".to_owned()].as_slice()));
            let objects = doc.projected_objects().unwrap();
            let fact = objects.iter().find(|object| object.id == scoped).unwrap();
            assert_eq!(fact.fields["value"], facts[format!("{}_{}", ids[0], ids[2])], "{order:?}/{command}");
        }
    }
    // The fallback must be explicit and bounded rather than constructing a
    // quadratic matrix for an untrusted number of mixer strips.
    let mut large = loaded.project;
    for i in 0..65 {
        let track = kition_film_engine::project::Track::new(
            kition_film_engine::project::TrackId(large.alloc_id()),
            kition_film_engine::project::TrackKind::Audio,
            format!("Extra {i}"),
        );
        large.sequence_mut(kition_film_engine::project::ItemId(sequence)).unwrap().submix_tracks.push(track);
    }
    let doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&large, false)).unwrap();
    let values = doc.derived(&[json!(sequence)], &["mixerRoutes".into()]).unwrap();
    assert!(values.iter().find(|values| values.id == sequence).unwrap().values["mixerRoutes"].is_null());
    let held = doc.under("mixer.addSend", &json!({"strip":ids[0],"target":ids[2]})).unwrap().unwrap();
    for id in [ids[0], ids[2]] {
        assert!(
            held.premises
                .iter()
                .any(|premise| premise.id == id && premise.positions.as_ref().is_some_and(|positions| positions.contains(&"sequence.submixTracks".into()))),
            "large graph fallback {id}: {held:?}"
        );
    }
}
