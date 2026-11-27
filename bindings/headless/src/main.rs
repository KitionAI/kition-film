//! `kition-film`: the Film kit for Kition's agent. The same document the in-page editor
//! runs (`kition-film-kit`), served headless over the Kit Protocol by `kition-headless`, as the
//! kit's `kit.json` declares it, with the object model
//! (`model.describe`, `model.batch`) over the document's change exchange, and the identity a file
//! carries (`file.identity`, `file.fork`): a `.kfilm` is the project as JSON and embeds no
//! replica (the kit makes one under a new id each time it opens a file), so a file carries no
//! identity and a fork is the same bytes.
//!
//! Its documents reach files only through the host (KHP A29): every session the SDK creates keeps
//! off the file system (`Session::host_files_only`), and the process reads no font folder of the
//! machine (as in the page, the kit's own fonts and those the host adds are the only ones).

use kition_headless::{FileIdentity, Headless, KitInfo};

// The commands in `SANDBOXED` name files but read them through lent files (the workspace,
// never the process's file system), so the agent may use them.
const SANDBOXED: &[&str] = kition_film_kit::files::AGENT_FILE_COMMANDS;
/// `inspect()` keys about the editing session rather than the file.
const VOLATILE: &[&str] = kition_film_kit::EDITOR_STATE;

fn main() -> std::process::ExitCode {
    kition_film_kit::no_system_fonts();
    let kit = match KitInfo::from_manifest(include_str!("../../../kit.json"), SANDBOXED, VOLATILE) {
        Ok(kit) => kit,
        Err(error) => {
            eprintln!("kit: {error}");
            return std::process::ExitCode::from(2);
        }
    };
    let backend = Headless::<kition_film_kit::FilmDocument>::with_replica_port(kit.clone()).with_file_identity(FileIdentity::NotEmbedded);
    kition_headless::serve_backend(&kit, backend)
}
