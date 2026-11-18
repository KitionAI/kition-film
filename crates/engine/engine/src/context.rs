//! Explicit call context (task card C4-film): the editor state a call reads besides its
//! parameters, set for one call and put back after it, so nothing an agent does depends on or
//! leaves behind the editor's open sequence, playheads, Source monitor, track targets or
//! selections (kition-sdk's `KitDocument::editor_state`, `set_context`, `restore_editor_state`;
//! Kit Process Protocol section 7a).
//!
//! None of this is an edit: the project, its revision, its dirty state and the undo history stay
//! as they are. In and Out points are not editor state here: they are the sequence's, saved with
//! it and undone like any edit.

use std::collections::BTreeMap;

use kition_film_project::{ClipId, ItemId};
use kition_film_time::{FrameRate, Tick};
use serde::{Deserialize, Serialize};

use crate::{EngineError, Result, Session, Targeting};

/// The editor state a call may read and must not leave behind: which sequence is open (and the
/// open timeline tabs), each sequence's playhead, the Source monitor's item and playhead, the
/// timeline, caption and Project panel selections, the selected edit points, graphic layers and
/// mask, track targets, timeline/marker switches and multicamera view modes.
/// Opaque to hosts.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    active_sequence: Option<ItemId>,
    open_sequences: Vec<ItemId>,
    playheads: BTreeMap<ItemId, Tick>,
    source_item: Option<ItemId>,
    source_playhead: Tick,
    selection: Vec<ClipId>,
    caption_selection: Vec<ClipId>,
    project_selection: Vec<ItemId>,
    edit_points: Vec<crate::trim::EditPoint>,
    graphic_layers: Vec<usize>,
    selected_mask: Option<crate::masks::MaskSel>,
    targeting: BTreeMap<ItemId, Targeting>,
    snapping: bool,
    linked_selection: bool,
    sequences_as_clips: bool,
    selection_follows_playhead: bool,
    show_through_edits: bool,
    ripple_sequence_markers: bool,
    copy_paste_sequence_markers: bool,
    hidden_marker_colors: Vec<kition_film_project::Label>,
    multicam_audio_follows_video: bool,
    multicam_view: crate::multicam::MulticamView,
    default_video_transition: String,
    default_audio_transition: String,
    clip_mixer_modes: BTreeMap<u64, kition_film_project::AutomationMode>,
}

/// The playhead for `seconds` from a sequence's start at `rate`: the nearest tick, then the start
/// of the frame showing it (the frame that time falls in, as the playhead always is), so
/// 3.5 s at 23.976 fps is frame 83, which starts at 3.4618 s. The one conversion of a call's
/// `at.time`.
pub fn playhead_at(seconds: f64, rate: FrameRate) -> Tick {
    rate.snap(Tick::from_seconds_f64(seconds))
}

/// A sequence as an error names it: `7 ("Sequence 01")`.
fn named(s: &Session, id: ItemId) -> String {
    format!("{} ({:?})", id.0, s.project.item(id).map(|item| item.name.as_str()).unwrap_or(""))
}

/// The project's sequences, as an error lists them.
fn sequences(s: &Session) -> String {
    let all: Vec<String> = s.project.sequences().map(|item| named(s, item.id)).collect();
    if all.is_empty() { "it has none".into() } else { format!("its sequences are {}", all.join(", ")) }
}

/// Where one id of a call's `on` is: what it selects.
enum Selected {
    Clip(ClipId),
    Caption(ClipId),
    Item(ItemId),
}

impl Session {
    /// Outside rereads must not silently redirect an unresolved active or selected identity.
    pub fn validate_call_state(&self, saved: &CallState) -> Result<()> {
        let missing = |kind: &str, id: u64| EngineError::Other(format!("deleted {kind} {id}"));
        for id in saved.active_sequence.iter().chain(&saved.open_sequences) {
            if self.project.sequence(*id).is_none() {
                return Err(missing("active sequence", id.0));
            }
        }
        for id in saved.source_item.iter().chain(&saved.project_selection) {
            if self.project.item(*id).is_none() && self.project.root.find_bin(kition_film_project::BinId(id.0)).is_none() {
                return Err(missing("active target", id.0));
            }
        }
        for id in saved.selection.iter().chain(&saved.caption_selection).chain(saved.edit_points.iter().map(|point| &point.clip)) {
            if !self.project.sequences().filter_map(|item| self.project.sequence(item.id)).any(|sequence| {
                sequence.find_item(*id).is_some() || sequence.caption_tracks.iter().any(|track| track.captions.iter().any(|caption| caption.id == *id))
            }) {
                return Err(missing("selected target", id.0));
            }
        }
        Ok(())
    }

    /// The editor state ([`CallState`]) as it is now.
    pub fn call_state(&self) -> CallState {
        let st = &self.state;
        CallState {
            active_sequence: st.active_sequence,
            open_sequences: st.open_sequences.clone(),
            playheads: st.playheads.clone(),
            source_item: st.source_item,
            source_playhead: st.source_playhead,
            selection: st.selection.clone(),
            caption_selection: st.caption_selection.clone(),
            project_selection: st.project_selection.clone(),
            edit_points: st.edit_points.clone(),
            graphic_layers: st.graphic_layers.clone(),
            selected_mask: st.selected_mask,
            targeting: st.targeting.clone(),
            snapping: st.snapping,
            linked_selection: st.linked_selection,
            sequences_as_clips: st.sequences_as_clips,
            selection_follows_playhead: st.selection_follows_playhead,
            show_through_edits: st.show_through_edits,
            ripple_sequence_markers: st.ripple_sequence_markers,
            copy_paste_sequence_markers: st.copy_paste_sequence_markers,
            hidden_marker_colors: st.hidden_marker_colors.clone(),
            multicam_audio_follows_video: st.multicam_audio_follows_video,
            multicam_view: st.multicam_view.clone(),
            default_video_transition: st.default_video_transition.clone(),
            default_audio_transition: st.default_audio_transition.clone(),
            clip_mixer_modes: st.clip_mixer_modes.clone(),
        }
    }

    /// Puts back what [`Session::call_state`] answered, as far as the project still has it: a
    /// sequence, item or clip the call deleted is left out (an open sequence that is gone leaves
    /// the one open now; with none saved, the one open now stays, so a sequence the call made is
    /// not closed into a project with no open sequence). No edit.
    pub fn restore_call_state(&mut self, saved: &CallState) {
        let before = (self.epoch, self.state.active_sequence);
        let project = self.project.clone();
        let is_sequence = |id: &ItemId| project.sequence(*id).is_some();
        let clip_exists = |id: &ClipId| {
            project
                .sequences()
                .filter_map(|item| project.sequence(item.id))
                .any(|q| q.find_item(*id).is_some() || q.caption_tracks.iter().any(|track| track.captions.iter().any(|caption| caption.id == *id)))
        };
        let item_exists = |id: &ItemId| {
            project.item(*id).is_some()
                || (kition_film_project::BinId(id.0) != project.root.id && project.root.find_bin(kition_film_project::BinId(id.0)).is_some())
        };
        let st = &mut self.state;
        if let Some(active) = saved.active_sequence.filter(is_sequence) {
            st.active_sequence = Some(active);
        }
        st.open_sequences = saved.open_sequences.iter().copied().filter(is_sequence).collect();
        if let Some(active) = st.active_sequence
            && !st.open_sequences.contains(&active)
        {
            st.open_sequences.push(active);
        }
        st.playheads = saved.playheads.iter().filter(|(id, _)| is_sequence(id)).map(|(id, t)| (*id, *t)).collect();
        st.source_item = saved.source_item.filter(item_exists);
        st.source_playhead = saved.source_playhead;
        st.selection = saved.selection.iter().copied().filter(clip_exists).collect();
        st.caption_selection = saved.caption_selection.iter().copied().filter(clip_exists).collect();
        st.project_selection = saved.project_selection.iter().copied().filter(item_exists).collect();
        st.edit_points = saved.edit_points.iter().copied().filter(|point| clip_exists(&point.clip)).collect();
        st.graphic_layers.clone_from(&saved.graphic_layers);
        st.selected_mask = saved.selected_mask;
        st.targeting = saved.targeting.iter().filter(|(id, _)| is_sequence(id)).map(|(id, t)| (*id, t.clone())).collect();
        st.snapping = saved.snapping;
        st.linked_selection = saved.linked_selection;
        st.sequences_as_clips = saved.sequences_as_clips;
        st.selection_follows_playhead = saved.selection_follows_playhead;
        st.show_through_edits = saved.show_through_edits;
        st.ripple_sequence_markers = saved.ripple_sequence_markers;
        st.copy_paste_sequence_markers = saved.copy_paste_sequence_markers;
        st.hidden_marker_colors.clone_from(&saved.hidden_marker_colors);
        st.multicam_audio_follows_video = saved.multicam_audio_follows_video;
        st.multicam_view.clone_from(&saved.multicam_view);
        st.default_video_transition.clone_from(&saved.default_video_transition);
        st.default_audio_transition.clone_from(&saved.default_audio_transition);
        st.clip_mixer_modes = saved
            .clip_mixer_modes
            .iter()
            .filter(|(track, _)| {
                project.sequences().filter_map(|item| project.sequence(item.id)).any(|sequence| sequence.audio_tracks.iter().any(|audio| audio.id.0 == **track))
            })
            .map(|(track, mode)| (*track, *mode))
            .collect();
        if before != (self.epoch, self.state.active_sequence) {
            self.left_editing_context();
        }
    }

    /// Sets the editor state one call reads: `sequence` (an item id) becomes the open sequence,
    /// `seconds` from its start its playhead ([`playhead_at`]), and `on` (ids as `inspect` lists
    /// them) the selection: clips and captions of that sequence select on the timeline, project
    /// items and bins in the Project panel, and every selection is exactly what `on` names. With
    /// no `sequence`, the open one is meant. Everything is checked before anything changes: a
    /// sequence, clip or item the project lacks, a time outside the sequence, or a time or clips
    /// with no sequence open is an error that says what is valid, and nothing changes. No edit.
    pub fn set_call_context(&mut self, sequence: Option<u64>, seconds: Option<f64>, on: &[u64]) -> Result<()> {
        let error = |message: String| Err(EngineError::Other(message));
        if let Some(id) = sequence
            && self.project.sequence(ItemId(id)).is_none()
        {
            return error(format!("`at.part.sequence` is {id}, which is no sequence of this project: {}", sequences(self)));
        }
        let target = sequence.map(ItemId).or(self.state.active_sequence);
        let needs_sequence = seconds.is_some() || on.iter().any(|id| self.project.item(ItemId(*id)).is_none());
        let q = match target.and_then(|id| self.project.sequence(id)) {
            Some(q) => Some(q),
            None if needs_sequence => {
                return error(format!("no sequence is open to set a time or clips in: name one in `at.part` ({{\"sequence\": id}}); {}", sequences(self)));
            }
            None => None,
        };
        let playhead = match (seconds, q, target) {
            (Some(seconds), Some(q), Some(id)) => {
                let end = q.duration().seconds();
                if !(seconds.is_finite() && (0.0..=end).contains(&seconds)) {
                    return error(format!(
                        "`at.time` is {seconds} s, outside sequence {}: it runs from 0 to {} s (its end); give a time in seconds in that range",
                        named(self, id),
                        (end * 1000.0).round() / 1000.0
                    ));
                }
                Some(playhead_at(seconds, q.settings.frame_rate))
            }
            _ => None,
        };
        let mut selected = Vec::with_capacity(on.len());
        for &id in on {
            let in_sequence = q.and_then(|q| {
                if q.find_item(ClipId(id)).is_some() {
                    Some(Selected::Clip(ClipId(id)))
                } else if q.caption_tracks.iter().any(|track| track.captions.iter().any(|caption| caption.id == ClipId(id))) {
                    Some(Selected::Caption(ClipId(id)))
                } else {
                    None
                }
            });
            let item = ItemId(id);
            let bin = kition_film_project::BinId(id);
            let found = in_sequence.or_else(|| {
                (self.project.item(item).is_some() || (bin != self.project.root.id && self.project.root.find_bin(bin).is_some()))
                    .then_some(Selected::Item(item))
            });
            match found {
                Some(found) => selected.push(found),
                None => {
                    let elsewhere = self.project.sequences().find(|other| self.project.sequence(other.id).is_some_and(|q| q.find_item(ClipId(id)).is_some()));
                    let message = match (elsewhere, target) {
                        (Some(other), Some(target)) => format!(
                            "`on` names clip {id}, which is in sequence {}, not in sequence {} the call acts in: name its sequence in `at.part` ({{\"sequence\": {}}})",
                            named(self, other.id),
                            named(self, target),
                            other.id.0
                        ),
                        _ => format!(
                            "`on` names {id}, which is no clip of {} and no project item: give clip ids as film_inspect lists them (`clip` in details.sequence) or item ids (`item` in details.project)",
                            target.map_or_else(|| "the open sequence".to_owned(), |target| format!("sequence {}", named(self, target)))
                        ),
                    };
                    return error(message);
                }
            }
        }
        // Checked: now set.
        if let Some(id) = sequence.map(ItemId)
            && self.state.active_sequence != Some(id)
        {
            self.state.active_sequence = Some(id);
            if !self.state.open_sequences.contains(&id) {
                self.state.open_sequences.push(id);
            }
            // As opening it in the Timeline does: the clips selected were another sequence's.
            self.state.selection.clear();
            self.state.caption_selection.clear();
            self.state.edit_points.clear();
            self.left_editing_context();
        }
        if let Some(playhead) = playhead {
            self.set_playhead(playhead);
        }
        if !selected.is_empty() {
            let st = &mut self.state;
            st.selection = selected.iter().filter_map(|found| if let Selected::Clip(id) = found { Some(*id) } else { None }).collect();
            st.caption_selection = selected.iter().filter_map(|found| if let Selected::Caption(id) = found { Some(*id) } else { None }).collect();
            st.project_selection = selected.iter().filter_map(|found| if let Selected::Item(id) = found { Some(*id) } else { None }).collect();
        }
        Ok(())
    }
}
