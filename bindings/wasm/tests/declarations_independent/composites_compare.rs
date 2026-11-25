//! promo.rs:159-655, commands.rs:1084-1205 and voiceover.rs:257-394.
//! Compound sound commands search free lanes and can analyse other clips.
//! Import dispatches by host bytes; its scope must cover each format route.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("timeline.placeMany", "explicit items list"),
    ("sound.phrase", "preset sound roles"),
    ("transition.beatCut", "explicit cuts at/clip/onBeat false"),
    ("transition.beatCut", "default beat selection"),
    ("audio.bed", "project item"),
    ("audio.bed", "existing clip"),
    ("file.import", "media"),
    ("file.import", "captions/interchange"),
    ("audio.voiceover.start", "punch or playhead start"),
    ("audio.voiceover.sync", "capture restart"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "file.import" {
        vec!["all-import-format-candidates", "whole-import-bin-tree", "whole-import-sequence", "coarse-import-options"]
    } else if command.starts_with("audio.voiceover") {
        vec!["whole-voiceover-timebase", "coarse-voiceover-options", "all-record-track-candidates"]
    } else {
        vec!["whole-composite-sequence", "all-composite-source-routes", "coarse-placement-options"]
    }
}
fn leaf(id: Value, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}
fn source(p: &Project, id: ItemId, want: &mut Under) {
    let mut next = Some(id);
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = next.filter(|id| seen.insert(*id)) {
        want.premises.push(leaf(
            json!(id.0),
            [
                "kind",
                "name",
                "props.common.label",
                "props.media",
                "props.parent",
                "props.range",
                "props.restrict_trims",
                "props.width",
                "props.height",
                "props.rate",
                "sequence",
                "~sourceGraphicDefinition",
            ],
        ));
        next = match p.item(id).map(|item| &item.kind) {
            Some(ItemKind::Subclip { parent, .. }) => Some(*parent),
            _ => None,
        };
    }
}
fn expected(p: &Project, seq: u64, command: &str, params: &Value) -> Under {
    let q = p.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    if command == "file.import" {
        want.premises.push(leaf(json!("project"), ["bins", "settings.ingest", "~importOptions"]));
        want.premises.extend(p.items.values().map(|item| Premise::on(json!(item.id.0))));
        return want;
    }
    if command.starts_with("audio.voiceover") {
        want.premises.push(leaf(
            json!(seq),
            [
                "sequence.settings.mark_in",
                "sequence.settings.mark_out",
                "sequence.settings.settings.sample_rate",
                "sequence.settings.settings.frame_rate",
                "sequence.settings.settings.drop_frame",
                "~audioTrackOrder",
            ],
        ));
        want.premises.push(leaf(json!("project"), ["~voiceoverOptions"]));
        for track in &q.audio_tracks {
            want.premises.push(leaf(json!(track.id.0), ["props.locked", "props.mixer.record_arm", "props.name"]));
        }
        return want;
    }
    want.premises.push(leaf(json!(seq), ["sequence"]));
    want.premises.push(leaf(json!("project"), ["~placementOptions"]));
    let mut ids: Vec<ItemId> = q.all_tracks().flat_map(|track| &track.items).map(|clip| clip.item).collect();
    if let Some(id) = params.get("item").and_then(Value::as_u64) {
        ids.push(ItemId(id));
    }
    if let Some(items) = params.get("items") {
        if let Some(items) = items.as_array() {
            ids.extend(items.iter().filter_map(|v| v.get("item").and_then(Value::as_u64)).map(ItemId));
        }
        if let Some(items) = items.as_object() {
            ids.extend(items.values().filter_map(Value::as_u64).map(ItemId));
        }
    }
    if let Some(sfx) = params.get("sfx") {
        if let Some(id) = sfx.as_u64() {
            ids.push(ItemId(id));
        }
        if let Some(ids2) = sfx.as_array() {
            ids.extend(ids2.iter().filter_map(Value::as_u64).map(ItemId));
        }
    }
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        source(p, id, &mut want);
    }
    want
}
#[test]
fn compound_paths_compare_all_source_forms_options_locked_lanes_marks_and_time_spellings() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("item.newOfflineFile", json!({"seconds":4})).unwrap()["item"].clone();
    let sub = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":media,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"][1].clone();
    for locked in [false, true] {
        doc.execute("timeline.setTrack", json!({"track":"A1","locked":locked})).unwrap();
        for marked in [false, true] {
            if marked {
                doc.execute("marker.markIn", json!({"time":0})).unwrap();
                doc.execute("marker.markOut", json!({"time":254_016_000_000i64})).unwrap();
            }
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.mutates);
                for params in [
                    json!({"items":[{"item":sub,"seconds":1,"alignPeak":true,"durationFrames":12}]}),
                    json!({}),
                    json!({"item":media,"time":0,"duck":true}),
                    json!({"clip":clip,"frame":12,"onBeat":false}),
                    json!({"items":{"riser":media,"impact":sub},"preset":"closing","seconds":2}),
                    json!({"at":[12],"sfx":[media,sub],"params":{"mix":0.5}}),
                    json!({"path":"lent.srt","bin":0}),
                    json!({"paths":["lent.wav","lent.xml"],"imageSequence":true}),
                    json!({"track":"A1","timecode":"00:00:01:00","preroll":0}),
                ] {
                    assert_eq!(
                        normalized(doc.under(command, &params).unwrap().unwrap_or_default()),
                        normalized(expected(&project, seq, command, &params)),
                        "{command}/{path}/{params}/{locked}/{marked}"
                    );
                }
            }
        }
    }
}
