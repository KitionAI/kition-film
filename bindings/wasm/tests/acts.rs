//! Every command declares the editor state it reads (`KitCommand::reads`): what the engine's code
//! reads, found by reading it, not by what descriptions say. Each command's definition (a `cmd!`,
//! `query!` or other constructor call, or a `CommandSpec { … }`) is followed through the engine's
//! functions, the `Session` methods, the macros and the commands it runs (`execute("…")`) to the
//! editor state: the timeline, caption and Project panel selections (`selection`), the open
//! sequence (`part`) and its playhead (`time`). A command that reaches one and does not declare it,
//! or declares what it never reads, fails here (task card C4-film). To see how the scan reached a
//! reading, set `ACTS_DEBUG=<command id>` or `ACTS_FN=<engine function>`; `ACTS_PRINT=1` prints
//! what the scan derives for every command. This scans the three original editor
//! columns, saved object-context Active and timeline/marker/camera/transition/mixer Mode reads, supplemented by reviewed Mode/Active
//! positives; it does not establish complete per-call document premises.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;

// Reviewed, positive Active/Mode readings supplement the source scan.
// Its original equality assertions remain in force for every command.
#[path = "declarations_independent.rs"]
mod independent;

/// Code that reads a selection: the timeline's clips, the caption track's captions, the Project
/// panel's items (`st` and `stt` are the engine's names for `&s.state`).
const SELECTION: &[&str] = &[
    "state.selection",
    "st.selection",
    "state.caption_selection",
    "st.caption_selection",
    "state.project_selection",
    "st.project_selection",
    "stt.project_selection",
];
/// Code that reads which sequence is open.
const PART: &[&str] = &["state.active_sequence", "st.active_sequence"];
/// Code that reads a sequence's playhead.
const TIME: &[&str] = &["state.playheads"];
/// Object contexts are Active editor inputs: track/layer targeting, Source monitor,
/// trim edit points, mask selection and the saved sequence tabs.
const ACTIVE: &[&str] = &[
    "state.targeting",
    "st.targeting",
    "state.graphic_layers",
    "st.graphic_layers",
    "state.source_item",
    "st.source_item",
    "state.source_playhead",
    "st.source_playhead",
    "state.edit_points",
    "st.edit_points",
    "state.selected_mask",
    "st.selected_mask",
    "state.open_sequences",
    "st.open_sequences",
];
const MODE: &[&str] = &[
    "trim_play",
    "mixrec",
    "previews.live",
    "prefs.graphics",
    "state.snapping",
    "st.snapping",
    "state.sequences_as_clips",
    "st.sequences_as_clips",
    "state.selection_follows_playhead",
    "st.selection_follows_playhead",
    "state.show_through_edits",
    "st.show_through_edits",
    "state.ripple_sequence_markers",
    "st.ripple_sequence_markers",
    "state.copy_paste_sequence_markers",
    "st.copy_paste_sequence_markers",
    "state.hidden_marker_colors",
    "st.hidden_marker_colors",
    "state.multicam_audio_follows_video",
    "st.multicam_audio_follows_video",
    "state.multicam_view",
    "st.multicam_view",
    "state.linked_selection",
    "st.linked_selection",
    "state.default_video_transition",
    "st.default_video_transition",
    "state.default_audio_transition",
    "st.default_audio_transition",
    "state.clip_mixer_modes",
    "st.clip_mixer_modes",
];

/// Calls the scan does not follow: running a command (followed by id instead, through `runs`),
/// the engine's command table, and the dispatcher's own checks.
const NOT_FOLLOWED: &[&str] =
    &["execute", "execute_as", "execute_unguarded", "enabled_for", "is_enabled", "build", "command_specs", "commands", "find", "find_spec"];

fn engine_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/engine/engine/src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs")
            && !path.file_name().is_some_and(|n| n == "tests.rs" || n.to_string_lossy().ends_with("_tests.rs"))
        {
            out.push(path);
        }
    }
}

/// `source` with every comment, string and character literal blanked (to spaces), so brackets and
/// names are only the code's; same length, byte for byte.
fn code_only(source: &str) -> Vec<u8> {
    let b = source.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in out.iter_mut().take(to).skip(from) {
            *byte = b' ';
        }
    };
    while i < b.len() {
        let ident_before = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if b[i..].starts_with(b"//") {
            let end = b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |n| i + n);
            blank(&mut out, i, end);
            i = end;
        } else if b[i..].starts_with(b"/*") {
            let end = source[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
            blank(&mut out, i, end);
            i = end;
        } else if !ident_before && (b[i] == b'r' || b[i..].starts_with(b"br")) && {
            let start = if b[i] == b'b' { i + 2 } else { i + 1 };
            let hashes = b[start..].iter().take_while(|&&c| c == b'#').count();
            b.get(start + hashes) == Some(&b'"')
        } {
            let start = if b[i] == b'b' { i + 2 } else { i + 1 };
            let hashes = b[start..].iter().take_while(|&&c| c == b'#').count();
            let close = format!("\"{}", "#".repeat(hashes));
            let body = start + hashes + 1;
            let end = source[body..].find(&close).map_or(b.len(), |n| body + n + close.len());
            blank(&mut out, i, end);
            i = end;
        } else if b[i] == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            blank(&mut out, i, (j + 1).min(b.len()));
            i = j + 1;
        } else if b[i] == b'\'' {
            // A character literal ('a', '\n', '{', 'é'), not a lifetime ('a).
            let rest = &source[i + 1..];
            let len = if let Some(escaped) = rest.strip_prefix('\\') {
                escaped.find('\'').map(|n| n + 2)
            } else {
                rest.chars().next().map(char::len_utf8).filter(|&n| rest[n..].starts_with('\''))
            };
            match len {
                Some(len) => {
                    blank(&mut out, i, i + len + 2);
                    i += len + 2;
                }
                None => i += 1,
            }
        } else {
            i += 1;
        }
    }
    out
}

/// The position after the bracket matching the one at `open`.
fn matching(code: &[u8], open: usize) -> usize {
    let (left, right) = match code[open] {
        b'(' => (b'(', b')'),
        b'{' => (b'{', b'}'),
        _ => (b'[', b']'),
    };
    let mut depth = 0usize;
    for (at, &c) in code.iter().enumerate().skip(open) {
        if c == left {
            depth += 1;
        } else if c == right {
            depth -= 1;
            if depth == 0 {
                return at + 1;
            }
        }
    }
    code.len()
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn ident_at(code: &[u8], at: usize) -> &str {
    let end = code[at..].iter().position(|c| !is_ident(*c)).map_or(code.len(), |n| at + n);
    std::str::from_utf8(&code[at..end]).unwrap_or("")
}

/// The identifier that ends right before `at` (skipping whitespace), and where it starts.
fn ident_before(code: &[u8], at: usize) -> Option<(usize, &str)> {
    let mut end = at;
    while end > 0 && code[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && is_ident(code[start - 1]) {
        start -= 1;
    }
    (start < end).then(|| (start, std::str::from_utf8(&code[start..end]).unwrap_or("")))
}

fn call_path(code: &[u8], at: usize) -> String {
    let mut start = at;
    while start >= 2 && &code[start - 2..start] == b"::" {
        let Some((from, _)) = ident_before(code, start - 2) else { break };
        start = from;
    }
    let end = at + ident_at(code, at).len();
    std::str::from_utf8(&code[start..end]).unwrap().to_owned()
}

/// A local binding shadows a free function only after its initializer and until the
/// containing lexical block ends. Its initializer can still call the free function.
fn local_bindings(code: &[u8]) -> Vec<(String, usize, usize)> {
    let mut scopes = vec![code.len()];
    let mut bindings = Vec::new();
    let mut at = 0;
    while at < code.len() {
        if code[at] == b'{' {
            scopes.push(matching(code, at));
        } else if code[at] == b'}' && scopes.len() > 1 {
            scopes.pop();
        }
        if ident_at(code, at) == "let" && (at == 0 || !is_ident(code[at - 1])) {
            let mut name_at = at + 3;
            while code.get(name_at).is_some_and(u8::is_ascii_whitespace) {
                name_at += 1;
            }
            if ident_at(code, name_at) == "mut" {
                name_at += 3;
                while code.get(name_at).is_some_and(u8::is_ascii_whitespace) {
                    name_at += 1;
                }
            }
            let name = ident_at(code, name_at);
            if !name.is_empty() {
                let mut end = name_at + name.len();
                while end < code.len() && code[end] != b';' {
                    if matches!(code[end], b'(' | b'[' | b'{') {
                        end = matching(code, end);
                    } else {
                        end += 1;
                    }
                }
                bindings.push((name.to_owned(), end.saturating_add(1), *scopes.last().unwrap()));
            }
        }
        at += 1;
    }
    bindings
}

/// The source cut before its `#[cfg(test)]` module, the code of what is left, its file, and the
/// byte ranges of its `impl Session` blocks.
struct File {
    source: String,
    code: Vec<u8>,
    name: String,
    session_impls: Vec<(usize, usize)>,
}

fn files() -> Vec<File> {
    let mut paths = Vec::new();
    rust_files(&engine_src(), &mut paths);
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let mut source = std::fs::read_to_string(&path).unwrap();
            if let Some(at) = source.find("#[cfg(test)]\nmod ") {
                source.truncate(at);
            }
            let code = code_only(&source);
            let text = std::str::from_utf8(&code).unwrap_or("").to_owned();
            let session_impls = ["impl Session {", "impl crate::Session {", "impl super::Session {"]
                .iter()
                .flat_map(|head| text.match_indices(head).map(|(at, head)| (at, matching(&code, at + head.len() - 1))).collect::<Vec<_>>())
                .collect();
            File { name: path.file_stem().unwrap().to_string_lossy().into_owned(), source, code, session_impls }
        })
        .collect()
}

/// What a piece of code reads directly, the free functions, `Session` methods and macros it calls,
/// and the commands it runs.
#[derive(Default, Clone)]
struct Reach {
    reads: BTreeSet<&'static str>,
    calls: BTreeSet<String>,
    methods: BTreeSet<String>,
    runs: BTreeSet<String>,
}

fn reach(code: &[u8], source: &str, modules: &BTreeSet<String>) -> Reach {
    let text = std::str::from_utf8(code).unwrap_or("");
    let mut found = Reach::default();
    let locals = local_bindings(code);
    let has = |token: &str| {
        let parts: Vec<_> = token.split('.').collect();
        text.match_indices(parts[0]).any(|(at, _)| {
            let mut end = at + parts[0].len();
            for part in parts.iter().skip(1) {
                while code.get(end).is_some_and(u8::is_ascii_whitespace) {
                    end += 1;
                }
                if code.get(end) != Some(&b'.') {
                    return false;
                }
                end += 1;
                while code.get(end).is_some_and(u8::is_ascii_whitespace) {
                    end += 1;
                }
                if !text.get(end..).is_some_and(|text| text.starts_with(part)) {
                    return false;
                }
                end += part.len();
            }
            // `state.selection` is not `state.selection_follows_playhead`, nor `my_state.selection`.
            let whole = !code.get(end).copied().is_some_and(is_ident) && !(at > 0 && is_ident(code[at - 1]));
            // Setting it (`st.selection = vec![id]`, `st.selection.clear()`) is no read.
            let rest = text[end..].trim_start();
            let written = (rest.starts_with('=') && !rest.starts_with("=="))
                || [".clear()", ".push(", ".retain(", ".extend(", ".truncate(", ".dedup(", ".insert(", ".remove("].iter().any(|write| rest.starts_with(write));
            whole && !written
        })
    };
    for (kind, tokens) in [("selection", SELECTION), ("part", PART), ("time", TIME), ("active", ACTIVE), ("mode", MODE)] {
        if tokens.iter().any(|token| has(token)) {
            found.reads.insert(kind);
        }
    }
    for at in 0..code.len() {
        let starts = (code[at].is_ascii_alphabetic() || code[at] == b'_') && (at == 0 || !is_ident(code[at - 1]));
        if !starts {
            continue;
        }
        let name = ident_at(code, at);
        let after = at + name.len();
        let dot = code[..at].iter().rposition(|c| !c.is_ascii_whitespace()).filter(|i| code[*i] == b'.');
        let method = dot.is_some();
        if code.get(after) == Some(&b'(') {
            if method {
                // Only Session receivers. `s.shortcuts.undo()` invokes ShortcutMap,
                // not Session::undo; their editor dependencies are unrelated.
                if dot.and_then(|dot| ident_before(code, dot)).is_some_and(|(_, receiver)| ["s", "self", "session"].contains(&receiver)) {
                    found.methods.insert(name.to_owned());
                }
            } else if in_engine(code, at, modules) {
                let path = call_path(code, at);
                let shadowed = path == name && locals.iter().any(|(local, from, to)| local == name && (*from..*to).contains(&at));
                if !shadowed {
                    found.calls.insert(path);
                }
            }
        }
        if code.get(after) == Some(&b'!') && code.get(after + 1).is_some_and(|c| matches!(c, b'(' | b'[' | b'{')) {
            found.calls.insert(format!("{name}!"));
        }
        // `s.execute("playhead.step", …)`: the command runs another, and reads what it reads.
        if ["execute", "execute_as", "execute_unguarded", "find_spec"].contains(&name) && code.get(after) == Some(&b'(') {
            let rest = source[after + 1..].trim_start();
            if let Some(stripped) = rest.strip_prefix('"')
                && let Some(end) = stripped.find('"')
            {
                found.runs.insert(stripped[..end].to_owned());
            }
        }
    }
    found
}

/// Whether the call at `at` is to the engine's own code: unqualified, or through `crate`, `super`,
/// `self` or one of its modules, not `std::mem::take` or another crate's function.
fn in_engine(code: &[u8], at: usize, modules: &BTreeSet<String>) -> bool {
    let mut start = at;
    while start >= 2 && &code[start - 2..start] == b"::" {
        let mut from = start - 2;
        while from > 0 && is_ident(code[from - 1]) {
            from -= 1;
        }
        start = from;
    }
    if start == at {
        return true;
    }
    let first = ident_at(code, start);
    ["crate", "super", "self"].contains(&first) || modules.contains(first)
}

/// A function's or macro's body, by name, with the file it is in: free functions under their
/// name, `Session` methods under `.name`, macros under `name!`.
type Bodies = BTreeMap<String, Vec<(String, Reach)>>;
type RunEdge = (String, String);

/// Parameter-specialized calls, pinned after checking the caller and callee.
/// An exclusion applies to this edge, never to the callee's other callers.
fn delegated_reads(origin: &str, command: &str, reads: &BTreeSet<&'static str>) -> BTreeSet<&'static str> {
    let omit: &[&str] = match (origin, command) {
        // color.rs:171-191 passes effect="color" and explicit clips. The
        // transition-only time/target/default-mode path of commands.rs:2680-2688
        // is unreachable for the literal Color effect.
        ("color::color_clip", "effects.apply") => &["time", "selection", "active", "mode"],
        // Both callers supply an items array; transcript::targets (transcript.rs)
        // returns it before consulting the Project selection.
        ("sequence_extras::transcribe" | "command:file.import", "transcript.generate") => &["selection"],
        // promo.rs:617-620 supplies the clips it just placed/resolved.
        ("promo::bed", "audioMixing.setType" | "audioMixing.set" | "audioMixing.generateDucking") => &["selection"],
        // keyboard::export_frame imports a freshly encoded PNG/TIFF/JPEG/BMP,
        // so neither the captions branch nor a selected transcript can run.
        ("keyboard::export_frame", "file.import") => &["selection", "part", "time"],
        // project_tools.rs:117-123 forces the image-sequence branch, which
        // cannot import a caption document into the open sequence.
        ("command:file.importImageSequence", "file.import") => &["selection", "part", "time"],
        // media_browser.rs:475 supplies the just-resolved item to source.open.
        ("media_browser::open_in_source", "source.open") => &["selection"],
        _ => &[],
    };
    reads.iter().copied().filter(|read| !omit.contains(read)).collect()
}

fn use_tree(tree: &str, prefix: &str, out: &mut BTreeMap<String, String>) {
    let tree = tree.trim();
    if let Some(open) = tree.find('{') {
        let root = format!("{prefix}{}", tree[..open].trim());
        let inner = &tree[open + 1..tree.rfind('}').unwrap()];
        let mut depth = 0;
        let mut from = 0;
        for (at, ch) in inner.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    use_tree(&inner[from..at], &root, out);
                    from = at + 1;
                }
                _ => {}
            }
        }
        use_tree(&inner[from..], &root, out);
    } else if !tree.is_empty() {
        let (path, alias) = tree.split_once(" as ").unwrap_or((tree, ""));
        let path = format!("{prefix}{path}").replace(char::is_whitespace, "");
        let name = if alias.is_empty() { path.rsplit("::").next().unwrap() } else { alias.trim() };
        if name != "*" {
            out.insert(name.to_owned(), path);
        }
    }
}

fn imports(file: &File) -> BTreeMap<String, String> {
    let text = std::str::from_utf8(&file.code).unwrap();
    let mut out = BTreeMap::new();
    for (at, _) in text.match_indices("use ") {
        if at > 0 && is_ident(file.code[at - 1]) {
            continue;
        }
        if let Some(end) = text[at..].find(';') {
            use_tree(&text[at + 4..at + end], "", &mut out);
        }
    }
    out
}

/// Preserve Rust module identity. Unqualified free functions resolve locally or
/// through an import, never to every same-named function in the crate.
fn resolved_bodies<'a>(name: &str, file: &str, bodies: &'a Bodies, imports: &BTreeMap<String, BTreeMap<String, String>>) -> Vec<(String, &'a (String, Reach))> {
    if name.starts_with('.') {
        return bodies.get(name).into_iter().flatten().map(|body| (name.to_owned(), body)).collect();
    }
    if let Some((module, leaf)) = name.rsplit_once("::") {
        let module = module.rsplit("::").next().unwrap();
        let target = match module {
            "crate" | "super" => "lib",
            "self" => file,
            other => other,
        };
        return bodies.get(leaf).into_iter().flatten().filter(|(f, _)| f == target).map(|body| (leaf.to_owned(), body)).collect();
    }
    let own: Vec<_> = bodies.get(name).into_iter().flatten().filter(|(f, _)| f == file).collect();
    if !own.is_empty() {
        return own.into_iter().map(|body| (name.to_owned(), body)).collect();
    }
    if let Some(path) = imports.get(file).and_then(|imports| imports.get(name)) {
        return resolved_bodies(path, file, bodies, imports);
    }
    // Exported macros have lexical visibility across modules. Their definitions
    // are still distinct from free functions and Session methods.
    if name.ends_with('!') {
        return bodies.get(name).into_iter().flatten().map(|body| (name.to_owned(), body)).collect();
    }
    Vec::new()
}

fn bodies(files: &[File], modules: &BTreeSet<String>) -> Bodies {
    let mut out: Bodies = BTreeMap::new();
    for file in files {
        let code = &file.code;
        let text = std::str::from_utf8(code).unwrap_or("");
        for (at, _) in text.match_indices("fn ") {
            if at > 0 && is_ident(code[at - 1]) {
                continue;
            }
            let name = ident_at(code, at + 3).to_owned();
            if name.is_empty() {
                continue;
            }
            let Some(open) = code[at..].iter().position(|&c| c == b'(').map(|n| at + n) else { continue };
            let params_end = matching(code, open);
            let Some(brace) = code[params_end..].iter().position(|&c| c == b'{' || c == b';').map(|n| params_end + n) else { continue };
            if code[brace] == b';' {
                continue;
            }
            let end = matching(code, brace);
            let method = file.session_impls.iter().any(|(from, to)| (*from..*to).contains(&at));
            let mut body = reach(&code[brace..end], &file.source[brace..end], modules);
            if method {
                // Session passes its history operations as function pointers:
                // undo_in -> in_scope(scope, Self::undo), not a direct call.
                let text = std::str::from_utf8(&code[brace..end]).unwrap();
                for (at, _) in text.match_indices("Self::") {
                    body.methods.insert(ident_at(text.as_bytes(), at + 6).to_owned());
                }
            }
            let key = if method { format!(".{name}") } else { name };
            out.entry(key).or_default().push((file.name.clone(), body));
        }
        for (at, _) in text.match_indices("macro_rules!") {
            let name = ident_at(code, at + "macro_rules!".len() + 1).to_owned();
            let Some(brace) = code[at..].iter().position(|&c| c == b'{').map(|n| at + n) else { continue };
            let end = matching(code, brace);
            let body = reach(&code[brace..end], &file.source[brace..end], modules);
            out.entry(format!("{name}!")).or_default().push((file.name.clone(), body));
        }
    }
    out
}

/// The names (functions and macros) whose bodies make a `CommandSpec`, directly or through
/// another of them: `cmd!`, `query!`, the modules' `spec` helpers, `tt!`, …
fn constructors(files: &[File]) -> BTreeSet<String> {
    let mut direct: BTreeMap<String, (String, String)> = BTreeMap::new();
    for file in files {
        let code = &file.code;
        let text = std::str::from_utf8(code).unwrap_or("");
        for (at, _) in text.match_indices("fn ").chain(text.match_indices("macro_rules!")) {
            if at > 0 && is_ident(code[at - 1]) {
                continue;
            }
            let is_macro = text[at..].starts_with("macro_rules!");
            let name = if is_macro { ident_at(code, at + "macro_rules!".len() + 1) } else { ident_at(code, at + 3) };
            let Some(brace) = code[at..].iter().position(|&c| c == b'{').map(|n| at + n) else { continue };
            let end = matching(code, brace);
            let body = text[brace..end].to_owned();
            // A constructor returns one CommandSpec. A function that happens to
            // invoke a constructor/command (execute, import, ...) is not one.
            let head = &text[at..brace];
            if !is_macro && !head.replace(char::is_whitespace, "").contains("->CommandSpec") {
                continue;
            }
            direct.insert(if is_macro { format!("{name}!") } else { name.to_owned() }, (file.name.clone(), body));
        }
    }
    let mut found: BTreeSet<String> = direct.iter().filter(|(_, (_, body))| body.contains("CommandSpec {")).map(|(name, _)| name.clone()).collect();
    // `let q = |id, label, params, run| CommandSpec { … };`: a module's local constructor.
    for file in files {
        let text = std::str::from_utf8(&file.code).unwrap_or("");
        for (at, _) in text.match_indices("let ") {
            let name = ident_at(&file.code, at + 4);
            let rest = text[at + 4 + name.len()..].trim_start();
            if !name.is_empty() && rest.starts_with("= |") && rest.split(';').next().is_some_and(|statement| statement.contains("CommandSpec {")) {
                found.insert(name.to_owned());
            }
        }
    }
    loop {
        let more: Vec<String> = direct
            .iter()
            .filter(|(name, _)| !found.contains(*name))
            .filter(|(_, (_, body))| found.iter().any(|c| body.contains(&format!("{c}("))))
            .map(|(name, _)| name.clone())
            .collect();
        if more.is_empty() {
            break;
        }
        found.extend(more);
    }
    found
}

/// The code that defines command `id`: the call to a constructor whose first argument is the id,
/// or the `CommandSpec { id: "…", … }` (also one whose id a macro writes with `concat!`), with the
/// constructor itself as a call.
fn definitions(id: &str, files: &[File], constructors: &BTreeSet<String>, functions: &BTreeSet<String>, modules: &BTreeSet<String>) -> Vec<(String, Reach)> {
    let mut out = Vec::new();
    let literal = format!("\"{id}\"");
    for file in files {
        let code = &file.code;
        let source = &file.source;
        let text = std::str::from_utf8(code).unwrap_or("");
        let locals = local_bindings(code);
        let mut region = |from: usize, to: usize, constructor: Option<String>| {
            let mut found = reach(&code[from..to], &source[from..to], modules);
            // A function given by name (`enabled: has_seq`, `run: detect_beats`, `q(…, events_list)`).
            for at in from..to {
                if is_ident(code[at]) && !code[at].is_ascii_digit() && (at == 0 || !(is_ident(code[at - 1]) || code[at - 1] == b'.')) {
                    let name = ident_at(code, at);
                    let next = code.get(at + name.len()).copied().unwrap_or(b' ');
                    if next != b'(' && next != b'!' && functions.contains(name) && in_engine(code, at, modules) {
                        let path = call_path(code, at);
                        let bound = locals.iter().any(|(local, start, end)| local == name && (*start..*end).contains(&at));
                        let declaration = ident_before(code, at).is_some_and(|(before, previous)| {
                            previous == "let" || (previous == "mut" && ident_before(code, before).is_some_and(|(_, previous)| previous == "let"))
                        });
                        if path != name || (!bound && !declaration) {
                            found.calls.insert(path);
                        }
                    }
                }
            }
            if let Some(constructor) = constructor {
                found.calls.insert(constructor);
            }
            out.push((file.name.clone(), found));
        };
        let spec_around = |at: usize| -> Option<(usize, usize)> {
            let start = text[..at].rfind("CommandSpec {")?;
            let open = start + "CommandSpec ".len();
            let end = matching(code, open);
            (end > at).then_some((open, end))
        };
        for (at, _) in source.match_indices(&literal) {
            let mut before = at;
            while before > 0 && code[before - 1].is_ascii_whitespace() {
                before -= 1;
            }
            if before > 0 && code[before - 1] == b'(' {
                let mut callee_end = before - 1;
                let bang = callee_end > 0 && code[callee_end - 1] == b'!';
                if bang {
                    callee_end -= 1;
                }
                let Some((_, name)) = ident_before(code, callee_end) else { continue };
                let name = if bang { format!("{name}!") } else { name.to_owned() };
                if constructors.contains(&name) {
                    region(before - 1, matching(code, before - 1), Some(name));
                }
            } else if before >= 3
                && &code[before - 3..before] == b"id:"
                && let Some((open, end)) = spec_around(at)
            {
                region(open, end, None);
            }
        }
        // `concat!("multicam.selectCamera", $n)`: the macro writes the number.
        for (at, _) in text.match_indices("concat!(") {
            let rest = source[at + "concat!(".len()..].trim_start();
            let Some(prefix) = rest.strip_prefix('"').and_then(|rest| rest.split('"').next()) else { continue };
            let tail = id.strip_prefix(prefix);
            if prefix.contains('.')
                && tail.is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|c| c.is_ascii_digit()))
                && let Some((open, end)) = spec_around(at)
            {
                region(open, end, None);
            }
        }
    }
    out
}

/// What every command reads, through the functions, methods, macros and commands it reaches.
fn derived(ids: &[String]) -> BTreeMap<String, BTreeSet<&'static str>> {
    let files = files();
    let mut modules: BTreeSet<String> = files.iter().map(|file| file.name.clone()).collect();
    modules.insert("commands".into());
    let bodies = bodies(&files, &modules);
    let imports: BTreeMap<_, _> = files.iter().map(|file| (file.name.clone(), imports(file))).collect();
    let constructors = constructors(&files);
    let functions: BTreeSet<String> = bodies
        .keys()
        .filter(|name| !name.starts_with('.') && !name.ends_with('!'))
        .cloned()
        .chain(imports.values().flat_map(|imports| imports.keys().cloned()))
        .collect();
    // A body's reads, to a fixed point over resolved calls.
    let mut reads: BTreeMap<(String, String), BTreeSet<&'static str>> = BTreeMap::new();
    let mut body_runs: BTreeMap<(String, String), BTreeSet<RunEdge>> = BTreeMap::new();
    for (name, defs) in &bodies {
        for (file, body) in defs {
            let mut direct = body.reads.clone();
            // interchange.rs:113-118 and sequence_extras.rs:497-512 only ask
            // whether the newly allocated sequence id is already an open tab.
            // No old tab can name it: format validation rejects counters that
            // reuse live ids, and the replica reader keeps its allocation floor.
            if (file == "interchange" && name == "import") || (file == "sequence_extras" && name == "simplify") {
                direct.remove("active");
            }
            reads.insert((name.clone(), file.clone()), direct);
            body_runs.insert((name.clone(), file.clone()), body.runs.iter().map(|id| (id.clone(), format!("{file}::{name}"))).collect());
        }
    }
    let callees = |body: &Reach, file: &str| -> Vec<String> {
        body.calls
            .iter()
            // project_tools::find is an editing handler, not registry lookup.
            .filter(|call| !NOT_FOLLOWED.contains(&call.rsplit("::").next().unwrap()) || file == "project_tools" && call.as_str() == "find")
            .cloned()
            .chain(body.methods.iter().filter(|method| !NOT_FOLLOWED.contains(&method.as_str())).map(|method| format!(".{method}")))
            .collect()
    };
    let resolve = |name: &str, file: &str, reads: &BTreeMap<(String, String), BTreeSet<&'static str>>| -> BTreeSet<&'static str> {
        resolved_bodies(name, file, &bodies, &imports)
            .iter()
            .flat_map(|(key, (f, _))| reads.get(&(key.clone(), f.clone())).cloned().unwrap_or_default())
            .collect()
    };
    let resolve_runs = |name: &str, file: &str, runs: &BTreeMap<(String, String), BTreeSet<RunEdge>>| -> BTreeSet<RunEdge> {
        resolved_bodies(name, file, &bodies, &imports)
            .iter()
            .flat_map(|(key, (f, _))| runs.get(&(key.clone(), f.clone())).cloned().unwrap_or_default())
            .collect()
    };
    loop {
        let mut changed = false;
        for (name, defs) in &bodies {
            for (file, body) in defs {
                let mut now = reads.get(&(name.clone(), file.clone())).cloned().unwrap_or_default();
                let mut run_now = body_runs.get(&(name.clone(), file.clone())).cloned().unwrap_or_default();
                for call in callees(body, file) {
                    if &call != name {
                        let mut called = resolve(&call, file, &reads);
                        // proxies.rs:449-453 supplies items to create; the
                        // Project-selection fallback in proxies::items is dead.
                        if file == "proxies" && name == "ingest" && call == "create" {
                            called.remove("selection");
                        }
                        // beats.rs:89-95 rejects non-media sound items before
                        // promo::place_sound calls place_item_on:181 with audio
                        // only and insert=false. The nesting/scaling/ripple
                        // switches cannot affect that media-only placement.
                        if file == "promo" && name == "place_sound" && call == "place_item_on" {
                            called.remove("mode");
                        }
                        now.extend(called);
                        run_now.extend(resolve_runs(&call, file, &body_runs));
                    }
                }
                if body_runs.get(&(name.clone(), file.clone())) != Some(&run_now) {
                    body_runs.insert((name.clone(), file.clone()), run_now);
                    changed = true;
                }
                if reads.get(&(name.clone(), file.clone())) != Some(&now) {
                    reads.insert((name.clone(), file.clone()), now);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    if let Ok(wanted) = std::env::var("ACTS_FN") {
        for (file, body) in bodies.get(&wanted).into_iter().flatten() {
            eprintln!("{wanted} in {file}: direct {:?}", body.reads);
            for call in callees(body, file) {
                eprintln!("  calls {call}: {:?}", resolve(&call, file, &reads));
            }
        }
    }
    let mut commands: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    let mut runs: BTreeMap<String, BTreeSet<RunEdge>> = BTreeMap::new();
    let mut missing = Vec::new();
    for id in ids {
        let defs = definitions(id, &files, &constructors, &functions, &modules);
        if defs.is_empty() {
            missing.push(id.clone());
        }
        let mut now = BTreeSet::new();
        for (file, def) in &defs {
            now.extend(def.reads.iter().copied());
            for call in callees(def, file) {
                now.extend(resolve(&call, file, &reads));
                runs.entry(id.clone()).or_default().extend(resolve_runs(&call, file, &body_runs));
                if std::env::var("ACTS_DEBUG").is_ok_and(|wanted| wanted == *id) {
                    eprintln!("{id} ({file}) calls {call}: {:?}", resolve(&call, file, &reads));
                }
            }
            runs.entry(id.clone()).or_default().extend(def.runs.iter().map(|other| (other.clone(), format!("command:{id}"))));
        }
        // commands.rs:943-1000 / clip_ops.rs:661-714 create/open a new destination before
        // targeting/place_item consume Part. This is no read of the old Part.
        if id == "file.newSequence" || id == "file.newSequenceFromClip" {
            now.remove("part");
            now.remove("active");
        }
        // multicam.rs:1069-1081 sets layout and page from parameters before
        // layout_name reads the newly assigned layout. No old view is an input.
        if id == "multicam.gridLayout" {
            now.remove("mode");
        }
        // clip_ops.rs:1749-1767 resolves From Bin from its explicit item or
        // Project selection; only the other two variants use the Source item.
        // Lines 1775-1797 calculate both playheads eagerly, but only Match Frame
        // consumes them. Ordinary replacement keeps the target start unchanged.
        if id == "clip.replaceFromBin" {
            now.remove("active");
            now.remove("time");
        } else if id == "clip.replaceFromSource" {
            now.remove("time");
        }
        commands.insert(id.clone(), now);
    }
    assert!(missing.is_empty(), "the scan finds no definition of {} commands: {}", missing.len(), missing.join(", "));
    // Commands that run other commands read what those read.
    loop {
        let mut changed = false;
        for id in ids {
            let mut now = commands[id].clone();
            for (other, origin) in runs.get(id).into_iter().flatten() {
                now.extend(delegated_reads(origin, other, &commands.get(other).cloned().unwrap_or_default()));
            }
            if commands[id] != now {
                commands.insert(id.clone(), now);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    for (id, reads) in &mut commands {
        reads.extend(independent::reviewed_editor_reads(id));
    }
    commands
}

/// The kit's commands: the engine's, and `file.render`, the binding's own, which draws an explicit
/// view and reads no editor state.
fn engine_ids(doc: &FilmDocument) -> Vec<String> {
    doc.commands().into_iter().map(|command| command.id).filter(|id| id != "file.render").collect()
}

#[test]
fn every_restored_context_field_has_an_editor_input_class() {
    let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/context.rs"));
    let saved = source.split_once("pub struct CallState {").unwrap().1.split_once("\n}").unwrap().0;
    for line in saved.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (field, _) = line.split_once(':').unwrap();
        let classes: Vec<_> = [("selection", SELECTION), ("part", PART), ("time", TIME), ("active", ACTIVE), ("mode", MODE)]
            .into_iter()
            .filter_map(|(class, tokens)| tokens.iter().any(|token| token.rsplit('.').next() == Some(field)).then_some(class))
            .collect();
        assert_eq!(classes.len(), 1, "restored context {field} needs one source-backed editor-input classification: {classes:?}");
    }
}

#[test]
fn scanner_reads_a_selection_split_across_rust_whitespace() {
    let source = "s.state\n    .selection.iter().next()";
    let read = reach(&code_only(source), source, &BTreeSet::new());
    assert!(read.reads.contains("selection"), "a line break does not change the field read");
    let source = "st.selection = Vec::new()";
    let written = reach(&code_only(source), source, &BTreeSet::new());
    assert!(!written.reads.contains("selection"), "an assignment alone does not read its old value");
}

#[test]
fn scanner_follows_a_command_delegated_inside_a_helper() {
    // graphics.rs:671-674 delegates through new_shape_cmd -> find_spec(...).run.
    let commands = derived(&["graphics.newRectangle".to_owned(), "graphics.newShape".to_owned()]);
    assert!(commands["graphics.newShape"].contains("time"));
    assert!(commands["graphics.newRectangle"].contains("time"), "the wrapper consumes the same placement time");
}

#[test]
fn scanner_keeps_qualified_functions_distinct() {
    let source = "crate::snap::apply(s, p); super::other::apply(s, p);";
    let read = reach(&code_only(source), source, &BTreeSet::from(["snap".into(), "other".into()]));
    assert_eq!(read.calls, BTreeSet::from(["crate::snap::apply".into(), "super::other::apply".into()]));
}

#[test]
fn scanner_does_not_follow_a_local_closure_as_a_global_function() {
    let source = "{ let mut add = |x| { x }; add(1); } add(2); crate::masks::add(s, p);";
    let read = reach(&code_only(source), source, &BTreeSet::from(["masks".into()]));
    assert_eq!(read.calls, BTreeSet::from(["add".into(), "crate::masks::add".into()]));
    let source = "let mut add = |x| { x }; add(1);";
    let read = reach(&code_only(source), source, &BTreeSet::new());
    assert!(read.calls.is_empty(), "a closure named add is not masks::add");
}

#[test]
fn scanner_distinguishes_session_methods_and_imported_function_aliases() {
    let source = "s.shortcuts.undo(); s.undo();";
    assert_eq!(reach(&code_only(source), source, &BTreeSet::new()).methods, BTreeSet::from(["undo".into()]));
    let source = "s.shortcuts.undo();";
    assert!(reach(&code_only(source), source, &BTreeSet::new()).methods.is_empty());
    let bodies = BTreeMap::from([("apply".into(), vec![("snap".into(), Reach::default()), ("presets".into(), Reach::default())])]);
    let mut imported = BTreeMap::new();
    use_tree("crate::snap::{apply as snap_apply}", "", &mut imported);
    let imports = BTreeMap::from([("commands".into(), imported)]);
    for path in ["crate::snap::apply", "snap_apply"] {
        let resolved = resolved_bodies(path, "commands", &bodies, &imports);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].0, "apply");
        assert_eq!(resolved[0].1.0, "snap");
    }
    assert!(resolved_bodies("apply", "commands", &bodies, &imports).is_empty());
}

#[test]
fn scanner_distinguishes_local_values_and_function_pointer_callbacks() {
    let source = r#"cmd!("test.local", "Toggle", [], None, "{}", always, |s, p| {
        let nest = true;
        Ok(json!({"nest": nest}))
    });"#;
    let file = File { source: source.into(), code: code_only(source), name: "sample".into(), session_impls: vec![] };
    let defs = definitions("test.local", &[file], &BTreeSet::from(["cmd!".into()]), &BTreeSet::from(["nest".into()]), &BTreeSet::new());
    assert_eq!(defs.len(), 1);
    assert!(!defs[0].1.calls.contains("nest"), "a local Boolean is not the nest handler");
    let source = r#"cmd!("test.callback", "Callback", [], None, "{}", always, nest);"#;
    let file = File { source: source.into(), code: code_only(source), name: "sample".into(), session_impls: vec![] };
    let defs = definitions("test.callback", &[file], &BTreeSet::from(["cmd!".into()]), &BTreeSet::from(["nest".into()]), &BTreeSet::new());
    assert!(defs[0].1.calls.contains("nest"), "a real callback must still be followed");
}

#[test]
fn scanner_finds_linked_selection_as_a_mode_input() {
    let source = "if s.state.linked_selection { with_links(s, ids); }";
    assert!(reach(&code_only(source), source, &BTreeSet::new()).reads.contains("mode"));
}

#[test]
fn scanner_finds_live_controls_and_recorded_gestures_as_mode_inputs() {
    for source in ["s.mixrec.active()", "s.previews.live.get(strip, lane)"] {
        assert!(reach(&code_only(source), source, &BTreeSet::new()).reads.contains("mode"), "{source}");
    }
}

#[test]
fn scanner_classifies_transition_defaults_and_clip_mixer_modes() {
    for source in ["s.state.default_video_transition.clone()", "st.default_audio_transition.clone()", "s.state.clip_mixer_modes.get(&track)"] {
        assert!(reach(&code_only(source), source, &BTreeSet::new()).reads.contains("mode"), "{source}");
    }
}

#[test]
fn scanner_follows_graphics_preference_reads() {
    for source in ["let gp = s.prefs.graphics.clone();", "let gp = s.prefs\n .graphics.clone();"] {
        assert_eq!(reach(&code_only(source), source, &BTreeSet::new()).reads, BTreeSet::from(["mode"]));
    }
}

#[test]
fn scanner_classifies_restored_timeline_marker_and_camera_switches_as_mode() {
    for field in [
        "snapping",
        "sequences_as_clips",
        "selection_follows_playhead",
        "show_through_edits",
        "ripple_sequence_markers",
        "copy_paste_sequence_markers",
        "hidden_marker_colors",
        "multicam_audio_follows_video",
        "multicam_view",
    ] {
        for receiver in ["s.state", "st"] {
            let source = format!("let previous = {receiver}.{field};");
            let found = reach(&code_only(&source), &source, &BTreeSet::new());
            assert_eq!(found.reads, BTreeSet::from(["mode"]), "{source}");
        }
    }
}

#[test]
fn scanner_classifies_track_targeting_as_active_input() {
    let source = "let targets = s.state.targeting.get(&sequence);";
    assert!(reach(&code_only(source), source, &BTreeSet::new()).reads.contains("active"));
}

#[test]
fn scanner_classifies_selected_graphic_layers_as_active_input() {
    for source in ["let layers = s.state.graphic_layers.clone();", "let first = st.graphic_layers.first();"] {
        assert!(reach(&code_only(source), source, &BTreeSet::new()).reads.contains("active"), "{source}");
    }
    let source = "st.graphic_layers = Vec::new();";
    assert!(!reach(&code_only(source), source, &BTreeSet::new()).reads.contains("active"), "a replacement alone does not use the old selection");
}

#[test]
fn scanner_classifies_restored_object_contexts_as_active() {
    for field in ["source_item", "source_playhead", "edit_points", "selected_mask", "open_sequences"] {
        for receiver in ["s.state", "st"] {
            let source = format!("let previous = {receiver}.{field};");
            let found = reach(&code_only(&source), &source, &BTreeSet::new());
            assert_eq!(found.reads, BTreeSet::from(["active"]), "{source}");
        }
    }
}

#[test]
fn mask_commands_declare_the_selected_mask_input() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let commands = doc.commands();
    for id in ["masks.add", "masks.set", "masks.remove", "masks.select"] {
        let command = commands.iter().find(|command| command.id == id).unwrap();
        assert!(command.reads.contains(&kition_kit::EditorState::Active), "{id}: {:?}", command.reads);
    }
}

#[test]
fn graphic_keyboard_commands_declare_their_selected_layer_input() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let missing: Vec<_> = doc
        .commands()
        .into_iter()
        .filter(|command| {
            (command.id.starts_with("graphics.fontSize")
                || command.id.starts_with("graphics.leading")
                || command.id.starts_with("graphics.alignText")
                || command.id.starts_with("graphics.nudge"))
                && !command.reads.iter().any(|state| state.as_str() == "active")
        })
        .map(|command| command.id)
        .collect();
    assert!(missing.is_empty(), "keyboard.rs:424-496 resolves state.graphic_layers: {missing:?}");
}

#[test]
fn scanner_does_not_treat_a_command_caller_as_a_constructor() {
    let source = "fn spec() -> CommandSpec { CommandSpec {} } fn execute() { spec(); }";
    let file = File { source: source.into(), code: code_only(source), name: "sample".into(), session_impls: vec![] };
    assert_eq!(constructors(&[file]), BTreeSet::from(["spec".into()]));
}

#[test]
fn scanner_audits_every_other_receiver_of_a_session_method_name() {
    let files = files();
    let modules = files.iter().map(|file| file.name.clone()).collect();
    let bodies = bodies(&files, &modules);
    let methods: BTreeSet<_> = bodies.keys().filter_map(|name| name.strip_prefix('.')).collect();
    // Pinned from receiver-type review, not from reads.json. ReplicaPort's local
    // `kdm` is the replica, not Session (kdm_bridge.rs:175-189,420-435).
    // lib.rs:798,835 bind p/w from Session.persistence (autosave::Worker).
    // shortcuts.rs:1169-1170 call the ShortcutMap field.
    let reviewed = BTreeSet::from([
        ("kdm_bridge", "kdm", "import_changes"),
        ("kdm_bridge", "kdm", "redo_in"),
        ("kdm_bridge", "kdm", "undo_in"),
        ("kdm_bridge", "kdm", "version"),
        ("kdm_bridge", "ensure_kdm()?", "version"),
        ("kdm_bridge", "ensure_kdm()?", "snapshot"),
        ("kdm_bridge", "ensure_kdm()?", "state_hash"),
        ("kdm_bridge", "ensure_kdm()?", "export_changes"),
        ("lib", "p", "drain_events"),
        ("lib", "w", "set_prefs"),
        ("shortcuts", "shortcuts", "undo"),
        ("shortcuts", "shortcuts", "redo"),
    ]);
    let mut actual = BTreeSet::new();
    for file in &files {
        for at in 0..file.code.len() {
            if !is_ident(file.code[at]) || (at > 0 && is_ident(file.code[at - 1])) {
                continue;
            }
            let Some((dot, _)) = (at > 0).then(|| file.code[..at].iter().enumerate().rev().find(|(_, c)| !c.is_ascii_whitespace())).flatten() else { continue };
            if file.code[dot] != b'.' {
                continue;
            }
            let name = ident_at(&file.code, at);
            if !methods.contains(name) || file.code.get(at + name.len()) != Some(&b'(') {
                continue;
            }
            let Some((_, receiver)) = ident_before(&file.code, dot) else {
                // kdm_bridge.rs:152-167: ensure_kdm returns the replica; `?`
                // unwraps its Result before calling the replica's method.
                if file.name == "kdm_bridge"
                    && std::str::from_utf8(&file.code[..dot]).unwrap().trim_end().ends_with("self.ensure_kdm().ok_or_else(no_replica)?")
                {
                    actual.insert((file.name.as_str(), "ensure_kdm()?", name));
                    continue;
                }
                panic!("{}: unclassified expression receiver of Session-named method {name}; resolve its type before using the projection", file.name);
            };
            if !["s", "self", "session"].contains(&receiver) {
                actual.insert((file.name.as_str(), receiver, name));
            }
        }
    }
    assert_eq!(actual, reviewed, "a new receiver needs a type review; never silently drop its editor reads");
}

#[test]
fn every_command_declares_the_editor_state_its_code_reads() {
    // Resolution corrections pinned after declaration review (C8-film-read).
    // The original blind rows are retained, including overstatements:
    // - commands.rs:915-933 replaces editor state; a demo does not consume it.
    // - aaf_omf.rs:434-440 -> interchange.rs:29-122 imports new sequences,
    //   writes active/open sequence, and reads no old Part/Selection/Time.
    // - commands.rs:1372-1379 -> kdm_bridge.rs:108-123 -> lib.rs:1103-1198:
    //   undo/redo fix the active sequence, but never read the playhead.
    // - commands.rs:1495-1540 speed edits read clips and their sequence, not time.
    // - commands.rs:381-455,2211-2339,2354-2401 resolve explicit movement/trim
    //   targets and snap::apply; the presets::apply Selection path is unrelated.
    // - trim.rs:86-113,339-365 uses edit points, not timeline Selection/Time.
    // - multicam.rs:502-649 -> settings_for:477-489 derives settings from source
    //   items and project selection, not the active sequence.
    // - graphics.rs:671-674,703-718 -> newShape:907-959 -> place_video_clip:
    //   125 consumes time; graphic_templates.rs:1019-1045 has a local add
    //   closure and reads only project data. masks::add is a different function.
    // - shortcuts.rs:798-817 undoes ShortcutMap history, not Session history.
    // - relink.rs:134-164,401-548 works on source items/paths, not editor time.
    // - commands.rs:1077-1195 and captions.rs:110-147 import media or a caption
    //   track; only captions consume Part. See delegated_reads for explicit
    //   transcript items and image-sequence/raster restrictions.
    // - masks.rs:128-142 reads multiline Selection; keyboard.rs:105-122
    //   reveal_nested does too. Their old scan missed the line break.
    // - panels.rs:164-175,273-339 resolves metadata from item/clip/Selection,
    //   not Time. media_browser.rs:426-475 imports before opening Source, so it
    //   can consume Part through a caption import. Source receives explicit item.
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let ids = engine_ids(&doc);
    let derived = derived(&ids);
    if std::env::var("ACTS_PRINT").is_ok() {
        let table: BTreeMap<&String, Vec<&str>> = derived.iter().map(|(id, reads)| (id, reads.iter().copied().collect::<Vec<_>>())).collect();
        println!("{}", serde_json::to_string_pretty(&table).unwrap());
    }
    let mut wrong = Vec::new();
    for command in doc.commands() {
        let mut declared: BTreeSet<&str> = command.reads.iter().map(|state| state.as_str()).collect();
        if matches!(command.id.as_str(), "clip.rename" | "clip.setTimeInterpolation") {
            // commands.rs:1491-1503 and clips_p:328-332 consume Selection
            // conditionally. Certify its private fact declaration before counting
            // that representation as the same read derived by the source scan.
            let name = if command.id == "clip.rename" { "renameSelection" } else { "interpolationSelection" };
            let under = doc.under(&command.id, &serde_json::json!({})).unwrap().unwrap();
            assert!(
                under.premises.iter().any(|held| held.id == "project" && held.fields.as_ref().is_some_and(|fields| fields.contains(&format!("~{name}")))),
                "{under:?}"
            );
            let fact = doc.projected_objects().unwrap().into_iter().find(|object| object.id == "film:editor-premises").unwrap();
            let state = doc.editor_state();
            assert_eq!(serde_json::json!(fact.fields["selection"]), state["selection"]);
            let schema: serde_json::Value = serde_json::from_str(include_str!("../../../crates/kdm/kdm-model/model/schema.json")).unwrap();
            assert_eq!(schema["types"]["Project"]["derived"][name]["premiseOnly"], true);
            assert_eq!(schema["types"]["Project"]["derived"][name]["onDemand"], true);
            declared.insert("selection");
        }
        let expected: BTreeSet<&str> = derived.get(&command.id).map_or_else(BTreeSet::new, |reads| reads.iter().copied().collect());
        if declared != expected {
            wrong.push(format!("{}: declares {declared:?}, its code reads {expected:?}", command.id));
        }
    }
    assert!(wrong.is_empty(), "{} commands declare other editor state than they read:\n{}", wrong.len(), wrong.join("\n"));
}
