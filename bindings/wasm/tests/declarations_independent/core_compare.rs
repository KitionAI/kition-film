//! Reviewed machine projections of the committed core/caption paths, pinned after review.
//! This is a verified lower-bound inventory, not an exhaustive declaration equivalence.
use super::effects_compare::BaselineGroup;

// Pinned after reviewing the transition branch: commands.rs::apply_transition
// reads targeting and transition preferences; core.rs retains its blind row.
// source placement: commands.rs:846-886,place_item_on:758-844 reads Source,
// target tracks, sequences_as_clips, media scaling and ripple-marker preferences.
// ReviewCorrection: the previous projection omitted timeline.place even though
// both original blind paths already list Mode/Active (core.rs:1006-1023).
// commands.rs:2230,2260-2299 reads patching/free-track choices; place_item_on
// :754-787 reads nest/scaling choices and still defaults at :2266-2273.
// commands.rs:1541-1552 -> with_links:194-205 and :1784-1797 read these
// timeline modes. The setters' unwrap_or expressions read the previous switch.
// ReviewCorrection: file.newSequence:943-1000 reads label/scaling/nest modes,
// but creates the destination before targeting, so its blind Active reading
// overstated old editor input. Its fromItem settings inheritance is direct media
// only (:943-945), while placement follows the media parent (:769-780).
pub const MODE_COMMANDS: &[&str] = &[
    "file.newSequence",
    "file.newSequenceFromClip",
    "effects.apply",
    "source.insert",
    "source.overwrite",
    "timeline.place",
    "clip.enable",
    "sequence.snap",
    "sequence.linkedSelection",
    "sequence.nestSequences",
];
// Pinned from the linked-selection source scan after declaration review; the
// blind rows remain unchanged. Direct roots: commands.rs:480-494 with callers
// :1383-1415,1510,1542,2321,2384,2507-2575,3291,3403; clip_ops.rs:1079,1113,
// 1771; mixer.rs:1084; audio_mixing.rs:34-44; keyboard.rs:133,160,209,249,
// 267,385. Session::set_playhead (lib.rs:1223-1230) conditionally delegates to
// sequence_tools.rs:252-257, so its callers also read the linked-selection mode.
// The scanner follows the remaining helper/command edges mechanically and fails
// if a new command reaches this mode without declaring it.
pub const LINKED_MODE_COMMANDS: &[&str] = &[
    "edit.cut",
    "edit.copy",
    "edit.paste",
    "edit.pasteInsert",
    "edit.pasteAttributes",
    "edit.removeAttributes",
    "edit.clear",
    "edit.rippleDelete",
    "edit.findNext",
    "clip.audioGain",
    "clip.speedDuration",
    "clip.audioPeak",
    "clip.nest",
    "sequence.reverseMatchFrame",
    "sequence.extract",
    "sequence.goToNextGap",
    "sequence.goToPrevGap",
    "sequence.goToNextGapInTrack",
    "sequence.goToPrevGapInTrack",
    "markers.goToIn",
    "markers.goToOut",
    "markers.goToSplitVideoIn",
    "markers.goToSplitVideoOut",
    "markers.goToSplitAudioIn",
    "markers.goToSplitAudioOut",
    "markers.goNext",
    "markers.goPrev",
    "playhead.set",
    "playhead.step",
    "playhead.stepForward",
    "playhead.stepBack",
    "playhead.stepForward5",
    "playhead.stepBack5",
    "playhead.nextEdit",
    "playhead.prevEdit",
    "playhead.start",
    "playhead.end",
    "clip.replaceFromSource",
    "clip.replaceFromSourceMatchFrame",
    "clip.replaceFromBin",
    "timeline.select",
    "timeline.move",
    "timeline.trim",
    "trim.tick",
    "timeline.slip",
    "timeline.slide",
    "timeline.rateStretch",
    "timeline.razor",
    "captions.goTo",
    "captions.next",
    "captions.previous",
    "audioMixing.inspect",
    "audioMixing.setType",
    "audioMixing.clearType",
    "audioMixing.set",
    "audioMixing.applyPreset",
    "audioMixing.savePreset",
    "audioMixing.autoMatch",
    "audioMixing.generateDucking",
    "graphics.selectNextGraphic",
    "graphics.selectPreviousGraphic",
    "transcript.select",
    "transcript.extract",
    "transcript.lift",
    "audio.bed",
    "playhead.nextEditAnyTrack",
    "playhead.prevEditAnyTrack",
    "playhead.selectedClipStart",
    "playhead.selectedClipEnd",
    "sequence.revealNested",
    "timeline.selectClipAtPlayhead",
    "timeline.selectNextClip",
    "timeline.selectPrevClip",
    "timeline.nudgeLeft",
    "timeline.nudgeRight",
    "timeline.nudgeLeft5",
    "timeline.nudgeRight5",
    "timeline.slipLeft",
    "timeline.slipRight",
    "timeline.slipLeft5",
    "timeline.slipRight5",
    "timeline.slideLeft",
    "timeline.slideRight",
    "timeline.slideLeft5",
    "timeline.slideRight5",
    "clip.volumeUp",
    "clip.volumeDown",
    "clip.volumeUpMany",
    "clip.volumeDownMany",
    "clip.nudgeVolumeUp1",
    "clip.nudgeVolumeUp3",
    "clip.nudgeVolumeDown1",
    "clip.nudgeVolumeDown3",
];

// Pinned from source tracing after declaration review, not blind rows.
// lib.rs:1237-1248 reads targeting; keyboard.rs:125-160,173-179,403-533 and
// sequence_tools.rs:254,285,310,376 consume it. Session::set_playhead delegates
// to targeted selection (lib.rs:1223-1230), so navigation callers read Active.
// Direct consumers include clip_ops.rs:1494,1526, voiceover.rs:265,
// transcript.rs:303 and project_tools.rs:1137. Fresh destinations are excluded:
// commands.rs:943-1000 and clip_ops.rs:661-714 create/open before targeting.
pub const TRACK_TARGET_ACTIVE_COMMANDS: &[&str] = &[
    "edit.paste",
    "edit.pasteInsert",
    "edit.findNext",
    "clip.frameHold",
    "clip.insertFrameHoldSegment",
    "clip.revealInProject",
    "sequence.addEdit",
    "sequence.applyVideoTransition",
    "sequence.applyAudioTransition",
    "sequence.lift",
    "sequence.extract",
    "sequence.goToNextGap",
    "sequence.goToPrevGap",
    "sequence.deleteTracks",
    "markers.markClip",
    "playhead.set",
    "playhead.step",
    "playhead.stepForward",
    "playhead.stepBack",
    "playhead.stepForward5",
    "playhead.stepBack5",
    "playhead.nextEdit",
    "playhead.prevEdit",
    "playhead.start",
    "playhead.end",
    "clip.automateToSequence",
    "trim.shuttle",
    "trim.shuttleStop",
    "trim.cancelDynamic",
    "trim.playAround",
    "trim.tick",
    "timeline.setTargeting",
    "captions.goTo",
    "captions.next",
    "captions.previous",
    "multicam.grid",
    "multicam.inspect",
    "graphics.selectNextGraphic",
    "graphics.selectPreviousGraphic",
    "transcript.select",
    "transcript.extract",
    "transcript.lift",
    "audio.voiceover.start",
    "playhead.nextEditAnyTrack",
    "playhead.prevEditAnyTrack",
    "playhead.selectedClipStart",
    "playhead.selectedClipEnd",
    "sequence.revealNested",
    "timeline.selectClipAtPlayhead",
    "timeline.selectNextClip",
    "timeline.selectPrevClip",
    "trim.extendPreviousEdit",
    "trim.extendNextEdit",
    "timeline.toggleAllVideoTargets",
    "timeline.toggleAllAudioTargets",
    "timeline.toggleAllSourceVideo",
    "timeline.toggleAllSourceAudio",
    "timeline.moveVideoTargetsUp",
    "timeline.moveVideoTargetsDown",
    "timeline.moveAudioTargetsUp",
    "timeline.moveAudioTargetsDown",
    "timeline.toggleMuteTargetedAudio",
    "timeline.toggleSoloTargetedAudio",
    "timeline.toggleOutputTargetedVideo",
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

pub const ACTIVE_COMMANDS: &[&str] = &["effects.apply", "source.insert", "source.overwrite", "timeline.place"];

pub const BASELINE_GROUPS: &[BaselineGroup] = &[
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "clip field patches omit owning-sequence eligibility",
        commands: &["edit.label", "clip.rename", "clip.enable"],
        proof: "commands.rs:1468-1502/1552-1562 resolves clips only in the active sequence. The original position-independent defaults and leaf profiles suppressed relocation when a clip departed that scope. issue-c8-film-read-r5-label-owners proves missing guard conflicts for explicit on/id calls while same-sequence video/audio track changes apply",
    },
    BaselineGroup {
        side: "less",
        kind: "sdk",
        class: "borrowed implicit selection discarded on file refresh",
        commands: &["edit.label", "edit.label.violet", "edit.label.blue"],
        proof: "pinned 10bd6f5 crates/kition-headless/src/lib.rs:1542-1555 reload replaces open.doc with self.read without transferring editor_state; binding lib.rs:282-290 opens a new Session. No-file controls and context.get assertions pass; independent file rewrites then lose the selection before under/execute, producing a no-op generic label or disabled palette command",
    },
    BaselineGroup {
        side: "less",
        kind: "engine",
        class: "malformed saved allocation counter aliases a live source or overflows",
        commands: &["file.newColorMatte"],
        proof: "project/src/lib.rs::alloc_id increments the saved counter and add_item inserts at that id; format/src/lib.rs::validate_loaded did not check the counter. Counter 8 overwrites the fixture's source; u64::MAX panics on addition. issue-c8-film-read-r5-id-counter proves both before load-boundary validation",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "editor state: Source monitor, selected mask, trim points and open tabs",
        commands: &[
            "clip.makeSubclip",
            "clip.replaceFromSource",
            "clip.replaceFromSourceMatchFrame",
            "edit.consolidateDuplicates",
            "edit.redo",
            "edit.removeUnused",
            "edit.undo",
            "file.close",
            "file.exportFrame",
            "file.save",
            "file.saveAll",
            "file.saveAs",
            "file.saveCopy",
            "masks.add",
            "masks.addVertex",
            "masks.moveVertex",
            "masks.remove",
            "masks.removeVertex",
            "masks.set",
            "masks.toggleVertexSmooth",
            "masks.track",
            "masks.translate",
            "project.delete",
            "project.setMarks",
            "sequence.close",
            "sequence.closeOthers",
            "sequence.moveTab",
            "sequence.open",
            "source.setPlayhead",
            "trim.applyDefaultTransition",
            "trim.backward",
            "trim.backwardMany",
            "trim.clear",
            "trim.extendToPlayhead",
            "trim.forward",
            "trim.forwardMany",
            "trim.nudge",
            "trim.selectEditPoint",
            "trim.toggleType",
        ],
        proof: "commands.rs:1651-1697/2184-2225/2981; masks.rs:128-142/226/317/621; trim.rs:86-113/339-365; clip_ops.rs:953/1027/1749-1797; lib.rs:982-994/1147-1180; keyboard.rs:528-550. Reviewed source contexts; raw blind rows remain unchanged. Fresh imported/simplified tabs and unused replacement playheads are excluded with separate caller proofs in acts.rs",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "eager Program playhead calculation unused by ordinary replacement",
        commands: &["clip.replaceFromSource", "clip.replaceFromBin"],
        proof: "clip_ops.rs:1775-1797 calculates Program/Source playheads before the variant match, but only MatchFrame consumes them; ordinary replacement preserves target start. issue-c8-film-read-r5-replacement-source proves false refusals for unrelated target start changes",
    },
    BaselineGroup {
        side: "less",
        kind: "engine",
        class: "live camera replay loses its original base when the caller changes undo scope",
        commands: &["multicam.recordStop"],
        proof: "kdm_bridge.rs:94-103 closes the merge key on an origin/scope switch; multicam.rs:894-902 uses the provisional project as its base when not merging. A person records camera 2 at 0.5s, then an agent stops at 1s: camera 2 incorrectly continues beyond 1s without any file change",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "editor state: restored timeline, marker and multicamera switches",
        commands: &["file.save", "file.saveAs", "file.saveCopy", "file.saveAll", "sequence.closeGap", "clip.automateToSequence"],
        proof: "commands.rs:3999-4002 -> lib.rs:982-994 serializes nest mode; commands.rs:1781 reads ripple markers; project_tools.rs:1221 calls place_item_on:754/837 (nest and ripple mode); scanner traces their callees, while the raw blind rows remain unchanged",
    },
    BaselineGroup {
        side: "less",
        kind: "engine",
        class: "equal split ranges discarded by the ordinary Source branch",
        commands: &["source.insert", "source.overwrite"],
        proof: "commands.rs:879-887 chose ordinary range/duration when vr == ar, even when both split ranges differed from that ordinary range; issue-c8-film-read-r5-equal-split demonstrates the wrong source-in before correction",
    },
    BaselineGroup {
        side: "less",
        kind: "engine",
        class: "flattened Source audio copies the video range and placement time",
        commands: &["source.insert", "source.overwrite"],
        proof: "commands.rs:869-886 computes independent audio range/time, but place_item_on:754-755 dropped audio_split before sequence_tools.rs:467-536 copied every kind using video range/time; issue-c8-film-read-r5-split-copy proves incorrect audio and the corresponding wrong range guard",
    },
    BaselineGroup {
        side: "less",
        kind: "sdk",
        class: "named session preset replaced by a built-in on file reread",
        commands: &["presets.apply"],
        proof: "bindings/wasm/src/lib.rs:285-292 creates a fresh host Session on open; presets.rs:109-116 selects the user definition before a built-in; the pinned SDK cannot carry session definitions across rereads",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "same-field protection: ripple suffix start assignments outside the point",
        commands: &["timeline.place"],
        proof: "commands.rs:place_item_on insert branch; edit/src/lib.rs:155-170 shift_track_from assigns suffix clip/transition starts; baseline holds only material under the point",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "sequence-from-selection inherits first parent timebase and placement geometry",
        commands: &["file.newSequenceFromClip"],
        proof: "clip_ops.rs:661-714 resolves media_root for first settings and every placement; blind effects.rs already lists source parents/settings",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "sequence-from-selection reads only a fresh destination part",
        commands: &["file.newSequenceFromClip"],
        proof: "clip_ops.rs:661-714 creates/opens the destination before targeting and placement; blind effects.rs Part/Active were overstated",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "new sequence placement reads indirect parent media",
        commands: &["file.newSequence"],
        proof: "commands.rs:943-1000,754-806;project/src/lib.rs:1599-1634; blind core.rs from-item path already names resolved media",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "new sequence whole source and newly assigned part",
        commands: &["file.newSequence"],
        proof: "commands.rs:943-1000; sequence destination and targeting are created before placement; marks/metadata unused, nest contents uncopied",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "local Boolean misread as a nesting operation",
        commands: &["sequence.nestSequences"],
        proof: "commands.rs:1792-1797 only reads sequences_as_clips; local nest is a Boolean, not commands::nest",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "nested placement implicit duration and copied identity",
        commands: &["timeline.place"],
        proof: "commands.rs:2232-2302;project/src/lib.rs:1503-1524;baseline premise.rs timeline.place branch lists duration as a position and omits name",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "nested source properties instead of copied label",
        commands: &["timeline.place"],
        proof: "commands.rs:2232-2302;project/src/lib.rs:1503-1524;baseline premise.rs timeline.place branch holds props including unused metadata",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "Source placement inputs outside positional target",
        commands: &["source.insert", "source.overwrite"],
        proof: "commands.rs:846-886,758-844; sequence_tools.rs:858-871; project/src/lib.rs:1503-1564",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "inherited sequence default",
        commands: &[
            "file.newAdjustmentLayer",
            "file.newBarsAndTone",
            "file.newBlackVideo",
            "file.newColorMatte",
            "file.newCountingLeader",
            "file.newTransparentVideo",
        ],
        proof: "commands.rs:584-596,1007-1074",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "resolved source bounds",
        commands: &["timeline.slip"],
        proof: "edit/src/lib.rs:779-788;engine/src/lib.rs:1308-1335",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "whole track instead of assigned fields",
        commands: &["timeline.setTrack"],
        proof: "commands.rs:2590-2632",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "caption eligibility lock",
        commands: &["captions.setText"],
        proof: "edit/src/captions.rs:18-23,125-136",
    },
    BaselineGroup {
        side: "less",
        kind: "declaration",
        class: "assigned caption-enabled fields",
        commands: &["captions.showAll", "captions.hideAll"],
        proof: "captions.rs:637-645",
    },
    BaselineGroup { side: "less", kind: "declaration", class: "clamping caption neighbour", commands: &["captions.add"], proof: "edit/src/captions.rs:43-55" },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "caption patch replaces less than held track",
        commands: &["captions.setTrack", "captions.setStyle"],
        proof: "captions.rs:330-418",
    },
    BaselineGroup {
        side: "more",
        kind: "declaration",
        class: "caption timing instead of unrelated text and track fields",
        commands: &["captions.setTimes", "captions.trim", "captions.move"],
        proof: "edit/src/captions.rs:139-219",
    },
];

#[test]
fn clip_field_commands_do_not_claim_unconditional_owner_independence() {
    use kition_kit::KitDocument;
    let doc = kition_film_kit::FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    // Reviewed qualification, not a blind-row edit: commands.rs:1468-1502
    // and 1552-1562 resolve clip ids only in the active sequence. Their temporal
    // fields are unused, but leaving that owning sequence changes eligibility.
    for id in ["edit.label", "clip.rename", "clip.enable"] {
        assert!(
            !doc.commands().iter().find(|command| command.id == id).unwrap().position_independent,
            "{id}: owner scope must remain a premise when context cannot be replayed"
        );
    }
}

#[test]
fn written_selections_and_all_track_razors_do_not_read_targeting() {
    use kition_kit::{EditorState, KitDocument};
    let doc = kition_film_kit::FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    // ReviewCorrection, not a blind-row edit: core.rs's nest and track-cut
    // rows overstate Active. commands.rs:3412-3571 reads Part/Selection and
    // linked-selection Mode, chooses lanes from the selected clips and occupied
    // spans, then ASSIGNS Project/timeline selections at :3567-3568. It does not
    // consume the old track-target map. commands.rs:2562-2607 resolves an explicit
    // track, or passes an empty set to edit/src/lib.rs:279-291 (all unlocked
    // tracks); the clip branch uses with_links, not targeting. These proofs do
    // not certify the commands' remaining facts or reduce unclassified paths.
    for id in ["clip.nest", "timeline.razor"] {
        let command = doc.commands().into_iter().find(|command| command.id == id).unwrap();
        assert!(!command.reads.contains(&EditorState::Active), "{id}: assigned selection and all-track defaults are not old targeting inputs");
        assert!(command.reads.contains(&EditorState::Mode), "{id}: linked-selection Mode remains an input");
    }
}
