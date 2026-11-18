//! The parameters commands read that their notation does not spell out, added to the schemas the
//! catalogue offers agents. Every command refuses a key its schema does not name (engine rule E7a),
//! so the schema must name every key the command reads: a shared helper's other spelling (`clip`
//! beside `clips`, through `clips_p`), the four spellings of a time (`time_p`: `…Time` in ticks,
//! `…Frame`, `…Seconds`, `…Timecode`), and the three of a duration (`dur_p`: ticks, `…Frames`,
//! `…Seconds`).

use serde_json::{Value, json};

#[derive(Clone, Copy)]
enum Kind {
    Integer,
    Number,
    String,
    Boolean,
    Array,
    Json,
    IndexOrName,
    /// Link Media's Match File Properties (`relink::MatchOptions`): a closed set of switches.
    MatchOptions,
    /// A transition's own parameters by name: which names exist depends on the transition the
    /// command applies, so the object is open (as `sequence.applyVideoTransition`'s `params`).
    TransitionParams,
}

impl Kind {
    fn node(self, description: &str) -> Value {
        let kind = match self {
            Kind::IndexOrName => return json!({ "oneOf": [{ "type": "integer" }, { "type": "string" }], "description": description }),
            Kind::MatchOptions => {
                let switch = |what: &str| json!({ "type": "boolean", "description": what });
                return json!({
                    "type": "object",
                    "description": description,
                    "additionalProperties": false,
                    "properties": {
                        "fileName": switch("the file name must match"),
                        "extension": switch("the file extension must match"),
                        "clipId": switch("the content fingerprint recorded at import must match"),
                        "duration": switch("the duration must match"),
                        "mediaStart": switch("the media start timecode must match"),
                        "metadata": switch("frame size, frame rate and audio channels must match"),
                        "alignTimecode": switch("keep clips on the same timecode when the new file starts at another"),
                        "relinkOthers": switch("apply the found file's folder to the other missing files"),
                    },
                });
            }
            Kind::TransitionParams => return json!({ "type": "object", "description": description, "additionalProperties": true }),
            Kind::Integer => "integer",
            Kind::Number => "number",
            Kind::String => "string",
            Kind::Boolean => "boolean",
            Kind::Array => "array",
            Kind::Json => "json",
        };
        json!({ "type": kind, "description": description })
    }
}

/// Keys a command's handler reads (directly or through a helper it passes its parameters to) that
/// its notation leaves out, found by reading each handler.
const EXTRA: &[(&str, &[(&str, Kind)])] = &[
    ("captions.delete", &[("caption", Kind::Integer)]),
    ("captions.merge", &[("caption", Kind::Integer)]),
    ("captions.move", &[("caption", Kind::Integer)]),
    ("clip.audioChannels", &[("item", Kind::Integer)]),
    ("clip.fillFrame", &[("clip", Kind::Integer)]),
    ("clip.fitToFrame", &[("clip", Kind::Integer)]),
    ("clip.frameHold", &[("clip", Kind::Integer)]),
    ("clip.frameHoldOptions", &[("clip", Kind::Integer)]),
    ("clip.link", &[("clip", Kind::Integer)]),
    ("clip.replaceFromSource", &[("item", Kind::Integer), ("keepSourceIn", Kind::Boolean)]),
    ("clip.replaceFromSourceMatchFrame", &[("item", Kind::Integer), ("keepSourceIn", Kind::Boolean)]),
    ("clip.revealInProject", &[("clips", Kind::Array)]),
    ("clip.sceneEditDetection", &[("clip", Kind::Integer)]),
    ("clip.setTimeInterpolation", &[("clip", Kind::Integer)]),
    ("clip.timeInterpolation.frameBlending", &[("clip", Kind::Integer)]),
    ("clip.timeInterpolation.frameSampling", &[("clip", Kind::Integer)]),
    ("clip.timeInterpolation.opticalFlow", &[("clip", Kind::Integer)]),
    ("clipMixer.release", &[("param", Kind::String)]),
    ("edit.clear", &[("clip", Kind::Integer)]),
    ("edit.rippleDelete", &[("clip", Kind::Integer)]),
    (
        "effects.addKeyframe",
        &[
            ("frame", Kind::Integer),
            ("inInfluence", Kind::Number),
            ("interpolation", Kind::String),
            ("mediaTime", Kind::Integer),
            ("outInfluence", Kind::Number),
            ("to", Kind::Integer),
            ("value", Kind::Json),
        ],
    ),
    (
        "effects.deleteKeyframe",
        &[
            ("inInfluence", Kind::Number),
            ("interpolation", Kind::String),
            ("mask", Kind::Integer),
            ("outInfluence", Kind::Number),
            ("to", Kind::Integer),
            ("value", Kind::Json),
        ],
    ),
    (
        "effects.moveKeyframe",
        &[("inInfluence", Kind::Number), ("interpolation", Kind::String), ("mask", Kind::Integer), ("outInfluence", Kind::Number), ("value", Kind::Json)],
    ),
    (
        "effects.setInterpolation",
        &[
            ("frame", Kind::Integer),
            ("time", Kind::Integer),
            ("inInfluence", Kind::Number),
            ("mask", Kind::Integer),
            ("outInfluence", Kind::Number),
            ("to", Kind::Integer),
            ("value", Kind::Json),
        ],
    ),
    ("effects.setKeyframe", &[("interpolation", Kind::String), ("mask", Kind::Integer), ("to", Kind::Integer)]),
    ("file.exportEdl", &[("format", Kind::String)]),
    ("file.exportFcp7Xml", &[("format", Kind::String)]),
    ("file.exportFcpxml", &[("format", Kind::String)]),
    ("file.exportOtio", &[("format", Kind::String)]),
    ("file.import", &[("order", Kind::String), ("path", Kind::String), ("recursive", Kind::Boolean)]),
    ("file.newBarsAndTone", &[("height", Kind::Integer), ("name", Kind::String), ("width", Kind::Integer)]),
    ("file.newBlackVideo", &[("height", Kind::Integer), ("name", Kind::String), ("width", Kind::Integer)]),
    ("file.newColorMatte", &[("height", Kind::Integer), ("name", Kind::String), ("width", Kind::Integer)]),
    ("file.newCountingLeader", &[("height", Kind::Integer), ("name", Kind::String), ("seconds", Kind::Number), ("width", Kind::Integer)]),
    ("file.newProjectFromTemplate", &[("force", Kind::Boolean)]),
    ("file.newTransparentVideo", &[("height", Kind::Integer), ("name", Kind::String), ("seconds", Kind::Number), ("width", Kind::Integer)]),
    ("graphics.align", &[("layer", Kind::IndexOrName)]),
    ("graphics.distribute", &[("layer", Kind::IndexOrName)]),
    ("graphics.distributeHorizontally", &[("layer", Kind::IndexOrName)]),
    ("graphics.distributeSpaceHorizontally", &[("layer", Kind::IndexOrName)]),
    ("graphics.distributeSpaceVertically", &[("layer", Kind::IndexOrName)]),
    ("graphics.distributeVertically", &[("layer", Kind::IndexOrName)]),
    ("markers.edit", &[("time", Kind::Integer)]),
    ("media.createProxies", &[("item", Kind::Integer)]),
    ("media.detachProxies", &[("item", Kind::Integer)]),
    ("media.makeOffline", &[("item", Kind::Integer)]),
    ("media.reconnectFullRes", &[("force", Kind::Boolean), ("match", Kind::MatchOptions), ("relinkOthers", Kind::Boolean)]),
    ("media.replaceFootage", &[("alignTimecode", Kind::Boolean), ("force", Kind::Boolean), ("match", Kind::MatchOptions), ("relinkOthers", Kind::Boolean)]),
    ("media.search", &[("alignTimecode", Kind::Boolean), ("match", Kind::MatchOptions), ("relinkOthers", Kind::Boolean)]),
    ("mediaBrowser.import", &[("path", Kind::String)]),
    ("mediaBrowser.openInSource", &[("paths", Kind::Array)]),
    ("presets.apply", &[("name", Kind::String)]),
    ("project.freeform.stack", &[("item", Kind::Integer)]),
    ("project.freeform.unstack", &[("item", Kind::Integer)]),
    ("sequence.applyAudioTransition", &[("edge", Kind::String), ("params", Kind::TransitionParams), ("reverse", Kind::Boolean)]),
    ("transcript.generate", &[("item", Kind::Integer)]),
];

/// The prefixes `time_p` is called with: each names a time in four spellings.
const TIMES: &[&str] = &["start", "end", "new", "reference"];
/// The keys `dur_p` is called with: each is a duration in ticks, `…Frames` or `…Seconds`.
const DURATIONS: &[&str] = &["easeIn", "easeOut", "intro", "outro", "postroll", "preroll"];

/// Adds to `schema` (a command's `ParameterSchemaSpec`) the keys `id` reads that its notation
/// leaves out.
pub fn complete(id: &str, schema: &mut Value) {
    let Some(properties) = schema.as_object_mut() else { return };
    if id == "timeline.move"
        && let Some(track) = properties
            .get_mut("moves")
            .and_then(|moves| moves.get_mut("items"))
            .and_then(|item| item.get_mut("properties"))
            .and_then(|fields| fields.get_mut("track"))
    {
        *track = Kind::IndexOrName.node("destination track id or V1/A1 ordinal");
    }
    if id == "sound.phrase" {
        let fields = ["riser", "impact", "sparkle", "swoosh", "transition", "click", "hit", "hitAlt"]
            .into_iter()
            .map(|name| (name.to_owned(), Kind::Integer.node("project sound item id, as required by the selected preset")))
            .collect::<serde_json::Map<_, _>>();
        properties.insert("items".to_owned(), json!({"type": "object", "properties": fields, "additionalProperties": false}));
    }
    if id == "transition.beatCut" {
        properties.insert("sfx".to_owned(), json!({"oneOf": [{"type": "integer"}, {"type": "array", "items": {"type": "integer"}}], "description": "project sound item id, or ids used in turn"}));
    }
    if id == "sequence.deleteTracks" {
        for key in ["video", "audio"] {
            properties.insert(key.to_owned(), Kind::IndexOrName.node("track id, V1/A1 ordinal, or empty to delete empty tracks"));
        }
    }
    if id.starts_with("mixer.") && properties.contains_key("strip") {
        for key in ["strip", "track"] {
            properties.insert(key.to_owned(), Kind::IndexOrName.node("mixer strip id, A1/S1 ordinal, Mix/master, or case-insensitive strip name"));
        }
        for key in ["output", "target"] {
            if properties.contains_key(key) {
                properties
                    .insert(key.to_owned(), Kind::IndexOrName.node("destination submix id, S1 ordinal or case-insensitive name; output also accepts Mix"));
            }
        }
    }
    for (key, kind) in EXTRA.iter().filter(|(command, _)| *command == id).flat_map(|(_, keys)| keys.iter()) {
        properties.entry(*key).or_insert_with(|| kind.node("read by the command beside its listed parameters"));
    }
    let spellings = |prefix: &str| -> [(String, Kind, &'static str); 4] {
        let name = |unit: &str| if prefix.is_empty() { unit.to_ascii_lowercase() } else { format!("{prefix}{unit}") };
        [
            (name("Time"), Kind::Integer, "in ticks"),
            (name("Frame"), Kind::Integer, "as a frame of the sequence"),
            (name("Seconds"), Kind::Number, "in seconds"),
            (name("Timecode"), Kind::String, "as a timecode"),
        ]
    };
    // A prefixed time is read by `time_p` in every spelling; a bare one only where the notation
    // already offers more than one (a bare `seconds` is often a duration instead).
    for prefix in TIMES.iter().copied().chain(std::iter::once("")) {
        let forms = spellings(prefix);
        let given = forms.iter().filter(|(key, _, _)| properties.contains_key(key)).count();
        if given == 0 || (prefix.is_empty() && given < 2) {
            continue;
        }
        let what = if prefix.is_empty() { "the time".to_owned() } else { format!("the {prefix} time") };
        for (key, kind, unit) in forms {
            properties.entry(key).or_insert_with(|| kind.node(&format!("{what}, {unit} (one spelling of it)")));
        }
    }
    for key in DURATIONS {
        let forms = [
            ((*key).to_owned(), Kind::Integer, "in ticks"),
            (format!("{key}Frames"), Kind::Number, "in frames"),
            (format!("{key}Seconds"), Kind::Number, "in seconds"),
        ];
        if forms.iter().any(|(name, _, _)| properties.contains_key(name)) {
            for (name, kind, unit) in forms {
                properties.entry(name).or_insert_with(|| kind.node(&format!("the {key} duration, {unit} (one spelling of it)")));
            }
        }
    }
}
