//! JSON shapes for the `props`/`settings` catch-all fields: mostly the real engine structs passed
//! straight through `serde_json` (lossless and simplest), except the few spots that
//! cross-reference another object (an `ItemId`/`TrackId` embedded in `Multicam`/`MergedClip`, a
//! `Subclip`'s parent): those are resolved to the referenced object's KDM id string at write time
//! and back through [`Ids`] at read time.
//!
//! Every `Tick` embedded in one of these blobs (a keyframe time, a mark in/out, a frame hold…) is
//! written as the engine's own raw JSON number, not the decimal-string form the named timing
//! fields (`Clip.start`/`duration`/`sourceIn`, `Transition.start`/`duration`, a marker's and a
//! caption's `start`/`duration`) use: see the crate docs for why, and the residual range risk
//! that leaves.

use std::collections::BTreeMap;

use kition_film_project::{Camera, ItemId, ItemKind, Label, MediaClip, MergedClip, MulticamAudio, MulticamSource, ProjectItem, SplitMarks, TrackId};
use kition_film_time::TimeRange;
use kition_kit::kdm::ObjectId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Ids;
use crate::kdm_err;

type KdmResult<T> = Result<T, kition_kit::kdm::KdmError>;

#[derive(Serialize, Deserialize)]
pub(crate) struct ItemCommon {
    pub label: Label,
    pub metadata: BTreeMap<String, String>,
    pub created: u64,
    pub split: SplitMarks,
}

/// `Item.props` for a media item.
#[derive(Serialize, Deserialize)]
pub(crate) struct MediaProps {
    pub common: ItemCommon,
    pub media: MediaClip,
}

/// `Item.props` for a sequence item (the sequence's own data lives in the `sequence` ref's
/// object; only the item-level common fields are here).
#[derive(Serialize, Deserialize)]
pub(crate) struct SequenceItemProps {
    pub common: ItemCommon,
}

/// `Item.props` for a subclip. `parent` is `None` when the parent item no longer exists (a
/// dangling reference `KitModel::validate` repairs away by dropping the subclip).
#[derive(Serialize, Deserialize)]
pub(crate) struct SubclipProps {
    pub common: ItemCommon,
    pub parent: Option<String>,
    pub range: TimeRange,
    pub restrict_trims: bool,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AdjustmentProps {
    pub common: ItemCommon,
    pub width: u32,
    pub height: u32,
    pub rate: kition_film_time::FrameRate,
    pub duration: kition_film_time::Tick,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct GraphicProps {
    pub common: ItemCommon,
    pub width: u32,
    pub height: u32,
    pub rate: kition_film_time::FrameRate,
}

fn common(item: &ProjectItem) -> ItemCommon {
    ItemCommon { label: item.label, metadata: item.metadata.clone(), created: item.created, split: item.split }
}

/// The `Item.kind` enum value and its `props` JSON for `item`.
pub(crate) fn item_kind_and_props(item: &ProjectItem, ids: &Ids) -> KdmResult<(&'static str, Value)> {
    let value = match &item.kind {
        // The markers are `Item.markers`, objects of their own.
        ItemKind::Media(media) => serde_json::to_value(MediaProps { common: common(item), media: MediaClip { markers: Vec::new(), ..media.clone() } }),
        ItemKind::Sequence(_) => serde_json::to_value(SequenceItemProps { common: common(item) }),
        ItemKind::Subclip { parent, range, restrict_trims } => serde_json::to_value(SubclipProps {
            common: common(item),
            parent: ids.items.object(*parent).map(ObjectId::as_str).map(str::to_owned),
            range: *range,
            restrict_trims: *restrict_trims,
        }),
        ItemKind::AdjustmentLayer { width, height, rate, duration } => {
            serde_json::to_value(AdjustmentProps { common: common(item), width: *width, height: *height, rate: *rate, duration: *duration })
        }
        ItemKind::Graphic { width, height, rate } => serde_json::to_value(GraphicProps { common: common(item), width: *width, height: *height, rate: *rate }),
    };
    let kind = match &item.kind {
        ItemKind::Media(_) => "media",
        ItemKind::Sequence(_) => "sequence",
        ItemKind::Subclip { .. } => "subclip",
        ItemKind::AdjustmentLayer { .. } => "adjustment",
        ItemKind::Graphic { .. } => "graphic",
    };
    Ok((kind, value.map_err(kdm_err)?))
}

/// `Sequence.settings`: [`kition_film_project::SequenceSettings`] plus every other sequence-level
/// field not given its own schema field, with `multicam`/`merged`'s `ItemId`/`TrackId` resolved
/// to KDM object id strings.
#[derive(Serialize, Deserialize)]
pub(crate) struct SeqSettings {
    pub settings: kition_film_project::SequenceSettings,
    pub mark_in: Option<kition_film_time::Tick>,
    pub mark_out: Option<kition_film_time::Tick>,
    pub work_area: Option<TimeRange>,
    pub start_timecode: i64,
    pub split: SplitMarks,
    pub multicam: Option<MulticamOut>,
    pub merged: Option<MergedOut>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct CameraOut {
    pub name: String,
    pub video_track: Option<String>,
    pub audio_tracks: Vec<String>,
    pub enabled: bool,
    pub source: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct MulticamOut {
    pub cameras: Vec<CameraOut>,
    pub audio: MulticamAudio,
    pub sync: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct MergedOut {
    pub video: Option<String>,
    pub audio: Vec<String>,
    pub sync: String,
}

fn track_ref(ids: &Ids, id: Option<TrackId>) -> Option<String> {
    id.and_then(|id| ids.tracks.object(id)).map(ObjectId::as_str).map(str::to_owned)
}
fn item_ref(ids: &Ids, id: Option<ItemId>) -> Option<String> {
    id.and_then(|id| ids.items.object(id)).map(ObjectId::as_str).map(str::to_owned)
}

pub(crate) fn build_sequence_settings(seq: &kition_film_project::Sequence, ids: &Ids) -> SeqSettings {
    SeqSettings {
        settings: seq.settings.clone(),
        mark_in: seq.mark_in,
        mark_out: seq.mark_out,
        work_area: seq.work_area,
        start_timecode: seq.start_timecode,
        split: seq.split,
        multicam: seq.multicam.as_ref().map(|m| MulticamOut {
            cameras: m
                .cameras
                .iter()
                .map(|camera: &Camera| CameraOut {
                    name: camera.name.clone(),
                    video_track: track_ref(ids, camera.video_track),
                    audio_tracks: camera.audio_tracks.iter().filter_map(|t| track_ref(ids, Some(*t))).collect(),
                    enabled: camera.enabled,
                    source: item_ref(ids, camera.source),
                })
                .collect(),
            audio: m.audio,
            sync: m.sync.clone(),
        }),
        merged: seq.merged.as_ref().map(|m: &MergedClip| MergedOut {
            video: item_ref(ids, m.video),
            audio: m.audio.iter().filter_map(|i| item_ref(ids, Some(*i))).collect(),
            sync: m.sync.clone(),
        }),
    }
}

pub(crate) fn apply_sequence_settings(seq: &mut kition_film_project::Sequence, value: Value, ids: &Ids) -> KdmResult<()> {
    let out: SeqSettings = serde_json::from_value(value).map_err(kdm_err)?;
    seq.settings = out.settings;
    seq.mark_in = out.mark_in;
    seq.mark_out = out.mark_out;
    seq.work_area = out.work_area;
    seq.start_timecode = out.start_timecode;
    seq.split = out.split;
    seq.multicam = out.multicam.map(|m| MulticamSource {
        cameras: m
            .cameras
            .into_iter()
            .map(|c| Camera {
                name: c.name,
                video_track: c.video_track.and_then(|o| ids.tracks.local(&ObjectId::from_string(o))),
                audio_tracks: c.audio_tracks.into_iter().filter_map(|o| ids.tracks.local(&ObjectId::from_string(o))).collect(),
                enabled: c.enabled,
                source: c.source.and_then(|o| ids.items.local(&ObjectId::from_string(o))),
            })
            .collect(),
        audio: m.audio,
        sync: m.sync,
    });
    seq.merged = out.merged.map(|m| MergedClip {
        video: m.video.and_then(|o| ids.items.local(&ObjectId::from_string(o))),
        audio: m.audio.into_iter().filter_map(|o| ids.items.local(&ObjectId::from_string(o))).collect(),
        sync: m.sync,
    });
    Ok(())
}

/// `Track.props`: everything about a track not given its own schema field. No cross-references.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct TrackProps {
    pub kind: kition_film_project::TrackKind,
    pub name: String,
    pub locked: bool,
    pub sync_lock: bool,
    pub enabled: bool,
    pub muted: bool,
    pub solo: bool,
    pub channels: kition_film_project::AudioChannels,
    pub mixer: kition_film_project::MixerStrip,
}

/// `Clip.props`: everything about a track item not given its own schema field. No cross-references.
#[derive(Serialize, Deserialize)]
pub(crate) struct ClipProps {
    pub name: String,
    pub label: Label,
    pub enabled: bool,
    pub frame_hold: Option<kition_film_time::Tick>,
    pub scale_to_frame: bool,
    pub audio_mixing: Option<kition_film_project::AudioMixing>,
    pub multicam: Option<kition_film_project::MulticamSel>,
    pub time_interpolation: kition_film_project::TimeInterpolation,
    pub hold_filters: bool,
    pub field_options: Option<kition_film_project::FieldOptions>,
    pub source_channels: Vec<u16>,
    pub audio_stream: usize,
    pub graphic: Option<Box<kition_film_project::GraphicMeta>>,
}

/// `Clip.gain`: the one scalar the design calls out on its own, left room to grow.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct ClipGain {
    pub gain_db: f64,
}
