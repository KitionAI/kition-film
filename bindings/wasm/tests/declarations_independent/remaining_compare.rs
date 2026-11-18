//! The final audit batch shares a fixed allowance with its unclassified paths.
//! Classifying a conservative path cannot increase the global difference bound.
pub fn compared_path(command: &str, path: &str) -> bool {
    super::analysis_compare::compared_path(command, path)
        || super::frame_lookup_compare::compared_path(command, path)
        || super::graphic_creation_compare::compared_path(command, path)
        || super::clipboard_compare::compared_path(command, path)
        || super::composites_compare::compared_path(command, path)
        || super::geometry_commands_compare::compared_path(command, path)
        || super::joins_compare::compared_path(command, path)
        || super::track_transition_compare::compared_path(command, path)
        || super::project_sources_compare::compared_path(command, path)
        || super::project_management_compare::compared_path(command, path)
        || super::range_gap_compare::compared_path(command, path)
        || super::transition_creation_compare::compared_path(command, path)
        || super::direct_move_compare::compared_path(command, path)
        || super::placement_compare::compared_path(command, path)
}
pub fn count() -> usize {
    super::analysis_compare::PATHS.len()
        + super::frame_lookup_compare::PATHS.len()
        + super::graphic_creation_compare::PATHS.len()
        + super::clipboard_compare::PATHS.len()
        + super::composites_compare::PATHS.len()
        + super::geometry_commands_compare::PATHS.len()
        + super::joins_compare::PATHS.len()
        + super::track_transition_compare::PATHS.len()
        + super::project_sources_compare::PATHS.len()
        + super::project_management_compare::PATHS.len()
        + super::range_gap_compare::PATHS.len()
        + super::transition_creation_compare::PATHS.len()
        + super::direct_move_compare::PATHS.len()
        + super::placement_compare::PATHS.len()
}
pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    if super::analysis_compare::compared_path(command, path) {
        super::analysis_compare::more(command)
    } else if super::frame_lookup_compare::compared_path(command, path) {
        super::frame_lookup_compare::more(command)
    } else if super::graphic_creation_compare::compared_path(command, path) {
        super::graphic_creation_compare::more(command)
    } else if super::clipboard_compare::compared_path(command, path) {
        super::clipboard_compare::more(command)
    } else if super::composites_compare::compared_path(command, path) {
        super::composites_compare::more(command)
    } else if super::geometry_commands_compare::compared_path(command, path) {
        super::geometry_commands_compare::more(command)
    } else if super::joins_compare::compared_path(command, path) {
        super::joins_compare::more(command)
    } else if super::track_transition_compare::compared_path(command, path) {
        super::track_transition_compare::more(command)
    } else if super::project_sources_compare::compared_path(command, path) {
        super::project_sources_compare::more(command)
    } else if super::project_management_compare::compared_path(command, path) {
        super::project_management_compare::more(command)
    } else if super::range_gap_compare::compared_path(command, path) {
        super::range_gap_compare::more(command)
    } else if super::transition_creation_compare::compared_path(command, path) {
        super::transition_creation_compare::more(command)
    } else if super::direct_move_compare::compared_path(command, path) {
        super::direct_move_compare::more(command)
    } else {
        super::placement_compare::more(command)
    }
}
