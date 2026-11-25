//! Bridges the Film engine's [`Project`] ([`kition_film_project`]) to a `kit.film` KDM replica.
//!
//! [`FilmModel`] implements [`KitModel`]: it is the engine's materialised view of a replica, the
//! same [`Project`] the rest of the engine already knows. Bins, items, tracks, clips, transitions
//! and effects become KDM objects with their own identity, so a draft's edits and the document's
//! made meanwhile to different ones merge finely (rules D1 to D9); [`write_document`] and [`write::write_changes`] are the engine command bridge's
//! entry points (phase 3b Task 2): writing a whole project in one creating transaction, or only
//! what a command changed.
//!
//! Media files are referenced by path plus a fingerprint, never embedded as blobs; the text of a
//! LUT imported into the project is a blob (`Lut.data`). Every field named by the schema
//! (`model/schema.json`) merges at that field's own grain: the collections a person edits a piece
//! at a time are objects and containers of their own (markers, caption tracks and captions, an
//! effect's parameters by id, master effects, transcripts, source graphics, LUTs, search bins —
//! see [`objects`]), and text a person types (a marker's comment, a caption's text) is a text
//! field (a draft that typed in a text the document also changed does not merge, rule D5). The rest round-trips through an opaque `json` register next to it (`Item.props`,
//! `Clip.props`/`gain`, `Track.props`, `Sequence.settings`/`mixer`, an effect's masks and layer
//! data) — last-writer-wins as a whole, but nothing is lost. See [`props`] for exactly what lives
//! where.
//!
//! **Tick range.** `Clip.start`/`duration`/`sourceIn` and `Transition.start`/`duration` are the
//! fields the repair pass (`validate`) and a draft's trims/ripples merged beside the document's reason about byte-exactly, so
//! they are written as decimal-string registers (`"start": "12345"`), not KDM `integer` registers:
//! a KDM `integer` (and in fact *any* JSON number anywhere in a replica, including inside a `json`
//! register — `kition_kdm::schema::unportable`) is rejected once its magnitude passes ±2^53, which
//! at `kition_film_time::TICKS_PER_SECOND` (254 016 000 000) is about 9.85 hours. A decimal string
//! has no such limit; a marker's and a caption's `start`/`duration` are written the same way.
//! Every *other* `Tick` this crate writes (keyframe times, mark in/out, frame holds, transcript
//! word times…) stays the engine's own raw JSON number, inside an opaque `json` value: this is a
//! known, deliberately scoped residual risk — such a field fails loudly (`Err`, not silent
//! corruption or a panic) if a project ever needs one past ~9.85 hours.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

mod compare;
mod edits;
mod ids;
mod objects;
mod props;
mod read;
mod session;
mod settle;
mod tick;
mod validate;
mod write;

use std::collections::BTreeSet;
use std::sync::Arc;

use kition_kit::kdm::{ActorId, KdmError, ObjectId, Replica, Schema, Tx};
use kition_kit::session::{BlobSink, BlobSource, Damage, KitError, KitModel};

pub use compare::normalize;
pub use edits::check_model_edits;
pub use ids::{Ids, Known};
pub use read::read_document;
pub use session::{FilmSession, decode_blobs, encode_blobs, slot_base};
pub use settle::settle_batch;
pub use write::write_changes;
pub use write::{replace_document, write_document};

/// Re-exported so downstream crates (the engine command bridge) share this crate's exact pin,
/// rather than taking their own dependency on `kition-sdk` that could drift from it.
pub use kition_kit;

type Result<T> = kition_kit::session::Result<T>;

const SCHEMA: &str = include_str!("../model/schema.json");

/// The `Project` object's id: one per replica, minted by [`write_document`] with
/// [`kition_kit::kdm::Tx::create_with_id`], so every reader finds it without an index.
pub(crate) fn project_id() -> ObjectId {
    ObjectId::from_string("project")
}

/// The root `Bin` object's id: the sole top-level node of the `Project.bins` tree, matching
/// [`kition_film_project::Project::root`] (which is itself one named bin, not a tree root with no
/// object of its own).
pub(crate) fn root_bin_id() -> ObjectId {
    ObjectId::from_string("rootBin")
}

/// A tree node a later diff needs to move or recurse into, keyed by the object it names (bins
/// cannot be read back from a `Tx`, so [`write::write_document`] and [`write::write_changes`]
/// keep this alongside [`Ids`]).
pub type Nodes = std::collections::HashMap<ObjectId, kition_kit::kdm::NodeRef>;

/// Wraps a [`KdmError`] (or anything else `Display`s) as a [`KitError`].
fn kit_err(error: impl std::fmt::Display) -> KitError {
    KitError::new(error.to_string())
}

/// Wraps anything `Display`s (a `serde_json::Error`, a `ParseIntError`, …) as a [`KdmError`], for
/// the helper modules that write and read through a `Tx`/`Replica` and so return [`KdmError`]
/// directly (this crate's `KitModel` methods then convert it once with [`kit_err`]).
pub(crate) fn kdm_err(error: impl std::fmt::Display) -> KdmError {
    KdmError::Engine(error.to_string())
}

/// The engine's view of a `kit.film` replica: the same [`kition_film_project::Project`] the rest of
/// the engine knows, plus the id maps [`write::write_changes`] needs to find each object again.
pub struct FilmModel {
    pub project: kition_film_project::Project,
    ids: Ids,
    nodes: Nodes,
    known: Known,
}

impl FilmModel {
    /// A view built by the caller itself: `project` as written by [`write_document`] or
    /// [`write::write_changes`], with the maps they filled.
    pub fn from_parts(project: kition_film_project::Project, ids: Ids, nodes: Nodes) -> Self {
        let mut known = Known::default();
        known.remember(&project, &ids);
        Self { project, ids, nodes, known }
    }

    /// Replaces the view after the caller wrote `project` to the replica itself (a diff bridge's
    /// `write_changes`), with the maps that write left.
    pub fn adopt(&mut self, project: kition_film_project::Project, ids: Ids, nodes: Nodes) {
        self.known.remember(&project, &ids);
        self.project = project;
        self.ids = ids;
        self.nodes = nodes;
    }

    /// The id maps, current as of the last `load`/`apply`. `KitSession::execute` hands the bridge
    /// only `&FilmModel`, so a diff bridge clones this (and [`FilmModel::nodes`]) into its own
    /// working copy to mutate while building a `write_changes` transaction; `apply` rebuilds both
    /// from the replica after the transaction commits, so nothing needs writing back.
    pub fn ids(&self) -> &Ids {
        &self.ids
    }

    /// The tree node of every `Bin` object this view knows, current as of the last `load`/`apply`.
    /// See [`FilmModel::ids`].
    pub fn nodes(&self) -> &Nodes {
        &self.nodes
    }
}

impl std::fmt::Debug for FilmModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilmModel").field("project", &self.project).finish_non_exhaustive()
    }
}

impl KitModel for FilmModel {
    fn schema() -> Arc<Schema> {
        #[allow(clippy::expect_used)]
        Arc::new(Schema::parse(SCHEMA).expect("model/schema.json is a fixed, tested file"))
    }

    fn load(replica: &Replica, blobs: &dyn BlobSource) -> Result<Self> {
        let (project, ids, nodes) = read::read_document_known(replica, &Known::default(), blobs).map_err(kit_err)?;
        Ok(Self::from_parts(project, ids, nodes))
    }

    /// This phase always reloads the whole view rather than patching the changed objects in
    /// place: a correct, simple fallback the `KitModel` contract itself allows (`KitSession`
    /// already reloads whenever `apply` cannot patch), and the id-continuity this still gives
    /// through `known` (a surviving object keeps its local id) is the part that matters for a
    /// session's own state. Task 2 (the engine command bridge) can tighten this to real
    /// incremental damage if it turns out to matter for interactive performance.
    ///
    /// The id counter never goes down within this actor's slot: an id this replica handed out may
    /// be gone from the view (deleted by a merged draft or an import, or undone) yet still live in an
    /// undo or redo step, so minting it again would give two things one id.
    fn apply(&mut self, replica: &Replica, _changed: &BTreeSet<ObjectId>, blobs: &dyn BlobSource) -> Result<Damage> {
        let (mut project, ids, nodes) = read::read_document_known(replica, &self.known, blobs).map_err(kit_err)?;
        let slot = slot_base(replica.actor());
        if (slot..slot.saturating_add(session::SLOT_SIZE)).contains(&self.project.next_id) {
            project.next_id = project.next_id.max(self.project.next_id);
        }
        self.project = project;
        self.ids = ids;
        self.nodes = nodes;
        self.known.remember(&self.project, &self.ids);
        Ok(Damage::Full)
    }

    fn validate(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> Result<bool> {
        validate::validate(tx, changed).map_err(kit_err)
    }

    fn import(_name: &str, bytes: &[u8], blobs: &mut dyn BlobSink, actor: ActorId) -> Result<Replica> {
        let loaded = kition_film_format::decode(bytes).map_err(kit_err)?;
        session::put_luts(&loaded.project, blobs);
        let mut ids = Ids::default();
        let mut nodes = Nodes::default();
        let (replica, ()) = Replica::create_with(Self::schema(), kition_kit::kdm::DocId::new(), actor, &kition_kit::kdm::Origin::system("import"), |tx| {
            write::write_document(tx, &loaded.project, &mut ids, &mut nodes)?;
            Ok(())
        })
        .map_err(kit_err)?;
        Ok(replica)
    }

    fn export(&self, _replica: &Replica, _name: &str, _blobs: &dyn BlobSource) -> Result<Vec<u8>> {
        Ok(kition_film_format::encode(&self.project, true))
    }
}
