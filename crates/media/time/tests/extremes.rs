use kition_film_time::{FrameRate, TICKS_PER_SECOND, Tick, TimeDisplay, format_time, frames_to_fields};

#[test]
fn huge_positive_frame_count_must_not_become_a_negative_trim() {
    assert!(FrameRate::FPS_24.tick_of(i64::MAX).0 > 0);
    assert!(FrameRate::FPS_24.tick_of(i64::MIN).0 < 0);
}

#[test]
fn extreme_ticks_never_panic_or_reverse_the_direction_of_arithmetic() {
    for n in [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX] {
        let result = std::panic::catch_unwind(|| {
            let value = Tick(n);
            let _ = value.abs();
            let _ = -value;
            let _ = value + Tick(i64::MAX);
            let _ = value - Tick(i64::MIN);
            let mut assignment = value;
            assignment += Tick(i64::MAX);
            assignment -= Tick(i64::MIN);
        });
        assert!(result.is_ok(), "tick arithmetic panicked for {n}");
    }
    assert_eq!(Tick(i64::MAX) + Tick(1), Tick(i64::MAX));
    assert_eq!(Tick(i64::MIN) - Tick(1), Tick(i64::MIN));
    assert_eq!(-Tick(i64::MIN), Tick(i64::MAX));
}

#[test]
fn corrupt_extreme_rates_and_container_timebases_are_total() {
    for n in [i64::MIN, -1, 0, 1, 24, i64::MAX] {
        for d in [i64::MIN, -1, 0, 1, 1001, i64::MAX] {
            let result = std::panic::catch_unwind(|| {
                let rate = FrameRate::new(n, d);
                for t in [i64::MIN, -1, 0, 1, i64::MAX] {
                    let _ = rate.tick_of(t);
                    let _ = rate.frame_at(Tick(t));
                    let _ = rate.frame_duration();
                    let _ = rate.snap_nearest(Tick(t));
                    let _ = Tick::from_rational(t, n, d);
                    let _ = Tick(t).to_rational_floor(n, d);
                    let _ = Tick(t).to_rational_round(n, d);
                    let _ = Tick(t).mul_ratio(n, d);
                    let _ = Tick::from_units(t, n);
                    let _ = Tick(t).to_units_floor(n);
                    for mode in TimeDisplay::ALL {
                        let _ = format_time(Tick(t), rate, true, mode, n);
                    }
                    let _ = frames_to_fields(t, rate, true);
                }
            });
            assert!(result.is_ok(), "time conversion panicked for {n}/{d}");
        }
    }
}

#[test]
fn representable_timestamp_ratios_keep_exact_results_despite_large_operands() {
    assert_eq!(Tick::from_rational(i64::MAX, 1, i64::MAX), Tick(TICKS_PER_SECOND));
    assert_eq!(Tick::from_rational(i64::MIN, 1, i64::MIN), Tick(TICKS_PER_SECOND));
    assert_eq!(Tick(i64::MAX).mul_ratio(i64::MAX, i64::MAX), Tick(i64::MAX));
    assert_eq!(Tick::from_rational(i64::MAX, i64::MAX, i64::MAX), Tick(i64::MAX));
    assert_eq!(Tick::from_units(i64::MAX, 1), Tick(i64::MAX));
    assert_eq!(Tick(i64::MAX).to_units_floor(i64::MAX), i64::MAX);
}
