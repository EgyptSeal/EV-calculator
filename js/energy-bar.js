/**
 * Energy progress bar: car position along route, predicted battery %, low battery warning.
 */
(function (global) {
  const Trip = global.EVTripPlannerTrip;

  function updateBar(container, options) {
    if (!container) return;
    const {
      currentBatteryPercent = 82,
      predictedEndPercent = 20,
      tripProgress = 0,
      chargeStops = [],
      lowBatteryPercent = 5,
      showWarning = false,
      zeroPointProgress = 100,
      effectiveRangeKm = 0,
      routeDistanceKm = 1,
      onChargeStopClick = null,
    } = options;

    const fillEl = container.querySelector('.energy-bar-fill');
    const carEl = container.querySelector('.energy-bar-car');
    const startLabel = container.querySelector('.energy-progress-start');
    const warningEl = container.querySelector('.energy-bar-warning');
    const redSeg = container.querySelector('.energy-bar-red-segment');
    const zeroPinWrap = container.querySelector('.energy-bar-zero-pin-wrap');
    const zeroPin = container.querySelector('.energy-bar-zero-pin');
    const chargePinsEl = container.querySelector('.energy-bar-charge-pins') || document.getElementById('energyBarChargePins');

    var startPct = options.currentBatteryPercent != null ? options.currentBatteryPercent : 100;
    var predictedPct = predictedEndPercent != null ? predictedEndPercent : 20;
    /* Zero pin: exact route progress where battery hits 0%. Green from start to zero point, red from zero point to end. */
    var zeroPinPos = zeroPointProgress != null ? Math.max(0, Math.min(100, zeroPointProgress)) : 100;
    var showRed = zeroPinPos < 100;
    if (zeroPointProgress == null && routeDistanceKm > 0 && effectiveRangeKm > 0 && effectiveRangeKm < routeDistanceKm) {
      zeroPinPos = Math.max(0, Math.min(100, (effectiveRangeKm / routeDistanceKm) * 100));
      showRed = true;
    } else if (zeroPointProgress == null && predictedPct < startPct) {
      var denom = startPct - predictedPct;
      if (denom > 0) {
        zeroPinPos = Math.max(0, Math.min(100, (startPct * 100) / denom));
        showRed = true;
      }
    }

    if (fillEl) {
      fillEl.style.width = (showRed ? zeroPinPos : 100) + '%';
      fillEl.classList.toggle('low', false);
    }
    if (carEl) {
      carEl.style.left = (tripProgress * 100).toFixed(1) + '%';
      carEl.classList.toggle('moving', tripProgress > 0.01 && tripProgress < 0.99);
    }
    if (startLabel) startLabel.textContent = (currentBatteryPercent != null ? currentBatteryPercent : 82) + '%';
    if (redSeg) {
      redSeg.style.left = zeroPinPos.toFixed(1) + '%';
      redSeg.style.width = (100 - zeroPinPos).toFixed(1) + '%';
      redSeg.style.display = showRed ? 'block' : 'none';
    }
    if (zeroPinWrap) {
      zeroPinWrap.classList.toggle('visible', showRed);
    }
    if (zeroPin) {
      zeroPin.style.left = zeroPinPos.toFixed(4) + '%';
    }
    if (chargePinsEl) {
      chargePinsEl.innerHTML = '';
      (chargeStops || []).forEach(function (stop) {
        var pct = (stop.progress != null ? stop.progress : 0) * 100;
        var wrap = document.createElement('div');
        wrap.className = 'energy-bar-charge-pin-wrap';
        wrap.style.left = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
        wrap.title = (stop.name || 'Charging stop') + (onChargeStopClick ? ' (click to remove)' : '');
        var waitText = '';
        if (stop.waitingTimeMin != null && stop.waitingTimeMin > 0) {
          var wh = Math.floor(stop.waitingTimeMin / 60);
          var wm = Math.round(stop.waitingTimeMin % 60);
          var waitStr = wh && wm ? wh + 'H, ' + wm + 'M' : wh ? wh + 'H' : wm + 'M';
          waitText = '<span class="energy-bar-charge-wait">~' + waitStr + '</span>';
        }
        wrap.innerHTML = '<div class="energy-bar-charge-pin"></div><span class="energy-bar-charge-pin-label">' + (stop.name || 'Charging Station') + '</span>' + waitText;
        if (onChargeStopClick && stop.lng != null && stop.lat != null) {
          wrap.style.pointerEvents = 'auto';
          wrap.style.cursor = 'pointer';
          wrap.addEventListener('click', function () { onChargeStopClick(stop.lng, stop.lat); });
        }
        chargePinsEl.appendChild(wrap);
      });
    }
    if (warningEl) {
      warningEl.style.display = (showWarning || showRed) && !showRed ? 'block' : 'none';
      warningEl.style.left = zeroPinPos.toFixed(1) + '%';
    }
  }

  function carIconSVG() {
    return '<svg viewBox="0 0 56 36" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="evCarTopBlack" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" style="stop-color:#2a2a2a"/><stop offset="40%" style="stop-color:#0a0a0a"/><stop offset="100%" style="stop-color:#000"/></linearGradient><linearGradient id="evCarSideBlack" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#000"/><stop offset="100%" style="stop-color:#1a1a1a"/></linearGradient><filter id="evCarShadow3d"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#000" flood-opacity="0.8"/><feDropShadow dx="0" dy="1" stdDeviation="0.5" flood-color="#333"/></filter></defs><g filter="url(#evCarShadow3d)"><path fill="url(#evCarTopBlack)" d="M10 12h36l-5-8H15L10 12z" stroke="#111" stroke-width="0.8"/><path fill="url(#evCarSideBlack)" d="M6 16h44v8H6z" stroke="#0a0a0a" stroke-width="0.6"/><g class="car-wheel" style="transform-box:fill-box;transform-origin:center"><circle cx="16" cy="26" r="3.5" fill="#0a0a0a" stroke="#333" stroke-width="1"/></g><g class="car-wheel" style="transform-box:fill-box;transform-origin:center"><circle cx="40" cy="26" r="3.5" fill="#0a0a0a" stroke="#333" stroke-width="1"/></g></g></svg>';
  }

  global.EVTripPlannerEnergyBar = {
    updateBar,
    carIconSVG,
  };
})(window);
