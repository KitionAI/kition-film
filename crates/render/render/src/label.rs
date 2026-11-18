//! A short label burned into a frame (a contact sheet's frame times): light text on a dark box in
//! the frame's bottom-left corner, sized to the frame, in the bundled default face, so it draws
//! the same everywhere.

use kition_film_text::{Align, ParagraphStyle, TextStyle, layout, render};

use crate::graphics::{paint_mask, premul_linear};
use crate::image::Image;

/// The box behind the text: black at this opacity.
const BOX_ALPHA: f32 = 0.72;

/// Burns `text` into `img`'s bottom-left corner. A frame too small for legible text (under 24
/// pixels high) is left as it is.
pub fn burn_label(img: &mut Image, text: &str) {
    if img.h < 24 || img.w < 24 || text.is_empty() {
        return;
    }
    let (w, h) = (img.w as f32, img.h as f32);
    let margin = (h * 0.04).max(2.0);
    let inner = (h * 0.03).max(2.0);
    let mut style =
        TextStyle { family: kition_film_text::fonts::DEFAULT_FAMILY.into(), style: "Bold".into(), size: (h * 0.12).clamp(9.0, 48.0), ..Default::default() };
    let para = ParagraphStyle { align: Align::Left, ..Default::default() };
    let mut lines = layout(text, &style, &para);
    let room = w - 2.0 * (margin + inner);
    let wide = lines.bounds[2] - lines.bounds[0];
    if wide > room && wide > 0.0 {
        style.size *= room / wide;
        lines = layout(text, &style, &para);
    }
    let (mask, _, _) = render::rasterize(&lines, &render::at(0.0, 0.0));
    let (tw, th) = (mask.w as f32, mask.h as f32);
    let (x1, y1) = ((margin + 2.0 * inner + tw).min(w), h - margin);
    let (x0, y0) = (margin, (y1 - th - 2.0 * inner).max(0.0));
    let backing = kition_film_text::Path::rect(x0, y0, x1, y1);
    if let Some(bounds) = backing.bounds() {
        let (bx, by) = (bounds.0.floor() as i32, bounds.1.floor() as i32);
        let fill = kition_film_text::raster::fill(
            &backing,
            (bounds.2.ceil() as i32 - bx).max(1) as usize,
            (bounds.3.ceil() as i32 - by).max(1) as usize,
            -bx as f32,
            -by as f32,
        );
        paint_mask(img, &fill, bx, by, [0.0, 0.0, 0.0, 1.0], BOX_ALPHA);
    }
    paint_mask(img, &mask, (x0 + inner).round() as i32, (y0 + inner).round() as i32, premul_linear([1.0, 1.0, 1.0, 1.0]), 1.0);
}
