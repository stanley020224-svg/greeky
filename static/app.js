/* 希臘文分析小程式 — 主程式
 * 資料模型：project = { meta, nodes:[{id,text,verse,ind,gx,gy}],
 *                       rels:[{id,a,b,label,star,type}] }
 *   nodes = 子句（一行一句），ind = 這行的左縮排（pt），gx/gy = 關係圖上的座標
 *   rels  = 一條「關係括號」，涵蓋第 a 行到第 b 行（含）。
 *           誰包住誰由 span 自動決定 → 畫出來就是範本那種「分叉樹」。
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var S = {
    project: null,
    relations: [],
    connectives: {},
    books: [],
    tab: 'outline',
    outline: null,
    wordEl: null,
    editBox: null,
    front: false,
    gEdge: null,        // 關係圖：正在從哪個節點拉線
    gEdgeEl: null,      // 拉線起點的圓點
    gEdgeSvg: null,     // 拉線時的預覽 SVG
    gEdgePath: null,    // 預覽線
    gEdgeXY: null,      // 預覽線起點座標
    gEdgeHover: null,   // 拉線時滑鼠所在的方塊
    _gEdgeMove: null,   // 拉線預覽的 mousemove handler
    _gEdgeUp: null,     // 拉線預覽的 mouseup handler
    gCuvEls: null,      // 關係圖右側和合本列（nodeId → element）
    gSel: null,         // 關係圖目前選取的物件：{t:'r'|'n', id}
    _gPressing: false,  // 拉線時滑鼠左鍵是否按住（滑出畫布不誤取消）
    gPortHover: null,   // 目前圆点被懸停的節點
    marksOn: false,      // 是否標示主要動詞／分詞
    marks: {},           // nodeId -> [{w,k,t}]（動詞 V/T/N、名詞 c1..c5、形容詞 j1..j5）
    marksKinds: { verb: false, noun: false, adj: false },  // 三組標示各自的開關
    nounOn: false,       // 顯示名詞（五格，橙色深淺）
    adjOn: false,        // 顯示形容詞（五格，紫色深淺）
    prepOf: {},          // nodeId -> 開頭的介詞（介係詞片語那幾行）
    proper: null,        // 專有名詞表（人名／地名／國族）；由 /api/proper 載入
    properOn: true,      // 是否用下劃線標出人名／地名／國族（1.5.0 新功能，預設開）
    scissor: false,      // 剪句模式：滑鼠變剪刀，點一下就切開
    wordMode: false,     // 詞序模式：句中單詞可拖動調序
    rowSel: null,        // 目前選取的行（左側「行工具」作用對象）
    cuvWords: [],        // 每句：{原文詞序: 和合本對應中文}
    gzoom: 1,            // 關係圖縮放
    transKey: 'occb',    // 右側「譯本」卡片目前選的譯本
    transData: [],       // 譯本卡片目前顯示的逐節譯文
    notesUI: null        // 縮排紙右側「筆記欄」的實例（虛線重畫用）
  };

  var GREEK_RE = /[\u0370-\u03ff\u1f00-\u1fff]/;
  var WORD_RE = /([\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+)/g;

  /* ---------------- 工具 ---------------- */
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('on'); }, ms || 2600);
  }
  function api(path, opts) {
    opts = opts || {};
    if (opts.body) {
      opts.method = opts.method || 'POST';
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (r) { return r.json(); });
  }
  function relById(id) {
    for (var i = 0; i < S.relations.length; i++) if (S.relations[i].id === id) return S.relations[i];
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function blankProject() {
    return { meta: { book: '', from: '', to: '', version: '', sub: '', code: '', ch: '',
                    cuv: { on: false, name: '和合本', map: [], cursor: 0 } },
             nodes: [], rels: [], notes: [] };
  }
  function nodeIdx(id) {
    for (var i = 0; i < S.project.nodes.length; i++) if (S.project.nodes[i].id === id) return i;
    return -1;
  }
  function relLabel(r) {
    var t = r.label || (relById(r.type) ? relById(r.type).short : '?');
    if (r.star && t.indexOf('*') < 0) t += '*';
    return t;
  }
  function projName() {
    var m = S.project.meta;
    var a = [m.book, m.from ? m.from + (m.to ? '-' + m.to : '') : ''].filter(Boolean).join('');
    return (a || '希臘文分析').replace(/\s+/g, '');
  }
  function titleText() {
    var m = S.project.meta;
    var t = esc(m.book);
    if (m.from) t += ' ' + esc(m.from);
    if (m.to) t += ' 至' + esc(m.to);
    if (m.version) t += ' (' + esc(m.version) + ')';
    return t.trim() || '（未命名分析）';
  }
  function syncMeta() {
    // ⚠ 一定要「就地更新」既有 meta，不能整個重建成固定鍵的清單：
    //   meta 裡還有 graphV、front、marks、words 等不是由這些輸入框控制的鍵，
    //   重建會把它們洗掉，尤其 graphV 一掉，下次啟動 normalize() 就會
    //   誤以為是舊版面而清光使用者拖好的方塊位置（gx/gy）。
    var m = S.project.meta || (S.project.meta = {});
    m.book = $('#mBook').value.trim();
    m.from = $('#mFrom').value.trim();
    m.to = $('#mTo').value.trim();
    m.version = $('#mVer').value.trim();
    m.sub = $('#mSub').value.trim();
    m.code = $('#pBook').value;
    m.ch = $('#pCh').value;
    if (m.cuv === undefined) m.cuv = null;
    m.graphV = 2;                        // 版面已確定為 v2，持久保存以免再被清座標
    m.properOn = !!S.properOn;           // 專名下劃線要存進專案（匯出 PDF 也照它決定）
    var t = titleText();
    if (m.sub) t += '　—— ' + m.sub;
    $('#olTitle').textContent = t;
  }

  /* ---------------- 標示動詞 ---------------- */
  $('#rVerbs').addEventListener('click', function () {
    var on = !S.marksKinds.verb;
    if (on && !Object.keys(S.marks).length) {
      fetchVerbMarks(function () {
        setMarks(true);
        renderOutlineView();
        toast('已標示：主要動詞（深紅）、分詞（中紅）、不定詞（淡紅）。和合本對應的詞也一併標出。');
      });
      return;
    }
    setMarks(on);
    if (on) fetchVerbMarks(function () { renderOutlineView(); });
    else renderOutlineView();
    toast(on ? '已標示動詞（紅色深淺）。' : '已取消動詞標示。');
  });

  /* ---------------- 顯示名詞（五格，橙色深淺） ---------------- */
  $('#rNouns').addEventListener('click', function () {
    var on = !S.marksKinds.noun;
    setNouns(on);
    if (on) fetchVerbMarks(function () { renderOutlineView(); });
    else renderOutlineView();
    toast(on ? '已顯示名詞：主格最深 → 呼格最淡（橙色）。和合本對應的詞也一併標出。' : '已取消名詞標示。');
  });

  /* ---------------- 顯示形容詞（五格，紫色深淺） ---------------- */
  $('#rAdjs').addEventListener('click', function () {
    var on = !S.marksKinds.adj;
    setAdjs(on);
    if (on) fetchVerbMarks(function () { renderOutlineView(); });
    else renderOutlineView();
    toast(on ? '已顯示形容詞：主格最深 → 呼格最淡（紫色）。和合本對應的詞也一併標出。' : '已取消形容詞標示。');
  });

  /* ---------------- 和合本對照欄 ---------------- */
  function cuvOn() {
    var c = S.project.meta.cuv;
    return !!(c && c.on);
  }
  function cuvMap() {
    if (!S.project.meta.cuv) S.project.meta.cuv = { on: false, name: '和合本', map: [], cursor: 0 };
    if (!S.project.meta.cuv.map) S.project.meta.cuv.map = [];
    return S.project.meta.cuv.map;
  }
  /* 把已存的「逐詞對應」(meta.cuv.words) 接回 S.cuvWords（畫面 hover 對應的來源）。
     句數不符（結構改過）時回 false，叫呼叫者去伺服器重算。 */
  function syncCuvWords() {
    var c = S.project.meta && S.project.meta.cuv;
    var w = c && c.words;
    if (w && w.length === S.project.nodes.length) { S.cuvWords = w; return true; }
    S.cuvWords = [];
    return false;
  }
  /* 開檔／啟動時：**優先沿用存好的逐詞對應**（保住使用者拖過的詞序），
     沒有或句數不符才向伺服器重算。
     為什麼：伺服器是拿「目前句子的詞」跟 OpenGNT 原文序做序列比對，
     句子已被調過詞序時再重算會對不上（中文掉詞、hover 錯位）。 */
  function ensureCuvWords(recompute) {
    if (!cuvOn()) return;
    if (!recompute && syncCuvWords()) { renderOutlineView(); return; }
    applyCuvOrdered();
  }
  /* 和合本鋪進每一句 —— 由伺服器「按原文語序」排好（不是照中文語序切）。
     伺服器拿 OpenGNT 的和合本逐詞對齊，跟每句希臘文做序列比對，
     比對到的詞就把中文掛到那一句，所以中文詞序會跟著原文走。 */
  function applyCuvOrdered(done) {
    var c = S.project.meta.cuv || (S.project.meta.cuv = { name: '和合本' });
    c.name = '和合本';
    if (!S.project.nodes.length) {
      c.map = [];
      if (done) done(false);
      return;
    }
    api('/api/cuvorder', { body: { project: S.project } }).then(function (r) {
      if (!r || !r.ok) { if (done) done(false); return; }
      c.map = r.map || [];
      c.matched = r.matched || 0;
      c.total = r.total || 0;
      c.words = r.words || [];        // 逐詞對應（滑到希臘文詞→對應和合本中文）
      S.cuvWords = c.words;
      setCuv(true);
      layoutCuvPreview();
      renderOutlineView();
      if (done) done(true, r);
    }).catch(function () { if (done) done(false); });
  }
  function setCuv(on) {
    var c = S.project.meta.cuv || (S.project.meta.cuv = { name: '和合本', map: [] });
    c.on = !!on;
    if (!c.name) c.name = '和合本';
    $$('#optCuv, #optCuvOn').forEach(function (x) { if (x) x.checked = c.on; });
    var wrap = $('#cuvPrevWrap');
    if (wrap) wrap.style.display = c.on ? '' : 'none';
    if (c.on) layoutCuvPreview();
    syncRail();
  }
  /* 依每句希臘文的長度比例，把整節和合本切成對應片段鋪進去 */
  function layoutCuvPreview() {
    var el = $('#cuvPrev');
    if (!el) return;
    var c = S.project.meta.cuv || {};
    var map = c.map || [];
    el.innerHTML = '';
    if (!S.project.nodes.length) {
      el.innerHTML = '<div class="empty">先取經文或分句，再按「重新對照」自動鋪上和合本。</div>';
      return;
    }
    S.project.nodes.forEach(function (n, i) {
      var w = document.createElement('div');
      w.className = 'cuv-item';
      w.innerHTML = '<span class="cv">' + esc(n.verse || '') + '</span>' +
        '<span class="cg">' + esc(n.text) + '</span>' +
        '<span class="cz">' + esc(map[i] || '') + '</span>';
      el.appendChild(w);
    });
  }

  /* ---------------- 復原 / 重做（⌘Z / ⇧⌘Z） ----------------
     做法：每有一次變更就把整份 project 快照存進堆疊（含 S.front），
     指標 p 指向目前狀態。⌘Z 往前、⇧⌘Z 往後，還原後重繪。
     連續快速變更（打字）用 350ms 合併；按 ⌘Z 前會先 flush，
     才不會「剛打完字就按 ⌘Z，結果復原掉上一步」。
     max 上限避免長篇分析吃記憶體（快照才幾 KB）。 */
  var HIST = { stack: [], p: -1, latest: null, tm: 0, busy: false, max: 60 };
  /* 正規化快照：固定鍵名與順序。
     為什麼要這樣：syncMeta() 每次重繪都會依 DOM 重建 meta，鍵的順序、
     或 cuv 物件的有無會變，導致「內容其實沒變但 JSON 字串不同」→
     誤記一步、堆疊被截斷、⌘Z 地打轉。固定成 canonical 後就不會。 */
  function canonProject(p) {
    p = p || {};
    var m = p.meta || {};
    return {
      meta: {
        book: m.book || '', from: m.from || '', to: m.to || '',
        version: m.version || '', sub: m.sub || '', code: m.code || '', ch: m.ch || '',
        graphV: m.graphV || 2,
        cuv: m.cuv ? { on: !!m.cuv.on, name: m.cuv.name || '',
                      map: m.cuv.map || [], matched: m.cuv.matched || 0, total: m.cuv.total || 0,
                      // ⚠ 逐詞對應也要進快照：詞序拖曳會同時搬動 node.text 與 cuv.words，
                      // 少存這一項 → 復原時希臘文回去了、中文卻留在調換後的順序（1.3 修）。
                      words: m.cuv.words || null } : null
      },
      nodes: (p.nodes || []).map(function (n) {
        return { id: n.id, text: n.text || '', verse: n.verse == null ? null : n.verse,
                 ind: n.ind || 0, att: n.att == null ? null : n.att,
                 pa: n.pa || null, gx: n.gx == null ? null : n.gx, gy: n.gy == null ? null : n.gy,
                 // 逐字樣式（1.6.1）：只記有實質樣式的 run（b\i\u\c）
                 rs: (n.rs && n.rs.length) ? n.rs.map(function (r) {
                   return { a: r.a, z: r.z, b: r.b ? 1 : 0, i: r.i ? 1 : 0, u: r.u ? 1 : 0, c: r.c || null };
                 }) : null };
      }),
      rels: (p.rels || []).map(function (r) {
        return { id: r.id, a: r.a, b: r.b, label: r.label || '', star: !!r.star,
                 starAt: r.starAt || '', type: r.type || '',
                 gx: r.gx == null ? null : r.gx, gy: r.gy == null ? null : r.gy };
      }),
      // 筆記（像 Word 的批注）：釘在某一行的註記卡，含位置
      notes: (p.notes || []).map(function (n) {
        return { id: n.id, node: n.node, text: n.text || '',
                 x: n.x == null ? null : n.x, y: n.y == null ? null : n.y };
      })
    };
  }
  function histSnap() {
    return JSON.stringify({ p: canonProject(S.project), f: !!S.front });
  }
  function histReset() {
    HIST.stack = [histSnap()]; HIST.p = 0; HIST.latest = HIST.stack[0];
    clearTimeout(HIST.tm); HIST.tm = 0;
  }
  /* 把目前的狀態補進堆疊（deferred 那一筆）。
     ⚠ 這裡「只補 latest」，且補完後把堆疊頂端重設為 latest；
     不要在 restore 期間被呼叫（會把重做的尾段截掉，導致 ⌘Z 連按失效）。 */
  function pushLatest() {
    HIST.tm = 0;
    var v = HIST.latest;
    if (v == null) return;
    if (HIST.p >= 0 && v === HIST.stack[HIST.p]) return;
    HIST.stack = HIST.stack.slice(0, HIST.p + 1);
    HIST.stack.push(v);
    while (HIST.stack.length > HIST.max) HIST.stack.shift();
    HIST.p = HIST.stack.length - 1;
  }
  function commit() {
    if (HIST.busy || !S.project) return;
    if (!HIST.stack.length) { histReset(); return; }
    var v = histSnap();
    if (HIST.p >= 0 && v === HIST.stack[HIST.p]) return;   // 沒變就不記
    HIST.latest = v;
    clearTimeout(HIST.tm);
    HIST.tm = setTimeout(pushLatest, 350);
  }
  function histFlush() { if (HIST.tm) { clearTimeout(HIST.tm); pushLatest(); } }
  function saveNow() {
    clearTimeout(autosaveTm);
    api('/api/autosave', { body: { project: S.project } }).catch(function () {});
  }
  function restore(s) {
    HIST.busy = true;
    var o;
    try { o = JSON.parse(s); } catch (e) { HIST.busy = false; return; }
    S.project = normalize(o.p || blankProject());
    setFront(!!o.f);
    var m = S.project.meta || {};
    if ($('#mBook')) $('#mBook').value = m.book || '';
    if ($('#mFrom')) $('#mFrom').value = m.from || '';
    if ($('#mTo')) $('#mTo').value = m.to || '';
    if ($('#mVer')) $('#mVer').value = m.version || '';
    if ($('#mSub')) $('#mSub').value = m.sub || '';
    if (m.code && $('#pBook')) {
      $('#pBook').value = m.code;
      if ($('#pCh')) $('#pCh').value = m.ch || '1';
      syncVerseRange(true);
    }
    if (S.project.meta.cuv) setCuv(!!S.project.meta.cuv.on);
    syncCuvWords();      // 逐詞中文跟著快照一起回來（否則復原後中文詞序不回去）
    renderOutlineView(); renderTable(); renderGraph();    HIST.busy = false;
    // ⚠ 還原後「只存檔、不記歷史」：若在此呼叫 touch()，
    // 會把目前狀態補進堆疊頂端，導致下一次 ⌘Z 原地打轉、重做尾段被截掉。
    HIST.latest = s;
    clearTimeout(HIST.tm); HIST.tm = 0;
    if (S.tab === 'graph') renderGraph();
    saveNow();
  }
  function undo() {
    histFlush();
    if (HIST.p <= 0) { toast('已經是最早的狀態了'); return; }
    HIST.p--;
    restore(HIST.stack[HIST.p]);
    toast('已復原上一步　（剩 ' + HIST.p + ' 步可復原）');
  }
  function redo() {
    histFlush();
    if (HIST.p >= HIST.stack.length - 1) { toast('沒有可重做的步驟'); return; }
    HIST.p++;
    restore(HIST.stack[HIST.p]);
    toast('已重做　（還可重做 ' + (HIST.stack.length - 1 - HIST.p) + ' 步）');
  }

  /* ---------------- 主要動詞／分詞標示 + 介係詞片語 ---------------- */
  function fetchVerbMarks(done) {
    if (!S.project || !S.project.nodes.length) { S.marks = {}; S.prepOf = {}; if (done) done(); return; }
    api('/api/verbmarks', { body: { project: S.project } }).then(function (r) {
      S.marks = (r && r.marks) || {};
      S.prepOf = (r && r.preps) || {};
      if (done) done();
    }).catch(function () { if (done) done(); });
  }
  function setMarks(on) {
    S.marksOn = !!on;
    S.marksKinds.verb = !!on;
    syncRail();
  }
  function setNouns(on) {
    S.nounOn = !!on;
    S.marksKinds.noun = !!on;
    syncRail();
  }
  function setAdjs(on) {
    S.adjOn = !!on;
    S.marksKinds.adj = !!on;
    syncRail();
  }
  /* 只讓「目前開著」的類別上色：動詞 → V/T/N；名詞 → c1..c5；形容詞 → j1..j5 */
  function markFilter(k) {
    if (!k) return false;
    if (k === 'V' || k === 'T' || k === 'N') return !!S.marksKinds.verb;
    if (k.charAt(0) === 'c') return !!S.marksKinds.noun;
    if (k.charAt(0) === 'j') return !!S.marksKinds.adj;
    return false;
  }

  /* ---------------- 專有名詞（人名／地名／國族）下劃線（1.5.0） ----------------
     資料來源：STEPBible TIPNR（CC BY 4.0）→ app/data/proper.json。
     比對用「去掉重音、小寫、final sigma 統一」的詞形。 */
  function normGrk(w) {
    var s = String(w || '').normalize ? String(w || '').normalize('NFD') : String(w || '');
    s = s.replace(/[\u0300-\u036f\u0345]/g, '');
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(/ς/g, 'σ').toLowerCase();
  }
  function properKind(w) {
    if (!S.proper || !w) return '';
    var k = normGrk(w);
    if (S.proper.forms && S.proper.forms[k]) return S.proper.forms[k];
    /* capforms：與普通名詞同形（如 στέφανος 冠冕／Στέφανος 司提反）
       → 只有首字大寫才當專名。 */
    if (S.proper.capforms && S.proper.capforms[k]) {
      var ch = String(w).charAt(0);
      if (ch && ch !== ch.toLowerCase()) return S.proper.capforms[k];
    }
    return '';
  }
  function loadProper(done) {
    if (S.proper) { if (done) done(); return; }
    api('/api/proper').then(function (r) {
      S.proper = r || { forms: {}, capforms: {} };
      if (done) done();
    }).catch(function () { S.proper = { forms: {}, capforms: {} }; if (done) done(); });
  }
  function setProper(on) {
    S.properOn = !!on;
    syncRail();
  }
  /* 把一句話鋪進元素；開著「專名」時，人名／地名／國族用下劃線標出。 */
  function fillProperText(el, text) {
    el.textContent = '';
    if (!S.properOn || !S.proper) { el.textContent = text; return; }
    var parts = String(text || '').split(WORD_RE);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (GREEK_RE.test(p)) {
        var k = properKind(p);
        if (k) {
          var sp = document.createElement('span');
          sp.className = 'w pr pr-' + k;
          sp.dataset.pr = k;
          sp.textContent = p;
          el.appendChild(sp);
          continue;
        }
      }
      el.appendChild(document.createTextNode(p));
    }
  }
  /* 把某一句（dragId）拖到目標句（targetId）的第 wi 個詞上放開
     → 這一句的縮排掛靠在那個單詞的**右緣後面**。
     1.3.1：不再限定介係詞片語、也不再自動對齊到動詞；任何句子、任何單詞都可以。 */
  function attachPrep(dragId, targetId, wi) {
    var pi = nodeIdx(dragId);
    if (pi < 0) return;
    var tj = nodeIdx(targetId);
    if (tj < 0) return;
    if (dragId === targetId) { toast('不能掛靠到自己這一行'); return; }
    var tEl = document.querySelector('.ol-text[data-id="' + targetId + '"]');
    // 用 [data-w] 而非 .w：連接詞提前時，目標詞可能是被移到句首的 .conn
    var wEl = (wi >= 0 && tEl) ? tEl.querySelector('[data-w="' + wi + '"]') : null;
    if (!wEl) { toast('請把這一句拖到某個「單詞」上放開（掛靠在那個詞後面）'); return; }
    // 把這一句的縮排（ind）算到「目標詞的右緣」（pt，相對基準線 G）
    var PT = GK.PT;
    var inst = S.outline, G = inst ? (inst.gutter || 0) : 0;
    var vbx = wEl.offsetLeft + wEl.offsetWidth;   // 掛在該詞「後面」→ 用右緣
    var prep = S.project.nodes[pi];
    prep.ind = Math.max(0, (vbx - G) / PT);
    prep.att = prep.ind;
    prep.pa = { t: targetId, w: wi };
    touch(); renderOutlineView();
    toast('已掛靠在「' + (wEl.textContent || '').trim() + '」後面');
  }
  function clearPrepAlign(id) {
    var i = nodeIdx(id);
    if (i < 0 || !S.project.nodes[i].pa) return;
    delete S.project.nodes[i].pa;
    touch(); renderOutlineView();
  }

  /* ---------------- 剪句模式（滑鼠變剪刀，點一下就切開） ---------------- */
  function setScissor(on) {
    S.scissor = !!on;
    document.body.classList.toggle('scissor', S.scissor);
    if (!S.scissor) hideScissorMark();
    if (S.scissor && S.wordMode) setWordMode(false);
    if (S.outline) S.outline.hidePal && S.outline.hidePal();
    renderOutlineView();
    toast(S.scissor
      ? '剪句模式：在句中兩個詞之間點一下，就從那裡切開（切一次後會自動關閉）。'
      : '已關閉剪句模式。');
  }
  /* 由點擊座標找出「從該處切開」的文字位移 */
  function textOffsetFromPoint(el, x, y) {
    var node = null, off = 0;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; off = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; off = p.offset; }
    }
    if (!node || !el.contains(node)) return null;
    var pre = document.createRange();
    pre.selectNodeContents(el);
    try { pre.setEnd(node, off); } catch (e) { return null; }
    return pre.toString().length;
  }
  /* ---- 剪句：跟著滑鼠跑的「精確切口」指示（剪刀游標另由 CSS 設定） ---- */
  var scMark = null;
  function scissorMarkEl() {
    if (!scMark) {
      scMark = document.createElement('div');
      scMark.className = 'scissor-mark';
      scMark.innerHTML = '<div class="sc-bar"></div>';
      document.body.appendChild(scMark);
    }
    return scMark;
  }
  function hideScissorMark() {
    if (scMark) scMark.classList.remove('on');
    $$('.ol-text .sc-nb').forEach(function (e) { e.classList.remove('sc-nb'); });
    S._scCutOff = null;
  }
  /* 句中「詞與詞之間」的位置（＝可切點）：前一個詞結束、後一個詞開始 */
  function wordGaps(full) {
    var spans = [], m, re = /\S+/g;
    while ((m = re.exec(full))) spans.push({ s: m.index, e: m.index + m[0].length });
    var gaps = [];
    for (var i = 0; i < spans.length - 1; i++) gaps.push({ g1: spans[i].e, g2: spans[i + 1].s });
    return gaps;
  }
  /* 把任意游標位移吸附到「最近的詞間空隙」；沒有任何空隙（單詞）回 null */
  function snapToGap(full, off) {
    if (off == null) return null;
    var gaps = wordGaps(full);
    if (!gaps.length) return null;
    var best = null, bd = Infinity;
    gaps.forEach(function (g) {
      var d = (off <= g.g1) ? (g.g1 - off) : (off >= g.g2 ? (off - g.g2) : 0);
      if (d < bd) { bd = d; best = g; }
    });
    return best ? { off: best.g1, g1: best.g1, g2: best.g2 } : null;
  }
  function rangeAtOffset(el, off) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), n, acc = 0;
    while ((n = w.nextNode())) {
      var len = n.nodeValue.length;
      if (off <= acc + len) {
        var r = document.createRange();
        r.setStart(n, Math.max(0, Math.min(len, off - acc)));
        r.collapse(true);
        return r;
      }
      acc += len;
    }
    return null;
  }
  function wordElAtOffset(el, off) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), n, acc = 0;
    while ((n = w.nextNode())) {
      var len = n.nodeValue.length;
      if (off < acc + len) {
        var p = n.parentNode;
        return (p && p.closest) ? p.closest('.w, .conn') : null;
      }
      acc += len;
    }
    return null;
  }
  function updateScissorMark(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('.ol-text') : null;
    if (!el) { hideScissorMark(); return; }
    var full = el.textContent;
    var snap = snapToGap(full, textOffsetFromPoint(el, ev.clientX, ev.clientY));
    if (!snap) { hideScissorMark(); return; }          // 單詞句／無詞間空隙 → 不顯示
    var r1 = rangeAtOffset(el, snap.g1), r2 = rangeAtOffset(el, snap.g2);
    var base = (r1 || r2) ? (r1 || r2).getBoundingClientRect() : null;
    if (!base || (!base.height && !base.width)) { hideScissorMark(); return; }
    var x = base.left;
    if (r1 && r2) {
      var a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      if (Math.abs(a.top - b.top) < 2) x = (a.left + b.left) / 2;   // 同一行 → 取空隙中點
    }
    var m = scissorMarkEl();
    var h = base.height || 20;
    m.querySelector('.sc-bar').style.height = (h + 6) + 'px';
    m.style.left = x + 'px';
    m.style.top = (base.top - 3) + 'px';
    m.classList.add('on');
    S._scCutOff = snap.off;
    // 描出切口左右那兩個詞
    $$('.ol-text .sc-nb').forEach(function (e) { e.classList.remove('sc-nb'); });
    var w1 = wordElAtOffset(el, snap.g1 - 1), w2 = wordElAtOffset(el, snap.g2);
    if (w1) w1.classList.add('sc-nb');
    if (w2 && w2 !== w1) w2.classList.add('sc-nb');
  }
  document.addEventListener('mousemove', function (ev) {
    if (!S.scissor) { if (scMark && scMark.classList.contains('on')) hideScissorMark(); return; }
    updateScissorMark(ev);
  }, true);
  document.addEventListener('scroll', function () { hideScissorMark(); }, true);
  window.addEventListener('blur', function () { hideScissorMark(); });

  function scissorCut(node, ev) {
    var el = document.querySelector('.ol-text[data-id="' + node.id + '"]');
    if (!el) return;
    var full = el.textContent;
    var snap = snapToGap(full, textOffsetFromPoint(el, ev.clientX, ev.clientY));
    if (!snap) { toast('請在兩個詞之間點一下（只能在詞與詞之間剪）'); return; }
    var off = snap.off;
    var a = full.slice(0, off).trim(), b = full.slice(off).trim();
    if (!a || !b) { toast('不能在句首或句尾切'); return; }
    node.text = a;
    var i = nodeIdx(node.id);
    S.project.nodes.splice(i + 1, 0, { id: GK.newId(), text: b, verse: null, ind: 0 });
    refreshMarksIfChanged();
    // 剪句工具為「單次使用」：成功切開一次後就自動關閉
    var wasScissor = S.scissor;
    S.scissor = false;
    document.body.classList.remove('scissor');
    hideScissorMark();
    touch(); renderOutlineView(); refreshCuv();
    toast(wasScissor ? '已從該處切開（剪句工具已自動關閉）。' : '已從該處切開。');
  }

  /* ---------------- 詞序模式（句中單詞自由拖動調序） ---------------- */
  function setWordMode(on) {
    S.wordMode = !!on;
    document.body.classList.toggle('wordmode', S.wordMode);
    if (S.wordMode && S.scissor) setScissor(false);
    if (S.outline) S.outline.hidePal && S.outline.hidePal();
    renderOutlineView();
    toast(S.wordMode
      ? '詞序模式：把句子裡的單詞拖到另一個詞上放開，即可調換順序（再按一次關閉）。'
      : '已關閉詞序模式。');
  }
  /* 把第 from 個詞移到第 to 個詞的位置。
     分隔符（空白與標點）**固定在原位**，只有單詞本體換位置：
     這樣詞與詞之間的空格不會消失，句末標點也不會跑到句中。 */
  function reorderWords(node, from, to) {
    var parts = String(node.text || '').split(WORD_RE);
    var words = [], seps = [], lead = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '') continue;
      if (GREEK_RE.test(p)) words.push(p);
      else if (words.length) seps.push(p);   // 第 k 個＝第 k 與 k+1 個詞之間的間隔
      else lead += p;                        // 第一個詞之前的東西
    }
    if (from < 0 || to < 0 || from >= words.length || to >= words.length) return;
    // 記下詞的置換：perm[k] = 現在排在第 k 位的詞，原本是第幾個
    var perm = words.map(function (_, q) { return q; });
    var pm = perm.splice(from, 1)[0];
    perm.splice(to, 0, pm);
    var moved = words.splice(from, 1)[0];
    words.splice(to, 0, moved);
    var out = lead;
    for (var k = 0; k < words.length; k++) {
      out += words[k];
      if (k < words.length - 1) out += (seps[k] !== undefined ? seps[k] : ' ');
    }
    for (var j = words.length - 1; j < seps.length; j++) out += seps[j];  // 尾端標點留在句末
    node.text = out.trim();
    cuvReorderWords(nodeIdx(node.id), perm);   // 和合本：中文詞跟著同一個調換一起移動
    refreshMarksIfChanged();
    touch(); renderOutlineView();
    toast('已調整詞序：' + moved);
  }

  /* ---------------- 滑到或點選希臘文詞→高亮和合本對應的詞 ---------------- */
  var _hotCuv = null;      // 滑鼠懸停時的高亮
  var _selCuv = null;      // 點選時的高亮（持續，直到取消）
  var HL_COLOR = { V: '#c0392b', T: '#e0703f', N: '#e8a87c',
                   c1: '#e08a00', c2: '#e8a020', c3: '#efb84a', c4: '#f4cf85', c5: '#f8e3b8',
                   j1: '#6b3fa0', j2: '#8257b4', j3: '#9a74c8', j4: '#b394d8', j5: '#cbb6e6' };
  var HL_DEF = '#ffe9a8';

  // 把同一句、同一個原文字序（wi）對應的和合本中文詞上色（滑鼠懸停＝暫時）
  function hoverCuvWord(nodeId, wi) {
    if (_hotCuv) { _hotCuv.classList.remove('hot'); _hotCuv = null; }
    if (wi == null || wi < 0) return;
    var cz = document.querySelector('.ol-cuv[data-id="' + nodeId + '"]');
    if (!cz) return;
    var sp = cz.querySelector('.czw[data-w="' + wi + '"]');
    if (sp) { sp.classList.add('hot'); _hotCuv = sp; }
  }

  // 點選希臘文詞：在和合本對應的中文詞上用「同樣的顏色」高亮（持續）
  function selCuvWord(nodeId, wi, kind) {
    if (_selCuv) { _selCuv.classList.remove('selw'); _selCuv.style.removeProperty('background');
                   _selCuv.style.removeProperty('box-shadow'); _selCuv.style.removeProperty('color'); _selCuv = null; }
    if (wi == null || wi < 0) return;
    var cz = document.querySelector('.ol-cuv[data-id="' + nodeId + '"]');
    if (!cz) return;
    var sp = cz.querySelector('.czw[data-w="' + wi + '"]');
    if (!sp) return;
    var col = HL_COLOR[kind] || HL_DEF;
    sp.classList.add('selw');
    sp.style.background = col;
    sp.style.boxShadow = '0 0 0 2px ' + col;
    sp.style.color = (kind === 'c1' || kind === 'j1' || kind === 'c2' || kind === 'j2') ? '#fff' : '#3a2a12';
    _selCuv = sp;
  }

  /* ---------------- 自動存檔 ---------------- */
  var autosaveTm;
  function touch() {
    commit();
    clearTimeout(autosaveTm);
    autosaveTm = setTimeout(function () {
      api('/api/autosave', { body: { project: S.project } }).catch(function () {});
    }, 1000);
  }

  /* ---------------- 縮排分析（分叉樹） ---------------- */
  var _marksSig = null;
  function marksSignature() {
    if (!S.project || !S.project.nodes) return '';
    return S.project.nodes.map(function (n) { return n.id + '\u0001' + (n.text || ''); }).join('\u0002');
  }
  function refreshMarksIfChanged() {
    var sig = marksSignature();
    if (sig === _marksSig) return;
    _marksSig = sig;
    fetchVerbMarks(function () {
      // 標記資料到了再重畫一次（不遞迴：簽章已更新）
      GK && S.project && S.project.nodes.length && renderOutlineView();
    });
  }

  function renderOutlineView() {
    syncMeta();
    syncRail();
    var body = $('#olBody');
    if (!S.project.nodes.length) {
      body.innerHTML = '<div class="ol-hint">還沒有內容。先在上面選經文，或按「＋ 新增子句」。</div>';
      if (S.outline) S.outline = null;
      renderNotesView();
      commit();
      return;
    }
    refreshMarksIfChanged();
    S.outline = GK.renderOutline(body, S.project, {
      editable: true, dragHandle: true, interactiveLines: true,
      onRowFocus: function (id) { focusRow(id); },
      front: S.front, connectives: S.connectives,
      marks: S.marks, markFilter: markFilter, prepOf: S.prepOf,
      properKind: S.properOn ? properKind : null,
      onPrepDrop: function (prepId, targetId, wi) { attachPrep(prepId, targetId, wi); },
      cuv: cuvOn() ? function (n, i) { return cuvMap()[i] || ''; } : null,
      cuvWords: cuvOn() ? function (n, i) { return S.cuvWords[i] || null; } : null,
      onWordHover: function (nodeId, wi) { hoverCuvWord(nodeId, wi); },
      onScissor: S.scissor ? function (n, wi, ev) { scissorCut(n, ev); } : null,
      wordDrag: !!S.wordMode,
      onWordMove: function (n, from, to) { reorderWords(n, from, to); },
      cuvTitle: (S.project.meta.cuv && S.project.meta.cuv.name) || '和合本',
      gkTitle: (S.project.meta.version || '原文') + ' 原文',
      onCuvEdit: function (n, el) { inlineEditCuv(n, el); },
      relation: function (id) { return relById(id); },
      onWord: function (w, el) { lookup(w, el); },
      runStyles: true,          // 1.6.1：逐字樣式（node.rs）交給渲染引擎切成 <span class="rsp …">
      onLabel: function (r) { openRelPicker(r); },
      onLine: function (r) { openRelPicker(r); },
      dropTarget: function (from, to) { link(from, to); },
      onRelLink: function (seg, nodeId) { pRelLink(seg, nodeId); },
      onEdit: function (node, el) { inlineEdit(node, el); },
      afterDraw: function () {
        // 縮排紙重畫（字型載入、視窗縮放、內容變動）後，筆記虛線要跟著重貼
        if (S.notesUI && S.notesUI.drawLines) S.notesUI.drawLines();
        fitPaperWidth();
      },
      tools: function (node, i, tl) {
        tl.appendChild(mkBtn('↶', '撤回', '撤回上一步（⌘Z）', function () { undo(); }));
        tl.appendChild(mkBtn('↷', '恢复', '重做下一步（⇧⌘Z）', function () { redo(); }));
        tl.appendChild(mkBtn('✎', '筆記', '為這一句開一則筆記（句子旁直接寫，存檔後在右側用虛線連到這句話）', function () {
          openNoteEditor(node.id);
        }));
        tl.appendChild(mkBtn('↑', '上移', '上移一句', function () { move(node.id, -1); }));
        tl.appendChild(mkBtn('↓', '下移', '下移一句', function () { move(node.id, 1); }));
        tl.appendChild(mkBtn('⧉', '新增', '在這一行後面新增一句', function () { addAfter(node.id); }));
        var sc = mkBtn('✂', '剪句', '剪句模式：開啟後在句中點一下即可切開（單次使用）', function () { setScissor(!S.scissor); });
        if (S.scissor) sc.classList.add('on');
        tl.appendChild(sc);
        var wm = mkBtn('⇄', '詞序', '詞序模式：開啟後可拖動句中單詞調序', function () { setWordMode(!S.wordMode); });
        if (S.wordMode) wm.classList.add('on');
        tl.appendChild(wm);
        tl.appendChild(mkBtn('⇧', '併入上句', '併入上一句', function () { mergePrev(node.id); }));
        tl.appendChild(mkBtn('⛓', '連關係', '把這一行連到指定範圍，建立子句關係', function () {
          S.outline && S.outline.hidePal && S.outline.hidePal();
          linkPrompt(node.id);
        }));
        if (node.pa) tl.appendChild(mkBtn('⤺', '取消掛靠', '取消這一句的縮排掛靠，回到一般縮排', function () { clearPrepAlign(node.id); }));
        tl.appendChild(mkBtn('🗑', '刪除', '刪除這一句', function () { delNode(node.id); }));
      }
    });
    applyRowSel();
    renderNotesView();
    renderTable();
    commit();
    // 重畫後，若右鍵工具列原本開著（且那一行還存在），照原位重新打開，
    // 這樣「上移／下移／新增／刪除」等工具可以連續點，不會一按就消失。
    if (S.outline && S.outline.keepPal) S.outline.keepPal();
  }

  /* 自由畫板：紙張保持可讀寬度。
     依關係標籤所需留白（gutter）＋希臘文可讀寬＋（開啟時）和合本欄，定出紙張最小寬度；
     窄視窗時畫板會橫向捲動，而不是把和合本犧牲去跟希臘文擠在一起。 */
  function fitPaperWidth() {
    var paper = document.querySelector('.ol-paper');
    if (!paper || !S.outline) return;
    var gut = S.outline.gutter || 0;
    var need = gut + 380 + (cuvOn() ? 316 : 0) + 100;
    paper.style.minWidth = Math.round(need) + 'px';
  }

  /* ---------------- 筆記（像 Word 的批注） ---------------- */
  function notesList() {
    if (!S.project.notes) S.project.notes = [];
    return S.project.notes;
  }
  /* 在縮排紙右側的「筆記車道」重畫所有註記卡與虛線（1.4.1：自由畫板） */
  function renderNotesView() {
    var host = $('#olNotesLane');
    var split = $('#olSplit');
    if (!host || !split) return;
    /* 1.5.0 修 bug：刪到沒有筆記時，以前是「提前 return」→ 既沒叫 GK.renderNotes
       去清虛線，也沒還原被撐高的畫布高度。現在一律交給 renderNotes 處理
       （它會在沒筆記時把 svg 清空、min-height 還原）。 */
    S.notesUI = GK.renderNotes(host, split, S.project, {
      rowEls: (S.outline && S.outline.rowEls) || {},
      editable: true,
      emptyHtml: null,
      onEdit: function () { touch(); renderNoteList(); },
      onMove: function () { touch(); },
      onDelete: function (n) { removeNote(n); },
      onFocus: function (id) { focusRow(id); }
    });
    var has = !!(S.notesUI && S.notesUI.cards && S.notesUI.cards.length);
    split.classList.toggle('has-notes', has);
    renderNoteList();
  }
  /* 右側「筆記」卡片：列出所有筆記，點一下跳到那一句 */
  function renderNoteList() {
    var box = $('#noteList');
    if (!box) return;
    var list = notesList();
    if (!list.length) {
      box.innerHTML = '<div class="empty">還沒有筆記。在縮排分析的行上按右鍵 →「✎ 筆記」，'
        + '就會在句子右側開一張註記卡，並用虛線連到那句話。</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (n) {
      var i = nodeIdx(n.node);
      var item = document.createElement('div');
      item.className = 'note-item';
      item.dataset.id = n.id;
      var verse = (i >= 0 && S.project.nodes[i].verse) ? ('第 ' + S.project.nodes[i].verse + ' 節 · ') : '';
      item.innerHTML = '<div class="ni-h"><span class="ni-n">第 ' + (i >= 0 ? (i + 1) : '?') + ' 句</span>'
        + '<span>' + esc(verse) + '</span></div>'
        + '<div class="ni-t' + (n.text ? '' : ' empty') + '">' + esc(n.text || '（空白筆記）') + '</div>';
      item.addEventListener('click', function () {
        switchTab('outline');
        focusRow(n.node);
        setTimeout(function () {
          var row = document.querySelector('.ol-row[data-id="' + n.node + '"]');
          if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          var card = document.querySelector('.ol-note[data-id="' + n.id + '"] .n-tx');
          if (card) card.focus();
        }, 60);
      });
      box.appendChild(item);
    });
  }
  function addNote(nodeId, text) {
    if (nodeIdx(nodeId) < 0) return null;
    var list = notesList();
    var n = list.filter(function (o) { return o.node === nodeId; })[0] || null;
    if (n) {
      if (text != null) n.text = text;
    } else {
      n = { id: GK.newId(), node: nodeId, text: text || '', x: null, y: null };
      // 排在前一則筆記下面，不打架
      var k = list.filter(function (o) { return o.node === nodeId; }).length;
      n.y = 6 + (list.length + k) * 64;
      n.x = 6;
      list.push(n);
    }
    touch();
    renderNotesView();
    return n;
  }
  function removeNote(n) {
    S.project.notes = notesList().filter(function (o) { return o.id !== n.id; });
    touch(); renderNotesView();
    toast('已刪除這則筆記。');
  }

  /* ---- 平面筆記編輯器（1.4.1）----
     右鍵工具列按「筆記」→ 在句子旁開一個扁平小面板直接寫；
     存檔後才在右側畫布上開註記卡、拉虛線。已有筆記則直接編輯那一則。 */
  var _notePop = null;
  function closeNoteEditor() {
    if (_notePop && _notePop.parentNode) _notePop.parentNode.removeChild(_notePop);
    _notePop = null;
    document.removeEventListener('mousedown', _notePopOutside, true);
    document.removeEventListener('keydown', _notePopEsc, true);
  }
  function _notePopOutside(ev) {
    if (_notePop && !_notePop.contains(ev.target)) closeNoteEditor();
  }
  function _notePopEsc(ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); closeNoteEditor(); }
  }
  function openNoteEditor(nodeId) {
    var idx = nodeIdx(nodeId);
    if (idx < 0) return;
    closeNoteEditor();
    if (S.outline && S.outline.hidePal) S.outline.hidePal();
    var existing = notesList().filter(function (n) { return n.node === nodeId; })[0] || null;
    var pop = document.createElement('div');
    pop.className = 'note-pop';
    pop.innerHTML =
      '<div class="np-hd"><span class="np-t">筆記</span><span class="np-s">第 ' + (idx + 1) + ' 句</span>'
      + '<button class="np-x" title="關閉（Esc）">✕</button></div>'
      + '<textarea class="np-ta" placeholder="在這句話旁寫下筆記…（⌘/Ctrl+Enter 儲存）"></textarea>'
      + '<div class="np-ft">'
      + '<button class="np-btn np-del"' + (existing ? '' : ' disabled') + '>刪除</button>'
      + '<span class="np-sp"></span>'
      + '<button class="np-btn np-cancel">取消</button>'
      + '<button class="np-btn primary np-ok">儲存</button>'
      + '</div>';
    pop.style.visibility = 'hidden';
    document.body.appendChild(pop);
    var ta = pop.querySelector('.np-ta');
    ta.value = existing ? (existing.text || '') : '';
    var row = S.outline && S.outline.rowEls ? S.outline.rowEls[nodeId] : null;
    var r = row ? row.getBoundingClientRect() : null;
    var pw = pop.offsetWidth || 268, ph = pop.offsetHeight || 160;
    var vw = window.innerWidth, vh = window.innerHeight;
    var x, y;
    if (r) {
      x = r.right + 16;
      if (x + pw > vw - 12) x = Math.max(12, r.left - pw - 16);
      y = Math.max(12, Math.min(r.top - 8, vh - ph - 12));
    } else { x = (vw - pw) / 2; y = 80; }
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.style.visibility = 'visible';
    _notePop = pop;
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}

    function doSave() {
      var txt = ta.value.trim();
      if (!txt) { if (existing) removeNote(existing); closeNoteEditor(); return; }
      var n = addNote(nodeId, ta.value);
      closeNoteEditor();
      toast(existing ? '筆記已更新。' : '筆記已加到句子右側（虛線相連）。');
      if (n) setTimeout(function () {
        var card = document.querySelector('.ol-note[data-id="' + n.id + '"] .n-tx');
        if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 40);
    }
    pop.querySelector('.np-ok').addEventListener('click', doSave);
    pop.querySelector('.np-cancel').addEventListener('click', closeNoteEditor);
    pop.querySelector('.np-x').addEventListener('click', closeNoteEditor);
    pop.querySelector('.np-del').addEventListener('click', function () {
      if (existing) removeNote(existing);
      closeNoteEditor();
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doSave(); }
      ev.stopPropagation();
    });
    pop.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    setTimeout(function () {
      document.addEventListener('mousedown', _notePopOutside, true);
      document.addEventListener('keydown', _notePopEsc, true);
    }, 0);
  }
  /* 行工具列的按鈕：豎版，每項＝圖示＋工具簡稱 */
  function mkBtn(icon, name, title, fn) {
    var b = document.createElement('button');
    b.className = 'btn sm ghost';
    b.title = title || name || '';
    var i = document.createElement('span');
    i.className = 'ic'; i.textContent = icon;
    var n = document.createElement('span');
    n.className = 'nm'; n.textContent = name || '';
    b.appendChild(i); b.appendChild(n);
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }
  /* 新增一句（插在当前行后面） */
  function addAfter(id) {
    var i = nodeIdx(id);
    if (i < 0) return;
    var nn = { id: GK.newId(), text: '', verse: null, ind: 0 };
    S.project.nodes.splice(i + 1, 0, nn);
    S.rowSel = nn.id;                 // 新增的行直接成為選取行，工具欄可繼續作用
    touch(); renderOutlineView(); refreshCuv();
    setTimeout(function () { editRow(nn.id); }, 60);
  }

  /* ---------------- 選定一行（供左側「行工具」作用） ----------------
     不再有「選擇」點選功能：一律用滑鼠右鍵點一行＝選定該行（同時彈出懸浮工具列）。 */
  function focusRow(id) {
    S.rowSel = id;
    applyRowSel();
    syncRail();
  }
  /* 在選定那一行打上 selected-row 標記。
     ⚠ 千萬不能用 'sel' 類名：CSS 已把 .sel 用在 <select> 下拉框上（max-width:190px 等），
     一旦套到整行，行會被壓成一團、看起來像「串行」。 */
  function applyRowSel() {
    var rows = document.querySelectorAll('.ol-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected-row', rows[i].dataset.id === S.rowSel);
    }
    var un = $('#rRowUnprep');
    if (un) {
      var n = S.rowSel ? S.project.nodes[nodeIdx(S.rowSel)] : null;
      un.style.display = (n && n.pa) ? '' : 'none';
    }
  }
  /* 工具列（左側 rail）對選定行做的動作 */
  function rowTool(t) {
    var id = S.rowSel;
    if (!id || nodeIdx(id) < 0) { toast('先在句子按滑鼠右鍵選定一行，再用這個工具。'); return; }
    if (t === 'up') move(id, -1);
    else if (t === 'down') move(id, 1);
    else if (t === 'add') addAfter(id);
    else if (t === 'merge') mergePrev(id);
    else if (t === 'link') linkPrompt(id);
    else if (t === 'unprep') clearPrepAlign(id);
    else if (t === 'del') { if (delNode(id)) { S.rowSel = null; applyRowSel(); toast('已刪除這一句。'); } }
  }
  /* 模式切換：剪句（B）／詞序（C）——游標與之對應；Esc 回到一般狀態 */
  function setRowTool(t) {
    if (t === 'scissor') { if (!S.scissor) setScissor(true); return; }
    if (t === 'word') { if (!S.wordMode) setWordMode(true); return; }
    exitRowTools();
  }
  function exitRowTools() {
    if (S.outline) S.outline.hidePal && S.outline.hidePal();
    if (S.scissor) setScissor(false);
    if (S.wordMode) setWordMode(false);
    syncRail();
  }
  /* 結構改變（合句、剪句、增刪、搬行）後重算並刷新和合本對照 map */
  function refreshCuv() {
    if (!cuvOn()) return;
    applyCuvOrdered();
  }
  /* 調換詞序時，把這一節的和合本「逐詞中文」跟著同一個置換搬過去，
     不向伺服器重算 —— 這樣中文與原文詞的配對不會掉詞，兩欄一起動。
     perm[k] = 新排第 k 位的詞原本在第幾個（依原文詞序）。 */
  function cuvReorderWords(idx, perm) {
    if (!cuvOn() || idx < 0) return;
    var wm = S.cuvWords[idx] ||
      (S.project.meta.cuv && S.project.meta.cuv.words && S.project.meta.cuv.words[idx]);
    if (!wm || !Object.keys(wm).length) { refreshCuv(); return; }
    if (!S.project.meta.cuv) S.project.meta.cuv = { name: '和合本', map: [] };
    var nd = {};
    for (var k = 0; k < perm.length; k++) {
      var src = wm[perm[k]];
      if (src != null && src !== '') nd[k] = src;
    }
    S.cuvWords[idx] = nd;
    if (!S.project.meta.cuv.words) S.project.meta.cuv.words = [];
    S.project.meta.cuv.words[idx] = nd;
    if (!S.project.meta.cuv.map) S.project.meta.cuv.map = [];
    var s = '';
    Object.keys(nd).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (k2) { s += nd[k2]; });
    S.project.meta.cuv.map[idx] = s;
  }
  /* 行工具列的「連關係」：用行號指定要連到哪一行 */
  function linkPrompt(id) {
    var i = nodeIdx(id);
    if (i < 0) return;
    var j = prompt('要把第 ' + (i + 1) + ' 行連到第幾行？（填行號，2~' + S.project.nodes.length + '）', String(i + 2));
    if (!j) return;
    var k = parseInt(j, 10);
    if (!(k >= 1) || k > S.project.nodes.length) { toast('行號超出範圍'); return; }
    if (k === i + 1) { toast('不能連到自己這一行'); return; }
    link(id, S.project.nodes[k - 1].id);
  }
  function redraw() { if (S.outline && S.outline.draw) S.outline.draw(); }

  /* 「重畫」＝清掉所有關係連線（句子全部保留）。
     這是破壞性動作，但可以用 ⌘Z 復原，所以先確認一次、再清。 */
  function clearAllRels() {
    var list = S.project.rels || [];
    var n = list.length;
    if (!n) { toast('目前沒有任何關係連線。'); return; }
    if (!confirm('刪除全部 ' + n + ' 條關係連線？\n\n'
        + '句子和筆記都會保留，只清掉連線與關係標記。\n'
        + '（不慎刪錯可以按 ⌘Z 復原）')) return;
    S.project.rels = [];
    S._newRel = null;
    touch();
    renderOutlineView();
    renderGraph();
    var g = $('#graph'); if (g) g.innerHTML = '';
    toast('已刪除全部 ' + n + ' 條關係連線（⌘Z 可復原）。');
  }

  /* ---------------- 關係：拖 A 到 B = 建立涵蓋 A..B 的括號 ---------------- */
  /* 把某一句連到某條「關係字」上＝這一句與那條關係所管的那一段之間的關係；
     新關係的範圍＝兩者的聯集（涵蓋中間所有句子），再跳出關係清單讓你命名。 */
  function linkToRel(aId, rId) {
    var i = nodeIdx(aId);
    if (i < 0) return;
    var raw = S.project.rels.filter(function (o) { return o.id === rId; })[0];
    if (!raw) return;
    var ai = nodeIdx(raw.a), bi = nodeIdx(raw.b);
    if (ai < 0 || bi < 0) return;
    if (ai > bi) { var t = ai; ai = bi; bi = t; }
    var lo = Math.min(ai, i), hi = Math.max(bi, i);
    if (i >= ai && i <= bi) { toast('這一句已經在「' + relLabel(raw) + '」那段關係裡面了。'); return; }
    if (lo === hi) { toast('這兩者是同一句，不需要再連。'); return; }
    link(S.project.nodes[lo].id, S.project.nodes[hi].id);
  }
  /* 拖「關係（合句）連結符號」放到某一句上＝那整段合句 × 這一句；
     新關係範圍＝兩者的聯集（涵蓋中間所有句子）。 */
  function pRelLink(seg, nodeId) {
    var i = nodeIdx(nodeId);
    if (i < 0) return;
    var ai = seg.ai, bi = seg.bi;
    if (i >= ai && i <= bi) { toast('這一句就在那段「合句」裡面，不用再連。'); return; }
    var lo = Math.min(ai, i), hi = Math.max(bi, i);
    link(S.project.nodes[lo].id, S.project.nodes[hi].id);
  }
  function link(aId, bId, opt) {
    opt = opt || {};
    var i = nodeIdx(aId), j = nodeIdx(bId);
    if (i < 0 || j < 0 || i === j) return;
    var ai = Math.min(i, j), bi = Math.max(i, j);
    var a = S.project.nodes[ai].id, b = S.project.nodes[bi].id;
    var exist = S.project.rels.filter(function (o) { return o.a === a && o.b === b; })[0];
    if (exist) { if (!opt.silent) openRelPicker(exist); return; }
    var rel = { id: GK.newId(), a: a, b: b, label: '', star: false, starAt: '', type: 'factinterp' };
    S.project.rels.push(rel);
    touch(); renderOutlineView(); renderGraph();
    S._newRel = rel;                 // 取消命名就回收，不留空關係
    if (!opt.silent) openRelPicker(rel);
  }
  function unlink(r) {
    S.project.rels = S.project.rels.filter(function (o) { return o.id !== r.id; });
    if (S._newRel && S._newRel.id === r.id) S._newRel = null;
    if (S.gSel && S.gSel.t === 'r' && S.gSel.id === r.id) S.gSel = null;
    touch(); renderOutlineView(); renderGraph();
  }

  /* ---------------- 關係挑選器 ---------------- */
  function relDesc(r) {
    var ai = nodeIdx(r.a), bi = nodeIdx(r.b);
    if (ai < 0 || bi < 0) return '';
    var n1 = S.project.nodes[ai], n2 = S.project.nodes[bi];
    var v1 = n1.verse ? n1.verse + ' ' : '';
    var v2 = n2.verse ? n2.verse + ' ' : '';
    var L = GK.layout(S.project);
    var dep = 0, j;
    for (j = 0; j < L.rels.length; j++) {
      var q = L.rels[j];
      if (q.raw === r && L.depth) { dep = L.depth[j]; break; }
    }
    return '第 ' + (ai + 1) + '~' + (bi + 1) + ' 行｜' + v1 + '…　到　' + v2 + '…' +
      '　（巢狀第 ' + (dep + 1) + ' 層，程式自動排；涵蓋 ' + (bi - ai + 1) + ' 句）';
  }
  function openRelPicker(r) {
    S.editBox = r;
    var list = $('#relList');
    list.innerHTML = '';
    S.relations.forEach(function (x) {
      var b = document.createElement('button');
      b.className = 'rel' + (r.type === x.id ? ' on' : '');
      b.innerHTML = '<div class="rt"><span class="rs">' + esc(x.short) + '</span>' +
        '<span class="rn">' + esc(x.name) + '</span><span class="re">' + esc(x.en) + '</span></div>' +
        '<div class="rd">' + esc(x.desc) + '</div>' +
        (x.keys ? '<div class="rk">' + esc(x.keys) + '</div>' : '');
      b.addEventListener('click', function () {
        r.type = x.id; r.label = '';
        $$('#relList .rel').forEach(function (y) { y.classList.remove('on'); });
        b.classList.add('on');
        syncRelPreview();
      });
      list.appendChild(b);
    });
    $('#relStarMode').value = (!r.star ? '' : (r.starAt === 'first' ? 'first' : 'second'));
    $('#relCustom').value = r.label || '';
    $('#relRange').textContent = relDesc(r);
    syncRelPreview();
    $('#relMask').classList.add('on');
  }
  function syncRelPreview() {
    var r = S.editBox; if (!r) return;
    var c = $('#relCustom').value.trim();
    var t = c || (relById(r.type) ? relById(r.type).short : '?');
    $('#relPreview').textContent = t;
  }
  function closeRelPicker(cancelled) {
    // 剛拉出來、還沒命名就取消 → 把這條空關係回收，不留垃圾
    if (cancelled && S.editBox && S.editBox === S._newRel) {
      S.project.rels = S.project.rels.filter(function (o) { return o !== S._newRel; });
      touch(); renderOutlineView(); renderGraph();
    }
    S._newRel = null;
    $('#relMask').classList.remove('on'); S.editBox = null;
  }

  $('#relOk').addEventListener('click', function () {
    var r = S.editBox;
    if (r) {
      var mode = $('#relStarMode') ? $('#relStarMode').value : '';
      r.star = !!mode;
      r.starAt = (mode === 'first' || mode === 'second') ? mode : '';
      var c = $('#relCustom').value.trim();
      var d = relById(r.type);
      r.label = (c && c !== (d ? d.short : '')) ? c.replace(/\*$/, '') : '';
      touch(); renderOutlineView(); renderGraph();
    }
    closeRelPicker();
  });
  $('#relRemove').addEventListener('click', function () {
    if (S.editBox) unlink(S.editBox);
    closeRelPicker();
  });
  $('#relCancel').addEventListener('click', function () { closeRelPicker(true); });
  $('#relMask').addEventListener('click', function (ev) { if (ev.target === $('#relMask')) closeRelPicker(true); });
  $('#relStarMode').addEventListener('change', syncRelPreview);
  $('#relCustom').addEventListener('input', syncRelPreview);

  /* ---------------- 逐字樣式（1.6.1）：加粗／斜體／底線／字色 ----------------
     雙擊句子進入編輯時，句子上方懸浮工具列（B／I／U ＋ 8 色）。
     ✦ 只改「選取到的那一段字」，不是整句。
     樣式存在 node.rs = [{a,z,b,i,u,c}]（a/z＝node.text 的字元位移，z 不含），
     希臘文與右側對應的和合本一起套、一起存、也印進 PDF。 */
  var EDIT_COLORS = ['#c0392b', '#e67e22', '#b8860b', '#2e7d32', '#1565c0', '#6b3fa0', '#111111', '#5c574e'];
  var COLOR_NAMES = ['紅', '橙', '金', '綠', '藍', '紫', '黑', '灰'];
  var EDITING = null;          // 目前正在編輯的句子 id
  var EDIT_EL = null;          // 目前正在編輯的 .ol-text 元素

  function nodeById(id) { for (var i = 0; i < S.project.nodes.length; i++) if (S.project.nodes[i].id === id) return S.project.nodes[i]; return null; }
  function rsAt(runs, off) {
    if (!runs) return null;
    var hit = null;
    for (var i = 0; i < runs.length; i++) { var r = runs[i]; if (off >= r.a && off < r.z) hit = r; }
    return hit;
  }
  function rsNorm(st) { return (st && (st.b || st.i || st.u || st.c)) ? { b: st.b ? 1 : 0, i: st.i ? 1 : 0, u: st.u ? 1 : 0, c: st.c || null } : null; }
  function rsSame(a, b) {
    if (!a || !b) return (!a && !b);
    return a.b === b.b && a.i === b.i && a.u === b.u && (a.c || null) === (b.c || null);
  }
  // 把 [A,Z) 這段字的樣式用 mut() 換掉，其餘不動；順便合併相鄰同款式。
  function rsApply(n, A, Z, mut) {
    var runs = n.rs || [];
    var pts = [A, Z];
    runs.forEach(function (r) { pts.push(r.a, r.z); });
    pts = pts.filter(function (v, i) { return v >= 0 && pts.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var s = pts[i], e = pts[i + 1];
      if (e <= s) continue;
      var mid = (s + e) / 2;
      var cur = rsNorm(rsAt(runs, mid));
      var st = (mid >= A && mid < Z) ? rsNorm(mut(cur)) : cur;
      if (!st) continue;
      out.push({ a: s, z: e, b: st.b, i: st.i, u: st.u, c: st.c });
    }
    var merged = [];
    out.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && last.z === r.a && rsSame(last, r)) last.z = r.z; else merged.push(r);
    });
    if (merged.length) n.rs = merged; else delete n.rs;
  }
  // 編輯結束時收掉前後多餘空白，並把樣式位移一起平移
  function trimRemap(n) {
    var T = n.text || '';
    var lead = T.length - T.replace(/^\s+/, '').length;
    var trail = T.length - T.replace(/\s+$/, '').length;
    if (!lead && !trail) return;
    var end = T.length - trail;
    n.text = T.slice(lead, end);
    if (n.rs) {
      n.rs = n.rs.map(function (r) { return { a: r.a - lead, z: r.z - lead, b: r.b, i: r.i, u: r.u, c: r.c }; })
        .filter(function (r) { return r.z > 0 && r.a < n.text.length; })
        .map(function (r) { r.a = Math.max(0, r.a); r.z = Math.min(n.text.length, r.z); return r; });
      if (!n.rs.length) delete n.rs;
    }
  }

  // 取得目前選取範圍（相對 el 純文字的位移）
  function selOffsets(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    var pre = document.createRange();
    pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
    var a = pre.toString().length;
    return { a: a, z: a + r.toString().length };
  }
  function setSelRange(el, a, z) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), node, pos = 0;
    var sn = null, so = 0, en = null, eo = 0;
    while ((node = w.nextNode())) {
      var len = node.nodeValue.length;
      if (sn === null && pos + len >= a) { sn = node; so = a - pos; }
      if (pos + len >= z) { en = node; eo = z - pos; break; }
      pos += len;
    }
    if (!sn) return;
    if (!en) { en = sn; eo = so; }
    var r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
    var sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  }

  // 把編輯中的元素依 n.text + n.rs 重畫（保留選取）
  function refreshEditEl(n, el) {
    if (!el) return;
    var sel = selOffsets(el);
    el.textContent = '';
    if (GK && GK.fillRich) GK.fillRich(el, n.text || '', n.rs);
    else el.textContent = n.text || '';
    try { el.focus(); } catch (e) {}
    if (sel) setSelRange(el, sel.a, sel.z);
  }
  // 在有選取時只改選取段；沒選取時改整句
  function toggleStyle(prop, val) {
    if (!EDITING) return;
    var n = nodeById(EDITING); if (!n) return;
    var sel = EDIT_EL ? selOffsets(EDIT_EL) : null;
    var a, z;
    if (sel && sel.z > sel.a) { a = sel.a; z = sel.z; }
    else { a = 0; z = (n.text || '').length; }
    rsApply(n, a, z, function (st) {
      st = st || { b: 0, i: 0, u: 0, c: null };
      if (prop === 'color') st.c = (st.c === val) ? null : val;
      else st[prop] = st[prop] ? 0 : 1;
      return st;
    });
    if (EDIT_EL) refreshEditEl(n, EDIT_EL);
    touch();
    var bar = $('#editBar');
    if (bar && bar.classList.contains('on')) refreshBarState();
  }

  function positionEditBar(el) {
    var bar = $('#editBar');
    if (!bar || !el) return;
    bar.classList.add('on');
    var r = el.getBoundingClientRect();
    var w = bar.offsetWidth || 300, h = bar.offsetHeight || 32;
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var left = Math.max(8, Math.min(r.left, vw - w - 8));
    var top = r.top - h - 6;
    if (top < 8) top = Math.min(r.bottom + 6, vh - h - 8);   // 上方放不下改放下方
    bar.style.left = left + 'px';
    bar.style.top = Math.max(8, top) + 'px';
  }

  function hideEditBar() {
    var bar = $('#editBar');
    if (bar) { bar.classList.remove('on'); bar.innerHTML = ''; }
    EDITING = null; EDIT_EL = null;
  }

  function showEditBar(node, el) {
    var bar = $('#editBar');
    if (!bar) return;
    EDITING = node.id;
    EDIT_EL = el || null;
    bar.innerHTML = '';
    function mk(label, title, fn) {
      var b = document.createElement('button');
      b.className = 'eb-b';
      b.type = 'button';
      b.title = title;
      b.innerHTML = label;
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });  // 不讓編輯框失焦
      b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
      bar.appendChild(b);
      return b;
    }
    mk('<b>B</b>', '加粗選取文字（⌘B）；沒選取時＝整句', function () { toggleStyle('b'); });
    mk('<i>I</i>', '斜體選取文字（⌘I）；沒選取時＝整句', function () { toggleStyle('i'); });
    mk('<u>U</u>', '下劃線選取文字（⌘U）；沒選取時＝整句', function () { toggleStyle('u'); });
    var sep = document.createElement('span'); sep.className = 'eb-sep'; bar.appendChild(sep);
    EDIT_COLORS.forEach(function (c, ci) {
      var s = document.createElement('button');
      s.type = 'button';
      s.className = 'eb-sw';
      s.dataset.c = c;
      s.style.background = c;
      s.title = '字色：' + COLOR_NAMES[ci] + '（套用在選取文字）';
      s.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      s.addEventListener('click', function (ev) { ev.stopPropagation(); toggleStyle('color', c); });
      bar.appendChild(s);
    });
    var sep2 = document.createElement('span'); sep2.className = 'eb-sep'; bar.appendChild(sep2);
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'eb-x'; x.textContent = '✕'; x.title = '完成／收起';
    x.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    x.addEventListener('click', function (ev) { ev.stopPropagation(); finishEdit(); });
    bar.appendChild(x);
    // 點工具列以外的地方 → 結束編輯（工具列本身不結束）
    if (!bar._wired) {
      bar._wired = true;
      document.addEventListener('mousedown', function (ev) {
        if (!EDITING) return;
        if (ev.target && ev.target.closest && ev.target.closest('#editBar')) return;
        if (ev.target && ev.target.closest && ev.target.closest('.ol-text.editing')) return;
        finishEdit();
      }, true);
      window.addEventListener('scroll', function () {
        if (!EDITING) return;
        var e = document.querySelector('.ol-text[data-id="' + EDITING + '"]');
        if (e) positionEditBar(e); else hideEditBar();
      }, true);
    }
    refreshBarState();
    positionEditBar(el);
  }

  // 工具列按鈕的亮燈狀態：依「目前選取段（沒選取＝整句）」的樣式顯示
  // 工具列按鈕的亮燈狀態：依「目前選取段（沒選取＝整句）」的樣式顯示
  function refreshBarState() {
    var bar = $('#editBar');
    if (!bar || !EDITING) return;
    var n = nodeById(EDITING); if (!n) return;
    var sel = EDIT_EL ? selOffsets(EDIT_EL) : null;
    var st;
    if (sel && sel.z > sel.a) {
      // 選取模式：看選取起點那一段字的樣式
      st = rsAt(n.rs, sel.a) || { b: 0, i: 0, u: 0, c: null };
    } else {
      // 整句模式：三個鍵＝全句皆具該樣式才亮；整句同一字色才亮色票
      var runs = n.rs || [], L = (n.text || '').length;
      var all = function (p) {
        return L > 0 && runs.filter(function (r) { return r[p]; })
          .reduce(function (a, r) { return a + (r.z - r.a); }, 0) >= L;
      };
      st = { b: all('b') ? 1 : 0, i: all('i') ? 1 : 0, u: all('u') ? 1 : 0,
             c: (runs.length === 1 && runs[0].a === 0 && runs[0].z === L) ? (runs[0].c || null) : null };
    }
    var bs = bar.querySelectorAll('.eb-b');
    if (bs[0]) bs[0].classList.toggle('on', !!st.b);
    if (bs[1]) bs[1].classList.toggle('on', !!st.i);
    if (bs[2]) bs[2].classList.toggle('on', !!st.u);
    var sws = bar.querySelectorAll('.eb-sw');
    for (var i = 0; i < sws.length; i++) sws[i].classList.toggle('on', sws[i].dataset.c === st.c);
  }

  function finishEdit() {
    if (!EDITING) return;
    var id = EDITING;
    hideEditBar();
    var e = document.querySelector('.ol-text.editing[data-id="' + id + '"]');
    if (e && e._finish) e._finish(true);
  }

  /* ---------------- 子句編輯 ---------------- */
  function inlineEdit(node, el) {
    el.classList.add('editing');
    refreshEditEl(node, el);       // 依 node.text + node.rs 畫（帶逐字樣式）
    el.contentEditable = 'plaintext-only';
    el.focus();
    // 編輯中：這一行暫時不可拖（否則選字會變成拖動整行）——見 1.6.0 bug 1
    var row = el.closest ? el.closest('.ol-row') : null;
    if (row) { row._wasDraggable = row.draggable; row.draggable = false; row.classList.add('editing-row'); }
    var r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    var sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(r); }
    showEditBar(node, el);
    function finish(save) {
      el.contentEditable = 'false';
      el.classList.remove('editing');
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('selectionchange', onSel);
      el._finish = null;
      if (row) { row.classList.remove('editing-row'); if (row._wasDraggable != null) row.draggable = row._wasDraggable; }
      if (EDITING === node.id) hideEditBar();
      if (save) { node.text = el.textContent.replace(/\s+/g, ' ').trim(); trimRemap(node); touch(); }
      renderOutlineView();
    }
    el._finish = finish;
    function onBlur() { /* 改由工具列／外部點擊控制，不用 blur 直接結束 */ }
    function onSel() { if (EDITING === node.id) refreshBarState(); }
    function onKey(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(true); return; }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey) {
        var k = String(ev.key || '').toLowerCase();
        if (k === 'b' || k === 'i' || k === 'u') { ev.preventDefault(); toggleStyle(k); }
      }
    }
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
    document.addEventListener('selectionchange', onSel);
  }

  /* 雙擊直接改這句的和合本對照 */
  function inlineEditCuv(node, el) {
    var i = nodeIdx(node.id);
    if (i < 0) return;
    var map = cuvMap();
    el.classList.add('editing');
    el.textContent = map[i] || '';
    el.contentEditable = 'plaintext-only';
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    function finish(save) {
      el.contentEditable = 'false';
      el.classList.remove('editing');
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      if (save) { map[i] = el.textContent.replace(/\s+/g, '').trim(); touch(); }
      renderOutlineView();
    }
    function onBlur() { finish(true); }
    function onKey(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    }
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
  }

  function splitHere(node) {
    var el = document.querySelector('.ol-text[data-id="' + node.id + '"]');
    if (!el) return;
    var sel = window.getSelection(), offset = null;
    if (sel.rangeCount && el.contains(sel.anchorNode)) {
      var pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(sel.anchorNode, sel.anchorOffset);
      offset = pre.toString().length;
    }
    if (offset == null || offset <= 0 || offset >= node.text.length) {
      toast('請先在句中把游標放好，再按 ✂'); return;
    }
    var a = node.text.slice(0, offset).trim(), b = node.text.slice(offset).trim();
    node.text = a;
    var i = nodeIdx(node.id);
    S.project.nodes.splice(i + 1, 0, { id: GK.newId(), text: b, verse: null, ind: 0 });
    touch(); renderOutlineView();
  }

  function mergePrev(id) {
    var i = nodeIdx(id);
    if (i <= 0) { toast('已經是第一句'); return; }
    var pv = S.project.nodes[i - 1];
    pv.text = (pv.text + ' ' + S.project.nodes[i].text).trim();
    S.project.nodes.splice(i, 1);
    S.project.rels = S.project.rels.filter(function (o) {
      if (o.a === id) o.a = pv.id;
      if (o.b === id) o.b = pv.id;
      return nodeIdx(o.a) >= 0 && nodeIdx(o.b) >= 0 && o.a !== o.b;
    });
    refreshMarksIfChanged();
    touch(); renderOutlineView(); refreshCuv();
  }

  function delNode(id) {
    var i = nodeIdx(id);
    if (i < 0) return false;
    S.project.nodes.splice(i, 1);
    var fallback = (S.project.nodes[i] || S.project.nodes[i - 1] || {}).id;
    S.project.rels = S.project.rels.filter(function (o) {
      if (o.a === id) o.a = fallback;
      if (o.b === id) o.b = fallback;
      return o.a && o.b && o.a !== o.b && nodeIdx(o.a) >= 0 && nodeIdx(o.b) >= 0;
    });
    // 被刪掉那一句的筆記一併清掉（不做孤兒卡片）
    if (S.project.notes && S.project.notes.length) {
      S.project.notes = S.project.notes.filter(function (n) { return n.node !== id; });
    }
    if (S.gSel && S.gSel.t === 'n' && S.gSel.id === id) S.gSel = null;
    touch(); renderOutlineView(); renderGraph(); refreshCuv();
    return true;
  }

  function move(id, dir) {
    var i = nodeIdx(id), j = i + dir;
    if (i < 0 || j < 0 || j >= S.project.nodes.length) return;
    var n = S.project.nodes;
    var t = n[i]; n[i] = n[j]; n[j] = t;
    touch(); renderOutlineView(); refreshCuv();
  }

  function addClause() {
    var nn = { id: GK.newId(), text: '', verse: null, ind: 0 };
    S.project.nodes.push(nn);
    touch(); renderOutlineView();
    setTimeout(function () { editRow(nn.id); }, 60);
  }
  /* 讓指定行直接進入編輯（新增空白行後立即打字） */
  function editRow(id) {
    var el = document.querySelector('.ol-text[data-id="' + id + '"]');
    if (!el) return;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }

  /* ---------------- 關係總表 ---------------- */
  function renderTable() {
    var box = $('#relTable');
    if (!box) return;
    var rows = S.project.rels.map(function (o) {
      return { o: o, ai: nodeIdx(o.a), bi: nodeIdx(o.b) };
    }).filter(function (r) { return r.ai >= 0 && r.bi >= 0; });
    rows.sort(function (a, b) { return (a.ai - b.ai) || (b.bi - a.bi); });
    box.textContent = '';
    if (!rows.length) {
      box.innerHTML = '<div class="empty">還沒有任何關係。在「縮排分析」把 ⛓ 把手拖到另一行即可建立。</div>';
      return;
    }
    var head = document.createElement('div');
    head.className = 'rt-head';
    ['行範圍', '句數', '標記', '關係'].forEach(function (c) {
      var s = document.createElement('span');
      s.textContent = c;
      head.appendChild(s);
    });
    box.appendChild(head);
    rows.forEach(function (r) {
      var rel = relById(r.o.type);
      var row = document.createElement('div');
      row.className = 'rt-row';
      [[(r.ai + 1) + '~' + (r.bi + 1), 'c1'], [String(r.bi - r.ai + 1), 'c2'],
       [relLabel(r.o), 'c3'], [rel ? rel.name : '', 'c4']].forEach(function (c) {
        var s = document.createElement('span');
        s.className = c[1];
        s.textContent = c[0];
        row.appendChild(s);
      });
      row.addEventListener('click', function () { openRelPicker(r.o); });
      box.appendChild(row);
    });
  }

  var GMIND = { COLW: 250, VGAP: 22, PADX: 40, PADY: 34 };
  var BRANCH_COLORS = ['#c58a2e', '#3f7fa6', '#7a9a54', '#a5563f', '#6a5aa6', '#2f8f83', '#b06696'];

  function syncCuvHot(id, on) {
    if (S.gCuvEls && S.gCuvEls[id]) S.gCuvEls[id].classList.toggle('hot', !!on);
  }
  function selectGraph(sel) {
    S.gSel = sel || null;
    $$('.gnode.sel').forEach(function (e) { e.classList.remove('sel'); });
    $$('.glbl2.sel').forEach(function (e) { e.classList.remove('sel'); });
    if (!S.gSel) return;
    var el = (S.gSel.t === 'r')
      ? document.querySelector('.glbl2[data-id="' + S.gSel.id + '"]')
      : document.querySelector('.gnode.leaf[data-id="' + S.gSel.id + '"]');
    if (el) el.classList.add('sel');
  }

  /* 關係圖：句子方塊靠右排成一欄；每條關係＝一條豎線，關係詞寫在豎線中點，
     豎線有手臂連到它的每個子節點。子關係的接點落在自己豎線的中點
     （＝「折線中間再接一條線」）。拓樸與縮排分析／PDF 完全一致。
     每條關係都獨立畫，不靠樹走訪 → 不會漏掉任何一條。 */
  function renderGraph() {
    var box = $('#graph');
    if (!box) return;
    box.textContent = '';
    if (!S.project.nodes.length) {
      box.innerHTML = '<div class="empty" style="padding:24px">還沒有內容。先在上面選經文或貼上。</div>';
      return;
    }
    var L = GK.layout(S.project);
    var C = GMIND;
    var zoom = S.gzoom || 1;
    var GAP = GK.GAP_PT * GK.PT;                 // 每層往左 14.2pt

    var inner = document.createElement('div');
    inner.className = 'graph-inner';
    box.appendChild(inner);

    /* --- 1) 葉節點（每個子句一個方塊） --- */
    var leafEls = [], leafW = [], leafH = [];
    L.nodes.forEach(function (n, i) {
      var d = document.createElement('div');
      d.className = 'gnode leaf';
      d.dataset.id = n.id;
      if (n.verse) {
        var gv = document.createElement('span');
        gv.className = 'gv'; gv.textContent = n.verse;
        d.appendChild(gv);
      }
      var gt = document.createElement('div');
      gt.className = 'gt';
      fillProperText(gt, n.text || '');   // 1.5.0：人名／地名／國族加下劃線
      d.appendChild(gt);
      var port = document.createElement('div');
      port.className = 'port l';
      port.title = '滑到圓點→出現動畫連線；按住拖到另一句放開＝建立關係（涵蓋中間所有句子）；拖到一條「關係字」上放開＝這一句和上一段之間的關係。';
      d.appendChild(port);
      port.addEventListener('mouseenter', function () { beginLink(n.id, d, port); });
      makeDraggable(d, n);
      inner.appendChild(d);
      leafEls[i] = d;
      leafW[i] = d.offsetWidth || 150;
      leafH[i] = d.offsetHeight || 30;
    });

    var maxBoxW = 0;
    for (var q = 0; q < leafW.length; q++) maxBoxW = Math.max(maxBoxW, leafW[q]);
    var maxRelDepth = 0;
    L.rels.forEach(function (r, j) { maxRelDepth = Math.max(maxRelDepth, L.depth[j] || 0); });

    var BOXX = C.PADX + (maxRelDepth + 1) * GAP;   // 方塊那一欄的左緣
    var W0 = BOXX + maxBoxW + C.PADX + 40;

    /* --- 2) 垂直：葉依序堆疊；關係＝其首尾子節點的中點 --- */
    var y = C.PADY, leafY = [];
    for (var i2 = 0; i2 < L.nodes.length; i2++) {
      var obj = L.nodes[i2];
      var h = leafH[i2];
      var yy = (obj.gy != null) ? obj.gy : (y + h / 2);
      leafY[i2] = yy;
      y = Math.max(y, (obj.gy != null) ? yy + h / 2 : yy + h / 2) + C.VGAP;
    }
    var Hh = Math.max(y + C.PADY, 260);

    var ycache = {};
    function yOf(k) {
      if (k.t === 'n') return leafY[k.i];
      if (ycache[k.i] != null) return ycache[k.i];
      var kids = L.childrenOf(k.i);
      if (!kids.length) { ycache[k.i] = leafY[L.rels[k.i].ai]; return ycache[k.i]; }
      ycache[k.i] = (yOf(kids[0]) + yOf(kids[kids.length - 1])) / 2;
      return ycache[k.i];
    }

    /* --- 3) 水平 ---
       方塊平常排在右邊一欄，也可以自由拖開（位置記在 node.gx）。
       關係豎線改用「遞迴」公式： barX = 子節點接點的最左值 − GAP
       （子節點是方塊→取方塊左緣；子節點是關係→取那條豎線）。
       這與縮排分析／匯出 PDF 共用同一套：巢狀時線會一層層往左讓開，
       所以不會互相交叉；而且手臂直接連到方塊左緣（圓點所在），拖開也不會脫節。 */
    function leafX(i) {
      var gx = L.nodes[i].gx;
      return (gx != null) ? gx : BOXX;
    }
    var barXa = new Array(L.rels.length);
    function calcBarX(j) {
      if (barXa[j] != null) return barXa[j];
      var m = Infinity;
      L.childrenOf(j).forEach(function (k) {
        var x = (k.t === 'n') ? leafX(k.i) : calcBarX(k.i);
        if (x < m) m = x;
      });
      barXa[j] = (m === Infinity ? BOXX : m) - GAP;
      return barXa[j];
    }
    L.rels.forEach(function (r, j) { calcBarX(j); });

    var minX = BOXX;
    L.nodes.forEach(function (n, i) { minX = Math.min(minX, leafX(i)); });
    L.rels.forEach(function (r, j) { minX = Math.min(minX, barXa[j]); });
    var off = (minX < C.PADX) ? (C.PADX - minX) : 0;
    S._gOff = off;                       // 拖曳時要把位移換回「未加留白」座標
    function attachX(k) { return ((k.t === 'n') ? leafX(k.i) : barXa[k.i]) + off; }

    var maxRight = 0;
    for (var i3 = 0; i3 < L.nodes.length; i3++) {
      var el = leafEls[i3];
      el.style.left = (leafX(i3) + off) + 'px';
      el.style.top = (leafY[i3] - leafH[i3] / 2) + 'px';
      maxRight = Math.max(maxRight, leafX(i3) + off + leafW[i3]);
    }
    var W = Math.max(W0 + off, maxRight + C.PADX + 40);
    inner.style.position = 'relative';
    inner.style.width = W + 'px';
    inner.style.height = Hh + 'px';
    inner.style.zoom = zoom;

    /* --- 4) 連線 --- */
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'gsvg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', Hh);
    inner.insertBefore(svg, inner.firstChild);

    var COLOR = BRANCH_COLORS;
    L.rels.forEach(function (r, j) {
      var kids = L.childrenOf(j);
      if (!kids.length) return;
      var x = barXa[j] + off;
      var k0 = kids[0], k1 = kids[kids.length - 1];
      var y0 = yOf(k0), y1 = yOf(k1);
      // 一條路徑：豎線 + 每條手臂（「折線中間再接一條線」）
      var dstr = 'M' + x + ' ' + y0 + ' V' + y1;
      kids.forEach(function (k) { dstr += ' M' + x + ' ' + yOf(k) + ' H' + attachX(k); });

      var raw = r.raw;
      var color = COLOR[L.depth[j] % COLOR.length];
      var weight = Math.max(1.4, 2.6 - (L.depth[j] || 0) * 0.16);
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', dstr);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', weight);
      p.setAttribute('stroke-opacity', '0.9');
      p.setAttribute('stroke-linejoin', 'miter');
      p.setAttribute('pointer-events', 'stroke');
      p.style.cursor = 'pointer';
      p.dataset.id = raw.id;
      p.addEventListener('click', function (ev) { ev.stopPropagation(); selectGraph({ t: 'r', id: raw.id }); });
      p.addEventListener('dblclick', function (ev) { ev.stopPropagation(); openRelPicker(raw); });
      svg.appendChild(p);

      // 關係詞：寫在這條豎線的中點（＝線「中間」）
      var lab = document.createElement('div');
      lab.className = 'glbl2' + (S.gSel && S.gSel.t === 'r' && S.gSel.id === raw.id ? ' sel' : '');
      lab.dataset.id = raw.id;
      lab.textContent = relLabel(raw);
      lab.title = '點一下選取（按 Delete 刪除）；按兩下可改這條關係';
      lab.style.left = x + 'px';
      lab.style.top = ((y0 + y1) / 2) + 'px';
      lab.addEventListener('click', function (ev) { ev.stopPropagation(); selectGraph({ t: 'r', id: raw.id }); });
      lab.addEventListener('dblclick', function (ev) { ev.stopPropagation(); openRelPicker(raw); });
      // 從「關係字」也可以拉出一條線，去連別的句子方塊或另一條關係字
      lab.addEventListener('mouseenter', function () {
        if (S.gEdge && S.gEdge.t === 'n') { stopEdgePreview(); S.gEdge = null; }
        if (!S.gEdge && !S.relDragInit) beginRelLink(raw.id, lab);
      });
      inner.appendChild(lab);
    });

    updateZoomLabel();
    renderGraphCuv(L, null);

    if (!renderGraph._fontsHooked) {
      renderGraph._fontsHooked = 1;
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (S.tab === 'graph') renderGraph(); });
      }
    }
  }

  /* ---------------- 關係圖右側：和合本對照 ---------------- */
  function renderGraphCuv(L, tree) {
    var body = $('#graphCuvBody');
    var wrap = $('#graphWrap');
    if (!body || !wrap) return;
    var hasCuv = cuvOn() && cuvMap().length;
    wrap.classList.toggle('no-cuv', !hasCuv);
    if (!hasCuv) {
      body.innerHTML = '<div class="gcuv-empty">還沒有和合本對照。在縮排分析按「和合本對照」或取經文時勾選「同時帶入和合本」，這裡就會自動列出來。</div>';
      return;
    }
    var map = cuvMap();
    body.innerHTML = '';
    L.nodes.forEach(function (n, i) {
      var r = document.createElement('div');
      r.className = 'gcuv-row';
      r.dataset.id = n.id;
      r.dataset.node = n.id;
      r.title = '點一下跳到縮排分析的這一句';
      var v = document.createElement('span');
      v.className = 'gv'; v.textContent = n.verse != null ? n.verse : '';
      var z = document.createElement('span');
      z.className = 'gz'; z.textContent = map[i] || '（這句沒對到中文）';
      r.appendChild(v); r.appendChild(z);
      r.addEventListener('click', function () {
        switchTab('outline');
        setTimeout(function () {
          var row = document.querySelector('.ol-row[data-id="' + n.id + '"]');
          if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 60);
      });
      body.appendChild(r);
    });
    S.gCuvEls = {};
    body.querySelectorAll('.gcuv-row').forEach(function (el) { S.gCuvEls[el.dataset.node] = el; });
  }

  /* ---- 拉線：滑到圓點就出現「跟著滑鼠跑、流動虛線」的動畫預覽線 ---- */
  function beginLink(fromId, fromEl, port) {
    // 拖曳進行中（已按住）不換來源：拖過別的方塊圓點時不能被搶走來源。
    if (S._gPressing && S.gEdge && S.gEdgeEl !== port) return;
    // ⚠ 殘留狀態防護（真實 bug）：只是「滑過」圓點、沒按鍵就移開時，
    //   S.gEdge 會被留著（_leave → stopEdgePreview 只收掉預覽線，沒清來源 id），
    //   下次任何 hover 都會被擋掉 → 圓點再也不出預覽線、也拉不動。
    if (S.gEdge && S.gEdgeEl === port) return;          // 同一個圓點重複觸發，忽略
    if (S.gEdge) {                                      // 清掉上一次滑過留下的殘留
      stopEdgePreview();
      S.gEdge = null;
      $$('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); });
    }
    S.gEdge = { t: 'n', id: fromId }; S.gEdgeEl = port;
    fromEl.classList.add('sel');
    startEdgePreview(fromEl, port);
    port.classList.add('dragging');
    // 只是滑過圓點、沒按左鍵 → 取消預覽並清掉殘留；正在拖就不中斷
    port._leave = function (ev) {
      if (!(S._gPressing || (ev && (ev.buttons & 1)))) {
        stopEdgePreview();
        S.gEdge = null;
        $$('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); });
      }
    };
    port.addEventListener('mouseleave', port._leave);
    if (!S._gEdgeUp) ensureEdgeUp();
  }
  /* 從「關係字」拉出一條線（＝把整段合句拿去連接） */
  function beginRelLink(rId, lab) {
    if (S._gPressing && S.gEdge && S.gEdgeEl !== lab) return;   // 拖曳中不換來源
    if (S.gEdge && S.gEdge.t === 'r' && S.gEdge.id === rId && S.gEdgeEl === lab) return;
    if (S.gEdge) {
      stopEdgePreview();
      S.gEdge = null;
      $$('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); });
    }
    S.gEdge = { t: 'r', id: rId }; S.gEdgeEl = lab;
    lab.classList.add('drag-src');
    startEdgePreview(lab, lab);
    ensureEdgeUp();
    var leave = function (ev) {
      if (!(S._gPressing || (ev && (ev.buttons & 1)))) {
        stopEdgePreview();
        S.gEdge = null;
        lab.classList.remove('drag-src');
      }
    };
    lab._leave = leave;
    lab.addEventListener('mouseleave', leave);
  }
  /* 放開時依「來源」與「目標」決定要建哪一條關係（句子圓點 / 關係字兩種來源共用） */
  function ensureEdgeUp() {
    if (S._gEdgeUp) return;
    S._gEdgeUp = function () {
      var from = S.gEdge;
      var tgt = S.gEdgeHover ? S.gEdgeHover.dataset.id : null;
      var tgtRel = S.gEdgeHoverRel ? S.gEdgeHoverRel.dataset.id : null;
      stopEdgePreview();
      $$('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); });
      $$('.glbl2.drag-src').forEach(function (x) { x.classList.remove('drag-src'); });
      S.gEdge = null;
      if (!from) return;
      if (from.t === 'n') {
        // 從句子圓點拉出的線
        if (tgtRel) linkToRel(from.id, tgtRel);
        else if (tgt && tgt !== from.id) link(from.id, tgt);
      } else if (from.t === 'r') {
        // 從關係字拉出的線：整段「合句」× 另一句／另一條關係
        var seg = relSegOf(from.id);
        if (!seg) return;
        if (tgtRel && tgtRel !== from.id) {
          var seg2 = relSegOf(tgtRel);
          if (seg2) linkSegSeg(seg, seg2);
          else if (tgt && !(tgt >= seg.ai && tgt <= seg.bi)) linkSegNode(seg, tgt);
        } else if (tgt && !(tgt >= seg.ai && tgt <= seg.bi)) {
          linkSegNode(seg, tgt);
        }
      }
    };
    document.addEventListener('mouseup', S._gEdgeUp);
  }
  function relSegOf(rId) {
    var raw = S.project.rels.filter(function (o) { return o.id === rId; })[0];
    if (!raw) return null;
    var ai = nodeIdx(raw.a), bi = nodeIdx(raw.b);
    if (ai < 0 || bi < 0) return null;
    if (ai > bi) { var t = ai; ai = bi; bi = t; }
    return { ai: ai, bi: bi };
  }
  function linkSegNode(seg, nodeId) {
    var i = nodeIdx(nodeId);
    if (i < 0) return;
    if (i >= seg.ai && i <= seg.bi) { toast('這一句已在那段「合句」裡面了。'); return; }
    var lo = Math.min(seg.ai, i), hi = Math.max(seg.bi, i);
    link(S.project.nodes[lo].id, S.project.nodes[hi].id);
  }
  function linkSegSeg(s1, s2) {
    if ((s1.ai <= s2.ai && s2.bi <= s1.bi) || (s2.ai <= s1.ai && s1.bi <= s2.bi)) {
      toast('這兩段已經是巢狀關係，不需要再連。'); return;
    }
    var lo = Math.min(s1.ai, s2.ai), hi = Math.max(s1.bi, s2.bi);
    link(S.project.nodes[lo].id, S.project.nodes[hi].id);
  }
  function startEdgePreview(fromEl, port) {
    stopEdgePreview();
    var inner = fromEl.parentNode;
    if (!inner) return;
    var z = S.gzoom || 1;
    var innerRect = inner.getBoundingClientRect();
    var pRect = port.getBoundingClientRect();
    var x1 = (pRect.left + pRect.width / 2 - innerRect.left) / z;
    var y1 = (pRect.top + pRect.height / 2 - innerRect.top) / z;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'gedge');
    svg.style.width = '100%';
    svg.style.height = '100%';
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + (x1 + 40) + ' ' + y1 + ' ' + (x1 + 40) + ' ' + y1 + ' ' + (x1 + 40) + ' ' + y1);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#c58a2e');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-opacity', '0.9');
    svg.appendChild(path);
    inner.appendChild(svg);
    S.gEdgeSvg = svg; S.gEdgePath = path;
    S.gEdgeXY = { x1: x1, y1: y1, inner: inner, z: z };
    S._gEdgeMove = function (ev) {
      var p = S.gEdgeXY; if (!p) return;
      var rr = inner.getBoundingClientRect();
      var x2 = (ev.clientX - rr.left) / p.z, y2 = (ev.clientY - rr.top) / p.z;
      var mx = (p.x1 + x2) / 2;
      if (S.gEdgePath) {
        S.gEdgePath.setAttribute('d', 'M' + p.x1 + ' ' + p.y1 + ' C' + mx + ' ' + p.y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
      }
      S._gPressing = !!(ev.buttons & 1);
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      // 放到「關係字」上＝這一句和上一段（那條關係管的那段）之間的關係
      var lbl = el && el.closest ? el.closest('.glbl2') : null;
      var selfRel = S.gEdge && S.gEdge.t === 'r' ? S.gEdge.id : null;
      if (lbl && selfRel && lbl.dataset.id === selfRel) lbl = null;
      if (lbl !== S.gEdgeHoverRel) {
        if (S.gEdgeHoverRel) S.gEdgeHoverRel.classList.remove('target');
        S.gEdgeHoverRel = lbl || null;
        if (S.gEdgeHoverRel) S.gEdgeHoverRel.classList.add('target');
      }
      var g = el && el.closest ? el.closest('.gnode') : null;
      var srcNode = S.gEdge && S.gEdge.t === 'n' ? S.gEdge.id : null;
      if (g !== S.gEdgeHover) {
        if (S.gEdgeHover) S.gEdgeHover.classList.remove('target');
        S.gEdgeHover = (g && g.dataset.id !== srcNode) ? g : null;
        if (S.gEdgeHover) S.gEdgeHover.classList.add('target');
      }
    };
    document.addEventListener('mousemove', S._gEdgeMove);
  }
  function stopEdgePreview() {
    if (S._gEdgeMove) { document.removeEventListener('mousemove', S._gEdgeMove); S._gEdgeMove = null; }
    if (S._gEdgeUp) { document.removeEventListener('mouseup', S._gEdgeUp); S._gEdgeUp = null; }
    if (S.gEdgeHover) { S.gEdgeHover.classList.remove('target'); S.gEdgeHover = null; }
    if (S.gEdgeHoverRel) { S.gEdgeHoverRel.classList.remove('target'); S.gEdgeHoverRel = null; }
    if (S.gEdgeEl) {
      if (S.gEdgeEl._leave) { S.gEdgeEl.removeEventListener('mouseleave', S.gEdgeEl._leave); S.gEdgeEl._leave = null; }
      S.gEdgeEl.classList.remove('dragging'); S.gEdgeEl = null;
    }
    $$('.port.dragging').forEach(function (p) { p.classList.remove('dragging'); });
    S._gPressing = false;                 // 拖曳狀態歸零，避免殘留 true 擋住下次 _leave
    if (S.gEdgeSvg && S.gEdgeSvg.parentNode) S.gEdgeSvg.parentNode.removeChild(S.gEdgeSvg);
    S.gEdgeSvg = null; S.gEdgePath = null; S.gEdgeXY = null;
  }

  function updateZoomLabel() {
    var v = $('#zoomVal');
    if (v) v.textContent = Math.round((S.gzoom || 1) * 100) + '%';
  }
  function setGraphZoom(z) {
    S.gzoom = Math.max(0.3, Math.min(1.6, z));
    renderGraph();
  }

  function makeDraggable(el, obj) {
    el.addEventListener('mousedown', function (ev) {
      if (ev.target.classList.contains('port') || ev.button !== 0) return;
      ev.preventDefault();
      var sx = ev.clientX, sy = ev.clientY, moved = false;
      var o = S._gOff || 0;              // 目前的左邊留白（未加留白才是 node.gx 的座標系）
      var ox = (parseFloat(el.style.left) || 0) - o, oy = parseFloat(el.style.top) || 0;
      var z = S.gzoom || 1;               // 縮放後，滑鼠位移要換回畫布座標
      function mv(e2) {
        if (!moved && (Math.abs(e2.clientX - sx) > 3 || Math.abs(e2.clientY - sy) > 3)) moved = true;
        if (!moved) return;
        var nx = ox + (e2.clientX - sx) / z, ny = oy + (e2.clientY - sy) / z;
        el.style.left = (nx + o) + 'px'; el.style.top = ny + 'px';
        obj.gx = nx; obj.gy = ny + (parseFloat(el.style.height) || el.offsetHeight) / 2;
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (moved) { touch(); renderGraph(); }
        else { selectGraph({ t: 'n', id: obj.id }); }   // 只是點一下 → 選取（按 Delete 可刪）
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    // 滑到方塊上：右側和合本對應那一句也亮起來
    el.addEventListener('mouseenter', function () {
      if (S.gEdge) return;
      el.classList.add('hot'); syncCuvHot(obj.id, true);
    });
    el.addEventListener('mouseleave', function () {
      el.classList.remove('hot'); syncCuvHot(obj.id, false);
    });
  }

  (function () {
    var gbox = $('#graph');
    if (!gbox) return;
    gbox.addEventListener('click', function (ev) {
      if (ev.target === gbox || ev.target.classList.contains('graph-inner') || ev.target.id === 'gsvg') selectGraph(null);
    });
    // 追蹤「左鍵是否按住」：按住期間拖到畫布外也不中斷預覽線
    document.addEventListener('mousedown', function () { if (S.gEdge) S._gPressing = true; });
    document.addEventListener('mouseup', function () { S._gPressing = false; });
  })();


  $('#btnGraphReset').addEventListener('click', function () {
    S.project.nodes.forEach(function (n) { delete n.gx; delete n.gy; });
    S.project.rels.forEach(function (r) { delete r.gx; delete r.gy; });
    touch(); renderGraph();
    toast('已重新排版');
  });
  $('#zoomIn').addEventListener('click', function () { setGraphZoom((S.gzoom || 1) + 0.1); });
  $('#zoomOut').addEventListener('click', function () { setGraphZoom((S.gzoom || 1) - 0.1); });

  /* ---------------- 標題／來源 ---------------- */
  ['#mBook', '#mFrom', '#mTo', '#mVer', '#mSub'].forEach(function (s) {
    $(s).addEventListener('input', function () { syncMeta(); touch(); });
  });

  /* ---------------- 連接詞提前 ---------------- */
  $('#rFront').addEventListener('click', function () {
    S.front = !S.front;
    syncRail();
    renderOutlineView();
    toast(S.front ? '已把 γάρ / δέ / οὖν 這類連接詞提到句首（紅色標出）。' : '還原原文語序。');
  });

  /* ---------------- 專名下劃線（人名／地名／國族） ---------------- */
  $('#rProper').addEventListener('click', function () {
    var on = !S.properOn;
    setProper(on);
    loadProper(function () { renderOutlineView(); });
    toast(on ? '已用下劃線標出人名（紫）、地名（綠）、國族／國家（橙）。'
             : '已取消專名下劃線。');
  });

  /* ---------------- 和合本對照欄 ---------------- */
  function fetchCuvForProject() {
    var m = S.project.meta || {};
    var code = m.code || ($('#pBook') ? $('#pBook').value : '');
    var ch = m.ch || ($('#pCh') ? $('#pCh').value : '');
    if (!code || !ch) return false;
    var a = parseInt(m.from || ($('#pV1') ? $('#pV1').value : '1'), 10) || 1;
    var b = parseInt(m.to || ($('#pV2') ? $('#pV2').value : String(a)), 10) || a;
    api('/api/cuv?book=' + encodeURIComponent(code) + '&ch=' + encodeURIComponent(ch) +
        '&v1=' + a + '&v2=' + b).then(function (r) {
      if (!r || !r.ok || !r.verses) { setCuv(false); toast('這個範圍沒有和合本資料。'); return; }
      applyCuvOrdered(function (ok, res) {
        if (!ok) { setCuv(false); toast('這個範圍排不出和合本對照。'); return; }
        toast('和合本已按原文語序排好' +
              (res && res.total ? '（對上 ' + res.matched + '/' + res.total + ' 個詞）' : '') + '。');
      });
    });
    return true;
  }
  $('#rCuv').addEventListener('click', function () {
    var on = !cuvOn();
    if (on && !cuvMap().length) {
      if (fetchCuvForProject()) { toast('讀取和合本…'); return; }
      setCuv(false);
      toast('這份分析沒有節號可對照；請先用「① 直接選經文」取文。');
      return;
    }
    setCuv(on);
    renderOutlineView();
    toast(on ? '已打開和合本對照欄。' : '已收起和合本對照欄。');
  });
  $('#btnCuvOff').addEventListener('click', function () {
    setCuv(false); renderOutlineView(); toast('已收起和合本對照欄。');
  });
  $('#btnCuvRedo').addEventListener('click', function () {
    if (!fetchCuvForProject()) toast('讀不到和合本（要先用「① 直接選經文」指定書卷章節）。');
  });

  /* ---------------- 直接取經文 ---------------- */
  function fillSelect(sel, items, val) {
    sel.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.v; o.textContent = it.t;
      sel.appendChild(o);
    });
    if (val != null) sel.value = String(val);
  }
  function syncVerseRange(keepEnd) {
    var b = S.books.filter(function (x) { return x.code === $('#pBook').value; })[0];
    if (!b) return;
    var chObj = b.chapters.filter(function (c) { return String(c.ch) === $('#pCh').value; })[0];
    var maxv = chObj ? chObj.max : 1;
    var v1 = Math.min(parseInt($('#pV1').value || '1', 10) || 1, maxv);
    var v2 = Math.min(parseInt($('#pV2').value || String(maxv), 10) || maxv, maxv);
    var opts = [];
    for (var i = 1; i <= maxv; i++) opts.push({ v: i, t: String(i) });
    fillSelect($('#pV1'), opts, v1);
    fillSelect($('#pV2'), opts, keepEnd ? v2 : maxv);
  }
  function loadBooks() {
    return api('/api/books').then(function (r) {
      S.books = (r && r.books) || [];
      S.connectives = (r && r.connectives) || {};
      fillSelect($('#pBook'), S.books.map(function (b) { return { v: b.code, t: b.name + '（' + b.short + '）' }; }), 'Jn');
      var b = S.books.filter(function (x) { return x.code === 'Jn'; })[0] || S.books[0];
      if (b) fillSelect($('#pCh'), b.chapters.map(function (c) { return { v: c.ch, t: '第 ' + c.ch + ' 章' }; }), 3);
      syncVerseRange(false);
    });
  }
  ['#pBook', '#pCh'].forEach(function (s) {
    $(s).addEventListener('change', function () { syncVerseRange(false); });
  });
  $('#pV1').addEventListener('change', function () {
    if (parseInt($('#pV2').value, 10) < parseInt($('#pV1').value, 10)) $('#pV2').value = $('#pV1').value;
  });

  function applyClauses(clauses) {
    S.project.nodes = clauses.map(function (c) {
      return { id: GK.newId(), text: c.text, verse: c.verse || null, ind: 0 };
    });
    S.project.rels = [];
    S.project.notes = [];         // 換一段經文 → 舊註記不留在畫面上
    S.marks = {}; S.prepOf = {};
    if (S.project.meta.cuv) S.project.meta.cuv.map = [];
  }

  $('#btnLoad').addEventListener('click', function () {
    var q = '?book=' + encodeURIComponent($('#pBook').value) + '&ch=' + encodeURIComponent($('#pCh').value) +
      '&v1=' + encodeURIComponent($('#pV1').value) + '&v2=' + encodeURIComponent($('#pV2').value);
    api('/api/passage' + q).then(function (r) {
      if (!r.ok) { toast('取文失敗：' + (r.error || ''), 5000); return; }
      $('#passagePrev').textContent = r.full;
      $('#mBook').value = r.title; $('#mFrom').value = r.v1; $('#mTo').value = r.v2;
      $('#mVer').value = 'SBLGNT';
      var doFront = $('#optFrontOn').checked;
      api('/api/split', {
        body: { text: r.full, comma: $('#optComma').checked, prep: $('#optPrep').checked, verse: true, lead: true, front: doFront }
      }).then(function (sp) {
        if (!sp.clauses || !sp.clauses.length) { toast('這一段切不出子句'); return; }
        if (S.project.nodes.length && !confirm('這會取代目前的分析內容，繼續嗎？')) return;
        applyClauses(sp.clauses);
        S.project.meta.code = $('#pBook').value;
        S.project.meta.ch = $('#pCh').value;
        setFront(doFront);
        var withCuv = $('#optCuvOn').checked;
        if (withCuv && r.cuv && r.cuv.length) { applyCuvOrdered(); }
        else { setCuv(false); }
        touch(); renderOutlineView(); renderGraph();
        refreshTrans();
        toast('已載入 ' + r.title + ' ' + r.v1 + '-' + r.v2 + '，共 ' + sp.clauses.length + ' 句。' +
              (withCuv && r.cuv && r.cuv.length ? '（已帶入和合本對照）' : ''));
      });
    });
  });

  $('#btnSplit').addEventListener('click', function () {
    var text = $('#paste').value.trim();
    if (!text) { toast('請先貼上希臘文'); return; }
    api('/api/split', {
      body: { text: text, comma: $('#optComma').checked, prep: $('#optPrep').checked, verse: $('#optVerse').checked, front: $('#optFrontOn').checked, lead: true }
    }).then(function (r) {
      if (!r.clauses || !r.clauses.length) { toast('切不出子句，換個方式或手動新增'); return; }
      if (S.project.nodes.length && !confirm('這會取代目前的分析內容，繼續嗎？')) return;
      applyClauses(r.clauses);
      setFront(!!$('#optFrontOn').checked);
      touch(); renderOutlineView(); renderGraph();
      toast('切出 ' + r.clauses.length + ' 句。把 ⛓ 把手拖到另一行即可建立關係。');
    });
  });

  function setFront(on) {
    S.front = !!on;
    syncRail();
  }

  /* ---------------- 分頁 ---------------- */
  function switchTab(name) {
    if (name !== 'outline' && S.outline && S.outline.hidePal) S.outline.hidePal();
    S.tab = name;
    $$('.tab').forEach(function (x) { x.classList.toggle('on', x.dataset.tab === name); });
    $('#viewOutline').style.display = name === 'outline' ? '' : 'none';
    $('#viewGraph').style.display = name === 'graph' ? '' : 'none';
    $('#viewTable').style.display = name === 'table' ? '' : 'none';
    var rt = { outline: '#rTabOutline', graph: '#rTabGraph', table: '#rTabTable' }[name];
    $$('#rail .rbtn').forEach(function (b) { if (b.id.indexOf('rTab') === 0) b.classList.toggle('on', '#' + b.id === rt); });
    if (name === 'outline') renderOutlineView();
    else if (name === 'graph') renderGraph();
    else renderTable();
  }
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
  });

  /* ---------------- 左側整頁工具列 ---------------- */
  function railWire(id, fn) {
    var b = $(id);
    if (b) b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
  }
  railWire('#rTake', function () { $('#cardPassage').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('#pBook').focus(); });
  railWire('#rPaste', function () { $('#cardPaste').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('#paste').focus(); });
  railWire('#rMeta', function () { $('#mBook').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#mBook').focus(); });
  railWire('#rTabOutline', function () { switchTab('outline'); });
  railWire('#rTabGraph', function () { switchTab('graph'); });
  railWire('#rTabTable', function () { switchTab('table'); });
  railWire('#rAdd', function () { switchTab('outline'); addClause(); });
  railWire('#rRedraw', function () { switchTab('outline'); clearAllRels(); });
  railWire('#rSave', function () { $('#btnSave').click(); });
  railWire('#rOpen', function () { $('#btnOpen').click(); });
  railWire('#rExport', function () { $('#btnExport').click(); });
  railWire('#rNew', function () { $('#btnNew').click(); });
  railWire('#rHelp', function () { $('#btnHelp').click(); });
  railWire('#rRowUp', function () { rowTool('up'); });
  railWire('#rRowDown', function () { rowTool('down'); });
  railWire('#rRowAdd', function () { rowTool('add'); });
  railWire('#rRowScissor', function () { setRowTool('scissor'); });
  railWire('#rRowWord', function () { setRowTool('word'); });
  railWire('#rRowMerge', function () { rowTool('merge'); });
  railWire('#rRowLink', function () { rowTool('link'); });
  railWire('#rRowUnprep', function () { rowTool('unprep'); });
  railWire('#rRowDel', function () { rowTool('del'); });

  /* 讓左側工具列的開關狀態與上方工具列同步 */
  function syncRail() {
    var f = $('#rFront'); if (f) f.classList.toggle('on', !!S.front);
    var c = $('#rCuv'); if (c) c.classList.toggle('on', cuvOn());
    var v = $('#rVerbs'); if (v) v.classList.toggle('on', !!S.marksKinds.verb);
    var n = $('#rNouns'); if (n) n.classList.toggle('on', !!S.marksKinds.noun);
    var j = $('#rAdjs'); if (j) j.classList.toggle('on', !!S.marksKinds.adj);
    var pp = $('#rProper'); if (pp) pp.classList.toggle('on', !!S.properOn);
    var rsc = $('#rRowScissor'); if (rsc) rsc.classList.toggle('on', !!S.scissor);
    var rwd = $('#rRowWord'); if (rwd) rwd.classList.toggle('on', !!S.wordMode);
  }

  /* ---------------- 詞形查詢 ---------------- */
  function lookup(word, el) {
    if (S.wordEl) S.wordEl.classList.remove('sel');
    if (el) { el.classList.add('sel'); S.wordEl = el; }
    // 1.6.1：點選希臘文詞 → 和合本對應的中文詞用同樣的顏色高亮（一一對應）
    try {
      var host = el && el.closest ? el.closest('.ol-text, .ol-cuv') : null;
      var nodeId = host ? host.dataset.id : null;
      var wi = el ? parseInt(el.dataset.w, 10) : NaN;
      var kind = el && el.dataset ? (el.dataset.k || el.dataset.pr || '') : '';
      if (nodeId && !isNaN(wi)) selCuvWord(nodeId, wi, kind);
    } catch (e) {}
    $('#wordPanel').innerHTML = '<div class="empty">查詢中…</div>';
    api('/api/morph?w=' + encodeURIComponent(word)).then(function (r) {
      var h = [];
      h.push('<div class="word-hd"><span class="gw">' + esc(r.query) + '</span>');
      if (r.lex && r.lex.t) h.push('<span class="tr">' + esc(r.lex.t) + '</span>');
      if (r.zh && r.zh.s) h.push('<span class="sn">' + esc(r.zh.s) + '</span>');
      h.push('</div>');
      // 中文釋義（來源：OpenGNT 的和合本逐詞對齊）
      if (r.zh && r.zh.z) {
        h.push('<div class="zh-lex"><span class="zl">中文</span><b>' + esc(r.zh.z) + '</b>' +
               (r.zh.n ? '<span class="zn">（新約 ' + r.zh.n + ' 次）</span>' : '') + '</div>');
      } else {
        h.push('<div class="zh-lex none"><span class="zl">中文</span>' +
               '<span class="zn">這個詞形沒有對應的中文（可能只出現於少數讀文）。</span></div>');
      }
      if (r.lex) {
        h.push('<div class="lex">');
        if (r.lex.g) h.push('<span class="en-lbl">英文</span><b>' + esc(r.lex.g) + '</b><br>');
        if (r.lex.d) h.push('<span class="en-d">' + esc(r.lex.d) + '</span>');
        h.push('</div>');
      }
      if (!r.found || !r.parses.length) {
        h.push('<div class="empty">離線詞形庫的範圍是新約（SBLGNT）。這可能是舊約、七十士譯本或教父文獻的詞形，因此查不到。</div>');
        $('#wordPanel').innerHTML = h.join('');
        return;
      }
      var seen = {}, uniq = [];
      r.parses.forEach(function (p) {
        var k = p.p + '|' + p.d.join('|') + '|' + p.l;
        if (seen[k]) { seen[k].n += (p.n || 1); return; }
        seen[k] = p; p.n = p.n || 1; uniq.push(p);
      });
      var byPos = {};
      uniq.forEach(function (p) { (byPos[p.p] = byPos[p.p] || []).push(p); });
      h.push('<div class="parse-list">');
      Object.keys(byPos).forEach(function (pos) {
        byPos[pos].forEach(function (p) {
          var chips = p.d.map(function (d) {
            var cls = '';
            if (/主動|中間|被動/.test(d)) cls = ' voice';
            else if (/現在|未完成|未來|不定過去|完成|過去完成/.test(d)) cls = ' tense';
            else if (/主格|屬格|與格|受格|呼格/.test(d)) cls = ' case';
            return '<span class="chip' + cls + '">' + esc(d) + '</span>';
          }).join('');
          h.push('<div class="parse"><span class="pos">' + esc(p.p) + '</span>' +
            '<span class="cnt">出現 ' + p.n + ' 次</span>' +
            '<div class="bits">' + chips + '</div>' +
            '<div class="lem">原形：<b style="font-family:var(--greek)">' + esc(p.l) + '</b></div></div>');
        });
      });
      h.push('</div>');
      $('#wordPanel').innerHTML = h.join('');
    });
  }

  /* ---------------- 專案 ---------------- */
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function summarize(p) {
    p = p || S.project;
    var m = p.meta || {};
    var loc = [m.book, m.from ? m.from + (m.to ? '-' + m.to : '') : ''].filter(Boolean).join(' ');
    return { loc: loc || '（未指定經文範圍）',
             nodes: (p.nodes || []).length, rels: (p.rels || []).length,
             has: !!((p.nodes || []).length) };
  }
  function openMask(id) { var m = $(id); if (m) { if (S.outline && S.outline.hidePal) S.outline.hidePal(); m.classList.add('on'); } }
  function closeMask(id) { var m = $(id); if (m) m.classList.remove('on'); }
  function maskWire(id) {
    var m = $(id);
    if (!m) return;
    m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('on'); });
  }
  function revealPath(path) { api('/api/reveal', { body: { path: path } }).catch(function () {}); }

  /* 新分析 */
  $('#btnNew').addEventListener('click', function () {
    var s = summarize();
    $('#newInfo').innerHTML = s.has
      ? '目前：<b>' + esc(s.loc) + '</b>（' + s.nodes + ' 句、' + s.rels + ' 條關係）<br>清空前會自動留一份備份（<code>autosave.prev.json</code>），不用擔心遗失。'
      : '目前還沒有內容，可以直接開始新分析。';
    openMask('#newMask');
  });
  $('#newCancel').addEventListener('click', function () { closeMask('#newMask'); });
  $('#newOk').addEventListener('click', function () {
    S.project = blankProject();
    $('#mBook').value = ''; $('#mFrom').value = ''; $('#mTo').value = '';
    $('#mVer').value = 'SBLGNT'; $('#mSub').value = ''; $('#paste').value = '';
    renderOutlineView(); renderTable(); renderGraph();
    histFlush();
    closeMask('#newMask');
    toast('已開始新的分析。');
  });
  maskWire('#newMask');

  /* 儲存專案 */
  $('#btnSave').addEventListener('click', function () {
    var s = summarize();
    var name = projName();
    $('#saveName').value = name;
    $('#saveInfo').innerHTML = '<b>' + esc(s.loc) + '</b>｜' + s.nodes + ' 句、' + s.rels + ' 條關係' +
      '<br>存到：「文件 → Greeky → 專案」';
    $('#saveName').dataset.existing = '';
    api('/api/projects').then(function (r) {
      var names = (r.items || []).map(function (x) { return x.name; });
      $('#saveName').dataset.existing = names.join('\n');
      saveWarn();
    }).catch(function () {});
    openMask('#saveMask');
    setTimeout(function () { $('#saveName').focus(); $('#saveName').select(); }, 60);
  });
  function saveWarn() {
    var nm = $('#saveName').value.trim();
    var ex = ($('#saveName').dataset.existing || '').split('\n');
    var dup = nm && ex.indexOf(nm) >= 0;
    var s = summarize();
    $('#saveInfo').innerHTML =
      '<b>' + esc(s.loc) + '</b>｜' + s.nodes + ' 句、' + s.rels + ' 條關係' +
      '<br>存到：「文件 → Greeky → 專案」' +
      (dup ? '<br><span class="warn">⚠ 已有同名專案，儲存會覆蓋它。</span>' : '');
  }
  $('#saveName').addEventListener('input', saveWarn);
  $('#saveCancel').addEventListener('click', function () { closeMask('#saveMask'); });
  $('#saveOk').addEventListener('click', function () {
    var name = $('#saveName').value.trim();
    if (!name) { toast('請先輸入專案名稱'); $('#saveName').focus(); return; }
    syncMeta();
    api('/api/save', { body: { name: name, project: S.project } }).then(function (r) {
      closeMask('#saveMask');
      toast(r.ok ? '已儲存：' + r.name : '儲存失敗');
    }).catch(function (e) { toast('儲存失敗：' + e); });
  });
  maskWire('#saveMask');

  /* 開啟專案 */
  function loadProject(r) {
    S.project = normalize(r.project);
    var m = S.project.meta || {};
    $('#mBook').value = m.book || ''; $('#mFrom').value = m.from || '';
    $('#mTo').value = m.to || ''; $('#mVer').value = m.version || '';
    $('#mSub').value = m.sub || '';
    if (m.code) { $('#pBook').value = m.code; $('#pCh').value = m.ch || '1'; syncVerseRange(true); }
    setFront(m.front);
    setMarks(!!(m.marks && m.marks.on));
    setProper(m.properOn !== false);      // 舊專案沒有這個鍵 → 預設開
    if (S.project.meta.cuv) setCuv(!!S.project.meta.cuv.on);
    syncCuvWords();
    renderOutlineView(); renderTable(); renderGraph();
    if (cuvOn()) ensureCuvWords();
    histFlush();
  }
  function renderProjList(r) {
    var box = $('#projList');
    box.innerHTML = '';
    var items = r.items || [];
    if (!items.length) { box.innerHTML = '<div class="empty">還沒有任何專案。先按「儲存」把目前的內容存下來吧。</div>'; return; }
    items.forEach(function (it) {
      var card = document.createElement('div');
      card.className = 'proj-card';
      var loc = [it.book, it.from ? it.from + (it.to ? '-' + it.to : '') : ''].filter(Boolean).join(' ');
      card.innerHTML =
        '<button class="pc-x" title="刪除這個專案">✕</button>' +
        '<div class="pc-t">' + esc(it.name) + '</div>' +
        '<div class="pc-m">' +
          (loc ? '<span class="tag">' + esc(loc) + '</span>' : '') +
          '<span class="tag">' + (it.nodes || 0) + ' 句</span>' +
          '<span class="tag">' + (it.rels || 0) + ' 條關係</span>' +
        '</div>' +
        '<div class="pc-d">' + (it.mtime ? fmtDate(it.mtime) : '') + '</div>';
      card.addEventListener('click', function () {
        api('/api/project?name=' + encodeURIComponent(it.name)).then(function (x) {
          if (!x.ok) { toast('開啟失敗'); return; }
          loadProject(x);
          closeMask('#openMask');
          toast('已開啟：' + it.name);
        });
      });
      card.querySelector('.pc-x').addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!confirm('刪除專案「' + it.name + '」？此動作無法復原。')) return;
        api('/api/delete', { body: { name: it.name } }).then(function () {
          card.remove();
          toast('已刪除：' + it.name);
        });
      });
      box.appendChild(card);
    });
  }
  $('#btnOpen').addEventListener('click', function () {
    api('/api/projects').then(function (r) {
      S.projFolder = r.folder || S.projFolder;
      renderProjList(r);
      openMask('#openMask');
    }).catch(function () { toast('讀不到專案清單'); });
  });
  $('#openFolder').addEventListener('click', function () {
    var p = S.projFolder;
    if (p) revealPath(p); else toast('資料夾位置未知');
  });
  $('#openCancel').addEventListener('click', function () { closeMask('#openMask'); });
  maskWire('#openMask');

  /* ---------------- 匯出 ---------------- */
  $('#btnExport').addEventListener('click', function () {
    if (!S.project.nodes.length) { toast('還沒有內容可以匯出'); return; }
    var s = summarize();
    $('#exportName').value = projName();
    $('#exportInfo').innerHTML = '<b>' + esc(s.loc) + '</b>｜' + s.nodes + ' 句、' + s.rels + ' 條關係<br>' +
      'A4 直式，版面與畫面相同；存到：「文件 → Greeky → 匯出」';
    openMask('#exportMask');
    setTimeout(function () { $('#exportName').focus(); $('#exportName').select(); }, 60);
  });
  $('#exportCancel').addEventListener('click', function () { closeMask('#exportMask'); });
  $('#exportFolder').addEventListener('click', function () {
    if (S.expFolder) revealPath(S.expFolder); else toast('資料夾位置未知');
  });
  maskWire('#exportMask');
  $('#exportOk').addEventListener('click', function () {
    syncMeta();
    S.project.meta.front = !!S.front;
    S.project.meta.marks = { on: !!S.marksKinds.verb, verb: !!S.marksKinds.verb,
                             noun: !!S.marksKinds.noun, adj: !!S.marksKinds.adj };
    var name = $('#exportName').value.trim() || projName();
    var btn = $('#exportOk');
    btn.disabled = true; btn.textContent = '匯出中…';
    api('/api/export', { body: { project: S.project, name: name } }).then(function (r) {
      btn.disabled = false; btn.textContent = '開始匯出';
      if (!r.ok) { toast('匯出失敗：' + (r.error || '未知錯誤'), 6000); return; }
      closeMask('#exportMask');
      toast('已匯出：' + r.path, 5000);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '開始匯出';
      toast('匯出失敗：' + e);
    });
  });
  api('/api/projects').then(function (r) { S.expFolder = r.exports || ''; }).catch(function () {});

  /* ---------------- 關閉／說明 ---------------- */
  $('#btnQuit').addEventListener('click', function () {
    if (!confirm('關閉 Greeky？\n（已儲存的專案不會遺失）')) return;
    api('/api/shutdown', { body: {} });
    setTimeout(function () {
      document.body.innerHTML = '<div style="font-family:var(--cjk);padding:70px;text-align:center;color:#5c574e">'
        + '<h2 style="color:#7a5c2e">程式已關閉</h2>'
        + '<p>下次要分析，再雙擊「Greeky」即可。</p></div>';
    }, 400);
  });
  $('#btnHelp').addEventListener('click', function () { $('#helpMask').classList.add('on'); });
  $('#helpClose').addEventListener('click', function () { $('#helpMask').classList.remove('on'); });
  $('#helpMask').addEventListener('click', function (e) { if (e.target === $('#helpMask')) $('#helpMask').classList.remove('on'); });

  function renderLegend() {
    var h = ['<div style="line-height:1.9">'];
    S.relations.forEach(function (r) {
      h.push('<div><b>' + esc(r.short) + '</b> — ' + esc(r.name) +
        ' <span style="color:#a9a294">' + esc(r.en) + '</span><br><span style="color:#8b8578;font-size:11.5px">' + esc(r.desc) + '</span></div>');
    });
    h.push('</div>');
    $('#legend').innerHTML = h.join('');
  }

  /* ---------------- 右側「譯本」卡片 ----------------
     並列閱讀整段經文（和合本／當代譯本／ASV）。
     刻意**不跟縮排分析聯動**：只用專案記錄的書卷章節範圍去拉對應的譯本內容。 */
  function transMeta() {
    var m = S.project.meta || {};
    var code = m.code || ($('#pBook') ? $('#pBook').value : '');
    var ch = m.ch || ($('#pCh') ? $('#pCh').value : '');
    var a = parseInt(m.from || ($('#pV1') ? $('#pV1').value : '1'), 10) || 1;
    var b = parseInt(m.to || ($('#pV2') ? $('#pV2').value : String(a)), 10) || a;
    return { code: code, ch: ch, v1: Math.min(a, b), v2: Math.max(a, b) };
  }
  function loadTransList() {
    var sel = $('#transSel');
    if (!sel) return Promise.resolve();
    return api('/api/translations').then(function (r) {
      S.transItems = (r && r.items) || [];
      sel.innerHTML = '';
      S.transItems.forEach(function (t) {
        if (!t.available) return;
        var o = document.createElement('option');
        o.value = t.key;
        o.textContent = t.name + (t.lang === 'en' ? '（英文）' : '');
        sel.appendChild(o);
      });
      var want = S.project.meta.transKey;
      if (want && S.transItems.some(function (t) { return t.key === want && t.available; })) {
        S.transKey = want;
      }
      sel.value = S.transKey;
      refreshTrans();
    }).catch(function () {});
  }
  function refreshTrans() {
    var body = $('#transBody'), ref = $('#transRef'), note = $('#transNote');
    if (!body) return;
    var meta = transMeta();
    var t = (S.transItems || []).filter(function (x) { return x.key === S.transKey; })[0];
    if (ref) ref.textContent = '';
    if (note) note.textContent = t ? t.note : '';
    if (!meta.code || !meta.ch) {
      body.innerHTML = '<div class="empty">先在上面「① 直接選經文」取一段經文，這裡就會列出所選譯本的整段譯文。</div>';
      return;
    }
    body.innerHTML = '<div class="empty">讀取中…</div>';
    api('/api/translation?key=' + encodeURIComponent(S.transKey) +
        '&book=' + encodeURIComponent(meta.code) + '&ch=' + encodeURIComponent(meta.ch) +
        '&v1=' + meta.v1 + '&v2=' + meta.v2).then(function (r) {
      if (!r || !r.ok || !r.verses || !r.verses.length) {
        body.innerHTML = '<div class="empty">這個譯本在這個範圍沒有資料。</div>';
        return;
      }
      var bk = (S.books || []).filter(function (x) { return x.code === meta.code; })[0];
      var bkName = bk ? bk.name : meta.code;
      if (ref) ref.textContent = bkName + ' ' + meta.ch + ':' + meta.v1 + (meta.v2 > meta.v1 ? '-' + meta.v2 : '');
      var en = r.verses.length && /^[\x00-\x7F\s\d\.,;:!?'"()\[\]\-—–]+$/.test(r.verses[0].text || '');
      body.innerHTML = '';
      r.verses.forEach(function (v) {
        var d = document.createElement('div');
        d.className = 'trans-v';
        var z = document.createElement('span');
        z.className = 'tv'; z.textContent = v.v;
        var x = document.createElement('span');
        x.className = 'tt' + (en ? ' en' : '');
        x.textContent = v.text;
        d.appendChild(z); d.appendChild(x);
        body.appendChild(d);
      });
    }).catch(function () {
      body.innerHTML = '<div class="empty">讀取譯本時發生錯誤。</div>';
    });
  }
  var _transSelWired = false;
  function wireTransCard() {
    if (_transSelWired) return;
    _transSelWired = true;
    var sel = $('#transSel');
    if (sel) sel.addEventListener('change', function () {
      S.transKey = sel.value;
      if (!S.project.meta) S.project.meta = {};
      S.project.meta.transKey = S.transKey;
      touch();
      refreshTrans();
    });
    var rf = $('#transRefresh');
    if (rf) rf.addEventListener('click', function () { refreshTrans(); });
  }

  /* ---------------- 舊資料轉換 ---------------- */
  function normalize(p) {
    if (!p) return blankProject();
    if (!p.nodes) p.nodes = [];
    if (!p.rels) p.rels = [];
    if (!p.notes) p.notes = [];
    if (!p.meta) p.meta = {};
    // 關係圖改了排版（改成由左往右的邏輯樹，欄寬 150→250px）。
    // 舊的手動座標是舊版面存的，套到新格線會卡在一起 → 一次性清掉，之後自動排版。
    if (p.meta.graphV !== 2) {
      p.nodes.forEach(function (n) { delete n.gx; delete n.gy; });
      p.rels.forEach(function (r) { delete r.gx; delete r.gy; });
      p.meta.graphV = 2;
    }
    // 舊版 boxes → rels（層級改由 span 自動決定）
    if (p.boxes && p.boxes.length && !p.rels.length) {
      p.rels = p.boxes.map(function (o) {
        return { id: o.id || GK.newId(), a: o.a, b: o.b,
                 label: o.label || '', star: !!o.star, starAt: o.starAt || '', type: o.type || '' };
      });
    }
    delete p.boxes;
    // 更舊的 edges → rels
    if (p.edges && p.edges.length) {
      var idx = {};
      p.nodes.forEach(function (n, i) { idx[n.id] = i; });
      var byChild = {}, kids = {};
      p.edges.forEach(function (e) {
        if (idx[e.from] == null || idx[e.to] == null) return;
        byChild[e.from] = e; (kids[e.to] = kids[e.to] || []).push(e.from);
      });
      Object.keys(byChild).forEach(function (cid) {
        var e = byChild[cid];
        var lo = idx[cid], hi = idx[cid];
        (function walk(id) {
          (kids[id] || []).forEach(function (k) {
            lo = Math.min(lo, idx[k]); hi = Math.max(hi, idx[k]); walk(k);
          });
        })(cid);
        var ai = Math.min(idx[e.to], lo), bi = Math.max(idx[e.to], hi);
        p.rels.push({ id: e.id || GK.newId(), a: p.nodes[ai].id, b: p.nodes[bi].id,
                      type: e.type || 'factinterp', label: e.label || '', star: e.main === 'child', starAt: e.main === 'child' ? 'second' : '' });
      });
    }
    delete p.edges;
    p.nodes.forEach(function (n) { if (n.ind == null) n.ind = 0; });
    return p;
  }

  /* ---------------- 鍵盤：⌘Z 復原、⇧⌘Z 重做 ---------------- */
  document.addEventListener('keydown', function (ev) {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    var t = ev.target;
    // 正在編輯文字框 / 輸入框時，交給系統原生的復原（比較符合直覺）
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var k = String(ev.key || '').toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); redo(); }
    else if (k === 's') { ev.preventDefault(); $('#btnSave').click(); }          // ⌘S 儲存專案
    else if (k === 'n') { ev.preventDefault(); $('#btnNew').click(); }           // ⌘N 新專案
  });

  /* ---------------- 鍵盤：B／C／D 工具 + Esc 回一般 ----------------
     B＝剪句 C＝詞序調換 D＝併入上句；Esc＝回到一般狀態。
     編輯文字中、或對話框開著時不搶鍵。 */
  document.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.mask.on')) return;
    var k = String(ev.key || '');
    if (ev.key === 'Escape') { ev.preventDefault(); exitRowTools(); return; }
    if (S.tab !== 'outline') return;
    if (k === 'b' || k === 'B') { ev.preventDefault(); setRowTool('scissor'); }
    else if (k === 'c' || k === 'C') { ev.preventDefault(); setRowTool('word'); }
    else if (k === 'd' || k === 'D') { ev.preventDefault(); rowTool('merge'); }
  }, true);

  /* ---------------- 點縮排分析頁的空白處 → 取消選定的句子 ---------------- */
  document.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) return;
    if (S.tab !== 'outline') return;
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('.ol-row')) return;              // 點句子 → 由行自己的 handler 選取
    if (t.closest('.rail, .mask, .ol-pal, .topbar, select, input, textarea, button')) return;
    if (!t.closest('.ol-paper')) return;           // 只把縮排紙面內的空白算作「空白處」
    if (!S.rowSel) return;
    S.rowSel = null;
    applyRowSel();
    syncRail();
  }, true);

  /* ---------------- 鍵盤：Delete／Backspace 刪除關係圖上選取到的物件 ---------------- */
  document.addEventListener('keydown', function (ev) {
    if (S.tab !== 'graph') return;
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    // 在輸入框 / 可編輯處 / 對話框裡時不要搶
    var t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.mask.on')) return;
    if (!S.gSel) return;
    var sel = S.gSel;
    if (sel.t === 'r') {
      var rel = S.project.rels.filter(function (o) { return o.id === sel.id; })[0];
      if (rel) {
        ev.preventDefault();
        unlink(rel);
        toast('已刪除這條關係。');
      }
    } else {
      var i = nodeIdx(sel.id);
      if (i >= 0) {
        ev.preventDefault();
        if (delNode(sel.id)) toast('已刪除第 ' + (i + 1) + ' 句。');
      }
    }
    S.gSel = null;
  });

  /* ---------------- 啟動 ---------------- */
  function boot() {
    api('/api/relations').then(function (r) {
      S.relations = r || [];
      renderLegend();
      return loadBooks();
    }).then(function () { return api('/api/proper'); })
      .then(function (r) { S.proper = r || { forms: {}, capforms: {} }; return api('/api/autosave'); })
      .then(function (r) {
        if (r && r.ok && r.project && r.project.nodes && r.project.nodes.length) {
          S.project = normalize(r.project);
          var m = S.project.meta || {};
          $('#mBook').value = m.book || ''; $('#mFrom').value = m.from || '';
          $('#mTo').value = m.to || ''; $('#mVer').value = m.version || 'SBLGNT';
          $('#mSub').value = m.sub || '';
          if (m.code) { $('#pBook').value = m.code; $('#pCh').value = m.ch || '1'; syncVerseRange(true); }
          if (typeof m.front === 'boolean') setFront(m.front);
          setMarks(m.marks ? (m.marks.verb !== false) : !!(m.marks && m.marks.on));
          setNouns(!!(m.marks && m.marks.noun));
          setAdjs(!!(m.marks && m.marks.adj));
          setProper(m.properOn !== false);
          if (S.project.meta.cuv) setCuv(!!S.project.meta.cuv.on);
        } else {
          S.project = blankProject();
        }
        histReset();
        renderOutlineView(); renderTable();
        wireTransCard(); loadTransList();
        // 開著和合本對照欄時：**有存好的逐詞對應就直接沿用**，
        // 只有在沒有（舊專案）或句數不符時才向伺服器重算。
        if (cuvOn()) ensureCuvWords();
      }).catch(function () {
        S.project = blankProject(); histReset(); renderOutlineView(); renderTable();
        wireTransCard(); loadTransList();
        toast('無法連上本機服務');
      });
  }

  window.addEventListener('resize', function () {
    if (S.tab === 'outline') redraw();
    else if (S.tab === 'graph') renderGraph();
  });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();

})();
