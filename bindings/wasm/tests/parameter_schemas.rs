//! Every command's parameter schema is a well-formed ParameterSchemaSpec (KHP E7, A5): in
//! particular every object node, however deep (a property, an array's items, a oneOf branch),
//! states `additionalProperties`, so hosts and agents know whether it takes keys it does not name
//! (kition-sdk `schema::validate`, the rule Kition's `check:kit-modules` applies).
#![allow(clippy::unwrap_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;

fn document() -> FilmDocument {
    FilmDocument::open("basic.kfilm", &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/basic.kfilm")).unwrap()).unwrap()
}

#[test]
fn every_command_schema_is_well_formed() {
    let problems: Vec<String> = document()
        .commands()
        .iter()
        .filter_map(|command| {
            let schema = command.schema.as_ref()?;
            kition_kit::schema::validate(schema).err().map(|error| format!("{}: {error}", command.id))
        })
        .collect();
    assert!(problems.is_empty(), "{} commands:\n{}", problems.len(), problems.join("\n"));
}
