/**
 * EV Trip Planner - Main application wiring.
 */
(function (global) {
  const C = global.EVTripPlannerConfig;
  const Data = global.EVTripPlannerData;
  const Weather = global.EVTripPlannerWeather;
  const Search = global.EVTripPlannerSearch;
  const MapModule = global.EVTripPlannerMap;
  const Routing = global.EVTripPlannerRouting;
  const Trip = global.EVTripPlannerTrip;
  const Chargers = global.EVTripPlannerChargers;
  const EnergyBar = global.EVTripPlannerEnergyBar;
  const UI = global.EVTripPlannerUI;

  let state = {
    vehicle: null,
    startBattery: 100,
    targetBattery: 20,
    ambientTempC: 25,
    cabinTempC: 24,
    passengers: 1,
    acOn: true,
    luggageKg: 0,
    maxSpeedKmh: 120,
    drivingMode: 'standard',
    windSpeed: 0,
    windDirection: 0,
    startCoords: null,
    endCoords: null,
    waypoints: [],
    route: null,
    chargersNearRoute: [],
    weather: null,
    currentLang: 'en',
    userLocation: null,
    navigationActive: false,
    watchId: null,
    speedWatchId: null,
    driverBehavior: { recentSpeeds: [], timestamps: [] },
    driverBehaviorScore: 0.5,
    liveConsumptionBias: 1.0,
    smoothedArrivalBatteryPct: null,
  };

  function formatDuration(minutes) {
    var h = Math.floor(minutes / 60);
    var m = Math.round(minutes % 60);
    if (h && m) return h + (h === 1 ? ' hour ' : ' hours ') + 'and ' + m + (m === 1 ? ' minute' : ' minutes');
    if (h) return h + (h === 1 ? ' hour' : ' hours');
    return (m || 0) + (m === 1 ? ' minute' : ' minutes');
  }

  function formatChargeTime(minutes) {
    var h = Math.floor(minutes / 60);
    var m = Math.round(minutes % 60);
    if (h && m) return h + 'H, ' + m + 'M';
    if (h) return h + 'H';
    return (m || 0) + 'M';
  }

  function buildTripOptions() {
    var opts = {
      drivingMode: state.drivingMode || 'standard',
      acOn: state.acOn !== false,
      cabinTempC: state.cabinTempC != null ? state.cabinTempC : 24,
      passengers: state.passengers != null ? state.passengers : 1,
      luggageKg: state.luggageKg != null ? state.luggageKg : 0,
      maxSpeedKmh: state.maxSpeedKmh != null ? state.maxSpeedKmh : 120,
      ambientTempC: state.ambientTempC != null ? state.ambientTempC : 25,
      drivingStyleScore: state.driverBehaviorScore != null ? state.driverBehaviorScore : 0.5,
      liveConsumptionBias: state.liveConsumptionBias != null && state.liveConsumptionBias > 0 ? state.liveConsumptionBias : 1.0,
    };
    if (state.weather) {
      opts.windSpeedKmh = state.weather.wind_speed_10m;
      opts.windDirectionDeg = state.weather.wind_direction_10m;
      if (state.weather.temperature_2m != null) opts.ambientTempC = state.weather.temperature_2m;
    }
    if (state.route && state.route.distanceKm > 0 && state.route.durationMin > 0) {
      opts.routeDistanceKm = state.route.distanceKm;
      opts.averageSpeedKmh = state.route.distanceKm / (state.route.durationMin / 60);
    }
    return opts;
  }

  function updateDriverBehaviorFromSpeed(speedKmh) {
    if (speedKmh == null || typeof speedKmh !== 'number' || speedKmh < 0) return;
    var now = Date.now();
    var maxAgeMs = 5 * 60 * 1000;
    if (!state.driverBehavior) state.driverBehavior = { recentSpeeds: [], timestamps: [] };
    state.driverBehavior.recentSpeeds.push(speedKmh);
    state.driverBehavior.timestamps.push(now);
    while (state.driverBehavior.timestamps.length > 0 && now - state.driverBehavior.timestamps[0] > maxAgeMs) {
      state.driverBehavior.recentSpeeds.shift();
      state.driverBehavior.timestamps.shift();
    }
    var arr = state.driverBehavior.recentSpeeds;
    if (arr.length < 3) { state.driverBehaviorScore = 0.5; return; }
    var sum = 0, count = 0, over100 = 0;
    for (var i = 0; i < arr.length; i++) { sum += arr[i]; count++; if (arr[i] > 100) over100++; }
    var avg = sum / count;
    var pctHigh = count > 0 ? over100 / count : 0;
    var planned = state.maxSpeedKmh != null ? state.maxSpeedKmh : 120;
    var score = 0.5;
    if (avg > planned * 0.95 && pctHigh > 0.3) score = 0.5 + 0.35 * pctHigh + 0.15 * Math.min(1, (avg - 90) / 50);
    else if (avg < 60 && pctHigh < 0.1) score = 0.35;
    else if (avg > 100) score = 0.5 + 0.2 * Math.min(1, (avg - 100) / 30) + 0.2 * pctHigh;
    state.driverBehaviorScore = Math.max(0, Math.min(1, score));
  }

  function smoothArrivalBattery(rawPredictedEnd, options) {
    var alpha = (options && options.arrival_soc_smoothing_factor != null) ? options.arrival_soc_smoothing_factor : (window.ENERGY_MODEL_TUNING && window.ENERGY_MODEL_TUNING.arrival_soc_smoothing_factor) || 0.18;
    if (state.smoothedArrivalBatteryPct == null) state.smoothedArrivalBatteryPct = rawPredictedEnd;
    else state.smoothedArrivalBatteryPct = alpha * rawPredictedEnd + (1 - alpha) * state.smoothedArrivalBatteryPct;
    return Math.round(state.smoothedArrivalBatteryPct);
  }

  /** Call when you have actual vs predicted consumption over the same distance to adapt future estimates. */
  function updateLiveConsumptionBias(actualKwhUsed, predictedKwhUsed) {
    if (predictedKwhUsed <= 0 || actualKwhUsed < 0) return;
    var t = window.ENERGY_MODEL_TUNING || {};
    var minSamples = t.live_adaptation_min_samples != null ? t.live_adaptation_min_samples : 2;
    if (!state._navConsumptionSamples) state._navConsumptionSamples = [];
    state._navConsumptionSamples.push({ actual: actualKwhUsed, predicted: predictedKwhUsed });
    if (state._navConsumptionSamples.length < minSamples) return;
    var actual = 0, predicted = 0;
    state._navConsumptionSamples.forEach(function (s) { actual += s.actual; predicted += s.predicted; });
    if (predicted <= 0) return;
    var ratio = actual / predicted;
    var strength = t.live_adaptation_strength != null ? t.live_adaptation_strength : 0.12;
    state.liveConsumptionBias = (1 - strength) * (state.liveConsumptionBias || 1) + strength * ratio;
  }

  function updateTipsContent() {
    var parts = [];
    if (state.drivingMode !== 'eco') parts.push('<strong>Eco mode</strong> – ~15% more range');
    if ((state.maxSpeedKmh || 120) > 100) parts.push('<strong>Reduce speed</strong> 90–100 km/h adds 20–30% range');
    var ambient = state.ambientTempC != null ? state.ambientTempC : 25;
    var cabin = state.cabinTempC != null ? state.cabinTempC : 24;
    if (state.acOn && Math.abs(cabin - ambient) > 3) parts.push('<strong>Minimize AC gap</strong> – Set cabin temp close to ambient');
    if ((state.passengers || 1) > 1 || (state.luggageKg || 0) > 20) parts.push('<strong>Lighten load</strong> – ~4 km per 40 kg extra');
    parts.push('<strong>Regen braking</strong> – Anticipate stops to recover energy');
    parts.push('<strong>Tire pressure</strong> – Keep at recommended level');
    parts.push('<strong>Charge 20–80%</strong> – Often fastest charging range');
    var text = parts.length ? parts.join(' · ') + ' \u2003 \u25C6 \u2003 ' : 'Adjust Trip setup for more tips. ';
    var el1 = document.getElementById('infoTipsInline1');
    var el2 = document.getElementById('infoTipsInline2');
    if (el1) { el1.innerHTML = text; }
    if (el2) { el2.innerHTML = text; }
  }

  function applyTripToUI() {
    updateTipsContent();
    updateInfoRouteStatus();
    const v = state.vehicle;
    var tripOpts = buildTripOptions();
    const rangeKm = v ? Trip.effectiveRangeKm(v, state.startBattery, tripOpts) : 0;
    UI.updateHeaderStats(state.startBattery, rangeKm, 'FAST');
    UI.updateBatterySidebar(state.startBattery, rangeKm);
    const previewImg = document.getElementById('vehiclePreviewImg');
    if (previewImg && v && v.vehicle_image) previewImg.src = v.vehicle_image;
    if (state.route) {
      var distKm = state.route.distanceKm;
      var stateWithRoute = Object.assign({}, tripOpts, { maxSpeedKmh: state.maxSpeedKmh != null ? state.maxSpeedKmh : 120 });
      var timeStr = formatDuration(state.route.durationMin);
      var chargeStops = state.chargersNearRoute.length;
      UI.updateRouteOverview(distKm, timeStr, chargeStops);
      var waypointsWithDist = [];
      if (state.waypoints && state.waypoints.length && state.route.coordinates && state.route.distanceKm) {
        waypointsWithDist = state.waypoints.map(function (wp) {
          var distKm = Chargers.distanceAlongRouteToPointKm(state.route.coordinates, wp.lng, wp.lat);
          return { distKm: distKm, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name, lng: wp.lng, lat: wp.lat };
        }).sort(function (a, b) { return a.distKm - b.distKm; });
      }
      var chargeTimeMin = 0;
      if (v && waypointsWithDist.length) {
        var prevB = state.startBattery;
        var prevD = 0;
        waypointsWithDist.forEach(function (w) {
          var arrPct = Math.round(Trip.batteryAtEnd(v, prevB, w.distKm - prevD, stateWithRoute));
          arrPct = Math.max(0, Math.min(100, arrPct));
          var toPct = w.chargeTo != null ? w.chargeTo : 100;
          chargeTimeMin += Trip.chargingTimeMin(v, arrPct, toPct, 50);
          prevB = toPct;
          prevD = w.distKm;
        });
      }
      UI.updateTripSummary(distKm, timeStr, formatChargeTime(chargeTimeMin), v ? Trip.costEstimateEGP(Trip.tripEnergyKwh(v, state.route.distanceKm, stateWithRoute)) : '—');
      const endBattery = v ? (waypointsWithDist.length ? Trip.batteryAtEndWithWaypoints(v, state.startBattery, state.route.distanceKm, waypointsWithDist, stateWithRoute) : Trip.batteryAtEnd(v, state.startBattery, state.route.distanceKm, stateWithRoute)) : 20;
      const effectiveRangeKm = v ? Trip.effectiveRangeKm(v, state.startBattery, tripOpts) : 0;
      const zeroPointPct = v ? Trip.zeroPointProgress(v, state.startBattery, state.route.distanceKm, waypointsWithDist, stateWithRoute) : 100;
      const arrivalMin = state.route.durationMin + chargeTimeMin;
      const now = new Date();
      const arrival = new Date(now.getTime() + arrivalMin * 60 * 1000);
      const arrivalStr = arrival.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      var nextStopKm = waypointsWithDist.length ? waypointsWithDist[0].distKm : null;
      var nextStopEta = '—';
      if (nextStopKm != null && state.route && state.route.durationMin) {
        var avgSpeedKmh = state.route.distanceKm > 0 ? (state.route.distanceKm / (state.route.durationMin / 60)) : 80;
        var etaMin = (nextStopKm / avgSpeedKmh) * 60;
        var etaDate = new Date(Date.now() + etaMin * 60 * 1000);
        nextStopEta = etaDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      }
      UI.updateBottomBar({
        expectedRangeKm: effectiveRangeKm,
        nextStopKm: nextStopKm,
        nextStopEta: nextStopEta,
        chargingTimeStr: formatChargeTime(chargeTimeMin),
        arrivalStr: arrivalStr,
        weatherTempC: state.weather ? state.weather.temperature_2m : null,
        weatherLabel: state.weather ? Weather.weatherCodeToLabel(state.weather.weather_code) : null,
        weatherHumidity: state.weather && state.weather.relative_humidity_2m != null ? Math.round(state.weather.relative_humidity_2m) : null,
        weatherWind: state.weather && state.weather.wind_speed_10m != null ? Math.round(state.weather.wind_speed_10m) : null,
        endEstPercent: Math.round(endBattery),
      });
      const bar = document.getElementById('energyProgressWrap');
      if (bar) {
        var prevBattery = state.startBattery;
        var prevDist = 0;
        var chargeStops = waypointsWithDist.map(function (w) {
          var progress = state.route.distanceKm > 0 ? Math.max(0, Math.min(1, w.distKm / state.route.distanceKm)) : 0;
          var arrivalPct = v ? Math.round(Trip.batteryAtEnd(v, prevBattery, w.distKm - prevDist, stateWithRoute)) : 20;
          arrivalPct = Math.max(0, Math.min(100, arrivalPct));
          var chargeTo = w.chargeTo != null ? w.chargeTo : 100;
          var addPct = Math.max(0, chargeTo - arrivalPct);
          var waitMin = v ? Trip.chargingTimeMin(v, arrivalPct, chargeTo, 50) : Math.round(addPct * 0.5);
          prevBattery = chargeTo;
          prevDist = w.distKm;
          return { progress: progress, name: w.name || 'Charging Station', waitingTimeMin: waitMin, lng: w.lng, lat: w.lat };
        });
        EnergyBar.updateBar(bar, {
          currentBatteryPercent: state.startBattery,
          predictedEndPercent: Math.round(endBattery),
          tripProgress: 0,
          chargeStops: chargeStops,
          showWarning: Trip.isLowBattery(endBattery),
          zeroPointProgress: zeroPointPct,
          effectiveRangeKm: effectiveRangeKm,
          routeDistanceKm: state.route.distanceKm,
          onChargeStopClick: onChargeStopRemoveClick,
        });
      }
    } else {
      UI.updateBottomBar({
        expectedRangeKm: rangeKm,
        nextStopKm: null,
        nextStopEta: '—',
        chargingTimeStr: '0M',
        arrivalStr: '—',
        weatherTempC: state.weather ? state.weather.temperature_2m : null,
        weatherLabel: state.weather ? Weather.weatherCodeToLabel(state.weather.weather_code) : null,
        weatherHumidity: state.weather && state.weather.relative_humidity_2m != null ? Math.round(state.weather.relative_humidity_2m) : null,
        weatherWind: state.weather && state.weather.wind_speed_10m != null ? Math.round(state.weather.wind_speed_10m) : null,
        endEstPercent: null,
      });
    }
  }

  function fetchWeatherForPosition(lat, lng) {
    return Weather.fetchWeather(lat, lng).then((w) => {
      state.weather = w;
      return w;
    }).catch(() => null);
  }

  function updateSpeedSign(speedMps, plannedSpeedKmh) {
    var valEl = document.getElementById('speedSignValue');
    var slowEl = document.getElementById('speedSignSlowdown');
    if (!valEl || !slowEl) return;
    var speedKmh = (speedMps != null && !isNaN(speedMps)) ? Math.round(speedMps * 3.6) : null;
    valEl.textContent = speedKmh != null ? speedKmh : '—';
    var overLimit = plannedSpeedKmh != null && speedKmh != null && speedKmh > plannedSpeedKmh;
    slowEl.classList.toggle('visible', overLimit);
  }

  /** Show distance until this close (m); below this show instruction only for immediate action (Google-style: still show "in 25 m" until then). */
  var HINT_IMMEDIATE_DISTANCE_M = 25;
  /** Show upcoming turn this far ahead (m), Google-style early guidance. */
  var HINT_SHOW_UPCOMING_TURN_AHEAD_M = 2000;

  /** Attached 44-icon sheet: 4 rows x 11 cols (row 0 = straight, 1 = right turns, 2 = left turns, 3 = U-turn/roundabout/splits). */
  var ATTACHED_NAV_ROWS = 4;
  var ATTACHED_NAV_COLS = 11;
  var ATTACHED_NAV_CELL = 48;
  var ATTACHED_NAV_ICONS = {
    'keep-straight': [0, 0],
    'turn-right': [1, 0],
    'turn-left': [2, 0],
    'take-right-exit': [1, 1],
    'take-left-exit': [2, 1],
    'sharp-right': [1, 2],
    'sharp-left': [2, 2],
    uturn: [3, 0],
    'roundabout-1st': [3, 1],
    'roundabout-2nd': [3, 2],
    'roundabout-3rd': [3, 3],
    'roundabout-4th': [3, 4],
    arrive: [0, 10],
  };

  /**
   * Fallback sprite grid (nav-icons-sprite.png). 64px cells.
   */
  var NAV_SPRITE_CELL = 64;
  var NAV_SPRITE_ICONS = {
    'keep-straight': [4, 14],
    'take-left-exit': [5, 14],
    'take-right-exit': [3, 14],
    'turn-left': [6, 14],
    'turn-right': [2, 14],
    'sharp-left': [7, 14],
    'sharp-right': [1, 14],
    uturn: [0, 16],
    'roundabout-1st': [2, 11],
    'roundabout-2nd': [4, 11],
    'roundabout-3rd': [6, 11],
    'roundabout-4th': [7, 11],
    arrive: [8, 0],
  };

  /** Professional nav icons: simple arrows like Google Maps (no decorative or funny shapes). */
  var NAV_HINT_ICONS_SVG = {
    'keep-straight': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 2l-5 7h3v8h4V9h3L12 2z"/></svg>',
    'turn-left': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18 8v3H9v3l-3-3 3-3h9V8h3l-3-4-3 4z"/></svg>',
    'turn-right': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M6 8V5h9v3l3-3 3 4-3 4v-3H9V8H6z"/></svg>',
    'take-left-exit': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M16 8v2h-4v4l-2-2 2-2v-2h4V8l3 3-3 3V8z"/></svg>',
    'take-right-exit': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M8 8v2h4v4l2-2-2-2v-2H8V8l-3 3 3 3V8z"/></svg>',
    'sharp-left': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18 8v3H9v3l-3-3 3-3h9V8h3l-3-4-3 4z"/></svg>',
    'sharp-right': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M6 8V5h9v3l3-3 3 4-3 4v-3H9V8H6z"/></svg>',
    uturn: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 4v5h4v2c0 2.2-1.8 4-4 4s-4-1.8-4-4V9c0-2.2 1.8-4 4-4h4V4l4 4-4 4z"/></svg>',
    'roundabout-1st': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M15 11l-3-3v2H9v2h3v2l3-3z"/></svg>',
    'roundabout-2nd': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M11 9l3 3-3 3v-2H9v-2h2V9z"/></svg>',
    'roundabout-3rd': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M9 13l3 3v-2h2v-2h-2v-2L9 13z"/></svg>',
    'roundabout-4th': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M13 15l-3 3v-2H8v-2h2v-2l3 3z"/></svg>',
    arrive: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
  };

  /** Replace north/south/east/west with straight so guidance uses only left, right, straight. */
  function normalizeInstructionText(str) {
    if (!str || typeof str !== 'string') return str;
    var s = str
      .replace(/\bHead\s+(north|south|east|west)\b/gi, 'Head straight')
      .replace(/\bContinue\s+(north|south|east|west)\b/gi, 'Continue straight')
      .replace(/\bGo\s+(north|south|east|west)\b/gi, 'Go straight')
      .replace(/\bTurn\s+(north|south|east|west)\s+onto\b/gi, 'Turn onto')
      .replace(/\bTurn\s+(north|south|east|west)\b/gi, 'Turn')
      .replace(/\bHeading\s+(north|south|east|west)\b/gi, 'Heading straight')
      .replace(/\bTravel\s+(north|south|east|west)\b/gi, 'Travel straight')
      .replace(/\bDrive\s+(north|south|east|west)\b/gi, 'Drive straight')
      .replace(/\bBear\s+(north|south|east|west)\b/gi, 'Bear straight')
      .replace(/\bProceed\s+(north|south|east|west)\b/gi, 'Proceed straight')
      .replace(/\s+(north|south|east|west)\s+on\s/gi, ' straight on ')
      .replace(/\s+then\s+(north|south|east|west)\s/gi, ' then straight ')
      .replace(/\s+and\s+(north|south|east|west)\s/gi, ' and straight ')
      .replace(/\bnorthbound\b/gi, 'ahead')
      .replace(/\bsouthbound\b/gi, 'ahead')
      .replace(/\beastbound\b/gi, 'ahead')
      .replace(/\bwestbound\b/gi, 'ahead')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return s;
  }

  /**
   * Mapbox turn icon mapping (per Maneuver UI / TurnIconResources).
   * Maps (type, modifier) to our icon key: turn, continue, depart, fork, roundabout/rotary, on ramp, end of road, notification.
   */
  function bannerTypeModifierToIconKey(type, modifier) {
    var t = (type || '').toLowerCase().replace(/_/g, ' ');
    var m = (modifier || 'straight').toLowerCase().replace(/_/g, ' ');
    if (t === 'arrive') return 'arrive';
    if (m === 'uturn') return 'uturn';
    if (t === 'depart') {
      if (m === 'left') return 'turn-left';
      if (m === 'right') return 'turn-right';
      return 'keep-straight';
    }
    if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') {
      if (m === 'right') return 'roundabout-1st';
      if (m === 'straight') return 'roundabout-2nd';
      if (m === 'left') return 'roundabout-3rd';
      return 'roundabout-4th';
    }
    if (t === 'merge' || t === 'on ramp' || t === 'off ramp' || t === 'fork' || t === 'continue' || t === 'turn' || t === 'end of road' || t === 'notification') {
      if (m === 'sharp left') return 'sharp-left';
      if (m === 'sharp right') return 'sharp-right';
      if (m === 'left') return 'turn-left';
      if (m === 'right') return 'turn-right';
      if (m === 'slight left') return 'take-left-exit';
      if (m === 'slight right') return 'take-right-exit';
      if (m === 'straight') return 'keep-straight';
      return 'keep-straight';
    }
    return 'keep-straight';
  }

  function instructionToIconKey(instruction) {
    if (instruction === 'Arrive at destination') return 'arrive';
    if (instruction === 'Make a U-turn') return 'uturn';
    if (instruction === 'Take the left exit') return 'take-left-exit';
    if (instruction === 'Take the right exit') return 'take-right-exit';
    if (instruction === 'Keep straight') return 'keep-straight';
    if (instruction === 'Turn left') return 'turn-left';
    if (instruction === 'Turn right') return 'turn-right';
    if (instruction === 'Sharp left') return 'sharp-left';
    if (instruction === 'Sharp right') return 'sharp-right';
    if (instruction && instruction.indexOf('Take the 1st exit') === 0) return 'roundabout-1st';
    if (instruction && instruction.indexOf('Take the 2nd exit') === 0) return 'roundabout-2nd';
    if (instruction && instruction.indexOf('Take the 3rd exit') === 0) return 'roundabout-3rd';
    if (instruction && instruction.indexOf('Take the 4th exit') === 0) return 'roundabout-4th';
    return 'keep-straight';
  }

  function isContinueStraightInstruction(instruction) {
    return instruction === 'Keep straight';
  }

  /** True if this is a turn/exit (zoom in when approaching). */
  function isTurnOrExitFromBanner(banner) {
    if (!banner) return false;
    var t = banner.type;
    if (t === 'arrive' || t === 'depart') return t === 'arrive';
    return true;
  }

  /** When API says left but route geometry says right (or vice versa), fix the banner so guidance matches the map. */
  /** When API says roundabout but geometry is a simple turn (no roundabout visible), show the simple turn instead. */
  function correctBannerFromGeometry(banner, geometryInstruction) {
    if (!banner || !geometryInstruction) return banner;
    var t = (banner.type || '').toLowerCase().replace(/_/g, ' ');
    var primary = (banner.primaryText || '').toLowerCase();
    var geom = geometryInstruction.toLowerCase();

    if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') {
      var ontoMatch = (banner.primaryText || '').match(/\bonto\s+(.+)/i);
      var ontoStr = ontoMatch ? ontoMatch[1].replace(/\s+in\s+\d.*$/i, '').trim() : '';
      if (geom.indexOf('turn left') !== -1 || geom === 'turn left') {
        return { primaryText: 'Turn left' + (ontoStr ? ' onto ' + ontoStr : ''), modifier: 'left', type: 'turn', secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
      }
      if (geom.indexOf('turn right') !== -1 || geom === 'turn right') {
        return { primaryText: 'Turn right' + (ontoStr ? ' onto ' + ontoStr : ''), modifier: 'right', type: 'turn', secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
      }
      if (geom.indexOf('take the left exit') !== -1) {
        return { primaryText: 'Take the left exit' + (ontoStr ? ' onto ' + ontoStr : ''), modifier: 'slight left', type: 'turn', secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
      }
      if (geom.indexOf('take the right exit') !== -1) {
        return { primaryText: 'Take the right exit' + (ontoStr ? ' onto ' + ontoStr : ''), modifier: 'slight right', type: 'turn', secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
      }
      if (geom.indexOf('keep straight') !== -1) {
        return { primaryText: 'Keep straight' + (ontoStr ? ' onto ' + ontoStr : ''), modifier: 'straight', type: 'continue', secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
      }
    }

    var mod = (banner.modifier || '').toLowerCase().replace(/_/g, ' ');
    var wantsLeft = mod === 'left' || primary.indexOf('turn left') !== -1 || primary.indexOf('left onto') !== -1 || primary.indexOf('left exit') !== -1;
    var wantsRight = mod === 'right' || primary.indexOf('turn right') !== -1 || primary.indexOf('right onto') !== -1 || primary.indexOf('right exit') !== -1;
    var geomLeft = geom.indexOf('left') !== -1;
    var geomRight = geom.indexOf('right') !== -1;
    if (wantsLeft && geomRight) {
      return { primaryText: (banner.primaryText || '').replace(/\bleft\b/gi, 'right'), modifier: 'right', type: banner.type, secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
    }
    if (wantsRight && geomLeft) {
      return { primaryText: (banner.primaryText || '').replace(/\bright\b/gi, 'left'), modifier: 'left', type: banner.type, secondaryText: banner.secondaryText, subText: banner.subText, distanceRemainingM: banner.distanceRemainingM, stepIndex: banner.stepIndex };
    }
    return banner;
  }

  function getManeuverSvg(type, modifier) {
    var t = (type || '').toLowerCase();
    var m = (modifier || '').toLowerCase().replace(/_/g, ' ');
    if (t === 'arrive') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="10" stroke="currentColor" stroke-width="3" fill="none"/><circle cx="24" cy="24" r="4" fill="currentColor"/></svg>';
    if (t === 'depart' || (t === 'continue' && (m === 'straight' || !m))) return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M24 8v32M18 14l6-6 6 6M18 34l6 6 6-6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (m === 'uturn' || m === 'sharp left' && t === 'turn') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M24 8v12a8 8 0 01-8 8 8 8 0 01-8-8V14M24 40v-12a8 8 0 008-8 8 8 0 008 8V34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>';
    if (m === 'left' || m === 'sharp left') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M38 24H14l8-8-4-4L6 24l12 12 4-4-8-8h24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (m === 'right' || m === 'sharp right') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M10 24h24l-8 8 4 4 12-12-12-12-4 4 8 8H10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (m === 'slight left') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M32 24H14l6-6M14 24l10 10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (m === 'slight right') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M16 24h18l-6-6M34 24L24 34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (t === 'roundabout' || t === 'rotary' || t.indexOf('roundabout') !== -1) return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="14" stroke="currentColor" stroke-width="2" fill="none"/><path d="M24 10v8l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
    if (t === 'ramp' || t === 'exit') return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M8 40V24a4 4 0 014-4h24M36 20l8 8-8 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M24 8v32M18 14l6-6 6 6M18 34l6 6 6-6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  }

  function formatNavDistance(m) {
    if (m == null || isNaN(m)) return '—';
    if (m < 30) return 'NOW';
    if (m < 100) return Math.round(m) + ' m';
    if (m <= 999) return Math.round(m) + ' m';
    return (m / 1000).toFixed(1).replace(/\.0$/, '') + ' km';
  }

  var _lastNavInstructionMainText = '';
  var _lastNavInstructionSeg = -1;
  function updateNavInstructionBox(opts) {
    var wrap = document.getElementById('navInstructionBoxWrap');
    var box = document.getElementById('navInstructionBox');
    var iconEl = document.getElementById('navInstructionIcon');
    var mainEl = document.getElementById('navInstructionMain');
    var streetEl = document.getElementById('navInstructionStreet');
    var distEl = document.getElementById('navInstructionDistance');
    var nextEl = document.getElementById('navInstructionNextText');
    if (!wrap || !box) return;
    if (!opts || opts.hide) {
      wrap.style.display = 'none';
      var nextWrapHide = document.getElementById('navInstructionNext');
      if (nextWrapHide) nextWrapHide.style.display = 'none';
      _lastNavInstructionMainText = '';
      _lastNavInstructionSeg = -1;
      return;
    }
    wrap.style.display = 'flex';
    var mainText = (opts.mainText || 'Continue straight').trim();
    var streetText = (opts.streetText || '').trim();
    var distanceM = opts.distanceM != null ? opts.distanceM : opts.distanceRemainingM;
    var nextText = (opts.nextText || '').trim();
    var type = opts.type || 'continue';
    var modifier = opts.modifier || 'straight';
    var seg = opts.segmentIndex != null ? opts.segmentIndex : -1;
    var mainChanged = mainText !== _lastNavInstructionMainText || seg !== _lastNavInstructionSeg;
    if (iconEl) iconEl.innerHTML = getManeuverSvg(type, modifier);
    if (mainEl) mainEl.textContent = mainText;
    if (streetEl) { streetEl.textContent = streetText; streetEl.style.display = streetText ? '' : 'none'; }
    var distStr = formatNavDistance(distanceM);
    if (distEl) {
      distEl.textContent = distStr;
      distEl.classList.toggle('now', distStr === 'NOW');
    }
    if (nextEl) nextEl.textContent = nextText || '—';
    var distRemM = opts.distanceRemainingM != null ? opts.distanceRemainingM : (opts.distanceM != null ? opts.distanceM : 999);
    var showNext = distRemM <= 500 && (nextText || opts.nextText);
    var nextWrap = document.getElementById('navInstructionNext');
    if (nextWrap) {
      if (showNext) {
        nextWrap.classList.remove('nav-next-pop-out');
        nextWrap.classList.add('nav-next-pop-in');
        nextWrap.style.display = '';
      } else {
        nextWrap.classList.remove('nav-next-pop-in');
        nextWrap.classList.add('nav-next-pop-out');
        setTimeout(function () {
          if (nextWrap.classList.contains('nav-next-pop-out')) nextWrap.style.display = 'none';
        }, 220);
      }
    }
    if (mainChanged) {
      _lastNavInstructionMainText = mainText;
      _lastNavInstructionSeg = seg;
      box.classList.remove('animate-in');
      void box.offsetWidth;
      box.classList.add('animate-in');
    }
  }

  var navAttachedLoaded = false;
  var navAttachedTried = false;
  var navSpriteLoaded = false;
  var navSpriteTried = false;

  function tryUseAttachedNavArrows(iconEl, key) {
    if (!iconEl) return false;
    if (!navAttachedTried) {
      navAttachedTried = true;
      var img = new Image();
      img.onload = function () { navAttachedLoaded = true; refreshNavHintIfVisible(); };
      img.onerror = function () { navAttachedLoaded = false; };
      img.src = 'assets/nav-arrows.png';
    }
    if (!navAttachedLoaded) return false;
    var pos = ATTACHED_NAV_ICONS[key];
    if (!pos) return false;
    var r = pos[0], c = pos[1];
    iconEl.classList.add('nav-hint-icon-sprite');
    iconEl.style.backgroundImage = 'url(assets/nav-arrows.png)';
    iconEl.style.backgroundPosition = (-c * ATTACHED_NAV_CELL) + 'px ' + (-r * ATTACHED_NAV_CELL) + 'px';
    iconEl.style.backgroundSize = (ATTACHED_NAV_COLS * ATTACHED_NAV_CELL) + 'px ' + (ATTACHED_NAV_ROWS * ATTACHED_NAV_CELL) + 'px';
    return true;
  }

  function tryUseNavSprite(iconEl, key) {
    if (!iconEl) return false;
    if (tryUseAttachedNavArrows(iconEl, key)) return true;
    if (!navSpriteTried) {
      navSpriteTried = true;
      var img = new Image();
      img.onload = function () { navSpriteLoaded = true; refreshNavHintIfVisible(); };
      img.onerror = function () { navSpriteLoaded = false; };
      img.src = 'assets/nav-icons-sprite.png';
    }
    if (!navSpriteLoaded) return false;
    var pos = NAV_SPRITE_ICONS[key];
    if (!pos) return false;
    var r = pos[0], c = pos[1];
    iconEl.classList.add('nav-hint-icon-sprite');
    iconEl.style.backgroundImage = 'url(assets/nav-icons-sprite.png)';
    iconEl.style.backgroundPosition = (-c * NAV_SPRITE_CELL) + 'px ' + (-r * NAV_SPRITE_CELL) + 'px';
    iconEl.style.backgroundSize = 'auto';
    return true;
  }

  function refreshNavHintIfVisible() {
    var h = document.getElementById('navRouteHint');
    if (h && h.style.display !== 'none' && state && (state._lastNavBanner || state._lastNavInstruction != null))
      updateNavRouteHintContent(state._lastNavBanner || state._lastNavInstruction, state._lastNavDistM);
  }

  /**
   * Update nav hint from Mapbox banner (primary, optional secondary/sub, step distance) or from fallback instruction.
   * instructionOrBanner: string (instruction) or object { primaryText, type, modifier, secondaryText, subText, distanceRemainingM }.
   */
  function updateNavRouteHintContent(instructionOrBanner, distM) {
    var iconEl = document.getElementById('navRouteHintIcon');
    var textEl = document.getElementById('navRouteHintText');
    var hintEl = document.getElementById('navRouteHint');
    if (!hintEl || !textEl) return;
    var isBanner = instructionOrBanner && typeof instructionOrBanner === 'object' && instructionOrBanner.primaryText != null;
    var key;
    var text;
    if (isBanner) {
      var banner = instructionOrBanner;
      key = bannerTypeModifierToIconKey(banner.type, banner.modifier);
      var primary = normalizeInstructionText(banner.primaryText || '');
      var t = (banner.type || '').toLowerCase().replace(/_/g, ' ');
      var isRoundaboutStep = (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn');
      if (isRoundaboutStep && primary && primary.toLowerCase().indexOf('roundabout') === -1 && primary.toLowerCase().indexOf('rotary') === -1)
        primary = 'At the roundabout, ' + (primary.charAt(0).toLowerCase() + primary.slice(1)).trim();
      var rem = banner.distanceRemainingM != null ? banner.distanceRemainingM : distM;
      if (banner.type === 'arrive') {
        text = primary;
      } else if (rem != null && rem > HINT_IMMEDIATE_DISTANCE_M) {
        var displayM = rem > 1000 ? Math.round(rem / 200) * 200 : rem > 400 ? Math.round(rem / 100) * 100 : rem > 100 ? Math.round(rem / 50) * 50 : Math.round(rem / 25) * 25 || 50;
        if (displayM >= 1000) text = primary + ' in ' + (displayM / 1000).toFixed(1) + ' km';
        else if (displayM >= 500) text = primary + ' in ' + Math.round(displayM / 100) * 100 + ' m';
        else text = primary + ' in ' + displayM + ' m';
        if (banner.secondaryText) text += ' · ' + normalizeInstructionText(banner.secondaryText);
        if (banner.subText) text += ' · Then ' + normalizeInstructionText(banner.subText).toLowerCase();
      } else {
        text = primary;
        if (banner.secondaryText) text += ' · ' + normalizeInstructionText(banner.secondaryText);
        if (banner.subText) text += ' · Then ' + normalizeInstructionText(banner.subText).toLowerCase();
      }
    } else {
      var instructionRaw = instructionOrBanner;
      key = instructionToIconKey(instructionRaw);
      text = normalizeInstructionText(instructionRaw);
      if (instructionRaw !== 'Arrive at destination' && distM != null) {
        var displayM = distM;
        if (distM > 1000) displayM = Math.round(distM / 200) * 200;
        else if (distM > 400) displayM = Math.round(distM / 100) * 100;
        else if (distM > 100) displayM = Math.round(distM / 50) * 50;
        else if (distM > 25) displayM = Math.round(distM / 25) * 25 || 50;
        if (distM <= HINT_IMMEDIATE_DISTANCE_M) {
          text = text;
        } else if (isContinueStraightInstruction(instructionRaw)) {
          text = 'Keep straight for ' + (displayM >= 1000 ? (displayM / 1000).toFixed(1) + ' km' : displayM + ' m');
        } else {
          text = 'In ' + displayM + ' m, ' + text.toLowerCase();
        }
      }
    }
    if (iconEl) {
      var iconKey = key && (NAV_HINT_ICONS_SVG[key] || NAV_SPRITE_ICONS[key]) ? key : 'keep-straight';
      var svgHtml = NAV_HINT_ICONS_SVG[iconKey] || NAV_HINT_ICONS_SVG['keep-straight'];
      iconEl.classList.remove('nav-hint-icon-sprite');
      iconEl.style.backgroundImage = '';
      iconEl.style.backgroundPosition = '';
      iconEl.innerHTML = svgHtml;
      iconEl.style.display = '';
      iconEl.setAttribute('aria-hidden', 'true');
      tryUseNavSprite(iconEl, iconKey);
    }
    textEl.textContent = text;
    if (state) {
      state._lastNavBanner = isBanner ? instructionOrBanner : null;
      state._lastNavInstruction = isBanner ? null : instructionOrBanner;
      state._lastNavDistM = distM;
    }
    hintEl.classList.add('is-updating');
    clearTimeout(hintEl._hintUpdateTimer);
    hintEl._hintUpdateTimer = setTimeout(function () {
      hintEl.classList.remove('is-updating');
    }, 280);
  }

  function updateInfoRouteStatus() {
    var el = document.getElementById('infoRouteStatus');
    if (!el) return;
    if (state.route) {
      var dist = Math.round(state.route.distanceKm);
      var stops = (state.waypoints || []).length;
      el.textContent = 'Route planned: ' + dist + ' km' + (stops ? ', ' + stops + ' charging stop(s)' : '') + '.';
    } else if (state.startCoords && state.endCoords) {
      var wpCount = (state.waypoints || []).length;
      el.textContent = 'Start and destination set' + (wpCount ? ', ' + wpCount + ' stop(s) added' : '') + '. Click Plan Route to calculate.';
    } else if (state.startCoords) {
      el.textContent = 'Start set. Enter destination and click Plan Route.';
    } else if (state.endCoords) {
      el.textContent = 'Destination set. Enter start and click Plan Route.';
    } else {
      el.textContent = 'Enter start and destination, then click Plan Route.';
    }
    var copyEl = document.getElementById('infoRouteStatusCopy');
    if (copyEl) copyEl.textContent = el.textContent;
  }

  function doSaveAndStart() {
    var el;
    state.startBattery = parseInt((el = document.getElementById('modalStartBattery')) && el.value, 10) || 100;
    state.targetBattery = parseInt((el = document.getElementById('modalTargetBattery')) && el.value, 10) || 20;
    state.cabinTempC = parseFloat((el = document.getElementById('modalCabinTemp')) && el.value) || 24;
    state.passengers = parseInt((el = document.getElementById('modalPassengers')) && el.value, 10) || 1;
    state.acOn = !((el = document.getElementById('modalAcOff')) && el.checked);
    state.luggageKg = parseFloat((el = document.getElementById('modalLuggage')) && el.value) || 0;
    state.maxSpeedKmh = parseInt((el = document.getElementById('modalMaxSpeed')) && el.value, 10) || 120;
    el = document.getElementById('modalDrivingMode');
    state.drivingMode = (el && el.value) || 'standard';
    var data = window.EVTripPlannerData;
    var evDb = (data && data.getEVDatabase && data.getEVDatabase()) || window.__EV_DATABASE_EMBEDDED || { vehicles: [] };
    var vehicles = (evDb && evDb.vehicles) || [];
    if (!state.vehicle && vehicles.length) state.vehicle = vehicles[0];
    if (!state.vehicle) {
      alert('Please select a vehicle.');
      return;
    }
    var modal = document.getElementById('startupModal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
    if (window.EVTripPlannerUI && window.EVTripPlannerUI.showModal) window.EVTripPlannerUI.showModal(false);
    setTimeout(initMapAndMain, 80);
  }
  global.onSaveAndStart = doSaveAndStart;

  function initModal() {
    var def = (window.EVTripPlannerConfig && window.EVTripPlannerConfig.defaults) || {};
    def = def || {};
    var stateDefaults = {
      startBattery: def.startBatteryPercent != null ? def.startBatteryPercent : 100,
      targetBattery: def.targetBatteryPercent != null ? def.targetBatteryPercent : 20,
      cabinTempC: def.cabinTempC != null ? def.cabinTempC : 24,
      passengers: def.passengers != null ? def.passengers : 1,
      acOn: def.acOn != null ? def.acOn : true,
      luggageKg: def.luggageKg != null ? def.luggageKg : 0,
      maxSpeedKmh: def.maxSpeedKmh != null ? def.maxSpeedKmh : 120,
      drivingMode: def.drivingMode || 'standard',
    };
    var setDefaults = function () {
      state.startBattery = stateDefaults.startBattery;
      state.targetBattery = stateDefaults.targetBattery;
      state.cabinTempC = stateDefaults.cabinTempC;
      state.passengers = stateDefaults.passengers;
      state.acOn = stateDefaults.acOn;
      state.luggageKg = stateDefaults.luggageKg;
      state.maxSpeedKmh = stateDefaults.maxSpeedKmh;
      state.drivingMode = stateDefaults.drivingMode;
      var id = 'modalStartBattery';
      var el = document.getElementById(id);
      if (el) el.value = state.startBattery;
      el = document.getElementById('modalTargetBattery'); if (el) el.value = state.targetBattery;
      el = document.getElementById('modalCabinTemp'); if (el) el.value = state.cabinTempC;
      el = document.getElementById('modalPassengers'); if (el) el.value = state.passengers;
      el = document.getElementById('modalAcOff'); if (el) el.checked = !state.acOn;
      syncAcTogglePill();
      el = document.getElementById('modalLuggage'); if (el) el.value = state.luggageKg;
      el = document.getElementById('modalMaxSpeed'); if (el) el.value = state.maxSpeedKmh;
      el = document.getElementById('modalDrivingMode'); if (el) el.value = state.drivingMode;
    };
    var el = document.getElementById('modalStartBattery');
    if (el) el.value = state.startBattery = stateDefaults.startBattery;
    el = document.getElementById('modalTargetBattery'); if (el) el.value = state.targetBattery = stateDefaults.targetBattery;
    el = document.getElementById('modalCabinTemp'); if (el) el.value = state.cabinTempC = stateDefaults.cabinTempC;
    el = document.getElementById('modalPassengers'); if (el) el.value = state.passengers = stateDefaults.passengers;
    state.acOn = stateDefaults.acOn;
    el = document.getElementById('modalAcOff'); if (el) el.checked = !stateDefaults.acOn;
    syncAcTogglePill();
    el = document.getElementById('modalLuggage'); if (el) el.value = state.luggageKg = stateDefaults.luggageKg;
    el = document.getElementById('modalMaxSpeed'); if (el) el.value = state.maxSpeedKmh = stateDefaults.maxSpeedKmh;
    el = document.getElementById('modalDrivingMode'); if (el) el.value = state.drivingMode = stateDefaults.drivingMode;
    el = document.getElementById('modalDeparture');
    if (el) {
      var now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      el.value = now.toISOString().slice(0, 16);
    }
    window.onSaveAndStart = doSaveAndStart;

    function renderVehicles() {
      var evDb = (Data && Data.getEVDatabase && Data.getEVDatabase()) || window.__EV_DATABASE_EMBEDDED || {};
      var allVehicles = (evDb && evDb.vehicles) || [];
      var vehicles = allVehicles.filter(function (v) {
        var img = (v.vehicle_image || '').toLowerCase();
        return img && img.endsWith('.png');
      });
      if (!state.vehicle && vehicles.length) {
        state.vehicle = vehicles.find(function (v) { return v.id === 'byd-song-l-662'; }) || vehicles[0];
      }
      if (state.vehicle && !vehicles.some(function (v) { return v.id === state.vehicle.id; })) {
        state.vehicle = vehicles[0] || null;
      }
      function onVehicleSelect(v) {
        state.vehicle = v;
        renderVehicles();
        updateModalPreview();
      }
      if (UI && UI.renderVehicleCards) UI.renderVehicleCards('vehicleCards', vehicles, state.vehicle ? state.vehicle.id : null, onVehicleSelect);
    }
    renderVehicles();
    if (Data && Data.ready) Data.ready.then(renderVehicles).catch(function () {});

    if (window.EVTripPlannerWeather && window.EVTripPlannerWeather.fetchWeather) {
      window.EVTripPlannerWeather.fetchWeather(30.0444, 31.2357).then(function (w) {
        var el = document.getElementById('modalAmbientTemp');
        if (el && w && w.temperature_2m != null) { el.value = Math.round(w.temperature_2m * 10) / 10; state.ambientTempC = w.temperature_2m; }
      }).catch(function () {});
    }

    var resetBtn = document.getElementById('modalReset');
    if (resetBtn) resetBtn.addEventListener('click', function () { setDefaults(); updateModalPreview(); });

    var saveBtn = document.getElementById('modalSaveStart');
    if (saveBtn) saveBtn.style.cursor = 'pointer';

    var modalPreviewIds = ['modalStartBattery', 'modalCabinTemp', 'modalPassengers', 'modalLuggage', 'modalMaxSpeed', 'modalAmbientTemp', 'modalDrivingMode'];
    modalPreviewIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', updateModalPreview);
      if (el) el.addEventListener('change', updateModalPreview);
    });
    var startupModal = document.getElementById('startupModal');
    if (startupModal) {
      startupModal.addEventListener('input', updateModalPreview);
      startupModal.addEventListener('change', updateModalPreview);
    }
    var acOff = document.getElementById('modalAcOff');
    var acPill = document.getElementById('modalAcTogglePill');
    if (acOff && acPill) {
      acOff.addEventListener('change', function () { syncAcTogglePill(); updateModalPreview(); });
      acPill.addEventListener('click', function () {
        acOff.checked = !acOff.checked;
        syncAcTogglePill();
        updateModalPreview();
      });
      acPill.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); acPill.click(); }
      });
    }
    updateModalPreview();
  }

  function initMapAndMain() {
    var mapContainer = document.getElementById('map');
    if (!mapContainer) return;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          state.userLocation = [pos.coords.longitude, pos.coords.latitude];
          if (window.EVTripPlannerMap && window.EVTripPlannerMap.setUserLocation) {
            window.EVTripPlannerMap.setUserLocation(state.userLocation[0], state.userLocation[1]);
          }
          if (window.EVTripPlannerMap && window.EVTripPlannerMap.centerOnUser) window.EVTripPlannerMap.centerOnUser();
        },
        function () {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
      );
    }
    setupRouteInputs();
    setupBottomControls();
    setupThemeToggle();
    setupDemo();
    setupDevTuningPanel();
    applyTripToUI();
    Data.ready.then(function (ref) {
      var chargers = (ref && ref.chargerDatabase && ref.chargerDatabase.chargers) || [];
      var toShow = state.route && state.route.coordinates && state.route.coordinates.length >= 2
        ? Chargers.chargersNearRoute(chargers, state.route.coordinates, C && C.routing && C.routing.chargerSearchRadiusKm ? C.routing.chargerSearchRadiusKm : 10)
        : [];
      MapModule.addChargerMarkers(toShow, onChargerPinClick);
    }).catch(function () {});
    var mapEl = MapModule.getMap && MapModule.getMap();
    if (mapEl && mapEl.resize) {
      setTimeout(function () { mapEl.resize(); }, 100);
      setTimeout(function () { mapEl.resize(); }, 400);
    }
    var userLoc = MapModule.getUserLocation && MapModule.getUserLocation();
    if (userLoc) {
      state.userLocation = userLoc;
      fetchWeatherForPosition(userLoc[1], userLoc[0]).then(function () { applyTripToUI(); });
    }
    if (navigator.geolocation && !state.speedWatchId) {
      state.speedWatchId = navigator.geolocation.watchPosition(
        function (pos) {
          if (!state.navigationActive) updateSpeedSign(pos.coords.speed, state.maxSpeedKmh);
        },
        function () {},
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
      );
    }
    setInterval(function () {
      var loc = state.userLocation || (MapModule.getUserLocation && MapModule.getUserLocation());
      if (loc) fetchWeatherForPosition(loc[1], loc[0]).then(function () { applyTripToUI(); });
    }, 10 * 60 * 1000);
    if (!mapEl && MapModule.init) {
      setTimeout(function () {
        MapModule.init('map').then(function (map) {
          if (map) {
            var isLight = document.documentElement.classList.contains('theme-light');
            if (MapModule.setStyle) MapModule.setStyle(isLight ? 'day' : 'night');
            setTimeout(function () { if (map.resize) map.resize(); }, 100);
            setTimeout(function () { if (map.resize) map.resize(); }, 400);
          }
          applyTripToUI();
        });
      }, 120);
    }
    /* Show map from start so route planning stays below it (doesn't jump to top) */
    showMapSection(true);
  }

  function onChargerPinClick(charger) {
    state.selectedChargerForStop = charger;
    var overlay = document.getElementById('chargerModalOverlay');
    var title = document.getElementById('chargerModalTitle');
    var slider = document.getElementById('chargerAddPercent');
    var valEl = document.getElementById('chargerAddPercentVal');
    var arrivalText = document.getElementById('chargerModalArrivalText');
    var costText = document.getElementById('chargerModalCostText');
    var costVal = document.getElementById('chargerModalCostVal');
    if (title) title.textContent = (charger.name || 'Charger') + ' – Add as stop?';

    var estimatedArrivalPercent = 10;
    if (state.route && state.route.coordinates && state.route.coordinates.length >= 2 && state.vehicle && state.startBattery != null) {
      var distKm = Chargers.distanceAlongRouteToPointKm(state.route.coordinates, charger.lng, charger.lat);
      var chargerTripOpts = buildTripOptions();
      estimatedArrivalPercent = Math.round(Trip.batteryAtEnd(state.vehicle, state.startBattery, distKm, chargerTripOpts));
      estimatedArrivalPercent = Math.max(5, Math.min(95, estimatedArrivalPercent));
    }
    state.chargerModalArrivalPercent = estimatedArrivalPercent;
    var minCharge = estimatedArrivalPercent;
    var maxCharge = 100;
    var addablePercent = 100 - estimatedArrivalPercent;
    var defaultCharge = 100;
    if (slider) {
      slider.min = minCharge;
      slider.max = maxCharge;
      slider.value = defaultCharge;
      slider.disabled = false;
      slider.setAttribute('data-arrival-pct', estimatedArrivalPercent);
    }
    if (valEl) valEl.textContent = defaultCharge;
    if (arrivalText) {
      arrivalText.textContent = 'Estimated battery on arrival: ' + estimatedArrivalPercent + '%. Charge to (max ' + addablePercent + '% addable):';
    }
    updateChargerModalCost(slider, costVal);
    if (overlay) overlay.style.display = 'flex';
  }

  function updateChargerModalCost(sliderEl, costValEl) {
    if (!costValEl || !state.vehicle || state.chargerModalArrivalPercent == null) return;
    var toPercent = parseInt(sliderEl && sliderEl.value, 10) || 80;
    var fromPercent = state.chargerModalArrivalPercent;
    if (toPercent <= fromPercent) {
      costValEl.textContent = '0.00';
      return;
    }
    var kwhAdded = state.vehicle.battery_kwh * ((toPercent - fromPercent) / 100);
    var rate = (C && C.routing && C.routing.dcFastCostPerKwhEGP != null) ? C.routing.dcFastCostPerKwhEGP : 6.5;
    var costEGP = (kwhAdded * rate).toFixed(2);
    costValEl.textContent = costEGP;
  }

  function setupRouteInputs() {
    const startInput = document.getElementById('startLocation');
    const destInput = document.getElementById('destination');
    const startDropdown = document.getElementById('startDropdown');
    const destDropdown = document.getElementById('destDropdown');

    var useStart = document.getElementById('useCurrentStart');
    if (useStart) useStart.addEventListener('click', function () {
      var loc = MapModule.getUserLocation && MapModule.getUserLocation();
      if (loc) {
        state.startCoords = loc;
        MapModule.setStartMarker(state.startCoords);
        Search.reverse(loc[1], loc[0]).then(function (name) {
          if (startInput) startInput.value = name || 'Current location';
        });
        updateInfoRouteStatus();
      } else {
        navigator.geolocation.getCurrentPosition(function (pos) {
          state.startCoords = [pos.coords.longitude, pos.coords.latitude];
          if (MapModule.setUserLocation) MapModule.setUserLocation(state.startCoords[0], state.startCoords[1]);
          state.userLocation = state.startCoords;
          MapModule.setStartMarker(state.startCoords);
          startInput.value = 'Current location';
          updateInfoRouteStatus();
        }, function () { alert('Could not get location'); }, { enableHighAccuracy: true });
      }
    });
    var useDest = document.getElementById('useCurrentDest');
    if (useDest) useDest.addEventListener('click', function () {
      var loc = MapModule.getUserLocation && MapModule.getUserLocation();
      if (loc) {
        state.endCoords = loc;
        MapModule.setEndMarker(state.endCoords);
        Search.reverse(loc[1], loc[0]).then(function (name) {
          if (destInput) destInput.value = name || 'Current location';
        });
        updateInfoRouteStatus();
      } else {
        navigator.geolocation.getCurrentPosition(function (pos) {
          state.endCoords = [pos.coords.longitude, pos.coords.latitude];
          if (MapModule.setUserLocation) MapModule.setUserLocation(state.endCoords[0], state.endCoords[1]);
          MapModule.setEndMarker(state.endCoords);
          destInput.value = 'Current location';
          updateInfoRouteStatus();
        }, function () { alert('Could not get location'); }, { enableHighAccuracy: true });
      }
    });

    function getChargerPlaces(query) {
      return Data.ready.then(function (ref) {
        var chargers = (ref && ref.chargerDatabase && ref.chargerDatabase.chargers) || [];
        var q = (query || '').toLowerCase().trim();
        if (!q) return [];
        return chargers.filter(function (c) {
          var name = (c.name || '').toLowerCase();
          var city = (c.city || '').toLowerCase();
          var network = (c.network || '').toLowerCase();
          return name.indexOf(q) !== -1 || city.indexOf(q) !== -1 || network.indexOf(q) !== -1;
        }).map(function (c) {
          var fullAddr = (c.name || 'Charger') + ', ' + (c.city || '') + ', Egypt';
          return { display_name: fullAddr, name: c.name, lat: c.lat, lng: c.lng };
        });
      }).catch(function () { return []; });
    }
    UI.setupSearchInput('startLocation', 'startDropdown', (place) => {
      state.startCoords = [place.lng, place.lat];
      MapModule.setStartMarker(state.startCoords);
      updateInfoRouteStatus();
    }, function () { return state.userLocation || (MapModule.getUserLocation && MapModule.getUserLocation()); }, getChargerPlaces, 'startLocationHint');
    UI.setupSearchInput('destination', 'destDropdown', (place) => {
      state.endCoords = [place.lng, place.lat];
      MapModule.setEndMarker(state.endCoords);
      updateInfoRouteStatus();
    }, function () { return state.userLocation || (MapModule.getUserLocation && MapModule.getUserLocation()); }, getChargerPlaces, 'destLocationHint');

    document.getElementById('pinStart')?.addEventListener('click', function () {
      var mapInstance = MapModule.getMap && MapModule.getMap();
      if (!mapInstance) { alert('Map not ready. Try again in a moment.'); return; }
      mapInstance.getCanvas().style.cursor = 'crosshair';
      function onMapClick(e) {
        mapInstance.off('click', onMapClick);
        mapInstance.getCanvas().style.cursor = '';
        var lng = e.lngLat.lng, lat = e.lngLat.lat;
        state.startCoords = [lng, lat];
        MapModule.setStartMarker(state.startCoords);
        Search.reverse(lat, lng).then(function (name) {
          if (startInput) startInput.value = name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
        });
        updateInfoRouteStatus();
      }
      mapInstance.on('click', onMapClick);
    });

    document.getElementById('pinDest')?.addEventListener('click', function () {
      var mapInstance = MapModule.getMap && MapModule.getMap();
      if (!mapInstance) { alert('Map not ready. Try again in a moment.'); return; }
      mapInstance.getCanvas().style.cursor = 'crosshair';
      function onMapClick(e) {
        mapInstance.off('click', onMapClick);
        mapInstance.getCanvas().style.cursor = '';
        var lng = e.lngLat.lng, lat = e.lngLat.lat;
        state.endCoords = [lng, lat];
        MapModule.setEndMarker(state.endCoords);
        Search.reverse(lat, lng).then(function (name) {
          if (destInput) destInput.value = name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
        });
        updateInfoRouteStatus();
      }
      mapInstance.on('click', onMapClick);
    });

    (function setupSavedPlaces() {
      var SAVED_PLACES_KEY = 'evTripSavedPlaces';
      var MAX_PLACES = 8;
      var pendingPinBySlot = {};
      var editNameSlotIndex = null;

      function getSavedPlaces() {
        try {
          var raw = localStorage.getItem(SAVED_PLACES_KEY);
          var list = raw ? JSON.parse(raw) : [];
          return Array.isArray(list) ? list.slice(0, MAX_PLACES) : [];
        } catch (e) { return []; }
      }
      function saveSavedPlaces(list) {
        try {
          localStorage.setItem(SAVED_PLACES_KEY, JSON.stringify(list.slice(0, MAX_PLACES)));
        } catch (e) {}
      }

      function renderSlots() {
        var list = getSavedPlaces();
        var container = document.getElementById('savedPlacesSlots');
        if (!container) return;
        container.innerHTML = '';
        for (var i = 0; i < MAX_PLACES; i++) {
          var place = list[i] || null;
          var pending = pendingPinBySlot[i];
          var row = document.createElement('div');
          row.className = 'saved-place-slot';
          var label = document.createElement('span');
          label.className = 'slot-label';
          label.textContent = 'Place ' + (i + 1);
          var input = document.createElement('input');
          input.type = 'text';
          input.className = 'slot-input';
          input.placeholder = 'Pin on map, then Save';
          input.readOnly = true;
          if (place) input.value = place.name || (place.lat.toFixed(4) + ', ' + place.lng.toFixed(4));
          else if (pending) input.value = pending.lat.toFixed(4) + ', ' + pending.lng.toFixed(4);
          var pinBtn = document.createElement('button');
          pinBtn.type = 'button';
          pinBtn.className = 'pin-btn';
          pinBtn.textContent = 'Pin on map';
          pinBtn.title = 'Click map to set location';
          var saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.className = 'slot-save-btn';
          saveBtn.textContent = 'Save';
          saveBtn.title = 'Save and name this place';
          saveBtn.disabled = !pending && !place;
          (function (slotIndex) {
            pinBtn.addEventListener('click', function () {
              var mapInstance = MapModule.getMap && MapModule.getMap();
              if (!mapInstance) { alert('Map not ready.'); return; }
              if (MapModule.removeTempSavePin) MapModule.removeTempSavePin();
              mapInstance.getCanvas().style.cursor = 'crosshair';
              function onMapClick(e) {
                mapInstance.off('click', onMapClick);
                mapInstance.getCanvas().style.cursor = '';
                var lng = e.lngLat.lng, lat = e.lngLat.lat;
                pendingPinBySlot[slotIndex] = { lng: lng, lat: lat };
                if (MapModule.setTempSavePin) MapModule.setTempSavePin(lng, lat);
                renderSlots();
              }
              mapInstance.on('click', onMapClick);
            });
            saveBtn.addEventListener('click', function () {
              var pending = pendingPinBySlot[slotIndex];
              var place = (getSavedPlaces())[slotIndex];
              if (!pending && !place) return;
              editNameSlotIndex = slotIndex;
              var overlay = document.getElementById('editNameModalOverlay');
              var inputEdit = document.getElementById('editNameInput');
              if (overlay && inputEdit) {
                inputEdit.value = place ? (place.name || '') : '';
                inputEdit.placeholder = 'Place name';
                overlay.style.display = 'flex';
                overlay.setAttribute('aria-hidden', 'false');
                inputEdit.focus();
              }
            });
          })(i);
          row.appendChild(label);
          row.appendChild(input);
          row.appendChild(pinBtn);
          row.appendChild(saveBtn);
          container.appendChild(row);
        }
      }

      function toggleSavedPlacesPanel() {
        var panel = document.getElementById('savedPlacesPanel');
        if (!panel) return;
        var show = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = show ? 'block' : 'none';
        if (show) renderSlots();
      }
      if (typeof window !== 'undefined') window.__evToggleSavedPlacesPanel = toggleSavedPlacesPanel;

      var editOverlay = document.getElementById('editNameModalOverlay');
      var editInput = document.getElementById('editNameInput');
      document.getElementById('editNameCancel')?.addEventListener('click', function () {
        if (editOverlay) { editOverlay.style.display = 'none'; editOverlay.setAttribute('aria-hidden', 'true'); }
        editNameSlotIndex = null;
      });
      document.getElementById('editNameSave')?.addEventListener('click', function () {
        if (editNameSlotIndex == null) return;
        var name = (editInput && editInput.value && editInput.value.trim()) || ('Saved ' + (editNameSlotIndex + 1));
        var list = getSavedPlaces();
        var pending = pendingPinBySlot[editNameSlotIndex];
        while (list.length <= editNameSlotIndex) list.push(null);
        var place = list[editNameSlotIndex];
        var lng = (pending && pending.lng) || (place && place.lng);
        var lat = (pending && pending.lat) || (place && place.lat);
        if (lng == null || lat == null) { if (editOverlay) editOverlay.style.display = 'none'; editNameSlotIndex = null; return; }
        list[editNameSlotIndex] = { id: (place && place.id) || Date.now(), name: name.trim(), lng: lng, lat: lat };
        saveSavedPlaces(list);
        pendingPinBySlot[editNameSlotIndex] = null;
        if (MapModule.removeTempSavePin) MapModule.removeTempSavePin();
        if (editOverlay) { editOverlay.style.display = 'none'; editOverlay.setAttribute('aria-hidden', 'true'); }
        editNameSlotIndex = null;
        renderSlots();
      });

      var savedDestBtn = document.getElementById('savedDestBtn');
      var savedDestDropdown = document.getElementById('savedDestDropdown');
      if (savedDestBtn && savedDestDropdown) {
        savedDestBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var list = getSavedPlaces().filter(function (p) { return p && p.name; });
          if (list.length === 0) {
            savedDestDropdown.style.display = 'none';
            alert('No saved places. Use Saved Places to pin and save locations.');
            return;
          }
          savedDestDropdown.innerHTML = '';
          list.forEach(function (place) {
            var item = document.createElement('div');
            item.className = 'search-dropdown-item';
            item.textContent = place.name;
            item.setAttribute('role', 'button');
            item.tabIndex = 0;
            item.addEventListener('click', function () {
              if (destInput) destInput.value = place.name;
              state.endCoords = [place.lng, place.lat];
              MapModule.setEndMarker(state.endCoords);
              updateInfoRouteStatus();
              savedDestDropdown.style.display = 'none';
              if (state.startCoords && state.endCoords) updateRouteFromCoords();
            });
            savedDestDropdown.appendChild(item);
          });
          savedDestDropdown.style.display = 'block';
        });
        document.addEventListener('click', function (e) {
          if (savedDestDropdown && savedDestDropdown.style.display === 'block' && !savedDestBtn.contains(e.target) && !savedDestDropdown.contains(e.target)) {
            savedDestDropdown.style.display = 'none';
          }
        });
      }
    })();

    var planBtn = document.getElementById('planRouteBtn');
    var startNavBtn = document.getElementById('startNavBtn');
    var stopRouteBtn = document.getElementById('stopRouteBtn');
    if (planBtn) planBtn.addEventListener('click', function () {
      if (state.startCoords && state.endCoords) updateRouteFromCoords();
      else alert('Please enter a start location and destination first.');
    });
    function updateNavButtons() {
      if (startNavBtn) startNavBtn.style.display = state.route && !state.navigationActive ? 'inline-block' : 'none';
      if (stopRouteBtn) stopRouteBtn.style.display = state.navigationActive ? 'inline-block' : 'none';
      var recenterBtn = document.getElementById('mapRecenterBtn');
      if (recenterBtn) recenterBtn.style.display = state.navigationActive ? 'inline-block' : 'none';
    }
    if (startNavBtn) startNavBtn.addEventListener('click', function () {
      if (!state.route || !state.endCoords) return;
      if (MapModule.removeDemoCar) MapModule.removeDemoCar();
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(function (lock) {
          state._wakeLock = lock;
        }).catch(function () {});
      }
      state.navigationActive = true;
      state.navPositionAlongRouteKm = 0;
      state.lastNavGpsPositionKm = null;
      state.lastNavGpsTime = null;
      state.navDisplayKm = null;
      state.navStartBattery = state.startBattery;
      state.navStartTime = Date.now();
      state.smoothedNavBatteryPct = state.startBattery;
      state._lastNavDisplayKm = 0;
      state._lastNavDisplayKmTime = Date.now();
      state._navLastGoodGpsKm = null;
      state._navLastGoodGpsTime = null;
      state.driverBehavior = { recentSpeeds: [], timestamps: [] };
      state.driverBehaviorScore = 0.5;
      state.liveConsumptionBias = 1.0;
      state.smoothedArrivalBatteryPct = null;
      state._navConsumptionSamples = [];
      updateNavButtons();
      if (MapModule.enterNavigationMode) MapModule.enterNavigationMode();
      var coords = state.route.coordinates;
      var mapInstance = MapModule.getMap && MapModule.getMap();
      if (mapInstance && mapInstance.resize) mapInstance.resize();
      if (coords && coords.length >= 2 && MapModule.flyToCar) {
        var bearing = MapModule.bearingBetween ? MapModule.bearingBetween(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) : null;
        MapModule.flyToCar(coords[0][0], coords[0][1], { bearing: bearing, duration: 1000 });
        var turnOff = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(coords, 0) : 0;
        if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(coords[0][0], coords[0][1], bearing, turnOff);
      }
      showMapSection(true);
      setNavLayoutExpanded(true);
      var lastNavMapUpdateTime = 0;
      var lastNavInstructionBoxUpdateTime = 0;
      var lastRouteTrimTime = 0;
      var NAV_MAP_UPDATE_INTERVAL_MS = 60;
      var NAV_INSTRUCTION_BOX_INTERVAL_MS = 200;
      var NAV_ROUTE_TRIM_INTERVAL_MS = 500;
      if (state.navSmoothIntervalId) { clearInterval(state.navSmoothIntervalId); state.navSmoothIntervalId = null; }
      if (state._navRafId) { cancelAnimationFrame(state._navRafId); state._navRafId = null; }
      var _navLastFrameTime = performance.now();
      function navSmoothFrame(timestamp) {
        if (!state.navigationActive || !state.route || !state.route.coordinates) { state._navRafId = requestAnimationFrame(navSmoothFrame); return; }
        var routeCoords = state.route.coordinates;
        var totalKm = state.route.distanceKm;
        if (totalKm == null || totalKm <= 0) {
          totalKm = 0;
          for (var i = 1; i < routeCoords.length; i++) totalKm += Chargers.haversineKm(routeCoords[i-1][1], routeCoords[i-1][0], routeCoords[i][1], routeCoords[i][0]);
        }
        var now = Date.now();
        var dtMs = Math.min(timestamp - _navLastFrameTime, 2000);
        _navLastFrameTime = timestamp;
        var dtSec = dtMs / 1000;

        var displayKm = state.navPositionAlongRouteKm;
        if (state.lastNavGpsPositionKm != null && state.lastNavGpsTime != null) {
          var speedKmh = state.currentSpeedKmh || 0;
          var timeSinceGps = (now - state.lastNavGpsTime) / 1000;
          var extrapolateKm = Math.min(timeSinceGps, 3) * (speedKmh / 3600);
          var targetKm = state.lastNavGpsPositionKm + extrapolateKm;
          targetKm = Math.max(0, Math.min(totalKm, targetKm));
          if (state.navDisplayKm == null) state.navDisplayKm = targetKm;
          var lerpFactor = 1 - Math.pow(0.05, dtSec);
          state.navDisplayKm = state.navDisplayKm + (targetKm - state.navDisplayKm) * lerpFactor;
          state.navDisplayKm = Math.max(0, Math.min(totalKm, state.navDisplayKm));
          displayKm = state.navDisplayKm;
        } else {
          displayKm = 0;
        }
        state.navPositionAlongRouteKm = displayKm;
        var pt = Chargers.getPointAlongRoute && Chargers.getPointAlongRoute(routeCoords, displayKm);
        if (!pt || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number' || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) { state._navRafId = requestAnimationFrame(navSmoothFrame); return; }
        var carLng = pt[0], carLat = pt[1];
        var seg = MapModule.getSegmentIndexFromRoute ? MapModule.getSegmentIndexFromRoute(routeCoords, carLng, carLat) : 0;
        var br = MapModule.getBearingFromRoute ? MapModule.getBearingFromRoute(routeCoords, carLng, carLat) : null;
        var turnOff = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(routeCoords, seg) : 0;
        if (state.lastNavGpsPositionKm != null && Number.isFinite(carLng) && Number.isFinite(carLat)) {
          if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(carLng, carLat, br, turnOff);
          if (now - lastNavMapUpdateTime >= NAV_MAP_UPDATE_INTERVAL_MS) {
            lastNavMapUpdateTime = now;
            if (MapModule.followCar) MapModule.followCar(carLng, carLat, br, undefined, state.currentSpeedKmh || 0, {});
          }
        }
        if (displayKm > 0.01 && MapModule.trimRouteToRemaining && now - lastRouteTrimTime >= NAV_ROUTE_TRIM_INTERVAL_MS) {
          lastRouteTrimTime = now;
          MapModule.trimRouteToRemaining(routeCoords, displayKm);
        }
        if (now - lastNavInstructionBoxUpdateTime >= NAV_INSTRUCTION_BOX_INTERVAL_MS) {
          lastNavInstructionBoxUpdateTime = now;
          var distTraveledM = displayKm * 1000;
          var banner = (MapModule.getBannerInstruction && state.route.maneuvers) ? MapModule.getBannerInstruction(state.route, seg, distTraveledM) : null;
          var t = banner && (banner.type || '').toLowerCase().replace(/_/g, ' ');
          var mod = banner && (banner.modifier || '').toLowerCase().replace(/_/g, ' ');
          var isStraightStep = t === 'depart' || (t === 'continue' && (mod === 'straight' || !mod));
          if (banner && isStraightStep && MapModule.getUpcomingTurnBanner) {
            var upcoming = MapModule.getUpcomingTurnBanner(state.route, seg, distTraveledM);
            if (upcoming && upcoming.distanceRemainingM >= 50 && upcoming.distanceRemainingM <= HINT_SHOW_UPCOMING_TURN_AHEAD_M) banner = upcoming;
          }
          var instr = MapModule.getNextTurnInstruction ? MapModule.getNextTurnInstruction(routeCoords, seg) : 'Keep straight';
          if (banner) banner = correctBannerFromGeometry(banner, instr);
          var nextPt = routeCoords[seg + 1];
          var distM = nextPt ? Math.round(Chargers.haversineKm(carLat, carLng, nextPt[1], nextPt[0]) * 1000) : 0;
          var remM = banner && banner.distanceRemainingM != null ? banner.distanceRemainingM : distM;
          if (banner && (banner.type || '').toLowerCase() === 'arrive' && remM <= 25) {
            if (!state._navArriveHideScheduled) {
              state._navArriveHideScheduled = true;
              setTimeout(function () {
                if (state.navigationActive) updateNavInstructionBox({ hide: true });
                state._navArriveHideScheduled = false;
              }, 1200);
            }
          } else {
            var nextM = MapModule.getUpcomingManeuvers ? MapModule.getUpcomingManeuvers(state.route, seg, 1)[0] : null;
            var nextStr = '';
            if (nextM && state.route.cumulativeStepDistanceM && state.route.stepIndexForSegment) {
              var stepIdx = state.route.stepIndexForSegment[seg];
              var nextStepStartM = state.route.cumulativeStepDistanceM[stepIdx + 1];
              var dRem = nextStepStartM != null ? Math.max(0, nextStepStartM - distTraveledM) : null;
              nextStr = (nextM.primaryText || 'Continue') + (dRem != null && dRem > 0 ? ' in ' + (dRem >= 1000 ? (dRem / 1000).toFixed(1) + ' km' : Math.round(dRem) + ' m') : '');
            }
            updateNavInstructionBox(banner ? { mainText: banner.primaryText || instr, streetText: [banner.secondaryText, banner.subText].filter(Boolean).join(' · ') || '', distanceRemainingM: banner.distanceRemainingM != null ? banner.distanceRemainingM : distM, type: banner.type, modifier: banner.modifier, nextText: nextStr, segmentIndex: seg } : { mainText: instr, distanceRemainingM: distM, nextText: nextStr, segmentIndex: seg });
          }
        }
        var v = state.vehicle;
        if (v && state.navStartBattery != null && state.route && state.route.distanceKm > 0) {
          var distTraveledKm = state.lastNavGpsPositionKm != null
            ? Math.max(0, Math.min(state.route.distanceKm, state.lastNavGpsPositionKm))
            : 0;
          var navState = Object.assign({}, state, {
            maxSpeedKmh: state.maxSpeedKmh != null ? state.maxSpeedKmh : 120,
            actualSpeedKmh: state.currentSpeedKmh,
            useInstantSpeed: true,
            routeDistanceKm: state.route.distanceKm,
            drivingStyleScore: state.driverBehaviorScore,
            liveConsumptionBias: state.liveConsumptionBias,
          });
          var elapsedHours = (now - (state.navStartTime || now)) / 3600000;
          var avgSpeedSoFarKmh = (elapsedHours > 0 && distTraveledKm > 0) ? (distTraveledKm / elapsedHours) : state.currentSpeedKmh;
          var navStateConsumed = Object.assign({}, navState, { actualSpeedKmh: avgSpeedSoFarKmh != null ? avgSpeedSoFarKmh : navState.maxSpeedKmh });
          var consumedKwh = Trip.tripEnergyKwh(v, distTraveledKm, navStateConsumed);
          var currentBattery = Math.max(0, state.navStartBattery - (consumedKwh / v.battery_kwh * 100));
          state.startBattery = Math.round(currentBattery);
          if (state.smoothedNavBatteryPct == null) state.smoothedNavBatteryPct = state.navStartBattery;
          var NAV_BATTERY_LERP = 0.2;
          state.smoothedNavBatteryPct = state.smoothedNavBatteryPct + (currentBattery - state.smoothedNavBatteryPct) * NAV_BATTERY_LERP;
          var displayBatteryPct = Math.round(state.smoothedNavBatteryPct);
          var remainingKm = Math.max(0, state.route.distanceKm - distTraveledKm);
          var predictedEndRaw = Trip.batteryAtEnd(v, currentBattery, remainingKm, navState);
          var predictedEnd = smoothArrivalBattery(predictedEndRaw, window.ENERGY_MODEL_TUNING);
          var rangeKm = Trip.effectiveRangeKm(v, currentBattery, navState);
          var wpWithDist = (state.waypoints || []).map(function (wp) {
            var d = Chargers.distanceAlongRouteToPointKm(routeCoords, wp.lng, wp.lat);
            return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name, lng: wp.lng, lat: wp.lat };
          }).sort(function (a, b) { return a.distKm - b.distKm; });
          var nextStopKm = wpWithDist.length ? Math.max(0, wpWithDist[0].distKm - distTraveledKm) : null;
          var zeroPct = Trip.zeroPointProgress(v, currentBattery, state.route.distanceKm, wpWithDist, navState);
          var etaMin = (state.currentSpeedKmh && state.currentSpeedKmh > 0 && remainingKm > 0) ? (remainingKm / state.currentSpeedKmh) * 60 : (state.route.durationMin && state.route.distanceKm > 0 ? (remainingKm / state.route.distanceKm) * state.route.durationMin : null);
          var arrivalStr = etaMin != null ? (function () { var d = new Date(Date.now() + etaMin * 60 * 1000); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); })() : '—';
          UI.updateHeaderStats(displayBatteryPct, rangeKm, 'FAST');
          UI.updateBatterySidebar(displayBatteryPct, rangeKm);
          UI.updateBottomBar({ expectedRangeKm: rangeKm, nextStopKm: nextStopKm, endEstPercent: predictedEnd, arrivalStr: arrivalStr });
          var bar = document.getElementById('energyProgressWrap');
          if (bar && window.EVTripPlannerEnergyBar) {
            var prevB = currentBattery;
            var prevD = distTraveledKm;
            var cs = wpWithDist.map(function (w) {
              var progress = state.route.distanceKm > 0 ? Math.max(0, Math.min(1, w.distKm / state.route.distanceKm)) : 0;
              var arrPct = Math.round(Trip.batteryAtEnd(v, prevB, w.distKm - prevD, navState));
              arrPct = Math.max(0, Math.min(100, arrPct));
              var chargeTo = w.chargeTo != null ? w.chargeTo : 100;
              var waitMin = Trip.chargingTimeMin(v, arrPct, chargeTo, 50);
              prevB = chargeTo;
              prevD = w.distKm;
              return { progress: progress, name: w.name || 'Charging Station', waitingTimeMin: waitMin, lng: w.lng, lat: w.lat };
            });
            window.EVTripPlannerEnergyBar.updateBar(bar, {
              currentBatteryPercent: displayBatteryPct,
              predictedEndPercent: predictedEnd,
              tripProgress: distTraveledKm / state.route.distanceKm,
              chargeStops: cs,
              zeroPointProgress: zeroPct,
              routeDistanceKm: state.route.distanceKm,
              onChargeStopClick: onChargeStopRemoveClick,
            });
          }
        }
        state._navRafId = requestAnimationFrame(navSmoothFrame);
      }
      state._navRafId = requestAnimationFrame(navSmoothFrame);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var lng = pos.coords.longitude, lat = pos.coords.latitude;
          var proj = Chargers.projectOntoRoute && coords && Chargers.projectOntoRoute(coords, lng, lat);
          var ROUTE_SNAP_MARGIN_KM_INIT = 0.004;
          if (proj && (proj.distanceFromRouteKm <= ROUTE_SNAP_MARGIN_KM_INIT || state.lastNavGpsPositionKm == null)) {
            state.lastNavGpsPositionKm = proj.distanceAlongKm;
            state.lastNavGpsTime = Date.now();
            if (state.navDisplayKm == null) state.navDisplayKm = proj.distanceAlongKm;
          }
        },
        function () {},
        { enableHighAccuracy: true, maximumAge: 0 }
      );
      var lastReroute = 0;
      var lastNavUpdateTime = null;
      var lastNavDistTraveledKm = 0;
      var REROUTE_THRESHOLD_KM = 0.01;
      var REROUTE_COOLDOWN_MS = 8000;
      state.watchId = navigator.geolocation.watchPosition(
        function (pos) {
          var lng = pos.coords.longitude;
          var lat = pos.coords.latitude;
          if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat) || (lng === 0 && lat === 0) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
          var accuracy = pos.coords.accuracy;
          if (accuracy != null && accuracy > 150) return;
          var currentSpeedKmh = (pos.coords.speed != null && !isNaN(pos.coords.speed) && pos.coords.speed >= 0) ? Math.round(pos.coords.speed * 3.6) : null;
          state.currentSpeedKmh = currentSpeedKmh != null ? currentSpeedKmh : (state.currentSpeedKmh || 0);
          updateDriverBehaviorFromSpeed(state.currentSpeedKmh);
          var routeCoords = (state.route && state.route.coordinates && state.route.coordinates.length >= 2)
            ? state.route.coordinates
            : (state.route && state.route.geometry && state.route.geometry.coordinates && state.route.geometry.coordinates.length >= 2)
              ? state.route.geometry.coordinates
              : null;
          if (!state.route || !routeCoords) return;
          var projected = Chargers.projectOntoRoute && Chargers.projectOntoRoute(routeCoords, lng, lat);
          var ROUTE_SNAP_MARGIN_KM = 0.05;
          if (!projected || projected.distanceFromRouteKm > ROUTE_SNAP_MARGIN_KM) return;
          var newKm = projected.distanceAlongKm;
          var nowMs = Date.now();
          if (state._navLastGoodGpsKm != null && state._navLastGoodGpsTime != null) {
            var dtSec = (nowMs - state._navLastGoodGpsTime) / 1000;
            if (dtSec < 0.3) return;
            var jump = newKm - state._navLastGoodGpsKm;
            var maxSpd = Math.max(state.currentSpeedKmh || 0, state.maxSpeedKmh || 120, 60);
            var maxForwardKm = (maxSpd / 3600) * dtSec * 3;
            var maxBackwardKm = 0.15;
            if (jump > maxForwardKm) return;
            if (jump < -maxBackwardKm) return;
          }
          state._navLastGoodGpsKm = newKm;
          state._navLastGoodGpsTime = nowMs;
          state.lastNavGpsPositionKm = newKm;
          state.lastNavGpsTime = nowMs;
          if (state.navDisplayKm == null) state.navDisplayKm = newKm;
          updateSpeedSign(pos.coords.speed, state.maxSpeedKmh);
          var distTraveledM = (projected ? projected.distanceAlongKm : Chargers.distanceAlongRouteToPointKm(routeCoords, lng, lat)) * 1000;
          var carLng = projected ? projected.lng : lng, carLat = projected ? projected.lat : lat;
          var seg = state.route && state.route.coordinates && MapModule.getSegmentIndexFromRoute ? MapModule.getSegmentIndexFromRoute(state.route.coordinates, carLng, carLat) : 0;
          var banner = (MapModule.getBannerInstruction && state.route && state.route.maneuvers) ? MapModule.getBannerInstruction(state.route, seg, distTraveledM) : null;
          var t = banner && (banner.type || '').toLowerCase().replace(/_/g, ' ');
          var mod = banner && (banner.modifier || '').toLowerCase().replace(/_/g, ' ');
          var isStraightStep = t === 'depart' || (t === 'continue' && (mod === 'straight' || !mod));
          if (banner && isStraightStep && MapModule.getUpcomingTurnBanner) {
            var upcoming = MapModule.getUpcomingTurnBanner(state.route, seg, distTraveledM);
            if (upcoming && upcoming.distanceRemainingM >= 50 && upcoming.distanceRemainingM <= HINT_SHOW_UPCOMING_TURN_AHEAD_M) banner = upcoming;
          }
          var instr = MapModule.getNextTurnInstruction ? MapModule.getNextTurnInstruction(routeCoords, seg) : 'Keep straight';
          if (banner) banner = correctBannerFromGeometry(banner, instr);
          var nextPt = routeCoords[seg + 1];
          var distM = nextPt ? Math.round(Chargers.haversineKm(carLat, carLng, nextPt[1], nextPt[0]) * 1000) : 0;
          var nextM = MapModule.getUpcomingManeuvers ? MapModule.getUpcomingManeuvers(state.route, seg, 1)[0] : null;
          var nextStr = '';
          if (nextM && state.route.cumulativeStepDistanceM && state.route.stepIndexForSegment) {
            var stepIdx = state.route.stepIndexForSegment[seg];
            var nextStepStartM = state.route.cumulativeStepDistanceM[stepIdx + 1];
            var dRem = nextStepStartM != null ? Math.max(0, nextStepStartM - distTraveledM) : null;
            nextStr = (nextM.primaryText || 'Continue') + (dRem != null && dRem > 0 ? ' in ' + (dRem >= 1000 ? (dRem / 1000).toFixed(1) + ' km' : Math.round(dRem) + ' m') : '');
          }
          updateNavInstructionBox(banner ? { mainText: banner.primaryText || instr, streetText: [banner.secondaryText, banner.subText].filter(Boolean).join(' · ') || '', distanceRemainingM: banner.distanceRemainingM != null ? banner.distanceRemainingM : distM, type: banner.type, modifier: banner.modifier, nextText: nextStr, segmentIndex: seg } : { mainText: instr, distanceRemainingM: distM, nextText: nextStr, segmentIndex: seg });
          var dist = Chargers.distanceFromRouteKm(routeCoords, lng, lat);
          if (dist > REROUTE_THRESHOLD_KM && Date.now() - lastReroute > REROUTE_COOLDOWN_MS && state.endCoords && state.endCoords.length >= 2) {
            lastReroute = Date.now();
            var distTraveledKmR = Chargers.distanceAlongRouteToPointKm(routeCoords, lng, lat);
            var wpWithDistR = (state.waypoints || []).map(function (w) {
              var d = Chargers.distanceAlongRouteToPointKm(routeCoords, w.lng, w.lat);
              return { distKm: d, lng: w.lng, lat: w.lat };
            }).sort(function (a, b) { return a.distKm - b.distKm; });
            var waypointsAhead = wpWithDistR.filter(function (w) { return w.distKm > distTraveledKmR + 0.05; });
            var waypointCoords = waypointsAhead.map(function (w) { return [w.lng, w.lat]; });
            var coords = [[lng, lat]].concat(waypointCoords, [state.endCoords]);
            Routing.getRoute(coords).then(function (newRoute) {
              if (!newRoute) return;
              lastNavDistTraveledKm = 0;
              lastNavUpdateTime = Date.now();
              state.route = newRoute;
              state.startCoords = [lng, lat];
              MapModule.removeRouteLayer('ev-trip-route');
              Routing.drawRoute(MapModule, newRoute);
              var br = MapModule.getBearingFromRoute ? MapModule.getBearingFromRoute(newRoute.coordinates, lng, lat) : null;
              var seg = MapModule.getSegmentIndexFromRoute ? MapModule.getSegmentIndexFromRoute(newRoute.coordinates, lng, lat) : 0;
              var turnOff = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(newRoute.coordinates, seg) : 0;
              if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(lng, lat, br, turnOff);
              MapModule.setEndMarker(state.endCoords);
              MapModule.setChargeStopMarkers(state.waypoints || []);
              Data.ready.then(function (_ref) {
                var chargerDatabase = _ref.chargerDatabase;
                var chargers = (chargerDatabase && chargerDatabase.chargers) || [];
                state.chargersNearRoute = Chargers.chargersNearRoute(chargers, newRoute.coordinates, C && C.routing && C.routing.chargerSearchRadiusKm ? C.routing.chargerSearchRadiusKm : 10);
                MapModule.addChargerMarkers(state.chargersNearRoute, onChargerPinClick);
                UI.renderChargerList('chargerList', state.chargersNearRoute, state.currentLang);
              });
              applyTripToUI();
              var bar = document.getElementById('energyProgressWrap');
              if (bar && window.EVTripPlannerEnergyBar) {
                var tripOpts = buildTripOptions();
                var waypointsWithDist = (state.waypoints && state.waypoints.length && newRoute.coordinates && newRoute.distanceKm) ? state.waypoints.map(function (wp) {
                  var d = Chargers.distanceAlongRouteToPointKm(newRoute.coordinates, wp.lng, wp.lat);
                  return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name, lng: wp.lng, lat: wp.lat };
                }).sort(function (a, b) { return a.distKm - b.distKm; }) : [];
                var endBattery = state.vehicle ? (waypointsWithDist.length ? Trip.batteryAtEndWithWaypoints(state.vehicle, state.startBattery, newRoute.distanceKm, waypointsWithDist, tripOpts) : Trip.batteryAtEnd(state.vehicle, state.startBattery, newRoute.distanceKm, tripOpts)) : 20;
                var zeroPct = state.vehicle ? Trip.zeroPointProgress(state.vehicle, state.startBattery, newRoute.distanceKm, waypointsWithDist, tripOpts) : 100;
                var prevB = state.startBattery;
                var prevD = 0;
                var cs = waypointsWithDist.map(function (w) {
                  var progress = newRoute.distanceKm > 0 ? Math.max(0, Math.min(1, w.distKm / newRoute.distanceKm)) : 0;
                  var arrPct = state.vehicle ? Math.round(Trip.batteryAtEnd(state.vehicle, prevB, w.distKm - prevD, tripOpts)) : 20;
                  arrPct = Math.max(0, Math.min(100, arrPct));
                  var chargeTo = w.chargeTo != null ? w.chargeTo : 100;
                  var waitMin = state.vehicle ? Trip.chargingTimeMin(state.vehicle, arrPct, chargeTo, 50) : 0;
                  prevB = chargeTo;
                  prevD = w.distKm;
                  return { progress: progress, name: w.name || 'Charging Station', waitingTimeMin: waitMin, lng: w.lng, lat: w.lat };
                });
                window.EVTripPlannerEnergyBar.updateBar(bar, { currentBatteryPercent: state.startBattery, predictedEndPercent: Math.round(endBattery), tripProgress: 0, chargeStops: cs, zeroPointProgress: zeroPct, routeDistanceKm: newRoute.distanceKm });
              }
            }).catch(function (err) {
              lastReroute = 0;
              if (typeof console !== 'undefined' && console.warn) console.warn('Reroute request failed', err);
            });
          }
        },
        function () {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });
    if (stopRouteBtn) stopRouteBtn.addEventListener('click', doStopNavigation);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.navigationActive) {
        state._navLastGoodGpsTime = null;
        state._navLastGoodGpsKm = null;
      }
    });

    var mapRecenterBtn = document.getElementById('mapRecenterBtn');
    if (mapRecenterBtn) mapRecenterBtn.addEventListener('click', function () {
      if (!state.navigationActive || !MapModule.recenterOnCar) return;
      MapModule.recenterOnCar(state.currentSpeedKmh != null ? state.currentSpeedKmh : 0);
    });
    document.getElementById('addStopBtn')?.addEventListener('click', () => {
      const list = document.getElementById('stopsList');
      if (!list) return;
      const row = document.createElement('div');
      row.className = 'field-row add-stop-row';
      row.innerHTML = '<input type="text" placeholder="Add stop or charger" class="route-input" data-stop><button type="button" class="pin-btn" title="Pin on map">📍</button><button type="button" class="pin-btn remove-stop-btn" title="Remove stop">✕</button>';
      list.appendChild(row);
      row.querySelector('.remove-stop-btn')?.addEventListener('click', () => {
        row.remove();
        updateInfoRouteStatus();
      });
    });
  }

  function showMapSection(show) {
    var el = document.getElementById('mapSection');
    if (!el) return;
    if (show) {
      el.classList.remove('map-section-hidden');
      var mapEl = MapModule.getMap && MapModule.getMap();
      if (mapEl && mapEl.resize) {
        setTimeout(function () { mapEl.resize(); }, 50);
        setTimeout(function () { mapEl.resize(); }, 200);
      }
    } else {
      el.classList.add('map-section-hidden');
    }
  }

  function doStopNavigation() {
    state.navigationActive = false;
    state.currentSpeedKmh = null;
    state.navPositionAlongRouteKm = null;
    state.lastNavGpsPositionKm = null;
    state.navDisplayKm = null;
    state.smoothedNavBatteryPct = null;
    state._lastNavDisplayKm = null;
    state._lastNavDisplayKmTime = null;
    state._navLastGoodGpsKm = null;
    state._navLastGoodGpsTime = null;
    if (state._navRafId) { cancelAnimationFrame(state._navRafId); state._navRafId = null; }
    if (state.navSmoothIntervalId) { clearInterval(state.navSmoothIntervalId); state.navSmoothIntervalId = null; }
    if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
    if (state._wakeLock) { try { state._wakeLock.release(); } catch (e) {} state._wakeLock = null; }
    if (MapModule.exitNavigationMode) MapModule.exitNavigationMode();
    if (MapModule.clearNavigationCar) MapModule.clearNavigationCar();
    updateNavInstructionBox({ hide: true });
    updateSpeedSign(null, null);
    setNavLayoutExpanded(false);
    reapplyRouteAndMarkers();
    updateNavButtons();
  }

  function setNavLayoutExpanded(expanded) {
    var row = document.querySelector('.map-row');
    if (row) {
      if (expanded) row.classList.add('nav-layout-expanded');
      else row.classList.remove('nav-layout-expanded');
      var mapEl = MapModule.getMap && MapModule.getMap();
      if (mapEl && mapEl.resize) {
        setTimeout(function () { mapEl.resize(); }, 100);
        setTimeout(function () { mapEl.resize(); }, 350);
      }
    }
    var stopBtn = document.getElementById('stopRouteBtn');
    var startBtn = document.getElementById('startNavBtn');
    var headerStopBtn = document.getElementById('btnStopNav');
    if (stopBtn) stopBtn.style.display = expanded ? 'inline-block' : 'none';
    if (headerStopBtn) headerStopBtn.style.display = expanded ? 'inline-block' : 'none';
    if (startBtn && !expanded) startBtn.style.display = (state.route && !state.navigationActive) ? 'inline-block' : 'none';
  }

  function applySelectedRoute(route) {
    if (!route) return;
    state.route = route;
    showMapSection(true);
    MapModule.removeRouteLayer('ev-trip-route');
    Routing.drawRoute(MapModule, route);
    MapModule.fitBounds(route.coordinates, 0.25);
    var mapEl = MapModule.getMap && MapModule.getMap();
    if (mapEl && mapEl.resize) setTimeout(function () { mapEl.resize(); MapModule.fitBounds(route.coordinates, 0.25); }, 150);
    Data.ready.then(({ chargerDatabase }) => {
      const chargers = chargerDatabase.chargers || [];
      state.chargersNearRoute = Chargers.chargersNearRoute(chargers, route.coordinates, C?.routing?.chargerSearchRadiusKm ?? 10);
      MapModule.addChargerMarkers(state.chargersNearRoute, onChargerPinClick);
      UI.renderChargerList('chargerList', state.chargersNearRoute, state.currentLang);
    });
    applyTripToUI();
    if (state.endCoords && state.endCoords.length >= 2) {
      fetchWeatherForPosition(state.endCoords[1], state.endCoords[0]).then(function () { applyTripToUI(); });
    }
    var startNavBtn = document.getElementById('startNavBtn');
    if (startNavBtn) startNavBtn.style.display = 'inline-block';
    var stopRouteBtn = document.getElementById('stopRouteBtn');
    if (stopRouteBtn && !state.navigationActive) stopRouteBtn.style.display = 'none';
  }

  function evRemainingPercent(route) {
    if (!state.vehicle || !route) return null;
    var opts = buildTripOptions();
    opts = Object.assign({}, opts, { routeDistanceKm: route.distanceKm, averageSpeedKmh: route.distanceKm > 0 && route.durationMin > 0 ? route.distanceKm / (route.durationMin / 60) : null });
    return Math.round(Trip.batteryAtEnd(state.vehicle, state.startBattery, route.distanceKm, opts));
  }

  function showRouteSelectModal(routes) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('routeSelectOverlay');
      const listEl = document.getElementById('routeSelectList');
      const okBtn = document.getElementById('routeSelectOk');
      const cancelBtn = document.getElementById('routeSelectCancel');
      if (!overlay || !listEl) { resolve(null); return; }
      showMapSection(true);
      listEl.innerHTML = '';
      var selectedIdx = 0;
      routes.forEach((r, i) => {
        var evPct = evRemainingPercent(r);
        var evText = evPct != null ? evPct + '% battery' : '—';
        var distText = Math.round(r.distanceKm) + ' km';
        var item = document.createElement('div');
        item.className = 'route-select-item' + (i === 0 ? ' selected' : '');
        item.dataset.index = String(i);
        item.innerHTML = '<span class="route-dist">' + distText + '</span><span class="route-ev">EV remaining: ' + evText + '</span>';
        item.addEventListener('click', function () {
          listEl.querySelectorAll('.route-select-item').forEach(function (el) { el.classList.remove('selected'); });
          item.classList.add('selected');
          selectedIdx = i;
          Routing.drawRoutePreview(MapModule, r);
        });
        listEl.appendChild(item);
      });
      var done = function (idx) {
        MapModule.stopRoutePreview && MapModule.stopRoutePreview();
        overlay.classList.remove('show');
        resolve(idx != null ? routes[idx] : null);
      };
      okBtn.onclick = function () { done(selectedIdx); };
      cancelBtn.onclick = function () { done(null); };
      Routing.drawRoutePreview(MapModule, routes[0]);
      overlay.classList.add('show');
    });
  }

  function onChargeStopRemoveClick(lng, lat) {
    UI.confirm('Do you want to remove this charging stop?', { okLabel: 'Yes', cancelLabel: 'No', variant: 'remove' }).then(function (ok) {
      if (!ok) return;
      state.waypoints = (state.waypoints || []).filter(function (w) {
        return !(Math.abs(w.lng - lng) < 1e-6 && Math.abs(w.lat - lat) < 1e-6);
      });
      MapModule.setChargeStopMarkers(state.waypoints || []);
      updateRouteFromCoords();
    });
  }

  function updateRouteFromCoords() {
    if (!state.startCoords || !state.endCoords) return;
    MapModule.setStartMarker(state.startCoords);
    MapModule.setEndMarker(state.endCoords);
    const coords = [state.startCoords, ...state.waypoints.map((w) => [w.lng, w.lat]), state.endCoords].filter(Boolean);
    var useAlternatives = state.waypoints.length === 0;
    Routing.getRoutes(coords, useAlternatives).then((routes) => {
      if (!routes || routes.length === 0) return;
      if (routes.length === 1) {
        applySelectedRoute(routes[0]);
        return;
      }
      showRouteSelectModal(routes).then(function (route) {
        if (route) applySelectedRoute(route);
      });
    });
  }

  function setupBottomControls() {
    const cancelBtn = document.getElementById('btnCancelTrip');
    const fullscreenBtn = document.getElementById('btnFullscreen');
    const replanBtn = document.getElementById('btnReplan');
    const stopNavBtn = document.getElementById('btnStopNav');

    if (stopNavBtn) stopNavBtn.addEventListener('click', doStopNavigation);

    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      UI.confirm('Cancel current trip?').then((ok) => {
        if (ok) {
          doStopNavigation();
          applyTripToUI();
        }
      });
    });
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', function () {
      if (!document.fullscreenElement && !document.webkitFullscreenElement && !document.msFullscreenElement) {
        var el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        else if (el.msRequestFullscreen) el.msRequestFullscreen();
        fullscreenBtn.textContent = 'Exit full screen';
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.msExitFullscreen) document.msExitFullscreen();
        fullscreenBtn.textContent = 'Full screen';
      }
    });
    document.addEventListener('fullscreenchange', function () {
      if (fullscreenBtn && !document.fullscreenElement) fullscreenBtn.textContent = 'Full screen';
    });
    document.addEventListener('webkitfullscreenchange', function () {
      if (fullscreenBtn && !document.webkitFullscreenElement) fullscreenBtn.textContent = 'Full screen';
    });
    if (replanBtn) replanBtn.addEventListener('click', () => {
      UI.confirm('Re-plan trip (clear and start over)?').then((ok) => {
        if (ok) {
          state.startCoords = null;
          state.endCoords = null;
          state.waypoints = [];
          state.route = null;
          state.chargersNearRoute = [];
          state.navigationActive = false;
          if (state.navSmoothIntervalId) { clearInterval(state.navSmoothIntervalId); state.navSmoothIntervalId = null; }
          if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
          if (MapModule.exitNavigationMode) MapModule.exitNavigationMode();
          if (MapModule.clearNavigationCar) MapModule.clearNavigationCar();
          setNavLayoutExpanded(false);
          var s = document.getElementById('startLocation'); if (s) s.value = '';
          var d = document.getElementById('destination'); if (d) d.value = '';
          var sl = document.getElementById('stopsList'); if (sl) sl.innerHTML = '';
          MapModule.clearMarkers();
          MapModule.removeRouteLayer('ev-trip-route');
          MapModule.addChargerMarkers([], onChargerPinClick);
          showMapSection(true);
          applyTripToUI();
          updateNavButtons();
        }
      });
    });

    var chargerAddSlider = document.getElementById('chargerAddPercent');
    var chargerAddVal = document.getElementById('chargerAddPercentVal');
    var chargerModalCostVal = document.getElementById('chargerModalCostVal');
    if (chargerAddSlider && chargerAddVal) {
      chargerAddSlider.addEventListener('input', function () {
        chargerAddVal.textContent = chargerAddSlider.value;
        updateChargerModalCost(chargerAddSlider, chargerModalCostVal);
      });
    }
    document.getElementById('chargerModalCancel')?.addEventListener('click', function () {
      document.getElementById('chargerModalOverlay').style.display = 'none';
      state.selectedChargerForStop = null;
    });
    document.getElementById('chargerModalOk')?.addEventListener('click', function () {
      var charger = state.selectedChargerForStop;
      var percent = parseInt(document.getElementById('chargerAddPercent').value, 10) || 80;
      document.getElementById('chargerModalOverlay').style.display = 'none';
      state.selectedChargerForStop = null;
      if (charger) {
        state.waypoints = state.waypoints || [];
        state.waypoints.push({ lat: charger.lat, lng: charger.lng, chargeTo: percent, name: charger.name });
        if (MapModule.setChargeStopMarkers) MapModule.setChargeStopMarkers(state.waypoints);
        updateInfoRouteStatus();
      }
    });
  }

  function reapplyRouteAndMarkers() {
    if (state.startCoords) MapModule.setStartMarker(state.startCoords);
    if (state.endCoords) MapModule.setEndMarker(state.endCoords);
    if (state.route && Routing && Routing.drawRoute) {
      MapModule.removeRouteLayer('ev-trip-route');
      Routing.drawRoute(MapModule, state.route);
    }
    if (state.waypoints && state.waypoints.length) MapModule.setChargeStopMarkers(state.waypoints);
    if (state.chargersNearRoute && state.chargersNearRoute.length) MapModule.addChargerMarkers(state.chargersNearRoute, onChargerPinClick);
  }

  function isDayTime() {
    var now = new Date();
    var hour = now.getHours();
    return hour >= 6 && hour < 18;
  }

  function setupThemeToggle() {
    var root = document.documentElement;
    var btn = document.getElementById('themeToggle');
    if (!root.classList.contains('theme-dark') && !root.classList.contains('theme-light')) {
      var isDark = !isDayTime();
      root.classList.add(isDark ? 'theme-dark' : 'theme-light');
      root.classList.remove(isDark ? 'theme-light' : 'theme-dark');
      if (btn) btn.textContent = isDark ? 'Map: Dark' : 'Map: Light';
    }
    var isDark = !root.classList.contains('theme-light');
    applyMapTheme(isDark);
    window.__evApplyMapTheme = applyMapTheme;
  }

  function applyMapTheme(isDark) {
    var mapboxConfig = window.EVTripPlannerConfig && window.EVTripPlannerConfig.mapbox;
    if (!mapboxConfig) return;
    var mapEl = document.getElementById('map');
    var mapInstance = (mapEl && mapEl._mapboxMap)
      || window.__evMapboxMap
      || (window.EVTripPlannerMap && typeof window.EVTripPlannerMap.getMap === 'function' && window.EVTripPlannerMap.getMap());
    if (!mapInstance || typeof mapInstance.setStyle !== 'function') return;
    if (window.EVTripPlannerMap && typeof window.EVTripPlannerMap._setMap === 'function') {
      window.EVTripPlannerMap._setMap(mapInstance);
    }
    var styleUrl = isDark
      ? (mapboxConfig.nightStyle || 'mapbox://styles/mapbox/dark-v11')
      : (mapboxConfig.dayStyle || 'mapbox://styles/mapbox/light-v11');
    function redrawRouteAndMarkers() {
      try {
        if (mapInstance.resize) mapInstance.resize();
        reapplyRouteAndMarkers();
      } catch (e) {}
    }
    mapInstance.once('style.load', function () {
      mapInstance.once('idle', redrawRouteAndMarkers);
      setTimeout(redrawRouteAndMarkers, 1200);
    });
    try {
      mapInstance.setStyle(styleUrl);
    } catch (e) {}
    setTimeout(redrawRouteAndMarkers, 1200);
  }

  var DEV_TUNING_DEFAULTS = {
    base_calibration_factor: 0.94,
    aerodynamic_speed_multiplier_90: 1.08,
    aerodynamic_speed_multiplier_110: 1.22,
    speed_curve_exponent: 1.65,
    efficient_multiplier: 0.92,
    normal_multiplier: 1.0,
    dynamic_multiplier: 1.08,
    aggressive_multiplier: 1.18,
    aggressive_driving_penalty: 1.18,
    city_efficiency_bonus: 0.95,
    stop_go_penalty: 1.12,
    highway_penalty_above_100: 1.15,
    live_adaptation_strength: 0.12,
    live_adaptation_min_samples: 2,
    arrival_soc_smoothing_factor: 0.18,
    speed_best_efficiency_kmh: 55,
    speed_highway_threshold_kmh: 90,
    speed_very_high_threshold_kmh: 110,
  };

  function setupDevTuningPanel() {
    var toggle = document.getElementById('devTuningToggle');
    var body = document.getElementById('devTuningBody');
    var grid = document.getElementById('devTuningGrid');
    var resetBtn = document.getElementById('devTuningReset');
    if (!toggle || !body || !grid) return;
    function render() {
      grid.innerHTML = '';
      var t = global.getEnergyModelTuning ? global.getEnergyModelTuning() : {};
      var keys = Object.keys(DEV_TUNING_DEFAULTS);
      keys.forEach(function (key) {
        var label = document.createElement('label');
        label.className = 'dev-tuning-label';
        label.textContent = key.replace(/_/g, ' ');
        var input = document.createElement('input');
        input.type = 'number';
        input.step = key.indexOf('factor') !== -1 || key.indexOf('multiplier') !== -1 || key.indexOf('penalty') !== -1 || key.indexOf('bonus') !== -1 ? 0.01 : 1;
        input.min = key.indexOf('factor') !== -1 || key.indexOf('multiplier') !== -1 || key.indexOf('penalty') !== -1 || key.indexOf('bonus') !== -1 ? 0 : (key.indexOf('speed_') === 0 ? 20 : 0);
        input.value = t[key] != null ? t[key] : '';
        input.dataset.key = key;
        input.addEventListener('change', function () {
          var k = this.dataset.key;
          var v = parseFloat(this.value);
          if (!isNaN(v) && global.setEnergyModelTuning) global.setEnergyModelTuning(k, v);
        });
        var row = document.createElement('div');
        row.className = 'dev-tuning-row';
        row.appendChild(label);
        row.appendChild(input);
        grid.appendChild(row);
      });
    }
    toggle.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (!open) render();
    });
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        var set = global.setEnergyModelTuning;
        if (set) Object.keys(DEV_TUNING_DEFAULTS).forEach(function (k) { set(k, DEV_TUNING_DEFAULTS[k]); });
        render();
      });
    }
  }

  function setupDemo() {
    var runBtn = document.getElementById('runDemoBtn');
    var stopBtn = document.getElementById('stopDemoBtn');
    var carSpeed = document.getElementById('demoCarSpeed');
    var carSpeedVal = document.getElementById('demoCarSpeedVal');
    var simSpeed = document.getElementById('demoSimSpeed');
    var simSpeedVal = document.getElementById('demoSimSpeedVal');
    if (carSpeed && carSpeedVal) carSpeed.addEventListener('input', function () { carSpeedVal.textContent = carSpeed.value; });
    if (simSpeed && simSpeedVal) simSpeed.addEventListener('input', function () { simSpeedVal.textContent = simSpeed.value + '×'; });

    var demoAnimationId = null;
    var demoStartTime = null;
    var demoPausedDuration = 0;
    var demoPauseStart = null;
    var demoStartBattery = 100;
      var demoRunning = false;
      var demoManualDeltaKm = 0;
      var demoManualOffsetM = 0;
    var demoPaused = false;

    function stopDemo() {
      if (demoAnimationId) cancelAnimationFrame(demoAnimationId);
      demoAnimationId = null;
      demoRunning = false;
      demoPaused = false;
      demoManualDeltaKm = 0;
      demoManualOffsetM = 0;
      var moveBtns = document.getElementById('demoMoveButtons');
      if (moveBtns) moveBtns.style.display = 'none';
      if (MapModule.removeDemoCar) MapModule.removeDemoCar();
      if (MapModule.exitNavigationMode && !state.navigationActive) MapModule.exitNavigationMode();
      updateSpeedSign(null, null);
      updateNavInstructionBox({ hide: true });
      if (runBtn) { runBtn.textContent = 'Run Demo'; runBtn.style.display = ''; }
      if (stopBtn) stopBtn.style.display = 'none';
      if (state.route && Routing && Routing.drawRoute) {
        MapModule.removeRouteLayer('ev-trip-route');
        Routing.drawRoute(MapModule, state.route);
      }
      applyTripToUI();
    }

    function getElapsedSec() {
      if (!demoStartTime) return 0;
      var paused = demoPausedDuration + (demoPaused ? (Date.now() - demoPauseStart) : 0);
      return (Date.now() - demoStartTime - paused) / 1000;
    }

    function runDemo() {
      if (!state.route || !state.route.coordinates || state.route.coordinates.length < 2) {
        alert('Plan a route first: enter start and destination, then click Plan Route.');
        return;
      }
      if (demoRunning && !demoPaused) {
        demoPaused = true;
        demoPauseStart = Date.now();
        if (runBtn) runBtn.textContent = 'Play';
        return;
      }
      if (demoPaused) {
        demoPaused = false;
        demoPausedDuration += Date.now() - demoPauseStart;
        if (runBtn) runBtn.textContent = 'Pause';
        return;
      }
      stopDemo();
      if (MapModule.clearNavigationCar) MapModule.clearNavigationCar();
      runBtn.style.display = '';
      stopBtn.style.display = 'block';
      if (runBtn) runBtn.textContent = 'Pause';
      demoRunning = true;
      demoPaused = false;
      demoManualDeltaKm = 0;
      demoManualOffsetM = 0;
      state.smoothedArrivalBatteryPct = null;
      var lastDemoReroute = 0;
      var demoRerouteInProgress = false;
      var REROUTE_THRESHOLD_KM_DEMO = 0.01;
      var REROUTE_COOLDOWN_MS_DEMO = 8000;
      var moveBtns = document.getElementById('demoMoveButtons');
      if (moveBtns) moveBtns.style.display = 'block';
      demoStartTime = Date.now();
      demoPausedDuration = 0;
      demoStartBattery = state.startBattery;
      var lastDemoTickTime = Date.now();
      var lastDemoInstructionTime = 0;
      var DEMO_INSTRUCTION_THROTTLE_MS = 500;
      var lastDemoGpsTime = Date.now();
      var demoGpsReportedKm = 0;
      var demoDistanceTraveledKm = 0;
      var lastDemoRouteTrimTime = 0;
      var demoCurrentCarSpeedKmh = parseInt(carSpeed && carSpeed.value ? carSpeed.value : 20, 10) || 20;
      var demoCurrentSimMult = parseInt(simSpeed && simSpeed.value ? simSpeed.value : 1, 10) || 1;
      var DEMO_SPEED_SMOOTH = 0.03;
      var coords = state.route.coordinates;
      if (coords && coords.length >= 2 && MapModule.enterNavigationMode) MapModule.enterNavigationMode();
      var mapInstance = MapModule.getMap && MapModule.getMap();
      if (mapInstance && mapInstance.resize) mapInstance.resize();
      if (coords && coords.length >= 2 && MapModule.flyToCar) {
        var bearing = MapModule.bearingBetween ? MapModule.bearingBetween(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) : null;
        MapModule.flyToCar(coords[0][0], coords[0][1], { bearing: bearing, duration: 800 });
        var turnOff0 = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(coords, 0) : 0;
        if (MapModule.setDemoCarPosition) MapModule.setDemoCarPosition(coords[0][0], coords[0][1], bearing, turnOff0);
      }
      var v = state.vehicle;

      function offsetLatLngByMeters(lng, lat, bearingDeg, offsetMeters) {
        if (!offsetMeters) return [lng, lat];
        var rad = Math.PI / 180;
        var br = (bearingDeg != null ? bearingDeg : 0) * rad;
        var dLng = (offsetMeters / 1000) * Math.sin(br + Math.PI / 2) / (111.32 * Math.cos(lat * rad));
        var dLat = (offsetMeters / 1000) * Math.cos(br + Math.PI / 2) / 110.54;
        return [lng + dLng, lat + dLat];
      }
      function tick() {
        if (!demoRunning) return;
        var now = Date.now();
        if (demoPaused) {
          lastDemoTickTime = now;
          demoAnimationId = requestAnimationFrame(tick);
          return;
        }
        var coords = state.route && state.route.coordinates;
        var totalDist = state.route && state.route.distanceKm;
        if (!coords || !coords.length) {
          demoAnimationId = requestAnimationFrame(tick);
          return;
        }
        if (totalDist == null || totalDist <= 0) {
          totalDist = 0;
          for (var i = 1; i < coords.length; i++) totalDist += Chargers.haversineKm(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
        }
        if (totalDist <= 0) {
          demoAnimationId = requestAnimationFrame(tick);
          return;
        }
        var deltaT = lastDemoTickTime != null ? (now - lastDemoTickTime) / 1000 : 0;
        lastDemoTickTime = now;
        var targetCarSpeedKmh = parseInt(carSpeed && carSpeed.value ? carSpeed.value : 20, 10) || 20;
        var targetSimMult = parseInt(simSpeed && simSpeed.value ? simSpeed.value : 1, 10) || 1;
        demoCurrentCarSpeedKmh += (targetCarSpeedKmh - demoCurrentCarSpeedKmh) * DEMO_SPEED_SMOOTH;
        demoCurrentSimMult += (targetSimMult - demoCurrentSimMult) * DEMO_SPEED_SMOOTH;
        demoDistanceTraveledKm += (demoCurrentCarSpeedKmh / 3600) * deltaT * demoCurrentSimMult;
        var effectiveKm = Math.max(0, Math.min(totalDist, demoDistanceTraveledKm + demoManualDeltaKm));
        if (effectiveKm >= totalDist) {
          stopDemo();
          applyTripToUI();
          return;
        }
        var positionKm = effectiveKm;
        var routePoint = Chargers.getPointAlongRoute && Chargers.getPointAlongRoute(coords, positionKm);
        var lng = routePoint && routePoint.length >= 2 ? routePoint[0] : coords[0][0];
        var lat = routePoint && routePoint.length >= 2 ? routePoint[1] : coords[0][1];
        var bearing = null;
        if (positionKm > 0 && positionKm < totalDist && Chargers.getPointAlongRoute) {
          var nextKm = Math.min(totalDist, positionKm + 0.001);
          var nextPt = Chargers.getPointAlongRoute(coords, nextKm);
          if (nextPt && nextPt.length >= 2 && MapModule.bearingBetween) bearing = MapModule.bearingBetween(lng, lat, nextPt[0], nextPt[1]);
        }
        if (bearing == null && coords.length >= 2 && MapModule.bearingBetween) bearing = MapModule.bearingBetween(coords[0][0], coords[0][1], coords[1][0], coords[1][1]);
        var offset = offsetLatLngByMeters(lng, lat, bearing, demoManualOffsetM);
        lng = offset[0]; lat = offset[1];
        var seg = 0;
        var d = 0;
        for (var j = 1; j < coords.length; j++) {
          var segLen = Chargers.haversineKm(coords[j-1][1], coords[j-1][0], coords[j][1], coords[j][0]);
          if (d + segLen >= positionKm) {
            seg = j - 1;
            break;
          }
          d += segLen;
        }
        seg = Math.min(seg, coords.length - 2);
        var offRouteKm = Chargers.distanceFromRouteKm(coords, lng, lat);
        if (offRouteKm > REROUTE_THRESHOLD_KM_DEMO && !demoRerouteInProgress && Date.now() - lastDemoReroute > REROUTE_COOLDOWN_MS_DEMO && state.endCoords && state.endCoords.length >= 2) {
          demoRerouteInProgress = true;
          lastDemoReroute = Date.now();
          var distTraveledR = Chargers.distanceAlongRouteToPointKm(coords, lng, lat);
          var wpWithDistR = (state.waypoints || []).map(function (w) {
            var d = Chargers.distanceAlongRouteToPointKm(coords, w.lng, w.lat);
            return { distKm: d, lng: w.lng, lat: w.lat };
          }).sort(function (a, b) { return a.distKm - b.distKm; });
          var waypointsAhead = wpWithDistR.filter(function (w) { return w.distKm > distTraveledR + 0.05; });
          var waypointCoords = waypointsAhead.map(function (w) { return [w.lng, w.lat]; });
          var rerouteCoords = [[lng, lat]].concat(waypointCoords, [state.endCoords]);
          Routing.getRoute(rerouteCoords).then(function (newRoute) {
            if (!newRoute || !demoRunning) { demoRerouteInProgress = false; return; }
            state.route = newRoute;
            MapModule.removeRouteLayer('ev-trip-route');
            Routing.drawRoute(MapModule, newRoute);
            MapModule.setChargeStopMarkers(state.waypoints || []);
            demoStartTime = Date.now();
            demoPausedDuration = 0;
            demoManualDeltaKm = 0;
            demoManualOffsetM = 0;
            demoDistanceTraveledKm = 0;
            lastDemoGpsTime = Date.now();
            demoGpsReportedKm = 0;
            lastDemoTickTime = Date.now();
            Data.ready.then(function (_ref) {
              var chargerDatabase = _ref.chargerDatabase;
              var chargers = (chargerDatabase && chargerDatabase.chargers) || [];
              state.chargersNearRoute = Chargers.chargersNearRoute(chargers, newRoute.coordinates, C && C.routing && C.routing.chargerSearchRadiusKm ? C.routing.chargerSearchRadiusKm : 10);
              MapModule.addChargerMarkers(state.chargersNearRoute, onChargerPinClick);
              UI.renderChargerList('chargerList', state.chargersNearRoute, state.currentLang);
            });
            applyTripToUI();
            demoRerouteInProgress = false;
          }).catch(function () { demoRerouteInProgress = false; });
        }
        var turnOffset = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(coords, seg) : 0;
        if (MapModule.setDemoCarPosition) MapModule.setDemoCarPosition(lng, lat, bearing, turnOffset);
        if (positionKm > 0.01 && MapModule.trimRouteToRemaining && now - lastDemoRouteTrimTime >= 300) {
          lastDemoRouteTrimTime = now;
          MapModule.trimRouteToRemaining(coords, positionKm);
        }
        var demoDistTraveledM = positionKm * 1000;
        var banner = (MapModule.getBannerInstruction && state.route && state.route.maneuvers) ? MapModule.getBannerInstruction(state.route, seg, demoDistTraveledM) : null;
        var t = banner && (banner.type || '').toLowerCase().replace(/_/g, ' ');
        var mod = banner && (banner.modifier || '').toLowerCase().replace(/_/g, ' ');
        var isStraightStep = t === 'depart' || (t === 'continue' && (mod === 'straight' || !mod));
        if (banner && isStraightStep && MapModule.getUpcomingTurnBanner) {
          var upcoming = MapModule.getUpcomingTurnBanner(state.route, seg, demoDistTraveledM);
          if (upcoming && upcoming.distanceRemainingM >= 50 && upcoming.distanceRemainingM <= HINT_SHOW_UPCOMING_TURN_AHEAD_M) banner = upcoming;
        }
        var instr = MapModule.getNextTurnInstruction ? MapModule.getNextTurnInstruction(coords, seg) : 'Keep straight';
        if (banner) banner = correctBannerFromGeometry(banner, instr);
        var nextPt = coords[seg + 1];
        var distM = nextPt ? Math.round(Chargers.haversineKm(lat, lng, nextPt[1], nextPt[0]) * 1000) : 0;
        var nextMDemo = MapModule.getUpcomingManeuvers && state.route ? MapModule.getUpcomingManeuvers(state.route, seg, 1)[0] : null;
        var nextStrDemo = '';
        if (nextMDemo && state.route.cumulativeStepDistanceM && state.route.stepIndexForSegment) {
          var stepIdxD = state.route.stepIndexForSegment[seg];
          var nextStepStartMD = state.route.cumulativeStepDistanceM[stepIdxD + 1];
          var dRemD = nextStepStartMD != null ? Math.max(0, nextStepStartMD - demoDistTraveledM) : null;
          nextStrDemo = (nextMDemo.primaryText || 'Continue') + (dRemD != null && dRemD > 0 ? ' in ' + (dRemD >= 1000 ? (dRemD / 1000).toFixed(1) + ' km' : Math.round(dRemD) + ' m') : '');
        }
        if (now - lastDemoInstructionTime >= DEMO_INSTRUCTION_THROTTLE_MS) {
          lastDemoInstructionTime = now;
          updateNavInstructionBox(banner ? { mainText: banner.primaryText || instr, streetText: [banner.secondaryText, banner.subText].filter(Boolean).join(' · ') || '', distanceRemainingM: banner.distanceRemainingM != null ? banner.distanceRemainingM : distM, type: banner.type, modifier: banner.modifier, nextText: nextStrDemo, segmentIndex: seg } : { mainText: instr, distanceRemainingM: distM, nextText: nextStrDemo, segmentIndex: seg });
        }
        if (MapModule.followCar) MapModule.followCar(lng, lat, bearing, true, demoCurrentCarSpeedKmh, {
          distToTurnM: banner && banner.distanceRemainingM != null ? banner.distanceRemainingM : distM,
          isTurnOrExit: banner ? isTurnOrExitFromBanner(banner) : !isContinueStraightInstruction(instr),
        });
        updateSpeedSign(demoCurrentCarSpeedKmh / 3.6, state.maxSpeedKmh);
        updateDriverBehaviorFromSpeed(demoCurrentCarSpeedKmh);
        var demoState = Object.assign({}, state, {
          maxSpeedKmh: demoCurrentCarSpeedKmh,
          actualSpeedKmh: demoCurrentCarSpeedKmh,
          useInstantSpeed: true,
          routeDistanceKm: totalDist,
          drivingStyleScore: state.driverBehaviorScore,
          liveConsumptionBias: state.liveConsumptionBias,
        });
        var consumptionKwhPerKm = v ? Trip.consumptionPerKm(v, demoState) : 0.2;
        var batteryUsedKwh = effectiveKm * consumptionKwhPerKm;
        var batteryPercent = Math.max(0, demoStartBattery - (batteryUsedKwh / (v ? v.battery_kwh : 60) * 100));
        state.startBattery = Math.round(batteryPercent);
        var remainingKm = totalDist - effectiveKm;
        var predictedEndPctRaw = v ? Trip.batteryAtEnd(v, state.startBattery, remainingKm, demoState) : 0;
        var predictedEndPct = smoothArrivalBattery(predictedEndPctRaw, window.ENERGY_MODEL_TUNING);
        var rangeKmDemo = v ? Trip.effectiveRangeKm(v, state.startBattery, demoState) : Math.round((batteryPercent / 100) * 300);
        var wpWithDist = [];
        var cs = [];
        if (state.route && state.route.coordinates && state.route.distanceKm && state.waypoints && state.waypoints.length) {
          wpWithDist = state.waypoints.map(function (wp) {
            var d = Chargers.distanceAlongRouteToPointKm(state.route.coordinates, wp.lng, wp.lat);
            return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name };
          }).sort(function (a, b) { return a.distKm - b.distKm; });
          cs = wpWithDist.map(function (w) {
            return { progress: Math.max(0, Math.min(1, w.distKm / state.route.distanceKm)), name: w.name };
          });
        }
        var nextStopKm = wpWithDist.length ? Math.max(0, wpWithDist[0].distKm - effectiveKm) : null;
        UI.updateHeaderStats(state.startBattery, rangeKmDemo, 'FAST');
        UI.updateBatterySidebar(state.startBattery, rangeKmDemo);
        UI.updateBottomBar({
          expectedRangeKm: rangeKmDemo,
          nextStopKm: nextStopKm,
          nextStopEta: '—',
          chargingTimeStr: state.route && state.route.durationMin ? formatChargeTime(0) : '0M',
          arrivalStr: '—',
          weatherTempC: state.weather ? state.weather.temperature_2m : null,
          weatherLabel: state.weather ? Weather.weatherCodeToLabel(state.weather.weather_code) : null,
          weatherHumidity: state.weather && state.weather.relative_humidity_2m != null ? Math.round(state.weather.relative_humidity_2m) : null,
          weatherWind: state.weather && state.weather.wind_speed_10m != null ? Math.round(state.weather.wind_speed_10m) : null,
          endEstPercent: predictedEndPct,
        });
        var bar = document.getElementById('energyProgressWrap');
        if (bar && window.EVTripPlannerEnergyBar) {
          var zeroPct = v ? Trip.zeroPointProgress(v, state.startBattery, totalDist, wpWithDist, demoState) : 100;
          window.EVTripPlannerEnergyBar.updateBar(bar, { currentBatteryPercent: state.startBattery, predictedEndPercent: predictedEndPct, tripProgress: effectiveKm / totalDist, chargeStops: cs, zeroPointProgress: zeroPct, routeDistanceKm: totalDist });
        }
        demoAnimationId = requestAnimationFrame(tick);
      }
      demoAnimationId = requestAnimationFrame(tick);
    }

    if (runBtn) runBtn.addEventListener('click', runDemo);
    if (stopBtn) stopBtn.addEventListener('click', stopDemo);
    var demoMoveFwd = document.getElementById('demoMoveForward');
    var demoMoveBwd = document.getElementById('demoMoveBackward');
    var demoMoveLeft = document.getElementById('demoMoveLeft');
    var demoMoveRight = document.getElementById('demoMoveRight');
    if (demoMoveFwd) demoMoveFwd.addEventListener('click', function () { demoManualDeltaKm += 0.05; });
    if (demoMoveBwd) demoMoveBwd.addEventListener('click', function () { demoManualDeltaKm -= 0.05; });
    if (demoMoveLeft) demoMoveLeft.addEventListener('click', function () { demoManualOffsetM -= 20; });
    if (demoMoveRight) demoMoveRight.addEventListener('click', function () { demoManualOffsetM += 20; });
  }

  function init() {
    initModal();
    updateTipsContent();
    Data.ready.then(function () { }).catch(function () { });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function syncModalFromState() {
    var el;
    el = document.getElementById('modalStartBattery'); if (el) el.value = state.startBattery;
    el = document.getElementById('modalTargetBattery'); if (el) el.value = state.targetBattery;
    el = document.getElementById('modalCabinTemp'); if (el) el.value = state.cabinTempC;
    el = document.getElementById('modalPassengers'); if (el) el.value = state.passengers;
    el = document.getElementById('modalAcOff'); if (el) el.checked = !state.acOn;
    syncAcTogglePill();
    el = document.getElementById('modalLuggage'); if (el) el.value = state.luggageKg;
    el = document.getElementById('modalMaxSpeed'); if (el) el.value = state.maxSpeedKmh;
    el = document.getElementById('modalDrivingMode'); if (el) el.value = state.drivingMode;
  }

  function syncAcTogglePill() {
    var cb = document.getElementById('modalAcOff');
    var pill = document.getElementById('modalAcTogglePill');
    if (pill) pill.classList.toggle('ac-off', cb && cb.checked);
  }

  function updateModalPreview() {
    var el;
    var v = state.vehicle;
    var startBattery = parseInt((el = document.getElementById('modalStartBattery')) && el.value, 10) || 100;
    var cabinTempC = parseFloat((el = document.getElementById('modalCabinTemp')) && el.value) || 24;
    var passengers = parseInt((el = document.getElementById('modalPassengers')) && el.value, 10) || 1;
    var acOn = !((el = document.getElementById('modalAcOff')) && el.checked);
    var luggageKg = parseFloat((el = document.getElementById('modalLuggage')) && el.value) || 0;
    var maxSpeedKmh = parseInt((el = document.getElementById('modalMaxSpeed')) && el.value, 10) || 120;
    el = document.getElementById('modalDrivingMode');
    var drivingMode = (el && el.value) || 'standard';
    var ambientTempC = parseFloat((el = document.getElementById('modalAmbientTemp')) && el.value);
    if (ambientTempC == null || isNaN(ambientTempC)) ambientTempC = state.ambientTempC != null ? state.ambientTempC : 25;
    var opts = {
      startBattery: startBattery,
      cabinTempC: cabinTempC,
      passengers: passengers,
      acOn: acOn,
      luggageKg: luggageKg,
      maxSpeedKmh: maxSpeedKmh,
      drivingMode: drivingMode,
      ambientTempC: ambientTempC,
      windSpeedKmh: state.weather ? state.weather.wind_speed_10m : null,
      windDirectionDeg: state.weather ? state.weather.wind_direction_10m : null,
    };
    if (state.route && state.route.distanceKm) {
      opts.routeDistanceKm = state.route.distanceKm;
      if (state.route.durationMin > 0) opts.averageSpeedKmh = state.route.distanceKm / (state.route.durationMin / 60);
    }
    var rangeKm = v ? Trip.effectiveRangeKm(v, startBattery, opts) : 0;
    var endBattery = null;
    if (v && state.route && state.route.distanceKm) {
      var distKm = state.route.distanceKm;
      var stateWithRoute = opts;
      var waypointsWithDist = [];
      if (state.waypoints && state.waypoints.length && state.route.coordinates && state.route.distanceKm) {
        waypointsWithDist = state.waypoints.map(function (wp) {
          var d = Chargers.distanceAlongRouteToPointKm(state.route.coordinates, wp.lng, wp.lat);
          return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name };
        }).sort(function (a, b) { return a.distKm - b.distKm; });
      }
      endBattery = waypointsWithDist.length
        ? Trip.batteryAtEndWithWaypoints(v, startBattery, distKm, waypointsWithDist, stateWithRoute)
        : Trip.batteryAtEnd(v, startBattery, distKm, stateWithRoute);
    }
    var rangeEl = document.getElementById('modalPreviewRange');
    var endEl = document.getElementById('modalPreviewEndEst');
    if (rangeEl) rangeEl.textContent = rangeKm != null ? Math.round(rangeKm) + ' km' : '—';
    if (endEl) endEl.textContent = endBattery != null ? '~' + Math.round(endBattery) + '%' : '—';
    var bottomRange = document.getElementById('bottomExpectedRange');
    var bottomEnd = document.getElementById('bottomEndEst');
    var progressEndEst = document.getElementById('energyProgressEndEst');
    if (bottomRange) bottomRange.textContent = (rangeKm != null ? Math.round(rangeKm) : '—') + ' KM';
    if (bottomEnd) bottomEnd.textContent = endBattery != null ? '~' + Math.round(endBattery) + '%' : '—';
    if (progressEndEst) progressEndEst.textContent = endBattery != null ? 'END EST. ~' + Math.round(endBattery) + '%' : '—';
  }

  global.EVTripPlannerApp = { state, applyTripToUI, updateRouteFromCoords, doSaveAndStart, syncModalFromState, updateModalPreview };
})(window);
