/**
 * Open-Meteo API for weather and wind. Used for default temp and range impact.
 */
(function (global) {
  const C = global.EVTripPlannerConfig?.openMeteo || {};
  const base = C.baseUrl || 'https://api.open-meteo.com/v1';
  const params = { ...C.params, timezone: 'Africa/Cairo' };

  function buildUrl(lat, lng) {
    const q = new URLSearchParams({
      latitude: lat,
      longitude: lng,
      ...params,
    });
    return `${base}/forecast?${q}`;
  }

  async function fetchWeather(lat, lng) {
    const url = buildUrl(lat, lng);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Weather fetch failed');
    const data = await res.json();
    const c = data.current || {};
    return {
      temperature_2m: c.temperature_2m ?? 25,
      relative_humidity_2m: c.relative_humidity_2m ?? 50,
      weather_code: c.weather_code ?? 0,
      wind_speed_10m: c.wind_speed_10m ?? 0,
      wind_direction_10m: c.wind_direction_10m ?? 0,
    };
  }

  function weatherCodeToLabel(code) {
    const map = {
      0: 'Clear Skies',
      1: 'Mainly Clear',
      2: 'Partly Cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Foggy',
      51: 'Drizzle',
      61: 'Rain',
      71: 'Snow',
      80: 'Rain Showers',
      95: 'Thunderstorm',
    };
    return map[code] || 'Clear Skies';
  }

  function celsiusToF(c) {
    return Math.round((c * 9) / 5 + 32);
  }

  global.EVTripPlannerWeather = {
    fetchWeather,
    weatherCodeToLabel,
    celsiusToF,
  };
})(window);
