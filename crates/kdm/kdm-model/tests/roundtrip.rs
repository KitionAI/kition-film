//! Round trip of every `.kfilm` fixture in the repository: import -> load -> export -> decode
//! equal to the original `Project`, ignoring ids (every `BinId`/`ItemId`/`TrackId`/`ClipId`/
//! `TransitionId` is freshly minted on load, never a stable identity — see `kdm_model::normalize`).

use kdm_model::FilmModel;
use kition_kit::kdm::ActorId;
use kition_kit::session::{KitModel, MemoryBlobs};

/// Compares as the JSON each project would serialize to, not the raw struct: an "auto" point is
/// `f64::NAN`, never equal to itself under `PartialEq`, but always the same JSON `null`.
fn assert_same_content(a: &kition_film_project::Project, b: &kition_film_project::Project, message: &str) {
    let left = serde_json::to_value(kdm_model::normalize(a)).unwrap_or_else(|error| panic!("serializing: {error}"));
    let right = serde_json::to_value(kdm_model::normalize(b)).unwrap_or_else(|error| panic!("serializing: {error}"));
    assert_eq!(left, right, "{message}");
}

fn fixtures() -> Vec<std::path::PathBuf> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut found = Vec::new();
    for dir in ["crates/formats/format/tests/fixtures", "web/public/sample/films"] {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("kfilm") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

#[test]
fn every_kition_film_fixture_round_trips_ignoring_ids() {
    let fixtures = fixtures();
    assert!(!fixtures.is_empty(), "no .kfilm fixtures found to round-trip");
    for path in fixtures {
        let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        let original = kition_film_format::decode(&bytes).unwrap_or_else(|error| panic!("decoding {}: {error}", path.display())).project;

        let mut blobs = MemoryBlobs::default();
        let replica = FilmModel::import(path.to_str().unwrap_or_default(), &bytes, &mut blobs, ActorId::from_u64(1).unwrap_or_else(|error| panic!("{error}")))
            .unwrap_or_else(|error| panic!("import {}: {error}", path.display()));

        let model = FilmModel::load(&replica, &blobs).unwrap_or_else(|error| panic!("load {}: {error}", path.display()));
        assert_same_content(&original, &model.project, &format!("{}: the loaded project differs from the original (ignoring ids)", path.display()));

        let exported = model.export(&replica, "roundtrip.kfilm", &blobs).unwrap_or_else(|error| panic!("export {}: {error}", path.display()));
        let reloaded = kition_film_format::decode(&exported).unwrap_or_else(|error| panic!("decoding exported {}: {error}", path.display())).project;
        assert_same_content(&original, &reloaded, &format!("{}: the exported project differs from the original (ignoring ids)", path.display()));
    }
}
