'use strict';

(function () {
  var MOBILE_CSS = [
    './css/mobile-shell.css',
    './css/mobile-preferences.css',
    './css/pdf-mobile-controls.css'
  ];

  function ensureMobileStylesheets() {
    var head = document.head || document.documentElement;
    if (!head) return;
    for (var i = 0; i < MOBILE_CSS.length; i++) {
      var href = MOBILE_CSS[i];
      if (document.querySelector('link[data-linden-mobile-css="' + href + '"]')) continue;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-linden-mobile-css', href);
      head.appendChild(link);
    }
  }

  function isMobileEnvironment() {
    return Boolean(
      (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Android') !== -1) ||
      (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 768)
    );
  }

  try {
    var themeMode = localStorage.getItem('linden_leaf_theme_mode') || 'system';
    var savedTheme = localStorage.getItem('linden_leaf_theme');
    var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var activeTheme = (themeMode === 'manual' && savedTheme) ? savedTheme : (isDark ? 'black' : 'light');
    document.documentElement.setAttribute('data-theme', activeTheme);
    var bg = '#FAF9F5';
    if (activeTheme === 'black') bg = '#000000';
    else if (activeTheme === 'dark') bg = '#1f1f1d';
    else if (activeTheme === 'sepia') bg = '#f5eedc';
    document.documentElement.style.backgroundColor = bg;
    if (document.body) document.body.style.backgroundColor = bg;
    document.documentElement.setAttribute('data-shelf-view', 'grid');

    var rawLoc = localStorage.getItem('linden_locale');
    var hasInit = localStorage.getItem('linden_user_initialized') === 'true';
    var resolvedLocale = 'zh-CN';
    if (rawLoc) {
      var normLoc = String(rawLoc).trim().toLowerCase().replace(/_/g, '-');
      if (normLoc === 'en' || normLoc.indexOf('en-') === 0) resolvedLocale = 'en';
      else if (normLoc === 'zh' || normLoc.indexOf('zh-') === 0) resolvedLocale = 'zh-CN';
    } else if (!hasInit) {
      var navLang = (navigator.language || (navigator.languages && navigator.languages[0]) || '').toLowerCase();
      resolvedLocale = navLang && navLang.indexOf('zh') !== 0 ? 'en' : 'zh-CN';
    }
    document.documentElement.lang = resolvedLocale;
    document.documentElement.dataset.locale = resolvedLocale;
    document.title = resolvedLocale === 'en'
      ? 'Linden Leaf - Modern Universal E-Book Reader'
      : 'Linden Leaf - 现代化全格式电子书阅读器';

    if (isMobileEnvironment()) {
      document.documentElement.classList.add('is-mobile-viewport');
      ensureMobileStylesheets();
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      var onResizeForMobileCss = function () {
        if (isMobileEnvironment()) {
          document.documentElement.classList.add('is-mobile-viewport');
          ensureMobileStylesheets();
          window.removeEventListener('resize', onResizeForMobileCss);
        }
      };
      window.addEventListener('resize', onResizeForMobileCss, { passive: true });
    }

    if (window.location) {
      var searchStr = window.location.search || '';
      if (!searchStr && window.location.hash && window.location.hash.indexOf('?') !== -1) {
        searchStr = window.location.hash.substring(window.location.hash.indexOf('?'));
      }
      if (searchStr) {
        var params = new URLSearchParams(searchStr);
        if (params.get('windowMode') === 'reader') {
          document.documentElement.classList.add('satellite-reader-window');
        }
      }
    }
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    var retryBtn = document.getElementById('startup-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        location.reload();
      });
    }
  }, { once: true });

  // ES2024 Polyfills for PDF.js v5 compatibility on older WebViews
  if (typeof Response !== 'undefined' && typeof Response.prototype.bytes !== 'function') {
    Response.prototype.bytes = async function () {
      var buffer = await this.arrayBuffer();
      return new Uint8Array(buffer);
    };
  }
  if (typeof Uint8Array.prototype.toHex !== 'function') {
    Uint8Array.prototype.toHex = function () {
      var hex = '';
      for (var i = 0; i < this.length; i++) {
        hex += this[i].toString(16).padStart(2, '0');
      }
      return hex;
    };
  }
  if (typeof Uint8Array.prototype.toBase64 !== 'function') {
    Uint8Array.prototype.toBase64 = function () {
      var binary = '';
      var len = this.byteLength;
      for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(this[i]);
      }
      return btoa(binary);
    };
  }
  if (typeof Uint8Array.fromBase64 !== 'function') {
    Uint8Array.fromBase64 = function (base64) {
      var binary = atob(base64);
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };
  }
  if (typeof Map.prototype.getOrInsertComputed !== 'function') {
    Map.prototype.getOrInsertComputed = function (key, callbackFunction) {
      if (this.has(key)) return this.get(key);
      var value = callbackFunction(key);
      this.set(key, value);
      return value;
    };
  }
  if (typeof Map.prototype.getOrInsert !== 'function') {
    Map.prototype.getOrInsert = function (key, defaultValue) {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    };
  }
  if (typeof Set.prototype.intersection !== 'function') {
    Set.prototype.intersection = function (other) {
      var result = new Set();
      for (var elem of this) {
        if (other && typeof other.has === 'function' ? other.has(elem) : false) {
          result.add(elem);
        }
      }
      return result;
    };
  }
  if (typeof Set.prototype.union !== 'function') {
    Set.prototype.union = function (other) {
      var result = new Set(this);
      if (other && typeof other[Symbol.iterator] === 'function') {
        for (var elem of other) {
          result.add(elem);
        }
      }
      return result;
    };
  }
  if (typeof Set.prototype.difference !== 'function') {
    Set.prototype.difference = function (other) {
      var result = new Set(this);
      if (other && typeof other.has === 'function') {
        for (var elem of this) {
          if (other.has(elem)) result.delete(elem);
        }
      }
      return result;
    };
  }
  if (typeof Promise.try !== 'function') {
    Promise.try = function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) {
        resolve(fn.apply(null, args));
      });
    };
  }
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }
  if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function (items, callback) {
      var result = Object.create(null);
      var i = 0;
      for (var idx = 0; idx < items.length; idx++) {
        var item = items[idx];
        var key = callback(item, i++);
        if (key in result) {
          result[key].push(item);
        } else {
          result[key] = [item];
        }
      }
      return result;
    };
  }
})();
