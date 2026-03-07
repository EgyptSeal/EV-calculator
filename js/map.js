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
  var NAV_CAR_TWEEN_MS = 280;
  let previewBlinkInterval = null;

  var FALLBACK_STYLE_DAY = 'mapbox://styles/mapbox/light-v11';
  var FALLBACK_STYLE_NIGHT = 'mapbox://styles/mapbox/dark-v11';
  var FOLLOW_ZOOM = 18.5;
  var FOLLOW_PITCH = 50;
  var FOLLOW_PITCH_MOVING = 68;
  var FOLLOW_PITCH_STOPPED = 48;
  var FOLLOW_DURATION_MS = 450;
  var FOLLOW_OFFSET_Y = 70;
  var FOLLOW_CENTER_AHEAD_KM = 0.04;

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

  var ROUTE_LINE_COLOR_DARK = '#00e5ff';
  var ROUTE_LINE_COLOR_LIGHT = '#42a5f5';

  function getRouteLineColor() {
    var isDark = document.documentElement.classList.contains('theme-dark');
    return isDark ? ROUTE_LINE_COLOR_DARK : ROUTE_LINE_COLOR_LIGHT;
  }

  function addSourceAndLayer(id, geoJSON, lineColor, lineWidth) {
    if (!map) return;
    var width = lineWidth != null ? lineWidth : 4;
    var lineColorUse = id === 'ev-trip-route' ? getRouteLineColor() : ROUTE_LINE_COLOR_DARK;
    if (map.getSource(id)) {
      map.getSource(id).setData(geoJSON);
      if (map.getLayer(id + '-line')) map.setPaintProperty(id + '-line', 'line-color', lineColorUse);
      return;
    }
    map.addSource(id, { type: 'geojson', data: geoJSON });
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
    if (markers.start && markers.start.getElement) {
      var el = markers.start.getElement();
      if (el) el.style.display = 'none';
    }
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

  function getSegmentIndexFromRoute(coords, lng, lat) {
    if (!coords || coords.length < 2) return 0;
    var bestSeg = 0;
    var bestD = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var c0 = coords[i], c1 = coords[i + 1];
      var d = Math.pow(c0[0] - lng, 2) + Math.pow(c0[1] - lat, 2);
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

  function setCarMarkerRotation(marker, turnOffsetDeg) {
    if (!marker || !marker.getElement) return;
    lastCarTurnOffset = turnOffsetDeg != null ? turnOffsetDeg : 0;
    var el = marker.getElement();
    if (!el) return;
    el.style.transform = 'rotate(' + lastCarTurnOffset + 'deg)';
  }

  /** Follow car: camera behind car (center point ahead of car), car above bottom line, strong tilt. */
  function followCar(lng, lat, bearing, forceFollow, speedKmh) {
    if (!map || (!navigationMode && !forceFollow)) return;
    var pitch = (speedKmh != null && speedKmh > 20) ? FOLLOW_PITCH_MOVING : FOLLOW_PITCH_STOPPED;
    var centerLng = lng;
    var centerLat = lat;
    if (bearing != null && !isNaN(bearing) && FOLLOW_CENTER_AHEAD_KM > 0) {
      var rad = (bearing * Math.PI) / 180;
      var latRad = (lat * Math.PI) / 180;
      centerLng = lng + (FOLLOW_CENTER_AHEAD_KM / 111.32) * Math.sin(rad) / Math.cos(latRad);
      centerLat = lat + (FOLLOW_CENTER_AHEAD_KM / 110.54) * Math.cos(rad);
    }
    var opts = {
      center: [centerLng, centerLat],
      zoom: FOLLOW_ZOOM,
      pitch: pitch,
      duration: FOLLOW_DURATION_MS,
      essential: true,
      offset: [0, FOLLOW_OFFSET_Y],
      easing: function (t) { return t * (2 - t); },
    };
    if (bearing != null && !isNaN(bearing)) opts.bearing = bearing;
    map.easeTo(opts);
  }

  function flyToCar(lng, lat, opts) {
    if (!map) return;
    opts = opts || {};
    var duration = opts.duration != null ? opts.duration : 800;
    var flyOpts = {
      center: [lng, lat],
      zoom: opts.zoom != null ? opts.zoom : FOLLOW_ZOOM,
      pitch: opts.pitch != null ? opts.pitch : FOLLOW_PITCH,
      duration: duration,
      essential: true,
      offset: [0, FOLLOW_OFFSET_Y],
      easing: function (t) { return t * (2 - t); },
    };
    if (opts.bearing != null && !isNaN(opts.bearing)) flyOpts.bearing = opts.bearing;
    map.flyTo(flyOpts);
  }

  function createCarMarkerElement(className) {
    var wrap = document.createElement('div');
    wrap.className = className;
    wrap.style.transformOrigin = 'center center';
    wrap.style.transition = 'transform 0.25s ease-out';
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
    if (lastNavCarLng == null || lastNavCarLat == null) {
      var cur = markers.navCar.getLngLat();
      lastNavCarLng = cur.lng;
      lastNavCarLat = cur.lat;
    }
    var startLng = lastNavCarLng;
    var startLat = lastNavCarLat;
    navCarTarget = { lng: lng, lat: lat, turnOffsetDeg: turnOffsetDeg };
    var startTime = null;
    function step(now) {
      if (!startTime) startTime = now;
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / NAV_CAR_TWEEN_MS);
      t = t * t * (3 - 2 * t);
      var curLng = startLng + (lng - startLng) * t;
      var curLat = startLat + (lat - startLat) * t;
      markers.navCar.setLngLat([curLng, curLat]);
      var turnT = turnOffsetDeg != null ? turnOffsetDeg : lastCarTurnOffset;
      setCarMarkerRotation(markers.navCar, turnT);
      if (t < 1) {
        navCarTweenId = requestAnimationFrame(step);
      } else {
        navCarTweenId = null;
        lastNavCarLng = lng;
        lastNavCarLat = lat;
      }
    }
    navCarTweenId = requestAnimationFrame(step);
    updateCarMarkerSizes();
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
    setNavigationCarPosition,
    clearNavigationCar,
  };
})(window);
