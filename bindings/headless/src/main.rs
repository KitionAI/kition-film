//! `kition-film`: the Film kit for Kition's agent. The same document the in-page editor
//! runs (`kition-film-kit`), served headless over the Kit Protocol by `kition-headless`, as the
//! kit's `kit.json` declares it, with the object model
//! (`model.describe`, `model.batch`) over the document's change exchange.
//!
//! Its documents reach files only through the host (KHP A29): every session the SDK creates keeps
//! off the file system (`Session::host_files_only`), and the process reads no font folder of the
//! machine (as in the page, the kit's own fonts and those the host adds are the only ones).

// The commands in `SANDBOXED` name files but read them through lent files (the workspace,
// never the process's file system), so the agent may use them.
const SANDBOXED: &[&str] = kition_film_kit::files::AGENT_FILE_COMMANDS;
/// `inspect()` keys about the editing session rather than the file.
const VOLATILE: &[&str] = kition_film_kit::EDITOR_STATE;

fn main() -> std::process::ExitCode {
    kition_film_kit::no_system_fonts();
    kition_headless::run_manifest_model::<kition_film_kit::FilmDocument>(include_str!("../../../kit.json"), SANDBOXED, VOLATILE)
}
