//! The user preferences as the web editor keeps them (upstream's preferences file): the engine
//! owns them for its page, and the editor persists them in the kit store. These read-only extras
//! and the one load never touch the document: no journal, no history step, no replica change,
//! and a preview's scratch copy keeps its own preferences.

use kition_film_engine::autosave::Preferences;
use serde_json::{Value, json};

use crate::FilmDocument;

impl FilmDocument {
    /// The preferences' revision: it moves whenever any command changes them (the engine's
    /// `Session::set_prefs`, which every preference change goes through) and with each
    /// [`Self::load_prefs`] that changes them, so the editor knows when to store them.
    pub fn prefs_version(&self) -> u64 {
        self.session.prefs_revision
    }

    /// The preferences and their revision: `{version, values}`, `values` as `prefs.get` with no
    /// key answers them.
    pub fn prefs_value(&self) -> Value {
        json!({ "version": self.session.prefs_revision, "values": self.session.prefs.to_value() })
    }

    /// Takes stored preferences (a JSON object, as [`Self::prefs_value`]'s `values`): read as
    /// upstream reads its preferences file (migrated, repaired against the schema, clamped) and
    /// set as `prefs.set` sets them, without running a command, but only while the revision is
    /// still `expected` (the one the editor merged from): a command that changed a preference
    /// since would otherwise be lost. Answers `{loaded, version, values}`, the preferences as the
    /// engine holds them after (a refused load leaves them as they were, to merge again).
    pub fn load_prefs(&mut self, json: &str, expected: u64) -> Result<Value, String> {
        let value: Value = serde_json::from_str(json).map_err(|error| format!("preferences: {error}"))?;
        if !value.is_object() {
            return Err("preferences: not an object".into());
        }
        let loaded = self.session.prefs_revision == expected;
        if loaded {
            self.session.set_prefs(Preferences::from_value(value)).map_err(|error| format!("saving preferences: {error}"))?;
        }
        Ok(json!({ "loaded": loaded, "version": self.session.prefs_revision, "values": self.session.prefs.to_value() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::fixture;
    use kition_kit::KitDocument;

    fn templates(doc: &FilmDocument) -> Value {
        doc.prefs_value()["values"]["guides"]["templates"].clone()
    }

    #[test]
    fn the_revision_moves_with_every_preference_change_and_only_then() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let start = doc.prefs_version();
        doc.execute("prefs.set", json!({ "key": "guides.templates", "value": [{ "name": "Thirds", "guides": [{ "vertical": true, "position": 640.0 }] }] }))
            .unwrap();
        let set = doc.prefs_version();
        assert!(set > start, "prefs.set moves it");
        doc.execute("prefs.set", json!({ "key": "guides.templates", "value": [{ "name": "Thirds", "guides": [{ "vertical": true, "position": 640.0 }] }] }))
            .unwrap();
        assert_eq!(doc.prefs_version(), set, "the same values again do not");
        // A command that keeps its own preferences (a view preset) moves it too.
        doc.execute("project.viewPreset.saveAs", json!({ "name": "Mine" })).unwrap();
        assert!(doc.prefs_version() > set, "project.viewPreset.saveAs moves it");
        let preset = doc.prefs_version();
        doc.execute("project.view.set", json!({ "view": "list" })).unwrap();
        doc.execute("project.view.set", json!({ "view": "icon" })).unwrap();
        assert!(doc.prefs_version() > preset, "project.view.set moves it");
        // Reads do not.
        let read = doc.prefs_version();
        doc.execute("prefs.get", json!({})).unwrap();
        doc.execute("project.view.get", json!({})).unwrap();
        assert_eq!(doc.prefs_version(), read);
        assert_eq!(doc.prefs_value()["version"], json!(read));
    }

    #[test]
    fn a_load_sets_the_preferences_without_touching_the_document() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let version = doc.version().unwrap();
        let history = doc.execute("history.list", json!({})).unwrap();
        let revision = doc.session.revision;
        let journal = doc.session.journal.len();
        let before = doc.prefs_version();
        let mut values = doc.prefs_value()["values"].clone();
        values["guides"]["templates"] = json!([{ "name": "Thirds", "guides": [{ "vertical": false, "position": 480.0 }] }]);
        values["labels"]["colors"]["violet"]["name"] = json!("Purple");
        let answer = doc.load_prefs(&values.to_string(), before).unwrap();
        assert_eq!(answer["loaded"], json!(true));
        let loaded = answer["version"].as_u64().unwrap();
        assert!(loaded > before);
        assert_eq!(answer["values"], doc.prefs_value()["values"], "it answers the preferences as the engine holds them");
        assert_eq!(templates(&doc), json!([{ "name": "Thirds", "guides": [{ "vertical": false, "position": 480.0 }] }]));
        assert_eq!(doc.execute("prefs.get", json!({ "key": "labels.colors.violet.name" })).unwrap(), json!("Purple"));
        assert_eq!(doc.version().unwrap(), version, "the replica is unchanged");
        assert_eq!(doc.execute("history.list", json!({})).unwrap(), history, "no history step");
        assert_eq!(doc.session.revision, revision, "no new revision");
        assert_eq!(doc.session.journal.len(), journal, "nothing journaled");
        // The same values again change nothing; unknown or broken values are repaired as a stored file is.
        assert_eq!(doc.load_prefs(&values.to_string(), loaded).unwrap()["version"], json!(loaded));
        values["timeline"] = json!("not an object");
        doc.load_prefs(&values.to_string(), loaded).unwrap();
        assert!(doc.prefs_value()["values"]["timeline"].is_object(), "a broken section takes its defaults");
    }

    #[test]
    fn a_load_is_refused_when_the_preferences_moved_since_the_editor_read_them() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let read = doc.prefs_value();
        let seen = read["version"].as_u64().unwrap();
        // A command lands between the editor's read and its load.
        doc.execute("project.view.set", json!({ "view": "list" })).unwrap();
        let moved = doc.prefs_version();
        assert!(moved > seen);
        let version = doc.version().unwrap();
        let history = doc.execute("history.list", json!({})).unwrap();
        let mut values = read["values"].clone();
        values["guides"]["templates"] = json!([{ "name": "Thirds", "guides": [] }]);
        let answer = doc.load_prefs(&values.to_string(), seen).unwrap();
        assert_eq!(answer["loaded"], json!(false), "refused: the command's change would be lost");
        assert_eq!(answer["version"], json!(moved));
        assert_eq!(answer["values"], doc.prefs_value()["values"], "it answers the preferences as they are, to merge again");
        assert_eq!(answer["values"]["projectPanel"]["view"]["mode"], json!("list"), "the command's change is kept");
        assert_eq!(answer["values"]["guides"]["templates"], json!([]), "nothing was loaded");
        assert_eq!(doc.prefs_version(), moved);
        assert_eq!(doc.version().unwrap(), version);
        assert_eq!(doc.execute("history.list", json!({})).unwrap(), history);
    }

    #[test]
    fn a_load_refuses_what_is_not_an_object() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let before = doc.prefs_version();
        assert!(doc.load_prefs("[]", before).is_err());
        assert!(doc.load_prefs("{", before).is_err());
        assert_eq!(doc.prefs_version(), before);
    }

    #[test]
    fn a_load_while_a_preview_is_open_leaves_the_preview_its_own_preferences() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        // Metadata Display previews its columns in the scratch copy's preferences.
        doc.preview_begin("project.columns.set", json!({ "columns": ["Name", "Media Duration"] })).unwrap();
        let mut values = doc.prefs_value()["values"].clone();
        values["guides"]["templates"] = json!([{ "name": "Thirds", "guides": [] }]);
        let expected = doc.prefs_version();
        doc.load_prefs(&values.to_string(), expected).unwrap();
        assert_eq!(templates(&doc), json!([{ "name": "Thirds", "guides": [] }]), "the document's engine takes the load");
        let scratch = doc.with_preview(|scratch| Ok(scratch.prefs.to_value())).expect("the preview stays open");
        assert_eq!(scratch["guides"]["templates"], json!([]), "the scratch copy keeps its own");
        let names = |columns: &Value| columns.as_array().unwrap().iter().map(|column| column["name"].clone()).collect::<Vec<_>>();
        assert_eq!(names(&scratch["projectPanel"]["view"]["columns"]), vec![json!("Name"), json!("Media Duration")], "and its previewed columns");
        assert_ne!(
            names(&doc.prefs_value()["values"]["projectPanel"]["view"]["columns"]),
            vec![json!("Name"), json!("Media Duration")],
            "which the document never takes"
        );
    }
}
