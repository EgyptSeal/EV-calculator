/**
 * Mapbox GL JS map, day/night styles, geolocation, camera fit.
 */
(function (global) {
  const C = global.EVTripPlannerConfig?.mapbox || {};
  let map = null;
  let currentStyle = 'day';
  let userLocation = null;
  let markers = { start: null, end: null, chargers: [], chargeStops: [], demoCar: null, navCar: null };
  let lastCarTurnOffset = 0;
  let lastNavCarLng = null;
  let lastNavCarLat = null;
  let navCarTweenId = null;
  let navCarTarget = null;
  let navigationMode = false;
  let previewBlinkInterval = null;

  var FALLBACK_STYLE_DAY = 'mapbox://styles/mapbox/light-v11';
  var FALLBACK_STYLE_NIGHT = 'mapbox://styles/mapbox/dark-v11';
  var FOLLOW_ZOOM = 18.5;
  var FOLLOW_ZOOM_APPROACH_TURN = 20;
  var FOLLOW_ZOOM_APPROACH_DISTANCE_M = 350;
  var FOLLOW_PITCH = 62;
  var FOLLOW_PITCH_MIN_KMH = 5;
  var FOLLOW_PITCH_MAX_KMH = 120;
  var FOLLOW_PITCH_STOPPED = 58;
  var FOLLOW_PITCH_MAX = 80;
  var FOLLOW_DURATION_MS = 120;
  var FOLLOW_CAR_BOTTOM_MARGIN_PX = 140;
  var FOLLOW_CENTER_AHEAD_KM = 0;

  function styleUrl(which) {
    if (which === 'night') return (C.nightStyle || FALLBACK_STYLE_NIGHT);
    return (C.dayStyle || FALLBACK_STYLE_DAY);
  }

  function init(containerId) {
    var mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
    if (!mapboxgl || !C.accessToken || C.accessToken === 'YOUR_MAPBOX_ACCESS_TOKEN') {
      console.warn('Mapbox token not set or Mapbox GL not loaded. Set EVTripPlannerConfig.mapbox.accessToken in config.js and ensure mapbox-gl.js loads.');
      return Promise.resolve(null);
    }
    var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    if (!container) return Promise.resolve(null);

    function ensureSize() {
      return new Promise(function (resolve) {
        function check() {
          if (container.offsetWidth > 0 && container.offsetHeight > 0) {
            resolve();
            return;
          }
          var parent = container.parentElement;
          if (parent && (parent.offsetHeight === 0 || container.offsetHeight === 0)) {
            parent.style.height = '360px';
            parent.style.minHeight = '360px';
          }
        }
        check();
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          resolve();
          return;
        }
        var attempts = 0;
        var t = setInterval(function () {
          check();
          if (container.offsetWidth > 0 && container.offsetHeight > 0) {
            clearInterval(t);
            resolve();
            return;
          }
          if (++attempts > 60) {
            clearInterval(t);
            if (container.parentElement) {
              container.parentElement.style.height = '360px';
              container.parentElement.style.minHeight = '360px';
            }
            resolve();
          }
        }, 50);
      });
    }

    return ensureSize().then(function () {
      var mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
      if (!mapboxgl) return Promise.resolve(null);
      mapboxgl.accessToken = C.accessToken;
      var center = userLocation || C.defaultCenter || [31.2357, 30.0444];
      var style = styleUrl('day');
      map = new mapboxgl.Map({
        container: container,
        style: style,
        center: center,
        zoom: userLocation ? 14 : (C.defaultZoom || 10),
        maxZoom: C.maxZoom || 18,
        minZoom: C.minZoom || 4,
      });
      if (typeof window !== 'undefined') window.__evMapboxMap = map;
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');

      return new Promise(function (resolve) {
        function onLoaded() {
          var ph = document.getElementById('mapPlaceholder');
          if (ph) ph.style.display = 'none';
          centerOnUser();
          [0, 100, 250, 500].forEach(function (ms) {
            setTimeout(function () { if (map && map.resize) map.resize(); }, ms);
          });
          resolve(map);
        }

        map.on('load', function () {
          if (window.addEventListener) window.addEventListener('resize', function onResize() {
            if (map && map.resize) map.resize();
          });
          if (!map._evCarZoomHandler) {
            map._evCarZoomHandler = true;
            map.on('zoom', function () { updateMarkerScales(); });
            map.on('zoomend', function () { updateMarkerScales(); });
          }
          if (!map._evUserPannedHandler) {
            map._evUserPannedHandler = true;
            map.on('moveend', function () {
              if (_ignoreNextMoveEnd) _ignoreNextMoveEnd = false;
              else userHasPannedMap = true;
            });
          }
          onLoaded();
        });

        map.on('error', function (e) {
          if (e.error && e.error.message && (e.error.message.indexOf('style') !== -1 || e.error.message.indexOf('401') !== -1 || e.error.message.indexOf('403') !== -1)) {
            try { map.setStyle(FALLBACK_STYLE_DAY); } catch (err) {}
          }
        });

        map.on('style.load', function () {
          if (map && map.resize) map.resize();
        });
      });
    });
  }

  function centerOnUser() {
    if (!navigator.geolocation || !map) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = [pos.coords.longitude, pos.coords.latitude];
        map.flyTo({ center: userLocation, zoom: 14, duration: 1500 });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }

  function setUserLocation(lng, lat) {
    userLocation = [lng, lat];
  }

  function setStyle(style, onStyleLoaded) {
    var m = map || (typeof getMap === 'function' ? getMap() : null);
    if (!m) return;
    currentStyle = style;
    var url = style === 'night' ? (C.nightStyle || FALLBACK_STYLE_NIGHT) : (C.dayStyle || FALLBACK_STYLE_DAY);
    m.once('style.load', function () {
      if (m && m.resize) m.resize();
      if (typeof onStyleLoaded === 'function') onStyleLoaded();
    });
    m.setStyle(url);
  }

  function toggleDayNight() {
    currentStyle = currentStyle === 'day' ? 'night' : 'day';
    setStyle(currentStyle);
    return currentStyle;
  }

  function fitBounds(coordinates, padding = 0.2) {
    if (!map || !coordinates || coordinates.length === 0) return;
    const bbox = coordinates.reduce(
      (acc, [lng, lat]) => {
        acc[0] = Math.min(acc[0], lng);
        acc[1] = Math.min(acc[1], lat);
        acc[2] = Math.max(acc[2], lng);
        acc[3] = Math.max(acc[3], lat);
        return acc;
      },
      [Infinity, Infinity, -Infinity, -Infinity]
    );
    const pad = padding;
    const w = bbox[2] - bbox[0];
    const h = bbox[3] - bbox[1];
    const padded = [
      [bbox[0] - w * pad, bbox[1] - h * pad],
      [bbox[2] + w * pad, bbox[3] + h * pad],
    ];
    map.fitBounds(padded, { duration: 800, padding: 40, maxZoom: 14 });
  }

  var ROUTE_LINE_COLOR_DARK = '#6ec8f7';
  var ROUTE_LINE_COLOR_LIGHT = '#5eb8ff';
  var ROUTE_LINE_WIDTH = 8;
  var ROUTE_GLOW_WIDTH = 18;
  var routeGlowAnimationId = null;

  function getRouteLineColor() {
    var isDark = document.documentElement.classList.contains('theme-dark');
    return isDark ? ROUTE_LINE_COLOR_DARK : ROUTE_LINE_COLOR_LIGHT;
  }

  function startRouteGlowAnimation() {
    if (!map || !map.getLayer('ev-trip-route-glow')) return;
    function tick(t) {
      routeGlowAnimationId = requestAnimationFrame(tick);
      if (!map || !map.getLayer('ev-trip-route-glow')) return;
      var opacity = 0.28 + 0.14 * Math.sin(t * 0.002);
      map.setPaintProperty('ev-trip-route-glow', 'line-opacity', opacity);
    }
    if (routeGlowAnimationId != null) cancelAnimationFrame(routeGlowAnimationId);
    routeGlowAnimationId = requestAnimationFrame(tick);
  }

  function stopRouteGlowAnimation() {
    if (routeGlowAnimationId != null) {
      cancelAnimationFrame(routeGlowAnimationId);
      routeGlowAnimationId = null;
    }
  }

  function addSourceAndLayer(id, geoJSON, lineColor, lineWidth) {
    if (!map) return;
    var width = (id === 'ev-trip-route') ? ROUTE_LINE_WIDTH : (lineWidth != null ? lineWidth : 4);
    var lineColorUse = id === 'ev-trip-route' ? getRouteLineColor() : ROUTE_LINE_COLOR_DARK;
    if (map.getSource(id)) {
      map.getSource(id).setData(geoJSON);
      if (map.getLayer(id + '-line')) map.setPaintProperty(id + '-line', 'line-color', lineColorUse);
      if (id === 'ev-trip-route' && map.getLayer('ev-trip-route-glow')) {
        map.setPaintProperty('ev-trip-route-glow', 'line-color', lineColorUse);
      }
      return;
    }
    map.addSource(id, { type: 'geojson', data: geoJSON });
    if (id === 'ev-trip-route') {
      map.addLayer({
        id: 'ev-trip-route-glow',
        type: 'line',
        source: id,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': lineColorUse,
          'line-width': ROUTE_GLOW_WIDTH,
          'line-opacity': 0.32,
        },
      });
      startRouteGlowAnimation();
    }
    map.addLayer({
      id: id + '-line',
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': lineColorUse, 'line-width': width },
    });
  }

  function removeRouteLayer(id) {
    if (!map) return;
    if (id === 'ev-trip-route') stopRouteGlowAnimation();
    if (id === 'ev-trip-route' && map.getLayer('ev-trip-route-glow')) map.removeLayer('ev-trip-route-glow');
    if (map.getLayer(id + '-line')) map.removeLayer(id + '-line');
    if (map.getSource(id)) map.removeSource(id);
  }

  function drawRoutePreview(geoJSON, lineColor) {
    if (!map || !geoJSON || !geoJSON.geometry) return;
    stopRoutePreview();
    var coords = geoJSON.geometry.coordinates || [];
    addSourceAndLayer('route-preview', geoJSON, ROUTE_LINE_COLOR_DARK, 6);
    if (coords.length > 0) fitBounds(coords, 0.25);
    var mapEl = getMap();
    if (mapEl && mapEl.resize) setTimeout(function () { mapEl.resize(); fitBounds(coords, 0.25); }, 150);
    var blinkVal = 1;
    previewBlinkInterval = setInterval(function () {
      if (!map || !map.getLayer('route-preview-line')) return;
      blinkVal = blinkVal === 1 ? 0.35 : 1;
      map.setPaintProperty('route-preview-line', 'line-opacity', blinkVal);
    }, 500);
  }

  function stopRoutePreview() {
    if (previewBlinkInterval) {
      clearInterval(previewBlinkInterval);
      previewBlinkInterval = null;
    }
    removeRouteLayer('route-preview');
  }

  function clearMarkers(which) {
    const keys = which ? [which] : ['start', 'end', 'chargers', 'chargeStops'];
    keys.forEach((k) => {
      const arr = Array.isArray(markers[k]) ? markers[k] : [markers[k]].filter(Boolean);
      arr.forEach((m) => m.remove());
      markers[k] = Array.isArray(markers[k]) ? [] : null;
    });
  }

  function markerScaleFromZoom(zoom) {
    if (zoom == null || zoom < 4) return 0.7;
    return Math.max(0.5, Math.min(1.8, 0.5 + (zoom - 6) * 0.08));
  }

  var FIXED_CAR_MARKER_SIZE_PX = 36;

  function updateCarMarkerSizes() {
    if (!map) return;
    var size = FIXED_CAR_MARKER_SIZE_PX;
    [markers.navCar, markers.demoCar].forEach(function (m) {
      if (m && m.getElement) {
        var el = m.getElement();
        if (el) {
          el.style.width = size + 'px';
          el.style.height = size + 'px';
          el.style.transform = 'rotate(' + lastCarTurnOffset + 'deg)';
        }
      }
    });
  }

  function updateMarkerScales() {
    var zoom = map && map.getZoom ? map.getZoom() : 10;
    var scale = markerScaleFromZoom(zoom);
    var allWraps = [];
    [markers.start, markers.end].concat(markers.chargers || [], markers.chargeStops || []).forEach(function (m) {
      var arr = Array.isArray(m) ? m : [m];
      arr.forEach(function (marker) {
        if (marker && marker.getElement) {
          var el = marker.getElement();
          if (el) allWraps.push(el);
        }
      });
    });
    allWraps.forEach(function (wrap) {
      wrap.style.transform = 'scale(' + scale + ')';
      wrap.style.transformOrigin = 'center bottom';
    });
    updateCarMarkerSizes();
  }

  function addMarker(type, lngLat, label) {
    if (!map) return null;
    const mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
    const wrap = document.createElement('div');
    wrap.className = 'map-marker-wrap map-marker-' + type;
    wrap.style.transformOrigin = 'center bottom';

    const labelEl = document.createElement('div');
    labelEl.className = 'map-marker-label';
    labelEl.setAttribute('dir', 'auto');
    labelEl.textContent = label || (type === 'start' ? 'Starting' : type === 'end' ? 'End' : '');
    labelEl.style.color = type === 'start' ? '#00ff88' : type === 'end' ? '#ff4757' : '#00d4ff';

    const el = document.createElement('div');
    el.className = 'map-marker map-marker-' + type;
    var pinW = type === 'charger' ? 28 : 36;
    var pinH = type === 'charger' ? 44 : 36;
    el.style.width = pinW + 'px';
    el.style.height = pinH + 'px';
    el.style.backgroundSize = 'contain';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = 'center bottom';
    el.style.backgroundColor = 'transparent';
    if (type === 'start') {
      el.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'><path fill=\'#00ff88\' d=\'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z\'/></svg>') + '")';
    } else if (type === 'end') {
      el.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'><path fill=\'#ff4757\' d=\'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z\'/></svg>') + '")';
    } else {
      el.style.backgroundImage = 'none';
      el.innerHTML = '<svg class="charger-pin-svg" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg"><path fill="#00b8d4" stroke="rgba(255,255,255,0.6)" stroke-width="0.8" d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0zm0 17c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5z"/><path fill="#fff" d="M13 2L3 14h5l-2 8 10-12h-5l2-8z" transform="translate(6,8) scale(0.55)"/></svg>';
    }

    wrap.appendChild(labelEl);
    wrap.appendChild(el);
    const marker = new mapboxgl.Marker({ element: wrap }).setLngLat(lngLat).addTo(map);
    if (map.on) {
      var onZoom = function () { updateMarkerScales(); };
      if (!map._evMarkerZoomHandler) {
        map._evMarkerZoomHandler = true;
        map.on('zoom', onZoom);
        map.on('zoomend', onZoom);
      }
    }
    updateMarkerScales();
    return marker;
  }

  function setStartMarker(lngLat) {
    clearMarkers('start');
    markers.start = addMarker('start', lngLat, 'Starting');
  }

  function setEndMarker(lngLat) {
    clearMarkers('end');
    markers.end = addMarker('end', lngLat, 'End');
  }

  function setChargeStopMarkers(waypoints) {
    clearMarkers('chargeStops');
    markers.chargeStops = (waypoints || []).map((wp) => addMarker('charger', [wp.lng, wp.lat], wp.name || 'Charge stop'));
  }

  function addChargerMarkers(chargers, onChargerClick) {
    clearMarkers('chargers');
    markers.chargers = (chargers || []).map((c) => {
      const m = addMarker('charger', [c.lng, c.lat], c.name || 'EV station');
      if (m && onChargerClick && m.getElement()) {
        m.getElement().style.cursor = 'pointer';
        m.getElement().addEventListener('click', (e) => { e.stopPropagation(); onChargerClick(c); });
      }
      return m;
    });
  }

  function enterNavigationMode() {
    if (!map) return;
    navigationMode = true;
    resetUserPannedMap();
    if (markers.start && markers.start.getElement) {
      var el = markers.start.getElement();
      if (el) el.style.display = 'none';
    }
    _ignoreNextMoveEnd = true;
    map.easeTo({
      pitch: FOLLOW_PITCH,
      zoom: FOLLOW_ZOOM,
      duration: 800,
    });
  }

  function exitNavigationMode() {
    if (!map) return;
    navigationMode = false;
    if (markers.start && markers.start.getElement) {
      var el = markers.start.getElement();
      if (el) el.style.display = '';
    }
    map.easeTo({
      pitch: 0,
      duration: 600,
    });
    clearNavigationCar();
  }

  /** Bearing in degrees from point A to B (0 = North, 90 = East). Camera behind car = map rotated in travel direction. */
  function bearingBetween(lng1, lat1, lng2, lat2) {
    var dLon = (lng2 - lng1) * Math.PI / 180;
    var lat1Rad = lat1 * Math.PI / 180;
    var lat2Rad = lat2 * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(lat2Rad);
    var x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  /**
   * Segment index = segment that actually contains the position (project point onto route).
   * So guidance matches reality: we show the instruction for the step we're currently on.
   */
  function getSegmentIndexFromRoute(coords, lng, lat) {
    if (!coords || coords.length < 2) return 0;
    var bestSeg = 0;
    var bestD = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i], b = coords[i + 1];
      var ax = a[0], ay = a[1], bx = b[0], by = b[1];
      var dx = bx - ax, dy = by - ay;
      var lenSq = dx * dx + dy * dy;
      var t = lenSq <= 0 ? 0 : Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / lenSq));
      var px = ax + t * dx, py = ay + t * dy;
      var d = (lng - px) * (lng - px) + (lat - py) * (lat - py);
      if (d < bestD) { bestD = d; bestSeg = i; }
    }
    return bestSeg;
  }

  function getBearingFromRoute(coords, lng, lat) {
    var seg = getSegmentIndexFromRoute(coords, lng, lat);
    var a = coords[seg], b = coords[seg + 1];
    if (!a || !b) return null;
    return bearingBetween(a[0], a[1], b[0], b[1]);
  }

  /** Turn offset for car icon: +30 left, -30 right, 0 straight. Used when entering a turn. */
  var CAR_TURN_OFFSET_DEG = 30;
  var CAR_TURN_THRESHOLD_DEG = 12;

  function getTurnOffsetFromRoute(coords, segIndex) {
    if (!coords || segIndex < 0 || segIndex + 2 >= coords.length) return 0;
    var a = coords[segIndex], b = coords[segIndex + 1], c = coords[segIndex + 2];
    var bear1 = bearingBetween(a[0], a[1], b[0], b[1]);
    var bear2 = bearingBetween(b[0], b[1], c[0], c[1]);
    var delta = ((bear2 - bear1 + 540) % 360) - 180;
    if (delta > CAR_TURN_THRESHOLD_DEG) return -CAR_TURN_OFFSET_DEG;
    if (delta < -CAR_TURN_THRESHOLD_DEG) return CAR_TURN_OFFSET_DEG;
    return 0;
  }

  /**
   * Route guidance from geometry only: turn, exit, keep straight.
   * Roundabout wording is never used here – only when the API returns roundabout/rotary.
   */
  var SLIGHT_DEG = 35;
  var SHARP_DEG = 90;
  var U_TURN_DEG = 150;

  function segmentLengthKm(a, b) {
    if (!a || !b) return 0;
    var latRad = (a[1] + b[1]) / 2 * Math.PI / 180;
    var dlatKm = (b[1] - a[1]) * 111;
    var dlngKm = (b[0] - a[0]) * 111 * Math.cos(latRad);
    return Math.sqrt(dlatKm * dlatKm + dlngKm * dlngKm);
  }

  /**
   * Mapbox Maneuver API style: get banner instruction for current step (primary, secondary, sub, step distance).
   * Returns null if route has no maneuvers; then use getNextTurnInstruction(coords, segIndex).
   * distanceTraveledM: optional meters traveled along route (for accurate remaining distance).
   */
  function getBannerInstruction(route, segIndex, distanceTraveledM) {
    if (!route || !route.maneuvers || !route.stepIndexForSegment || !route.cumulativeStepDistanceM || !route.segmentDistanceKm) return null;
    if (segIndex < 0 || segIndex >= route.stepIndexForSegment.length) return null;
    var stepIdx = route.stepIndexForSegment[segIndex];
    var maneuver = route.maneuvers[stepIdx];
    if (!maneuver) return null;
    var stepEndM = route.cumulativeStepDistanceM[stepIdx + 1];
    var traveled = distanceTraveledM != null && !isNaN(distanceTraveledM) ? distanceTraveledM : (route.segmentDistanceKm[segIndex] * 1000);
    var distanceRemainingM = Math.max(0, Math.round(stepEndM - traveled));
    return {
      primaryText: maneuver.primaryText,
      type: maneuver.type,
      modifier: maneuver.modifier,
      secondaryText: maneuver.secondaryText,
      subText: maneuver.subText,
      distanceM: maneuver.distanceM,
      distanceRemainingM: distanceRemainingM,
      stepIndex: stepIdx,
    };
  }

  /**
   * Upcoming maneuvers list (after current step), per Mapbox Maneuver UI.
   */
  function getUpcomingManeuvers(route, segIndex, count) {
    if (!route || !route.maneuvers || !route.stepIndexForSegment) return [];
    if (segIndex < 0 || segIndex >= route.stepIndexForSegment.length) return [];
    var stepIdx = route.stepIndexForSegment[segIndex];
    var list = [];
    for (var i = stepIdx + 1; i < route.maneuvers.length && list.length < (count || 5); i++) {
      list.push(route.maneuvers[i]);
    }
    return list;
  }

  /** Google-style: next real turn (not continue straight) and distance to it, so we can show it early. */
  function getUpcomingTurnBanner(route, segIndex, distanceTraveledM) {
    if (!route || !route.maneuvers || !route.stepIndexForSegment || !route.cumulativeStepDistanceM) return null;
    if (segIndex < 0 || segIndex >= route.stepIndexForSegment.length) return null;
    var stepIdx = route.stepIndexForSegment[segIndex];
    var traveled = distanceTraveledM != null && !isNaN(distanceTraveledM) ? distanceTraveledM : (route.segmentDistanceKm[segIndex] * 1000);
    for (var i = stepIdx + 1; i < route.maneuvers.length; i++) {
      var m = route.maneuvers[i];
      var t = (m.type || '').toLowerCase().replace(/_/g, ' ');
      var mod = (m.modifier || '').toLowerCase().replace(/_/g, ' ');
      if (t === 'arrive') break;
      var isStraight = (t === 'depart' || t === 'continue') && (mod === 'straight' || !mod);
      if (isStraight) continue;
      var stepEndM = route.cumulativeStepDistanceM[i + 1];
      var distToTurnM = Math.max(0, Math.round(stepEndM - traveled));
      if (distToTurnM > 2000) return null;
      return { primaryText: m.primaryText, type: m.type, modifier: m.modifier, secondaryText: m.secondaryText, subText: m.subText, distanceRemainingM: distToTurnM, stepIndex: i };
    }
    return null;
  }

  function getNextTurnInstruction(coords, segIndex) {
    if (!coords || coords.length < 2) return 'Keep straight';
    if (segIndex < 0 || segIndex + 2 >= coords.length) return 'Arrive at destination';
    var a = coords[segIndex], b = coords[segIndex + 1], c = coords[segIndex + 2];
    var bear1 = bearingBetween(a[0], a[1], b[0], b[1]);
    var bear2 = bearingBetween(b[0], b[1], c[0], c[1]);
    var delta = ((bear2 - bear1 + 540) % 360) - 180;

    if (delta >= U_TURN_DEG || delta <= -U_TURN_DEG) return 'Make a U-turn';
    if (delta > SHARP_DEG) return 'Turn right';
    if (delta < -SHARP_DEG) return 'Turn left';
    if (delta > SLIGHT_DEG) return 'Take the right exit';
    if (delta < -SLIGHT_DEG) return 'Take the left exit';
    if (delta > CAR_TURN_THRESHOLD_DEG) return 'Take the right exit';
    if (delta < -CAR_TURN_THRESHOLD_DEG) return 'Take the left exit';
    return 'Keep straight';
  }

  function setCarMarkerRotation(marker, turnOffsetDeg) {
    if (!marker || !marker.getElement) return;
    lastCarTurnOffset = turnOffsetDeg != null ? turnOffsetDeg : 0;
    var el = marker.getElement();
    if (!el) return;
    el.style.transform = 'rotate(' + lastCarTurnOffset + 'deg)';
  }

  var userHasPannedMap = false;
  var _ignoreNextMoveEnd = false;

  /** Follow car: car locked at bottom center, pitch increases with speed. Zooms in when approaching a turn/exit. */
  function followCar(lng, lat, bearing, forceFollow, speedKmh, options) {
    if (!map || (!navigationMode && !forceFollow)) return;
    if (userHasPannedMap) return;
    var speed = speedKmh != null && !isNaN(speedKmh) ? Math.max(0, Math.min(FOLLOW_PITCH_MAX_KMH, speedKmh)) : 0;
    var pitch = speed <= FOLLOW_PITCH_MIN_KMH
      ? FOLLOW_PITCH_STOPPED
      : FOLLOW_PITCH_STOPPED + ((speed - FOLLOW_PITCH_MIN_KMH) / (FOLLOW_PITCH_MAX_KMH - FOLLOW_PITCH_MIN_KMH)) * (FOLLOW_PITCH_MAX - FOLLOW_PITCH_STOPPED);
    var distToTurnM = options && options.distToTurnM != null ? options.distToTurnM : Infinity;
    var isTurnOrExit = options && options.isTurnOrExit === true;
    var zoom = (isTurnOrExit && distToTurnM < FOLLOW_ZOOM_APPROACH_DISTANCE_M)
      ? FOLLOW_ZOOM_APPROACH_TURN
      : FOLLOW_ZOOM;
    var container = map.getContainer();
    var h = (container && container.clientHeight) || 400;
    var offsetY = Math.round(h / 2 - FOLLOW_CAR_BOTTOM_MARGIN_PX);
    var opts = {
      center: [lng, lat],
      zoom: zoom,
      pitch: pitch,
      duration: FOLLOW_DURATION_MS,
      essential: true,
      offset: [0, offsetY],
      easing: function (t) { return t * (2 - t); },
    };
    if (bearing != null && !isNaN(bearing)) opts.bearing = bearing;
    _ignoreNextMoveEnd = true;
    map.easeTo(opts);
  }

  function resetUserPannedMap() {
    userHasPannedMap = false;
  }

  function flyToCar(lng, lat, opts) {
    if (!map) return;
    opts = opts || {};
    var duration = opts.duration != null ? opts.duration : 800;
    var container = map.getContainer();
    var h = (container && container.clientHeight) || 400;
    var offsetY = Math.round(h / 2 - FOLLOW_CAR_BOTTOM_MARGIN_PX);
    var flyOpts = {
      center: [lng, lat],
      zoom: opts.zoom != null ? opts.zoom : FOLLOW_ZOOM,
      pitch: opts.pitch != null ? opts.pitch : FOLLOW_PITCH,
      duration: duration,
      essential: true,
      offset: [0, offsetY],
      easing: function (t) { return t * (2 - t); },
    };
    if (opts.bearing != null && !isNaN(opts.bearing)) flyOpts.bearing = opts.bearing;
    map.flyTo(flyOpts);
  }

  function createCarMarkerElement(className) {
    var wrap = document.createElement('div');
    wrap.className = className;
    wrap.style.transformOrigin = 'center center';
    var ripples = document.createElement('div');
    ripples.className = 'car-marker-ripples';
    for (var i = 0; i < 3; i++) {
      var ring = document.createElement('div');
      ring.className = 'car-marker-ripple';
      ring.style.animationDelay = (i * 0.6) + 's';
      ripples.appendChild(ring);
    }
    wrap.appendChild(ripples);
    var dot = document.createElement('div');
    dot.className = 'car-marker-dot';
    wrap.appendChild(dot);
    return wrap;
  }

  function setNavigationCarPosition(lng, lat, bearing, turnOffsetDeg) {
    if (!map) return;
    var mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
    if (!mapboxgl) return;
    if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) return;
    if (lng === 0 && lat === 0) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    if (!markers.navCar) {
      const wrap = createCarMarkerElement('nav-car-marker');
      markers.navCar = new mapboxgl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
      lastNavCarLng = lng;
      lastNavCarLat = lat;
      setCarMarkerRotation(markers.navCar, turnOffsetDeg);
      updateCarMarkerSizes();
      return;
    }
    if (navCarTweenId != null) {
      cancelAnimationFrame(navCarTweenId);
      navCarTweenId = null;
    }
    lastNavCarLng = lng;
    lastNavCarLat = lat;
    markers.navCar.setLngLat([lng, lat]);
    setCarMarkerRotation(markers.navCar, turnOffsetDeg != null ? turnOffsetDeg : lastCarTurnOffset);
    updateCarMarkerSizes();
  }

  var tempSavePinMarker = null;

  function setTempSavePin(lng, lat) {
    if (!map) return;
    var mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
    if (!mapboxgl) return;
    removeTempSavePin();
    var el = document.createElement('div');
    el.className = 'pin-save-blink';
    el.style.fontSize = '28px';
    el.style.lineHeight = '1';
    el.textContent = '📍';
    el.style.filter = 'drop-shadow(0 0 6px #ff4757)';
    tempSavePinMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(map);
  }

  function removeTempSavePin() {
    if (tempSavePinMarker) {
      tempSavePinMarker.remove();
      tempSavePinMarker = null;
    }
  }

  function clearNavigationCar() {
    if (navCarTweenId != null) {
      cancelAnimationFrame(navCarTweenId);
      navCarTweenId = null;
    }
    lastNavCarLng = null;
    lastNavCarLat = null;
    navCarTarget = null;
    if (markers.navCar) {
      markers.navCar.remove();
      markers.navCar = null;
    }
    lastCarTurnOffset = 0;
  }

  function setDemoCarPosition(lng, lat, bearing, turnOffsetDeg) {
    if (!map) return;
    if (!markers.demoCar) {
      const el = createCarMarkerElement('demo-car-marker');
      markers.demoCar = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
    }
    markers.demoCar.setLngLat([lng, lat]);
    setCarMarkerRotation(markers.demoCar, turnOffsetDeg);
    updateCarMarkerSizes();
  }

  function removeDemoCar() {
    if (markers.demoCar) {
      markers.demoCar.remove();
      markers.demoCar = null;
    }
    lastCarTurnOffset = 0;
  }

  function getMap() {
    return map;
  }

  function _setMap(instance) {
    if (instance && typeof instance.resize === 'function') {
      map = instance;
    }
  }

  function getUserLocation() {
    return userLocation;
  }

  global.EVTripPlannerMap = {
    init,
    getMap,
    setStyle,
    _setMap,
    toggleDayNight,
    fitBounds,
    addSourceAndLayer,
    removeRouteLayer,
    drawRoutePreview,
    stopRoutePreview,
    clearMarkers,
    setStartMarker,
    setEndMarker,
    setChargeStopMarkers,
    addChargerMarkers,
    centerOnUser,
    getUserLocation,
    setUserLocation,
    setDemoCarPosition,
    removeDemoCar,
    enterNavigationMode,
    exitNavigationMode,
    followCar,
    flyToCar,
    bearingBetween,
    getBearingFromRoute,
    getSegmentIndexFromRoute,
    getTurnOffsetFromRoute,
    getNextTurnInstruction,
    getBannerInstruction,
    getUpcomingManeuvers,
    getUpcomingTurnBanner,
    setNavigationCarPosition,
    clearNavigationCar,
    resetUserPannedMap,
    setTempSavePin,
    removeTempSavePin,
  };
})(window);
