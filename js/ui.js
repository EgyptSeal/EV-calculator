/**
 * UI: modal, search dropdowns, panel updates, bottom bar, confirm dialog.
 */
(function (global) {
  const Weather = global.EVTripPlannerWeather;
  const Search = global.EVTripPlannerSearch;

  function showModal(visible) {
    const el = document.getElementById('startupModal');
    if (el) el.classList.toggle('hidden', !visible);
  }

  function renderVehicleCards(containerId, vehicles, selectedId, onSelect) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    (vehicles || []).forEach((v) => {
      const card = document.createElement('div');
      card.className = 'vehicle-card' + (v.id === selectedId ? ' selected' : '');
      const name = [v.brand, v.model, v.trim].filter(Boolean).join(' ');
      card.innerHTML =
        '<div class="v-img-wrap"><img src="' +
        (v.vehicle_image || 'assets/car-sedan.png') +
        '" alt="" onerror="this.style.display=\'none\'"></div>' +
        '<div class="v-name">' +
        name +
        '</div>' +
        '<div class="v-range">' +
        (v.epa_range_km ?? v.estimated_epa_range_km ?? v.official_range_value ?? '—') +
        ' km EPA</div>';
      card.addEventListener('click', () => onSelect && onSelect(v));
      container.appendChild(card);
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLon = ((lon2 - lon1) * Math.PI) / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function setupSearchInput(inputId, dropdownId, onSelect, getFromCoords, getExtraPlaces) {
    var input = document.getElementById(inputId);
    var dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    function renderResults(results, from) {
      dropdown.innerHTML = '';
      dropdown.classList.remove('show');
      if (!results || results.length === 0) {
        dropdown.classList.add('show');
        var noItem = document.createElement('div');
        noItem.className = 'search-dropdown-item';
        noItem.textContent = 'No places found';
        dropdown.appendChild(noItem);
        return;
      }
      results.forEach(function (r) {
        var item = document.createElement('div');
        item.className = 'search-dropdown-item';
        var distText = '';
        if (from && from.length >= 2) {
          var km = haversineKm(from[1], from[0], r.lat, r.lng);
          distText = '<div class="suggestion-distance">' + km.toFixed(1) + ' km away</div>';
        }
        var displayName = r.display_name || r.name || (r.lat + ', ' + r.lng);
        item.innerHTML = '<div class="place-name">' + (r.name || displayName) + '</div><div class="place-addr">' + displayName + '</div>' + distText;
        item.addEventListener('click', function () {
          onSelect({ name: displayName, lat: r.lat, lng: r.lng });
          input.value = displayName;
          dropdown.innerHTML = '';
          dropdown.classList.remove('show');
        });
        dropdown.appendChild(item);
      });
      dropdown.classList.add('show');
    }

    var searchFn = Search.debounce(function () {
      var q = input.value.trim();
      if (q.length < 2) {
        dropdown.innerHTML = '';
        dropdown.classList.remove('show');
        return;
      }
      dropdown.innerHTML = '<div class="search-dropdown-item search-dropdown-searching" style="color:var(--text-secondary)">Searching…</div>';
      dropdown.classList.add('show');
      var from = (typeof getFromCoords === 'function') ? getFromCoords() : null;
      var searchPromise = Search.search(q, { limit: 20 });
      var extraPromise = (typeof getExtraPlaces === 'function') ? getExtraPlaces(q) : Promise.resolve([]);
      Promise.all([searchPromise, extraPromise]).then(function (arr) {
        var apiResults = arr[0] || [];
        var extra = arr[1] || [];
        var seen = {};
        var combined = [];
        function addIfValid(r) {
          if (!r || r.lat == null || r.lng == null) return;
          var key = r.lat + ',' + r.lng;
          if (!seen[key]) { seen[key] = true; combined.push(r); }
        }
        apiResults.forEach(addIfValid);
        extra.forEach(addIfValid);
        if (from && from.length >= 2) {
          combined.sort(function (a, b) {
            var da = haversineKm(from[1], from[0], a.lat, a.lng);
            var db = haversineKm(from[1], from[0], b.lat, b.lng);
            return da - db;
          });
        }
        renderResults(combined, from);
      }).catch(function () { renderResults([], from); });
    }, 400);

    input.addEventListener('input', searchFn);
    input.addEventListener('focus', function () { if (dropdown.children.length) dropdown.classList.add('show'); });
    document.addEventListener('click', function (e) {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('show');
    });
  }

  function updateHeaderStats(batteryPercent, rangeKm, chargingMode) {
    const el = document.getElementById('headerBattery');
    if (el) el.textContent = batteryPercent + '%';
    const rangeEl = document.getElementById('headerRange');
    if (rangeEl) rangeEl.textContent = (rangeKm != null ? Math.round(rangeKm) : '—') + ' KM';
    const modeEl = document.getElementById('headerChargingMode');
    if (modeEl) modeEl.textContent = chargingMode || 'FAST';
  }

  function updateRouteOverview(distanceKm, travelTimeStr, chargingStopsCount) {
    const distEl = document.getElementById('routeTotalDistance');
    if (distEl) distEl.textContent = (distanceKm != null ? Math.round(distanceKm) : '—') + ' KM';
    const timeEl = document.getElementById('routeTravelTime');
    if (timeEl) timeEl.textContent = travelTimeStr || '—';
    const stopsEl = document.getElementById('routeChargingStops');
    if (stopsEl) stopsEl.textContent = (chargingStopsCount != null ? chargingStopsCount : 0) + ' STOPS';
  }

  function updateBatterySidebar(percent, rangeKm) {
    const pctEl = document.getElementById('batteryPct');
    if (pctEl) pctEl.textContent = (percent != null ? percent : 82) + '%';
    const fillEl = document.getElementById('batteryFill');
    if (fillEl) fillEl.style.width = (percent != null ? percent : 82) + '%';
    const rangeEl = document.getElementById('estRangeValue');
    if (rangeEl) rangeEl.textContent = (rangeKm != null ? Math.round(rangeKm) : '—') + ' KM';
  }

  function updateTripSummary(distanceKm, travelTimeStr, chargingTimeStr, costStr) {
    const list = document.getElementById('tripSummaryList');
    if (!list) return;
    const items = [
      ['TOTAL DISTANCE', (distanceKm != null ? Math.round(distanceKm) : '—') + ' KM'],
      ['TRAVEL TIME', travelTimeStr || '—'],
      ['CHARGING TIME', chargingTimeStr || '0M'],
      ['COST ESTIMATE', costStr != null ? 'EGP ' + costStr : '—'],
    ];
    list.innerHTML = items.map(([l, v]) => '<li><span class="label">' + l + '</span><span class="value">' + v + '</span></li>').join('');
  }

  function updateBottomBar(opts) {
    const o = opts || {};
    const rangeEl = document.getElementById('bottomExpectedRange');
    if (rangeEl) rangeEl.textContent = (o.expectedRangeKm != null ? Math.round(o.expectedRangeKm) : '—') + ' KM';
    const nextEl = document.getElementById('bottomNextStop');
    if (nextEl) nextEl.textContent = (o.nextStopKm != null ? Math.round(o.nextStopKm) : '—') + ' KM';
    const etaEl = document.getElementById('bottomEta');
    if (etaEl) etaEl.textContent = o.nextStopEta || '—';
    const chargeEl = document.getElementById('bottomChargingTime');
    if (chargeEl) chargeEl.textContent = o.chargingTimeStr || '0M';
    const arrEl = document.getElementById('bottomArrival');
    if (arrEl) arrEl.textContent = o.arrivalStr || '—';
    const tempEl = document.getElementById('bottomWeatherTemp');
    if (tempEl) tempEl.textContent = o.weatherTempC != null ? (Math.round(o.weatherTempC * 10) / 10) : '—';
    const condEl = document.getElementById('bottomWeatherCond');
    if (condEl) condEl.textContent = o.weatherLabel || '—';
    const humEl = document.getElementById('bottomWeatherHumidity');
    if (humEl) humEl.textContent = o.weatherHumidity != null ? o.weatherHumidity + '%' : '—';
    const windEl = document.getElementById('bottomWeatherWind');
    if (windEl) windEl.textContent = o.weatherWind != null ? o.weatherWind + ' km/h' : '—';
    const endEstEl = document.getElementById('bottomEndEst');
    if (endEstEl) endEstEl.textContent = o.endEstPercent != null ? '~' + o.endEstPercent + '%' : '—';
    const progressEndEst = document.getElementById('energyProgressEndEst');
    if (progressEndEst) progressEndEst.textContent = o.endEstPercent != null ? 'END EST. ~' + o.endEstPercent + '%' : '—';
  }

  function renderChargerList(containerId, chargers, lang) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    (chargers || []).forEach((c) => {
      const name = lang === 'ar' && c.name_ar ? c.name_ar : c.name;
      const item = document.createElement('div');
      item.className = 'charger-list-item';
      item.innerHTML =
        '<div class="charger-name">' +
        name +
        '</div>' +
        '<div class="charger-meta">' +
        c.network +
        ' · ' +
        c.power_kw +
        ' kW ' +
        c.type +
        ' · ' +
        (c.connectors || []).join(', ') +
        ' · ' +
        c.distanceFromRouteKm +
        ' km from route</div>';
      container.appendChild(item);
    });
  }

  function confirm(message, opts) {
    opts = opts || {};
    var okLabel = opts.okLabel != null ? opts.okLabel : 'OK';
    var cancelLabel = opts.cancelLabel != null ? opts.cancelLabel : 'Cancel';
    var isRemove = opts.variant === 'remove';
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirmOverlay');
      const msgEl = document.getElementById('confirmMessage');
      const btnOk = document.getElementById('confirmOk');
      const btnCancel = document.getElementById('confirmCancel');
      const box = overlay ? overlay.querySelector('.confirm-box') : null;
      if (!overlay || !msgEl) {
        resolve(window.confirm(message));
        return;
      }
      msgEl.textContent = message;
      if (btnOk) btnOk.textContent = okLabel;
      if (btnCancel) btnCancel.textContent = cancelLabel;
      if (box) box.classList.toggle('confirm-box-3d', isRemove);
      overlay.style.display = 'flex';
      overlay.classList.add('show');
      const done = (ok) => {
        overlay.classList.remove('show');
        overlay.style.display = '';
        if (box) box.classList.remove('confirm-box-3d');
        if (btnOk) { btnOk.textContent = 'OK'; btnOk.removeEventListener('click', onOk); }
        if (btnCancel) { btnCancel.textContent = 'Cancel'; btnCancel.removeEventListener('click', onCancel); }
        resolve(ok);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      if (btnOk) btnOk.addEventListener('click', onOk);
      if (btnCancel) btnCancel.addEventListener('click', onCancel);
    });
  }

  global.EVTripPlannerUI = {
    showModal,
    renderVehicleCards,
    setupSearchInput,
    updateHeaderStats,
    updateRouteOverview,
    updateBatterySidebar,
    updateTripSummary,
    updateBottomBar,
    renderChargerList,
    confirm,
  };
})(window);
