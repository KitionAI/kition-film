//! project_tools.rs:455-478,486-511; project/find.rs:111-200.
//! Reading correction, without changing the blind rows: New Search Bin and
//! Edit Search Bin return search_bin_json, whose items are query.find(project).
//! They therefore consume matching columns and Project-panel candidate order.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind};
use kition_film_kit::FilmDocument;
use kition_kit::{ContentPremise, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("file.newSearchBin", "new"), ("project.editSearchBin", "existing by ID"), ("project.deleteSearchBin", "existing by ID")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0xf8d2f12928fa34b4
        && hash(include_str!("../../../../crates/engine/project/src/find.rs")) == 0x7ed1d41343dde15f
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "project.deleteSearchBin" {
        return vec![];
    }
    let mut out = vec!["coarse-search-column-text", "unmatched-search-candidate-order"];
    if command == "file.newSearchBin" {
        out.push("unconsumed-program-material");
    }
    out
}
fn key(column: &str) -> String {
    format!("c{}", column.to_ascii_lowercase().bytes().map(|byte| format!("{byte:02x}")).collect::<String>())
}

#[test]
fn search_bins_compare_live_results_query_precedence_column_spellings_and_full_removed_entries() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let source = doc.execute("file.newColorMatte", json!({"name":"Needle","seconds":2})).unwrap()["item"].as_u64().unwrap();
        let bin = doc.execute("file.newSearchBin", json!({"name":"Saved","column":"Name","text":"Needle"})).unwrap()["bin"].as_u64().unwrap();
        if populated {
            doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
            doc.execute("playhead.set", json!({"time":time})).unwrap();
            let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                assert!(
                    spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.reads.is_empty()
                );
                assert!(
                    spec.places.is_empty()
                        && spec.name_params.is_empty()
                        && spec.name_field.is_none()
                        && spec.index.is_none()
                        && !spec.index_numbers
                        && !spec.index_reversed
                );
                for column in [
                    "Name",
                    "NAME",
                    "Label",
                    "All",
                    "",
                    "Video Info",
                    "Audio Info",
                    "Frame Rate",
                    "Media Duration",
                    "File Path",
                    "type",
                    "duration",
                    "path",
                    "custom.[/]",
                ] {
                    for rows in [false, true] {
                        for replacement in [false, true] {
                            let mut p = if command == "file.newSearchBin" || replacement {
                                json!({"bin":bin,"name":"Agent","column":column,"text":"Needle"})
                            } else {
                                json!({"bin":bin,"name":"Agent"})
                            };
                            if rows && replacement {
                                p["rows"] = json!([{"column":column,"text":"Needle"},{"column":"Scene","text":""},{"column":"Name","text":"other"}]);
                            }
                            let mut want = Under::default();
                            if command == "file.newSearchBin" {
                                for track in q.all_tracks() {
                                    let from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
                                    let to = track.items.iter().take_while(|clip| clip.start.0 <= at).count().max(from);
                                    want.objects.extend(track.items[from..to].iter().map(|clip| json!(clip.id.0)));
                                    want.within.push(Within {
                                        parent: json!(track.id.0),
                                        field: "clips".into(),
                                        from,
                                        to,
                                        time: Some(TimeSpan {
                                            from: json!(at.to_string()),
                                            to: json!(at.to_string()),
                                            start: "start".into(),
                                            duration: Some("duration".into()),
                                            identity: None,
                                            end: None,
                                        }),
                                    });
                                }
                            } else {
                                want.objects.push(json!("project"));
                                want.premises.push(Premise::on(json!("project")).fields([format!("docState.search_bins[id={bin}]")]));
                            }
                            if command != "project.deleteSearchBin" {
                                let columns: Vec<_> = if let Some(rows) = p["rows"].as_array() {
                                    rows.iter()
                                        .filter(|row| row["text"].as_str().is_some_and(|text| !text.is_empty()))
                                        .map(|row| row["column"].as_str().unwrap_or("All"))
                                        .collect()
                                } else if p.get("text").is_some() {
                                    vec![column]
                                } else {
                                    vec!["Name"]
                                };
                                let mut fields = vec!["order".to_owned()];
                                for item in project.items.values().filter(|item| !matches!(item.kind, ItemKind::Graphic { .. })) {
                                    for column in &columns {
                                        fields.push(if column.is_empty() || column.eq_ignore_ascii_case("all") {
                                            format!("items.i{}.all", item.id.0)
                                        } else {
                                            format!("items.i{}.columns.{}", item.id.0, key(column))
                                        });
                                    }
                                }
                                fields.sort();
                                fields.dedup();
                                want.content.push(ContentPremise { id: json!("film:search-premises"), field: "~project".into(), region: json!(fields) });
                            }
                            assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/time={time}");
                        }
                    }
                }
            }
        }
        let facts = doc.derived(&[json!("film:search-premises")], &["project".into()]).unwrap();
        let search = facts.iter().find(|fact| fact.id == "film:search-premises").unwrap();
        assert_eq!(search.values["project"]["items"][format!("i{source}")]["columns"][key("Name")], "Needle");
        assert_eq!(search.values["project"]["items"][format!("i{source}")]["columns"][key("custom.[/]")], Value::Null);
    }
}
