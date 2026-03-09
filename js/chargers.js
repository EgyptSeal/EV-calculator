/**
 * Chargers within radius of route from local JSON dataset.
 */
(function (global) {
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function pointToSegmentDistanceKm(px, py, x1, y1, x2, y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = lenSq !== 0 ? dot / lenSq : -1;
    param = Math.max(0, Math.min(1, param));
    const xx = x1 + param * C;
    const yy = y1 + param * D;
    return haversineKm(py, px, yy, xx);
  }

  function chargersNearRoute(chargers, routeCoordinates, radiusKm) {
    if (!chargers || !routeCoordinates || routeCoordinates.length < 2) return [];
    const radius = radiusKm ?? 7;
    const results = [];
    for (let i = 0; i < chargers.length; i++) {
      const c = chargers[i];
      let minDist = Infinity;
      for (let j = 0; j < routeCoordinates.length - 1; j++) {
        const [lng1, lat1] = routeCoordinates[j];
        const [lng2, lat2] = routeCoordinates[j + 1];
        const d = pointToSegmentDistanceKm(c.lng, c.lat, lng1, lat1, lng2, lat2);
        if (d < minDist) minDist = d;
      }
      if (minDist <= radius) {
        results.push({ ...c, distanceFromRouteKm: Math.round(minDist * 10) / 10 });
      }
    }
    results.sort((a, b) => a.distanceFromRouteKm - b.distanceFromRouteKm);
    return results;
  }

  function distanceFromRouteKm(routeCoordinates, lng, lat) {
    if (!routeCoordinates || routeCoordinates.length < 2) return Infinity;
    let minDist = Infinity;
    for (let j = 0; j < routeCoordinates.length - 1; j++) {
      const [lng1, lat1] = routeCoordinates[j];
      const [lng2, lat2] = routeCoordinates[j + 1];
      const d = pointToSegmentDistanceKm(lng, lat, lng1, lat1, lng2, lat2);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  /** Distance in km from route start to the point on the route closest to (lng, lat). */
  function distanceAlongRouteToPointKm(routeCoordinates, lng, lat) {
    if (!routeCoordinates || routeCoordinates.length < 2) return 0;
    let bestParam = 0;
    let bestSegmentIndex = 0;
    let minDist = Infinity;
    for (let j = 0; j < routeCoordinates.length - 1; j++) {
      const [lng1, lat1] = routeCoordinates[j];
      const [lng2, lat2] = routeCoordinates[j + 1];
      const A = lng - lng1;
      const B = lat - lat1;
      const C = lng2 - lng1;
      const D = lat2 - lat1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = lenSq !== 0 ? dot / lenSq : 0;
      param = Math.max(0, Math.min(1, param));
      const xx = lng1 + param * C;
      const yy = lat1 + param * D;
      const d = haversineKm(lat, lng, yy, xx);
      if (d < minDist) {
        minDist = d;
        bestParam = param;
        bestSegmentIndex = j;
      }
    }
    let distKm = 0;
    for (let j = 0; j < bestSegmentIndex; j++) {
      const [x1, y1] = routeCoordinates[j];
      const [x2, y2] = routeCoordinates[j + 1];
      distKm += haversineKm(y1, x1, y2, x2);
    }
    const [lng1, lat1] = routeCoordinates[bestSegmentIndex];
    const [lng2, lat2] = routeCoordinates[bestSegmentIndex + 1];
    const latProj = lat1 + bestParam * (lat2 - lat1);
    const lngProj = lng1 + bestParam * (lng2 - lng1);
    distKm += haversineKm(lat1, lng1, latProj, lngProj);
    return distKm;
  }

  /** Project (lng, lat) onto route; return projected point and distances. Use snapped position for car (within margin). */
  function projectOntoRoute(routeCoordinates, lng, lat) {
    if (!routeCoordinates || routeCoordinates.length < 2) return { lng: lng, lat: lat, distanceAlongKm: 0, distanceFromRouteKm: 0 };
    let bestParam = 0;
    let bestSegmentIndex = 0;
    let minDist = Infinity;
    for (let j = 0; j < routeCoordinates.length - 1; j++) {
      const [lng1, lat1] = routeCoordinates[j];
      const [lng2, lat2] = routeCoordinates[j + 1];
      const A = lng - lng1;
      const B = lat - lat1;
      const C = lng2 - lng1;
      const D = lat2 - lat1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = lenSq !== 0 ? dot / lenSq : 0;
      param = Math.max(0, Math.min(1, param));
      const xx = lng1 + param * C;
      const yy = lat1 + param * D;
      const d = haversineKm(lat, lng, yy, xx);
      if (d < minDist) {
        minDist = d;
        bestParam = param;
        bestSegmentIndex = j;
      }
    }
    let distKm = 0;
    for (let j = 0; j < bestSegmentIndex; j++) {
      const [x1, y1] = routeCoordinates[j];
      const [x2, y2] = routeCoordinates[j + 1];
      distKm += haversineKm(y1, x1, y2, x2);
    }
    const [lng1, lat1] = routeCoordinates[bestSegmentIndex];
    const [lng2, lat2] = routeCoordinates[bestSegmentIndex + 1];
    const latProj = lat1 + bestParam * (lat2 - lat1);
    const lngProj = lng1 + bestParam * (lng2 - lng1);
    distKm += haversineKm(lat1, lng1, latProj, lngProj);
    return { lng: lngProj, lat: latProj, distanceAlongKm: distKm, distanceFromRouteKm: minDist };
  }

  /** Get [lng, lat] at distanceKm along the route (for smooth interpolation). */
  function getPointAlongRoute(routeCoordinates, distanceKm) {
    if (!routeCoordinates || routeCoordinates.length < 2 || distanceKm <= 0) return routeCoordinates[0].slice();
    let acc = 0;
    for (let j = 0; j < routeCoordinates.length - 1; j++) {
      const [lng1, lat1] = routeCoordinates[j];
      const [lng2, lat2] = routeCoordinates[j + 1];
      const segKm = haversineKm(lat1, lng1, lat2, lng2);
      if (acc + segKm >= distanceKm) {
        const t = segKm > 0 ? (distanceKm - acc) / segKm : 0;
        return [lng1 + t * (lng2 - lng1), lat1 + t * (lat2 - lat1)];
      }
      acc += segKm;
    }
    return routeCoordinates[routeCoordinates.length - 1].slice();
  }

  global.EVTripPlannerChargers = {
    chargersNearRoute,
    haversineKm,
    distanceFromRouteKm,
    distanceAlongRouteToPointKm,
    projectOntoRoute,
    getPointAlongRoute,
  };
})(window);
