//! Every command says what it does and every reading command an agent is offered declares what it
//! answers (kition-sdk `check_commands`); run on conformance/basic.kfilm, the reading
//! commands' answers match their output schemas (`bindings/wasm/src/outputs.json`).
#![allow(clippy::unwrap_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn project() -> FilmDocument {
    FilmDocument::open("basic.kfilm", &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/basic.kfilm")).unwrap()).unwrap()
}

fn matches(schema: &Value, value: &Value) -> Result<(), String> {
    match schema["type"].as_str() {
        Some("json") | None => Ok(()),
        Some("object") => match value.as_object() {
            Some(object) => kition_kit::schema::check_params(&schema["properties"], object),
            None => Err(format!("expected an object, got {value}")),
        },
        Some("array") => value.is_array().then_some(()).ok_or_else(|| format!("expected an array, got {value}")),
        Some("boolean") => value.is_boolean().then_some(()).ok_or_else(|| format!("expected a boolean, got {value}")),
        Some("integer") => value.is_i64().then_some(()).or(value.is_u64().then_some(())).ok_or_else(|| format!("expected an integer, got {value}")),
        Some("number") => value.is_number().then_some(()).ok_or_else(|| format!("expected a number, got {value}")),
        Some("string") => value.is_string().then_some(()).ok_or_else(|| format!("expected a string, got {value}")),
        Some(other) => Err(format!("unknown output type {other}")),
    }
}

#[test]
fn every_command_is_described_and_reading_commands_answer_their_output_schema() {
    let commands = project().commands();
    kition_kit::testing::check_commands(&commands, kition_film_kit::descriptions::NO_OUTPUT).unwrap();
    let mut checked = 0;
    for command in commands.iter().filter(|command| !command.mutates && command.schema.is_some()) {
        let Some(schema) = &command.output_schema else { continue };
        kition_kit::schema::validate_output(schema).unwrap_or_else(|error| panic!("{}: {error}", command.id));
        if let Ok(answer) = project().execute(&command.id, json!({}))
            && !answer.is_null()
        {
            matches(schema, &answer).unwrap_or_else(|error| panic!("{}: {error}", command.id));
            checked += 1;
        }
    }
    assert!(checked > 40, "only {checked} reading commands answered with no parameters");
}

/// Edit Original only answers the media paths for the host to open, so it is a read command (no undo
/// step, read-only to agents) with an output schema.
#[test]
fn edit_original_is_a_read_command_with_an_output() {
    let commands = project().commands();
    let Some(command) = commands.iter().find(|command| command.id == "edit.editOriginal") else {
        panic!("edit.editOriginal is listed");
    };
    assert!(!command.mutates, "edit.editOriginal changes nothing");
    assert!(command.output_schema.is_some(), "edit.editOriginal declares {{paths}}");
}
