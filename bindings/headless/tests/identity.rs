//! `document.identity` and `document.fork` (Kit Process Protocol section 5.6, KitModel M7a)
//! through the real `kition-film` process: a `.kfilm` is the project as JSON (the envelope
//! `kition_film_format::encode_with_view` writes) and embeds no replica; the kit makes one under a
//! new id each time it opens a file (`FilmModel::import`). So a file carries no identity, and a
//! fork is the same bytes with no id, written to a new file only.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use kition_kit_host::{HeadlessKit, LaunchOptions};

const LIMIT: Duration = Duration::from_secs(30);

fn workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kition-film-identity-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

async fn launch(dir: &Path) -> HeadlessKit {
    let mut options = LaunchOptions::new(env!("CARGO_BIN_EXE_kition-film"));
    options.workspace = Some(dir.to_path_buf());
    HeadlessKit::launch(options).await.unwrap()
}

/// A saved project: one sequence, as a person's first save writes it.
fn film() -> Vec<u8> {
    FilmDocument::create("Cut.kfilm", 1920, 1080).unwrap().save(None).unwrap()
}

#[tokio::test]
async fn a_film_carries_no_identity_and_forks_into_the_same_bytes() {
    let dir = workspace("plain");
    let bytes = film();
    std::fs::write(dir.join("Cut.kfilm"), &bytes).unwrap();
    // An empty `.kfilm` (a file made for the kit before it saved a project there).
    std::fs::write(dir.join("New.kfilm"), b"").unwrap();
    let kit = launch(&dir).await;
    assert!(kit.serves("document.identity"), "{}", kit.capabilities());

    // No file carries an identity, a byte copy neither.
    std::fs::copy(dir.join("Cut.kfilm"), dir.join("Copy.kfilm")).unwrap();
    for path in ["Cut.kfilm", "Copy.kfilm", "New.kfilm"] {
        assert_eq!(kit.identity(path, LIMIT).await.unwrap().doc_id, None, "{path} embeds no replica");
    }

    // A fork is the same bytes, with no id, in a new file that opens as the project.
    let fork = kit.fork("Cut.kfilm", "Fork.kfilm", LIMIT).await.unwrap();
    assert_eq!(fork.doc_id, None);
    assert_eq!(fork.name, "Fork.kfilm");
    assert!(!fork.version.is_empty());
    assert_eq!(std::fs::read(dir.join("Fork.kfilm")).unwrap(), bytes, "a file without a replica forks unchanged");
    assert_eq!(std::fs::read(dir.join("Cut.kfilm")).unwrap(), bytes, "the source is unchanged");
    let state = kit.open("Fork.kfilm", true, LIMIT).await.unwrap();
    assert!(state["documentId"].is_string(), "{state}");
    let empty = kit.fork("New.kfilm", "NewCopy.kfilm", LIMIT).await.unwrap();
    assert_eq!(empty.doc_id, None);
    assert_eq!(std::fs::read(dir.join("NewCopy.kfilm")).unwrap(), b"");

    // A fork never replaces a file.
    let taken = kit.fork("Copy.kfilm", "Fork.kfilm", LIMIT).await.unwrap_err();
    assert_eq!(taken.reason(), Some("file_conflict"), "{taken}");
    assert_eq!(std::fs::read(dir.join("Fork.kfilm")).unwrap(), bytes, "the first fork is kept");
    kit.shutdown(Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(dir);
}
