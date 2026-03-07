/**
 * Load EV and charger databases. Fetches from data/; use a local server (e.g. npx serve) for fetch to work.
 */
(function () {
  const DATA_BASE = 'data/';
  let evDatabase = (window.__EV_DATABASE_EMBEDDED && typeof window.__EV_DATABASE_EMBEDDED === 'object') ? window.__EV_DATABASE_EMBEDDED : { vehicles: [], range_conversion_notes: {} };
  let chargerDatabase = (window.__CHARGER_DATABASE_EMBEDDED && typeof window.__CHARGER_DATABASE_EMBEDDED === 'object') ? window.__CHARGER_DATABASE_EMBEDDED : { chargers: [] };

  function loadJSON(path) {
    const useEmbedded = path.indexOf('ev') !== -1 ? window.__EV_DATABASE_EMBEDDED : window.__CHARGER_DATABASE_EMBEDDED;
    return fetch(DATA_BASE + path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(path))))
      .catch(() => useEmbedded || null);
  }

  window.EVTripPlannerData = {
    ready: Promise.all([
      loadJSON('ev_database.json').then((data) => {
        if (data && data.vehicles && data.vehicles.length) evDatabase = data;
        else if (window.__EV_DATABASE_EMBEDDED) evDatabase = window.__EV_DATABASE_EMBEDDED;
        return evDatabase;
      }),
      loadJSON('charger_database.json').then((data) => {
        if (data && data.chargers && data.chargers.length) chargerDatabase = data;
        else if (window.__CHARGER_DATABASE_EMBEDDED) chargerDatabase = window.__CHARGER_DATABASE_EMBEDDED;
        return chargerDatabase;
      }),
    ]).then(() => ({ evDatabase, chargerDatabase })),

    getEVDatabase() {
      return evDatabase;
    },
    getChargerDatabase() {
      return chargerDatabase;
    },
  };
})();
