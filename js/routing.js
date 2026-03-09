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
    const out = {
      geometry: geom && geom.coordinates ? geom : { type: 'LineString', coordinates: coordinates },
      coordinates: coordinates,
      distanceKm,
      durationMin,
      distanceMi: distanceKm / (C?.routing?.miToKm || 1.60934),
    };
    const legs = route.legs;
    if (legs && legs.length) {
      const cumulativeStepDistanceM = [0];
      const maneuvers = [];
      for (let legIdx = 0; legIdx < legs.length; legIdx++) {
        const steps = legs[legIdx].steps;
        if (!steps || !steps.length) continue;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const d = step.distance != null ? step.distance : 0;
          cumulativeStepDistanceM.push(cumulativeStepDistanceM[cumulativeStepDistanceM.length - 1] + d);
          const banner = step.banner_instructions && step.banner_instructions[0];
          const primary = banner && banner.primary ? banner.primary : null;
          const secondary = banner && banner.secondary ? banner.secondary : null;
          const sub = banner && banner.sub ? banner.sub : null;
          const text = primary && primary.text != null ? primary.text : (step.maneuver && step.maneuver.instruction ? step.maneuver.instruction : '');
          const type = (primary && primary.type) || (step.maneuver && step.maneuver.type) || 'turn';
          const modifier = (primary && primary.modifier) || (step.maneuver && step.maneuver.modifier) || 'straight';
          maneuvers.push({
            primaryText: text,
            type: type,
            modifier: modifier,
            secondaryText: secondary && secondary.text != null ? secondary.text : null,
            subText: sub && sub.text != null ? sub.text : null,
            distanceM: d,
          });
        }
      }
      if (maneuvers.length) {
        out.maneuvers = maneuvers;
        out.cumulativeStepDistanceM = cumulativeStepDistanceM;
      const segDistKm = [0];
      for (let i = 1; i < coordinates.length; i++) {
        const a = coordinates[i - 1];
        const b = coordinates[i];
        const latRad = ((a[1] + b[1]) / 2) * Math.PI / 180;
        const dlat = (b[1] - a[1]) * 111;
        const dlng = (b[0] - a[0]) * 111 * Math.cos(latRad);
        segDistKm.push(segDistKm[segDistKm.length - 1] + Math.sqrt(dlat * dlat + dlng * dlng));
      }
      const stepIndexForSegment = [];
      for (let seg = 0; seg < coordinates.length - 1; seg++) {
        const distM = segDistKm[seg] * 1000;
        let stepIdx = 0;
        for (let s = 0; s < cumulativeStepDistanceM.length - 1; s++) {
          if (distM >= cumulativeStepDistanceM[s] && distM < cumulativeStepDistanceM[s + 1]) {
            stepIdx = s;
            break;
          }
          if (s === cumulativeStepDistanceM.length - 2) stepIdx = s;
        }
        stepIndexForSegment.push(stepIdx);
      }
      out.stepIndexForSegment = stepIndexForSegment;
      out.segmentDistanceKm = segDistKm;
      }
    }
    return out;
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
      steps: 'true',
      banner_instructions: 'true',
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
