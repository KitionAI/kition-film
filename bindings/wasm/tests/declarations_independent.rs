//! C8-film-read: independent expected handler dependencies, committed before declaration review.
//! Each row records a distinct code path. Assigned fields participate in same-field protection.
//! `blind` identifies readings made without opening declarations or their tests.
#![allow(dead_code)]

#[derive(Debug)]
pub struct Row {
    pub command: &'static str,
    pub path: &'static str,
    pub resolves: &'static str,
    pub reads: &'static str,
    pub editor: &'static str,
    pub writes: &'static str,
    pub proof: &'static str,
    pub blind: bool,
}

#[path = "declarations_independent/analysis_compare.rs"]
mod analysis_compare;
#[path = "declarations_independent/attributes_replace_compare.rs"]
mod attributes_replace_compare;
#[path = "declarations_independent/blocked_compare.rs"]
mod blocked_compare;
#[path = "declarations_independent/camera_compare.rs"]
mod camera_compare;
#[path = "declarations_independent/caption_creation_compare.rs"]
mod caption_creation_compare;
#[path = "declarations_independent/caption_navigation_compare.rs"]
mod caption_navigation_compare;
#[path = "declarations_independent/captions_compare.rs"]
mod captions_compare;
#[path = "declarations_independent/channels_compare.rs"]
mod channels_compare;
#[path = "declarations_independent/clip_fields_compare.rs"]
mod clip_fields_compare;
#[path = "declarations_independent/clipboard_compare.rs"]
mod clipboard_compare;
#[path = "declarations_independent/closing_compare.rs"]
mod closing_compare;
#[path = "declarations_independent/color_compare.rs"]
mod color_compare;
#[path = "declarations_independent/composites_compare.rs"]
mod composites_compare;
#[path = "declarations_independent/core.rs"]
mod core;
#[path = "declarations_independent/core_compare.rs"]
mod core_compare;
#[path = "declarations_independent/cuts_compare.rs"]
mod cuts_compare;
#[path = "declarations_independent/direct_edits_compare.rs"]
mod direct_edits_compare;
#[path = "declarations_independent/direct_media_compare.rs"]
mod direct_media_compare;
#[path = "declarations_independent/direct_move_compare.rs"]
mod direct_move_compare;
#[path = "declarations_independent/editor_compare.rs"]
mod editor_compare;
#[path = "declarations_independent/frame_hold_compare.rs"]
mod frame_hold_compare;
#[path = "declarations_independent/frame_lookup_compare.rs"]
mod frame_lookup_compare;
#[path = "declarations_independent/gap_paths_compare.rs"]
mod gap_paths_compare;
#[path = "declarations_independent/generators_compare.rs"]
mod generators_compare;
#[path = "declarations_independent/geometry_commands_compare.rs"]
mod geometry_commands_compare;
#[path = "declarations_independent/graphic_creation_compare.rs"]
mod graphic_creation_compare;
#[path = "declarations_independent/graphic_metadata_compare.rs"]
mod graphic_metadata_compare;
#[path = "declarations_independent/graphics_compare.rs"]
mod graphics_compare;
#[path = "declarations_independent/history_cache_compare.rs"]
mod history_cache_compare;
#[path = "declarations_independent/items_compare.rs"]
mod items_compare;
#[path = "declarations_independent/joins_compare.rs"]
mod joins_compare;
#[path = "declarations_independent/labels_compare.rs"]
mod labels_compare;
#[path = "declarations_independent/layout_compare.rs"]
mod layout_compare;
#[path = "declarations_independent/lifecycle_compare.rs"]
mod lifecycle_compare;
#[path = "declarations_independent/marker_paths_compare.rs"]
mod marker_paths_compare;
#[path = "declarations_independent/marker_writes_compare.rs"]
mod marker_writes_compare;
#[path = "declarations_independent/marks_compare.rs"]
mod marks_compare;
#[path = "declarations_independent/masks_compare.rs"]
mod masks_compare;
#[path = "declarations_independent/media_targets_compare.rs"]
mod media_targets_compare;
#[path = "declarations_independent/metadata_compare.rs"]
mod metadata_compare;
#[path = "declarations_independent/mixer_paths_compare.rs"]
mod mixer_paths_compare;
#[path = "declarations_independent/mixer_recording_compare.rs"]
mod mixer_recording_compare;
#[path = "declarations_independent/moves_compare.rs"]
mod moves_compare;
#[path = "declarations_independent/navigation_compare.rs"]
mod navigation_compare;
#[path = "declarations_independent/nest_flatten_compare.rs"]
mod nest_flatten_compare;
#[path = "declarations_independent/new_sequence_compare.rs"]
mod new_sequence_compare;
#[path = "declarations_independent/nudges_compare.rs"]
mod nudges_compare;
#[path = "declarations_independent/numeric_compare.rs"]
mod numeric_compare;
#[path = "declarations_independent/parameters_compare.rs"]
mod parameters_compare;
#[path = "declarations_independent/patches_compare.rs"]
mod patches_compare;
#[path = "declarations_independent/placement_compare.rs"]
mod placement_compare;
#[path = "declarations_independent/project_identity_compare.rs"]
mod project_identity_compare;
#[path = "declarations_independent/project_management_compare.rs"]
mod project_management_compare;
#[path = "declarations_independent/project_queries_compare.rs"]
mod project_queries_compare;
#[path = "declarations_independent/project_sources_compare.rs"]
mod project_sources_compare;
#[path = "declarations_independent/range_gap_compare.rs"]
mod range_gap_compare;
#[path = "declarations_independent/remaining_compare.rs"]
mod remaining_compare;
#[path = "declarations_independent/render_fonts_compare.rs"]
mod render_fonts_compare;
#[path = "declarations_independent/root_actions_compare.rs"]
mod root_actions_compare;
#[path = "declarations_independent/search_paths_compare.rs"]
mod search_paths_compare;
#[path = "declarations_independent/selection_steps_compare.rs"]
mod selection_steps_compare;
#[path = "declarations_independent/sequence_copies_compare.rs"]
mod sequence_copies_compare;
#[path = "declarations_independent/sequences_compare.rs"]
mod sequences_compare;
#[path = "declarations_independent/services_compare.rs"]
mod services_compare;
#[path = "declarations_independent/settings_compare.rs"]
mod settings_compare;
#[path = "declarations_independent/slip_paths_compare.rs"]
mod slip_paths_compare;
#[path = "declarations_independent/sound_paths_compare.rs"]
mod sound_paths_compare;
#[path = "declarations_independent/source_inputs_compare.rs"]
mod source_inputs_compare;
#[path = "declarations_independent/subclip_edit_compare.rs"]
mod subclip_edit_compare;
#[path = "declarations_independent/sync_compare.rs"]
mod sync_compare;
#[path = "declarations_independent/targeting_compare.rs"]
mod targeting_compare;
#[path = "declarations_independent/track_flags_compare.rs"]
mod track_flags_compare;
#[path = "declarations_independent/track_layout_compare.rs"]
mod track_layout_compare;
#[path = "declarations_independent/track_transition_compare.rs"]
mod track_transition_compare;
#[path = "declarations_independent/transcript_paths_compare.rs"]
mod transcript_paths_compare;
#[path = "declarations_independent/transition_creation_compare.rs"]
mod transition_creation_compare;
#[path = "declarations_independent/trim_edits_compare.rs"]
mod trim_edits_compare;
#[path = "declarations_independent/trim_paths_compare.rs"]
mod trim_paths_compare;
#[path = "declarations_independent/typography_compare.rs"]
mod typography_compare;
#[path = "declarations_independent/unavailable_compare.rs"]
mod unavailable_compare;
#[path = "declarations_independent/volume_compare.rs"]
mod volume_compare;

pub fn reviewed_editor_reads(id: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    if core_compare::MODE_COMMANDS.contains(&id)
        || core_compare::LINKED_MODE_COMMANDS.contains(&id)
        || media_compare::MODE_COMMANDS.contains(&id)
        || sequences_compare::MODE_COMMANDS.contains(&id)
        || effects_compare::TRANSITION_MIXER_MODE.contains(&id)
        || services_compare::PATHS.iter().any(|&(command, _)| command == id)
    {
        out.push("mode");
    }
    if core_compare::ACTIVE_COMMANDS.contains(&id)
        || core_compare::TRACK_TARGET_ACTIVE_COMMANDS.contains(&id)
        || media_compare::ACTIVE_COMMANDS.contains(&id)
        || sequences_compare::ACTIVE_COMMANDS.contains(&id)
        || effects_compare::GRAPHIC_LAYER_ACTIVE.contains(&id)
    {
        out.push("active");
    }
    out
}

#[test]
fn reviewed_editor_readings_are_declared() {
    use kition_kit::KitDocument;
    let doc = kition_film_kit::FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    for command in doc.commands() {
        for expected in reviewed_editor_reads(&command.id) {
            assert!(command.reads.iter().any(|state| state.as_str() == expected), "{}: missing {expected}", command.id);
        }
    }
}
#[path = "declarations_independent/effects.rs"]
mod effects;
#[path = "declarations_independent/effects_compare.rs"]
mod effects_compare;
#[path = "declarations_independent/media.rs"]
mod media;
#[path = "declarations_independent/media_compare.rs"]
mod media_compare;
#[path = "declarations_independent/sequences.rs"]
mod sequences;

fn rows() -> impl Iterator<Item = &'static Row> {
    core::ROWS.iter().chain(effects::ROWS).chain(media::ROWS).chain(sequences::ROWS)
}

#[test]
fn independent_core_rows_name_registered_handlers() {
    let specs = kition_film_engine::command_specs();
    let unregistered: Vec<_> = rows().filter(|row| !specs.iter().any(|spec| spec.id == row.command)).map(|row| row.command).collect();
    // sequence_extras.rs:40 defines this handler. project_tools.rs:210 puts it
    // in the pool, but its splice layout omits it. Keep its blind paths detached.
    assert_eq!(unregistered, ["sequence.applyDefaultTransitionsToSelection"; 2]);
    for row in rows() {
        assert!(row.blind && !row.reads.is_empty() && !row.writes.is_empty() && !row.proof.is_empty(), "incomplete {row:?}");
    }
}

#[test]
fn every_registered_write_has_an_independent_row() {
    let missing: Vec<_> =
        kition_film_engine::command_specs().iter().filter(|spec| spec.journal && !rows().any(|row| row.command == spec.id)).map(|spec| spec.id).collect();
    assert!(missing.is_empty(), "missing blind readings: {missing:?}");
    println!(
        "READING rows={} unique={} registered-writes={}",
        rows().count(),
        rows().map(|r| r.command).collect::<std::collections::BTreeSet<_>>().len(),
        kition_film_engine::command_specs().iter().filter(|s| s.journal).count()
    );
}

#[test]
fn unclassified_path_ceiling_cannot_grow() {
    let registered: std::collections::BTreeSet<_> = kition_film_engine::command_specs().iter().filter(|spec| spec.journal).map(|spec| spec.id).collect();
    let mut compared = 0;
    let mut unknown = 0;
    for row in rows().filter(|row| registered.contains(row.command)) {
        if patches_compare::compared_path(row.command, row.path)
            || generators_compare::compared_path(row.command, row.path)
            || targeting_compare::compared_path(row.command, row.path)
            || labels_compare::compared_path(row.command, row.path)
            || clip_fields_compare::compared_path(row.command, row.path)
            || editor_compare::compared_path(row.command, row.path)
            || graphics_compare::compared_path(row.command, row.path)
            || services_compare::compared_path(row.command, row.path)
            || marks_compare::compared_path(row.command, row.path)
            || sync_compare::compared_path(row.command, row.path)
            || layout_compare::compared_path(row.command, row.path)
            || metadata_compare::compared_path(row.command, row.path)
            || parameters_compare::compared_path(row.command, row.path)
            || masks_compare::compared_path(row.command, row.path)
            || color_compare::compared_path(row.command, row.path)
            || settings_compare::compared_path(row.command, row.path)
            || captions_compare::compared_path(row.command, row.path)
            || blocked_compare::compared_path(row.command, row.path)
            || caption_navigation_compare::compared_path(row.command, row.path)
            || typography_compare::compared_path(row.command, row.path)
            || unavailable_compare::compared_path(row.command, row.path)
            || nudges_compare::compared_path(row.command, row.path)
            || items_compare::compared_path(row.command, row.path)
            || closing_compare::compared_path(row.command, row.path)
            || navigation_compare::compared_path(row.command, row.path)
            || marker_paths_compare::compared_path(row.command, row.path)
            || marker_writes_compare::compared_path(row.command, row.path)
            || lifecycle_compare::compared_path(row.command, row.path)
            || camera_compare::compared_path(row.command, row.path)
            || track_layout_compare::compared_path(row.command, row.path)
            || track_flags_compare::compared_path(row.command, row.path)
            || volume_compare::compared_path(row.command, row.path)
            || source_inputs_compare::compared_path(row.command, row.path)
            || mixer_paths_compare::compared_path(row.command, row.path)
            || gap_paths_compare::compared_path(row.command, row.path)
            || project_identity_compare::compared_path(row.command, row.path)
            || sound_paths_compare::compared_path(row.command, row.path)
            || search_paths_compare::compared_path(row.command, row.path)
            || slip_paths_compare::compared_path(row.command, row.path)
            || mixer_recording_compare::compared_path(row.command, row.path)
            || trim_paths_compare::compared_path(row.command, row.path)
            || transcript_paths_compare::compared_path(row.command, row.path)
            || trim_edits_compare::compared_path(row.command, row.path)
            || selection_steps_compare::compared_path(row.command, row.path)
            || caption_creation_compare::compared_path(row.command, row.path)
            || new_sequence_compare::compared_path(row.command, row.path)
            || moves_compare::compared_path(row.command, row.path)
            || direct_media_compare::compared_path(row.command, row.path)
            || history_cache_compare::compared_path(row.command, row.path)
            || frame_hold_compare::compared_path(row.command, row.path)
            || subclip_edit_compare::compared_path(row.command, row.path)
            || attributes_replace_compare::compared_path(row.command, row.path)
            || sequence_copies_compare::compared_path(row.command, row.path)
            || render_fonts_compare::compared_path(row.command, row.path)
            || project_queries_compare::compared_path(row.command, row.path)
            || root_actions_compare::compared_path(row.command, row.path)
            || graphic_metadata_compare::compared_path(row.command, row.path)
            || channels_compare::compared_path(row.command, row.path)
            || media_targets_compare::compared_path(row.command, row.path)
            || nest_flatten_compare::compared_path(row.command, row.path)
            || cuts_compare::compared_path(row.command, row.path)
            || direct_edits_compare::compared_path(row.command, row.path)
            || remaining_compare::compared_path(row.command, row.path)
        {
            compared += 1;
        } else {
            unknown += 1;
        }
    }
    assert_eq!(
        compared,
        patches_compare::COMPARED_PATHS.len()
            + generators_compare::COMPARED_PATHS.len()
            + targeting_compare::COMMANDS.len()
            + labels_compare::COMMANDS.len()
            + clip_fields_compare::PATHS.len()
            + editor_compare::PATHS.len()
            + 2 * graphics_compare::COMMANDS.len()
            + 2 * graphics_compare::NEW_LAYERS.len()
            + services_compare::PATHS.len()
            + marks_compare::PATHS.len()
            + sync_compare::COMMANDS.len() * sync_compare::METHODS.len()
            + layout_compare::PATHS.len()
            + metadata_compare::PATHS.len()
            + parameters_compare::PATHS.len()
            + masks_compare::PATHS.len()
            + color_compare::PATHS.len()
            + settings_compare::PATHS.len()
            + captions_compare::PATHS.len()
            + blocked_compare::PATHS.len()
            + caption_navigation_compare::PATHS.len()
            + typography_compare::COMMANDS.len()
            + unavailable_compare::PATHS.len()
            + 2 * nudges_compare::COMMANDS.len()
            + items_compare::PATHS.len()
            + closing_compare::PATHS.len()
            + navigation_compare::COMMANDS.len()
            + marker_paths_compare::PATHS.len()
            + marker_writes_compare::PATHS.len()
            + lifecycle_compare::PATHS.len()
            + camera_compare::PATH_COUNT
            + track_layout_compare::PATHS.len()
            + track_flags_compare::COMMANDS.len()
            + volume_compare::COMMANDS.len()
            + source_inputs_compare::PATHS.len()
            + mixer_paths_compare::PATHS.len()
            + gap_paths_compare::PATHS.len()
            + project_identity_compare::PATHS.len()
            + sound_paths_compare::PATHS.len()
            + search_paths_compare::PATHS.len()
            + slip_paths_compare::PATHS.len()
            + mixer_recording_compare::PATHS.len()
            + trim_paths_compare::PATHS.len()
            + transcript_paths_compare::PATHS.len()
            + trim_edits_compare::COMMANDS.len() * trim_edits_compare::KINDS.len()
            + selection_steps_compare::PATHS.len()
            + caption_creation_compare::PATHS.len()
            + new_sequence_compare::PATHS.len()
            + moves_compare::PATHS.len()
            + direct_media_compare::PATHS.len()
            + history_cache_compare::PATHS.len()
            + frame_hold_compare::PATHS.len()
            + subclip_edit_compare::PATHS.len()
            + attributes_replace_compare::PATHS.len()
            + sequence_copies_compare::PATHS.len()
            + render_fonts_compare::PATHS.len()
            + project_queries_compare::PATHS.len()
            + root_actions_compare::PATHS.len()
            + graphic_metadata_compare::PATHS.len()
            + channels_compare::PATHS.len()
            + media_targets_compare::PATHS.len()
            + nest_flatten_compare::PATHS.len()
            + cuts_compare::PATHS.len()
            + direct_edits_compare::PATHS.len()
            + remaining_compare::count(),
        "each complete comparison must name exactly one original path"
    );
    // Only decrease this ceiling when a path's landing, result dependencies,
    // assigned fields and eligibility have a complete parameterized comparison.
    // Representative projections and historical lower bounds do not certify it.
    assert_eq!(unknown, 0, "unclassified write paths grew to {unknown}; compare new paths instead of raising the ceiling");
    println!("PATH_COMPARISON compared={compared} unclassified={unknown}");
}

/// Unknown paths count against all three ceilings. Certification can only
/// remove uncertainty; a known conservative hold never vanishes from the gate.
#[test]
fn current_path_difference_bounds_can_only_decrease() {
    use std::collections::BTreeMap;
    let registered: std::collections::BTreeSet<_> = kition_film_engine::command_specs().iter().filter(|spec| spec.journal).map(|spec| spec.id).collect();
    let mut unknown = 0;
    let mut more = 0;
    let mut editor_more = 0;
    let mut graphics_more = 0;
    let mut graphics_new_more = 0;
    let mut services_more = 0;
    let mut reset_more = 0;
    let mut settings_more = 0;
    let mut marks_more = 0;
    let mut sync_more = 0;
    let mut layout_more = 0;
    let mut metadata_more = 0;
    let mut parameters_more = 0;
    let mut masks_more = 0;
    let mut color_more = 0;
    let mut captions_more = 0;
    let mut caption_navigation_more = 0;
    let mut keyboard_more = 0;
    let mut items_more = 0;
    let mut navigation_more = 0;
    let mut marker_navigation_more = 0;
    let mut marker_writes_more = 0;
    let mut lifecycle_more = 0;
    let mut camera_more = 0;
    let mut camera_recording_more = 0;
    let mut track_layout_more = 0;
    let mut track_flags_more = 0;
    let mut volume_more = 0;
    let mut source_inputs_more = 0;
    let mut mixer_paths_more = 0;
    let mut gap_paths_more = 0;
    let mut project_identity_more = 0;
    let mut sound_paths_more = 0;
    let mut search_paths_more = 0;
    let mut slip_paths_more = 0;
    let mut mixer_recording_more = 0;
    let mut trim_paths_more = 0;
    let mut transcript_paths_more = 0;
    let mut trim_edits_more = 0;
    let mut selection_steps_more = 0;
    let mut caption_creation_more = 0;
    let mut new_sequence_more = 0;
    let mut moves_more = 0;
    let mut direct_media_more = 0;
    let mut history_cache_more = 0;
    let mut frame_hold_more = 0;
    let mut subclip_edit_more = 0;
    let mut attributes_replace_more = 0;
    let mut sequence_copies_more = 0;
    let mut render_fonts_more = 0;
    let mut project_queries_more = 0;
    let mut root_graphic_metadata_more = 0;
    let mut channels_more = 0;
    let mut media_targets_more = 0;
    let mut copies_cuts_more = 0;
    let mut remaining_more = 0;
    let mut total = 0;
    let mut classes: BTreeMap<&str, usize> = BTreeMap::new();
    for row in rows().filter(|row| registered.contains(row.command)) {
        total += 1;
        let classified = if patches_compare::compared_path(row.command, row.path)
            || blocked_compare::compared_path(row.command, row.path)
            || unavailable_compare::compared_path(row.command, row.path)
            || closing_compare::compared_path(row.command, row.path)
        {
            Some(vec![])
        } else if settings_compare::compared_path(row.command, row.path) {
            Some(settings_compare::more(row.command))
        } else if generators_compare::compared_path(row.command, row.path) {
            Some(if row.command == "file.newOfflineFile" { vec!["explicit-offline-part"] } else { vec![] })
        } else if targeting_compare::compared_path(row.command, row.path) {
            // lib.rs::editor_state Active includes Source and Media Browser,
            // whereas these handlers consume only the current targeting map.
            Some(vec!["coarse-active-state"])
        } else if labels_compare::compared_path(row.command, row.path) {
            let mut classes = vec!["item-only-part"];
            if row.command != "edit.label" {
                classes.push("unconsumed-selection");
            }
            Some(classes)
        } else if clip_fields_compare::compared_path(row.command, row.path) {
            if matches!(row.command, "clip.link" | "clip.group" | "clip.ungroup" | "clip.scaleToFrameSize") {
                Some(if row.command == "clip.link" { vec!["coarse-selection-state", "unconsumed-selection"] } else { vec!["coarse-selection-state"] })
            } else if row.command == "clip.rename" {
                Some(if row.path == "item" { vec!["item-only-part", "unused-explicit-clip"] } else { vec![] })
            } else {
                let mut classes = vec!["clip-owner-position"];
                if row.command != "clip.setTimeInterpolation" {
                    classes.push("unconsumed-selection");
                }
                Some(classes)
            }
        } else if editor_compare::compared_path(row.command, row.path) {
            Some(editor_compare::more(row.command))
        } else if graphics_compare::compared_path(row.command, row.path) {
            Some(graphics_compare::more(row.command, row.path))
        } else if services_compare::compared_path(row.command, row.path) {
            Some(services_compare::more(row.command))
        } else if marks_compare::compared_path(row.command, row.path) {
            Some(marks_compare::more(row.command, row.path))
        } else if sync_compare::compared_path(row.command, row.path) {
            Some(sync_compare::more(row.command))
        } else if layout_compare::compared_path(row.command, row.path) {
            Some(layout_compare::more(row.command, row.path))
        } else if metadata_compare::compared_path(row.command, row.path) {
            Some(metadata_compare::more(row.command))
        } else if parameters_compare::compared_path(row.command, row.path) {
            Some(parameters_compare::more(row.command))
        } else if masks_compare::compared_path(row.command, row.path) {
            Some(masks_compare::more(row.command))
        } else if color_compare::compared_path(row.command, row.path) {
            Some(color_compare::more(row.command))
        } else if captions_compare::compared_path(row.command, row.path) {
            Some(captions_compare::more(row.command, row.path))
        } else if caption_navigation_compare::compared_path(row.command, row.path) {
            Some(caption_navigation_compare::more(row.command))
        } else if typography_compare::compared_path(row.command, row.path) {
            Some(typography_compare::more(row.command))
        } else if nudges_compare::compared_path(row.command, row.path) {
            Some(nudges_compare::more(row.command, row.path))
        } else if items_compare::compared_path(row.command, row.path) {
            Some(items_compare::more(row.command))
        } else if navigation_compare::compared_path(row.command, row.path) {
            Some(navigation_compare::more(row.command))
        } else if marker_paths_compare::compared_path(row.command, row.path) {
            Some(marker_paths_compare::more(row.command, row.path))
        } else if marker_writes_compare::compared_path(row.command, row.path) {
            Some(marker_writes_compare::more(row.command, row.path))
        } else if lifecycle_compare::compared_path(row.command, row.path) {
            Some(lifecycle_compare::more(row.command))
        } else if camera_compare::compared_path(row.command, row.path) {
            Some(camera_compare::more(row.command, row.path))
        } else if track_layout_compare::compared_path(row.command, row.path) {
            Some(track_layout_compare::more())
        } else if track_flags_compare::compared_path(row.command, row.path) {
            Some(track_flags_compare::more())
        } else if volume_compare::compared_path(row.command, row.path) {
            Some(volume_compare::more())
        } else if source_inputs_compare::compared_path(row.command, row.path) {
            Some(source_inputs_compare::more(row.command))
        } else if mixer_paths_compare::compared_path(row.command, row.path) {
            Some(mixer_paths_compare::more(row.command))
        } else if gap_paths_compare::compared_path(row.command, row.path) {
            Some(gap_paths_compare::more(row.command))
        } else if project_identity_compare::compared_path(row.command, row.path) {
            Some(project_identity_compare::more(row.command))
        } else if sound_paths_compare::compared_path(row.command, row.path) {
            Some(sound_paths_compare::more(row.command))
        } else if search_paths_compare::compared_path(row.command, row.path) {
            Some(search_paths_compare::more(row.command))
        } else if slip_paths_compare::compared_path(row.command, row.path) {
            Some(slip_paths_compare::more(row.command))
        } else if mixer_recording_compare::compared_path(row.command, row.path) {
            Some(mixer_recording_compare::more(row.command))
        } else if trim_paths_compare::compared_path(row.command, row.path) {
            Some(trim_paths_compare::more(row.command))
        } else if transcript_paths_compare::compared_path(row.command, row.path) {
            Some(transcript_paths_compare::more(row.command))
        } else if trim_edits_compare::compared_path(row.command, row.path) {
            Some(trim_edits_compare::more(row.path))
        } else if selection_steps_compare::compared_path(row.command, row.path) {
            Some(selection_steps_compare::more(row.command))
        } else if caption_creation_compare::compared_path(row.command, row.path) {
            Some(caption_creation_compare::more(row.command))
        } else if new_sequence_compare::compared_path(row.command, row.path) {
            Some(new_sequence_compare::more())
        } else if moves_compare::compared_path(row.command, row.path) {
            Some(moves_compare::more(row.command))
        } else if direct_media_compare::compared_path(row.command, row.path) {
            Some(direct_media_compare::more(row.command))
        } else if history_cache_compare::compared_path(row.command, row.path) {
            Some(history_cache_compare::more(row.command))
        } else if frame_hold_compare::compared_path(row.command, row.path) {
            Some(frame_hold_compare::more(row.command))
        } else if subclip_edit_compare::compared_path(row.command, row.path) {
            Some(subclip_edit_compare::more(row.command))
        } else if attributes_replace_compare::compared_path(row.command, row.path) {
            Some(attributes_replace_compare::more(row.command))
        } else if sequence_copies_compare::compared_path(row.command, row.path) {
            Some(sequence_copies_compare::more(row.command))
        } else if render_fonts_compare::compared_path(row.command, row.path) {
            Some(render_fonts_compare::more(row.command))
        } else if project_queries_compare::compared_path(row.command, row.path) {
            Some(project_queries_compare::more(row.command))
        } else if root_actions_compare::compared_path(row.command, row.path) {
            Some(root_actions_compare::more(row.command))
        } else if graphic_metadata_compare::compared_path(row.command, row.path) {
            Some(graphic_metadata_compare::more(row.path))
        } else if channels_compare::compared_path(row.command, row.path) {
            Some(channels_compare::more())
        } else if media_targets_compare::compared_path(row.command, row.path) {
            Some(media_targets_compare::more(row.command))
        } else if nest_flatten_compare::compared_path(row.command, row.path) {
            Some(nest_flatten_compare::more(row.command))
        } else if cuts_compare::compared_path(row.command, row.path) {
            Some(cuts_compare::more(row.command))
        } else if direct_edits_compare::compared_path(row.command, row.path) {
            Some(direct_edits_compare::more(row.command))
        } else if remaining_compare::compared_path(row.command, row.path) {
            Some(remaining_compare::more(row.command, row.path))
        } else {
            None
        };
        if let Some(row_classes) = &classified {
            if editor_compare::compared_path(row.command, row.path) {
                editor_more += usize::from(!row_classes.is_empty());
            } else if graphics_compare::compared_path(row.command, row.path) {
                if graphics_compare::NEW_LAYERS.contains(&row.command) {
                    graphics_new_more += usize::from(!row_classes.is_empty());
                } else {
                    graphics_more += usize::from(!row_classes.is_empty());
                }
            } else if services_compare::compared_path(row.command, row.path) {
                if row.command == "prefs.reset" {
                    reset_more += usize::from(!row_classes.is_empty());
                } else {
                    services_more += usize::from(!row_classes.is_empty());
                }
            } else if marks_compare::compared_path(row.command, row.path) {
                marks_more += usize::from(!row_classes.is_empty());
            } else if sync_compare::compared_path(row.command, row.path) {
                sync_more += usize::from(!row_classes.is_empty());
            } else if layout_compare::compared_path(row.command, row.path) {
                layout_more += usize::from(!row_classes.is_empty());
            } else if metadata_compare::compared_path(row.command, row.path) {
                metadata_more += usize::from(!row_classes.is_empty());
            } else if parameters_compare::compared_path(row.command, row.path) {
                parameters_more += usize::from(!row_classes.is_empty());
            } else if masks_compare::compared_path(row.command, row.path) {
                masks_more += usize::from(!row_classes.is_empty());
            } else if color_compare::compared_path(row.command, row.path) {
                color_more += usize::from(!row_classes.is_empty());
            } else if captions_compare::compared_path(row.command, row.path) {
                captions_more += usize::from(!row_classes.is_empty());
            } else if caption_navigation_compare::compared_path(row.command, row.path) {
                caption_navigation_more += usize::from(!row_classes.is_empty());
            } else if typography_compare::compared_path(row.command, row.path) || nudges_compare::compared_path(row.command, row.path) {
                keyboard_more += usize::from(!row_classes.is_empty());
            } else if items_compare::compared_path(row.command, row.path) {
                items_more += usize::from(!row_classes.is_empty());
            } else if settings_compare::compared_path(row.command, row.path) {
                settings_more += usize::from(!row_classes.is_empty());
            } else if navigation_compare::compared_path(row.command, row.path) {
                navigation_more += usize::from(!row_classes.is_empty());
            } else if marker_paths_compare::compared_path(row.command, row.path) {
                marker_navigation_more += usize::from(!row_classes.is_empty());
            } else if marker_writes_compare::compared_path(row.command, row.path) {
                marker_writes_more += usize::from(!row_classes.is_empty());
            } else if lifecycle_compare::compared_path(row.command, row.path) {
                lifecycle_more += usize::from(!row_classes.is_empty());
            } else if camera_compare::compared_path(row.command, row.path) {
                if row.path == "recording" {
                    camera_recording_more += usize::from(!row_classes.is_empty());
                } else {
                    camera_more += usize::from(!row_classes.is_empty());
                }
            } else if track_layout_compare::compared_path(row.command, row.path) {
                track_layout_more += usize::from(!row_classes.is_empty());
            } else if track_flags_compare::compared_path(row.command, row.path) {
                track_flags_more += usize::from(!row_classes.is_empty());
            } else if volume_compare::compared_path(row.command, row.path) {
                volume_more += usize::from(!row_classes.is_empty());
            } else if source_inputs_compare::compared_path(row.command, row.path) {
                source_inputs_more += usize::from(!row_classes.is_empty());
            } else if mixer_paths_compare::compared_path(row.command, row.path) {
                mixer_paths_more += usize::from(!row_classes.is_empty());
            } else if gap_paths_compare::compared_path(row.command, row.path) {
                gap_paths_more += usize::from(!row_classes.is_empty());
            } else if project_identity_compare::compared_path(row.command, row.path) {
                project_identity_more += usize::from(!row_classes.is_empty());
            } else if sound_paths_compare::compared_path(row.command, row.path) {
                sound_paths_more += usize::from(!row_classes.is_empty());
            } else if search_paths_compare::compared_path(row.command, row.path) {
                search_paths_more += usize::from(!row_classes.is_empty());
            } else if slip_paths_compare::compared_path(row.command, row.path) {
                slip_paths_more += usize::from(!row_classes.is_empty());
            } else if mixer_recording_compare::compared_path(row.command, row.path) {
                mixer_recording_more += usize::from(!row_classes.is_empty());
            } else if trim_paths_compare::compared_path(row.command, row.path) {
                trim_paths_more += usize::from(!row_classes.is_empty());
            } else if transcript_paths_compare::compared_path(row.command, row.path) {
                transcript_paths_more += usize::from(!row_classes.is_empty());
            } else if trim_edits_compare::compared_path(row.command, row.path) {
                trim_edits_more += usize::from(!row_classes.is_empty());
            } else if selection_steps_compare::compared_path(row.command, row.path) {
                selection_steps_more += usize::from(!row_classes.is_empty());
            } else if caption_creation_compare::compared_path(row.command, row.path) {
                caption_creation_more += usize::from(!row_classes.is_empty());
            } else if new_sequence_compare::compared_path(row.command, row.path) {
                new_sequence_more += usize::from(!row_classes.is_empty());
            } else if moves_compare::compared_path(row.command, row.path) {
                moves_more += usize::from(!row_classes.is_empty());
            } else if direct_media_compare::compared_path(row.command, row.path) {
                direct_media_more += usize::from(!row_classes.is_empty());
            } else if history_cache_compare::compared_path(row.command, row.path) {
                history_cache_more += usize::from(!row_classes.is_empty());
            } else if frame_hold_compare::compared_path(row.command, row.path) {
                frame_hold_more += usize::from(!row_classes.is_empty());
            } else if subclip_edit_compare::compared_path(row.command, row.path) {
                subclip_edit_more += usize::from(!row_classes.is_empty());
            } else if attributes_replace_compare::compared_path(row.command, row.path) {
                attributes_replace_more += usize::from(!row_classes.is_empty());
            } else if sequence_copies_compare::compared_path(row.command, row.path) {
                sequence_copies_more += usize::from(!row_classes.is_empty());
            } else if render_fonts_compare::compared_path(row.command, row.path) {
                render_fonts_more += usize::from(!row_classes.is_empty());
            } else if project_queries_compare::compared_path(row.command, row.path) {
                project_queries_more += usize::from(!row_classes.is_empty());
            } else if root_actions_compare::compared_path(row.command, row.path) || graphic_metadata_compare::compared_path(row.command, row.path) {
                root_graphic_metadata_more += usize::from(!row_classes.is_empty());
            } else if channels_compare::compared_path(row.command, row.path) {
                channels_more += usize::from(!row_classes.is_empty());
            } else if media_targets_compare::compared_path(row.command, row.path) {
                media_targets_more += usize::from(!row_classes.is_empty());
            } else if nest_flatten_compare::compared_path(row.command, row.path)
                || cuts_compare::compared_path(row.command, row.path)
                || direct_edits_compare::compared_path(row.command, row.path)
            {
                copies_cuts_more += usize::from(!row_classes.is_empty());
            } else if remaining_compare::compared_path(row.command, row.path) {
                remaining_more += usize::from(!row_classes.is_empty());
            } else {
                more += usize::from(!row_classes.is_empty());
            }
            for class in row_classes {
                *classes.entry(class).or_default() += 1;
            }
        } else {
            unknown += 1;
        }
        if std::env::var_os("FILM_READING_EXPORT").is_some() {
            println!(
                "PATH_AUDIT_JSON {}",
                serde_json::json!({"command":row.command,"path":row.path,"status":if classified.is_some(){"compared"}else{"unclassified"},"more":classified,"proof":row.proof})
            );
        }
    }
    // Every registered path must have its independent parameterized proof.
    assert_eq!(unknown, 0, "potential LESS grew to {unknown}");
    assert!(remaining_more <= 87, "final audit batch differences grew to {remaining_more}");
    assert!(unknown + more <= 773, "potential MORE/differing grew: unknown={unknown} known-more={more}");
    assert!(
        unknown + more + editor_more <= 773,
        "potential MORE/differing grew with editor paths: unknown={unknown} known-more={more} editor-more={editor_more}"
    );
    assert!(editor_more <= 28, "editor MORE grew to {editor_more}");
    assert!(
        unknown + more + editor_more + graphics_more <= 773,
        "potential MORE/differing grew with graphics paths: unknown={unknown} original={more} editor={editor_more} graphics={graphics_more}"
    );
    assert!(graphics_more <= 82, "graphics MORE grew to {graphics_more}");
    assert!(unknown + more + editor_more + graphics_more + services_more <= 773, "potential MORE/differing grew with local services");
    assert!(services_more <= 26, "local service MORE grew to {services_more}");
    assert!(unknown + more + editor_more + graphics_more + services_more + marks_more <= 773, "potential MORE/differing grew with mark paths");
    assert!(marks_more <= 21, "mark MORE grew to {marks_more}");
    assert!(unknown + more + editor_more + graphics_more + services_more + marks_more + sync_more <= 773, "potential MORE/differing grew with sync paths");
    assert!(sync_more <= 15, "sync MORE grew to {sync_more}");
    assert!(
        unknown + more + editor_more + graphics_more + services_more + marks_more + sync_more + layout_more + metadata_more <= 773,
        "potential MORE/differing grew with project layout and metadata paths"
    );
    assert!(layout_more <= 10, "layout MORE grew to {layout_more}");
    assert!(metadata_more <= 5, "metadata MORE grew to {metadata_more}");
    assert!(
        unknown + more + editor_more + graphics_more + services_more + marks_more + sync_more + layout_more + metadata_more + parameters_more <= 773,
        "potential MORE/differing grew with effect parameters"
    );
    assert!(parameters_more <= 12, "effect parameter MORE grew to {parameters_more}");
    assert!(
        unknown + more + editor_more + graphics_more + services_more + marks_more + sync_more + layout_more + metadata_more + parameters_more + masks_more
            <= 773,
        "potential MORE/differing grew with mask paths"
    );
    assert!(masks_more <= 9, "mask MORE grew to {masks_more}");
    assert!(
        unknown
            + more
            + editor_more
            + graphics_more
            + services_more
            + marks_more
            + sync_more
            + layout_more
            + metadata_more
            + parameters_more
            + masks_more
            + color_more
            <= 773,
        "potential MORE/differing grew with color paths"
    );
    assert!(color_more <= 5, "color MORE grew to {color_more}");
    assert!(captions_more <= 13, "caption MORE grew to {captions_more}");
    assert!(caption_navigation_more <= 5, "caption navigation MORE grew to {caption_navigation_more}");
    assert!(more <= 52, "reviewed MORE grew to {more}: {classes:?}");
    let more = more
        + editor_more
        + graphics_more
        + services_more
        + marks_more
        + sync_more
        + layout_more
        + metadata_more
        + parameters_more
        + masks_more
        + color_more
        + captions_more
        + caption_navigation_more
        + keyboard_more
        + items_more
        + reset_more
        + settings_more
        + graphics_new_more
        + navigation_more
        + marker_navigation_more
        + marker_writes_more
        + lifecycle_more
        + camera_more
        + camera_recording_more
        + track_layout_more
        + track_flags_more
        + volume_more
        + source_inputs_more
        + mixer_paths_more
        + gap_paths_more
        + project_identity_more
        + sound_paths_more
        + search_paths_more
        + slip_paths_more
        + mixer_recording_more
        + trim_paths_more
        + transcript_paths_more
        + trim_edits_more
        + selection_steps_more
        + caption_creation_more
        + new_sequence_more
        + moves_more
        + direct_media_more
        + history_cache_more
        + frame_hold_more
        + subclip_edit_more
        + attributes_replace_more
        + sequence_copies_more
        + render_fonts_more
        + project_queries_more
        + root_graphic_metadata_more
        + channels_more
        + media_targets_more
        + copies_cuts_more
        + remaining_more;
    assert!(keyboard_more <= 27, "keyboard MORE grew to {keyboard_more}");
    assert!(items_more <= 5, "item MORE grew to {items_more}");
    assert!(reset_more <= 1, "preference reset MORE grew to {reset_more}");
    assert!(settings_more <= 1, "sequence settings MORE grew to {settings_more}");
    assert!(graphics_new_more <= 12, "new graphic layer MORE grew to {graphics_new_more}");
    assert!(navigation_more <= 16, "navigation MORE grew to {navigation_more}");
    assert!(marker_navigation_more <= 15, "marker navigation MORE grew to {marker_navigation_more}");
    assert!(marker_writes_more <= 17, "marker write MORE grew to {marker_writes_more}");
    assert!(lifecycle_more <= 12, "lifecycle MORE grew to {lifecycle_more}");
    assert!(camera_more <= 26, "camera MORE grew to {camera_more}");
    assert!(camera_recording_more <= 21, "camera recording MORE grew to {camera_recording_more}");
    assert!(track_layout_more <= 3, "track layout MORE grew to {track_layout_more}");
    assert!(track_flags_more <= 3, "targeted flag MORE grew to {track_flags_more}");
    assert!(volume_more <= 8, "keyboard volume MORE grew to {volume_more}");
    assert!(source_inputs_more <= 7, "source input MORE grew to {source_inputs_more}");
    assert!(mixer_paths_more <= 12, "mixer path MORE grew to {mixer_paths_more}");
    assert!(gap_paths_more <= 5, "gap and selection path MORE grew to {gap_paths_more}");
    assert!(project_identity_more <= 5, "project identity path MORE grew to {project_identity_more}");
    assert!(sound_paths_more <= 10, "sound path MORE grew to {sound_paths_more}");
    assert!(search_paths_more <= 2, "search path MORE grew to {search_paths_more}");
    assert!(slip_paths_more <= 5, "slip path MORE grew to {slip_paths_more}");
    assert!(mixer_recording_more <= 11, "mixer recording MORE grew to {mixer_recording_more}");
    assert!(trim_paths_more <= 8, "trim path MORE grew to {trim_paths_more}");
    assert!(transcript_paths_more <= 9, "transcript path MORE grew to {transcript_paths_more}");
    assert!(trim_edits_more <= 18, "trim edit MORE grew to {trim_edits_more}");
    assert!(selection_steps_more <= 3, "selection step MORE grew to {selection_steps_more}");
    assert!(caption_creation_more <= 1, "caption creation MORE grew to {caption_creation_more}");
    assert!(new_sequence_more <= 2, "new sequence MORE grew to {new_sequence_more}");
    assert!(moves_more <= 6, "keyboard move MORE grew to {moves_more}");
    assert!(direct_media_more <= 3, "direct media MORE grew to {direct_media_more}");
    assert!(history_cache_more <= 4, "history and cache MORE grew to {history_cache_more}");
    assert!(frame_hold_more <= 3, "frame hold MORE grew to {frame_hold_more}");
    assert!(subclip_edit_more <= 2, "subclip edit MORE grew to {subclip_edit_more}");
    assert!(attributes_replace_more <= 7, "attributes and replacement MORE grew to {attributes_replace_more}");
    assert!(sequence_copies_more <= 3, "sequence copy MORE grew to {sequence_copies_more}");
    assert!(render_fonts_more <= 2, "render and font MORE grew to {render_fonts_more}");
    assert!(project_queries_more <= 8, "project query MORE grew to {project_queries_more}");
    assert!(root_graphic_metadata_more <= 7, "root and graphic metadata MORE grew to {root_graphic_metadata_more}");
    assert!(channels_more <= 2, "audio channel MORE grew to {channels_more}");
    assert!(media_targets_more <= 2, "media target MORE grew to {media_targets_more}");
    assert!(copies_cuts_more <= 11, "nest, flatten, cut and direct edit MORE grew to {copies_cuts_more}");
    assert!(unknown + more <= 695, "potential MORE/differing grew with caption, keyboard and item paths");
    println!(
        "CURRENT_PATH_AUDIT compared={} differing={more} less=0 more={more} unclassified={unknown} final-batch-more={remaining_more} classes={classes:?}",
        total - unknown
    );
}

#[test]
fn export_readings_for_mechanical_review() {
    use kition_kit::KitDocument;
    if std::env::var_os("FILM_READING_EXPORT").is_none() {
        return;
    }
    for row in rows() {
        println!(
            "READING_JSON {}",
            serde_json::json!({"command":row.command,"path":row.path,"resolves":row.resolves,"reads":row.reads,"editor":row.editor,"writes":row.writes,"proof":row.proof,"blind":row.blind})
        );
    }
    let doc = kition_film_kit::FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    for command in doc.commands() {
        println!("DECLARATION_JSON {}", serde_json::to_value(command).unwrap());
    }
}

#[test]
fn reviewed_baseline_inventory_has_provenance() {
    use std::collections::BTreeSet;
    let registered: BTreeSet<_> = kition_film_engine::command_specs().iter().filter(|spec| spec.journal).map(|spec| spec.id).collect();
    let mut less = BTreeSet::new();
    let mut more = BTreeSet::new();
    let mut engine = BTreeSet::new();
    for group in core_compare::BASELINE_GROUPS.iter().chain(effects_compare::BASELINE_GROUPS).chain(sequences_compare::BASELINE_GROUPS) {
        assert!(!group.proof.is_empty(), "{group:?}");
        assert!(["declaration", "engine", "sdk"].contains(&group.kind), "unclassified kind: {group:?}");
        println!(
            "BASELINE_CLASS {}",
            serde_json::json!({"side":group.side,"kind":group.kind,"class":group.class,"commands":group.commands,"proof":group.proof})
        );
        for command in group.commands {
            assert!(registered.contains(command), "{group:?}");
            assert!(rows().any(|row| row.command == *command), "no original reading: {command}");
            if group.kind == "engine" {
                engine.insert(*command);
            } else if group.kind == "sdk" {
                // Runtime lifecycle gaps are recorded separately from the
                // declaration and dispatch lower-bound inventories.
                continue;
            } else if group.side == "less" {
                less.insert(*command);
            } else {
                more.insert(*command);
            }
        }
    }
    less.extend(media_compare::DOCUMENT_LESS.iter().map(|row| row.0));
    more.extend(media_compare::DOCUMENT_MORE.iter().map(|row| row.0));
    // The later saved-writer label family independently exposed the generic
    // selection spelling as well as the sixteen colour-specific commands.
    more.insert("edit.label");
    for command in &registered {
        if !reviewed_editor_reads(command).is_empty() {
            less.insert(*command);
        }
    }
    engine.extend(effects_compare::BASELINE_GRAPHICS_DISPATCH);
    let all_less: BTreeSet<_> = less.union(&engine).copied().collect();
    println!(
        "VERIFIED BASELINE declarations less={} more={} differing={}; engine-dispatch={}; including engine less={} differing={}; total={} (lower bounds, unclassified paths remain)",
        less.len(),
        more.len(),
        less.union(&more).count(),
        engine.len(),
        all_less.len(),
        all_less.union(&more).count(),
        registered.len()
    );
}
