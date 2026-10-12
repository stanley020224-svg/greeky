/* Greeky 靜態版 — 後端 API 墊片（純前端）
 * 攔截所有 fetch('/api/…')，改用 GCore（移植自 server.py 的邏輯）+ 瀏覽器儲存。
 * 原 app.js / outline.js 不需修改即可運作。
 *
 * 儲存：localStorage（file:// 與 GitHub Pages 皆可用）
 *   greeky:autosave        目前編輯中的專案
 *   greeky:autosave.prev   上一版備份
 *   greeky:proj:<name>     具名專案
 * 匯出：把列印版面渲染到 #printRoot（螢幕外），再呼叫 window.print() → 另存 PDF。
 */
(function (global) {
  'use strict';
  var G = global.GCore;
  var ORIG_FETCH = global.fetch;
  global.__origFetch = ORIG_FETCH;

  var LS = global.localStorage;
  var K_AUTO = 'greeky:autosave';
  var K_PREV = 'greeky:autosave.prev';
  var K_PROJ = 'greeky:proj:';
  var K_PREV_P = 'greeky:projprev:';

  function lsGet(k) { try { var v = LS.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }
  function lsSet(k, v) { try { LS.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { LS.removeItem(k); } catch (e) {} }

  // ---------- 譯本登錄 ----------
  var TRANS = [
    { key: 'cuv', name: '和合本', short: '和合本', file: 'cuv', lang: 'zh', note: '和合本（繁體）；公眾領域' },
    { key: 'occb', name: '當代譯本', short: '當代', file: 'trans_occb', lang: 'zh', note: 'Biblica® 聖經，當代譯本開放資源（繁體）；CC BY-SA 4.0' },
    { key: 'asv', name: 'ASV 譯本', short: 'ASV', file: 'trans_asv', lang: 'en', note: 'American Standard Version (1901)；公眾領域' }
  ];
  var TRANS_MAP = {};
  TRANS.forEach(function (t) { TRANS_MAP[t.key] = t; });
  var dummies = { cuv: 'cuv', occb: 'trans_occb', asv: 'trans_asv' };

  // ---------- Response 替身 ----------
  function jsonResp(obj, code) {
    var body = JSON.stringify(obj == null ? null : obj);
    return {
      ok: (code || 200) < 400, status: code || 200,
      json: function () { return Promise.resolve(JSON.parse(body)); },
      text: function () { return Promise.resolve(body); }
    };
  }

  // ---------- 路由實作 ----------
  function q(u) {
    var o = {}; var s = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
    s.split('&').forEach(function (kv) {
      if (!kv) return; var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
      o[k] = v;
    });
    return o;
  }
  function intOf(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }

  function getRoute(path) {
    var u = path, qq = q(path), p = path.split('?')[0];
    if (p === '/api/health') return Promise.resolve(jsonResp({ ok: true, app: 'greek-analysis', mode: 'static' }));
    if (p === '/api/relations') return G.load('relations').then(function (r) { return jsonResp(r || []); });
    if (p === '/api/proper') return G.load('proper').then(function (r) { return jsonResp(r || { forms: {}, capforms: {} }); });
    if (p === '/api/books') return Promise.all([G.load('books'), G.load('connectives')]).then(function (a) {
      return jsonResp({ ok: true, books: a[0], connectives: a[1] || {} });
    });
    if (p === '/api/passage') return G.loadPassage(qq.book, qq.ch || '1', qq.v1 || '1', qq.v2 || '').then(jsonResp);
    if (p === '/api/cuv') {
      return G.load('cuv').then(function (cuvData) {
        var ch = intOf(qq.ch, 1), v1 = intOf(qq.v1, 1), v2 = intOf(qq.v2, v1);
        if (v2 < v1) { var t = v1; v1 = v2; v2 = t; }
        var vs = G.cuvVerses(cuvData, qq.book, ch, v1, v2);
        return jsonResp({ ok: !!vs.length, verses: vs, name: '和合本' });
      });
    }
    if (p === '/api/ognt') {
      return G.load('ognt/' + (G.bookBy(qq.book) || {}).code).then(function (bk) {
        var ch = intOf(qq.ch, 1), v1 = intOf(qq.v1, 1), v2 = intOf(qq.v2, v1);
        if (v2 < v1) { var t = v1; v1 = v2; v2 = t; }
        var out = [];
        for (var v = v1; v <= v2; v++) {
          var items = (bk || {})[((G.bookBy(qq.book) || {}).code) + '|' + ch + '|' + v];
          if (items) out.push({ v: v, items: items });
        }
        return jsonResp({ ok: !!out.length, verses: out, name: '和合本' });
      });
    }
    if (p === '/api/translations') {
      return Promise.resolve(jsonResp({ ok: true, items: TRANS.map(function (t) {
        return { key: t.key, name: t.name, short: t.short, lang: t.lang, note: t.note, available: true };
      }) }));
    }
    if (p === '/api/translation') {
      var t = TRANS_MAP[qq.key] || TRANS_MAP.cuv;
      return G.load(t.file).then(function (data) {
        var ch = intOf(qq.ch, 1), v1 = intOf(qq.v1, 1), v2 = intOf(qq.v2, v1);
        if (v2 < v1) { var w = v1; v1 = v2; v2 = w; }
        var vs = G.transVerses(data, qq.book, ch, v1, v2);
        return jsonResp({ ok: !!vs.length, verses: vs, key: t.key, name: t.name, note: t.note });
      });
    }
    if (p === '/api/morph') return Promise.all([G.load('morph'), G.load('lexicon'), G.load('gloss')])
      .then(function () { return jsonResp(G.lookupWord(qq.w || '')); });
    if (p === '/api/lexicon') {
      return G.load('lexicon').then(function (lex) {
        var key = qq.l || '';
        return jsonResp(lex[key] || lex[G.stripAccents(key)] || {});
      });
    }
    if (p === '/api/projects') {
      var items = [];
      try {
        for (var i = 0; i < LS.length; i++) {
          var k = LS.key(i);
          if (k && k.indexOf(K_PROJ) === 0) {
            var nm = k.slice(K_PROJ.length);
            var d = lsGet(k) || {};
            var m = d.meta || {};
            items.push({ name: nm, mtime: d.__mtime || 0, size: k.length,
              book: m.book || '', ch: m.ch || '', from: m.from || '', to: m.to || '',
              nodes: (d.nodes || []).length, rels: (d.rels || []).length });
          }
        }
      } catch (e) {}
      items.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
      return Promise.resolve(jsonResp({ items: items, folder: '', exports: '' }));
    }
    if (p === '/api/project') {
      var data = lsGet(K_PROJ + (qq.name || ''));
      return Promise.resolve(data == null
        ? jsonResp({ ok: false, error: '找不到專案' }, 404)
        : jsonResp({ ok: true, project: data }));
    }
    if (p === '/api/autosave') {
      var d = lsGet(K_AUTO);
      return Promise.resolve(jsonResp({ ok: !!d, project: d }));
    }
    if (p === '/api/printdata') return Promise.resolve(jsonResp({ ok: false, error: 'token expired' }, 404));
    return null; // 未知 → 交回原生 fetch
  }

  function postRoute(path, body) {
    var p = path.split('?')[0];
    if (p === '/api/split') {
      var clauses = G.autoSplit(body.text || '', !!body.comma, !!body.verse, !!body.prep, !!body.mid);
      if (body.lead) {
        clauses = clauses.map(function (c) {
          var fc = body.front ? G.frontConnectives(c.text) : [c.text, G.markConnectives(c.text)[1]];
          var lead = G.markConnectives(fc[0])[0];
          var o = {}; for (var kk in c) o[kk] = c[kk];
          o.text = fc[0]; o.lead = lead; o.conn = fc[1];
          return o;
        });
      }
      return Promise.resolve(jsonResp({ ok: true, clauses: clauses }));
    }
    if (p === '/api/verbmarks') {
      var proj = body.project || {};
      return Promise.all([G.load('morph'), G.load('kinds'), G.load('preps')]).then(function () {
        var marks = {}, preps = {};
        (proj.nodes || []).forEach(function (n) {
          if (!n || !n.id) return;
          var mk = G.markWordsAll(n.text || '');
          if (mk && mk.length) marks[n.id] = mk;
          var pw = G.nodeIsPrep(n.text || '');
          if (pw) preps[n.id] = pw;
        });
        return jsonResp({ ok: true, marks: marks, preps: preps });
      });
    }
    if (p === '/api/cuvorder') {
      var proj2 = body.project || {};
      var code = (proj2.meta || {}).code;
      return G.load('ognt/' + code).then(function (bk) {
        var res = G.cuvInGreekOrder(proj2, bk || {});
        res.ok = true;
        return jsonResp(res);
      }).catch(function () {
        var res = G.cuvInGreekOrder(proj2, {});
        res.ok = true; return jsonResp(res);
      });
    }
    if (p === '/api/save') {
      var name = body.name || '未命名';
      var pr = body.project || {};
      pr.__mtime = Date.now();
      lsSet(K_PROJ + name, pr);
      return Promise.resolve(jsonResp({ ok: true, path: K_PROJ + name, name: name }));
    }
    if (p === '/api/autosave') {
      var old = LS.getItem(K_AUTO);
      var newP = body.project || {};
      if (old != null) {
        try { if (JSON.stringify(JSON.parse(old)) !== JSON.stringify(newP)) LS.setItem(K_PREV, old); }
        catch (e) { LS.setItem(K_PREV, old); }
      }
      var okSet = lsSet(K_AUTO, newP);
      return Promise.resolve(jsonResp({ ok: okSet }));
    }
    if (p === '/api/delete') {
      lsDel(K_PROJ + (body.name || ''));
      return Promise.resolve(jsonResp({ ok: true }));
    }
    if (p === '/api/export') {
      try { exportPDF(body.project || body || {}, body.name || ''); }
      catch (e) { return Promise.resolve(jsonResp({ ok: false, error: String(e) })); }
      return Promise.resolve(jsonResp({ ok: true, path: '瀏覽器列印（另存為 PDF）' }));
    }
    if (p === '/api/shutdown') return Promise.resolve(jsonResp({ ok: true }));
    if (p === '/api/reveal' || p === '/api/open') return Promise.resolve(jsonResp({ ok: false, error: '靜態版沒有本機檔案系統' }));
    return null;
  }

  // ---------- 匯出（瀏覽器列印） ----------
  function ensurePrintRoot() {
    var r = document.getElementById('printRoot');
    if (!r) {
      r = document.createElement('div');
      r.id = 'printRoot';
      document.body.appendChild(r);
    }
    return r;
  }
  function printOpts(project, relmap, marks, preps, properOn) {
    var m = project.meta || {};
    var cuvMap = {};
    ((m.cuv && m.cuv.map) || []).forEach(function (x, i) { cuvMap[i] = x; });
    var cuvOn = !!(m.cuv && m.cuv.on);
    var marksSet = m.marks || {};
    function markFilter(k) {
      if (!k) return false;
      if (k === 'V' || k === 'T' || k === 'N') return (marksSet.verb !== undefined ? !!marksSet.verb : !!marksSet.on);
      if (k.charAt(0) === 'c') return !!marksSet.noun;
      if (k.charAt(0) === 'j') return !!marksSet.adj;
      return false;
    }
    function properKind(w) {
      if (!properOn || !w) return '';
      var k = G.stripAccents(w);
      var P = global.__GD.proper || { forms: {}, capforms: {} };
      if (P.forms && P.forms[k]) return P.forms[k];
      if (P.capforms && P.capforms[k]) {
        var ch = String(w).charAt(0);
        if (ch && ch !== ch.toLowerCase()) return P.capforms[k];
      }
      return '';
    }
    return {
      front: !!m.front, connectives: G.connectives(), textLeftPt: 172.88,
      lineWidth: 0.4, lineColor: '#000', labelScale: 0.73,
      marks: marks || {}, markFilter: markFilter, prepOf: preps || {},
      properKind: properOn ? properKind : null,
      relation: function (id) { return relmap[id] || null; },
      cuv: cuvOn ? function (n, i) { return cuvMap[i] || ''; } : null,
      cuvWords: cuvOn ? function (n, i) { return (m.cuv && m.cuv.words && m.cuv.words[i]) || null; } : null,
      cuvTitle: (m.cuv && m.cuv.name) || '和合本',
      runStyles: true,
      gkTitle: (m.version || '原文') + ' 原文'
    };
  }

  function exportPDF(project, name) {
    Promise.all([G.load('relations'), G.load('morph'), G.load('kinds'), G.load('proper'),
                 G.load('preps'), G.load('connectives')]).then(function () {
      // 開了和合本 → 依原文語序重算（與伺服器一致）
      var chain = Promise.resolve();
      if (project.meta && project.meta.cuv && project.meta.cuv.on) {
        chain = G.load('ognt/' + (project.meta.code || '')).then(function (bk) {
          var res = G.cuvInGreekOrder(project, bk || {});
          project.meta.cuv.map = res.map; project.meta.cuv.matched = res.matched;
          project.meta.cuv.total = res.total; project.meta.cuv.words = res.words;
        });
      }
      return chain;
    }).then(function () {
      var relmap = {}; (global.__GD.relations || []).forEach(function (x) { relmap[x.id] = x; });
      var marks = {}, preps = {};
      (project.nodes || []).forEach(function (n) {
        if (!n || !n.id) return;
        var mk = G.markWordsAll(n.text || ''); if (mk && mk.length) marks[n.id] = mk;
        var pw = G.nodeIsPrep(n.text || ''); if (pw) preps[n.id] = pw;
      });
      var properOn = (project.meta && project.meta.properOn) !== false;

      var r = ensurePrintRoot();
      r.innerHTML = '';
      var m = project.meta || {};
      var wrap = document.createElement('div'); wrap.className = 'wrap';
      var title = (m.book || '') + (m.from ? (' ' + m.from) : '') + (m.to ? (' 至' + m.to) : '') +
        (m.version ? (' (' + m.version + ')') : '');
      wrap.innerHTML = '<div class="credit-line">程式由 @Demodikes 開發，僅供改革宗神學院內部使用</div>' +
        '<h1 class="doc-title">' + esc(title.trim() || '希臘文分析') + '</h1>' +
        (m.sub ? '<div class="doc-sub">—— ' + esc(m.sub) + '</div>' : '') +
        '<hr class="rule">' +
        '<div class="ol-body" id="printOlBody"></div>' +
        '<div class="foot" id="printFoot"></div>';
      r.appendChild(wrap);

      var body = wrap.querySelector('#printOlBody');
      var inst = global.GK.renderOutline(body, project, printOpts(project, relmap, marks, preps, properOn));

      var foot = wrap.querySelector('#printFoot');
      foot.textContent = '論述分析 Discourse Analysis　·　' + new Date().toISOString().slice(0, 10) +
        (properOn ? '　·　下劃線：人名／地名／國族（資料來源 STEPBible TIPNR, CC BY 4.0）' : '');

      function go() {
        try {
          if (inst && inst.redrawStable) inst.redrawStable(12, 110, function () { doPrint(); });
          else doPrint();
        } catch (e) { doPrint(); }
      }
      function doPrint() {
        // 等字型就緒再印，避免連線壓到文字
        var done = false;
        function fire() { if (done) return; done = true; try { global.print(); } catch (e) {} }
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(fire, 60); });
        else setTimeout(fire, 120);
      }
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { setTimeout(go, 40); });
      } else setTimeout(go, 120);
    }).catch(function (e) {
      try { if (global.toast) global.toast('匯出失敗：' + e, 6000); } catch (x) {}
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------- 攔截 fetch ----------
  global.fetch = function (input, opts) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var path = url;
    // 只攔截 /api/（含相對寫法）。其餘交回原生。
    if (path.indexOf('/api/') !== 0 && path.indexOf('api/') !== 0) {
      return ORIG_FETCH.apply(global, arguments);
    }
    var method = ((opts && opts.method) || 'GET').toUpperCase();
    var body = {};
    if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = {}; } }
    try {
      var res = (method === 'POST') ? postRoute(path, body) : getRoute(path);
      if (res) return res;
    } catch (e) {
      return Promise.resolve(jsonResp({ ok: false, error: String(e) }, 500));
    }
    return ORIG_FETCH.apply(global, arguments);
  };

  // ---------- 靜態版補充 UI：專案匯出／匯入 ----------
  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function projFileName(p) {
    var m = (p && p.meta) || {};
    var t = (m.book || '希臘文分析') + (m.from ? m.from : '') + (m.to ? '-' + m.to : '');
    return 'Greeky-' + String(t).replace(/[\\/:*?"<>|\s]/g, '_') + '.json';
  }
  function setupExtra() {
    ['openFolder', 'exportFolder'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.style.display = 'none';
    });
    var of = document.getElementById('openMask');
    if (!of || document.getElementById('stImport')) return;
    var foot = of.querySelector('.dlg-foot');
    if (!foot) return;
    var bImp = document.createElement('button');
    bImp.className = 'btn ghost'; bImp.id = 'stImport'; bImp.textContent = '⬆ 匯入專案(.json)';
    var bExp = document.createElement('button');
    bExp.className = 'btn ghost'; bExp.id = 'stExport'; bExp.textContent = '⬇ 匯出目前專案';
    var sp = foot.querySelector('.spacer');
    if (sp) { foot.insertBefore(bImp, sp); foot.insertBefore(bExp, sp); }
    else { foot.insertBefore(bImp, foot.firstChild); foot.insertBefore(bExp, foot.firstChild); }

    bExp.addEventListener('click', function () {
      var p = lsGet(K_AUTO);
      if (p == null) { alert('目前沒有可以匯出的專案。'); return; }
      download(projFileName(p), JSON.stringify(p, null, 1));
    });
    var fi = document.createElement('input');
    fi.type = 'file'; fi.accept = '.json,application/json'; fi.style.display = 'none';
    bImp.addEventListener('click', function () { fi.click(); });
    fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var obj;
        try { obj = JSON.parse(rd.result); } catch (e) { alert('檔案格式不正確（不是有效的 JSON）。'); return; }
        if (!obj || typeof obj !== 'object' || !obj.nodes) { alert('這不像 Greeky 專案檔。'); return; }
        lsSet(K_AUTO, obj);
        var m = obj.meta || {};
        var nm = (m.book || f.name.replace(/\.json$/i, '')) + (m.from ? m.from : '') + (m.to ? '-' + m.to : '');
        obj.__mtime = Date.now();
        lsSet(K_PROJ + nm, obj);
        alert('已匯入並載入：' + nm);
        var b = document.getElementById('openCancel'); if (b) b.click();
        setTimeout(function () { location.reload(); }, 150);
      };
      rd.readAsText(f);
    });
    document.body.appendChild(fi);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupExtra);
  else setTimeout(setupExtra, 0);
})(window);
