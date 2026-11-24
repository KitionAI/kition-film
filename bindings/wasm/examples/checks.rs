//! Writes the conformance fixtures (KHP `spec/conformance.md`): `basic.kfilm`, which `film_check`
//! finds clean, one `check-<code>.kfilm` per code of `agent/checks.json`, on which the check reports
//! that code, and `expected/` (the expected previews of `basic.kfilm`).
//! `cargo run -p kition-film-kit --example checks -- conformance`. The projects are made with the
//! kit's own commands; states no command makes (an offline item, footage no host lends, a clip
//! whose item is gone, a clip that reads past its media) are written on the project model and
//! encoded by the kit's own format crate, so the files are the same on every run.

use std::path::Path;

use kition_film_engine::project::{ItemKind, MediaRef, Project};
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn project() -> Result<FilmDocument, String> {
    FilmDocument::create("film.kfilm", 640, 360)
}

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Result<Value, String> {
    doc.execute(command, params).map_err(|error| format!("{command}: {error}"))
}

/// A colour matte of `seconds`, placed on V1 at `at` seconds: the clip's id.
fn matte(doc: &mut FilmDocument, color: &str, seconds: f64, at: f64) -> Result<u64, String> {
    let item = run(doc, "file.newColorMatte", json!({ "color": color, "seconds": seconds }))?;
    let placed = run(doc, "timeline.place", json!({ "item": item["item"], "track": "V1", "seconds": at }))?;
    clip_of(&placed).ok_or_else(|| format!("timeline.place answered no clip: {placed}"))
}

fn clip_of(placed: &Value) -> Option<u64> {
    placed.get("clip").and_then(Value::as_u64).or_else(|| placed.get("clips").and_then(|clips| clips.get(0)).and_then(Value::as_u64))
}

/// The saved project, changed on its model by `edit`.
fn edited(doc: &FilmDocument, edit: impl FnOnce(&mut Project)) -> Result<Vec<u8>, String> {
    let mut loaded = kition_film_format::decode(&doc.save(None)?).map_err(|error| error.to_string())?;
    edit(&mut loaded.project);
    Ok(kition_film_format::encode(&loaded.project, false))
}

fn fixtures() -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    let mut out = Vec::new();

    let mut basic = project()?;
    matte(&mut basic, "#1f4e8c", 2.0, 0.0)?;
    out.push(("basic.kfilm", basic.save(None)?));

    out.push(("check-empty-sequence.kfilm", project()?.save(None)?));

    let mut gap = project()?;
    matte(&mut gap, "#1f4e8c", 2.0, 0.0)?;
    matte(&mut gap, "#c0392b", 2.0, 3.0)?;
    out.push(("check-gap.kfilm", gap.save(None)?));

    let mut disabled = project()?;
    let clip = matte(&mut disabled, "#1f4e8c", 2.0, 0.0)?;
    run(&mut disabled, "clip.enable", json!({ "clips": [clip] }))?;
    out.push(("check-disabled-clip.kfilm", disabled.save(None)?));

    let mut offline = project()?;
    matte(&mut offline, "#1f4e8c", 2.0, 0.0)?;
    out.push((
        "check-offline-media.kfilm",
        edited(&offline, |project| {
            for item in project.items.values_mut() {
                if let ItemKind::Media(media) = &mut item.kind {
                    media.offline = true;
                }
            }
        })?,
    ));

    let mut gone = project()?;
    matte(&mut gone, "#1f4e8c", 2.0, 0.0)?;
    out.push((
        "check-missing-media.kfilm",
        edited(&gone, |project| {
            for item in project.items.values_mut() {
                // Footage named by a path no host lends: missing from the workspace.
                if let ItemKind::Media(media) = &mut item.kind {
                    media.media = MediaRef::File { path: "footage/missing.mov".into() };
                }
            }
        })?,
    ));

    let mut missing = project()?;
    matte(&mut missing, "#1f4e8c", 2.0, 0.0)?;
    out.push(("check-missing-item.kfilm", edited(&missing, |project| project.items.retain(|_, item| !matches!(item.kind, ItemKind::Media(_))))?));

    let mut past = project()?;
    matte(&mut past, "#1f4e8c", 2.0, 0.0)?;
    out.push((
        "check-past-media-end.kfilm",
        edited(&past, |project| {
            for item in project.items.values_mut() {
                // Footage (a movie) that ends halfway through its clip.
                if let ItemKind::Media(media) = &mut item.kind {
                    media.info.kind = kition_film_media::MediaKind::Movie;
                    media.info.duration.0 /= 2;
                }
            }
        })?,
    ));

    let mut font = project()?;
    matte(&mut font, "#1f4e8c", 2.0, 0.0)?;
    run(&mut font, "graphics.newText", json!({ "text": "Title", "font": "No Such Font Family", "seconds": 2, "time": 0 }))?;
    out.push(("check-font-missing.kfilm", font.save(None)?));

    let mut truncated = project()?;
    for i in 0..103 {
        let clip = matte(&mut truncated, "#1f4e8c", 0.1, f64::from(i) * 0.1)?;
        run(&mut truncated, "clip.enable", json!({ "clips": [clip] }))?;
    }
    out.push(("check-truncated.kfilm", truncated.save(None)?));
    Ok(out)
}

/// `expected/basic.png` and `expected/basic-scale-2.png`: the engine's own render of `basic.kfilm` (the
/// program monitor at the playhead), at 1 and 2 pixels per pixel.
fn expected_previews(dir: &Path, bytes: &[u8]) -> Result<(), String> {
    let doc = FilmDocument::open("basic.kfilm", bytes)?;
    let expected = dir.join("expected");
    std::fs::create_dir_all(&expected).map_err(|error| error.to_string())?;
    for (file, scale) in [("basic.png", 1.0), ("basic-scale-2.png", 2.0)] {
        let (width, height) = ((f64::from(doc.width()) * scale) as u32, (f64::from(doc.height()) * scale) as u32);
        let rgba = doc.render(0.0, 0.0, scale, width, height)?;
        let picture = image::RgbaImage::from_raw(width, height, rgba).ok_or("a render of the wrong size")?;
        picture.save(expected.join(file)).map_err(|error| error.to_string())?;
        println!("wrote expected/{file}");
    }
    Ok(())
}

fn main() -> Result<(), String> {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "conformance".into());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    for (name, bytes) in fixtures()? {
        std::fs::write(dir.join(name), &bytes).map_err(|error| format!("{name}: {error}"))?;
        println!("wrote {name}");
        if name == "basic.kfilm" {
            expected_previews(dir, &bytes)?;
        }
    }
    Ok(())
}
