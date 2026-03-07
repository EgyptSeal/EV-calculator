/**
 * Mapbox Directions API and route drawing.
 */
(function (global) {
  const C = global.EVTripPlannerConfig;
  const mapboxToken = C?.mapbox?.accessToken;
  const base = C?.mapboxDirections?.baseUrl || 'https://api.mapbox.com/directions/v5/mapbox/driving';

  function routeFromApi(route) {
    if (!route) return null;
    const geom = route.geometry;
    let coordinates = geom?.coordinates;
    if (!coordinates || coordinates.length < 2) {
      const legs = route.legs;
      if (legs && legs.length) {
        coordinates = [];
        legs.forEach((leg) => {
          const g = leg.geometry?.coordinates;
          if (g && g.length) coordinates.push(...g);
        });
      }
    }
    if (!coordinates || coordinates.length < 2) return null;
    const distanceKm = (route.distance || 0) / 1000;
    const durationMin = (route.duration || 0) / 60;
    return {
      geometry: geom && geom.coordinates ? geom : { type: 'LineString', coordinates: coordinates },
      coordinates: coordinates,
      distanceKm,
      durationMin,
      distanceMi: distanceKm / (C?.routing?.miToKm || 1.60934),
    };
  }

  async function getRoute(coordinates) {
    const routes = await getRoutes(coordinates, false);
    return routes && routes.length ? routes[0] : null;
  }

  async function getRoutes(coordinates, alternatives = true) {
    if (!coordinates || coordinates.length < 2 || !mapboxToken || mapboxToken === 'YOUR_MAPBOX_ACCESS_TOKEN') {
      return [];
    }
    const coords = coordinates.map((c) => c.join(',')).join(';');
    const params = new URLSearchParams({
      access_token: mapboxToken,
      geometries: 'geojson',
      overview: 'full',
      alternatives: String(!!alternatives),
    });
    const url = `${base}/${coords}?${params}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const raw = data.routes || [];
    return raw.map((r) => routeFromApi(r)).filter(Boolean);
  }

  function routeToGeoJSON(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: geometry.coordinates,
      },
    };
  }

  function routeLineColor() {
    return '#00e5ff';
  }

  const ROUTE_LAYER_ID = 'ev-trip-route';

  function drawRoute(mapModule, route) {
    if (!route || !route.geometry) return;
    const geoJSON = routeToGeoJSON(route.geometry);
    const lineColor = routeLineColor();
    if (geoJSON) mapModule.addSourceAndLayer(ROUTE_LAYER_ID, geoJSON, lineColor, 5);
  }

  function drawRoutePreview(mapModule, route) {
    if (!route || !route.geometry) return;
    const geoJSON = routeToGeoJSON(route.geometry);
    const lineColor = routeLineColor();
    if (geoJSON && mapModule.drawRoutePreview) mapModule.drawRoutePreview(geoJSON, lineColor);
  }

  global.EVTripPlannerRouting = {
    getRoute,
    getRoutes,
    routeToGeoJSON,
    drawRoute,
    drawRoutePreview,
  };
})(window);
