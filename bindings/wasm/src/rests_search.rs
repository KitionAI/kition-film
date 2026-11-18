//! Search results consume displayed column text and candidate order, including
//! candidates that stopped matching before an outside file was reread.
use kition_film_engine::{
    Session,
    project::{
        ItemKind,
        find::{COLUMNS, column_text},
    },
};
use kition_kit::{ContentAsk, ContentPremise, Under, kdm::projection::ProjectedObject};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) fn column_key(column: &str) -> String {
    use std::fmt::Write;
    let mut key = String::from("c");
    for byte in column.to_ascii_lowercase().bytes() {
        let _ = write!(key, "{byte:02x}");
    }
    key
}

fn columns(params: &Value) -> Vec<String> {
    let row = |row: &Value| {
        row.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()).map(|_| row.get("column").and_then(Value::as_str).unwrap_or("All").to_owned())
    };
    match params.get("rows").and_then(Value::as_array) {
        Some(rows) => rows.iter().filter_map(row).collect(),
        None => row(params).into_iter().collect(),
    }
}

pub fn complete(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    let columns = match command {
        "file.newSearchBin" => columns(params),
        "project.editSearchBin" => {
            let id = params.get("bin").and_then(Value::as_u64)?;
            let bin = session.project.search_bins.iter().find(|bin| bin.id.0 == id)?;
            if params.get("rows").is_some() || params.get("text").is_some() {
                columns(params)
            } else {
                bin.query.rows.iter().filter(|row| !row.text.is_empty()).map(|row| row.column.clone()).collect()
            }
        }
        _ => return under,
    };
    let mut answer = under.unwrap_or_default();
    let mut fields = Vec::new();
    if !columns.is_empty() {
        fields.push("order".to_owned());
        for item in session.project.items.values().filter(|item| !matches!(item.kind, ItemKind::Graphic { .. })) {
            for column in &columns {
                let suffix = if column.is_empty() || column.eq_ignore_ascii_case("all") { "all".to_owned() } else { format!("columns.{}", column_key(column)) };
                fields.push(format!("items.i{}.{suffix}", item.id.0));
            }
        }
    }
    if !fields.is_empty() {
        fields.sort();
        fields.dedup();
        answer.content.push(ContentPremise { id: json!("film:search-premises"), field: "~project".into(), region: json!(fields) });
    }
    Some(answer)
}

pub fn content(session: &Session, ask: &ContentAsk) -> Option<bool> {
    if ask.premise.id != "film:search-premises" || ask.premise.field != "~project" {
        return None;
    }
    let fields = ask.premise.region.as_array()?;
    let current = derived(session, &[json!("film:search-premises")], &["project".into()])?;
    let value = |root: &Value, path: &str| -> Value { path.split('.').try_fold(root, |value, key| value.get(key)).cloned().unwrap_or(Value::Null) };
    let now = current.values.get("project")?;
    Some(fields.iter().any(|field| field.as_str().is_none_or(|field| value(&ask.before, field) != value(now, field))))
}

pub fn object() -> ProjectedObject {
    ProjectedObject { id: "film:search-premises".into(), ty: "SearchPremises".into(), fields: Default::default(), at: None }
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Option<kition_kit::DerivedValues> {
    if (!ids.is_empty() && !ids.iter().any(|id| id == "film:search-premises")) || (!names.is_empty() && !names.iter().any(|name| name == "project")) {
        return None;
    }
    let project = &session.project;
    let mut order = Vec::new();
    project.root.all_items(&mut order);
    for id in project.items.keys() {
        if !order.contains(id) {
            order.push(*id);
        }
    }
    order.retain(|id| project.item(*id).is_some_and(|item| !matches!(item.kind, ItemKind::Graphic { .. })));
    let items: serde_json::Map<_, _> = project
        .items
        .values()
        .filter(|item| !matches!(item.kind, ItemKind::Graphic { .. }))
        .map(|item| {
            let columns: BTreeSet<_> =
                COLUMNS[1..].iter().copied().chain(["type", "duration", "path"]).chain(item.metadata.keys().map(String::as_str)).collect();
            let values: serde_json::Map<_, _> = columns.into_iter().map(|column| (column_key(column), json!(column_text(project, item, column)))).collect();
            let all: Vec<_> = COLUMNS[1..].iter().map(|column| column_text(project, item, column)).chain(item.metadata.values().cloned()).collect();
            (format!("i{}", item.id.0), json!({"columns":values,"all":all}))
        })
        .collect();
    Some(kition_kit::DerivedValues {
        id: json!("film:search-premises"),
        values: serde_json::Map::from_iter([("project".into(), json!({"order":order,"items":items}))]),
    })
}
