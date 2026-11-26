//! `.kfilm` save/open through the command interface: the versioned envelope, Save a Copy,
//! Revert.

use super::*;
use serde_json::json;

fn demo() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("fc-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn saved_file_is_versioned_and_save_copy_keeps_state() {
    let d = temp_dir("schema");
    let path = d.join("p.kfilm").to_string_lossy().to_string();
    let mut s = demo();
    s.execute("file.saveAs", json!({"path": path})).unwrap();
    let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(v["schema_version"], kition_film_format::SCHEMA_VERSION);
    assert_eq!(v["format"], "kition-film.project");
    s.execute("sequence.addEdit", json!({"seconds": 1.0})).unwrap();
    assert!(s.is_dirty());
    let copy = d.join("copy.kfilm").to_string_lossy().to_string();
    s.execute("file.saveCopy", json!({"path": copy})).unwrap();
    assert!(s.is_dirty(), "Save a Copy leaves the project unsaved");
    assert_eq!(s.path.as_deref(), Some(path.as_str()));
    let mut t = Session::default();
    t.execute("file.open", json!({"path": copy})).unwrap();
    // The copy holds the whole project and its id counter as the file states it, the first id
    // past every id the project holds (`encode_file`); the session's own counter (which may run
    // ahead, or in its replica's id range) is the session's and not saved.
    let content = crate::file_tests::as_saved(&s.project);
    assert!(s.project.next_id >= content.next_id, "the session never hands out an id the copy holds");
    assert_eq!(*t.project, content);
    // Revert discards the edit.
    s.execute("file.revert", json!({})).unwrap();
    assert!(!s.is_dirty());
    assert_ne!(*t.project, *s.project);
    assert!(!Session::default().is_enabled("file.revert"), "nothing to revert to before a save");
    // No temp files left next to the project.
    let stray: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(stray.is_empty());
    let _ = std::fs::remove_dir_all(&d);
}

/// A saved project file opens; a file of another format version is refused clearly, and no
/// backup or upgrade is made.
#[test]
fn project_file_opens_and_other_versions_are_refused() {
    let d = temp_dir("versions");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../formats/format/tests/fixtures/edit.kfilm");
    let path = d.join("edit.kfilm");
    std::fs::copy(&fixture, &path).unwrap();
    let p = path.to_string_lossy().to_string();
    let mut s = Session::default();
    let r = s.execute("file.open", json!({"path": p})).unwrap();
    assert_eq!(r["schemaVersion"], 1);
    assert_eq!(s.project.name, "Legacy Edit");
    let r = s.execute("file.save", json!({})).unwrap();
    assert!(r.get("backup").is_none(), "{r}");
    let saved = std::fs::read(&path).unwrap();
    assert!(saved.starts_with(b"{\"format\""), "the file is compact");
    let mut v: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(v["schema_version"], kition_film_format::SCHEMA_VERSION);
    for version in [kition_film_format::SCHEMA_VERSION + 1, 13] {
        v["schema_version"] = json!(version);
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        let e = Session::default().execute("file.open", json!({"path": p})).unwrap_err().to_string();
        assert!(e.contains("reads version 1 only"), "{e}");
    }
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "no backup next to the file");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn project_is_named_after_its_file() {
    let d = temp_dir("name");
    let mut s = demo();
    let a = d.join("Apollo 11 - Tranquility.kfilm").to_string_lossy().to_string();
    s.execute("file.saveAs", json!({"path": a})).unwrap();
    assert_eq!(s.project.name, "Apollo 11 - Tranquility");
    assert_eq!(s.project.root.name, "Apollo 11 - Tranquility");
    assert!(!s.is_dirty(), "renaming on Save As is not an edit");
    // Save a Copy keeps the current name.
    let c = d.join("Backup copy.kfilm").to_string_lossy().to_string();
    s.execute("file.saveCopy", json!({"path": c})).unwrap();
    assert_eq!(s.project.name, "Apollo 11 - Tranquility");
    s.execute("file.open", json!({"path": c})).unwrap();
    assert_eq!(s.project.name, "Apollo 11 - Tranquility");
    let _ = std::fs::remove_dir_all(&d);
}

/// `project` as its file holds it (`kition_film_format::encode_file`): its id counter is the first
/// id past every id it holds, not the session's own (which may run ahead, or in its replica's id
/// range). What a project saved and opened again equals. (Here, not in `lib.rs`, whose source the
/// declarations' comparisons pin.)
pub(crate) fn as_saved(project: &kition_film_project::Project) -> kition_film_project::Project {
    let mut content = project.clone();
    if let Some(counter) = content.minimum_next_id(true) {
        content.next_id = counter;
    }
    content
}
