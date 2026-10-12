/* Greeky 靜態版 — 核心分析邏輯（純前端）
 * 把 server.py 的希臘文分析逐段移植成 JS：
 *   形態比對（詞類／格）、分句、連接詞提前、和合本按原文語序對齊、詞形查詢。
 * 資料由 data/*.json 提供；序列比對重現 Python difflib.SequenceMatcher。
 */
(function (global) {
  'use strict';

  // ---------- 常數（與 server.py 對齊） ----------
  var SBLGNT_MARKS = '';
  for (var c = 0x2E00; c <= 0x2E20; c++) SBLGNT_MARKS += String.fromCharCode(c);

  var WORD_RE = /[\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+[0-9]*/g;
  var WORD_RE_ONE = /[\u0370-\u03ff\u1f00-\u1fff\u02bc\u2019]+[0-9]*/;

  var SUBORDINATORS = ['καί', 'καὶ', 'δέ', 'δὲ', 'γάρ', 'γὰρ', 'ἵνα', 'ὅτι', 'ὥστε', 'ἀλλά',
    'ἀλλʼ', 'ἀλλ’', 'οὐ', 'οὐκ', 'οὐχ', 'μή', 'μὴ', 'καθώς', 'καθὼς', 'ὡς',
    'ὥσπερ', 'οὕτως', 'ὅτε', 'ὅταν', 'ἐάν', 'εἰ', 'εἴ', 'διό', 'οὖν', 'τοίνυν',
    'δή', 'μὲν', 'ἤ', 'ἢ', 'ὅπως', 'ὅπου', 'ἐπεί', 'ἐπειδή', 'ἄρα', 'νῦν',
    'κἀγώ', 'κἀκεῖνος', 'μόνον', 'πλὴν', 'μέντοι'];
  var SUBORDINATORS_SET = {};
  SUBORDINATORS.forEach(function (x) { SUBORDINATORS_SET[x] = 1; });

  var CLAUSE_INTRO_SET = {};
  ['ὥστε', 'ἵνα', 'ὅτι', 'ὅπως', 'ἐάν', 'εἰ', 'εἴ', 'ὅτε', 'ὅταν', 'καθώς',
    'καθὼς', 'ὥσπερ', 'διότι', 'ἐπεί', 'ἐπειδή', 'ἀλλά', 'ἀλλʼ', 'ἀλλ’', 'πλήν']
    .forEach(function (x) { CLAUSE_INTRO_SET[x] = 1; });

  var PREPOSITIONS = {};
  ['ἐν', 'εἰς', 'πρός', 'πρὸς', 'διά', 'διʼ', 'δι’', 'ἐκ', 'ἐξ', 'ἀπό', 'ἀπὸ',
    'μετά', 'μετὰ', 'κατά', 'κατὰ', 'ὑπέρ', 'ὑπὲρ', 'περί', 'περὶ', 'ἐπί', 'ἐπὶ',
    'παρά', 'παρὰ', 'σύν', 'ἀντί', 'ἀντὶ', 'ὑπό', 'ὑπὸ', 'πρό', 'πρὸ',
    'ἕνεκεν', 'χάριν', 'ἐναντίον', 'ἄχρι', 'μέχρι']
    .forEach(function (x) { PREPOSITIONS[x] = 1; });

  var CASE_KEYS = ['c1', 'c2', 'c3', 'c4', 'c5'];
  var JCASE_KEYS = ['j1', 'j2', 'j3', 'j4', 'j5'];
  var CASE_LABELS = ['主格', '屬格', '與格', '受格', '呼格'];
  var CASE_INDEX = {};
  CASE_LABELS.forEach(function (l, i) { CASE_INDEX[l] = i; });

  var BOOKS = [
    ['Mt', '馬太福音', '太'], ['Mk', '馬可福音', '可'], ['Lk', '路加福音', '路'],
    ['Jn', '約翰福音', '約'], ['Ac', '使徒行傳', '徒'], ['Ro', '羅馬書', '羅'],
    ['1Co', '哥林多前書', '林前'], ['2Co', '哥林多後書', '林後'], ['Ga', '加拉太書', '加'],
    ['Eph', '以弗所書', '弗'], ['Php', '腓立比書', '腓'], ['Col', '歌羅西書', '西'],
    ['1Th', '帖撒羅尼迦前書', '帖前'], ['2Th', '帖撒羅尼迦後書', '帖後'],
    ['1Ti', '提摩太前書', '提前'], ['2Ti', '提摩太後書', '提後'], ['Tit', '提多書', '多'],
    ['Phm', '腓利門書', '門'], ['Heb', '希伯來書', '來'], ['Jas', '雅各書', '雅'],
    ['1Pe', '彼得前書', '彼前'], ['2Pe', '彼得後書', '彼後'], ['1Jn', '約翰壹書', '約壹'],
    ['2Jn', '約翰貳書', '約貳'], ['3Jn', '約翰參書', '約參'], ['Jud', '猶大書', '猶'],
    ['Re', '啟示錄', '啟']
  ];
  var _CH_NUM = '〇一二三四五六七八九';

  // ---------- 資料載入 ----------
  var DATA = {};         // 名稱 -> 內容
  var DATA_P = {};       // 名稱 -> Promise
  var BASE = '';         // data 目錄（相對於頁面）
  var _conn = null;
  var nativeFetch = (global.__origFetch || global.fetch).bind(global);

  var REG = (global.__GD = global.__GD || {});   // 由 data/*.js 設定的全域資料表
  var REG_P = (global.__GDP = global.__GDP || {});
  var _preps = null;      // 介詞集合（去重音；來自 preps.js，nodeIsPrep 用）
  function prepsSet() {
    if (_preps) return _preps;
    var arr = DATA.preps || REG.preps;
    if (!arr) return {};               // 還沒載入 → 回空（不快取）
    if (!Array.isArray(arr)) { _preps = arr; return _preps; }
    _preps = {};
    arr.forEach(function (x) { _preps[x] = 1; });
    return _preps;
  }

  function load(name) {
    if (DATA[name] !== undefined) return Promise.resolve(DATA[name]);
    if (DATA_P[name]) return DATA_P[name];
    // 1) 已經由 <script> 載入的資料（file:// 也能用）
    if (REG[name] !== undefined) { DATA[name] = REG[name]; return Promise.resolve(REG[name]);
    }
    if (REG_P[name]) { DATA_P[name] = REG_P[name]; return DATA_P[name]; }
    // 2) 用 data_loader 以 <script> 載入 data/<name>.js（file:// 也能用）
    if (global.__gdata) {
      DATA_P[name] = global.__gdata(name).then(function (v) {
        if (v == null) throw new Error('讀不到資料檔：' + name);
        DATA[name] = v; return v;
      });
      return DATA_P[name];
    }
    // 3) 退而求其次：用 fetch 讀 .json（需要 http 服務）
    var url = (BASE ? BASE + '/' : '') + name + '.json';
    DATA_P[name] = nativeFetch(url).then(function (r) {
      if (!r.ok) throw new Error('讀不到資料檔：' + name);
      return r.json();
    }).then(function (j) { DATA[name] = j; return j; });
    return DATA_P[name];
  }

  /* data_loader.js 用：等一批 <script> 載完，把結果註冊進 REG。
     每個 loader 包成 [ name, promise ]；載入失敗不 reject（回 null），
     這樣單一資料檔缺失不會拖垮整個程式。 */
  function registerScript(name, promise) {
    REG_P[name] = promise = promise.catch(function () { return null; });
    promise.then(function (v) { if (v !== null && v !== undefined) REG[name] = v; });
    return promise;
  }

  function init(opts) {
    opts = opts || {};
    if (opts.base != null) BASE = opts.base;
    return Promise.all([load('connectives'), load('books'), load('preps'),
                        load('kinds'), load('morph')]).then(function (a) {
      _conn = a[0] || {};
      _preps = a[2] || {};
      return a[1];
    });
  }

  function connectives() {
    if (_conn) return _conn;
    if (REG.connectives) { _conn = REG.connectives; return _conn; }
    return {};
  }

  // ---------- 希臘文正規化 ----------
  function stripAccents(s) {
    s = (s || '').normalize('NFD').replace(/[\u0300-\u036f\u0345]/g, '');
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(/ς/g, 'σ').toLowerCase();
  }

  function cleanToken(s) {
    s = String(s == null ? '' : s).replace(/[.,;:·!?«»"'‘’“”()\[\]{}<>=/\\|~^*#@&+_%$]/g, '');
    s = s.replace(/\u0387/g, '').replace(/\u00b7/g, '');
    for (var i = 0; i < SBLGNT_MARKS.length; i++) s = s.split(SBLGNT_MARKS[i]).join('');
    s = s.replace(/\u2019/g, '\u02bc');
    return s.trim();
  }

  function _ztok(s) { return stripAccents(cleanToken(s || '')); }

  function cleanVerse(text) {
    text = String(text == null ? '' : text);
    for (var i = 0; i < SBLGNT_MARKS.length; i++) text = text.split(SBLGNT_MARKS[i]).join('');
    return text.replace(/\s+/g, ' ').trim();
  }

  function tokens(text) {
    var out = [], m;
    var re = new RegExp(WORD_RE.source, 'g');
    while ((m = re.exec(text || '')) !== null) out.push(m[0]);
    return out;
  }

  // ---------- 詞類／形態 ----------
  function wordKind(raw) {
    var q = cleanToken(raw);
    if (!q) return '';
    var K = DATA.kinds || {};
    var keys = [q, q.replace(/’/g, 'ʼ'), stripAccents(q)];
    for (var i = 0; i < keys.length; i++) if (K[keys[i]] !== undefined) return K[keys[i]];
    return '';
  }

  function _bestParse(q) {
    if (!q) return null;
    var M = DATA.morph || { exact: {}, norm: {} };
    var res = null, k;
    var keys = [q, q.replace(/’/g, 'ʼ')];
    for (var i = 0; i < keys.length; i++) { if (M.exact[keys[i]]) { res = M.exact[keys[i]]; break; } }
    if (res == null) {
      var nk = stripAccents(q);
      var cand = [nk, nk.replace(/σ$/, 'ς'), nk.replace(/σ/g, 'ς')];
      for (var j = 0; j < cand.length; j++) { if (M.exact[cand[j]]) { res = M.exact[cand[j]]; break; } }
    }
    if (res == null) res = M.norm[stripAccents(q)];
    if (!res || !res.length) return null;
    return res.slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); })[0];
  }

  function wordPosCase(raw) {
    var p = _bestParse(cleanToken(raw));
    if (!p) return null;
    var pos = p.p;
    if (pos !== '名詞' && pos !== '形容詞') return null;
    var ds = p.d || [], idx = null;
    for (var i = 0; i < ds.length; i++) if (CASE_INDEX[ds[i]] !== undefined) { idx = CASE_INDEX[ds[i]]; break; }
    if (idx === null) return null;
    return pos === '名詞' ? [CASE_KEYS[idx], 'n'] : [JCASE_KEYS[idx], 'j'];
  }

  function markWords(text) {
    var out = [], re = new RegExp(WORD_RE.source, 'g'), m, w = 0;
    while ((m = re.exec(text || '')) !== null) {
      var k = wordKind(m[0]);
      if (k === 'V' || k === 'T' || k === 'N') out.push({ w: w, k: k, t: cleanToken(m[0]) });
      w++;
    }
    return out;
  }

  function markWordsAll(text) {
    var out = [], re = new RegExp(WORD_RE.source, 'g'), m, w = 0;
    while ((m = re.exec(text || '')) !== null) {
      var raw = m[0];
      var k = wordKind(raw);
      if (k === 'V' || k === 'T' || k === 'N') { out.push({ w: w, k: k, t: cleanToken(raw) }); }
      else {
        var pc = wordPosCase(raw);
        if (pc) out.push({ w: w, k: pc[0], t: cleanToken(raw), p: pc[1] });
      }
      w++;
    }
    return out;
  }

  function nodeIsPrep(text) {
    var toks = tokens(text);
    if (!toks.length) return null;
    var P = prepsSet();
    if (P[stripAccents(cleanToken(toks[0]))]) return cleanToken(toks[0]);
    return null;
  }

  // ---------- 連接詞 ----------
  function markConnectives(text) {
    var toks = tokens(text);
    if (!toks.length) return [null, null];
    var CT = connectives();
    var hit = CT[cleanToken(toks[0])] || CT[toks[0]];
    return [toks[0], hit ? hit[0] : null];
  }

  function frontConnectives(text) {
    text = String(text == null ? '' : text).trim();
    var spans = [], re = new RegExp(WORD_RE.source, 'g'), m;
    while ((m = re.exec(text)) !== null) spans.push([m.index, re.lastIndex, m[0]]);
    if (!spans.length) return [text, null];
    var CT = connectives();
    for (var idx = 0; idx < Math.min(2, spans.length); idx++) {
      var s = spans[idx][0], e = spans[idx][1], raw = spans[idx][2];
      var key = cleanToken(raw);
      var hit = CT[key] || CT[raw];
      if (!hit) continue;
      if (idx === 0) return [text, key];
      var lead = text.slice(0, s).replace(/[,;·]/g, ' ').trim();
      var wp = text.slice(e);
      var rest = (lead + ' ' + wp).trim().replace(/\s+/g, ' ').trim();
      return [(raw + ' ' + rest).trim(), key];
    }
    return [text, null];
  }

  // ---------- 分句 ----------
  function firstLexemes(s, n) {
    return tokens(s).slice(0, n);
  }

  function _mergeStubs(segs) {
    var out = [], i = 0;
    while (i < segs.length) {
      var s = (segs[i] || '').trim();
      var toks = tokens(s);
      if (toks.length <= 1 && i + 1 < segs.length) {
        out.push((s + ' ' + (segs[i + 1] || '').trim()).trim());
        i += 2; continue;
      }
      out.push(s); i++;
    }
    return out;
  }

  function _splitAtIntro(seg) {
    var m, toks = [], re = new RegExp(WORD_RE.source, 'g');
    while ((m = re.exec(seg)) !== null) toks.push([m.index, re.lastIndex, m[0]]);
    var cuts = [];
    for (var i = 0; i < toks.length; i++) {
      if (i === 0) continue;
      if (CLAUSE_INTRO_SET[cleanToken(toks[i][2])]) {
        if (!seg.slice(toks[i][1]).replace(/[ ,;.·]/g, '')) continue;
        cuts.push(toks[i][0]);
      }
    }
    if (!cuts.length) return [seg];
    var parts = [], prev = 0;
    for (var k = 0; k < cuts.length; k++) {
      var piece = seg.slice(prev, cuts[k]).trim().replace(/^[,\s]+|[,\s]+$/g, '');
      if (piece) parts.push(piece);
      prev = cuts[k];
    }
    var tail = seg.slice(prev).trim();
    if (tail) parts.push(tail);
    return parts.length ? parts : [seg];
  }

  function splitPrep(seg) {
    var m, toks = [], re = new RegExp(WORD_RE.source, 'g');
    while ((m = re.exec(seg)) !== null) toks.push([m.index, m[0]]);
    var cuts = [];
    for (var i = 0; i < toks.length; i++) {
      if (i === 0) continue;
      if (PREPOSITIONS[cleanToken(toks[i][1])]) cuts.push(toks[i][0]);
    }
    if (!cuts.length) return [seg];
    var parts = [], prev = 0;
    for (var k = 0; k < cuts.length; k++) {
      var piece = seg.slice(prev, cuts[k]).trim();
      if (piece) parts.push(piece);
      prev = cuts[k];
    }
    var tail = seg.slice(prev).trim();
    if (tail) parts.push(tail);
    return parts.length ? parts : [seg];
  }

  function splitClauses(body, comma, prep, mid) {
    body = body.replace(/·/g, ';');
    var rough = body.split(/(?<=[;.])\s*/);
    var result = [];
    for (var ri = 0; ri < rough.length; ri++) {
      var chunk = rough[ri].trim();
      if (!chunk) continue;
      var pieces = comma ? chunk.split(/(?<=,)\s*/) : [chunk];
      var buf = '';
      for (var pi = 0; pi < pieces.length; pi++) {
        var p = pieces[pi];
        if (!p.trim()) continue;
        var lead = firstLexemes(p, 2);
        if (buf && (SUBORDINATORS_SET[lead[0]] || (lead.length > 1 && SUBORDINATORS_SET[lead[1]]))) {
          result.push(buf); buf = p;
        } else {
          buf = buf ? (buf + ' ' + p).trim() : p;
        }
      }
      if (buf) result.push(buf);
    }
    if (mid) {
      var out = [];
      for (var si = 0; si < result.length; si++) out = out.concat(_splitAtIntro(result[si]));
      result = _mergeStubs(out);
    }
    if (prep) {
      var out2 = [];
      for (var sj = 0; sj < result.length; sj++) out2 = out2.concat(splitPrep(result[sj]));
      result = _mergeStubs(out2);
    }
    return result;
  }

  function autoSplit(text, comma, verse, prep, mid) {
    text = String(text == null ? '' : text).replace(/\u00a0/g, ' ');
    for (var i = 0; i < SBLGNT_MARKS.length; i++) text = text.split(SBLGNT_MARKS[i]).join('');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    var chunks = [];
    if (verse) {
      var parts = (' ' + text).split(/(?:^|(?<=\s))(\d{1,3})\s+/);
      // parts[0] 為前置字串，其後兩兩成對（數字, 內容）
      if (parts.length > 1) {
        for (var k = 1; k + 1 < parts.length; k += 2) {
          chunks.push([parts[k], (parts[k + 1] || '').trim()]);
        }
        if (parts[0].trim()) chunks.unshift([null, parts[0].trim()]);
      } else {
        chunks.push([null, text]);
      }
    } else chunks.push([null, text]);

    var out = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      var num = chunks[ci][0], body = chunks[ci][1];
      var first = true;
      var segs = splitClauses(body, comma, prep, mid);
      for (var si = 0; si < segs.length; si++) {
        var seg = (segs[si] || '').trim();
        if (!seg) continue;
        if (!/[\u0370-\u03ff\u1f00-\u1fff]/.test(seg)) continue;
        out.push({ text: seg, verse: first ? num : null });
        first = false;
      }
    }
    return out;
  }

  // ---------- Python difflib.SequenceMatcher（autojunk=False） ----------
  function SequenceMatcher(a, b) {
    this.a = a; this.b = b;
    var b2j = {};
    for (var i = 0; i < b.length; i++) {
      var k = b[i];
      (b2j[k] || (b2j[k] = [])).push(i);
    }
    this.b2j = b2j;
  }
  SequenceMatcher.prototype.findLongestMatch = function (alo, ahi, blo, bhi) {
    var a = this.a, b = this.b, b2j = this.b2j;
    var besti = alo, bestj = blo, bestsize = 0;
    var j2len = {};
    for (var i = alo; i < ahi; i++) {
      var newj2len = {};
      var js = b2j[a[i]] || [];
      for (var x = 0; x < js.length; x++) {
        var j = js[x];
        if (j < blo) continue;
        if (j >= bhi) break;
        var c = (j2len[j - 1] || 0) + 1;
        newj2len[j] = c;
        if (c > bestsize) { besti = i - c + 1; bestj = j - c + 1; bestsize = c; }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  };
  SequenceMatcher.prototype.getMatchingBlocks = function () {
    var la = this.a.length, lb = this.b.length;
    var queue = [[0, la, 0, lb]];
    var blocks = [];
    while (queue.length) {
      var q = queue.pop();
      var alo = q[0], ahi = q[1], blo = q[2], bhi = q[3];
      var m = this.findLongestMatch(alo, ahi, blo, bhi);
      var i = m[0], j = m[1], k = m[2];
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort(function (x, y) { return (x[0] - y[0]) || (x[1] - y[1]); });
    // 合併相鄰
    var merged = [], i1 = 0, j1 = 0, k1 = 0;
    blocks.forEach(function (bl) {
      var i2 = bl[0], j2 = bl[1], k2 = bl[2];
      if (i1 + k1 === i2 && j1 + k1 === j2) { k1 += k2; }
      else {
        if (k1) merged.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    });
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    return merged;
  };

  // ---------- 和合本按原文語序對齊 ----------
  function cuvInGreekOrder(project, ogntData) {
    var nodes = (project && project.nodes) || [];
    var meta = (project && project.meta) || {};
    var code = meta.code, ch = meta.ch;
    var out = nodes.map(function () { return ''; });
    var words = nodes.map(function () { return {}; });
    if (!nodes.length || !code || !ch || !ogntData) {
      return { map: out, matched: 0, total: 0, words: words };
    }
    ch = parseInt(ch, 10);
    if (isNaN(ch)) return { map: out, matched: 0, total: 0, words: words };

    var groups = [], last = null;
    nodes.forEach(function (n, i) {
      var v = n.verse;
      var key = (v == null || v === '') ? last : String(v);
      if (!groups.length || groups[groups.length - 1][0] !== key) groups.push([key, [i]]);
      else groups[groups.length - 1][1].push(i);
      if (v != null && v !== '') last = String(v);
    });

    var matched = 0, total = 0;
    groups.forEach(function (g) {
      var key = g[0], idx = g[1];
      if (!key) return;
      var vi = parseInt(key, 10);
      if (isNaN(vi)) return;
      var items = ogntData[code + '|' + ch + '|' + vi];
      if (!items) return;
      var clToks = [];
      idx.forEach(function (i) {
        var re = new RegExp(WORD_RE.source, 'g'), m, wi = 0;
        while ((m = re.exec(nodes[i].text || '')) !== null) {
          clToks.push({ i: i, w: wi, raw: m[0], k: _ztok(m[0]) });
          wi++;
        }
      });
      var ogToks = items.map(function (it) { return { zh: (it.length > 1 ? it[1] : ''), k: _ztok(it[0]) }; });
      total += ogToks.length;
      var sm = new SequenceMatcher(clToks.map(function (t) { return t.k; }),
                                   ogToks.map(function (t) { return t.k; }));
      sm.getMatchingBlocks().forEach(function (bl) {
        var a = bl[0], b = bl[1], size = bl[2];
        for (var d = 0; d < size; d++) {
          var zh = ogToks[b + d].zh;
          if (zh) {
            var ni = clToks[a + d].i, wi = clToks[a + d].w;
            out[ni] += zh;
            words[ni][wi] = (words[ni][wi] || '') + zh;
            matched++;
          }
        }
      });
    });
    return { map: out, matched: matched, total: total, words: words };
  }

  // ---------- 詞形查詢 ----------
  function lookupWord(word) {
    word = String(word == null ? '' : word).trim();
    var q = cleanToken(word);
    if (!q) return { found: false, query: word, parses: [], lex: null };
    var M = DATA.morph || { exact: {}, norm: {} };
    var keys = [q, q.replace(/’/g, 'ʼ')];
    var nk = stripAccents(q);
    var res = null, k;
    for (var i = 0; i < keys.length; i++) { if (M.exact[keys[i]]) { res = M.exact[keys[i]]; break; } }
    if (res == null) {
      var cand = [nk, nk.replace(/σ$/, 'ς'), nk.replace(/σ/g, 'ς')];
      for (var j = 0; j < cand.length; j++) { if (M.exact[cand[j]]) { res = M.exact[cand[j]]; break; } }
    }
    if (res == null) res = M.norm[nk];
    if (res == null && /σ$/.test(nk)) res = M.norm[nk.slice(0, -1) + 'ς'];
    var lex = DATA.lexicon || {};
    var entry = lex[q] || lex[nk] || null;
    if (entry == null && res && res[0]) {
      var l0 = res[0].l || '';
      entry = lex[l0] || lex[stripAccents(l0)] || null;
    }
    var parses = (res || []).slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
    var G = DATA.gloss || {};
    var lem = (parses.length ? parses[0].l : '') || (entry ? entry.t : '') || '';
    var zent = null;
    var gk = [lem, q, nk, stripAccents(lem)];
    for (var z = 0; z < gk.length; z++) { if (gk[z] && G[gk[z]]) { zent = G[gk[z]]; break; } }
    return { found: !!parses.length, query: word, parses: parses, lex: entry, zh: zent };
  }

  // ---------- 取經文 ----------
  function bookBy(x) {
    for (var i = 0; i < BOOKS.length; i++) {
      var b = BOOKS[i];
      if (x === b[0] || x === b[1] || x === b[2] || String(i + 1) === String(x) ||
          ('0' + (i + 1)) === String(x)) return { i: i, code: b[0], name: b[1], short: b[2] };
    }
    return null;
  }

  function cnNum(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n <= 0 || n > 99) return String(n);
    if (n < 10) return _CH_NUM[n];
    var t = Math.floor(n / 10), o = n % 10;
    var s = (t === 1 ? '' : _CH_NUM[t]) + '十';
    return s + (o === 0 ? '' : _CH_NUM[o]);
  }

  function cuvVerses(cuvData, book, ch, v1, v2) {
    var chs = cuvData[book]; if (!chs) return [];
    var vs = chs[String(ch)]; if (!vs) return [];
    var out = [];
    for (var v = v1; v <= v2; v++) { var t = vs[String(v)]; if (t) out.push({ v: v, text: t }); }
    return out;
  }

  function transVerses(transData, book, ch, v1, v2) {
    var chs = transData[book]; if (!chs) return [];
    var vs = chs[String(ch)]; if (!vs) return [];
    var out = [];
    for (var v = v1; v <= v2; v++) { var t = vs[String(v)]; if (t) out.push({ v: v, text: t }); }
    return out;
  }

  function loadPassage(bookArg, ch, v1, v2) {
    var b = bookBy(bookArg);
    if (!b) return Promise.resolve({ ok: false, error: '不認得這卷書' });
    ch = parseInt(ch, 10); v1 = parseInt(v1, 10);
    if (isNaN(ch) || isNaN(v1)) return Promise.resolve({ ok: false, error: '章／節必須是數字' });
    v2 = (String(v2).trim() === '' ? v1 : parseInt(v2, 10));
    if (v2 < v1) { var t = v1; v1 = v2; v2 = t; }
    return Promise.all([load('passages/' + b.code), load('cuv'),
                        load('ognt/' + b.code)]).then(function (arr) {
      var P = arr[0], cuvData = arr[1], ogntBook = arr[2] || {};
      var verses = [];
      var chObj = P[String(ch)] || {};
      for (var v = v1; v <= v2; v++) { if (chObj[String(v)] != null) verses.push({ v: v, text: chObj[String(v)] }); }
      if (!verses.length) return { ok: false, error: '這個範圍沒有經文（請確認章節）' };
      var full = verses.map(function (x) { return x.v + ' ' + x.text; }).join(' ');
      var ognt = [];
      for (var vv = v1; vv <= v2; vv++) {
        var items = ogntBook[b.code + '|' + ch + '|' + vv];
        if (items) ognt.push({ v: vv, items: items });
      }
      return {
        ok: true, book: b.code, bookName: b.name, short: b.short,
        ch: ch, v1: v1, v2: v2, verses: verses, full: full,
        title: b.name + cnNum(ch),
        cuv: cuvVerses(cuvData, b.code, ch, v1, v2),
        cuvName: '和合本',
        ognt: ognt
      };
    });
  }

  global.GCore = {
    init: init, load: load, registerScript: registerScript, connectives: connectives,
    cleanToken: cleanToken, stripAccents: stripAccents, _ztok: _ztok,
    cleanVerse: cleanVerse, tokens: tokens, wordKind: wordKind,
    _bestParse: _bestParse, wordPosCase: wordPosCase,
    markWords: markWords, markWordsAll: markWordsAll, nodeIsPrep: nodeIsPrep,
    markConnectives: markConnectives, frontConnectives: frontConnectives,
    autoSplit: autoSplit, splitClauses: splitClauses,
    cuvInGreekOrder: cuvInGreekOrder, SequenceMatcher: SequenceMatcher,
    lookupWord: lookupWord, loadPassage: loadPassage, cnNum: cnNum,
    cuvVerses: cuvVerses, transVerses: transVerses, bookBy: bookBy,
    SUBORDINATORS: SUBORDINATORS, CLAUSE_INTRO: Object.keys(CLAUSE_INTRO_SET),
    PREPOSITIONS: PREPOSITIONS, BOOKS: BOOKS, WORD_RE: WORD_RE
  };
})(window);
