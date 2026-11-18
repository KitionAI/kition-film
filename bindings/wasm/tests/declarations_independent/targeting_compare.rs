//! Complete track-targeting comparisons from keyboard.rs:276-346 and
//! Session::targeting:1243-1256. Defaults read all lane identities; an explicit
//! targeting map narrows fixed toggles to one lane and source toggles to first.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under, Within};
use serde_json::json;

pub const COMMANDS: &[&str] = &[
    "timeline.toggleAllVideoTargets",
    "timeline.toggleAllAudioTargets",
    "timeline.toggleAllSourceVideo",
    "timeline.toggleAllSourceAudio",
    "timeline.moveVideoTargetsUp",
    "timeline.moveVideoTargetsDown",
    "timeline.moveAudioTargetsUp",
    "timeline.moveAudioTargetsDown",
    "timeline.toggleTargetV1",
    "timeline.toggleTargetV2",
    "timeline.toggleTargetV3",
    "timeline.toggleTargetV4",
    "timeline.toggleTargetV5",
    "timeline.toggleTargetV6",
    "timeline.toggleTargetV7",
    "timeline.toggleTargetV8",
    "timeline.toggleTargetA1",
    "timeline.toggleTargetA2",
    "timeline.toggleTargetA3",
    "timeline.toggleTargetA4",
    "timeline.toggleTargetA5",
    "timeline.toggleTargetA6",
    "timeline.toggleTargetA7",
    "timeline.toggleTargetA8",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    COMMANDS.contains(&command)
        && path == "editor targeting"
        && super::patches_compare::matches_source(
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/keyboard.rs")),
            "fn set_targeting(",
            "// ------------------------------------------------------------------ audio",
            0x8e06bf338e2f5819,
        )
        && super::patches_compare::matches_source(
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/lib.rs")),
            "    pub fn targeting(",
            "    /// The media source",
            0x13e2d14d426abbbb,
        )
}

#[test]
fn targeting_paths_compare_defaults_explicit_state_and_missing_lanes() {
    for tracks in [3, 8] {
        for explicit in [false, true] {
            let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
            if tracks == 8 {
                doc.execute("sequence.addTracks", json!({"video":5,"audio":5})).unwrap();
            }
            if explicit {
                doc.execute("timeline.setTargeting", json!({"track":"V2","targeted":true})).unwrap();
            }
            let sequence = doc.inspect().unwrap()["sequence"]["id"].clone();
            for &command in COMMANDS {
                assert!(compared_path(command, "editor targeting"));
                let kind = if command.contains("Audio") || command.contains("TargetA") { "audio" } else { "video" };
                let ordinal = command.strip_prefix("timeline.toggleTarget").and_then(|suffix| suffix.get(1..)).and_then(|n| n.parse::<usize>().ok());
                let mut expected = Under::default();
                let fields = if explicit { Vec::new() } else { vec!["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"] };
                if !fields.is_empty() {
                    expected.premises.push(Premise::on(sequence.clone()).fields(fields).positions(Vec::<String>::new()));
                }
                if ordinal.is_some() || command.contains("Source") {
                    let index = ordinal.unwrap_or(1) - 1;
                    expected.within.push(Within {
                        parent: sequence.clone(),
                        field: format!("sequence.{kind}Tracks"),
                        from: index,
                        to: index + 1,
                        ..Default::default()
                    });
                } else if explicit {
                    expected.premises.push(Premise::on(sequence.clone()).fields([format!("~{kind}TrackOrder")]).positions(Vec::<String>::new()));
                }
                assert_eq!(doc.under(command, &json!({})).unwrap().unwrap_or_default(), expected, "{command}/{tracks}/{explicit}");
                let declaration = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(declaration.enabled && declaration.mutates);
                assert_eq!(declaration.reads, [EditorState::Part, EditorState::Active]);
                assert!(declaration.targets.is_none() && declaration.objects.is_empty() && declaration.places.is_empty());
                assert!(declaration.object_types.is_empty() && declaration.name_params.is_empty());
                assert!(declaration.name_field.is_none() && declaration.index.is_none() && !declaration.index_numbers && !declaration.index_reversed);
            }
        }
    }
}
