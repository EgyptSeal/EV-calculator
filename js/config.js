/**
 * EV Trip Planner - API & configuration
 * Replace MAPBOX_ACCESS_TOKEN with your own token from https://account.mapbox.com
 */
const EVTripPlannerConfig = {
  mapbox: {
    accessToken: 'pk.eyJ1IjoiaG9zc2FtaGVnYXppODUiLCJhIjoiY21tN3YxMGFtMHJqcTJwcjFjejMxM2RzZCJ9.vpxr16H3Rj31KkVQ6l3kFw',
    dayStyle: 'mapbox://styles/hossamhegazi85/cmmc5ivm7001201sc07vsf0rc',
    nightStyle: 'mapbox://styles/hossamhegazi85/cmmdjq2nx00bt01sc10jh85gf',
    defaultCenter: [31.2357, 30.0444],
    defaultZoom: 10,
    maxZoom: 18,
    minZoom: 4,
  },
  nominatim: {
    baseUrl: 'https://nominatim.openstreetmap.org',
    searchEndpoint: '/search',
    reverseEndpoint: '/reverse',
    params: { format: 'json', addressdetails: 1, limit: 8, 'accept-language': 'en,ar' },
    rateLimitMs: 1100,
  },
  openMeteo: {
    baseUrl: 'https://api.open-meteo.com/v1',
    forecastPath: '/forecast',
    params: { current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m' },
  },
  mapboxDirections: {
    baseUrl: 'https://api.mapbox.com/directions/v5/mapbox/driving',
    geometries: 'geojson',
    overview: 'full',
  },
  routing: {
    chargerSearchRadiusKm: 10,
    lowBatteryWarningPercent: 5,
    costPerKwhEGP: 4.5,
    /** DC fast charging rate (EGP per kWh) – 2026 Egypt. Update with actual rate. */
    dcFastCostPerKwhEGP: 6.5,
    /** Egypt charging stations max power (kW) – used for charge time calculation. */
    maxChargerKwEgypt: 50,
    miToKm: 1.60934,
  },
  defaults: {
    startBatteryPercent: 100,
    targetBatteryPercent: 20,
    cabinTempC: 24,
    passengers: 1,
    acOn: true,
    luggageKg: 0,
    maxSpeedKmh: 120,
    drivingMode: 'standard',
  },
};

// Export for modules
window.EVTripPlannerConfig = EVTripPlannerConfig;
