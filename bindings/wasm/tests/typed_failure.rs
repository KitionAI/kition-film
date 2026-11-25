//! Why a command did not run is typed (`kition_kit::failure`, task card C8-film), so a host
//! answers its error code without reading the wording: an unknown command is
//! `command_not_found`, one that cannot run now `command_disabled`, wrong parameters and a call
//! context the project lacks `invalid_params`. A message whose words would mislead a guess (an
//! invalid parameter whose text says "not available") is still told by its reason.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use kition_kit::failure::{CommandFailure, parse_failure};
use kition_kit::kdm::Origin;
use serde_json::json;

fn project() -> FilmDocument {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let matte = doc.execute("item.newColorMatte", json!({ "color": "#ff0000", "seconds": 2 })).unwrap();
    doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0 })).unwrap();
    doc
}

fn reason(error: &str) -> CommandFailure {
    parse_failure(error).unwrap_or_else(|| panic!("no typed reason in {error:?}")).1
}

#[test]
fn a_commands_failure_carries_its_reason() {
    let mut doc = project();
    assert_eq!(reason(&doc.execute("timeline.noSuchCommand", json!({})).unwrap_err()), CommandFailure::NotFound);
    assert_eq!(
        reason(&doc.execute("effect.setParam", json!({ "effect": "opacity", "param": "opacity", "value": 1 })).unwrap_err()),
        CommandFailure::InvalidParams
    );
    // A parameter the command does not take (named with the one it resembles).
    let unknown = doc.execute("effect.setParam", json!({ "clipz": 1 })).unwrap_err();
    assert_eq!(reason(&unknown), CommandFailure::InvalidParams);
    assert!(unknown.contains("did you mean `clip`"), "{unknown}");
    // Nothing selected: the command cannot run now.
    doc.execute("timeline.select", json!({ "clips": [] })).unwrap();
    assert_eq!(reason(&doc.execute("clip.enable", json!({})).unwrap_err()), CommandFailure::Disabled);
    let agent = Origin::agent("user:test");
    assert_eq!(reason(&doc.execute_as("timeline.noSuchCommand", json!({}), &agent).unwrap_err()), CommandFailure::NotFound);
}

#[test]
fn a_call_context_the_project_lacks_is_invalid_params() {
    let mut doc = project();
    for context in
        [json!({ "time": 600 }), json!({ "on": [9_999] }), json!({ "part": { "sequence": 9_999 } }), json!({ "part": { "slide": 1 } }), json!({ "on": ["x"] })]
    {
        let context: kition_kit::CallContext = serde_json::from_value(context.clone()).unwrap();
        let error = doc.set_context(&context).unwrap_err();
        assert_eq!(reason(&error), CommandFailure::InvalidParams, "{error}");
    }
}
