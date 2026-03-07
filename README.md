# EV Trip Planner – Egypt

Production-grade EV trip planning and live range estimation web app for Egypt, with a premium futuristic UI matching the provided blueprint.

## Run locally

1. **With a local server (recommended)**  
   From the project root:
   ```bash
   npx serve ev-trip-planner
   ```
   Then open `http://localhost:3000` (or the URL shown). This allows:
   - Loading `data/ev_database.json` and `data/charger_database.json`
   - Mapbox map and routing
   - Nominatim search and Open-Meteo weather

2. **Without a server (file://)**  
   Open `ev-trip-planner/index.html` in the browser. Vehicle and charger data are loaded from `data/embedded.js`. Map and routing still require a valid **Mapbox access token** (see below). **Note:** Location search (Nominatim + Mapbox) will not work when opened via file:// due to CORS; use a local server for search.

## API configuration

Edit **`js/config.js`**:

| Setting | Description |
|--------|-------------|
| **Mapbox** | Set `mapbox.accessToken` to your [Mapbox](https://account.mapbox.com) token. Required for map and routing. |
| **Nominatim** | Used as-is (OpenStreetMap). Respect 1 request/second. |
| **Open-Meteo** | No API key; used for weather and default temperature. |
| **Chargers** | From `data/charger_database.json` (or embedded fallback). |

Example:

```js
mapbox: {
  accessToken: 'pk.your_mapbox_public_token_here',
  dayStyle: 'mapbox://styles/hossamhegazi85/cmmc5ivm7001201sc07vsf0rc',
  nightStyle: 'mapbox://styles/hossamhegazi85/cmmdjq2nx00bt01sc10jh85gf',
  // ...
}
```

## Structure

- **index.html** – Single-page app (modal + main map screen).
- **css/styles.css** – Blueprint-aligned layout and styling.
- **js/config.js** – API and app defaults.
- **js/data-loader.js** – Loads EV and charger data (fetch + embedded fallback).
- **js/weather.js** – Open-Meteo.
- **js/search.js** – Nominatim (EN/AR, Egypt).
- **js/map.js** – Mapbox GL, day/night, geolocation, fit bounds.
- **js/routing.js** – Mapbox Directions, route drawing.
- **js/trip.js** – EPA-style range, energy, charging stops.
- **js/chargers.js** – Chargers near route (7 km).
- **js/energy-bar.js** – Progress bar and low-battery warning.
- **js/ui.js** – Modal, search dropdowns, panels, bottom bar.
- **js/app.js** – Startup flow and wiring.
- **data/ev_database.json** – EV list (BYD and others, EPA-style range).
- **data/charger_database.json** – Egypt chargers (expandable).
- **data/embedded.js** – Fallback data for file://.

## EV database

- **BYD**: Song L 662 km, Song Plus EV, Dolphin, Seal, Han, Atto 3.
- **Others**: Tesla Model 3/Y, NIO ET5, Geely Geometry C, MG4, Zeekr 001.
- **Range**: CLTC/NEDC converted to EPA-style (CLTC × 0.71). `estimated_epa_range_km` and weight used for trip energy.

## Charger database

- Base set: Infinity, Revolta, Ikarus, Sha7en (Cairo, New Cairo, 6th October).
- Fields: name, name_ar, network, lat, lng, type, power_kw, connectors.
- Chargers within 7 km of the route are shown on the map and in the side panel.

## Tech stack

- **Map**: Mapbox GL JS (your day/night styles).
- **Routing**: Mapbox Directions API.
- **Search**: Nominatim (EN + AR, Egypt).
- **Weather**: Open-Meteo.
- **Data**: Local JSON + embedded fallback.

All behavior is implemented in vanilla HTML/CSS/JS; no build step required.
