//! Decimal-string encoding of the five timing fields the repair pass and concurrent trims reason
//! about exactly (`Clip.start`/`duration`/`sourceIn`, `Transition.start`/`duration`); see the
//! crate docs for why a plain KDM `integer` (or any JSON number) is not safe at every `Tick`.

use kition_film_time::Tick;
use kition_kit::kdm::KdmError;

use crate::kdm_err;

type KdmResult<T> = Result<T, KdmError>;

pub(crate) fn to_string(t: Tick) -> String {
    t.0.to_string()
}

pub(crate) fn from_str(s: &str) -> KdmResult<Tick> {
    s.parse::<i64>().map(Tick).map_err(kdm_err)
}

/// Reads a `string`-kind tick register, treating a missing/non-string value as corrupt input
/// (never a panic): callers see a plain [`KdmError`] they can report.
pub(crate) fn from_value(value: &serde_json::Value) -> KdmResult<Tick> {
    let text = value.as_str().ok_or_else(|| kdm_err("expected a decimal-string tick value"))?;
    from_str(text)
}
