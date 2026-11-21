//! `kition-film` reads and writes only inside its workspace, and only through its host (KHP A29,
//! section 10.6): whatever an agent runs, nothing appears in the process's current folder, its
//! home folder or its temporary folder, nothing outside the workspace is listed, read into an
//! answer or a picture, changed or deleted, and the workspace holds only what the host saved. An
//! audit found that an agent could delete files anywhere (`prefs.set` of the media cache folder,
//! then `mediaCache.clean`), that ordinary rendering (`sequence.renderInToOut`) wrote preview
//! movies into the current folder, and that commands kept from agents ran anyway inside
//! `model.batch` (LUT and shortcut files read and written by path).
//!
//! The test runs itself again as a child process whose current folder, `HOME` and `TMPDIR` are
//! fresh empty folders, so every by-path write the engine makes lands where it can be seen. A
//! folder beside them (`outside/`) holds this test's own sentinel files, which the agent names by
//! path (directly, inside `model.batch`, and from a project file, which is the agent's data): it
//! must neither list, read, change nor delete them.

use std::path::{Path, PathBuf};

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::{Origin, ScreenshotScope};
use kition_kit_server::{KitBackend, OpenRequest, ScreenshotRequest};
use serde_json::{Map, Value, json};

/// Set in the child: the folder holding `workspace/` and `outside/`.
const CHILD: &str = "KITION_FILM_TEST_SANDBOX";
const NAME: &str = "basic.kfilm";
/// The picture outside the workspace, and one inside it.
const OUTSIDE_RGB: [u8; 3] = [17, 233, 71];
const INSIDE_RGB: [u8; 3] = [201, 40, 160];
/// Text only files outside the workspace hold: it must reach no answer.
const SECRET: &str = "SENTINEL-7d1f";
/// A file outside the workspace that no call names: only a listing could find it.
const LISTED_ONLY: &str = "listed-only-7d1f.txt";
/// An auto-save of `basic.kfilm` outside the workspace, named as the engine names them.
const AUTO_SAVE: &str = "basic-2026-01-01_00-00-00.kfilm";

/// Every file and folder under `dir`, relative to it, with a file's bytes.
fn tree(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = path.strip_prefix(dir).unwrap_or(&path).to_string_lossy().into_owned();
            if path.is_dir() {
                stack.push(path.clone());
                out.push((name, None));
            } else {
                out.push((name, std::fs::read(&path).ok()));
            }
        }
    }
    out.sort();
    out
}

fn names(dir: &Path) -> Vec<String> {
    tree(dir).into_iter().map(|(name, _)| name).collect()
}

/// A `w` x `h` 24-bit BMP of one colour.
fn bmp(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let row = (w * 3).div_ceil(4) * 4;
    let size = 54 + row * h;
    let mut out = Vec::new();
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    for _ in 0..h {
        for _ in 0..w {
            out.extend_from_slice(&[rgb[2], rgb[1], rgb[0]]);
        }
        out.resize(out.len() + (row - w * 3) as usize, 0);
    }
    out
}

/// Whether some pixel of `rgba` is within 8 of `rgb` in every channel.
fn shows(rgba: &[u8], rgb: [u8; 3]) -> bool {
    rgba.as_chunks::<4>().0.iter().any(|px| (0..3).all(|c| px[c].abs_diff(rgb[c]) <= 8))
}

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The agent's session: the headless kit over the workspace, and every answer it gave.
struct Agent {
    kit: Headless<FilmDocument>,
    folder: HostFolder,
    answers: Vec<String>,
}

impl Agent {
    fn open(&mut self, name: &str) -> String {
        self.kit.open(OpenRequest { file: &self.folder.file(name).unwrap(), read_only: false, create: None }).unwrap().id
    }

    fn keep(&mut self, what: String, answer: Result<Value, String>) -> Result<Value, String> {
        self.answers.push(format!("{what}: {answer:?}"));
        answer
    }

    /// `command` as the agent calls it directly.
    fn run(&mut self, id: &str, command: &str, value: Value) -> Result<Value, String> {
        let answer = self.kit.execute(id, command, params(value), Origin::Agent).map(|done| done.result.unwrap_or(Value::Null)).map_err(|e| format!("{e:?}"));
        self.keep(command.to_owned(), answer)
    }

    /// `command` as one `command` operation of `model.batch`, with the batch's `origin` (none: the
    /// object model's default, a script; or one the caller claims).
    fn batch(&mut self, id: &str, command: &str, value: Value, origin: &Value) -> Result<Value, String> {
        let mut request = json!({ "documentId": id, "ops": [{ "op": "command", "id": command, "params": value }] });
        if !origin.is_null() {
            request["origin"] = origin.clone();
        }
        let answer = self.kit.model("model.batch", request).map_err(|e| format!("{e:?}"));
        self.keep(format!("model.batch {command} as {origin}"), answer)
    }

    /// The program picture of document `id`, as RGBA.
    fn picture(&mut self, id: &str) -> Vec<u8> {
        let shot = self.kit.screenshot(id, &ScreenshotRequest { scope: ScreenshotScope::Canvas, max_size: 256, scale: 1.0, target: None }).unwrap();
        image::load_from_memory(&shot.png).unwrap().to_rgba8().into_raw()
    }
}

/// A copy of the saved project `bytes` whose media named `from` is named `to`, with its scratch
/// disks and ingest settings pointing at `outside`: what an agent's project file may say.
fn hostile(bytes: &[u8], from: &str, to: &str, outside: &Path) -> Vec<u8> {
    fn walk(value: &mut Value, from: &str, to: &str) {
        match value {
            Value::String(text) if text == from => *text = to.to_owned(),
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, from, to)),
            Value::Object(fields) => fields.values_mut().for_each(|item| walk(item, from, to)),
            _ => {}
        }
    }
    let mut project: Value = serde_json::from_slice(bytes).unwrap();
    walk(&mut project, from, to);
    let at = |name: &str| outside.join(name).to_string_lossy().into_owned();
    let settings = &mut project["project"]["settings"];
    settings["scratch"] =
        json!({ "captured": at("captured"), "videoPreviews": at("prev"), "audioPreviews": at("prev"), "autoSave": outside.to_string_lossy() });
    settings["ingest"] = json!({ "enabled": true, "action": "copy", "destination": at("ingested"), "preset": "" });
    serde_json::to_vec(&project).unwrap()
}

/// What the agent does in the child. Errors are fine; reaching files outside the workspace is not.
/// Returns what went wrong that the child can see (answers and pictures); the parent checks the
/// folders.
fn act(root: &Path) -> Vec<String> {
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    let at = |name: &str| outside.join(name).to_string_lossy().into_owned();
    let mut wrong = Vec::new();

    // A short movie in the workspace, made by the kit (for proxies and ingest), and a project.
    let mut maker = FilmDocument::create("maker.kfilm", 64, 36).unwrap();
    let matte = maker.execute("file.newColorMatte", json!({ "color": "#3060c0", "seconds": 1.0 })).unwrap();
    maker.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
    let range = json!({ "range": "custom", "startSeconds": 0.0, "endSeconds": 0.5, "wait": true });
    let mut movie = json!({ "path": "clip.mov", "format": "prores" });
    movie.as_object_mut().unwrap().extend(range.as_object().unwrap().clone());
    maker.execute("file.exportMedia", movie).unwrap();
    std::fs::write(workspace.join("clip.mov"), maker.take_file("clip.mov").unwrap()).unwrap();
    std::fs::write(workspace.join(NAME), maker.save(None).unwrap()).unwrap();

    let info = KitInfo::from_manifest(include_str!("../../../kit.json"), &["file.import"], kition_film_kit::EDITOR_STATE).unwrap();
    let mut agent = Agent { kit: Headless::<FilmDocument>::with_replica_port(info), folder: HostFolder::new(&workspace).unwrap(), answers: Vec::new() };
    agent.kit.set_host(agent.folder.host());
    let id = agent.open(NAME);

    // Media from the workspace, through the host: the picture inside is shown.
    let imported = agent.run(&id, "file.import", json!({ "paths": ["inside.bmp", "clip.mov"] })).unwrap();
    let (picture, clip) = (imported["items"][0].clone(), imported["items"][1].clone());
    agent.run(&id, "timeline.place", json!({ "item": picture, "track": "V2", "seconds": 0.0 })).unwrap();
    agent.kit.save(&id, None, None).unwrap();
    if !shows(&agent.picture(&id), INSIDE_RGB) {
        wrong.push("the picture in the workspace is not shown".to_owned());
    }
    let found = agent.kit.check(&id).unwrap();
    if found.to_string().contains("film.missing-media") {
        wrong.push(format!("media in the workspace is reported missing: {found}"));
    }

    // Preferences that name folders: the media cache, which Delete Media Cache Files empties.
    let refused = agent.run(&id, "prefs.set", json!({ "key": "mediaCache.location", "value": at("cache") }));
    if refused.is_ok() {
        wrong.push(format!("prefs.set took a media cache folder outside the workspace: {refused:?}"));
    }
    let _ = agent.run(&id, "prefs.set", json!({ "values": { "mediaCache.location": at("cache"), "mediaCache.management": "olderThan" } }));
    let _ = agent.run(&id, "prefs.set", json!({ "key": "mediaCache.databaseLocation", "value": at("cache") }));
    let _ = agent.run(&id, "mediaCache.info", json!({}));
    let _ = agent.run(&id, "mediaCache.clean", json!({ "all": true }));

    // Ordinary rendering, with no hostile input, then into a scratch disk the agent names.
    let _ = agent.run(&id, "sequence.renderInToOut", json!({ "wait": true }));
    let _ = agent.run(&id, "sequence.renderAudio", json!({ "wait": true }));
    let _ = agent.run(&id, "file.projectSettings.scratchDisks", json!({ "videoPreviews": at("prev"), "autoSave": outside.to_string_lossy() }));
    let _ = agent.run(&id, "sequence.renderInToOut", json!({ "wait": true }));
    let _ = agent.run(&id, "file.listAutoSaves", json!({}));

    // Commands that write folders they are given.
    let _ = agent.run(&id, "file.projectManager", json!({ "destination": at("pm"), "wait": true }));
    let _ = agent.run(&id, "media.createProxies", json!({ "items": [clip], "destination": at("proxies"), "wait": true }));
    let _ = agent.run(&id, "project.ingestSettings", json!({ "enabled": true, "action": "copy", "destination": at("ingested") }));
    let _ = agent.run(&id, "file.import", json!({ "paths": ["clip.mov"] }));
    let _ = agent.run(&id, "file.newProjectFromTemplate", json!({ "template": at("planted.kfilm") }));
    let _ = agent.run(&id, "transcript.models", json!({}));

    // Commands the agent is not offered, inside model.batch: as a script (no origin), as the
    // agent, and as a person the caller claims to be. None of them reaches a file by path.
    let nested: Vec<(&str, Value)> = vec![
        ("lut.import", json!({ "path": at("secret.cube") })),
        ("color.setInputLut", json!({ "path": at("secret.cube") })),
        ("lut.export", json!({ "lut": "builtin:look-teal-orange", "path": at("made.cube") })),
        ("shortcuts.export", json!({ "path": at("made-shortcuts.json") })),
        ("shortcuts.import", json!({ "path": at("shortcuts.json") })),
        ("color.presetThumbnails", json!({ "path": at("thumbs.png") })),
        ("media.search", json!({ "folder": outside.to_string_lossy() })),
        ("media.autoRelink", json!({ "folder": outside.to_string_lossy() })),
        ("captions.import", json!({ "path": at("secret.srt") })),
        ("file.projectManager", json!({ "destination": at("pm-batch"), "wait": true })),
        ("media.createProxies", json!({ "items": [clip], "destination": at("proxies-batch"), "wait": true })),
        ("file.projectSettings.scratchDisks", json!({ "videoPreviews": at("prev-batch") })),
        ("prefs.set", json!({ "key": "mediaCache.location", "value": at("cache") })),
        ("mediaCache.clean", json!({ "all": true })),
        ("sequence.renderInToOut", json!({ "wait": true })),
    ];
    for origin in [Value::Null, json!({ "kind": "agent", "principal": "agent:test" }), json!({ "kind": "person", "principal": "person:local" })] {
        for (command, value) in &nested {
            let _ = agent.batch(&id, command, value.clone(), &origin);
        }
    }

    // A project file is the agent's data: media named by a path outside the workspace, and
    // scratch disks and ingest settings there. The media is missing; nothing outside is read.
    let saved = std::fs::read(workspace.join(NAME)).unwrap();
    for (name, media) in [("escape.kfilm", at("secret.bmp")), ("escape2.kfilm", "../outside/secret2.bmp".to_owned())] {
        std::fs::write(workspace.join(name), hostile(&saved, "inside.bmp", &media, &outside)).unwrap();
        let escape = agent.open(name);
        let shown = agent.picture(&escape);
        if shows(&shown, OUTSIDE_RGB) {
            wrong.push(format!("{name}: the picture outside the workspace ({media}) was read into the render"));
        }
        // The check says so: the clip's media is missing (it renders the offline slate).
        let found = agent.kit.check(&escape).unwrap();
        if !found.to_string().contains("film.missing-media") {
            wrong.push(format!("{name}: the check does not report the media outside the workspace as missing: {found}"));
        }
        let _ = agent.run(&escape, "sequence.renderInToOut", json!({ "wait": true }));
        let _ = agent.run(&escape, "media.createProxies", json!({ "wait": true }));
        let _ = agent.run(&escape, "file.import", json!({ "paths": ["clip.mov"] }));
        let _ = agent.run(&escape, "file.listAutoSaves", json!({}));
        // The project's picture item now names the file outside: deleting it must delete nothing.
        let _ = agent.run(&escape, "media.makeOffline", json!({ "items": [picture], "deleteFiles": true }));
        // What it rendered was the kit's offline slate: the same picture as the item made offline.
        if agent.picture(&escape) != shown {
            wrong.push(format!("{name}: the missing media does not render the offline slate"));
        }
    }

    // An export's image overlay names a picture outside the workspace: it is not burned in.
    let mut exporter = FilmDocument::create("overlay.kfilm", 64, 36).unwrap();
    let matte = exporter.execute("file.newColorMatte", json!({ "color": "#000000", "seconds": 1.0 })).unwrap();
    exporter.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
    let overlay = json!({ "enabled": true, "path": at("overlay.bmp"), "size_percent": 100.0, "opacity": 100.0 });
    let mut export = json!({ "path": "overlay.png", "format": "png", "settings": { "effects": { "image_overlay": overlay } } });
    export.as_object_mut().unwrap().extend(range.as_object().unwrap().clone());
    let exported = exporter.execute("file.exportMedia", export);
    agent.answers.push(format!("file.exportMedia with an image overlay: {exported:?}"));
    if exported.is_ok() {
        // A PNG sequence: overlay000.png is its first frame.
        let first = exporter.take_file("overlay000.png").expect("the first frame of the export");
        if shows(&image::load_from_memory(&first).unwrap().to_rgba8().into_raw(), OUTSIDE_RGB) {
            wrong.push("the image overlay outside the workspace was burned into the export".to_owned());
        }
    }

    // Every command the kit offers the agent, with no parameters.
    let offered: Vec<String> = agent.kit.commands(Some(&id)).unwrap().into_iter().map(|command| command.id).collect();
    for command in offered {
        // These end or replace the project the rest of the sweep runs in.
        if matches!(command.as_str(), "file.close" | "file.closeProject" | "file.closeAllProjects" | "file.newProject" | "file.openDemoProject" | "file.revert")
        {
            continue;
        }
        let _ = agent.run(&id, &command, json!({}));
    }

    // Nothing outside the workspace reached an answer: its files' text, a listing, a folder of
    // this process.
    let home = root.join("home").to_string_lossy().into_owned();
    let tmp = root.join("tmp").to_string_lossy().into_owned();
    for answer in &agent.answers {
        for leak in [SECRET, LISTED_ONLY, AUTO_SAVE.trim_end_matches(".kfilm"), home.as_str(), tmp.as_str()] {
            if answer.contains(leak) {
                wrong.push(format!("an answer holds `{leak}` from outside the workspace: {}", answer.chars().take(400).collect::<String>()));
            }
        }
    }
    wrong
}

#[test]
fn agent_commands_reach_no_file_outside_the_workspace() {
    if let Some(root) = std::env::var_os(CHILD) {
        let wrong = act(&PathBuf::from(root));
        assert!(wrong.is_empty(), "{wrong:#?}");
        return;
    }
    let root = std::env::temp_dir().join(format!("kition-film-workspace-only-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for dir in ["workspace", "cwd", "home", "tmp", "outside/cache/sub"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = std::fs::canonicalize(root).unwrap();
    let outside = root.join("outside");
    std::fs::write(root.join("workspace/inside.bmp"), bmp(16, 16, INSIDE_RGB)).unwrap();
    std::fs::write(outside.join("secret.bmp"), bmp(16, 16, OUTSIDE_RGB)).unwrap();
    std::fs::write(outside.join("secret2.bmp"), bmp(16, 16, OUTSIDE_RGB)).unwrap();
    std::fs::write(outside.join("overlay.bmp"), bmp(16, 16, OUTSIDE_RGB)).unwrap();
    std::fs::write(outside.join("secret.cube"), format!("TITLE \"{SECRET}\"\nLUT_3D_SIZE 2\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n"))
        .unwrap();
    std::fs::write(outside.join("secret.srt"), format!("1\n00:00:00,000 --> 00:00:01,000\n{SECRET}\n")).unwrap();
    std::fs::write(
        outside.join("shortcuts.json"),
        format!("{{\"format\":\"kition-film-keyboard-shortcuts\",\"version\":1,\"name\":\"{SECRET}\",\"bindings\":[]}}"),
    )
    .unwrap();
    std::fs::write(outside.join("planted.kfilm"), FilmDocument::create(&format!("{SECRET}.kfilm"), 16, 16).unwrap().save(None).unwrap()).unwrap();
    std::fs::write(outside.join(AUTO_SAVE), FilmDocument::create(AUTO_SAVE, 16, 16).unwrap().save(None).unwrap()).unwrap();
    std::fs::write(outside.join(LISTED_ONLY), SECRET).unwrap();
    std::fs::write(outside.join("cache/old.bin"), SECRET).unwrap();
    std::fs::write(outside.join("cache/sub/older.bin"), SECRET).unwrap();
    let planted = tree(&outside);

    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "agent_commands_reach_no_file_outside_the_workspace", "--nocapture", "--test-threads=1"])
        .current_dir(root.join("cwd"))
        .env(CHILD, &root)
        .env("HOME", root.join("home"))
        .env("TMPDIR", root.join("tmp"))
        .env("XDG_CONFIG_HOME", root.join("home/.config"))
        .env("XDG_DATA_HOME", root.join("home/.local/share"))
        .env("XDG_CACHE_HOME", root.join("home/.cache"))
        .env_remove("KITION_FILM_DATA_DIR")
        .status()
        .unwrap();
    let mut wrong = Vec::new();
    if !status.success() {
        wrong.push(format!("the agent's session found something outside the workspace (see its output above): {status}"));
    }
    for dir in ["cwd", "home", "tmp"] {
        let found = names(&root.join(dir));
        if !found.is_empty() {
            wrong.push(format!("the kit wrote into its {dir} folder: {found:?}"));
        }
    }
    let now = tree(&outside);
    if now != planted {
        let before: Vec<&String> = planted.iter().map(|(name, _)| name).collect();
        let after: Vec<&String> = now.iter().map(|(name, _)| name).collect();
        wrong.push(format!("the folder outside the workspace changed: before {before:?}, after {after:?}"));
    }
    let expected = ["basic.kfilm", "clip.mov", "escape.kfilm", "escape2.kfilm", "inside.bmp"];
    let found = names(&root.join("workspace"));
    if found != expected {
        wrong.push(format!("the workspace holds {found:?}, not only what the host saved and the test wrote ({expected:?})"));
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
    let _ = std::fs::remove_dir_all(&root);
}
