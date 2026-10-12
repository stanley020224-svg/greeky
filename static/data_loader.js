/* Greeky 靜態版 — 資料載入器
 * 把 data/*.js（載入即寫入 window.__GD）用 <script> 動態載入。
 * 用 <script> 而非 fetch，所以「雙擊 index.html」（file://）也能用；
 * 掛在 GitHub Pages 時文字檔一樣會被 gzip。
 * greeky_core.js 會呼叫 window.__gdata(name) 取得資料。
 */
(function (global) {
  'use strict';
  var BASE = 'data';
  var cache = {};

  function loadScript(name) {
    if (cache[name]) return cache[name];
    cache[name] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = BASE + '/' + name + '.js';
      s.async = false;
      s.onload = function () {
        resolve(global.__GD ? global.__GD[name] : undefined);
      };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return cache[name];
  }

  global.__gdata = function (name) { return loadScript(name); };
  global.__gdataBase = function (b) { if (b) BASE = b; return BASE; };
})(window);
