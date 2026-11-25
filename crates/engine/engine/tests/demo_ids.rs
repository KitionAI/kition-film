//! The demo project takes every id from the project's counter, so a saved demo reopens: the
//! file's id check refuses a counter at or below an id the project holds, and the demo once
//! placed its transitions and markers at fixed ids far past the counter.

use kition_film_engine::Session;
use serde_json::json;

fn demo() -> Session {
    let mut s = Session::default();
    s.execute("file.openDemoProject", json!({})).unwrap();
    s
}

#[test]
fn the_demo_counter_is_past_every_id_it_holds() {
    let s = demo();
    let floor = s.project.minimum_next_id(true).unwrap();
    assert!(s.project.next_id >= floor, "demo next_id {} would reuse an existing id (minimum {floor})", s.project.next_id);
}

#[test]
fn a_saved_demo_reopens() {
    let dir = std::env::temp_dir().join(format!("kition-film-demo-ids-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("demo.kfilm").to_string_lossy().to_string();
    let mut s = demo();
    s.execute("file.saveAs", json!({ "path": path })).unwrap();
    let mut t = Session::default();
    let opened = t.execute("file.open", json!({ "path": path }));
    std::fs::remove_dir_all(&dir).ok();
    opened.unwrap();
    // The file's id counter is the first id past every id the demo holds; the session's own is
    // no smaller.
    let mut content = (*s.project).clone();
    content.next_id = content.minimum_next_id(true).unwrap();
    assert!(s.project.next_id >= content.next_id);
    assert_eq!(*t.project, content);
}
