//! A command refuses a parameter its schema does not name, saying which, instead of running
//! without it (engine rule E7a, kit requirement AX15).
#![allow(clippy::unwrap_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

fn project() -> FilmDocument {
    FilmDocument::open("basic.kfilm", &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/basic.kfilm")).unwrap()).unwrap()
}

#[test]
fn every_command_refuses_a_parameter_it_does_not_take() {
    if let Err(problems) = kition_kit::testing::check_unknown_params(project, &[]) {
        panic!("{} commands:\n{}", problems.len(), problems.join("\n"));
    }
}

#[test]
fn a_misspelled_parameter_names_the_one_it_resembles_and_changes_nothing() {
    let mut doc = project();
    let before = doc.inspect().unwrap();
    let error = doc.execute("marker.filterColors", json!({ "colour": "red", "visible": false })).unwrap_err();
    assert!(error.contains("`colour`") && error.contains("did you mean `color`"), "{error}");
    assert_eq!(doc.inspect().unwrap(), before);
    // Either form of the command's parameters is a valid call.
    doc.execute("marker.filterColors", json!({ "color": "violet", "visible": false })).unwrap();
}
