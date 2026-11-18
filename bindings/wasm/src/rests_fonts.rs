//! Replace Fonts selects recipients throughout the project by family/style.
//! graphic_templates.rs::for_each_layer and replace_fonts read these facts;
//! graphic text, geometry, clip timing and project metadata are independent.
use kition_film_engine::{
    Session,
    project::{EffectInstance, ItemKind, ParamValue, graphic::TEXT_LAYER},
};
use kition_kit::{DerivedValues, Premise, Under};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn key(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::from("f");
    for byte in s.to_ascii_lowercase().bytes() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn under(command: &str, params: &Value) -> Option<Under> {
    if command != "file.replaceFonts" {
        return None;
    }
    let from = params.get("from")?;
    let family = from.as_str().or_else(|| from.get("family").and_then(Value::as_str))?;
    let style = from.get("style").and_then(Value::as_str);
    let to_style = if params.get("to").is_some_and(Value::is_object) { params["to"].get("style") } else { params.get("toStyle") }.and_then(Value::as_str);
    let family = key(family);
    let mut fields = vec![match style {
        Some(style) => format!("~fontUses.byStyle.{family}.{}", key(style)),
        None => format!("~fontUses.byFamily.{family}"),
    }];
    if to_style.is_some() {
        fields.push(match style {
            Some(style) => format!("~fontUses.assignedStylesByStyle.{family}.{}", key(style)),
            None => format!("~fontUses.assignedStyles.{family}"),
        });
    }
    Some(Under { premises: vec![Premise::on(json!("project")).fields(fields).positions(Vec::<String>::new())], ..Default::default() })
}

#[derive(Default)]
struct Uses {
    family: BTreeMap<String, Vec<Value>>,
    style: BTreeMap<String, BTreeMap<String, Vec<Value>>>,
    assigned: BTreeMap<String, Vec<Value>>,
    assigned_style: BTreeMap<String, BTreeMap<String, Vec<Value>>>,
}

impl Uses {
    fn add(&mut self, family: &str, style: &str, identity: Value, font: Value, assigned_style: Value) {
        let (f, s) = (key(family), key(style));
        self.family.entry(f.clone()).or_default().push(json!([identity, font]));
        self.style.entry(f.clone()).or_default().entry(s.clone()).or_default().push(json!([identity, font, s]));
        self.assigned.entry(f.clone()).or_default().push(json!([identity, assigned_style]));
        self.assigned_style.entry(f).or_default().entry(s).or_default().push(json!([identity, assigned_style]));
    }

    fn layer(&mut self, location: Value, effect: &EffectInstance) {
        if effect.effect != TEXT_LAYER {
            return;
        }
        let text = |name: &str| {
            effect
                .param(name)
                .and_then(|p| match &p.value {
                    ParamValue::Text(s) => Some(s.as_str()),
                    _ => None,
                })
                .unwrap_or("")
        };
        let (font, style) = (text("font"), text("font_style"));
        self.add(font, style, json!([location, "base"]), json!(effect.param("font")), json!(effect.param("font_style")));
        if let Some(extra) = &effect.layer {
            for (index, run) in extra.runs.iter().enumerate() {
                // replace_fonts only assigns runs with an explicit font.
                if let Some(font) = &run.style.font {
                    self.add(
                        font,
                        run.style.font_style.as_deref().unwrap_or(style),
                        json!([location, "run", index]),
                        json!(run.style.font),
                        json!(run.style.font_style),
                    );
                }
            }
        }
    }

    fn value(mut self) -> Value {
        for values in self.family.values_mut().chain(self.assigned.values_mut()) {
            values.sort_by_cached_key(Value::to_string);
        }
        for styles in self.style.values_mut().chain(self.assigned_style.values_mut()) {
            for values in styles.values_mut() {
                values.sort_by_cached_key(Value::to_string);
            }
        }
        json!({"byFamily":self.family,"byStyle":self.style,"assignedStyles":self.assigned,"assignedStylesByStyle":self.assigned_style})
    }
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Option<DerivedValues> {
    if (!ids.is_empty() && !ids.iter().any(|id| id.as_str() == Some("project"))) || (!names.is_empty() && !names.iter().any(|name| name == "fontUses")) {
        return None;
    }
    let mut uses = Uses::default();
    for item in session.project.items.values() {
        let ItemKind::Sequence(q) = &item.kind else { continue };
        for clip in q.video_tracks.iter().flat_map(|track| &track.items) {
            for (index, effect) in clip.effects.iter().enumerate() {
                uses.layer(json!(["clip", clip.id.0, index]), effect);
            }
        }
        for track in &q.caption_tracks {
            uses.family.entry(key(&track.style.font)).or_default().push(json!([["caption", item.id.0, track.id.0], track.style.font]));
        }
    }
    for (id, graphic) in &session.project.source_graphics {
        for (index, effect) in graphic.layers.iter().enumerate() {
            uses.layer(json!(["source", id.0, index]), effect);
        }
    }
    Some(DerivedValues { id: json!("project"), values: serde_json::Map::from_iter([("fontUses".to_owned(), uses.value())]) })
}
