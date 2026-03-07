/**
 * Place search: Nominatim (OSM) + Mapbox Geocoding for Egypt.
 * Nominatim requires a valid User-Agent header or returns 403.
 */
(function (global) {
  const Nominatim = global.EVTripPlannerConfig?.nominatim || {};
  const MapboxC = global.EVTripPlannerConfig?.mapbox || {};
  const nominatimBase = Nominatim.baseUrl || 'https://nominatim.openstreetmap.org';
  const rateLimitMs = Nominatim.rateLimitMs || 1100;
  const userAgent = 'EVTripPlanner/1.0 (Egypt EV Navigation)';
  let lastNominatim = 0;
  let lastMapbox = 0;

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function searchNominatim(query, limit) {
    try {
      const now = Date.now();
      const wait = rateLimitMs - (now - lastNominatim);
      if (wait > 0) await delay(wait);
      lastNominatim = Date.now();
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        addressdetails: 1,
        limit: limit || 20,
        'accept-language': 'en,ar',
        countrycodes: 'eg',
      });
      const url = `${nominatimBase}/search?${params}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).map((item) => ({
        display_name: item.display_name,
        name: item.name || item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        type: item.type,
        address: item.address || {},
      }));
    } catch (e) {
      return [];
    }
  }

  async function searchMapbox(query, limit) {
    try {
      const token = MapboxC.accessToken;
      if (!token || token === 'YOUR_MAPBOX_ACCESS_TOKEN') return [];
      const now = Date.now();
      if (now - lastMapbox < 100) await delay(100);
      lastMapbox = Date.now();
      const params = new URLSearchParams({
        access_token: token,
        country: 'EG',
        limit: limit || 15,
        types: 'address,place,poi,locality,neighborhood,region',
      });
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      if (data.message || !data.features) return [];
      return (data.features || []).map((f) => {
        const c = f.geometry?.coordinates || [];
        if (!c[0] || !c[1]) return null;
        return {
          display_name: f.place_name || f.text || '',
          name: f.text || f.place_name || '',
          lat: c[1],
          lng: c[0],
          type: (f.place_type && f.place_type[0]) || 'place',
          address: f.context || {},
        };
      }).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  async function search(query, options = {}) {
    const limit = options.limit || 20;
    const fromNominatim = searchNominatim(query, limit);
    const fromMapbox = searchMapbox(query, Math.min(15, limit));
    const [nominatimRes, mapboxRes] = await Promise.all([fromNominatim, fromMapbox]);
    const seen = {};
    const combined = [];
    function add(r) {
      if (!r || r.lat == null || r.lng == null) return;
      const key = Number(r.lat).toFixed(4) + ',' + Number(r.lng).toFixed(4);
      if (!seen[key]) {
        seen[key] = true;
        combined.push(r);
      }
    }
    (nominatimRes || []).forEach(add);
    (mapboxRes || []).forEach(add);
    return combined.slice(0, limit);
  }

  async function reverse(lat, lng) {
    const params = new URLSearchParams({
      lat,
      lon: lng,
      format: 'json',
      addressdetails: 1,
      'accept-language': 'en,ar',
    });
    const url = `${nominatimBase}/reverse?${params}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  global.EVTripPlannerSearch = {
    search,
    reverse,
    debounce,
  };
})(window);
