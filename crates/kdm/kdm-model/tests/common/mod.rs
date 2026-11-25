//! Shared test helpers: a small project to edit, and a harness over
//! `KitSession<FilmModel>`. Included by several `tests/*.rs` binaries, each of which uses only
//! some of these; a function unused by one binary is still used by another.
#![allow(dead_code)]

use kition_film_media::{DemoScene, Generator, MediaSource, generators::GeneratorSource};
use kition_film_project::{ItemId, Label, MediaClip, Project, SequenceSettings, TrackKind};
use kition_film_time::{FrameRate, TimeRange};
use kition_kit::kdm::{ActorId, DocId, Origin, Replica};
use kition_kit::session::{KitModel, KitSession, MemoryBlobs};

pub type Session = KitSession<kdm_model::FilmModel>;

/// The id of `project`'s one sequence item. `demo_project`'s own `ItemId`s are only valid for the
/// exact `Project` it returns: every `read_document` (so every `FilmModel::load`, so every
/// `first`/`peer` session) mints its own ids from scratch, so a test must look these up again on
/// `session.model().project` rather than reuse the ids `demo_project` or `add_clip` handed back.
pub fn sequence_id(project: &Project) -> ItemId {
    project.items.values().find(|item| matches!(item.kind, kition_film_project::ItemKind::Sequence(_))).unwrap_or_else(|| panic!("no sequence item")).id
}

/// The id of `project`'s one media item. See [`sequence_id`].
pub fn media_id(project: &Project) -> ItemId {
    project.items.values().find(|item| matches!(item.kind, kition_film_project::ItemKind::Media(_))).unwrap_or_else(|| panic!("no media item")).id
}

/// A project with one media item and one sequence (one video, one audio track, no clips yet).
pub fn demo_project() -> (Project, ItemId, ItemId) {
    let mut project = Project::new("Test");
    let source = GeneratorSource::demo(DemoScene::OceanSunset);
    let info = source.info().clone();
    let media = project.add_item(
        "Ocean_Sunset.mp4",
        Label::Iris,
        kition_film_project::ItemKind::Media(MediaClip {
            media: kition_film_project::MediaRef::Generator(Generator::Demo(DemoScene::OceanSunset)),
            info,
            interpret: Default::default(),
            mark_in: None,
            mark_out: None,
            markers: Vec::new(),
            offline: false,
            proxy: None,
            identity: None,
        }),
        None,
    );
    let sequence = project.new_sequence("Sequence 01", SequenceSettings::default(), 1, 1, None);
    (project, media, sequence)
}

/// Appends a clip of `media` to the sequence's first video track, `duration` long, at `start`.
pub fn add_clip(project: &mut Project, sequence: ItemId, media: ItemId, start: kition_film_time::Tick, duration: kition_film_time::Tick) -> u64 {
    let rate = project.sequence(sequence).map(|s| s.settings.frame_rate).unwrap_or(FrameRate::FPS_24);
    let clip = project.make_track_item(media, TrackKind::Video, start, TimeRange::new(kition_film_time::Tick::ZERO, duration), rate).unwrap_or_else(|| {
        panic!("make_track_item");
    });
    let id = clip.id.0;
    project.sequence_mut(sequence).unwrap_or_else(|| panic!("sequence")).video_tracks[0].items.push(clip);
    id
}

pub fn actor(value: u64) -> ActorId {
    ActorId::from_u64(value).unwrap_or_else(|error| panic!("actor {value}: {error}"))
}

pub fn person(name: &str) -> Origin {
    Origin::person(format!("user:{name}"))
}

/// A fresh replica + session holding `project`.
pub fn first(project: &Project) -> Session {
    let mut ids = kdm_model::Ids::default();
    let mut nodes = kdm_model::Nodes::default();
    let (replica, ()) = Replica::create_with(kdm_model::FilmModel::schema(), DocId::new(), actor(1), &Origin::system("create"), |tx| {
        kdm_model::write_document(tx, project, &mut ids, &mut nodes).map(|_| ())
    })
    .unwrap_or_else(|error| panic!("create: {error}"));
    KitSession::from_replica(replica, Box::new(MemoryBlobs::default())).unwrap_or_else(|error| panic!("attach: {error}"))
}

/// A peer session starting from a snapshot of `of`, under a different actor.
pub fn peer(of: &Session, value: u64) -> Session {
    let snapshot = of.snapshot().unwrap_or_else(|error| panic!("snapshot: {error}"));
    KitSession::open_snapshot(&snapshot, Box::new(MemoryBlobs::default()), actor(value)).unwrap_or_else(|error| panic!("open_snapshot: {error}"))
}

/// Exchanges changes both ways until both replicas are at one version (or panics after a generous
/// number of rounds): the replica that wrote since the last exchange hands its changes over.
pub fn sync(a: &mut Session, b: &mut Session) {
    for _ in 0..8 {
        a.import_changes(&b.export_changes(&a.version()).unwrap_or_else(|error| panic!("export: {error}"))).unwrap_or_else(|error| panic!("import: {error}"));
        b.import_changes(&a.export_changes(&b.version()).unwrap_or_else(|error| panic!("export: {error}"))).unwrap_or_else(|error| panic!("import: {error}"));
        if a.version() == b.version() {
            return;
        }
    }
    panic!("the replicas did not reach one version");
}

/// Asserts `a` and `b` hold the same content once ids are normalized (`kdm_model::normalize`),
/// comparing the JSON each would serialize to rather than the raw structs: an "auto" point is
/// `f64::NAN`, never equal to itself under `PartialEq`, but always the same JSON `null`.
pub fn assert_same_content(a: &Project, b: &Project) {
    let left = serde_json::to_value(kdm_model::normalize(a)).unwrap_or_else(|error| panic!("serializing a: {error}"));
    let right = serde_json::to_value(kdm_model::normalize(b)).unwrap_or_else(|error| panic!("serializing b: {error}"));
    assert_eq!(left, right, "the two projects differ once ids are normalized");
}

/// Writes the diff between the session's current project and `after` as one transaction, then
/// makes `after` the session's view (mirroring how an engine command bridge would use
/// `kdm_model::write_changes`: the engine already holds `after`, and the bridge only replicates
/// the difference).
pub fn record(session: &mut Session, origin: &Origin, after: &Project) {
    let mut ids = session.model().ids().clone();
    let mut nodes = session.model().nodes().clone();
    let before = session.model().project.clone();
    session
        .record(origin, |tx| {
            kdm_model::write_changes(tx, &before, after, &mut ids, &mut nodes).map_err(|error| kition_kit::session::KitError::new(error.to_string()))
        })
        .unwrap_or_else(|error| panic!("record: {error}"));
    *session.model_mut() = kdm_model::FilmModel::from_parts(after.clone(), ids, nodes);
}
