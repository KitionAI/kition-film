//! `KITION_FILM_NO_SYSTEM_FONTS=1` keeps the machine's fonts out (renders that must not
//! depend on the machine): a family that is not built in or added stays missing and draws the
//! default family, flagged as missing.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use kition_film_text::fonts;

#[test]
fn system_fonts_off_keeps_renders_machine_independent() {
    // the switch in code (the environment variable sets it for a whole process)
    fonts::set_system_fonts(false);
    let r = fonts::resolve("Helvetica", "Regular");
    assert!(r.missing, "Helvetica is not built in");
    assert_eq!(fonts::face(r.face).info.family, fonts::DEFAULT_FAMILY);
    assert!(fonts::all_faces().iter().all(|f| f.info.origin != "system"), "no machine font was read");
    assert_eq!(fonts::scan_system(), 0);
}
