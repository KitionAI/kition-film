//! The font database: bundled fonts (always available, also on the web), the optional
//! [`KITION_FONTS`] (present when built with `KITION_FONTS_DIR`, also on the web) plus fonts
//! discovered by [`FontSource`]s (system font folders on native platforms).
//!
//! Faces are addressed by [`FaceId`] (an index that never changes for the life of the process).
//! [`resolve`] maps a family + style name (as stored in projects) to a face and the synthetic
//! bold/italic needed when the family lacks that style. Unknown families fall back to Inter.
//! A variable font's named instances (Light, Bold, …) are faces of their own, drawn at their
//! place in the font's variation space. `KITION_FILM_NO_SYSTEM_FONTS=1` (or
//! [`set_system_fonts`]) keeps the machine's fonts out, so renders do not depend on the machine.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use skrifa::instance::{Location, LocationRef, Size};
use skrifa::{FontRef, MetadataProvider};

use crate::sfnt::{FaceNames, read_faces, read_faces_bytes};

/// Bundled fonts (SIL OFL 1.1; see `assets/fonts/*.attribution` and docs/attribution.md).
pub static INTER_REGULAR: &[u8] = include_bytes!("../../../../assets/fonts/Inter-Regular.ttf");
pub static INTER_MEDIUM: &[u8] = include_bytes!("../../../../assets/fonts/Inter-Medium.ttf");
pub static INTER_SEMIBOLD: &[u8] = include_bytes!("../../../../assets/fonts/Inter-SemiBold.ttf");
pub static INTER_BOLD: &[u8] = include_bytes!("../../../../assets/fonts/Inter-Bold.ttf");
pub static INTER_ITALIC: &[u8] = include_bytes!("../../../../assets/fonts/Inter-Italic.ttf");
pub static JETBRAINS_MONO_REGULAR: &[u8] = include_bytes!("../../../../assets/fonts/JetBrainsMono-Regular.ttf");
pub static NOTO_SERIF_REGULAR: &[u8] = include_bytes!("../../../../assets/fonts/NotoSerif-Regular.ttf");

/// A font from the optional kition-fonts build input (empty unless built with `KITION_FONTS_DIR`; see
/// `build.rs` and KitionAI/kition-fonts `docs/integration.md`).
pub struct KitionFont {
    pub family: &'static str,
    pub style: &'static str,
    /// ISO 15924 scripts the font is for, e.g. `"Jpan"`.
    pub scripts: &'static [&'static str],
    pub bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/kition_fonts.rs"));

/// The kition-fonts entries for Japanese (`Jpan`), in [`KITION_FONTS`] order. Empty when the app was
/// built without kition-fonts.
pub fn kition_fonts_japanese() -> impl Iterator<Item = &'static KitionFont> {
    KITION_FONTS.iter().filter(|f| f.scripts.contains(&"Jpan"))
}

/// Origin of faces registered from [`KITION_FONTS`].
pub const KITION_FONTS_ORIGIN: &str = "kition-fonts";

/// The default family for new text.
pub const DEFAULT_FAMILY: &str = "Inter";

/// Index of a face in the database.
pub type FaceId = usize;

/// Where a face's bytes come from.
#[derive(Clone, Debug)]
pub enum FaceData {
    Static(&'static [u8]),
    Shared(Arc<Vec<u8>>),
    /// A file read on first use.
    File(PathBuf),
}

/// Description of a face offered by a [`FontSource`].
#[derive(Clone, Debug)]
pub struct FaceInfo {
    pub family: String,
    pub style: String,
    pub weight: u16,
    pub italic: bool,
    pub index: u32,
    pub data: FaceData,
    /// "bundled", "system", …
    pub origin: &'static str,
    /// A named instance of a variable font (its index in the font's `fvar` table): the face draws
    /// at that instance's location. `None`: the font's default location.
    pub instance: Option<u16>,
}

/// Something that can list fonts (system folders, a web font picker, a project's font folder…).
pub trait FontSource: Send + Sync {
    fn faces(&self) -> Vec<FaceInfo>;
}

/// Scans font folders on disk (reading only name tables). Native only; on the web there are no
/// folders and the scan finds nothing.
pub struct DirectorySource {
    pub dirs: Vec<PathBuf>,
}

impl DirectorySource {
    /// The platform's standard font folders.
    pub fn system() -> Self {
        let mut dirs: Vec<PathBuf> = Vec::new();
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if cfg!(target_os = "macos") {
            dirs.extend(["/System/Library/Fonts", "/Library/Fonts"].map(PathBuf::from));
            if let Some(h) = &home {
                dirs.push(h.join("Library/Fonts"));
            }
        } else if cfg!(windows) {
            let win = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
            dirs.push(win.join("Fonts"));
            if let Some(l) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(PathBuf::from(l).join("Microsoft\\Windows\\Fonts"));
            }
        } else if cfg!(unix) && !cfg!(target_arch = "wasm32") {
            dirs.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
            if let Some(h) = &home {
                dirs.push(h.join(".local/share/fonts"));
                dirs.push(h.join(".fonts"));
            }
        }
        Self { dirs }
    }
}

fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                walk(&p, depth + 1, out);
            }
        } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc" | "otc")) {
            out.push(p);
        }
    }
}

impl FontSource for DirectorySource {
    fn faces(&self) -> Vec<FaceInfo> {
        let mut files = Vec::new();
        for d in &self.dirs {
            walk(d, 0, &mut files);
        }
        files.sort();
        let mut out = Vec::new();
        for f in files {
            let Ok(mut file) = std::fs::File::open(&f) else { continue };
            for n in read_faces(&mut file) {
                out.push(info_from(n, FaceData::File(f.clone()), "system"));
            }
        }
        out
    }
}

fn info_from(n: FaceNames, data: FaceData, origin: &'static str) -> FaceInfo {
    FaceInfo { family: n.family, style: n.style, weight: n.weight, italic: n.italic, index: n.index, data, origin, instance: None }
}

/// The named instances of a variable font face (`base`, read from `bytes`) other than the one its
/// default location already is: Lora's Medium, SemiBold, Bold and so on, each a face of the
/// family with its own style name, weight (the `wght` coordinate) and slant.
fn named_instances(base: &FaceInfo, bytes: &[u8]) -> Vec<FaceInfo> {
    let Ok(font) = FontRef::from_index(bytes, base.index) else { return Vec::new() };
    let axes = font.axes();
    let axis = |tag: &[u8; 4]| axes.iter().position(|a| a.tag() == skrifa::Tag::new(tag));
    let (wght, ital) = (axis(b"wght"), axis(b"ital"));
    let mut out: Vec<FaceInfo> = Vec::new();
    for (i, named) in font.named_instances().iter().enumerate() {
        let Ok(index) = u16::try_from(i) else { break };
        let Some(style) = font.localized_strings(named.subfamily_name_id()).english_or_first().map(|s| s.to_string()) else { continue };
        let style = style.trim().to_string();
        if style.is_empty() || style.eq_ignore_ascii_case(&base.style) || out.iter().any(|f| f.style.eq_ignore_ascii_case(&style)) {
            continue;
        }
        let coords: Vec<f32> = named.user_coords().collect();
        let weight = wght.and_then(|k| coords.get(k)).filter(|w| w.is_finite()).map_or(base.weight, |w| w.round().clamp(1.0, 1000.0) as u16);
        let italic = base.italic || style.to_ascii_lowercase().contains("italic") || ital.and_then(|k| coords.get(k)).is_some_and(|v| *v >= 0.5);
        out.push(FaceInfo { style, weight, italic, instance: Some(index), ..base.clone() });
    }
    out
}

/// A loaded (or loadable) face.
pub struct Face {
    pub id: FaceId,
    pub info: FaceInfo,
    bytes: OnceLock<Option<FaceBytes>>,
    shaper: OnceLock<harfrust::ShaperData>,
    location: OnceLock<Location>,
    shaper_instance: OnceLock<Option<harfrust::ShaperInstance>>,
}

#[derive(Clone)]
enum FaceBytes {
    Static(&'static [u8]),
    Shared(Arc<Vec<u8>>),
}

impl FaceBytes {
    fn get(&self) -> &[u8] {
        match self {
            FaceBytes::Static(b) => b,
            FaceBytes::Shared(b) => b,
        }
    }
}

/// Vertical metrics at a pixel size (all positive distances, y down from the baseline for the
/// underline position).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VMetrics {
    pub ascent: f32,
    pub descent: f32,
    pub line_gap: f32,
    pub cap_height: f32,
    pub x_height: f32,
    pub underline_pos: f32,
    pub underline_thickness: f32,
}

impl Face {
    fn bytes(&self) -> Option<&[u8]> {
        self.bytes
            .get_or_init(|| match &self.info.data {
                FaceData::Static(b) => Some(FaceBytes::Static(b)),
                FaceData::Shared(b) => Some(FaceBytes::Shared(b.clone())),
                FaceData::File(p) => std::fs::read(p).ok().map(|v| FaceBytes::Shared(Arc::new(v))),
            })
            .as_ref()
            .map(FaceBytes::get)
    }
    /// A copy of the font file's bytes (None if it is missing or unreadable).
    pub fn data(&self) -> Option<Vec<u8>> {
        self.bytes().map(<[u8]>::to_vec)
    }
    /// The parsed font (None if the file is missing or unreadable).
    pub fn font(&self) -> Option<FontRef<'_>> {
        FontRef::from_index(self.bytes()?, self.info.index).ok()
    }
    pub(crate) fn shaper_data(&self) -> Option<&harfrust::ShaperData> {
        let f = self.font()?;
        Some(self.shaper.get_or_init(|| harfrust::ShaperData::new(&f)))
    }
    /// Where in the font's variation space the face draws: its named instance's location, else the
    /// default.
    pub fn location(&self) -> LocationRef<'_> {
        LocationRef::from(self.location.get_or_init(|| match (self.info.instance, self.font()) {
            (Some(i), Some(f)) => f.named_instances().get(usize::from(i)).map(|n| n.location()).unwrap_or_default(),
            _ => Location::default(),
        }))
    }
    /// The shaper's view of the face's named instance (`None` at the default location).
    pub(crate) fn shaper_instance(&self) -> Option<&harfrust::ShaperInstance> {
        self.shaper_instance
            .get_or_init(|| {
                let i = self.info.instance?;
                let f = self.font()?;
                Some(harfrust::ShaperInstance::from_named_instance(&f, usize::from(i)))
            })
            .as_ref()
    }
    pub fn units_per_em(&self) -> f32 {
        self.font().map(|f| f.metrics(Size::unscaled(), LocationRef::default()).units_per_em as f32).filter(|u| *u > 0.0).unwrap_or(1000.0)
    }
    /// Glyph for a character (None when the face does not cover it).
    pub fn glyph(&self, c: char) -> Option<u32> {
        self.font()?.charmap().map(c).map(|g| g.to_u32()).filter(|g| *g != 0)
    }
    pub fn has_char(&self, c: char) -> bool {
        self.glyph(c).is_some()
    }
    /// Height of the glyph's vertical origin above its baseline, in pixels.
    /// OpenType VORG takes precedence; TrueType uses the ink top plus vmtx's top bearing.
    pub(crate) fn vertical_origin(&self, gid: u32, px: f32) -> Option<f32> {
        use skrifa::raw::TableProvider;
        let font = self.font()?;
        let glyph = skrifa::GlyphId::new(gid);
        let units = match font.vorg() {
            Ok(table) => f32::from(table.vertical_origin_y(glyph)),
            Err(_) => {
                let bounds = font.glyph_metrics(Size::unscaled(), self.location()).bounds(glyph)?;
                bounds.y_max + f32::from(font.vmtx().ok()?.side_bearing(glyph)?)
            }
        };
        let origin = units * px / self.units_per_em();
        (origin.is_finite() && origin.abs() < px * 4.0).then_some(origin)
    }

    pub fn metrics(&self, px: f32) -> VMetrics {
        let Some(f) = self.font() else {
            return VMetrics {
                ascent: px * 0.8,
                descent: px * 0.2,
                cap_height: px * 0.7,
                x_height: px * 0.5,
                underline_pos: px * 0.1,
                underline_thickness: px * 0.06,
                ..Default::default()
            };
        };
        let m = f.metrics(Size::new(px), self.location());
        VMetrics {
            ascent: m.ascent,
            descent: -m.descent,
            line_gap: m.leading,
            cap_height: m.cap_height.unwrap_or(m.ascent * 0.7),
            x_height: m.x_height.unwrap_or(m.ascent * 0.5),
            underline_pos: m.underline.map_or(px * 0.1, |u| -u.offset),
            underline_thickness: m.underline.map_or(px * 0.06, |u| u.thickness.max(px * 0.03)),
        }
    }
    /// Whether the face's GSUB offers an OpenType feature (e.g. `smcp`).
    pub fn has_feature(&self, tag: &[u8; 4]) -> bool {
        use skrifa::raw::TableProvider;
        let Some(f) = self.font() else { return false };
        let Ok(gsub) = f.gsub() else { return false };
        let Ok(list) = gsub.feature_list() else { return false };
        list.feature_records().iter().any(|r| r.feature_tag().to_be_bytes() == *tag)
    }
}

struct Db {
    faces: Vec<Arc<Face>>,
    scanned: bool,
}

fn db() -> &'static RwLock<Db> {
    static DB: OnceLock<RwLock<Db>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = Db { faces: Vec::new(), scanned: false };
        for b in [INTER_REGULAR, INTER_MEDIUM, INTER_SEMIBOLD, INTER_BOLD, INTER_ITALIC, JETBRAINS_MONO_REGULAR, NOTO_SERIF_REGULAR] {
            for n in read_faces_bytes(b) {
                push_with_instances(&mut db, info_from(n, FaceData::Static(b), "bundled"), b);
            }
        }
        // after the bundled faces, before anything a FontSource finds (a system copy of the same
        // family + style is then skipped as a duplicate)
        for f in KITION_FONTS {
            for n in read_faces_bytes(f.bytes) {
                push_with_instances(&mut db, info_from(n, FaceData::Static(f.bytes), KITION_FONTS_ORIGIN), f.bytes);
            }
        }
        RwLock::new(db)
    })
}

fn push(db: &mut Db, info: FaceInfo) -> FaceId {
    let id = db.faces.len();
    db.faces.push(Arc::new(Face { id, info, bytes: OnceLock::new(), shaper: OnceLock::new(), location: OnceLock::new(), shaper_instance: OnceLock::new() }));
    id
}

/// [`push`] a face read from `bytes`, then its variable font's named instances. Returns their ids.
fn push_with_instances(db: &mut Db, info: FaceInfo, bytes: &[u8]) -> Vec<FaceId> {
    let instances = named_instances(&info, bytes);
    let mut ids = vec![push(db, info)];
    ids.extend(instances.into_iter().map(|i| push(db, i)));
    ids
}

/// Add faces from a source (skipping family+style pairs already present). Returns how many were
/// added.
pub fn add_source(src: &dyn FontSource) -> usize {
    let faces = src.faces();
    let mut d = db().write().unwrap_or_else(|e| e.into_inner());
    let mut n = 0;
    for f in faces {
        let dup = d.faces.iter().any(|g| g.info.family.eq_ignore_ascii_case(&f.family) && g.info.style.eq_ignore_ascii_case(&f.style));
        if !dup {
            push(&mut d, f);
            n += 1;
        }
    }
    n
}

/// Register a font from memory (e.g. a font file the user picked on the web). Returns its faces.
pub fn add_font_data(data: Vec<u8>) -> Vec<FaceId> {
    let data = Arc::new(data);
    let names = read_faces_bytes(&data);
    let mut d = db().write().unwrap_or_else(|e| e.into_inner());
    names.into_iter().flat_map(|n| push_with_instances(&mut d, info_from(n, FaceData::Shared(data.clone()), "user"), &data)).collect()
}

/// Off: [`set_system_fonts`]`(false)`, or `KITION_FILM_NO_SYSTEM_FONTS` set (not `0`) in the
/// environment.
static SYSTEM_FONTS_OFF: AtomicBool = AtomicBool::new(false);

/// Whether the machine's fonts may be read ([`scan_system`]). Turned off, only the built-in fonts,
/// [`KITION_FONTS`] and fonts added at run time are used, so a render is the same on every machine;
/// a family that is none of these is missing and draws the default family.
pub fn set_system_fonts(on: bool) {
    SYSTEM_FONTS_OFF.store(!on, Ordering::Relaxed);
}

/// Whether the machine's fonts are read (see [`set_system_fonts`]).
pub fn system_fonts() -> bool {
    !SYSTEM_FONTS_OFF.load(Ordering::Relaxed) && std::env::var_os("KITION_FILM_NO_SYSTEM_FONTS").is_none_or(|v| v.is_empty() || v == "0")
}

/// Scan the system font folders once (native only; a no-op on wasm). Returns the number of faces
/// added by this call.
pub fn scan_system() -> usize {
    // Held for the whole scan: a concurrent caller waits for the complete list instead of
    // returning early and resolving against a half-filled database.
    static SCAN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _scan = SCAN.lock().unwrap_or_else(|e| e.into_inner());
    if system_scanned() || !system_fonts() {
        return 0;
    }
    let n = if cfg!(target_arch = "wasm32") { 0 } else { add_source(&DirectorySource::system()) };
    db().write().unwrap_or_else(|e| e.into_inner()).scanned = true;
    n
}

pub fn system_scanned() -> bool {
    db().read().unwrap_or_else(|e| e.into_inner()).scanned
}

/// A face by id (unknown ids give the default face).
// The bundled faces are compiled in (`include_bytes!`) and registered when the database is
// created, so `faces` is never empty.
#[allow(clippy::expect_used)]
pub fn face(id: FaceId) -> Arc<Face> {
    let d = db().read().unwrap_or_else(|e| e.into_inner());
    d.faces.get(id).or_else(|| d.faces.first()).cloned().expect("bundled fonts present")
}

/// All faces (bundled first).
pub fn all_faces() -> Vec<Arc<Face>> {
    db().read().unwrap_or_else(|e| e.into_inner()).faces.clone()
}

/// Families with their style names, sorted by family; styles in weight order.
pub fn families() -> Vec<(String, Vec<String>)> {
    let mut m: std::collections::BTreeMap<String, Vec<(bool, u16, String)>> = Default::default();
    for f in all_faces() {
        let v = m.entry(f.info.family.clone()).or_default();
        if !v.iter().any(|(_, _, s)| s == &f.info.style) {
            v.push((f.info.italic, f.info.weight, f.info.style.clone()));
        }
    }
    m.into_iter()
        .map(|(k, mut v)| {
            v.sort();
            (k, v.into_iter().map(|(_, _, s)| s).collect())
        })
        .collect()
}

/// The face chosen for a family/style request, plus synthetic emboldening / slant when the family
/// lacks a real bold / italic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Resolved {
    pub face: FaceId,
    pub synth_bold: bool,
    pub synth_italic: bool,
    /// The requested family was not found (Premiere shows such fonts as missing).
    pub missing: bool,
}

fn style_wants(style: &str) -> (u16, bool) {
    let s = style.to_ascii_lowercase().replace([' ', '-'], "");
    let italic = s.contains("italic") || s.contains("oblique");
    let w = if s.contains("thin") || s.contains("hairline") {
        100
    } else if s.contains("extralight") || s.contains("ultralight") {
        200
    } else if s.contains("light") {
        300
    } else if s.contains("medium") {
        500
    } else if s.contains("semibold") || s.contains("demibold") {
        600
    } else if s.contains("extrabold") || s.contains("ultrabold") {
        800
    } else if s.contains("black") || s.contains("heavy") {
        900
    } else if s.contains("bold") {
        700
    } else {
        400
    };
    (w, italic)
}

/// Resolve a family + style name. Family matching is case-insensitive; a style that the family
/// lacks picks the nearest weight and synthesises bold (≥ 600 requested, ≤ 500 found) or italic.
pub fn resolve(family: &str, style: &str) -> Resolved {
    if let Some(r) = resolve_in(family, style) {
        return r;
    }
    if !system_scanned() && system_fonts() && !family.is_empty() && !family.eq_ignore_ascii_case(DEFAULT_FAMILY) {
        scan_system();
        if let Some(r) = resolve_in(family, style) {
            return r;
        }
    }
    let mut r = resolve_in(DEFAULT_FAMILY, style).unwrap_or(Resolved { face: 0, synth_bold: false, synth_italic: false, missing: true });
    r.missing = !family.is_empty() && !family.eq_ignore_ascii_case(DEFAULT_FAMILY);
    r
}

fn resolve_in(family: &str, style: &str) -> Option<Resolved> {
    let faces = all_faces();
    let fam: Vec<&Arc<Face>> = faces.iter().filter(|f| f.info.family.eq_ignore_ascii_case(family)).collect();
    if fam.is_empty() {
        return None;
    }
    if let Some(f) = fam.iter().find(|f| f.info.style.eq_ignore_ascii_case(style)) {
        return Some(Resolved { face: f.id, synth_bold: false, synth_italic: false, missing: false });
    }
    let (w, it) = style_wants(style);
    let best = fam.iter().min_by_key(|f| {
        let italic_pen = if f.info.italic == it { 0 } else { 1000 };
        italic_pen + (f.info.weight as i32 - w as i32).unsigned_abs()
    })?;
    Some(Resolved { face: best.id, synth_bold: w >= 600 && best.info.weight <= 500, synth_italic: it && !best.info.italic, missing: false })
}

/// Whether a family name reads as a serif face (Noto Serif, Shippori Mincho, …), to pick a Mincho
/// fallback for serif text and a Gothic one otherwise.
fn is_serif(family: &str) -> bool {
    let f = family.to_ascii_lowercase();
    (f.contains("serif") && !f.contains("sans")) || f.contains("mincho")
}

/// A face that covers `c`, preferring `prefer`; bundled, kition-fonts, then loaded and run-time
/// added faces are searched, in that order.
pub fn fallback_for(c: char, prefer: FaceId) -> FaceId {
    let p = face(prefer);
    if p.has_char(c) || c.is_control() {
        return prefer;
    }
    let faces = all_faces();
    // prefer a face of the same italic-ness that is bundled (cheap), then anything loaded already
    for f in faces.iter().filter(|f| f.info.origin == "bundled") {
        if f.has_char(c) {
            return f.id;
        }
    }
    // then the kition-fonts faces (Japanese): Mincho for serif text, Gothic otherwise, nearest weight
    let serif = is_serif(&p.info.family);
    let mut kition_fonts: Vec<&Arc<Face>> = faces.iter().filter(|f| f.info.origin == KITION_FONTS_ORIGIN).collect();
    kition_fonts.sort_by_key(|f| (is_serif(&f.info.family) != serif, f.info.italic != p.info.italic, f.info.weight.abs_diff(p.info.weight)));
    for f in kition_fonts {
        if f.has_char(c) {
            return f.id;
        }
    }
    // then faces whose data is in memory: loaded already, or added from memory at run time
    // ([`add_font_data`]), which nothing may have loaded yet
    for f in faces.iter().filter(|f| f.info.origin != "bundled" && (f.bytes.get().is_some() || matches!(f.info.data, FaceData::Shared(_)))) {
        if f.has_char(c) {
            return f.id;
        }
    }
    prefer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_families_and_resolution() {
        let fams = families();
        let inter = fams.iter().find(|(f, _)| f == "Inter").expect("Inter");
        for s in ["Regular", "Medium", "SemiBold", "Bold", "Italic"] {
            assert!(inter.1.iter().any(|x| x == s), "{s} in {:?}", inter.1);
        }
        assert!(fams.iter().any(|(f, _)| f == "Noto Serif"));
        assert!(fams.iter().any(|(f, _)| f == "JetBrains Mono"));
        let b = resolve("inter", "bold");
        assert_eq!(face(b.face).info.style, "Bold");
        assert!(!b.synth_bold);
        // Noto Serif has only Regular: Bold Italic is synthesised
        let s = resolve("Noto Serif", "Bold Italic");
        assert_eq!(face(s.face).info.family, "Noto Serif");
        assert!(s.synth_bold && s.synth_italic);
        // Inter Bold Italic: nearest is Italic (400) → synth bold
        let bi = resolve("Inter", "Bold Italic");
        assert!(face(bi.face).info.italic && bi.synth_bold && !bi.synth_italic);
    }

    #[test]
    fn missing_family_falls_back_to_inter() {
        let r = resolve("No Such Font Family 123", "Regular");
        assert_eq!(face(r.face).info.family, "Inter");
        assert!(r.missing);
    }

    /// A kition-fonts variable font (`KITION_FONTS`, else `KITION_FONTS_DIR` at test time), or
    /// `None` (the test is skipped).
    fn kition_variable_font(family: &str, file: &str) -> Option<Vec<u8>> {
        KITION_FONTS
            .iter()
            .find(|f| f.family == family)
            .map(|f| f.bytes.to_vec())
            .or_else(|| std::env::var_os("KITION_FONTS_DIR").and_then(|dir| std::fs::read(PathBuf::from(dir).join(file)).ok()))
    }

    /// A variable font's named instances (Lora's Medium, SemiBold, Bold, the italics…)
    /// are listed and resolved as real faces at their axis values, so Lora Bold draws the font's own
    /// bold instead of a faux bold of Regular.
    #[test]
    fn variable_font_lists_and_resolves_its_named_instances() {
        let Some(bytes) = kition_variable_font("Lora", "fonts/lora/Lora-Variable.ttf") else {
            eprintln!("skipped: no Lora variable font (build or run with KITION_FONTS_DIR)");
            return;
        };
        add_font_data(bytes);
        let fams = families();
        let lora = fams.iter().find(|(f, _)| f == "Lora").expect("Lora");
        for s in ["Regular", "Medium", "SemiBold", "Bold"] {
            assert!(lora.1.iter().any(|x| x == s), "{s} in {:?}", lora.1);
        }
        let regular = resolve("Lora", "Regular");
        let bold = resolve("Lora", "Bold");
        assert!(!bold.synth_bold, "Bold is the font's own instance");
        assert_ne!(regular.face, bold.face);
        assert_eq!(face(bold.face).info.weight, 700);
        // the bold outline is heavier: the stem of its "l" is wider
        let stem = |id: FaceId| {
            let f = face(id);
            let g = f.glyph('l').unwrap();
            let font = f.font().unwrap();
            let b = font.glyph_metrics(Size::unscaled(), f.location()).bounds(skrifa::GlyphId::new(g)).unwrap();
            b.x_max - b.x_min
        };
        assert!(stem(bold.face) > stem(regular.face) * 1.15, "{} vs {}", stem(bold.face), stem(regular.face));
    }

    /// Native: the system scan reads name tables only and resolves families installed there.
    #[test]
    fn system_scan_finds_fonts() {
        let t = std::time::Instant::now();
        scan_system(); // (another test may have triggered the scan already)
        let n = all_faces().iter().filter(|f| f.info.origin == "system").count();
        eprintln!("system fonts: {n} faces in {:?}", t.elapsed());
        assert_eq!(scan_system(), 0, "scans once");
        if cfg!(target_os = "macos") {
            assert!(n > 20, "{n}");
            let r = resolve("Helvetica", "Bold");
            assert_eq!(face(r.face).info.family, "Helvetica");
            let l = crate::layout("Helvetica", &crate::TextStyle { family: "Helvetica".into(), size: 30.0, ..Default::default() }, &Default::default());
            assert!(!l.missing_font && l.glyphs.iter().all(|g| g.id != 0));
        }
    }

    /// The configured Japanese faces cover the requested text. The font manifest may ship
    /// only a regular sans face; serif and bold preference are tested independently below.
    #[test]
    fn japanese_falls_back_to_kition_fonts() {
        if kition_fonts_japanese().next().is_none() {
            eprintln!("SKIPPED: built without Japanese kition-fonts (set KITION_FONTS_DIR to run)");
            return;
        }
        let kition_fonts: Vec<_> = all_faces().into_iter().filter(|f| f.info.origin == KITION_FONTS_ORIGIN).collect();
        assert!(kition_fonts.len() >= kition_fonts_japanese().count(), "{} faces", kition_fonts.len());
        let bundled = all_faces().iter().take_while(|f| f.info.origin == "bundled").count();
        assert!(kition_fonts.iter().all(|f| f.id >= bundled), "kition-fonts faces come after the bundled faces");
        for (family, style) in [("Inter", "Regular"), ("Noto Serif", "Regular"), ("Inter", "Bold")] {
            let preferred = resolve(family, style).face;
            for c in "日本語の文字".chars() {
                let fallback = face(fallback_for(c, preferred));
                assert_eq!(fallback.info.origin, KITION_FONTS_ORIGIN, "{family} {style}: {c}");
                assert!(fallback.has_char(c), "{c}: {}", fallback.info.family);
            }
        }
        let l = crate::layout("日本語の文字", &crate::TextStyle { size: 40.0, ..Default::default() }, &Default::default());
        assert_eq!(l.glyphs.len(), 6);
        assert!(l.glyphs.iter().all(|g| g.id != 0), "{:?}", l.glyphs);
    }

    /// Synthetic fonts isolate style preference from changes to the optional font manifest.
    #[test]
    fn kition_fallback_prefers_serif_and_bold_when_available() {
        struct TestSource(Vec<FaceInfo>);
        impl FontSource for TestSource {
            fn faces(&self) -> Vec<FaceInfo> {
                self.0.clone()
            }
        }
        // A private-use character keeps these fixtures separate from real text and other tests.
        let c = '\u{e9a2}';
        let source = TestSource(
            [("Fallback Test Gothic", "Regular", 400), ("Fallback Test Gothic", "Bold", 700), ("Fallback Test Mincho", "Regular", 400)]
                .into_iter()
                .map(|(family, style, weight)| FaceInfo {
                    family: family.into(),
                    style: style.into(),
                    weight,
                    italic: false,
                    index: 0,
                    data: FaceData::Shared(Arc::new(test_font(family, &[(c as u16, c as u16, 2u16.wrapping_sub(c as u16))]))),
                    origin: KITION_FONTS_ORIGIN,
                    instance: None,
                })
                .collect(),
        );
        assert_eq!(add_source(&source), 3);
        for (family, style, expected_family, expected_weight) in [
            ("Inter", "Regular", "Fallback Test Gothic", 400),
            ("Inter", "Bold", "Fallback Test Gothic", 700),
            ("Noto Serif", "Regular", "Fallback Test Mincho", 400),
        ] {
            let fallback = face(fallback_for(c, resolve(family, style).face));
            assert!(fallback.has_char(c));
            assert_eq!(fallback.info.family, expected_family);
            assert_eq!(fallback.info.weight, expected_weight);
        }
    }

    /// A font added at run time with [`add_font_data`] stands in for characters nothing else
    /// covers, before anything has loaded its bytes (W3-59): its data is in memory already, so
    /// trying it is as cheap as trying a loaded face. Hermetic: the font is built in code and
    /// covers one private-use character no bundled or kition-fonts face draws.
    #[test]
    fn a_font_added_at_run_time_is_a_fallback() {
        let c = '\u{e9a1}';
        let inter = resolve("Inter", "Regular").face;
        assert_eq!(fallback_for(c, inter), inter, "nothing covers {c:?} yet");
        let ids = add_font_data(test_font("Late Added Test", &[(c as u16, c as u16, 2u16.wrapping_sub(c as u16))]));
        let &[id] = ids.as_slice() else { panic!("one face expected: {ids:?}") };
        assert_eq!(fallback_for(c, inter), id, "the added face covers {c:?}");
    }

    /// A minimal TrueType font of family `family` (style Regular) built in code: glyph 1 is empty,
    /// glyph 2 a triangle. `segments` are its `cmap` format 4 ranges (first, last, idDelta), in
    /// ascending order.
    fn test_font(family: &str, segments: &[(u16, u16, u16)]) -> Vec<u8> {
        fn u16s(v: &[u16]) -> Vec<u8> {
            v.iter().flat_map(|x| x.to_be_bytes()).collect()
        }
        let cmap4 = {
            let mut segs = segments.to_vec();
            segs.push((0xFFFF, 0xFFFF, 1));
            let n = segs.len() as u16;
            let range = 2 * (1u16 << (15 - n.leading_zeros()));
            let mut t = u16s(&[4, 0, 0, 2 * n, range, 15 - n.leading_zeros() as u16, 2 * n - range]);
            t.extend(u16s(&segs.iter().map(|s| s.1).collect::<Vec<_>>()));
            t.push(0);
            t.push(0);
            t.extend(u16s(&segs.iter().map(|s| s.0).collect::<Vec<_>>()));
            t.extend(u16s(&segs.iter().map(|s| s.2).collect::<Vec<_>>()));
            t.extend(u16s(&vec![0; segs.len()]));
            let len = t.len() as u16;
            t[2..4].copy_from_slice(&len.to_be_bytes());
            t
        };
        let mut cmap = u16s(&[0, 1, 3, 1, 0, 12]);
        cmap.extend(cmap4);
        // glyph 2: one contour of three on-curve points (100,0) (500,0) (300,600)
        let mut glyf = u16s(&[1, 100, 0, 500, 600, 2, 0]);
        glyf.extend([1u8, 1, 1]);
        glyf.extend(u16s(&[100, 400, (-200i16) as u16, 0, 0, 600]));
        glyf.push(0);
        let loca = u16s(&[0, 0, 0, (glyf.len() / 2) as u16]);
        let mut head = u16s(&[1, 0, 1, 0, 0, 0, 0x5F0F, 0x3CF5, 0, 1000]);
        head.extend([0u8; 16]);
        head.extend(u16s(&[100, 0, 500, 600, 0, 8, 2, 0, 0]));
        let mut hhea = u16s(&[1, 0, 800, (-200i16) as u16, 0, 600, 0, 0, 500, 1, 0, 0]);
        hhea.extend([0u8; 8]);
        hhea.extend(u16s(&[0, 3]));
        let hmtx = u16s(&[600, 0, 600, 0, 600, 0]);
        let maxp = u16s(&[1, 0, 3, 3, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
        let strings: Vec<Vec<u8>> = [family, "Regular"].iter().map(|s| s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()).collect();
        let mut name = u16s(&[0, 2, 30]);
        let mut off = 0;
        for (id, st) in strings.iter().enumerate() {
            name.extend(u16s(&[3, 1, 0x409, id as u16 + 1, st.len() as u16, off]));
            off += st.len() as u16;
        }
        strings.iter().for_each(|st| name.extend(st));
        let tables: [(&[u8; 4], Vec<u8>); 8] =
            [(b"cmap", cmap), (b"glyf", glyf), (b"head", head), (b"hhea", hhea), (b"hmtx", hmtx), (b"loca", loca), (b"maxp", maxp), (b"name", name)];
        let mut out = u16s(&[1, 0, tables.len() as u16, 128, 3, 0]);
        let mut offset = 12 + 16 * tables.len();
        let mut body = vec![];
        for (tag, data) in &tables {
            out.extend(*tag);
            out.extend([0u8; 4]);
            out.extend((offset as u32).to_be_bytes());
            out.extend((data.len() as u32).to_be_bytes());
            let padded = data.len().div_ceil(4) * 4;
            body.extend(data);
            body.resize(body.len() + padded - data.len(), 0);
            offset += padded;
        }
        out.extend(body);
        out
    }

    #[test]
    fn metrics_and_coverage() {
        let f = face(resolve("Inter", "Regular").face);
        let m = f.metrics(100.0);
        assert!(m.ascent > 80.0 && m.ascent < 110.0, "{m:?}");
        assert!(m.descent > 10.0 && m.descent < 40.0);
        assert!(m.cap_height > 60.0 && m.cap_height < 80.0);
        assert!(f.has_char('A') && f.has_char('Ж'));
        assert!(!f.has_char('\u{5d0}'), "Inter has no Hebrew");
        assert!(f.has_feature(b"liga") || f.has_feature(b"calt"));
    }
}
