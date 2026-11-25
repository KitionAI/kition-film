//! The person's view of the project (Kit UI protocol 7n, capability `view-state`): the open
//! sequence tabs in order, the active one, the Timeline's nest toggle and how each sequence is
//! shown (zoom, scroll, track heights). It is never written into the `.kfilm` or the replica: the
//! editor asks [`FilmDocument::view_state`] and the host keeps it after each save, and gives it back
//! with [`FilmDocument::restore_view`] when the document opens. Neither touches the document: no
//! journal, no history step, no revision, no replica change.

use kition_film_engine::project::ProjectView;
use serde_json::{Value, json};

use crate::FilmDocument;

/// The payload's own version (UI-S1): a value of another version is ignored.
pub const VIEW_STATE_VERSION: u64 = 1;

impl FilmDocument {
    /// The person's view as the host keeps it: `{ v: 1, view: { open_sequences, active_sequence,
    /// sequences_as_clips, sequences } }`.
    pub fn view_state(&self) -> Value {
        json!({ "v": VIEW_STATE_VERSION, "view": self.session.project_view() })
    }

    /// Puts back a view [`Self::view_state`] answered, as the Timeline preference "Restore open
    /// sequences when opening projects" allows. Nothing in it is trusted: a value of another
    /// version or one that cannot be read is ignored, and sequences the project lacks are left out
    /// (`Session::restore_project_view`). Answers whether it was put back.
    pub fn restore_view(&mut self, state: &Value) -> bool {
        if state.get("v").and_then(Value::as_u64) != Some(VIEW_STATE_VERSION) || !self.session.prefs.timeline.restore_open_sequences {
            return false;
        }
        let Some(Ok(view)) = state.get("view").map(|view| serde_json::from_value::<ProjectView>(view.clone())) else { return false };
        self.session.restore_project_view(view);
        if let Some(sequence) = self.session.state.active_sequence {
            self.session.events.push(kition_film_engine::Event::OpenSequence(sequence));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::fixture;
    use kition_film_engine::project::{ItemId, SequenceView};
    use kition_kit::KitDocument;

    /// The fixture with a second sequence, saved: what two sessions open.
    fn two_sequences() -> (Vec<u8>, [u64; 2]) {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let first = doc.session.state.active_sequence.unwrap().0;
        let second = doc.execute("sequence.new", json!({ "name": "B" })).unwrap()["sequence"].as_u64().unwrap();
        (doc.save(None).unwrap(), [first, second])
    }

    // Two sessions that save the same file write the same bytes: `tests/view_state.rs`.

    /// The view state goes back into a session that opens the file: the tabs, the active one, and
    /// each sequence's zoom; it is no edit, and a sequence the project lacks is left out.
    #[test]
    fn the_view_state_is_put_back_when_the_file_opens_again() {
        let (file, [first, second]) = two_sequences();
        let mut a = FilmDocument::open("Edit.kfilm", &file).unwrap();
        a.execute("sequence.open", json!({ "item": second })).unwrap();
        let shown = SequenceView { pps: 300.0, scroll: 2.0, v_scroll: 0.0, a_scroll: 0.0, video_track_h: 80.0, audio_track_h: 40.0 };
        a.session.state.timeline_views.insert(ItemId(second), shown);
        let mut state = a.view_state();
        state["view"]["open_sequences"].as_array_mut().unwrap().push(json!(424_242));

        let mut b = FilmDocument::open("Edit.kfilm", &file).unwrap();
        assert_eq!(b.session.state.active_sequence, Some(ItemId(first)), "a file opens on its first sequence");
        let (revision, steps) = (b.session.revision, b.session.history.undo.len());
        assert!(b.restore_view(&state));
        assert_eq!(b.session.state.open_sequences, [ItemId(first), ItemId(second)]);
        assert_eq!(b.session.state.active_sequence, Some(ItemId(second)));
        assert_eq!(b.session.state.timeline_views.get(&ItemId(second)), Some(&shown));
        assert_eq!((b.session.revision, b.session.history.undo.len()), (revision, steps), "no edit");
        assert!(!b.session.is_dirty());
        assert!(b.session.events.contains(&kition_film_engine::Event::OpenSequence(ItemId(second))), "the Timeline shows it");
    }

    /// A value the kit cannot read, or of another version, is ignored; with "Restore open
    /// sequences" off nothing is put back.
    #[test]
    fn a_view_state_it_cannot_read_is_ignored() {
        let (file, [first, second]) = two_sequences();
        let mut a = FilmDocument::open("Edit.kfilm", &file).unwrap();
        a.execute("sequence.open", json!({ "item": second })).unwrap();
        let good = a.view_state();
        let mut b = FilmDocument::open("Edit.kfilm", &file).unwrap();
        let mut other = good.clone();
        other["v"] = json!(2);
        for junk in [json!(null), json!("tabs"), json!({ "v": 1 }), json!({ "v": 1, "view": { "open_sequences": "all" } }), other] {
            assert!(!b.restore_view(&junk), "{junk}");
            assert_eq!(b.session.state.active_sequence, Some(ItemId(first)), "{junk}");
        }
        b.execute("prefs.set", json!({ "key": "timeline.restoreOpenSequences", "value": false })).unwrap();
        assert!(!b.restore_view(&good));
        assert_eq!(b.session.state.active_sequence, Some(ItemId(first)));
    }
}
