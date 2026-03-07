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
      var stateWithRoute = tripOpts;
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
      estimatedArrivalPercent = Math.round(Trip.batteryAtEnd(state.vehicle, state.startBattery, distKm, state));
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
    }
    if (startNavBtn) startNavBtn.addEventListener('click', function () {
      if (!state.route || !state.endCoords) return;
      if (MapModule.removeDemoCar) MapModule.removeDemoCar();
      state.navigationActive = true;
      updateNavButtons();
      if (MapModule.enterNavigationMode) MapModule.enterNavigationMode();
      var coords = state.route.coordinates;
      if (coords && coords.length >= 2 && MapModule.flyToCar) {
        var bearing = MapModule.bearingBetween ? MapModule.bearingBetween(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) : null;
        MapModule.flyToCar(coords[0][0], coords[0][1], { bearing: bearing, duration: 1000 });
        var turnOff = MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(coords, 0) : 0;
        if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(coords[0][0], coords[0][1], bearing, turnOff);
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var lng = pos.coords.longitude, lat = pos.coords.latitude;
          var br = coords && coords.length >= 2 && MapModule.getBearingFromRoute ? MapModule.getBearingFromRoute(coords, lng, lat) : null;
          var seg = coords && MapModule.getSegmentIndexFromRoute ? MapModule.getSegmentIndexFromRoute(coords, lng, lat) : 0;
          var turnOff = coords && MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(coords, seg) : 0;
          if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(lng, lat, br, turnOff);
          if (MapModule.followCar) MapModule.followCar(lng, lat, br);
        },
        function () {},
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
      var lastReroute = 0;
      var REROUTE_THRESHOLD_KM = 0.01;
      var REROUTE_COOLDOWN_MS = 8000;
      state.watchId = navigator.geolocation.watchPosition(
        function (pos) {
          var lng = pos.coords.longitude;
          var lat = pos.coords.latitude;
          var currentSpeedKmh = (pos.coords.speed != null && !isNaN(pos.coords.speed)) ? Math.round(pos.coords.speed * 3.6) : null;
          state.currentSpeedKmh = currentSpeedKmh != null ? currentSpeedKmh : state.maxSpeedKmh;
          var br = state.route && state.route.coordinates && MapModule.getBearingFromRoute ? MapModule.getBearingFromRoute(state.route.coordinates, lng, lat) : null;
          var seg = state.route && state.route.coordinates && MapModule.getSegmentIndexFromRoute ? MapModule.getSegmentIndexFromRoute(state.route.coordinates, lng, lat) : 0;
          var turnOff = state.route && state.route.coordinates && MapModule.getTurnOffsetFromRoute ? MapModule.getTurnOffsetFromRoute(state.route.coordinates, seg) : 0;
          if (MapModule.setNavigationCarPosition) MapModule.setNavigationCarPosition(lng, lat, br, turnOff);
          if (MapModule.followCar) MapModule.followCar(lng, lat, br, undefined, state.currentSpeedKmh);
          updateSpeedSign(pos.coords.speed, state.maxSpeedKmh);
          var routeCoords = (state.route && state.route.coordinates && state.route.coordinates.length >= 2)
            ? state.route.coordinates
            : (state.route && state.route.geometry && state.route.geometry.coordinates && state.route.geometry.coordinates.length >= 2)
              ? state.route.geometry.coordinates
              : null;
          if (!state.route || !routeCoords) return;
          var v = state.vehicle;
          if (v) {
            var distTraveledKm = Chargers.distanceAlongRouteToPointKm(routeCoords, lng, lat);
            var navState = Object.assign({}, state, { maxSpeedKmh: state.currentSpeedKmh, useInstantSpeed: true, routeDistanceKm: state.route.distanceKm });
            var consumedKwh = Trip.tripEnergyKwh(v, distTraveledKm, navState);
            var currentBattery = Math.max(0, state.startBattery - (consumedKwh / v.battery_kwh * 100));
            var remainingKm = Math.max(0, state.route.distanceKm - distTraveledKm);
            var predictedEnd = Trip.batteryAtEnd(v, currentBattery, remainingKm, navState);
            var rangeKm = Trip.effectiveRangeKm(v, currentBattery, navState);
            state.startBattery = Math.round(currentBattery);
            UI.updateHeaderStats(state.startBattery, rangeKm, 'FAST');
            UI.updateBatterySidebar(state.startBattery, rangeKm);
            var wpWithDist = (state.waypoints || []).map(function (wp) {
              var d = Chargers.distanceAlongRouteToPointKm(routeCoords, wp.lng, wp.lat);
              return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name, lng: wp.lng, lat: wp.lat };
            }).sort(function (a, b) { return a.distKm - b.distKm; });
            var nextStopKm = wpWithDist.length ? Math.max(0, wpWithDist[0].distKm - distTraveledKm) : null;
            var zeroPct = Trip.zeroPointProgress(v, state.startBattery, state.route.distanceKm, wpWithDist, navState);
            UI.updateBottomBar({
              expectedRangeKm: rangeKm,
              nextStopKm: nextStopKm,
              endEstPercent: Math.round(predictedEnd),
            });
            var bar = document.getElementById('energyProgressWrap');
            if (bar && window.EVTripPlannerEnergyBar) {
              var prevB = state.startBattery;
              var prevD = 0;
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
                currentBatteryPercent: state.startBattery,
                predictedEndPercent: Math.round(predictedEnd),
                tripProgress: distTraveledKm / state.route.distanceKm,
                chargeStops: cs,
                zeroPointProgress: zeroPct,
                routeDistanceKm: state.route.distanceKm,
                onChargeStopClick: onChargeStopRemoveClick,
              });
            }
          }
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
                  return { distKm: d, chargeTo: wp.chargeTo != null ? wp.chargeTo : 100, name: wp.name };
                }).sort(function (a, b) { return a.distKm - b.distKm; }) : [];
                var endBattery = state.vehicle ? (waypointsWithDist.length ? Trip.batteryAtEndWithWaypoints(state.vehicle, state.startBattery, newRoute.distanceKm, waypointsWithDist, tripOpts) : Trip.batteryAtEnd(state.vehicle, state.startBattery, newRoute.distanceKm, tripOpts)) : 20;
                var zeroPct = state.vehicle ? Trip.zeroPointProgress(state.vehicle, state.startBattery, newRoute.distanceKm, waypointsWithDist, tripOpts) : 100;
                var cs = waypointsWithDist.map(function (w) {
                  return { progress: newRoute.distanceKm > 0 ? Math.max(0, Math.min(1, w.distKm / newRoute.distanceKm)) : 0, name: w.name || 'Charging Station' };
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
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );
    });
    if (stopRouteBtn) stopRouteBtn.addEventListener('click', function () {
      state.navigationActive = false;
      state.currentSpeedKmh = null;
      if (state.watchId != null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
      }
      if (MapModule.exitNavigationMode) MapModule.exitNavigationMode();
      updateSpeedSign(null, null);
      updateNavButtons();
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
    var opts = Object.assign({}, state, { routeDistanceKm: route.distanceKm });
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
    const restartBtn = document.getElementById('btnRestart');
    const refreshBtn = document.getElementById('btnRefresh');
    const fullscreenBtn = document.getElementById('btnFullscreen');
    const replanBtn = document.getElementById('btnReplan');

    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      UI.confirm('Cancel current trip?').then((ok) => {
        if (ok) {
          state.route = null; state.chargersNearRoute = []; state.navigationActive = false;
          if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
          if (MapModule.exitNavigationMode) MapModule.exitNavigationMode();
          updateSpeedSign(null, null);
          showMapSection(false);
          MapModule.clearMarkers(); MapModule.removeRouteLayer('ev-trip-route');
          MapModule.addChargerMarkers([], onChargerPinClick);
          applyTripToUI();
          var startNavBtn = document.getElementById('startNavBtn'); if (startNavBtn) startNavBtn.style.display = 'none';
          var stopRouteBtn = document.getElementById('stopRouteBtn'); if (stopRouteBtn) stopRouteBtn.style.display = 'none';
        }
      });
    });
    if (restartBtn) restartBtn.addEventListener('click', () => {
      UI.confirm('Restart trip from beginning?').then((ok) => { if (ok) applyTripToUI(); });
    });
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      applyTripToUI();
      if (state.startCoords && state.endCoords) updateRouteFromCoords();
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
          state.startCoords = null; state.endCoords = null; state.waypoints = []; state.route = null;
          state.navigationActive = false;
          if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
          if (MapModule.exitNavigationMode) MapModule.exitNavigationMode();
          showMapSection(false);
          var s = document.getElementById('startLocation'); if (s) s.value = '';
          var d = document.getElementById('destination'); if (d) d.value = '';
          var sl = document.getElementById('stopsList'); if (sl) sl.innerHTML = '';
          MapModule.clearMarkers(); MapModule.removeRouteLayer('ev-trip-route');
          MapModule.addChargerMarkers([], onChargerPinClick);
          applyTripToUI();
          var startNavBtn = document.getElementById('startNavBtn'); if (startNavBtn) startNavBtn.style.display = 'none';
          var stopRouteBtn = document.getElementById('stopRouteBtn'); if (stopRouteBtn) stopRouteBtn.style.display = 'none';
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
      if (runBtn) { runBtn.textContent = 'Run Demo'; runBtn.style.display = ''; }
      if (stopBtn) stopBtn.style.display = 'none';
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
      var lastDemoReroute = 0;
      var demoRerouteInProgress = false;
      var REROUTE_THRESHOLD_KM_DEMO = 0.01;
      var REROUTE_COOLDOWN_MS_DEMO = 8000;
      var moveBtns = document.getElementById('demoMoveButtons');
      if (moveBtns) moveBtns.style.display = 'block';
      demoStartTime = Date.now();
      demoPausedDuration = 0;
      demoStartBattery = state.startBattery;
      var coords = state.route.coordinates;
      if (coords && coords.length >= 2 && MapModule.enterNavigationMode) MapModule.enterNavigationMode();
      if (coords && coords.length >= 2 && MapModule.flyToCar) {
        var bearing = MapModule.bearingBetween ? MapModule.bearingBetween(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) : null;
        MapModule.flyToCar(coords[0][0], coords[0][1], { bearing: bearing, duration: 800 });
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
        if (demoPaused) { demoAnimationId = requestAnimationFrame(tick); return; }
        var coords = state.route && state.route.coordinates;
        var totalDist = state.route && state.route.distanceKm;
        if (!coords || !coords.length || totalDist == null || totalDist <= 0) {
          demoAnimationId = requestAnimationFrame(tick);
          return;
        }
        var carSpeedKmh = parseInt(carSpeed && carSpeed.value ? carSpeed.value : 20, 10) || 20;
        var simMult = parseInt(simSpeed && simSpeed.value ? simSpeed.value : 1, 10) || 1;
        var elapsedSec = getElapsedSec();
        var distanceTraveledKm = (carSpeedKmh / 3600) * elapsedSec * simMult;
        var effectiveKm = Math.max(0, Math.min(totalDist, distanceTraveledKm + demoManualDeltaKm));
        if (effectiveKm >= totalDist && distanceTraveledKm >= totalDist) {
          stopDemo();
          applyTripToUI();
          return;
        }
        var seg = 0;
        var d = 0;
        for (var j = 1; j < coords.length; j++) {
          var segLen = Chargers.haversineKm(coords[j-1][1], coords[j-1][0], coords[j][1], coords[j][0]);
          if (d + segLen >= effectiveKm) {
            seg = j - 1;
            break;
          }
          d += segLen;
        }
        var segLen = Chargers.haversineKm(coords[seg][1], coords[seg][0], coords[seg+1][1], coords[seg+1][0]) || 0.001;
        var t = (effectiveKm - d) / segLen;
        t = Math.max(0, Math.min(1, t));
        var lng = coords[seg][0] + t * (coords[seg+1][0] - coords[seg][0]);
        var lat = coords[seg][1] + t * (coords[seg+1][1] - coords[seg][1]);
        var bearing = seg + 1 < coords.length && MapModule.bearingBetween ? MapModule.bearingBetween(coords[seg][0], coords[seg][1], coords[seg + 1][0], coords[seg + 1][1]) : null;
        var offset = offsetLatLngByMeters(lng, lat, bearing, demoManualOffsetM);
        lng = offset[0]; lat = offset[1];
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
        if (window.EVTripPlannerMap && window.EVTripPlannerMap.setDemoCarPosition) window.EVTripPlannerMap.setDemoCarPosition(lng, lat, bearing, turnOffset);
        if (MapModule.followCar) MapModule.followCar(lng, lat, bearing, true);
        updateSpeedSign(carSpeedKmh / 3.6, state.maxSpeedKmh);
        var demoState = Object.assign({}, state, { maxSpeedKmh: carSpeedKmh, useInstantSpeed: true, routeDistanceKm: totalDist });
        var consumptionKwhPerKm = v ? Trip.consumptionPerKm(v, demoState) : 0.2;
        var batteryUsedKwh = effectiveKm * consumptionKwhPerKm;
        var batteryPercent = Math.max(0, demoStartBattery - (batteryUsedKwh / (v ? v.battery_kwh : 60) * 100));
        state.startBattery = Math.round(batteryPercent);
        var remainingKm = totalDist - effectiveKm;
        var predictedEndPct = v ? Trip.batteryAtEnd(v, state.startBattery, remainingKm, demoState) : 0;
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
          endEstPercent: Math.round(predictedEndPct),
        });
        var bar = document.getElementById('energyProgressWrap');
        if (bar && window.EVTripPlannerEnergyBar) {
          var zeroPct = v ? Trip.zeroPointProgress(v, state.startBattery, totalDist, wpWithDist, demoState) : 100;
          window.EVTripPlannerEnergyBar.updateBar(bar, { currentBatteryPercent: state.startBattery, predictedEndPercent: Math.round(predictedEndPct), tripProgress: effectiveKm / totalDist, chargeStops: cs, zeroPointProgress: zeroPct, routeDistanceKm: totalDist });
        }
        demoAnimationId = requestAnimationFrame(tick);
      }
      tick();
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
