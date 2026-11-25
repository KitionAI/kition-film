//! Complete existing-graphic resolver and document-scope comparisons.
//! Expected scopes follow graphics::{target_clip,layer_effect_index,layer_boxes},
//! graphic_templates::{pin_layer,set_char_style,upgrade_to_source,sync_source_graphics}.
//! Whole-target and whole-layer profiles deliberately retain known MORE facts.
//! ReviewCorrection: graphic_templates.rs:945-955 now skips instances unchanged
//! by this dispatch; the historical blind post-dispatch rows retain the old
//! global reconciliation reading. Only edited sources can propagate today.
use std::collections::{BTreeMap, BTreeSet};

use kition_film_engine::project::{ItemId, ItemKind, Project, TrackItem};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const COMMANDS: &[(&str, &str)] = &[
    ("graphics.setText", "text layer edit"),
    ("graphics.set", "property edit"),
    ("graphics.setTextType", "point/paragraph"),
    ("graphics.deleteLayer", "index/default"),
    ("graphics.arrangeLayer", "paint order"),
    ("graphics.bringToFront", "paint order"),
    ("graphics.bringForward", "paint order"),
    ("graphics.sendBackward", "paint order"),
    ("graphics.sendToBack", "paint order"),
    ("graphics.align", "evaluated layer bounds"),
    ("graphics.alignFrame.left", "evaluated layer bounds"),
    ("graphics.alignFrame.hcenter", "evaluated layer bounds"),
    ("graphics.alignFrame.right", "evaluated layer bounds"),
    ("graphics.alignFrame.top", "evaluated layer bounds"),
    ("graphics.alignFrame.vcenter", "evaluated layer bounds"),
    ("graphics.alignFrame.bottom", "evaluated layer bounds"),
    ("graphics.alignGroup.left", "evaluated layer bounds"),
    ("graphics.alignGroup.hcenter", "evaluated layer bounds"),
    ("graphics.alignGroup.right", "evaluated layer bounds"),
    ("graphics.alignGroup.top", "evaluated layer bounds"),
    ("graphics.alignGroup.vcenter", "evaluated layer bounds"),
    ("graphics.alignGroup.bottom", "evaluated layer bounds"),
    ("graphics.alignSelection.left", "evaluated layer bounds"),
    ("graphics.alignSelection.hcenter", "evaluated layer bounds"),
    ("graphics.alignSelection.right", "evaluated layer bounds"),
    ("graphics.alignSelection.top", "evaluated layer bounds"),
    ("graphics.alignSelection.vcenter", "evaluated layer bounds"),
    ("graphics.alignSelection.bottom", "evaluated layer bounds"),
    ("graphics.distribute", "evaluated layer bounds"),
    ("graphics.distributeVertically", "evaluated layer bounds"),
    ("graphics.distributeSpaceVertically", "evaluated layer bounds"),
    ("graphics.distributeHorizontally", "evaluated layer bounds"),
    ("graphics.distributeSpaceHorizontally", "evaluated layer bounds"),
    ("graphics.resetAllParameters", "layers/default all"),
    ("graphics.resetDuration", "next clip limit"),
    ("graphics.selectLayer", "editor selection"),
    ("graphics.selectNextLayer", "editor navigation"),
    ("graphics.selectPreviousLayer", "editor navigation"),
    ("graphics.pin", "frame/layer/none pin"),
    ("graphics.setCharStyle", "character range"),
    ("graphics.upgradeToSourceGraphic", "source item creation"),
];

pub const POST_DISPATCH: &str = "post-dispatch existing source graphics";
pub const NEW_LAYERS: &[&str] =
    &["graphics.newText", "graphics.newVerticalText", "graphics.newShape", "graphics.newRectangle", "graphics.newEllipse", "graphics.newPolygon"];

pub fn compared_path(command: &str, path: &str) -> bool {
    if !COMMANDS.iter().any(|&(id, regular)| id == command && (path == regular || path == POST_DISPATCH))
        && !(NEW_LAYERS.contains(&command) && matches!(path, "existing graphic target" | POST_DISPATCH))
    {
        return false;
    }
    let graphics = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/graphics.rs"));
    let templates = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/graphic_templates.rs"));
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    hash(graphics) == 0xaf7908925300a7a2 && hash(templates) == 0xc21099df4545af4a
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    if NEW_LAYERS.contains(&command) {
        let mut classes = vec!["whole-graphic-target", "coarse-source-profile", "graphic-layer-profile", "coarse-time-state"];
        if matches!(command, "graphics.newText" | "graphics.newVerticalText") {
            classes.push("coarse-mode-state");
        }
        if command == "graphics.newPolygon" {
            classes.push("coarse-active-state");
        }
        if path == POST_DISPATCH {
            classes.push("unconsumed-graphic-peer-fields");
        }
        return classes;
    }
    let mut classes = vec!["coarse-selection-state", "graphic-layer-profile"];
    if command != "graphics.setText" {
        classes.extend(["whole-graphic-target", "coarse-source-profile"]);
    }
    if !matches!(command, "graphics.resetDuration" | "graphics.selectLayer" | "graphics.upgradeToSourceGraphic") {
        classes.push("coarse-active-state");
    }
    if path == POST_DISPATCH {
        classes.push("unconsumed-graphic-peer-fields");
    }
    classes
}

pub(super) fn fixture(shared: bool) -> (FilmDocument, u64, u64, u64, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let first = doc.execute("graphics.newText", json!({"newClip":true,"track":0,"time":0,"text":"First"})).unwrap()["clip"].as_u64().unwrap();
    for text in ["Second", "Third"] {
        doc.execute("graphics.newText", json!({"clip":first,"text":text})).unwrap();
    }
    if shared {
        let source = doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":first})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":source,"track":"V1","seconds":10,"duration":254_016_000_000i64})).unwrap();
    }
    let other = doc.execute("graphics.newText", json!({"newClip":true,"track":1,"time":0,"text":"Other"})).unwrap()["clip"].as_u64().unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    let ordinary = doc.execute("timeline.place", json!({"item":item,"track":"V3","seconds":0})).unwrap()["clips"][0].as_u64().unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    (doc, first, other, ordinary, sequence)
}

fn clips(project: &Project) -> impl Iterator<Item = &TrackItem> {
    project.sequences().filter_map(|item| project.sequence(item.id)).flat_map(|sequence| &sequence.video_tracks).flat_map(|track| &track.items)
}

fn add(expected: &mut BTreeMap<String, Premise>, premise: Premise) {
    let key = premise.id.to_string();
    if let Some(previous) = expected.get_mut(&key) {
        for (held, more) in [(&mut previous.fields, premise.fields), (&mut previous.positions, premise.positions)] {
            if let (Some(held), Some(more)) = (held.as_mut(), &more) {
                held.extend(more.iter().cloned());
            } else {
                *held = None;
            }
        }
    } else {
        expected.insert(key, premise);
    }
}

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

pub(super) fn expected(project: &Project, command: &str, target: u64, sequence: u64, selected: &[u64], explicit: bool) -> Under {
    let mut expected = BTreeMap::new();
    let target = clips(project).find(|clip| clip.id.0 == target).unwrap();
    let source = target.item;
    add(
        &mut expected,
        leaf(
            source.0,
            if command == "graphics.setText" {
                &["kind"]
            } else {
                &["kind", "props.media", "props.parent", "props.range", "props.restrict_trims", "props.width", "props.height", "props.rate", "sequence"]
            },
        ),
    );
    add(&mut expected, leaf(source.0, &["~sourceGraphic"]));
    if !explicit {
        for id in selected {
            let clip = clips(project).find(|clip| clip.id.0 == *id).unwrap();
            add(&mut expected, leaf(*id, &["item"]));
            add(&mut expected, leaf(clip.item.0, &["kind"]));
        }
    }
    if command != "graphics.setText" {
        add(&mut expected, Premise::on(json!(target.id.0)));
    }
    for clip in clips(project).filter(|clip| clip.id == target.id || (project.source_graphics.contains_key(&source) && clip.item == source)) {
        let mut fields = vec!["item".to_owned(), "props.graphic".to_owned()];
        fields.extend(
            clip.effects
                .iter()
                .enumerate()
                .filter(|(_, effect)| matches!(effect.effect.as_str(), "graphic_text" | "graphic_shape"))
                .map(|(index, _)| format!("effects.{index}")),
        );
        add(&mut expected, Premise::on(json!(clip.id.0)).fields(fields).positions(Vec::<String>::new()));
    }
    add(&mut expected, leaf(target.id.0, &["sourceIn", "speed", "reverse", "props.frame_hold"]));
    add(&mut expected, Premise::on(json!(target.id.0)).fields(Vec::<String>::new()).positions(["start", "duration"]));
    if command.contains("align") || command.contains("distribute") || command.starts_with("graphics.new") || command == "graphics.resetAllParameters" {
        add(&mut expected, leaf(sequence, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
    }
    if command == "graphics.resetDuration" {
        add(&mut expected, leaf(sequence, &["sequence.settings.settings.frame_rate"]));
        add(&mut expected, Premise::on(json!(format!("fact:{}:~followingClip", target.id.0))).fields(["value"]).positions(Vec::<String>::new()));
    }
    Under { premises: expected.into_values().collect(), ..Default::default() }
}

#[test]
fn new_layer_paths_compare_existing_targets_all_shapes_text_defaults_and_shared_recipients() {
    // graphics.rs:173-190 inserts after the last graphic layer, so layer order
    // is read but existing parameter values are preserved. graphics.rs:699 and
    // 671-674 delegate text/shape variants without adding other project inputs.
    for shared in [false, true] {
        let (mut doc, first, other, ordinary, sequence) = fixture(shared);
        for selected in [vec![], vec![ordinary], vec![other, first]] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for &command in NEW_LAYERS {
                assert!(compared_path(command, "existing graphic target") && compared_path(command, POST_DISPATCH));
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                let text = matches!(command, "graphics.newText" | "graphics.newVerticalText");
                assert_eq!(
                    spec.reads,
                    if text {
                        vec![EditorState::Part, EditorState::Time, EditorState::Mode]
                    } else if command == "graphics.newPolygon" {
                        vec![EditorState::Part, EditorState::Time, EditorState::Active]
                    } else {
                        vec![EditorState::Part, EditorState::Time]
                    }
                );
                assert!(spec.enabled && spec.mutates && spec.objects.is_empty());
                assert_eq!(spec.targets, Some("clip"));
                assert_eq!(spec.object_types, [("clip", &["Clip"][..])]);
                assert_eq!(
                    spec.places,
                    if matches!(command, "graphics.newRectangle" | "graphics.newEllipse") {
                        vec![]
                    } else {
                        vec!["track", "time", "seconds", "frame", "timecode"]
                    }
                );
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                for clip in [first, other] {
                    for shape in ["rectangle", "ellipse", "polygon", "path"] {
                        for explicit_geometry in [false, true] {
                            let mut params = json!({"clip":clip,"shape":shape,"text":"Assigned text","newClip":false});
                            if explicit_geometry {
                                params["position"] = json!([10, 20]);
                                params["size"] = if text { json!(32) } else { json!([80, 40]) };
                                params["box"] = json!([100, 50]);
                                params["font"] = json!("Assigned font");
                                params["fontStyle"] = json!("Bold");
                                params["points"] = json!([[0, 0], [20, 0], [20, 20]]);
                                params["sides"] = json!(5);
                            }
                            assert_eq!(
                                normalize(doc.under(command, &params).unwrap().unwrap()),
                                normalize(expected(&project, command, clip, sequence, &selected, true)),
                                "{command}/{params}/selection={selected:?}/shared={shared}"
                            );
                        }
                    }
                }
            }
        }
    }
}

fn normalize(mut under: Under) -> Under {
    for premise in &mut under.premises {
        for fields in [&mut premise.fields, &mut premise.positions].into_iter().flatten() {
            *fields = fields.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
        }
    }
    under.premises.sort_by_key(|premise| premise.id.to_string());
    under
}

#[test]
fn existing_graphic_paths_compare_explicit_selected_and_point_targets_with_shared_peers() {
    for shared in [false, true] {
        let (mut doc, first, other, ordinary, sequence) = fixture(shared);
        for selected in [vec![], vec![ordinary, first, other], vec![other, first]] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            doc.execute("graphics.selectLayer", json!({"layers":[0,1,2],"keepSelection":true})).unwrap();
            let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
            let project = &loaded.project;
            let specs = doc.commands();
            for &(command, path) in COMMANDS {
                assert!(compared_path(command, path) && compared_path(command, POST_DISPATCH), "review expired: {command}");
                let spec = specs.iter().find(|spec| spec.id == command).unwrap();
                let active = !matches!(command, "graphics.resetDuration" | "graphics.selectLayer" | "graphics.upgradeToSourceGraphic");
                let mut reads = vec![EditorState::Part, EditorState::Selection, EditorState::Time];
                if active {
                    reads.push(EditorState::Active);
                }
                assert_eq!(spec.reads, reads, "{command}");
                assert!(spec.enabled && spec.mutates, "{command}");
                let accepts_clip = !matches!(command, "graphics.selectNextLayer" | "graphics.selectPreviousLayer");
                assert_eq!(spec.targets, accepts_clip.then_some("clip"), "{command}");
                assert!(spec.objects.is_empty() && spec.places.is_empty() && spec.name_params.is_empty(), "{command}");
                assert_eq!(spec.object_types, if accepts_clip { vec![("clip", &["Clip"][..])] } else { vec![] }, "{command}");
                assert!(spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed, "{command}");
                for explicit in [None, Some(first), Some(other)].into_iter().filter(|value| accepts_clip || value.is_none()) {
                    let target = explicit.unwrap_or_else(|| selected.iter().copied().find(|id| *id == first || *id == other).unwrap_or(other));
                    for layer in [Value::Null, json!(0), json!(2), json!("First")] {
                        let mut params = json!({"layer":layer,"layers":[0,1,2],"text":"Assigned","props":{"position":[5,6]},"to":"frame","type":"paragraph","seconds":7,"style":{"font":"Example"}});
                        if let Some(id) = explicit {
                            params["clip"] = json!(id);
                        }
                        let held = doc.under(command, &params).unwrap().unwrap();
                        let expected = expected(project, command, target, sequence, &selected, explicit.is_some());
                        assert_eq!(normalize(held), normalize(expected), "{command}/{params}/{selected:?}/shared={shared}");
                    }
                }
            }
            let sources: BTreeSet<ItemId> = clips(project).filter(|clip| clip.id.0 == first || clip.id.0 == other).map(|clip| clip.item).collect();
            for source in sources {
                assert!(matches!(project.item(source).unwrap().kind, ItemKind::Graphic { .. }));
                let actual = doc.derived(&[json!(source.0)], &["sourceGraphic".into()]).unwrap();
                let held = actual.iter().find(|values| values.id == source.0).unwrap();
                let expected = project
                    .source_graphics
                    .get(&source)
                    .map(|definition| {
                        let recipients: BTreeSet<_> = clips(project).filter(|clip| clip.item == source).map(|clip| clip.id.0).collect();
                        json!({"definition":definition,"recipients":recipients})
                    })
                    .unwrap_or(Value::Null);
                assert_eq!(held.values["sourceGraphic"], expected);
            }
        }
    }
}
