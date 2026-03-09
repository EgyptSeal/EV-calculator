/**
 * Energy model tuning – single place to calibrate consumption predictions.
 * Tune these values to match real-world BYD Song L (or your EV) results.
 * Default baseline: ~3% less pessimistic than previous model.
 */
(function (global) {
  var TUNING = {
    /** 1) Calibration: final_consumption = raw × base_calibration_factor. 0.97 ≈ 3% lower. */
    base_calibration_factor: 0.97,

    /** 2) Aerodynamic / high-speed: multiplier applied above 90 km/h and more above 110. */
    aerodynamic_speed_multiplier_90: 1.08,
    aerodynamic_speed_multiplier_110: 1.22,
    /** Smooth curve exponent for speed (higher = steeper at high speed). */
    speed_curve_exponent: 1.65,

    /** 3) Driver behavior: consumption multiplier by style (efficient < 1, aggressive > 1). */
    efficient_multiplier: 0.92,
    normal_multiplier: 1.0,
    dynamic_multiplier: 1.08,
    aggressive_multiplier: 1.18,
    aggressive_driving_penalty: 1.18,

    /** 4) Road type: city is often more efficient than constant highway at 120. */
    city_efficiency_bonus: 0.95,
    stop_go_penalty: 1.12,
    highway_penalty_above_100: 1.15,

    /** 5) Live adaptation: blend predicted vs actual during trip (0 = ignore actual, 1 = fast adapt). */
    live_adaptation_strength: 0.12,
    live_adaptation_min_samples: 2,

    /** 6) Arrival SOC display: smoothing so % doesn’t jump (0 = no smooth, 1 = very slow). */
    arrival_soc_smoothing_factor: 0.18,

    /** 7) Speed bands (km/h) for efficiency curve: best in 45–75, worse in stop-go, worse at 100+. */
    speed_best_efficiency_kmh: 55,
    speed_highway_threshold_kmh: 90,
    speed_very_high_threshold_kmh: 110,
  };

  global.ENERGY_MODEL_TUNING = TUNING;
  global.getEnergyModelTuning = function () { return Object.assign({}, TUNING); };
  global.setEnergyModelTuning = function (key, value) {
    if (TUNING.hasOwnProperty(key)) TUNING[key] = value;
  };
})(window);
