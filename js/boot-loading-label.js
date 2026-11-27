'use strict';

(function () {
  if (document.documentElement && document.documentElement.dataset.locale === 'en') {
    var lbl = document.getElementById('startup-loading-label');
    var rty = document.getElementById('startup-retry');
    if (lbl) lbl.textContent = 'Opening…';
    if (rty) rty.textContent = 'Reopen';
  }
})();
