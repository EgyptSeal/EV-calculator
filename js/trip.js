/**
 * Trip energy prediction – physics-based consumption model.
 * Uses: base consumption, speed (non-linear aero), road type, elevation, temperature,
 * load, HVAC, driver behavior, calibration factor, live adaptation.
 */
(function (global) {
  const C = global.EVTripPlannerConfig?.routing || {};
  const miToKm = C.miToKm || 1.60934;
  const lowBatteryPercent = C.lowBatteryWarningPercent ?? 5;
  const costPerKwh = C.costPerKwhEGP ?? 4.5;

  function getTuning() {
    return global.ENERGY_MODEL_TUNING || {};
  }

  /** Normalize vehicle fields – support both old and new schema. */
  function getVehicleFields(v) {
    if (!v) return null;
    return {
      batteryKwh: v.battery_capacity_kwh ?? v.battery_kwh ?? 60,
      epaRangeKm: v.epa_range_km ?? v.estimated_epa_range_km ?? v.official_range_value ?? 400,
      weightKg: v.vehicle_weight_kg ?? v.curb_weight_kg ?? 1800,
    };
  }

  /**
   * Base consumption (kWh/km) = battery_capacity_kwh / epa_range_km
   */
  function baseConsumptionKwhPerKm(vehicle) {
    const f = getVehicleFields(vehicle);
    if (!f || f.epaRangeKm <= 0) return 0.22;
    return f.batteryKwh / f.epaRangeKm;
  }

  /**
   * Speed efficiency curve (smooth, non-linear):
   * Best efficiency in moderate city/mixed (45–75 km/h), worse in stop-go, clearly worse at highway, much worse at very high speed.
   * Uses tuning: speed_best_efficiency_kmh, speed_highway_threshold_kmh, speed_very_high_threshold_kmh, aerodynamic multipliers.
   */
  function speedMultiplier(speedKmh) {
    var T = getTuning();
    var best = T.speed_best_efficiency_kmh != null ? T.speed_best_efficiency_kmh : 55;
    var h90 = T.speed_highway_threshold_kmh != null ? T.speed_highway_threshold_kmh : 90;
    var h110 = T.speed_very_high_threshold_kmh != null ? T.speed_very_high_threshold_kmh : 110;
    var aero90 = T.aerodynamic_speed_multiplier_90 != null ? T.aerodynamic_speed_multiplier_90 : 1.08;
    var aero110 = T.aerodynamic_speed_multiplier_110 != null ? T.aerodynamic_speed_multiplier_110 : 1.22;
    var exp = T.speed_curve_exponent != null ? T.speed_curve_exponent : 1.65;
    var stopGo = T.stop_go_penalty != null ? T.stop_go_penalty : 1.12;
    var cityBonus = T.city_efficiency_bonus != null ? T.city_efficiency_bonus : 0.95;
    var highwayPenalty = T.highway_penalty_above_100 != null ? T.highway_penalty_above_100 : 1.15;

    var s = Math.max(5, Math.min(160, speedKmh));

    if (s <= 25) {
      var t = s / 25;
      return 0.92 + (1 - t) * (stopGo - 0.92);
    }
    if (s <= best) {
      var t = (s - 25) / (best - 25);
      return 0.92 + t * (1.0 - 0.92);
    }
    if (s <= h90) {
      var t = (s - best) / (h90 - best);
      return 1.0 + t * (aero90 - 1.0);
    }
    if (s <= h110) {
      var t = (s - h90) / (h110 - h90);
      var mult = aero90 + t * (aero110 - aero90);
      return mult;
    }
    var excess = (s - h110) / 30;
    var extra = Math.pow(Math.min(excess, 2), exp) * 0.28;
    return Math.min(1.85, aero110 + extra);
  }

  /**
   * Road type weights (spec example): city 40%, secondary 20%, highway 40%
   * Typical speeds: city 40, secondary 60, highway 100
   * Weighted avg speed multiplier when no route data.
   */
  function roadTypeWeightedSpeedMultiplier(routeKm, maxSpeedKmh) {
    const cityShare = routeKm <= 30 ? 0.6 : routeKm <= 100 ? 0.4 : 0.25;
    const highwayShare = routeKm <= 30 ? 0.2 : routeKm <= 100 ? 0.35 : 0.55;
    const secondaryShare = 1 - cityShare - highwayShare;
    const citySpeed = 40;
    const secondarySpeed = 60;
    const highwaySpeed = Math.min(maxSpeedKmh * 0.9, 120);
    const avgSpeed = cityShare * citySpeed + secondaryShare * secondarySpeed + highwayShare * highwaySpeed;
    return speedMultiplier(avgSpeed);
  }

  /**
   * Elevation: +7% consumption per 1000 m climb, recover 40% of downhill.
   * elevationGainM in options; when unavailable, 0.
   */
  function elevationFactor(elevationGainM, elevationLossM) {
    const gain = elevationGainM ?? 0;
    const loss = elevationLossM ?? 0;
    const climbPenalty = 1 + (gain / 1000) * 0.07;
    const downhillRecovery = (loss / 1000) * 0.07 * 0.4;
    return Math.max(0.7, Math.min(1.5, climbPenalty - downhillRecovery));
  }

  /**
   * Temperature effect (spec):
   * 0°C +25%, 10°C +15%, 20°C baseline, 35°C +5%
   */
  function temperatureFactor(tempC) {
    const t = tempC ?? 20;
    if (t >= 20 && t <= 25) return 1.0;
    if (t > 25 && t <= 35) return 1 + (t - 25) * 0.005;
    if (t > 35) return 1.05;
    if (t >= 10) return 1 + (20 - t) * 0.015;
    if (t >= 0) return 1.15 + (10 - t) * 0.01;
    return 1.25 + (0 - t) * 0.02;
  }

  /**
   * Wind: +5% consumption per 10 km/h headwind
   */
  function windFactor(windSpeedKmh, windDirectionDeg, routeBearingDeg) {
    if (!windSpeedKmh || windSpeedKmh <= 0) return 1.0;
    const headwind = headwindComponent(windSpeedKmh, windDirectionDeg, routeBearingDeg);
    if (headwind <= 0) return 1.0;
    return 1 + (headwind / 10) * 0.05;
  }

  function headwindComponent(windSpeedKmh, windDirectionDeg, routeBearingDeg) {
    if (windDirectionDeg == null || routeBearingDeg == null) return windSpeedKmh * 0.5;
    const diff = Math.abs(((windDirectionDeg - routeBearingDeg + 180) % 360) - 180);
    const headwindRatio = Math.cos((diff * Math.PI) / 180);
    return Math.max(0, windSpeedKmh * headwindRatio);
  }

  /**
   * Traffic: heavy +10%, moderate +5%, free_flow 0%
   */
  function trafficFactor(trafficLevel) {
    if (trafficLevel === 'heavy') return 1.10;
    if (trafficLevel === 'moderate') return 1.05;
    return 1.0;
  }

  /**
   * Load: +1.5% consumption per 100 kg extra (passengers + luggage)
   */
  function loadFactor(passengers, luggageKg) {
    const p = passengers ?? 1;
    const l = luggageKg ?? 0;
    const extraKg = (p - 1) * 70 + l;
    return 1 + (extraKg / 100) * 0.015;
  }

  /**
   * HVAC: AC cooling +5%, heater +10%
   */
  function hvacFactor(acOn, ambientTempC, cabinTempC) {
    if (!acOn) return 1.0;
    const ambient = ambientTempC ?? 20;
    const cabin = cabinTempC ?? 22;
    const delta = Math.abs(cabin - ambient);
    if (delta < 2) return 1.0;
    if (ambient < cabin) return 1.10;
    return 1.05;
  }

  /**
   * Driving mode (trip setup) or live driving style score (0–1: efficient→aggressive).
   * Uses tuning: efficient_multiplier, normal_multiplier, dynamic_multiplier, aggressive_multiplier.
   */
  function drivingModeFactor(mode) {
    if (mode === 'eco') return (getTuning().efficient_multiplier != null ? getTuning().efficient_multiplier : 0.92);
    if (mode === 'aggressive') return (getTuning().aggressive_multiplier != null ? getTuning().aggressive_multiplier : 1.15);
    return (getTuning().normal_multiplier != null ? getTuning().normal_multiplier : 1.0);
  }

  /** drivingStyleScore: 0=efficient, 0.33=normal, 0.66=dynamic, 1=aggressive. Interpolates tuning multipliers. */
  function driverBehaviorMultiplier(drivingStyleScore) {
    if (drivingStyleScore == null || typeof drivingStyleScore !== 'number') return 1.0;
    var T = getTuning();
    var eff = T.efficient_multiplier != null ? T.efficient_multiplier : 0.92;
    var norm = T.normal_multiplier != null ? T.normal_multiplier : 1.0;
    var dyn = T.dynamic_multiplier != null ? T.dynamic_multiplier : 1.08;
    var agg = T.aggressive_multiplier != null ? T.aggressive_multiplier : 1.18;
    var s = Math.max(0, Math.min(1, drivingStyleScore));
    if (s <= 0.33) return eff + (s / 0.33) * (norm - eff);
    if (s <= 0.66) return norm + ((s - 0.33) / 0.33) * (dyn - norm);
    return dyn + ((s - 0.66) / 0.34) * (agg - dyn);
  }

  /**
   * Adjusted consumption (kWh/km). Final value = raw × base_calibration_factor × liveConsumptionBias.
   * Planned max speed strongly influences initial prediction; useInstantSpeed + maxSpeedKmh for live.
   */
  function consumptionPerKm(vehicle, options = {}) {
    const base = baseConsumptionKwhPerKm(vehicle);
    const maxSpeedKmh = options.maxSpeedKmh ?? 120;
    const routeKm = options.routeDistanceKm ?? 100;
    const avgSpeedKmh = options.averageSpeedKmh ?? null;

    let speedMult;
    if (options.useInstantSpeed && (options.maxSpeedKmh != null || options.actualSpeedKmh != null)) {
      var liveSpeed = options.actualSpeedKmh != null ? options.actualSpeedKmh : options.maxSpeedKmh;
      speedMult = speedMultiplier(liveSpeed);
    } else if (avgSpeedKmh != null && avgSpeedKmh > 0) {
      var effectiveSpeed = Math.min(avgSpeedKmh, maxSpeedKmh * 0.95);
      speedMult = speedMultiplier(effectiveSpeed);
    } else {
      speedMult = roadTypeWeightedSpeedMultiplier(routeKm, maxSpeedKmh);
    }

    const elevFactor = elevationFactor(options.elevationGainM, options.elevationLossM);
    const tempFactor = temperatureFactor(options.ambientTempC);
    const windFact = windFactor(options.windSpeedKmh, options.windDirectionDeg, options.routeBearingDeg);
    const trafficFact = trafficFactor(options.trafficLevel);
    const loadFact = loadFactor(options.passengers, options.luggageKg);
    const hvacFact = hvacFactor(options.acOn !== false, options.ambientTempC, options.cabinTempC);
    const modeFact = drivingModeFactor(options.drivingMode);
    const driverFact = driverBehaviorMultiplier(options.drivingStyleScore);

    var raw = base * speedMult * elevFactor * tempFactor * windFact * trafficFact * loadFact * hvacFact * modeFact * driverFact;
    var cal = (getTuning().base_calibration_factor != null ? getTuning().base_calibration_factor : 0.97);
    var bias = (options.liveConsumptionBias != null && options.liveConsumptionBias > 0) ? options.liveConsumptionBias : 1.0;
    const adjusted = raw * cal * bias;
    return Math.max(0.05, adjusted);
  }

  /**
   * Effective range (km) at given battery %.
   */
  function effectiveRangeKm(vehicle, batteryPercent, options = {}) {
    if (!vehicle || batteryPercent <= 0) return 0;
    const f = getVehicleFields(vehicle);
    const usableKwh = f.batteryKwh * (batteryPercent / 100);
    const cons = consumptionPerKm(vehicle, options);
    return Math.max(0, usableKwh / cons);
  }

  function tripEnergyKwh(vehicle, distanceKm, options = {}) {
    const opts = Object.assign({}, options, { routeDistanceKm: options.routeDistanceKm ?? distanceKm });
    const cons = consumptionPerKm(vehicle, opts);
    return distanceKm * cons;
  }

  function batteryAtEnd(vehicle, startPercent, distanceKm, options = {}) {
    const totalKwh = getVehicleFields(vehicle)?.batteryKwh ?? 60;
    const used = tripEnergyKwh(vehicle, distanceKm, options);
    const usedPercent = (used / totalKwh) * 100;
    return Math.max(0, startPercent - usedPercent);
  }

  /** Battery at end considering charge stops. waypoints: [{distKm, chargeTo}], sorted by route order. */
  function batteryAtEndWithWaypoints(vehicle, startPercent, routeDistanceKm, waypointsWithDist, options = {}) {
    if (!vehicle || !waypointsWithDist || waypointsWithDist.length === 0) {
      return batteryAtEnd(vehicle, startPercent, routeDistanceKm, options);
    }
    const opts = Object.assign({}, options, { routeDistanceKm: routeDistanceKm });
    let battery = startPercent;
    let prevDist = 0;
    for (let i = 0; i < waypointsWithDist.length; i++) {
      const { distKm, chargeTo } = waypointsWithDist[i];
      const segDist = distKm - prevDist;
      battery = batteryAtEnd(vehicle, battery, segDist, opts);
      battery = Math.max(0, battery);
      battery = chargeTo != null ? chargeTo : battery;
      prevDist = distKm;
    }
    const lastSegDist = routeDistanceKm - prevDist;
    battery = batteryAtEnd(vehicle, battery, lastSegDist, opts);
    return Math.max(0, battery);
  }

  /** Route progress (0-100) where battery hits 0%, considering charge stops. Returns 100 if we make it. */
  function zeroPointProgress(vehicle, startPercent, routeDistanceKm, waypointsWithDist, options = {}) {
    if (!vehicle || routeDistanceKm <= 0) return 100;
    const opts = Object.assign({}, options, { routeDistanceKm: routeDistanceKm });
    let battery = startPercent;
    let prevDist = 0;
    const waypoints = waypointsWithDist || [];
    for (let i = 0; i < waypoints.length; i++) {
      const { distKm, chargeTo } = waypoints[i];
      const segDist = distKm - prevDist;
      const usedPct = (tripEnergyKwh(vehicle, segDist, opts) / getVehicleFields(vehicle).batteryKwh) * 100;
      if (usedPct >= battery) {
        const frac = usedPct > 0 ? battery / usedPct : 1;
        const zeroDist = prevDist + segDist * Math.min(1, frac);
        return Math.min(100, (zeroDist / routeDistanceKm) * 100);
      }
      battery = chargeTo != null ? chargeTo : (battery - usedPct);
      prevDist = distKm;
    }
    const lastSegDist = routeDistanceKm - prevDist;
    const usedPct = (tripEnergyKwh(vehicle, lastSegDist, opts) / getVehicleFields(vehicle).batteryKwh) * 100;
    if (usedPct >= battery) {
      const frac = usedPct > 0 ? battery / usedPct : 1;
      const zeroDist = prevDist + lastSegDist * Math.min(1, frac);
      return Math.min(100, (zeroDist / routeDistanceKm) * 100);
    }
    return 100;
  }

  function chargingStopsNeeded(vehicle, startPercent, targetPercent, distanceKm, options = {}) {
    const range = effectiveRangeKm(vehicle, startPercent, options);
    if (distanceKm <= range) return [];
    let remaining = distanceKm;
    let battery = startPercent;
    const stops = [];
    const segmentRange = effectiveRangeKm(vehicle, 100, options);
    while (remaining > 0 && battery < targetPercent + 20) {
      const canDrive = effectiveRangeKm(vehicle, battery, options);
      if (remaining <= canDrive) break;
      const driveTo = Math.min(canDrive * 0.85, remaining);
      remaining -= driveTo;
      const usedPct = (driveTo / segmentRange) * 100;
      battery = Math.max(0, battery - usedPct);
      if (battery < targetPercent) {
        stops.push({ segmentKm: driveTo, batteryAfter: battery, chargeTo: Math.min(80, battery + 50) });
        battery = Math.min(80, battery + 50);
      }
    }
    return stops;
  }

  function chargingTimeMin(vehicle, fromPercent, toPercent, chargerKw) {
    const f = getVehicleFields(vehicle);
    const kwhNeeded = f.batteryKwh * ((toPercent - fromPercent) / 100);
    const maxChargerKw = C.maxChargerKwEgypt ?? 50;
    const effectiveChargerKw = Math.min(chargerKw || 50, maxChargerKw);
    const kw = Math.min(vehicle.charging_power_kw || 50, effectiveChargerKw);
    const hours = kwhNeeded / kw;
    return Math.ceil(hours * 60);
  }

  function costEstimateEGP(kwhTotal) {
    return (kwhTotal * costPerKwh).toFixed(2);
  }

  function isLowBattery(percent) {
    return percent <= lowBatteryPercent;
  }

  /**
   * Segment-based energy (kWh) for route segments. Options can vary per segment (elevation, urban/highway).
   * Returns array of { distKm, kWh } and total kWh.
   */
  function tripEnergyKwhSegmented(vehicle, segments, options = {}) {
    if (!segments || segments.length === 0) return { segmentKwh: [], totalKwh: 0 };
    var segmentKwh = [];
    var totalKwh = 0;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var distKm = typeof seg === 'number' ? seg : (seg.distKm ?? seg.distanceKm ?? 0);
      var segOpts = Object.assign({}, options, typeof seg === 'object' ? seg : {});
      var kwh = tripEnergyKwh(vehicle, distKm, segOpts);
      segmentKwh.push({ distKm: distKm, kWh: kwh });
      totalKwh += kwh;
    }
    return { segmentKwh: segmentKwh, totalKwh: totalKwh };
  }

  global.EVTripPlannerTrip = {
    effectiveRangeKm,
    consumptionPerKm,
    tripEnergyKwh,
    tripEnergyKwhSegmented,
    batteryAtEnd,
    batteryAtEndWithWaypoints,
    zeroPointProgress,
    chargingStopsNeeded,
    chargingTimeMin,
    costEstimateEGP,
    isLowBattery,
    miToKm,
    baseConsumptionKwhPerKm,
    speedMultiplier,
    getTuning: getTuning,
    driverBehaviorMultiplier,
  };
})(window);
