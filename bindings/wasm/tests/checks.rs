//! `film_check` against its catalogue (`agent/checks.json`, KHP A38): every fixture in
//! `conformance/` (written by `examples/checks.rs`) reports its code when opened, every
//! code it reports is catalogued, and `basic.kfilm` reports nothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]

use std::path::Path;

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::Value;

fn repo() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn check(fixture: &str) -> Vec<kition_kit::diagnostics::Diagnostic> {
    let bytes = std::fs::read(repo().join("conformance").join(fixture)).unwrap_or_else(|error| panic!("{fixture}: {error}"));
    FilmDocument::open(fixture, &bytes).unwrap_or_else(|error| panic!("{fixture}: {error}")).check()
}

#[test]
fn every_fixture_reports_its_code() {
    let catalogue: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(repo().join("agent/checks.json")).unwrap()).unwrap();
    let codes: Vec<&str> = catalogue.iter().map(|entry| entry["code"].as_str().unwrap()).collect();
    let mut failures = Vec::new();
    for entry in &catalogue {
        let (code, fixture) = (entry["code"].as_str().unwrap(), entry["fixture"].as_str().unwrap());
        let found = check(fixture);
        if !found.iter().any(|d| d.code == code && serde_json::to_value(d.severity).unwrap() == entry["severity"]) {
            failures.push(format!("{fixture} does not report {code}: {:?}", found.iter().map(|d| &d.code).collect::<Vec<_>>()));
        }
        for d in &found {
            if !codes.contains(&d.code.as_str()) {
                failures.push(format!("{fixture} reports {} outside the catalogue", d.code));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn the_basic_fixture_is_clean() {
    let found: Vec<String> = check("basic.kfilm").into_iter().map(|d| d.code).collect();
    assert_eq!(found, Vec::<String>::new());
}

/// The fixes repair what they say: `sequence.closeGap` closes the gap and `clip.enable` enables the
/// clip, so the check no longer reports them.
#[test]
fn the_fixes_repair_the_gap_and_the_disabled_clip() {
    for (fixture, code) in [("check-gap.kfilm", "film.gap"), ("check-disabled-clip.kfilm", "film.disabled-clip")] {
        let bytes = std::fs::read(repo().join("conformance").join(fixture)).unwrap();
        let mut doc = FilmDocument::open(fixture, &bytes).unwrap();
        let fix = doc.check().into_iter().find(|d| d.code == code).and_then(|d| d.fix).unwrap_or_else(|| panic!("{fixture}: a fix"));
        doc.execute(&fix.command, fix.params.clone().unwrap_or_default()).unwrap_or_else(|error| panic!("{fixture}: {error}"));
        assert!(!doc.check().iter().any(|d| d.code == code), "{fixture}: {:?}", doc.check());
    }
}
