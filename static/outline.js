/* 縮排分析版面的共用渲染引擎（編輯器與列印版共用）
 *
 * 資料模型（與《01_約翰福音03.14-21》範本一致）：
 *   project.nodes = [{id, text, verse, ind, att}]
 *       ind = 這一行文字的左縮排（pt，相對基準線）
 *       att = 這一行「連線接點」的左縮排（pt；有節號的行會比文字再左一點）
 *   project.rels  = [{id, a, b, label, star, type}]
 *       a, b = 節點 id，這條關係涵蓋第 a 行到第 b 行（含）
 *
 * 版面規則（逐條對齊範本 PDF 量到的座標）：
 *   1. 每一條關係是一條 C 形折線：左邊豎線(bar) + 上下兩段橫線(arm)
 *   2. 樹：一條關係的「子」＝ 它的範圍內【極大的子關係】＋【沒被蓋到的單行】，
 *      依先後交錯排好。所以一整群句子的關係，會從子關係的豎線中段分叉出去。
 *   3. 豎線 x（相對） = min(所有子的接點 x) - 14.2pt
 *        子的接點 x：單行＝該行接點；子關係＝子關係的豎線 x
 *   4. 橫線高度 = 子的接點 y：單行＝該行中心；子關係＝子關係豎線的垂直中點
 *   5. 標記貼在豎線右側 2.3pt、雙線**下側與下橫線的抝角**（1.3.1 改；原本在豎線中點）
 *      星號（*）獨立成一個元素：重點在首句 → 貼在豎線與上橫線的抝角；
 *      重點在次句 → 貼在標記正下方、下橫線上方。
 *   6. 最深的那條豎線離文字左緣 14.2pt；其餘每往上一層再多 14.2pt
 */
(function (global) {
  'use strict';

  var PT = 96 / 72;              // pt -> px
  var GAP_PT = 14.2;             // 每層往左 14.2pt（範本量測值）
  var GAP = GAP_PT * PT;         // px
  var LBLW = 10;                 // 標記欄寬 px
  var PAD = 3;                   // 標記與豎線間距 px
  var MARGIN = 12;               // 最左邊留白 px
  var LBLGAP = 2;                // 標記底端離「下橫臂」的間距 px（貼在抝角）
  var STARH = 11;                // 星號高度 px
  var STARGAP = 1;               // 星號與標記／橫線的間距 px

  /* 目前活著的懸浮工具列（同一時間只會有一個）。
     PAL_MEM：工具列開著時記住它是對著哪一行、在哪個座標開的；
     重畫畫面後可以照原位重新打開（連續點工具才不會一按就消失）。
     「點別處才收起」的外層監聽只註冊一次（見 wirePalOutside），
     否則每次重畫都往 document 上疊一份，越疊越多。 */
  var ACTIVE_PAL = null, ACTIVE_HIDE = null, PAL_MEM = null, palOutsideWired = false;

  function killPalettes() {
    ACTIVE_PAL = null; ACTIVE_HIDE = null;
    if (!global.document) return;
    var ps = global.document.querySelectorAll('.ol-pal');
    for (var i = 0; i < ps.length; i++) if (ps[i].parentNode) ps[i].parentNode.removeChild(ps[i]);
  }

  /* 全頁只註冊一次的「收起」監聽：
     只有當工具列開著時才作用，且點到工具列本身不算。
     · 左鍵按在別處（不在任何句子上）→ 收起
     · 在別處按右鍵（叫出別的選單）→ 收起
     · 左鍵點另一行 → 由該行的 contextmenu/mousedown 處理（不在此收起，免得誤關） */
  function wirePalOutside() {
    if (palOutsideWired || !global.document) return;
    palOutsideWired = true;
    var d = global.document;
    function open() { return !!(ACTIVE_PAL && ACTIVE_PAL.dataset.pinned === '1'); }
    function insidePal(t) { return !!(t && t.closest && t.closest('.ol-pal')); }
    function inRow(t) { return !!(t && t.closest && t.closest('.ol-row')); }
    d.addEventListener('mousedown', function (ev) {
      if (!open() || ev.button !== 0) return;
      if (insidePal(ev.target) || inRow(ev.target)) return;
      if (ACTIVE_HIDE) ACTIVE_HIDE();                  // 點到別處的空白 → 收起
    }, true);
    d.addEventListener('contextmenu', function (ev) {
      if (!open()) return;
      if (insidePal(ev.target)) return;
      if (ACTIVE_HIDE) ACTIVE_HIDE();                  // 在別處按右鍵 → 收起（若在另一行，隨後的 showPal 會再開）
    }, true);
  }

  function newId() {
    return 'n' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  }

  /* ---------------- 樹：由巢狀區間還原 ---------------- */
  function layout(project) {
    var nodes = (project && project.nodes) || [];
    var raw = (project && (project.rels || project.boxes)) || [];
    var idx = {};
    for (var i = 0; i < nodes.length; i++) idx[nodes[i].id] = i;

    var rels = [];
    for (i = 0; i < raw.length; i++) {
      var o = raw[i];
      if (!o) continue;
      var ai = idx[o.a], bi = idx[o.b];
      if (ai == null || bi == null) continue;
      if (ai > bi) { var t = ai; ai = bi; bi = t; }
      rels.push({ id: o.id, ai: ai, bi: bi, label: o.label || '',
                  star: !!o.star, starAt: o.starAt || '', type: o.type || '', raw: o, ord: i });
    }
    // 相同範圍時，先出現的視為「內層」
    function inside(j, i) {
      if (j === i) return false;
      var a = rels[i], b = rels[j];
      if (a.ai <= b.ai && b.bi <= a.bi) {
        if (a.ai === b.ai && a.bi === b.bi) return b.ord < a.ord;
        return true;
      }
      return false;
    }
    function childrenOf(i) {
      var pool = [], j;
      for (j = 0; j < rels.length; j++) if (inside(j, i)) pool.push(j);
      var maximal = pool.filter(function (j) {
        return !pool.some(function (k) { return k !== j && inside(j, k); });
      });
      maximal.sort(function (x, y) { return rels[x].ai - rels[y].ai; });
      var out = [], p = rels[i].ai;
      maximal.forEach(function (j) {
        var c = rels[j];
        if (c.ai < p) return;                       // 交叉，略過
        while (p < c.ai) { out.push({ t: 'n', i: p }); p++; }
        out.push({ t: 'r', i: j });
        p = c.bi + 1;
      });
      while (p <= rels[i].bi) { out.push({ t: 'n', i: p }); p++; }
      return out;
    }
    var roots = [];
    for (i = 0; i < rels.length; i++) {
      var hasP = false;
      for (var k = 0; k < rels.length; k++) if (inside(i, k)) { hasP = true; break; }
      if (!hasP) roots.push(i);
    }
    var depth = rels.map(function (r, j) {
      var d = 0;
      for (var k = 0; k < rels.length; k++) if (inside(j, k)) d++;
      return d;
    });
    return { nodes: nodes, rels: rels, idx: idx,
             childrenOf: childrenOf, roots: roots, depth: depth };
  }

  /* ---------------- 產生一行文字（可點選詞） ---------------- */
  var GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
  var WORD_RE = /([\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+)/g;

  /* ---------------- 逐字樣式（1.6.1）：node.rs = [{a,z,b,i,u,c}] ----------------
     rs 是 node.text 上「某一段字元」的樣式（粗體／斜體／底線／字色）。
     a/z 是字元位移（z 不含）。渲染時把每個字按樣式分組、包成 <span class="rsp …">。 */
  function sameRich(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (!!a.b === !!b.b) && (!!a.i === !!b.i) && (!!a.u === !!b.u) && ((a.c || '') === (b.c || ''));
  }
  function runsAt(runs, off) {
    if (!runs) return null;
    var hit = null;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (off >= r.a && off < r.z) hit = r;   // 重疊時後者為準
    }
    return hit;
  }
  // offAt(k)：把「這段文字」的第 k 個字對回 node.text 的位移。
  function buildRich(txt, offAt, runs) {
    var frag = document.createDocumentFragment(), any = false, i = 0;
    while (i < txt.length) {
      var st = runsAt(runs, offAt(i));
      var j = i + 1;
      while (j < txt.length && sameRich(runsAt(runs, offAt(j)), st)) j++;
      var seg = txt.slice(i, j);
      if (st) {
        any = true;
        var sp = document.createElement('span');
        sp.className = 'rsp' + (st.b ? ' rs-b' : '') + (st.i ? ' rs-i' : '') + (st.u ? ' rs-u' : '');
        if (st.c) sp.style.color = st.c;
        sp.textContent = seg;
        frag.appendChild(sp);
      } else {
        frag.appendChild(document.createTextNode(seg));
      }
      i = j;
    }
    return any ? frag : null;
  }

  // 把一個「詞」的逐字樣式摘要存進 dataset（給和合本 .czw 複製用）
  function markWordStyle(s, st) {
    if (!s || !st) return;
    if (st.b) s.dataset.rb = '1';
    if (st.i) s.dataset.ri = '1';
    if (st.u) s.dataset.ru = '1';
    if (st.c) s.dataset.rc = st.c;
  }

  /* 把「一段純文字＋逐字樣式」直接畫進 el（編輯中即時回饋用，不做詞／專名上色）。 */
  function fillRich(el, text, runs) {
    el.textContent = '';
    var frag = buildRich(String(text || ''), function (k) { return k; }, runs);
    if (frag) el.appendChild(frag); else el.textContent = String(text || '');
  }

  function fillWords(el, text, onWord, kindOf, wmap, properOf, rich) {
    el.textContent = '';
    var parts = String(text || '').split(WORD_RE);
    var wi = -1;                       // 畫面詞序（只有希臘文詞才遞增）
    var off = 0;                       // 目前文字在 text 中的位移（給逐字樣式對位）
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (GREEK.test(p)) {
        wi++;
        // wmap：把畫面詞序對回「原文詞序」。連接詞提前會改變詞的順序與位置，
        // 若不對回原文詞序，詞類標示（依原文詞序算）就會錯位。
        var oi = wmap ? wmap[wi] : wi;
        if (oi == null) oi = wi;
        var s = document.createElement('span');
        s.className = 'w';
        s.textContent = p;
        s.dataset.w = oi;
        // 詞類上色：V/T/N（動詞，紅色系）／c1..c5（名詞五格，橙色系）／j1..j5（形容詞五格，紫色系）
        // 顏色在 app.css 定義。
        if (kindOf) {
          var k = kindOf(p, oi);
          if (k) { s.classList.add('k-' + k.toLowerCase()); s.dataset.k = k; }
        }
        // 專有名詞（1.5.0）：人名／地名／國族 → 加下劃線，方便一眼掃出來
        if (properOf) {
          var pk = properOf(p);
          if (pk) { s.classList.add('pr', 'pr-' + pk); s.dataset.pr = pk; }
        }
        // 逐字樣式（1.6.1）：把詞裡的字按樣式切成數個 <span class="rsp …">。
        // 外層 .w 保留 data-w 與滑鼠事件，所以點詞／對應和合本都不受影響。
        if (rich) {
          var rf = buildRich(p, (function (b) { return function (k) { return rich.offAt(b + k); }; })(off), rich.runs);
          if (rf) { s.textContent = ''; s.appendChild(rf); }
          // 和合本對應用：把這個「詞」的逐字樣式摘要到 dataset，稍後複製到 .czw
          markWordStyle(s, runsAt(rich.runs, rich.offAt(off)));
        }
        // 注意：var 是函式作用域，若把 s 留在外面，所有 span 的 click 會共用
        // 同一個 s（最後一個），點了永遠highlight最後一個字。務必把該 span
        // 一起包進閉包（連同文字 t）。
        (function (t, sp) {
          sp.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (onWord) onWord(t, sp);
          });
        })(p, s);
        el.appendChild(s);
      } else {
        var rf2 = rich ? buildRich(p, (function (b) { return function (k) { return rich.offAt(b + k); }; })(off), rich.runs) : null;
        if (rf2) el.appendChild(rf2); else el.appendChild(document.createTextNode(p));
      }
      off += p.length;
    }
  }

  /* ---------------- 子句樣式（加粗／斜體／底線／字色） ----------------
     資料：node.style = {b:1,i:1,u:1,c:'#c0392b'}
     這是「整句」的樣式（希臘文與對應的和合本一起套），
     由編輯界面上方的懸浮工具列設定。 */
  function styleClasses(st) {
    if (!st) return '';
    var out = '';
    if (st.b) out += ' rs-b';
    if (st.i) out += ' rs-i';
    if (st.u) out += ' rs-u';
    return out;
  }
  function applyStyle(el, st) {
    if (!el || !st) return;
    if (st.b) el.classList.add('rs-b');
    if (st.i) el.classList.add('rs-i');
    if (st.u) el.classList.add('rs-u');
    if (st.c) el.style.color = st.c;
  }

  /* 連接詞提前時，顯示文字和 node.text 的順序不同；這個函式把「顯示位移」
     對回 node.text 的位移，逐字樣式在「連接詞提前」模式下才不會跑位。 */
  function makeFrontRich(T, ft, runs) {
    var c = T.indexOf(ft.conn);
    if (c < 0) return { runs: runs, offAt: function (d) { return d; }, connOff: 0 };
    var connLen = ft.conn.length;
    var pre = T.slice(0, c), tail = T.slice(c + connLen);
    var raw = pre + tail;
    var src = [], buf = '';
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (/\s/.test(ch)) {
        if (buf === '' || buf.charAt(buf.length - 1) === ' ') continue;  // 收掉連續空白／行首空白
        buf += ' ';
      } else {
        buf += ch;
      }
      src.push(i < pre.length ? i : i + connLen);   // 這個輸出字元在 T 中的位移
    }
    while (buf.charAt(buf.length - 1) === ' ') { buf = buf.slice(0, -1); src.pop(); }   // 尾端 trim
    while (buf && '[,;\u00b7]'.indexOf(buf.charAt(0)) >= 0) { buf = buf.slice(1); src.shift(); }  // 開頭標點
    // 顯示文字是 ' ' + ft.post：d=0 → 連接詞末端；d>=1 → src[d-1]
    return { runs: runs, connOff: c, offAt: function (d) {
      if (d <= 0) return c + connLen;
      var p = d - 1;
      if (p >= src.length) return T.length;
      return src[p];
    } };
  }

  /* ---------------- 關係連接詞：句首（或第二位） ---------------- */
  function findConnective(text, table) {
    if (!table) return null;
    var toks = String(text || '').match(/[\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+/g) || [];
    for (var i = 0; i < Math.min(2, toks.length); i++) {
      if (table[toks[i]]) return { i: i, word: toks[i], label: table[toks[i]] };
    }
    return null;
  }

  function frontText(text, table) {
    var s0 = String(text || '');
    var toks = s0.match(/[\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+/g) || [];
    var hit = findConnective(s0, table);
    if (!hit) return { conn: '', post: s0, connIdx: null, map: null };
    // 連接詞被移到最前面後，「畫面上其餘的詞」依序對應到這些原文詞序：
    var map = [];
    for (var k = 0; k < toks.length; k++) if (k !== hit.i) map.push(k);
    if (hit.i === 0) {
      // 連接詞本來就在句首：後面的詞就是原文第 1、2…個
      return { conn: hit.word, post: s0.slice(s0.indexOf(toks[0]) + toks[0].length),
               connIdx: 0, map: map };
    }
    var first = toks[0];
    var at = s0.indexOf(hit.word, s0.indexOf(first) + first.length);
    var rest = (s0.slice(0, at) + s0.slice(at + hit.word.length)).replace(/\s+/g, ' ').trim();
    rest = rest.replace(/^[,;·]\s*/, '').trim();
    return { conn: hit.word, post: rest, connIdx: hit.i, map: map };
  }

  /* ---------------- 渲染 ---------------- */
  function renderOutline(body, project, opts) {
    opts = opts || {};
    killPalettes();
    var L = layout(project);
    var nodes = L.nodes;
    var rels = L.rels;

    if (!nodes.length) {
      body.innerHTML = '<div class="ol-hint">還沒有內容。先在上面選經文，或按「＋ 新增子句」。</div>';
      return null;
    }

    function indPx(i) { var n = nodes[i]; return ((n && n.ind) || 0) * PT; }
    function attPx(i) { var n = nodes[i]; var v = (n && n.att != null) ? n.att : ((n && n.ind) || 0); return v * PT; }
    // 標記／星號的間距：螢幕與列印字級不同 → 用 labelScale 縮放（列印版傳入）
    var LK = (opts.labelScale != null ? opts.labelScale : 1);
    var lblGap = LBLGAP * LK, starH = STARH * LK, starGap = STARGAP * LK;

    // 相對豎線 x（不含左邊留白）：relX(子) - 14.2pt
    var relX = new Array(rels.length);
    function calcX(j) {
      if (relX[j] != null) return relX[j];
      var kids = L.childrenOf(j), m = Infinity;
      kids.forEach(function (k) {
        var x = (k.t === 'n') ? attPx(k.i) : calcX(k.i);
        if (x < m) m = x;
      });
      relX[j] = (m === Infinity ? 0 : m) - GAP;
      return relX[j];
    }
    L.roots.forEach(calcX);
    rels.forEach(function (r, j) { if (relX[j] == null) calcX(j); });

    var minRel = Math.min.apply(null, relX.concat([0]));
    var need = -minRel + LBLW + PAD + MARGIN;          // 不裁切所需的最小留白（px）
    // 範本把文字區塊擺在離左邊界 172.88pt 處（實測值）；列印時照做才會與範本重合
    var G = Math.max(need, (opts.textLeftPt != null ? opts.textLeftPt * PT : 0));

    body.textContent = '';
    if (opts.cuv) body.classList.add('has-cuv');
    else body.classList.remove('has-cuv');
    var rowEls = {}, labelEls = {}, cuvEls = {};

    /* 合句把手：一條關係（＝一段「合句」）左側有個獨立連結符號，
       可以拖去和別的句子／關係連接（兩段各自已有關係也能互相連）。 */
    var relDragId = null;
    // 1.3.2：拖曳句子時，游標所在的目標單詞
    var dropHot = null;
    function clearDropHot() {
      if (dropHot) { dropHot.classList.remove('drop-hot'); dropHot = null; }
      var xs = body.querySelectorAll('.drop-hot');
      for (var i = 0; i < xs.length; i++) xs[i].classList.remove('drop-hot');
    }
    function relSeg(relId) {
      var r = (project.rels || []).filter(function (x) { return x && x.id === relId; })[0];
      if (!r) return null;
      var ai = L.idx[r.a], bi = L.idx[r.b];
      if (ai == null || bi == null) return null;
      if (ai > bi) { var t = ai; ai = bi; bi = t; }
      return { ai: ai, bi: bi };
    }
    function deliverRel(relId, nodeId) {
      if (!opts.onRelLink) return;
      var seg = relSeg(relId);
      if (!seg) return;
      opts.onRelLink(seg, nodeId);
    }

    var lastVerse = null;      // 節號只在「每一節的第一句」顯示（與範本一致）
    var pal = null, palNodeId = null;
    if (opts.tools) {
      pal = document.createElement('div');
      pal.className = 'ol-pal';
      document.body.appendChild(pal);
      // 在工具列上按右鍵：不要彈出系統原生選單，也不要收起來
      pal.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
      });
      /* 懸浮工具列不再「過一會兒自己消失」：
         只有在別處按下滑鼠、在別處按右鍵（叫出別的選單）、或捲動畫面時才收起。
         滑鼠移開、停著不動都不會消失，方便慢慢點。 */
      ACTIVE_PAL = pal;
      ACTIVE_HIDE = hidePal;
      wirePalOutside();
    }
    function markRow(id) {
      Object.keys(rowEls).forEach(function (k) { rowEls[k].classList.remove('hovering'); });
      if (rowEls[id]) rowEls[id].classList.add('hovering');
    }
    function unmarkRows() {
      Object.keys(rowEls).forEach(function (k) { rowEls[k].classList.remove('hovering'); });
    }
    function posPal(ev) {
      if (!pal) return;
      var w = pal.offsetWidth, h = pal.offsetHeight;
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      pal.style.left = Math.max(8, Math.min(ev.clientX + 16, vw - w - 8)) + 'px';
      pal.style.top = Math.max(8, Math.min(ev.clientY - h / 2, vh - h - 8)) + 'px';
    }
    function showPal(node, idx, textEl, ev) {
      if (!pal) return;
      var isNew = palNodeId !== node.id;
      if (isNew) {
        pal.textContent = '';
        opts.tools(node, idx, pal, textEl);
        palNodeId = node.id;
      }
      pal.style.display = 'flex';
      markRow(node.id);
      // 只在換行時定位一次；之後不再跟著指標移動（否則永遠點不到）
      if (isNew || !pal.dataset.pinned) {
        posPal(ev);
        pal.dataset.pinned = '1';
        PAL_MEM = { id: node.id, x: ev.clientX, y: ev.clientY };
      }
    }
    function hidePal() {
      if (!pal) return;
      pal.style.display = 'none';
      palNodeId = null;
      PAL_MEM = null;          // 明確收起 → 重畫畫面時不再自動重開
      unmarkRows();
      pal.dataset.pinned = '';
    }

    if (opts.cuv) {
      var hd = document.createElement('div');
      hd.className = 'ol-cuvhd';
      var h1 = document.createElement('span');
      h1.textContent = opts.gkTitle || '希臘文原文';
      var h2 = document.createElement('span');
      h2.textContent = opts.cuvTitle || '和合本';
      hd.appendChild(h1);
      hd.appendChild(h2);
      body.appendChild(hd);
    }

    nodes.forEach(function (n, i) {
      var row = document.createElement('div');
      row.className = 'ol-row';
      row.dataset.id = n.id;
      row.dataset.i = i;
      row.style.position = 'relative';

      var ind = G + indPx(i);
      var att = G + attPx(i);

      if (opts.dragHandle) {
        var grip = document.createElement('div');
        grip.className = 'ol-grip';
        grip.textContent = '⛓';
        grip.style.left = Math.max(2, att - 17) + 'px';
        grip.title = '把這個把手拖到另一行＝建立關係（涵蓋這兩行之間的所有句子）';
        grip.draggable = true;
        grip.addEventListener('dragstart', function (ev) {
          ev.stopPropagation();
          ev.dataTransfer.setData('text/plain', n.id);
          ev.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        grip.addEventListener('dragend', function () { row.classList.remove('dragging'); });
        row.appendChild(grip);
      }

      var showNum = n.verse != null && n.verse !== '' && String(n.verse) !== String(lastVerse);
      if (n.verse != null && n.verse !== '') lastVerse = n.verse;
      if (showNum) {
        var num = document.createElement('div');
        num.className = 'ol-num';
        num.textContent = n.verse;
        num.style.left = ind + 'px';   // 右緣＝這一句的文字左緣（與範本一致）
        row.appendChild(num);
      }

      // 和合本對照欄：與希臘文同一列、右側成欄
      // 只要開了對照欄，每一列都走同一組固定欄寬，希臘文欄才不會歪
      var cuvTxt = opts.cuv ? (opts.cuv(n, i) || '') : '';

      // 這一行是不是「介係詞片語」（開頭詞是介詞）
      var prepWord = opts.prepOf ? (opts.prepOf[n.id] || null) : null;
      if (prepWord) row.classList.add('ol-row-prep');

      var kindOf = null;
      if (opts.marks && opts.markFilter) {
        var mk = opts.marks[n.id] || [];
        var byW = {};
        mk.forEach(function (m) { byW[m.w] = m.k; });
        // markFilter 決定「哪些類別目前開著」→ 關掉的類別回空字串（不上色）
        kindOf = function (w, idx) { var k = byW[idx] || ''; return (k && opts.markFilter(k)) ? k : ''; };
      }
      // 專有名詞（1.5.0）：人名／地名／國族 → 在詞上加下劃線
      var properOf = opts.properKind || null;

      // 逐字樣式（1.6.1）：node.rs = [{a,z,b,i,u,c}]，只套在選取到的那一段字上。
      var runs = (opts.runStyles && n.rs && n.rs.length) ? n.rs : null;
      var ident = runs ? { runs: runs, offAt: function (d) { return d; } } : null;

      var t = document.createElement('div');
      t.className = 'ol-text';
      t.dataset.id = n.id;
      t.style.marginLeft = ind + 'px';
      if (opts.front && opts.connectives) {
        var ft = frontText(n.text, opts.connectives);
        if (ft.conn) {
          var frich = runs ? makeFrontRich(n.text, ft, runs) : null;
          var cs = document.createElement('span');
          cs.className = 'conn';
          cs.textContent = ft.conn;
          cs.dataset.w = (ft.connIdx == null ? 0 : ft.connIdx);
          // 連接詞本身若也是動詞／分詞（如 ὤν），一樣上色
          if (kindOf && ft.connIdx != null) {
            var ck = kindOf(ft.conn, ft.connIdx);
            if (ck) { cs.classList.add('k-' + ck.toLowerCase()); cs.dataset.k = ck; }
          }
          if (properOf) {
            var cpk = properOf(ft.conn);
            if (cpk) { cs.classList.add('pr', 'pr-' + cpk); cs.dataset.pr = cpk; }
          }
          if (frich) markWordStyle(cs, runsAt(runs, frich.connOff));
          var lb = opts.connectives[ft.conn];
          cs.title = '關係連接詞' + (lb ? '（' + (lb[0] || lb) + '）' : '');
          t.appendChild(cs);
          var rest = document.createElement('span');
          t.appendChild(rest);
          fillWords(rest, ' ' + ft.post, opts.onWord, kindOf, ft.map, properOf, frich);
        } else {
          fillWords(t, n.text, opts.onWord, kindOf, null, properOf, ident);
        }
      } else {
        fillWords(t, n.text, opts.onWord, kindOf, null, properOf, ident);
      }
      if (opts.editable) {
        t.title = '按兩下可以直接改這一句';
        t.addEventListener('dblclick', function (ev) {
          ev.stopPropagation();
          if (opts.onEdit) opts.onEdit(n, t);
        });
      }
      // 滑到某個希臘文詞 → 通知外面（用來對應和合本欄的那個字）
      if (opts.onWordHover) {
        t.addEventListener('mouseover', function (ev) {
          var el = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
          if (!el || el === t._hovEl) return;
          t._hovEl = el;
          var wi = parseInt(el.dataset.w, 10);
          opts.onWordHover(n.id, isNaN(wi) ? -1 : wi);
        });
        t.addEventListener('mouseleave', function () {
          t._hovEl = null;
          opts.onWordHover(n.id, -1);
        });
      }
      // 剪句模式：滑鼠變成剪刀，直接在詞與詞之間點一下就切開
      // （用 capture 攔在最前面，蓋掉「點詞查詞形」的行為）
      if (opts.onScissor) {
        t.addEventListener('click', function (ev) {
          var el = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
          ev.stopPropagation(); ev.preventDefault();
          opts.onScissor(n, el ? parseInt(el.dataset.w, 10) : -1, ev);
        }, true);
      }
      // 詞序模式：句中單詞可自由拖動調序
      if (opts.wordDrag) {
        var wlist = t.querySelectorAll('.w, .conn');
        for (var qi = 0; qi < wlist.length; qi++) {
          wlist[qi].draggable = true;
          wlist[qi].classList.add('wmove');
        }
        t.addEventListener('dragstart', function (ev) {
          var el = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
          if (!el) return;
          ev.stopPropagation();
          ev.dataTransfer.effectAllowed = 'move';
          try { ev.dataTransfer.setData('text/plain', 'wordmove'); } catch (e) {}
          t._dragW = parseInt(el.dataset.w, 10);
          el.classList.add('wmove-src');
        });
        t.addEventListener('dragend', function () {
          t._dragW = null; t._dropW = null;
          var xs = t.querySelectorAll('.wmove-over, .wmove-src');
          for (var q = 0; q < xs.length; q++) xs[q].classList.remove('wmove-over', 'wmove-src');
        });
        t.addEventListener('dragover', function (ev) {
          if (t._dragW == null) return;
          ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
          var el = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
          var xs = t.querySelectorAll('.wmove-over');
          for (var q = 0; q < xs.length; q++) xs[q].classList.remove('wmove-over');
          if (el) { el.classList.add('wmove-over'); t._dropW = parseInt(el.dataset.w, 10); }
          else t._dropW = null;
        });
        t.addEventListener('drop', function (ev) {
          if (t._dragW == null) return;
          ev.preventDefault(); ev.stopPropagation();
          var from = t._dragW, to = t._dropW;
          t._dragW = null; t._dropW = null;
          if (to != null && to !== from && opts.onWordMove) opts.onWordMove(n, from, to);
        });
      }
      if (opts.cuv) {
        var cols = document.createElement('div');
        cols.className = 'ol-cols';
        cols.appendChild(t);
        var cz = document.createElement('div');
        cz.className = 'ol-cuv';
        cz.dataset.id = n.id;
        // 有「逐詞對應」時，把中文拆成一個詞一個 span，滑到希臘文詞就能對應高亮
        var cm = opts.cuvWords ? opts.cuvWords(n, i) : null;
        if (cm && Object.keys(cm).length) {
          Object.keys(cm).map(Number).sort(function (a, b) { return a - b; }).forEach(function (wi) {
            if (!cm[wi]) return;
            var sp = document.createElement('span');
            sp.className = 'czw';
            sp.dataset.w = wi;
            sp.textContent = cm[wi];
            cz.appendChild(sp);
          });
        } else {
          cz.textContent = cuvTxt;
        }
        if (n.verse) cz.dataset.verse = n.verse;
        // 詞類標示／專名下劃線／逐字樣式「一一對應」到和合本：
        // 逐詞對應的 .czw[data-w] 直接複製同一個希臘文詞的 k-*／pr 樣式，
        // 並把逐字樣式（rs-b/i/u／字色 rb/ri/ru/rc）一併鏡射過去。
        var prs = cz.querySelectorAll('.czw');
        for (var ci = 0; ci < prs.length; ci++) {
          var wi = prs[ci].dataset.w;
          var src = t.querySelector('.w[data-w="' + wi + '"], .conn[data-w="' + wi + '"]');
          if (!src) continue;
          var cls = src.classList;
          for (var cj = 0; cj < cls.length; cj++) {
            var cn = cls[cj];
            if (cn.indexOf('k-') === 0 || cn === 'pr' || cn.indexOf('pr-') === 0) prs[ci].classList.add(cn);
          }
          if (src.dataset.k) prs[ci].dataset.k = src.dataset.k;
          if (src.dataset.pr) prs[ci].dataset.pr = src.dataset.pr;
          // 逐字樣式：把希臘文詞的樣式鏡射到對應的中文詞
          if (src.dataset.rb) prs[ci].classList.add('rs-b');
          if (src.dataset.ri) prs[ci].classList.add('rs-i');
          if (src.dataset.ru) prs[ci].classList.add('rs-u');
          if (src.dataset.rc) prs[ci].style.color = src.dataset.rc;
        }
        cz.title = opts.editable ? '按兩下可以直接改這句的和合本對照' : '和合本對照';
        if (opts.editable && opts.onCuvEdit) {
          cz.addEventListener('dblclick', function (ev) {
            ev.stopPropagation();
            opts.onCuvEdit(n, cz);
          });
        }
        cols.appendChild(cz);
        row.appendChild(cols);
        cuvEls[n.id] = cz;
      } else {
        row.appendChild(t);
      }
      rowEls[n.id] = row;

      if (opts.tools) {
        (function (node, idx, textEl) {
          // 左鍵點一行＝選定這一行（供左側「行工具」作用）
          row.addEventListener('mousedown', function (ev) {
            if (ev.button !== 0) return;
            if (opts.onRowFocus) opts.onRowFocus(node.id);
          });
          // 右鍵＝選定 + 彈出懸浮工具列（保留原本的右鍵工具列）
          row.addEventListener('contextmenu', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (opts.onRowFocus) opts.onRowFocus(node.id);
            showPal(node, idx, textEl, ev);
          });
        })(n, i, t);
      }

      // 任何一句都能拖：拖到別的句子的某個「單詞」上放開 → 縮排掛靠在那個單詞後面
      // （1.3.1：不再限定介係詞片語，也不再自動對齊到動詞）
      if (opts.onPrepDrop) {
        row.draggable = true;
        row.classList.add('hang-drag');
        row.title = '把這一句拖到別的句子的某個單詞上放開，就會掛靠在那個單詞後面';
        row.addEventListener('dragstart', function (ev) {
          ev.stopPropagation();
          ev.dataTransfer.setData('application/x-prep', n.id);
          ev.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', function () { row.classList.remove('dragging'); });
      }
      if (opts.dropTarget) {
        row.addEventListener('dragover', function (ev) {
          ev.preventDefault(); row.classList.add('dropping');
          if (relDragId) row.classList.add('rel-dropping');
          // 1.3.2：拖曳句子時，游標所在的那個「單詞」高亮，讓人看清楚會掛靠在誰後面
          if (relDragId) return;
          var wel = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
          if (dropHot && dropHot !== wel) dropHot.classList.remove('drop-hot');
          dropHot = wel;
          if (wel) wel.classList.add('drop-hot');
        });
        row.addEventListener('dragleave', function (ev) {
          row.classList.remove('dropping', 'rel-dropping');
          if (!row.contains(ev.relatedTarget)) clearDropHot();
        });
        row.addEventListener('drop', function (ev) {
          ev.preventDefault();
          row.classList.remove('dropping', 'rel-dropping');
          clearDropHot();
          var prepId = ev.dataTransfer.getData('application/x-prep');
          if (prepId && opts.onPrepDrop) {
            // 找出放開位置的「詞」；任何單詞都能掛靠
            var el = ev.target && ev.target.closest ? ev.target.closest('.w, .conn') : null;
            var wi = el ? parseInt(el.dataset.w, 10) : -1;
            // 1.6.2：掛靠完成後，被掛靠的單詞不再留任何高亮（陳霂要求）
            opts.onPrepDrop(prepId, n.id, isNaN(wi) ? -1 : wi);
            return;
          }
          // 從「關係把手」拖過來 → 整段合句 × 這一句
          var relId = ev.dataTransfer.getData('application/x-rel');
          if (relId) { deliverRel(relId, n.id); return; }
          var from = ev.dataTransfer.getData('text/plain');
          if (from && from !== n.id) opts.dropTarget(from, n.id);
        });
      }

      body.appendChild(row);
    });

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ol-svg' + (opts.interactiveLines ? ' interactive' : ''));
    body.appendChild(svg);

    function relLeft(el) {
      // 累加 offsetLeft 到 body，得到相對 body 的左緣
      var x = 0, q = el;
      while (q && q !== body) { x += q.offsetLeft || 0; q = q.offsetParent; }
      return x;
    }
    function prepTextEl(nodeId) {
      var r = rowEls[nodeId];
      return r ? r.querySelector('.ol-text') : null;
    }
    // 介係詞片語的縮排（ind）在拖放時就已依目標動詞算好並存進專案，
    // 所以這裡「只量測、不改版面」：算出引導虛線的兩端座標。
    // （幾何走 ind，樹的橫臂／接點才會跟著一致；不要用 marginLeft 硬蓋。）
    function targetVerbX(node) {
      var tEl = prepTextEl(node.pa.t);
      if (!tEl) return null;
      var wEl = tEl.querySelector('[data-w="' + node.pa.w + '"]');
      if (!wEl) return null;
      // relLeft(相對 body) + wEl.offsetLeft(相對 .ol-text 內容盒＝已含 marginLeft)
      return relLeft(tEl) + wEl.offsetLeft;
    }
    function nodeIdxOf(id) { for (var k = 0; k < nodes.length; k++) if (nodes[k].id === id) return k; return -1; }
    function alignPreps() {
      var placed = {};
      nodes.forEach(function (n, i) {
        var r = rowEls[n.id];
        if (!r) return;
        if (!n.pa || !n.pa.t) { r.classList.remove('aligned'); return; }
        var tx = targetVerbX(n);
        var tj = nodeIdxOf(n.pa.t);
        if (tx == null || tj < 0) { r.classList.remove('aligned'); return; }
        r.classList.add('aligned');
        placed[n.id] = {
          x: G + indPx(i),                 // 介係詞片語自己的文字左緣
          y: rowCenter(i),
          tx: tx + 4,                      // 目標動詞右緣附近（+4 讓點落在字上）
          ty: rowCenter(tj)
        };
      });
      return placed;
    }

    function rowCenter(i) {
      var el = rowEls[nodes[i].id];
      if (!el) return 0;
      // 用 offsetTop/offsetHeight（版面座標）比 getBoundingClientRect 穩定：
      // 不會受容器捲動、瀏覽器縮放、列印模擬影響。
      return el.offsetTop + el.offsetHeight / 2;
    }
    function attachXY(k) {
      if (k.t === 'n') return { x: G + attPx(k.i), y: rowCenter(k.i) };
      var kids = L.childrenOf(k.i);
      var y0 = rowCenter(kids[0].t === 'n' ? kids[0].i : firstLeaf(kids[0])),
          y1 = rowCenter(kids[kids.length - 1].t === 'n' ? kids[kids.length - 1].i : firstLeaf(kids[kids.length - 1]));
      return { x: G + relX[k.i], y: (y0 + y1) / 2 };
    }
    // 子關係的接點 y = 該關係豎線的中點 = 其第一/最後子的 y 平均
    function relTopBot(j) {
      var kids = L.childrenOf(j);
      var k0 = kids[0], k1 = kids[kids.length - 1];
      var y0 = (k0.t === 'n') ? rowCenter(k0.i) : anchY(k0.i);
      var y1 = (k1.t === 'n') ? rowCenter(k1.i) : anchY(k1.i);
      return { y0: y0, y1: y1, k0: k0, k1: k1 };
    }
    var anchYcache = {};
    function anchY(j) {
      if (anchYcache[j] != null) return anchYcache[j];
      var tb = relTopBot(j);
      anchYcache[j] = (tb.y0 + tb.y1) / 2;
      return anchYcache[j];
    }
    function firstLeaf(k) { return k.t === 'n' ? k.i : null; }

    function draw() {
      var H = body.scrollHeight;
      svg.removeAttribute('viewBox');
      svg.removeAttribute('width');
      svg.setAttribute('height', H);
      svg.style.width = '100%';
      svg.style.height = H + 'px';
      svg.style.overflow = 'visible';
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var old = body.querySelectorAll('.ol-label, .ol-star, .ol-relgrip');
      for (var q = 0; q < old.length; q++) old[q].parentNode.removeChild(old[q]);
      labelEls = {};
      anchYcache = {};

      rels.forEach(function (o, j) {
        var kids = L.childrenOf(j);
        if (!kids.length) return;
        var k0 = kids[0], k1 = kids[kids.length - 1];
        var y0 = (k0.t === 'n') ? rowCenter(k0.i) : anchY(k0.i);
        var y1 = (k1.t === 'n') ? rowCenter(k1.i) : anchY(k1.i);
        var xa = (k0.t === 'n') ? (G + attPx(k0.i)) : (G + relX[k0.i]);
        var xb = (k1.t === 'n') ? (G + attPx(k1.i)) : (G + relX[k1.i]);
        var x = G + relX[j];
        var dstr = 'M' + xa + ' ' + y0 + ' H' + x + ' V' + y1 + ' H' + xb;

        if (opts.onLine) {
          var hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hit.setAttribute('d', dstr);
          hit.setAttribute('fill', 'none');
          hit.setAttribute('stroke', '#000');
          hit.setAttribute('stroke-opacity', '0');
          hit.setAttribute('stroke-width', '9');
          hit.setAttribute('stroke-linejoin', 'miter');
          hit.setAttribute('pointer-events', 'stroke');
          hit.style.cursor = 'pointer';
          hit.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onLine(o.raw, ev); });
          svg.appendChild(hit);
        }
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', dstr);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', opts.lineColor || '#1b1a17');
        path.setAttribute('stroke-width', opts.lineWidth || 1.0);
        path.setAttribute('stroke-linejoin', 'miter');
        path.setAttribute('pointer-events', 'stroke');
        path.style.cursor = 'pointer';
        svg.appendChild(path);
        if (opts.onLine) path.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onLine(o.raw, ev); });

        // 關係（合句）把手：左側一個可拖曳的連結符號
        if (opts.dragHandle && opts.dropTarget) {
          var rg = document.createElement('div');
          rg.className = 'ol-relgrip';
          rg.textContent = '⛓';
          rg.style.left = (x - 15) + 'px';
          rg.style.top = ((y0 + y1) / 2) + 'px';
          rg.title = '拖這個連結符號到別的句子（或另一條關係）上放開＝把整段「合句」拿去連接';
          rg.draggable = true;
          rg.addEventListener('dragstart', function (ev) {
            ev.stopPropagation();
            ev.dataTransfer.setData('application/x-rel', o.id);
            ev.dataTransfer.effectAllowed = 'move';
            relDragId = o.id;
          });
          rg.addEventListener('dragend', function () { relDragId = null; });
          rg.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
          body.appendChild(rg);
        }

        var txt = '';
        if (opts.labelFor) txt = opts.labelFor(o.raw);
        else {
          txt = o.label || (opts.relation && opts.relation(o.type) ? opts.relation(o.type).short : '');
        }
        txt = String(txt).replace(/\*/g, '');      // 星號改為獨立元素，不混在字裡
        var starMode = o.star ? (o.starAt === 'first' ? 'first' : 'second') : null;
        if (!txt && !starMode) return;
        // 標記：貼在豎線「下側與下橫線的抝角」（底端對齊下橫臂上方）
        var labBottom = y1 - lblGap;
        if (starMode === 'second') labBottom -= (starH + starGap);
        if (txt) {
          var lab = document.createElement('div');
          lab.className = 'ol-label';
          lab.style.left = (x + PAD) + 'px';
          lab.style.top = labBottom + 'px';      // CSS translateY(-100%) → top 即底端
          lab.style.width = LBLW + 'px';
          Array.from(String(txt)).forEach(function (c) {
            var s = document.createElement('span');
            s.textContent = c;
            lab.appendChild(s);
          });
          lab.title = '按一下可以改這條關係';
          if (opts.onLabel) {
            lab.style.pointerEvents = 'auto';
            lab.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onLabel(o.raw, lab); });
          }
          body.appendChild(lab);
          labelEls[o.id] = lab;
        }
        // 星號：重點在首句 → 豎線與上橫線的抝角；重點在次句 → 標記下方、下橫線上方
        if (starMode) {
          var st = document.createElement('div');
          st.className = 'ol-star' + (starMode === 'first' ? ' top' : ' bottom');
          st.textContent = '*';
          st.style.left = (x + PAD) + 'px';
          st.style.width = LBLW + 'px';
          st.style.top = (starMode === 'first'
            ? (y0 + starH / 2 + starGap)
            : (y1 - starH / 2 - starGap)) + 'px';
          body.appendChild(st);
        }
      });

      // 介係詞片語：只保留「對齊」的結果（縮排與淡藍底），
      // 原本那條從片語拉出去的虛線已移除——改用「滑到動詞→高亮和合本對應詞」。
      alignPreps();

      if (opts.afterDraw) opts.afterDraw(svg, body, rowEls, labelEls);
    }

    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(function () { global.requestAnimationFrame(draw); });
    }
    draw();
    if (global.document && global.document.fonts && global.document.fonts.ready) {
      global.document.fonts.ready.then(function () { draw(); });
    }
    if (global.addEventListener) global.addEventListener('load', function () { setTimeout(draw, 60); });

    function redrawStable(times, gap, done) {
      // 版面（字型載入、CJK 換行）可能在第一次 draw 之後才定下來，
      // 導致線停在舊座標 → 反覆重畫直到高度連續穩定為止。
      var n = times || 8, last = -1, stable = 0, k = 0;
      function step() {
        var h = body.scrollHeight;
        draw();
        if (h === last) stable++; else stable = 0;
        last = h; k++;
        if ((stable >= 3 && k >= 4) || k >= n) { if (done) done(); return; }
        setTimeout(step, gap || 120);
      }
      step();
    }

    return { draw: draw, redrawStable: redrawStable, layout: L, rowEls: rowEls,
             labelEls: labelEls, cuvEls: cuvEls, gutter: G, alignPreps: alignPreps,
             hidePal: hidePal, keepPal: keepPal };

    /* 重畫後，若工具列原本開著、那一行還在、而且縮排頁正顯示著，
       就照原位重新打開（讓「上移／下移／新增／刪除」等工具可以連續點）。 */
    function keepPal() {
      if (!PAL_MEM || !pal || !opts.tools) return;
      if (!body.getClientRects().length) return;
      var mi = -1;
      for (var q = 0; q < nodes.length; q++) if (nodes[q].id === PAL_MEM.id) { mi = q; break; }
      if (mi < 0 || !rowEls[PAL_MEM.id]) { PAL_MEM = null; return; }
      var row = rowEls[PAL_MEM.id];
      var txtEl = row.querySelector ? row.querySelector('.ol-text') : null;
      showPal(nodes[mi], mi, txtEl, { clientX: PAL_MEM.x, clientY: PAL_MEM.y });
    }
  }

  /* ---------------- 筆記（像 Word 的批注） -------------
   * 資料：project.notes = [{id, node, text, x, y}]
   *   node = 這則筆記釘在哪一句（節點 id）
   *   x, y = 註記卡在「筆記欄」裡的座標（px，相對 host）
   * host    = 筆記欄的內容區（卡片絕對定位的容器）
   * connect = 拉虛線的座標系容器（整個 .ol-split；虛線從卡片左緣連到該句右緣）
   * 列印版也共用這一支（只是不做拖曳與編輯）。
   */
  function renderNotes(host, connect, project, opts) {
    opts = opts || {};
    if (!host) return null;
    var notes = (project && project.notes) || [];
    host.textContent = '';
    var svg = null;
    if (connect) {
      svg = connect.querySelector('.ol-note-svg');
      if (svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
    }
    var rowEls = opts.rowEls || {};
    var live = notes.filter(function (n) { return n && n.node && rowEls[n.node]; });
    if (!live.length) {
      /* 1.5.0 修 bug：筆記刪光後，虛線（svg path）與被撐高的畫布高度都要一併清掉。
         以前只清卡片、沒清 svg → 最後一則筆記刪掉後，那條虛線還留在紙上。 */
      if (svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
      if (opts.emptyHtml != null) host.innerHTML = opts.emptyHtml;
      host.style.minHeight = '';
      if (connect) connect.style.minHeight = '';
      return [];
    }
    var cards = [];

    live.forEach(function (n, k) {
      var card = document.createElement('div');
      card.className = 'ol-note';
      card.dataset.id = n.id;
      var row = rowEls[n.node];
      var rowIdx = row ? parseInt(row.dataset.i, 10) : 0;
      if (isNaN(rowIdx)) rowIdx = 0;
      var hd = document.createElement('div');
      hd.className = 'n-hd';
      hd.textContent = '第 ' + (rowIdx + 1) + ' 句';
      var tx = document.createElement('div');
      tx.className = 'n-tx';
      tx.textContent = n.text || '';
      card.appendChild(hd);
      card.appendChild(tx);
      if (opts.editable) {
        var del = document.createElement('button');
        del.className = 'n-del';
        del.textContent = '✕';
        del.title = '刪除這則筆記';
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (opts.onDelete) opts.onDelete(n);
        });
        card.appendChild(del);
      }
      if (n.x == null || n.y == null) { n.x = 4; n.y = 6 + k * 64; }
      card.style.left = n.x + 'px';
      card.style.top = n.y + 'px';
      host.appendChild(card);
      cards.push({ n: n, card: card });

      // 編輯文字（列印版不開）
      if (opts.editable) {
        tx.contentEditable = 'true';
        tx.title = '直接打字寫筆記';
        tx.addEventListener('input', function () { n.text = tx.textContent; if (opts.onEdit) opts.onEdit(n); });
        tx.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        tx.addEventListener('blur', function () { if (opts.onEdit) opts.onEdit(n, true); });
        // 拖曳：抓標題列移動整張卡
        hd.style.cursor = 'move';
        hd.addEventListener('mousedown', function (ev) {
          if (ev.button !== 0) return;
          ev.preventDefault(); ev.stopPropagation();
          var sx = ev.clientX, sy = ev.clientY, ox = n.x, oy = n.y, moved = false;
          var cw = card.offsetWidth || 200;
          function mv(e2) {
            var dx = e2.clientX - sx, dy = e2.clientY - sy;
            if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) moved = true;
            if (!moved) return;
            n.x = Math.max(0, Math.min(ox + dx, laneW - cw));
            n.y = Math.max(0, oy + dy);
            card.style.left = n.x + 'px'; card.style.top = n.y + 'px';
            drawLines();
          }
          function up() {
            document.removeEventListener('mousemove', mv);
            document.removeEventListener('mouseup', up);
            if (moved && opts.onMove) opts.onMove(n);
          }
          document.addEventListener('mousemove', mv);
          document.addEventListener('mouseup', up);
        });
      }
      card.addEventListener('mousedown', function () { if (opts.onFocus) opts.onFocus(n.node); });
    });

    // 卡片寬度＝筆記車道寬度（扣掉滑鼠與邊框，避免溢出）
    var laneW = host.clientWidth || 296;
    var w = Math.max(90, laneW - 14);
    cards.forEach(function (c) { c.card.style.width = w + 'px'; });

    // 卡片可能往下超出紙張：把畫布撐高，讓畫板能捲到最下面的卡片
    var maxY = 0;
    cards.forEach(function (c) {
      maxY = Math.max(maxY, (c.n.y || 0) + (c.card.offsetHeight || 40));
    });
    host.style.minHeight = (maxY + 16) + 'px';
    // 車道是絕對定位 → 要靠 olSplit 的 min-height 把捲動範圍撐出來
    if (connect) {
      var paper = connect.querySelector('.ol-paper');
      var ph = paper ? paper.offsetHeight : 0;
      connect.style.minHeight = Math.max(ph, maxY + 24) + 'px';
    }

    function drawLines() {
      if (!svg || !connect) return;
      var cr = connect.getBoundingClientRect();
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('viewBox', '0 0 ' + cr.width + ' ' + cr.height);
      svg.setAttribute('width', cr.width);
      svg.setAttribute('height', cr.height);
      svg.style.width = cr.width + 'px';
      svg.style.height = cr.height + 'px';
      cards.forEach(function (c) {
        var row = rowEls[c.n.node];
        if (!row) return;
        var txt = row.querySelector('.ol-text');
        var tr = (txt || row).getBoundingClientRect();
        var nr = c.card.getBoundingClientRect();
        var x1 = tr.right - cr.left, y1 = tr.top + tr.height / 2 - cr.top;
        var x2 = nr.left - cr.left, y2 = nr.top + Math.min(16, nr.height / 2) - cr.top;
        var mx = (x1 + x2) / 2;
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', opts.lineColor || '#d9b44a');
        p.setAttribute('stroke-width', opts.lineWidth || 1.2);
        p.setAttribute('stroke-dasharray', opts.dash || '4 3');
        svg.appendChild(p);
      });
    }
    drawLines();
    return { drawLines: drawLines, cards: cards };
  }

  global.GK = {
    PT: PT, GAP_PT: GAP_PT, newId: newId,
    layout: layout, renderOutline: renderOutline, fillWords: fillWords, fillRich: fillRich,
    findConnective: findConnective, frontText: frontText, LBLW: LBLW,
    renderNotes: renderNotes
  };
})(window);
