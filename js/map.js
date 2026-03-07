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
  let navigationMode = false;
  let previewBlinkInterval = null;

  var FALLBACK_STYLE_DAY = 'mapbox://styles/mapbox/light-v11';
  var FALLBACK_STYLE_NIGHT = 'mapbox://styles/mapbox/dark-v11';
  var FOLLOW_ZOOM = 15;
  var FOLLOW_ZOOM_START = 15.5;
  var FOLLOW_PITCH = 50;
  var FOLLOW_DURATION_MS = 350;
  var lastCarBearing = null;
  /** Fraction of view height from top where the car should sit (0.5 = center, 0.72 = bottom area). */
  var CAR_VIEW_VERTICAL_FRAC = 0.72;
  /** Fallback offset (degrees) when pixel-based offset can't be used (e.g. initial fly). Car in bottom area. */
  var CAR_VIEW_OFFSET_DEG = 0.00035;

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
            map.on('zoom', function () { updateMarkerScales(); updateCarMarkerSizes(); });
            map.on('zoomend', function () { updateMarkerScales(); updateCarMarkerSizes(); });
            map.on('rotate', updateCarMarkerRotationFromMap);
            map.on('moveend', updateCarMarkerRotationFromMap);
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

  function addSourceAndLayer(id, geoJSON, lineColor, lineWidth) {
    if (!map) return;
    var lightBlue = '#5dd4ff';
    var color = lightBlue;
    var width = lineWidth != null ? lineWidth : 4;
    if (map.getSource(id)) {
      map.getSource(id).setData(geoJSON);
      return;
    }
    map.addSource(id, { type: 'geojson', data: geoJSON });
    map.addLayer({
      id: id + '-line',
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width },
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
    var color = '#5dd4ff';
    var coords = geoJSON.geometry.coordinates || [];
    addSourceAndLayer('route-preview', geoJSON, color, 6);
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

  /** Real-world car size: ~4.5m. Returns pixel size for car icon at given zoom/lat. */
  function carPixelSizeFromZoom(zoom, lat) {
    if (zoom == null) return 48;
    lat = lat != null ? lat : 30;
    var metersPerPixel = (2 * Math.PI * 6378137) / (256 * Math.pow(2, zoom)) * Math.cos(lat * Math.PI / 180);
    var carMeters = 4.5;
    var px = Math.round((carMeters / metersPerPixel));
    return Math.max(24, Math.min(120, px));
  }

  function updateCarMarkerSizes() {
    if (!map) return;
    var zoom = map.getZoom ? map.getZoom() : 16;
    var center = map.getCenter ? map.getCenter() : null;
    var lat = center && center.lat != null ? center.lat : 30;
    var size = carPixelSizeFromZoom(zoom, lat);
    [markers.navCar, markers.demoCar].forEach(function (m) {
      if (m && m.getElement) {
        var el = m.getElement();
        if (el) {
          el.style.width = size + 'px';
          el.style.height = 'auto';
          setCarMarkerRotation(m, lastCarBearing, lastCarTurnOffset);
          var img = el.querySelector('img');
          if (img) {
            img.style.width = size + 'px';
            img.style.height = 'auto';
          }
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
    el.style.width = type === 'charger' ? '28px' : '32px';
    el.style.height = type === 'charger' ? '44px' : '32px';
    el.style.backgroundSize = 'contain';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = 'center bottom';
    el.style.backgroundColor = 'transparent';
    if (type === 'start') {
      el.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'><path fill=\'#00ff88\' d=\'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z\'/></svg>') + '")';
    } else if (type === 'end') {
      el.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'><path fill=\'#ff4757\' d=\'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z\'/></svg>') + '")';
    } else {
      el.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 36\'><path fill=\'#00d4ff\' stroke=\'#0088aa\' stroke-width=\'0.8\' stroke-linejoin=\'round\' d=\'M12 0C7.58 0 4 3.6 4 8c0 6 8 16 8 16s8-10 8-16c0-4.4-3.58-8-8-8zm0 11.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z\'/></svg>') + '")';
    }

    wrap.appendChild(labelEl);
    wrap.appendChild(el);
    const marker = new mapboxgl.Marker({ element: wrap }).setLngLat(lngLat).addTo(map);
    if (map.on) {
      var onZoom = function () { updateMarkerScales(); updateCarMarkerSizes(); };
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
    map.jumpTo({
      pitch: FOLLOW_PITCH,
      zoom: FOLLOW_ZOOM_START,
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

  /** Car icon counter-rotates when map rotates: camera rotates => car rotates the opposite way so it stays aligned with the road. */
  function setCarMarkerRotation(marker, bearing, turnOffsetDeg) {
    if (!marker || !marker.getElement || !map) return;
    lastCarTurnOffset = turnOffsetDeg != null ? turnOffsetDeg : 0;
    lastCarBearing = bearing != null && !isNaN(bearing) ? bearing : lastCarBearing;
    var mapBearing = typeof map.getBearing === 'function' ? map.getBearing() : 0;
    var rot = (lastCarBearing != null ? lastCarBearing - mapBearing : 0) + lastCarTurnOffset;
    var el = marker.getElement();
    if (!el) return;
    el.style.transform = 'rotate(' + rot + 'deg)';
  }

  function updateCarMarkerRotationFromMap() {
    if (markers.navCar) setCarMarkerRotation(markers.navCar, lastCarBearing, lastCarTurnOffset);
    if (markers.demoCar) setCarMarkerRotation(markers.demoCar, lastCarBearing, lastCarTurnOffset);
  }

  function zoomFromSpeed(speedKmh) {
    if (speedKmh == null || isNaN(speedKmh)) speedKmh = 50;
    var z = FOLLOW_ZOOM_START - (speedKmh - 50) * 0.015;
    return Math.max(14, Math.min(17, z));
  }

  /**
   * Compute map center so the car at (lng, lat) appears in the bottom area of the view (camera sees car from behind).
   * Pan so car moves to (centerX, targetCarY). Uses geographic offset if car is off-screen (e.g. right after start).
   */
  function centerForCarAtBottom(lng, lat, bearing, zoom, pitch) {
    zoom = zoom != null ? zoom : FOLLOW_ZOOM_START;
    pitch = pitch != null ? pitch : FOLLOW_PITCH;
    var container = map.getContainer();
    var w = container && container.offsetWidth ? container.offsetWidth : 400;
    var h = container && container.offsetHeight ? container.offsetHeight : 300;
    var margin = Math.min(w, h) * 0.3;
    var carPixel = map.project([lng, lat]);
    if (carPixel.x < -margin || carPixel.x > w + margin || carPixel.y < -margin || carPixel.y > h + margin) {
      var b = (bearing != null && !isNaN(bearing)) ? (bearing * Math.PI / 180) : 0;
      var d = CAR_VIEW_OFFSET_DEG;
      return { center: [lng + d * Math.sin(b), lat + d * Math.cos(b)], zoom: zoom, pitch: pitch };
    }
    var centerY = h / 2;
    var targetCarY = h * CAR_VIEW_VERTICAL_FRAC;
    var newCenterPixel = [carPixel.x, centerY + carPixel.y - targetCarY];
    var newCenter = map.unproject(newCenterPixel);
    return { center: [newCenter.lng, newCenter.lat], zoom: zoom, pitch: pitch };
  }

  /** Follow car with smooth camera. Camera sees the car from behind, car in bottom area of view. */
  function followCar(lng, lat, bearing, forceFollow, speedKmh) {
    if (!map || (!navigationMode && !forceFollow)) return;
    var zoom = zoomFromSpeed(speedKmh);
    var result = centerForCarAtBottom(lng, lat, bearing, zoom, FOLLOW_PITCH);
    var opts = {
      center: result.center,
      zoom: result.zoom,
      pitch: result.pitch,
      bearing: bearing != null && !isNaN(bearing) ? bearing : undefined,
      duration: FOLLOW_DURATION_MS,
      essential: true,
      easing: function (t) { return t * (2 - t); },
    };
    map.easeTo(opts);
  }

  function flyToCar(lng, lat, opts) {
    if (!map) return;
    opts = opts || {};
    var duration = opts.duration != null ? opts.duration : 400;
    var zoom = opts.zoom != null ? opts.zoom : FOLLOW_ZOOM_START;
    var pitch = opts.pitch != null ? opts.pitch : FOLLOW_PITCH;
    var bearing = opts.bearing != null && !isNaN(opts.bearing) ? opts.bearing : 0;
    var b = (bearing * Math.PI / 180);
    var d = CAR_VIEW_OFFSET_DEG;
    var center = [lng + d * Math.sin(b), lat + d * Math.cos(b)];
    var flyOpts = {
      center: center,
      zoom: zoom,
      pitch: pitch,
      duration: duration,
      essential: true,
      easing: function (t) { return t * (2 - t); },
    };
    flyOpts.bearing = bearing;
    map.flyTo(flyOpts);
  }

  function createCarMarkerElement(className) {
    var wrap = document.createElement('div');
    wrap.className = className;
    var img = document.createElement('img');
    img.src = 'assets/car-map-icon.png';
    img.alt = 'Car';
    img.style.display = 'block';
    img.style.pointerEvents = 'none';
    wrap.appendChild(img);
    wrap.style.transformOrigin = 'center center';
    wrap.style.transition = 'transform 0s';
    return wrap;
  }

  function setNavigationCarPosition(lng, lat, bearing, turnOffsetDeg) {
    if (!map) return;
    if (!markers.navCar) {
      const wrap = createCarMarkerElement('nav-car-marker');
      var mapboxgl = global.mapboxgl || (typeof window !== 'undefined' && window.mapboxgl);
      if (!mapboxgl) return;
      markers.navCar = new mapboxgl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
    }
    markers.navCar.setLngLat([lng, lat]);
    setCarMarkerRotation(markers.navCar, bearing, turnOffsetDeg);
    updateCarMarkerSizes();
  }

  function clearNavigationCar() {
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
    setCarMarkerRotation(markers.demoCar, bearing, turnOffsetDeg);
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
      currentStyle = document.documentElement.classList.contains('theme-light') ? 'day' : 'night';
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
