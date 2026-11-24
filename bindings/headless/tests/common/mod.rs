//! What `ids.rs` and `outside.rs` share: a project of colour-matte clips laid end to end on V1, the
//! `kition-film` executable driven through the kits' MCP server's tools (`kition_kits::tools`,
//! the library `kition-kits-mcp` serves) as an agent drives it, and two programs other than that
//! server that change the file: a colleague's (this kit's engine, an instance of its own, opening
//! the file, running commands and saving it) and a bare rewriter (the `.kfilm` reader and writer
//! alone, no engine).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use kition_kits::tools::{self, CallOptions};
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

pub const ME: &str = "agent-me";
pub const FILE: &str = "Edit.kfilm";
/// Ticks in a second.
pub const SECOND: i64 = 254_016_000_000;

pub fn kit() -> &'static KitDefinition {
    KitDefinition::from_manifest_text(include_str!("../../../../kit.json")).unwrap()
}

/// A 320 x 180 project whose sequence holds `clips` one-second colour mattes end to end on V1
/// (clip `n` from `n` s), each of its own matte item.
pub fn project(clips: usize) -> Vec<u8> {
    let mut doc = FilmDocument::create(FILE, 320, 180).unwrap();
    for n in 0..clips {
        let color = format!("#{:02x}{:02x}{:02x}", (n * 37) % 256, (n * 91) % 256, (n * 53) % 256);
        let matte = doc.execute("file.newColorMatte", json!({ "color": color, "seconds": 1 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": n })).unwrap();
    }
    doc.save(None).unwrap()
}

/// Sets the file's modification time an hour before its own, so that only its content tells the
/// server it changed.
fn backdate(file: &Path, before: std::time::SystemTime) {
    std::fs::File::options().write(true).open(file).unwrap().set_modified(before - Duration::from_secs(3600)).unwrap();
}

/// A colleague's program: this kit's engine, its own instance, opening the file from disk,
/// running `steps` (commands and parameters) and saving the file back.
pub fn colleague(file: &Path, steps: &[(&str, Value)]) -> Vec<Value> {
    let at = std::fs::metadata(file).unwrap().modified().unwrap();
    let mut doc = FilmDocument::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let answers =
        steps.iter().map(|(command, params)| doc.execute(command, params.clone()).unwrap_or_else(|error| panic!("colleague's {command}: {error}"))).collect();
    std::fs::write(file, doc.save(Some(FILE)).unwrap()).unwrap();
    backdate(file, at);
    answers
}

/// Another program rewriting the file through the `.kfilm` reader and writer alone (no engine,
/// no session), changing the project with `change`.
pub fn rewrite(file: &Path, change: impl FnOnce(&mut kition_film_project::Project)) {
    let at = std::fs::metadata(file).unwrap().modified().unwrap();
    let mut loaded = kition_film_format::decode(&std::fs::read(file).unwrap()).unwrap();
    change(&mut loaded.project);
    std::fs::write(file, kition_film_format::encode(&loaded.project, true)).unwrap();
    backdate(file, at);
}

/// The file's V1 as a new engine reads it: each clip's id, start (ticks), and whether it is enabled.
pub fn v1_on_disk(file: &Path) -> Vec<(u64, i64, bool)> {
    let doc = FilmDocument::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let seen = doc.inspect().unwrap();
    seen["sequence"]["video"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|clip| (clip["clip"].as_u64().unwrap(), clip["start"].as_i64().unwrap(), clip["enabled"].as_bool().unwrap()))
        .collect()
}

/// Clip `id`'s opacity in the file as a new engine reads it.
pub fn opacity_on_disk(file: &Path, id: u64) -> f64 {
    let doc = FilmDocument::open(FILE, &std::fs::read(file).unwrap()).unwrap();
    let seen = doc.inspect().unwrap();
    let clip =
        seen["sequence"]["video"][0]["items"].as_array().unwrap().iter().find(|clip| clip["clip"] == id).unwrap_or_else(|| panic!("no clip {id}")).clone();
    let opacity = clip["effects"].as_array().unwrap().iter().find(|effect| effect["effect"] == "opacity").unwrap();
    opacity["params"]["opacity"]["value"].as_f64().unwrap()
}

pub struct Fixture {
    pub kits: KitManager,
    pub options: CallOptions,
    pub workspace: tempfile::TempDir,
}

impl Fixture {
    pub fn new(clips: usize) -> Self {
        Self::with(clips, CallOptions::default())
    }

    pub fn with(clips: usize, options: CallOptions) -> Self {
        Self::from_bytes(&project(clips), options)
    }

    pub fn from_bytes(bytes: &[u8], options: CallOptions) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join(FILE), bytes).unwrap();
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(), Some(PathBuf::from(env!("CARGO_BIN_EXE_kition-film"))))]);
        Self { kits, options, workspace }
    }

    pub fn file(&self) -> PathBuf {
        self.workspace.path().join(FILE)
    }

    pub fn colleague(&self, steps: &[(&str, Value)]) -> Vec<Value> {
        colleague(&self.file(), steps)
    }

    pub async fn call(&self, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(FILE);
        match tools::call_as(&self.kits, &format!("film_{action}"), &input, self.options, ME).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("film_{action} is no tool"),
        }
    }

    pub async fn ok(&self, action: &str, input: Value) -> Value {
        self.call(action, input).await.unwrap_or_else(|error| panic!("film_{action}: {error}"))
    }

    pub async fn refused(&self, action: &str, input: Value) -> Value {
        match self.call(action, input).await {
            Err(error) => error,
            Ok(answer) => panic!("film_{action} was expected to be refused: {answer}"),
        }
    }

    /// The open sequence as the agent inspects it (`details.sequence`) and the answer's `revision`.
    pub async fn inspect(&self) -> (Value, String) {
        let seen = self.ok("inspect", json!({})).await;
        (seen["details"]["sequence"].clone(), revision(&seen))
    }

    pub async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

/// The clip ids of V1 of an inspected sequence, in time order.
pub fn v1(sequence: &Value) -> Vec<u64> {
    sequence["video"][0]["items"].as_array().unwrap().iter().map(|clip| clip["clip"].as_u64().unwrap()).collect()
}

pub fn revision(answer: &Value) -> String {
    answer["revision"].as_str().unwrap_or_else(|| panic!("a revision: {answer}")).to_owned()
}

/// The ids a change list names.
pub fn ids(list: &Value) -> Vec<String> {
    list.as_array().map(|items| items.iter().filter_map(|item| id_text(&item["id"])).collect()).unwrap_or_default()
}

/// An id as receipts, `others` and conflicts give it (a number, the form commands take), or as
/// the object model's reads give it (a string), as text.
pub fn id_text(id: &Value) -> Option<String> {
    id.as_u64().map(|id| id.to_string()).or_else(|| id.as_str().map(str::to_owned))
}

/// The entry of `list` naming `id`.
pub fn entry<'a>(list: &'a Value, id: &str) -> &'a Value {
    list.as_array().and_then(|items| items.iter().find(|item| id_text(&item["id"]).as_deref() == Some(id))).unwrap_or_else(|| panic!("no {id} in {list}"))
}

/// A step setting clip `clip`'s opacity to `value`.
pub fn set_opacity(clip: u64, value: f64) -> Value {
    json!({ "command": "effects.setParam", "params": { "clip": clip, "effect": "opacity", "param": "opacity", "value": value } })
}

/// The colleague's command setting clip `clip`'s opacity to `value`.
pub fn opacity(clip: u64, value: f64) -> (&'static str, Value) {
    ("effects.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "value": value }))
}

/// A refusal of a write whose premises others changed, naming `id` with `reason`.
pub fn assert_conflict<'a>(refused: &'a Value, id: &str, reason: &str) -> &'a Value {
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");
    assert!(refused["revision"].is_string(), "{refused}");
    let found = refused["conflicts"].as_array().and_then(|conflicts| conflicts.iter().find(|conflict| id_text(&conflict["id"]).as_deref() == Some(id)));
    let found = found.unwrap_or_else(|| panic!("no conflict on {id}: {refused}"));
    assert_eq!(found["reason"], reason, "{refused}");
    found
}

/// The median of `samples`, in milliseconds.
pub fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples.get(samples.len() / 2).copied().unwrap_or(f64::NAN)
}
