/* 글로벌 주식플래너 — 미장·국장 테마 대시보드
 * 데이터: docs/data/stocks.json (야후 파이낸스, 약 15분 지연·일봉 기준)
 */
(() => {
  'use strict';

  const DEFAULT_WATCH = ['NVDA', 'MSFT', '045970.KQ', '034020.KS', '142210.KQ'];
  const WATCH_KEY = 'gsp_watch_v1';
  const state = {
    market: 'us',
    data: null,
    hist: {},
    watch: [],
    view: 'home',
    arg: null,
    chart: null,
    charts: null,
    colorUp: '#e0342b',
    colorDown: '#1673e6',
  };

  /* ---------------------------------------------------------------- utils */
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function stocksOf(market) {
    const m = state.data && state.data.markets[market];
    return (m && m.stocks) || {};
  }
  function marketOf(market) {
    return (state.data && state.data.markets[market]) || null;
  }
  function findStock(sym) {
    for (const k of ['us', 'kr']) {
      const s = stocksOf(k)[sym];
      if (s) return s;
    }
    return null;
  }
  function fx() { return (state.data && state.data.meta && state.data.meta.usd_krw) || 1350; }

  function group3(s) {
    const neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function fixed(v, d) {
    const p = Math.pow(10, d);
    return (Math.round(Number(v) * p) / p).toFixed(d);
  }
  function money(v, cur) {
    if (v == null || Number.isNaN(Number(v))) return '–';
    if (cur === 'KRW') return group3(String(Math.round(Number(v)))) + '원';
    return '$' + group3(fixed(v, 2));
  }
  function axisMoney(v, cur) {
    if (cur === 'KRW') return group3(String(Math.round(Number(v))));
    return group3(fixed(v, 2));
  }
  function krwApprox(v, cur) {
    if (cur === 'KRW' || v == null) return '';
    const won = v * fx();
    const rounded = won >= 100000 ? Math.round(won / 1000) * 1000 : Math.round(won);
    return '약 ' + rounded.toLocaleString('ko-KR') + '원';
  }
  function pct(v, withSign = true) {
    if (v == null || Number.isNaN(v)) return '–';
    const s = Number(v).toFixed(2);
    return (withSign && v > 0 ? '+' : '') + s + '%';
  }
  function pctCls(v) { return v > 0.005 ? 'up' : (v < -0.005 ? 'down' : 'flat'); }
  function compact(v) {
    if (v == null) return '–';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '만';
    return String(Math.round(v));
  }
  /* 거래량 축 눈금 (1000.0만 같은 표기를 피한다) */
  function volAxis(v) {
    if (v == null || Number.isNaN(Number(v))) return '';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
    if (v >= 1e4) return Math.round(v / 1e4).toLocaleString('ko-KR') + '만';
    return String(Math.round(v));
  }
  function mcapText(s) {
    if (!s.market_cap) return '–';
    if (s.currency === 'KRW') return compact(s.market_cap) + '원';
    return '$' + compact(s.market_cap);
  }

  /* ---------------------------------------------------------------- watch */
  function loadWatch() {
    try {
      const raw = localStorage.getItem(WATCH_KEY);
      if (!raw) return DEFAULT_WATCH.slice();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : DEFAULT_WATCH.slice();
    } catch (e) { return DEFAULT_WATCH.slice(); }
  }
  function saveWatch() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(state.watch)); } catch (e) { /* ignore */ }
  }
  function isWatched(sym) { return state.watch.indexOf(sym) !== -1; }
  function toggleWatch(sym) {
    const i = state.watch.indexOf(sym);
    if (i === -1) { state.watch.push(sym); toast('⭐ 관심종목에 담았습니다'); }
    else { state.watch.splice(i, 1); toast('관심종목에서 뺐습니다'); }
    saveWatch();
  }

  let toastTimer = null;
  function toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  /* ---------------------------------------------------------------- clock */
  function tzParts(tz, d = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    fmt.formatToParts(d).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
    let H = parseInt(p.hour, 10) % 24;
    return { y: +p.year, m: +p.month, d: +p.day, H, M: +p.minute, S: +p.second };
  }
  function tzOffset(tz) {
    const now = new Date();
    const p = tzParts(tz, now);
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
    return asUTC - Math.floor(now.getTime() / 1000) * 1000;
  }
  function instantAt(tz, dayOffset, h, m) {
    const p = tzParts(tz);
    const off = tzOffset(tz);
    return Date.UTC(p.y, p.m - 1, p.d + dayOffset, h, m, 0) - off;
  }
  function weekdayOf(tz) {
    const p = tzParts(tz);
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }
  function nextTrading(tz, hour, min) {
    const wd = weekdayOf(tz);
    let d = 1;
    while ([0, 6].indexOf((wd + d) % 7) !== -1) d++;
    return instantAt(tz, d, hour, min);
  }

  function usClock() {
    const tz = 'America/New_York';
    const p = tzParts(tz);
    const mins = p.H * 60 + p.M;
    const wd = weekdayOf(tz);
    const weekend = (wd === 0 || wd === 6);
    if (weekend) {
      return { state: '주말 휴장', cls: 'closed', target: nextTrading(tz, 9, 30), label: '다음 정규장 개장' };
    }
    if (mins < 240) return { state: '프리장 전', cls: 'closed', target: instantAt(tz, 0, 4, 0), label: '프리장 시작' };
    if (mins < 570) return { state: '프리장 진행', cls: 'pre', target: instantAt(tz, 0, 9, 30), label: '정규장 개장' };
    if (mins < 960) return { state: '정규장 진행 중', cls: 'open', target: instantAt(tz, 0, 16, 0), label: '정규장 마감' };
    if (mins < 1200) return { state: '애프터장 진행', cls: 'pre', target: nextTrading(tz, 9, 30), label: '정규장 개장' };
    return { state: '장 마감', cls: 'closed', target: nextTrading(tz, 4, 0), label: '프리장 시작' };
  }
  function krClock() {
    const tz = 'Asia/Seoul';
    const p = tzParts(tz);
    const mins = p.H * 60 + p.M;
    const wd = weekdayOf(tz);
    if (wd === 0 || wd === 6) return { state: '주말 휴장', cls: 'closed', target: nextTrading(tz, 9, 0), label: '다음 정규장 개장' };
    if (mins < 510) return { state: '장 시작 전', cls: 'closed', target: instantAt(tz, 0, 9, 0), label: '정규장 개장' };
    if (mins < 540) return { state: '장전 동시호가', cls: 'pre', target: instantAt(tz, 0, 9, 0), label: '정규장 개장' };
    if (mins < 930) return { state: '정규장 진행 중', cls: 'open', target: instantAt(tz, 0, 15, 30), label: '정규장 마감' };
    return { state: '장 마감', cls: 'closed', target: nextTrading(tz, 9, 0), label: '다음 정규장 개장' };
  }
  function fmtDur(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (d > 0 ? d + '일 ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function kstShort(ts) {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts)).replace(' ', ' ');
  }

  function tickClock() {
    const el = $('#clockLine');
    if (!el || !state.data) return;
    const c = state.market === 'us' ? usClock() : krClock();
    const left = c.target - Date.now();
    const note = state.market === 'us'
      ? '정규장 09:30–16:00 ET (한국 23:30~06:00 겨울 / 22:30~05:00 서머타임)'
      : '정규장 09:00–15:30 KST · 장전 동시호가 08:30';
    el.innerHTML =
      '<span class="dot ' + c.cls + '"></span><b>' + esc((state.market === 'us' ? '🇺🇸 ' : '🇰🇷 ') + c.state) + '</b>' +
      ' <span>· ' + esc(c.label) + '까지</span> <b>' + fmtDur(left) + '</b>' +
      ' <span>(' + esc(kstShort(c.target)) + ' KST)</span>' +
      '<span style="flex-basis:100%;color:#9aa1ad;font-size:10.5px">' + esc(note) + '</span>';
  }

  /* ---------------------------------------------------------------- data */
  async function loadData() {
    if (window.__SNAP__) {           /* 단일 파일(오프라인) 모드 */
      state.data = window.__SNAP__;
      const m0 = state.data.meta || {};
      $('#stamp').textContent = (m0.generated_at_kst || '').replace(' KST', '') + ' 갱신 · 15분 지연';
      return;
    }
    let res = null;
    for (let i = 0; i < 3; i++) {
      try {
        res = await fetch('data/stocks.json?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) break;
      } catch (e) { res = null; }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    if (!res || !res.ok) throw new Error('데이터 응답 ' + (res ? res.status : '실패'));
    state.data = await res.json();
    const meta = state.data.meta || {};
    $('#stamp').textContent = (meta.generated_at_kst || '').replace(' KST', '') + ' 갱신 · 15분 지연';
  }
  async function loadHist(sym) {
    if (state.hist[sym]) return state.hist[sym];
    if (window.__HIST__ && window.__HIST__[sym]) {
      state.hist[sym] = window.__HIST__[sym];
      return state.hist[sym];
    }
    let lastErr = null;
    const stamp = (state.data && state.data.meta && state.data.meta.generated_at) || '';
    const base = 'data/hist/' + encodeURIComponent(sym) + '.json';
    for (let i = 0; i < 3; i++) {
      try {
        /* 데이터 갱신 시각을 캐시 키에 넣어 오래된 히스토리가 남지 않게 한다 */
        const params = [];
        if (stamp) params.push('v=' + encodeURIComponent(stamp));
        if (i) params.push('r=' + Date.now());
        const url = base + (params.length ? '?' + params.join('&') : '');
        const res = await fetch(url, { cache: 'default' });
        if (!res.ok) throw new Error('차트 응답 ' + res.status);
        const j = await res.json();
        state.hist[sym] = j;
        return j;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
    throw lastErr || new Error('차트 데이터 없음');
  }

  /* ---------------------------------------------------------------- route */
  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const market = (parts[0] === 'us' || parts[0] === 'kr') ? parts[0] : state.market;
    const view = parts[1] || 'home';
    const arg = parts[2] ? decodeURIComponent(parts[2]) : null;
    return { market, view, arg };
  }
  function go(path) {
    if (location.hash === path) { route(); return; }
    location.hash = path;
  }
  function href(market, view, arg) {
    return '#/' + market + '/' + view + (arg ? '/' + encodeURIComponent(arg) : '');
  }

  /* ---------------------------------------------------------------- render */
  function route() {
    const r = parseHash();
    const here = location.hash || '#/' + r.market + '/home';
    state.prevHash = (state.lastHash && state.lastHash !== here) ? state.lastHash : null;
    state.market = r.market;
    state.view = r.view;
    state.arg = r.arg;
    if (state.charts) { state.charts.forEach((c) => { try { c.remove(); } catch (e) { /* ignore */ } }); state.charts = null; }
    if (state.chart) { try { state.chart.remove(); } catch (e) {} state.chart = null; }
    if (state.ro) { try { state.ro.disconnect(); } catch (e) {} state.ro = null; }
    renderTop();
    const app = $('#app');
    let html = '';
    if (!state.data) {
      html = '<div class="empty">데이터를 불러오는 중…</div>';
    } else if (state.view === 'theme') {
      html = viewTheme(r.arg);
    } else if (state.view === 'stock') {
      html = viewStock(r.arg);
    } else if (state.view === 'screen') {
      html = viewScreen();
    } else if (state.view === 'spike') {
      html = viewSpike();
    } else if (state.view === 'watch') {
      html = viewWatch();
    } else if (state.view === 'info') {
      html = viewInfo();
    } else {
      html = viewHome();
    }
    app.innerHTML = html;
    window.scrollTo(0, 0);
    state.lastHash = here;
    if (state.view === 'stock') mountChart(r.arg);
    tickClock();
  }

  function renderTop() {
    $('#tabUs').classList.toggle('on', state.market === 'us');
    $('#tabKr').classList.toggle('on', state.market === 'kr');
    $('#tabUs').setAttribute('aria-selected', state.market === 'us');
    $('#tabKr').setAttribute('aria-selected', state.market === 'kr');
    document.querySelectorAll('.tbtn').forEach((b) => {
      const n = b.dataset.nav;
      b.classList.toggle('on', n === state.view || (n === 'home' && state.view === 'home'));
    });
    const m = marketOf(state.market);
    const strip = $('#indexStrip');
    if (m && m.indices) {
      strip.innerHTML = m.indices.map((ix) => {
        const isFx = ix.symbol === 'KRW=X';
        const price = isFx ? '₩' + axisMoney(ix.price, 'USD') : axisMoney(ix.price, 'USD');
        return '<div class="ix"><div class="ix-name">' + esc(ix.name) + '</div>' +
          '<div class="ix-price">' + esc(price) + '</div>' +
          '<div class="ix-chg ' + pctCls(ix.change_pct) + '">' + pct(ix.change_pct) + '</div></div>';
      }).join('');
    }
  }

  /* ---------------------------------------------------------------- home */
  function viewHome() {
    const m = marketOf(state.market);
    const stocks = m.stocks || {};
    const themes = m.themes || [];
    const list = Object.keys(stocks).map((k) => stocks[k]);
    const gz = list.filter((s) => s.golden_zone).length;
    const cands = list.filter((s) => s.filter_count >= 3).length;
    const hot = themes[0];
    const watched = state.watch.map(findStock).filter(Boolean)
      .filter((s) => s.market === state.market);

    const upN = list.filter((s) => s.change_pct > 0).length;
    const downN = list.filter((s) => s.change_pct < 0).length;
    const spikes = list.filter((s) => s.vol_spike).length;
    const warns = list.filter((s) => s.fake_rally_warn).length;
    const topS = list.slice().sort((a, b) => b.change_pct - a.change_pct)[0];
    const summary =
      '<div class="card" style="padding:12px 14px">' +
        '<div style="font-size:13.5px;font-weight:700;letter-spacing:-.2px">' +
          (hot ? hot.emoji + ' 오늘 ' + (state.market === 'us' ? '미장' : '국장') + '은 <span class="' + pctCls(hot.avg_change) + '">' + esc(hot.name) + ' ' + pct(hot.avg_change) + '</span>이 이끌었어요' : '테마 데이터 준비 중') +
        '</div>' +
        '<div class="hint" style="margin-top:3px">상승 ' + upN + ' · 하락 ' + downN + ' · 골든존 ' + gz + '개 · 거래량 2배↑ ' + spikes + '개' +
          (topS ? ' · 1위 ' + esc(topS.name) + ' ' + pct(topS.change_pct) : '') + '</div>' +
      '</div>';

    const cards =
      '<div class="cards">' +
        card('🔥 지금 유행 테마', hot ? hot.emoji + ' ' + hot.name : '–',
             hot ? pct(hot.avg_change) + ' · ↑' + hot.up + ' ↓' + hot.down : '',
             href(state.market, 'theme', hot ? hot.id : '')) +
        card('🎯 4중 필터 매수후보', cands + '개 종목',
             '골든존 ' + gz + '개 · 눌림·정배열 통과', href(state.market, 'screen')) +
        card('🔍 종목 검색', '종목·티커 검색', '한글 이름으로도 찾기', 'SEARCH') +
        card('⭐ 관심종목', watched.length + '개 담김',
             watched.length ? watched[0].name + ' ' + pct(watched[0].change_pct) : '별을 눌러 담아두세요',
             href(state.market, 'watch')) +
        '<button class="alertcard" data-go="' + href(state.market, 'spike') + '">' +
          '<div class="ac-l"><b>🔥 거래량 급증 ' + spikes + '개</b>' +
            '<span>20일 평균 2배 이상 · ' + (warns ? '매물 출회·자금유입 경고 ' + warns + '개' : '경고 없음') + '</span></div>' +
          '<span class="chev">›</span>' +
        '</button>' +
      '</div>';

    const rows = themes.map((t) => {
      const l = t.leader;
      return '<button class="theme-row" data-go="' + href(state.market, 'theme', t.id) + '">' +
        '<span class="emoji">' + t.emoji + '</span>' +
        '<div class="tr-main">' +
          '<div class="tr-name">' + esc(t.name) + ' <span class="cnt">↑' + t.up + ' ↓' + t.down + '</span></div>' +
          '<div class="tr-leader"><span class="badge leader">대장</span>' + esc(l.name) +
            ' <span style="font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#9aa1ad">' + esc(l.symbol) + '</span>' +
            ' <span class="pct ' + pctCls(l.change_pct) + '">' + pct(l.change_pct) + '</span></div>' +
        '</div>' +
        '<div class="tr-right"><span class="avg pct ' + pctCls(t.avg_change) + '">' + pct(t.avg_change) + '</span>' +
          '<span class="chev">›</span></div>' +
      '</button>';
    }).join('');

    const meta = state.data.meta;
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 2px 8px">' +
        '<div class="hint">테마 평균 등락률 순 · ' + (state.market === 'us' ? '미국장' : '국장') + ' ' + list.length + '종목</div>' +
        '<button class="chip" id="btnReload" style="font-size:11px">⟳ 새로고침</button>' +
      '</div>' +
      summary +
      cards +
      '<div class="sec-title"><h2>오늘의 뜨거운 테마</h2><small>클릭 → 대장주·관련주</small></div>' +
      rows +
      '<div class="card" style="margin-top:10px">' +
        '<h3>📌 이 화면 쓰는 법</h3>' +
        '<div class="kv"><span class="k">골든존</span><span class="v">200일선 ±3% 또는 RSI 35~45 눌림</span></div>' +
        '<div class="kv"><span class="k">4중 필터</span><span class="v">추세 · RSI · 거래량/양봉 · 손익비</span></div>' +
        '<div class="kv"><span class="k">볼린저밴드</span><span class="v">20일선 ±2표준편차 (상단 돌파=과열, 하단 근접=반등 자리)</span></div>' +
        '<div class="kv"><span class="k">거래량 배수</span><span class="v">20일 평균 대비 · 2배 이상이면 🔥 급증</span></div>' +
        '<div class="kv"><span class="k">경고</span><span class="v">윗꼬리 + 거래량 = 매물 출회 의심 · CMF 음수 = 자금유입 약함</span></div>' +
        '<div class="kv"><span class="k">데이터</span><span class="v">' + esc(meta.delay_note) + '</span></div>' +
        '<div style="margin-top:10px"><button class="chip" data-go="' + href(state.market, 'info') + '">자세한 안내 · 한계 보기 →</button></div>' +
      '</div>';
  }

  function card(label, value, sub, target) {
    const attr = target === 'SEARCH' ? 'data-search="1"' : 'data-go="' + target + '"';
    return '<button class="scard" ' + attr + '>' +
      '<span class="lbl">' + label + '</span>' +
      '<span class="val">' + esc(value) + '</span>' +
      '<span class="sub2">' + sub + '</span></button>';
  }

  /* ---------------------------------------------------------------- theme */
  function viewTheme(id) {
    const m = marketOf(state.market);
    const t = (m.themes || []).find((x) => x.id === id);
    if (!t) return '<div class="empty">테마를 찾을 수 없습니다.</div>';
    const lead = m.stocks[t.leader.symbol];
    let html = '<div class="pagehead">' +
      '<button class="backbtn" data-go="' + href(state.market, 'home') + '">‹</button>' +
      '<div><h2>' + t.emoji + ' ' + esc(t.name) + '</h2>' +
      '<div class="ph-sub">평균 <b class="' + pctCls(t.avg_change) + '">' + pct(t.avg_change) + '</b> · ↑' + t.up + ' ↓' + t.down +
      ' · 골든존 ' + t.golden_count + '개</div></div></div>';

    if (lead) {
      html += '<button class="leader-card" style="width:100%;text-align:left" data-go="' + href(state.market, 'stock', lead.symbol) + '">' +
        '<div class="lbl">👑 이 테마의 대장주</div>' +
        '<div class="nm">' + esc(lead.name) + ' <span style="font-size:11px;font-weight:700;opacity:.65">' + esc(lead.symbol) + '</span></div>' +
        '<div class="px">' + money(lead.price, lead.currency) + '</div>' +
        '<div class="ch ' + pctCls(lead.change_pct) + '">' + pct(lead.change_pct) +
          ' <span style="opacity:.6;font-weight:600">(' + money(lead.price - (lead.price / (1 + lead.change_pct / 100)), lead.currency) + ')</span></div>' +
        '<div class="chips">' +
          (lead.golden_zone ? '<span class="chip gz">🟡 골든존</span>' : '') +
          '<span class="chip">' + esc(lead.verdict) + '</span>' +
          '<span class="chip">RSI ' + (lead.rsi14 == null ? '–' : lead.rsi14) + '</span>' +
        '</div>' +
      '</button>';
    }

    html += '<div class="sec-title"><h2>대장주 · 관련주</h2><small>' + t.stocks.length + '종목 · 등락률순</small></div>';
    const sorted = t.stocks.slice().sort((a, b) => b.change_pct - a.change_pct);
    html += '<div class="card">' + sorted.map((r) => {
      const s = m.stocks[r.symbol];
      return rowHtml(s || r, { role: r.role, theme: t });
    }).join('') + '</div>';
    html += '<div class="card"><h3>💡 이 테마 보는 법</h3><div class="hint">' +
      '대장주가 먼저 움직이고 관련주가 따라오는 경우가 많아요. 대장주가 200일선 위에서 눌림(RSI 35~50)을 주는지 먼저 보고, 관련주는 대장주보다 뒤늦게 반응하니 골든존 배지가 뜬 종목을 눈여겨보세요.</div></div>';
    return html;
  }

  /* 종목 상세 상단 태그 */
  function detailTags(s) {
    const out = [];
    if (s.rsi_state && s.rsi_state_key && s.rsi_state_key !== 'na') {
      out.push('<span class="tag rsi ' + s.rsi_state_key + '">RSI ' + (s.rsi14 == null ? '–' : s.rsi14) +
        ' · ' + esc(s.rsi_state) + '</span>');
    }
    if (s.vol_spike && s.vol_ratio != null) {
      out.push('<span class="tag vol">🔥 거래량 ' + s.vol_ratio + '배</span>');
    }
    (s.fake_rally_reasons || []).forEach((r) => {
      out.push('<span class="tag warn">⚠️ ' + esc(r.label) + '</span>');
    });
    if (s.bb_pos_key === 'hot') out.push('<span class="tag bbhot">📈 ' + esc(s.bb_pos) + '</span>');
    else if (s.bb_pos_key === 'cold') out.push('<span class="tag bbcold">📉 ' + esc(s.bb_pos) + '</span>');
    return out.join('');
  }

  /* 리스트용 배지: RSI 상태 · 거래량 2배↑ · 가짜 상승 경고 · 볼린저 극단 */
  function stockBadges(s) {
    const out = [];
    if (s.rsi_state && s.rsi_state_key && s.rsi_state_key !== 'na') {
      out.push('<span class="chip rsi ' + s.rsi_state_key + '" title="RSI(14) ' +
        (s.rsi14 == null ? '–' : s.rsi14) + ' · ' + esc(s.rsi_state) + '">RSI ' + esc(s.rsi_state) + '</span>');
    }
    if (s.vol_spike && s.vol_ratio != null) {
      out.push('<span class="chip vol" title="오늘 거래량이 20일 평균의 ' + s.vol_ratio + '배">🔥 거래량 ' + s.vol_ratio + '배</span>');
    }
    (s.fake_rally_reasons || []).forEach((r) => {
      out.push('<span class="chip warn" title="' + esc(r.detail) + '">⚠️ ' + esc(r.label) + '</span>');
    });
    if (s.bb_pos_key === 'hot') {
      out.push('<span class="chip bbhot" title="볼린저 상단(' + (s.bb_upper == null ? '–' : s.bb_upper) + ') 위 — 단기 과열">📈 볼린저 상단</span>');
    }
    return out.length ? '<div class="rbadges">' + out.join('') + '</div>' : '';
  }

  function rowHtml(s, opt) {
    const role = opt && opt.role;
    const dots = (s.filters || []).map((f) => '<span class="mdot ' + (f.ok ? 'on' : '') + '"></span>').join('');
    return '<button class="row" style="width:100%;text-align:left" data-go="' + href(state.market, 'stock', s.symbol) + '">' +
      '<div class="rname">' +
        '<div class="n1">' + (role ? '<span class="badge ' + (role === '대장' ? 'leader' : 'member') + '">' + role + '</span>' : '') +
          esc(s.name) + ' <span class="mini-dots">' + dots + '</span></div>' +
        '<div class="n2">' + esc(s.symbol) +
          (s.golden_zone ? ' · <span style="color:#b45309;font-weight:700">골든존</span>' : '') + '</div>' +
        stockBadges(s) +
      '</div>' +
      '<div class="rprice">' +
        '<div class="p1">' + money(s.price, s.currency || (state.market === 'kr' ? 'KRW' : 'USD')) + '</div>' +
        '<div class="p2 ' + pctCls(s.change_pct) + '">' + pct(s.change_pct) + '</div>' +
      '</div></button>';
  }

  /* ---------------------------------------------------------------- screen */
  function viewScreen() {
    const m = marketOf(state.market);
    const list = Object.keys(m.stocks).map((k) => m.stocks[k]);
    const cands = list.filter((s) => s.filter_count >= 3)
      .sort((a, b) => (b.filter_count - a.filter_count) || (b.golden_zone - a.golden_zone) || (b.change_pct - a.change_pct));
    const gz = list.filter((s) => s.golden_zone);
    let html = '<div class="pagehead"><button class="backbtn" data-go="' + href(state.market, 'home') + '">‹</button>' +
      '<div><h2>🎯 4중 필터 매수후보</h2><div class="ph-sub">' + (state.market === 'us' ? '미국장' : '국장') +
      ' · 3개 이상 통과 ' + cands.length + '종목</div></div></div>';

    html += '<div class="card">' +
      '<h3>필터 기준 (고수 기법 통합)</h3>' +
      '<div class="kv"><span class="k">① 추세·바닥</span><span class="v">200일선 위 + 20일선 &gt; 60일선</span></div>' +
      '<div class="kv"><span class="k">② RSI</span><span class="v">35~50 눌림 (과열 추격 금지)</span></div>' +
      '<div class="kv"><span class="k">③ 거래량·양봉</span><span class="v">20일 평균 80% 이상 + 양봉</span></div>' +
      '<div class="kv"><span class="k">④ 손익비</span><span class="v">200일선 손절폭 6% 이내 + 52주 고점 여유</span></div>' +
      '<div class="hint" style="margin-top:8px">4개를 모두 통과해야 "매수 후보". 1개라도 빠지면 눌림을 기다리세요.</div>' +
    '</div>';

    if (!cands.length) {
      html += '<div class="empty">지금은 3개 이상 통과한 종목이 없습니다.<br>급등장에서는 쉬는 것도 전략입니다.</div>';
    } else {
      html += '<div class="sec-title"><h2>통과 종목</h2><small>필터 개수 · 골든존 순</small></div><div class="card">' +
        cands.map((s) => '<button class="row" style="width:100%;text-align:left" data-go="' + href(state.market, 'stock', s.symbol) + '">' +
          '<div class="rname"><div class="n1">' + esc(s.name) +
            ' <span class="chip ' + s.tone + '">' + s.filter_count + '/4</span>' +
            (s.golden_zone ? ' <span class="chip gz">골든존</span>' : '') + '</div>' +
            '<div class="n2">' + esc(s.symbol) + ' · RSI ' + (s.rsi14 == null ? '–' : s.rsi14) +
            ' · 200일선 ' + (s.ma200_dist_pct == null ? '–' : (s.ma200_dist_pct > 0 ? '+' : '') + s.ma200_dist_pct + '%') + '</div>' +
            stockBadges(s) + '</div>' +
          '<div class="rprice"><div class="p1">' + money(s.price, s.currency) + '</div>' +
          '<div class="p2 ' + pctCls(s.change_pct) + '">' + pct(s.change_pct) + '</div></div></button>').join('') + '</div>';
    }

    html += '<div class="sec-title"><h2>🟡 골든존 종목</h2><small>' + gz.length + '개</small></div>' +
      (gz.length ? '<div class="card">' + gz.map((s) => rowHtml(s)).join('') + '</div>' : '<div class="empty">골든존 종목이 없습니다.</div>');
    return html;
  }

  /* ---------------------------------------------------------------- spike */
  function viewSpike() {
    const m = marketOf(state.market);
    const list = Object.keys(m.stocks).map((k) => m.stocks[k]);
    const spikes = list.filter((s) => s.vol_spike)
      .sort((a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0));
    const warns = list.filter((s) => s.fake_rally_warn)
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
    const hotBb = list.filter((s) => s.bb_pos_key === 'hot').length;
    const coldBb = list.filter((s) => s.bb_pos_key === 'cold').length;

    let html = '<div class="pagehead"><button class="backbtn" data-go="' + href(state.market, 'home') + '">‹</button>' +
      '<div><h2>🔥 거래량 · 경고 모아보기</h2><div class="ph-sub">' +
      (state.market === 'us' ? '미국장' : '국장') + ' · 2배↑ ' + spikes.length + '개 · 경고 ' + warns.length + '개</div></div></div>';

    html += '<div class="card"><h3>이 화면 보는 법</h3>' +
      '<div class="hint" style="margin-top:6px">' +
        '<b>🔥 거래량 2배↑</b> — 20일 평균보다 두 배 넘게 터진 날. 뉴스·실적이나 큰 손이 들어왔다는 신호입니다. ' +
        '양봉에 거래량이 붙으면 힘이 실린 것이고, 음봉에 터지면 던지는 물량일 수 있습니다.<br><br>' +
        '<b>⚠️ 매물 출회 의심</b> — 양봉이지만 윗꼬리가 몸통보다 길고 거래량도 많은 모양. 장중에 올랐다가 파는 물량에 밀렸다는 뜻입니다.<br><br>' +
        '<b>⚠️ 자금유입 약함</b> — 가격은 올랐는데 자금흐름(CMF)이 마이너스. 오르는 것처럼 보이지만 실제로는 파는 힘이 더 큰 상태입니다.<br><br>' +
        '<b>📈📉 볼린저</b> — 20일선 ±2표준편차 밴드. 상단을 뚫으면 단기 과열(추격 주의), ' +
        '하단에 붙으면 반등을 노려볼 자리입니다.</div>' +
      '<div class="kv" style="margin-top:8px"><span class="k">볼린저 상단 돌파 과열</span><span class="v">' + hotBb + '개</span></div>' +
      '<div class="kv"><span class="k">볼린저 하단 근접 반등</span><span class="v">' + coldBb + '개</span></div>' +
    '</div>';

    html += '<div class="sec-title"><h2>🔥 거래량 급증</h2><small>' + spikes.length + '종목 · 배수순</small></div>';
    html += spikes.length
      ? '<div class="card">' + spikes.map((s) => rowHtml(s)).join('') + '</div>'
      : '<div class="empty">오늘 20일 평균 2배 이상 터진 종목이 없습니다.</div>';

    html += '<div class="sec-title"><h2>⚠️ 가짜 상승 경고</h2><small>' + warns.length + '종목</small></div>';
    if (warns.length) {
      html += '<div class="card">' + warns.map((s) => {
        return '<button class="row warnrow" style="width:100%;text-align:left" data-go="' + href(state.market, 'stock', s.symbol) + '">' +
          '<div class="rname"><div class="n1">' + esc(s.name) +
            ' <span class="chip ' + s.tone + '">' + s.filter_count + '/4</span></div>' +
            '<div class="n2">' + esc(s.symbol) + ' · RSI ' + (s.rsi14 == null ? '–' : s.rsi14) +
              ' · 5일 ' + (s.chg5 == null ? '–' : (s.chg5 > 0 ? '+' : '') + s.chg5 + '%') + '</div>' +
            (s.fake_rally_reasons || []).map((r) =>
              '<div class="warnline">⚠️ <b>' + esc(r.label) + '</b> — ' + esc(r.detail) + '</div>').join('') +
          '</div>' +
          '<div class="rprice"><div class="p1">' + money(s.price, s.currency) + '</div>' +
          '<div class="p2 ' + pctCls(s.change_pct) + '">' + pct(s.change_pct) + '</div></div></button>';
      }).join('') + '</div>';
    } else {
      html += '<div class="empty">오늘은 가짜 상승 경고에 걸린 종목이 없습니다.</div>';
    }
    return html;
  }

  /* ---------------------------------------------------------------- watch */
  function viewWatch() {
    const items = state.watch.map(findStock).filter(Boolean);
    let html = '<div class="pagehead"><button class="backbtn" data-go="' + href(state.market, 'home') + '">‹</button>' +
      '<div><h2>⭐ 관심종목</h2><div class="ph-sub">' + items.length + '개 · 이 폰에만 저장됩니다</div></div></div>';
    if (!items.length) {
      return html + '<div class="empty">아직 담은 종목이 없어요.<br>종목 화면에서 ☆를 눌러 담아보세요.</div>';
    }
    ['us', 'kr'].forEach((mk) => {
      const list = items.filter((s) => s.market === mk);
      if (!list.length) return;
      html += '<div class="sec-title"><h2>' + (mk === 'us' ? '🇺🇸 미국장' : '🇰🇷 국장') + '</h2><small>' + list.length + '종목</small></div>';
      html += '<div class="card">' + list.map((s) => rowHtml(s)).join('') + '</div>';
    });
    html += '<div class="card"><div class="hint">☆ 다시 누르면 목록에서 빠지고, 다음에 열어도 그대로 남아 있어요.</div></div>';
    return html;
  }

  /* ---------------------------------------------------------------- stock */
  function viewStock(sym) {
    const s = findStock(sym);
    if (!s) return '<div class="empty">종목을 찾을 수 없습니다.</div>';
    const cur = s.currency;
    const kst = kstShortLong(s);
    const pos = s.pos52 == null ? 50 : clamp(s.pos52, 0, 100);
    const an = s.analyst || { available: false, note: '목표가 집계 없음 (차트·4중 필터 기준 확인)' };

    let html = '<div class="pagehead"><button class="backbtn" data-go="' + backTarget() + '">‹</button>' +
      '<div><h2>' + esc(s.name) + '</h2><div class="ph-sub">' + esc(s.symbol) + ' · ' + (s.market === 'us' ? '미국' : '한국') +
      (s.sector ? ' · ' + esc(s.sector) : '') + '</div></div></div>';

    html += '<div class="stock-head">' +
      '<div class="sh-top"><div class="sh-title">' +
        '<div class="sh-name">' + esc(s.name) + '</div>' +
        '<div class="sh-tick">' + esc(s.symbol) + ' · ' + esc(s.name_en || '') + '</div>' +
      '</div>' +
      '<button class="starbtn ' + (isWatched(sym) ? 'on' : '') + '" data-star="' + esc(sym) + '" aria-label="관심종목">' +
        (isWatched(sym) ? '★' : '☆') + '</button></div>' +
      '<div class="sh-price"><span class="big">' + money(s.price, cur) + '</span>' +
        '<span class="diff ' + pctCls(s.change_pct) + '">' + pct(s.change_pct) + '</span></div>' +
      '<div class="sh-krw">' + (cur === 'KRW' ? '전일 ' + money(s.prev_close, cur) + ' · ' + kst : krwApprox(s.price, cur) + ' · ' + kst) + '</div>' +
      '<div class="sh-tags">' + (s.themes || []).map((t) =>
        '<span class="tag" data-go="' + href(s.market, 'theme', t.id) + '">' + t.emoji + ' ' + esc(t.name) + ' · ' + esc(t.role) + '</span>').join('') +
        (s.golden_zone ? '<span class="tag" style="background:#fff7e6;color:#b45309">🟡 골든존</span>' : '') +
        detailTags(s) +
      '</div>' +
      '<div class="range52"><div class="lbl"><span>52주 최저 ' + money(s.low52, cur) + '</span><span>52주 최고 ' + money(s.high52, cur) + '</span></div>' +
        '<div class="bar"><span class="mark" style="left:' + pos + '%"></span></div>' +
        '<div class="lbl"><span>현재 위치 ' + (s.pos52 == null ? '–' : s.pos52 + '%') + '</span><span>오늘 ' + money(s.day_low, cur) + ' ~ ' + money(s.day_high, cur) + '</span></div>' +
      '</div>' +
    '</div>';

    if (s.fake_rally_warn) {
      html += '<div class="warnbox">' +
        '<div class="wb-t">⚠️ 가짜 상승 주의 — 지금 모양 그대로 따라 사면 위험할 수 있어요</div>' +
        (s.fake_rally_reasons || []).map((r) =>
          '<div class="wb-r"><b>' + esc(r.label) + '</b> ' + esc(r.detail) + '</div>').join('') +
      '</div>';
    }

    // 회사 설명
    html += '<div class="card"><h3>🏢 뭐 하는 회사인가요?</h3>' +
      '<p style="font-size:13.5px;color:#374151;margin-top:8px;line-height:1.65">' + esc(s.desc) + '</p>' +
      ((s.themes || []).length ? '<div class="hint" style="margin-top:8px">테마: ' +
        s.themes.map((t) => t.emoji + ' ' + esc(t.name) + '(' + esc(t.role) + ')').join(' · ') + '</div>' : '') +
    '</div>';

    // 차트
    html += '<div class="card chartcard">' +
      '<div class="chart-toolbar">' +
        '<div class="seg"><button class="chart-tab on" data-chart="day">일봉</button><button class="chart-tab" data-chart="week">주봉</button></div>' +
        '<div class="toggles">' +
          '<button class="tg on" data-tg="ma">200일선</button>' +
          '<button class="tg on" data-tg="zone">골든존</button>' +
          '<button class="tg bb' + (chartState.bb ? ' on' : '') + '" data-tg="bb">볼린저밴드</button>' +
          '<button class="tg rsi' + (chartState.rsi ? ' on' : '') + '" data-tg="rsi">RSI</button>' +
        '</div>' +
      '</div>' +
      '<div id="chart"></div>' +
      '<div class="legend" id="chartLegend">불러오는 중…</div>' +
      '<div class="legend rsi-legend" id="rsiLegend"' + (chartState.rsi ? '' : ' hidden') + '>RSI(14) 불러오는 중…</div>' +
      '<div class="chart-note">🟠 200일선(골든선) · 🟡 골든존 = 200일선 ±3% 밴드 · 🟣 볼린저밴드 = 20일선 ±2표준편차 · ' +
        '아래 거래량 막대는 <b style="color:#f97316">주황색</b>이면 20일 평균 2배 이상 급증한 날입니다. ' +
        '<b style="color:#e0342b">RSI 70</b>은 과열, <b style="color:#1673e6">RSI 30</b>은 과매도 기준선이고, ' +
        '주봉은 200일선을 40주선·RSI는 주봉 14주 기준으로 환산합니다.</div>' +
    '</div>';

    // 4중 필터
    html += '<div class="card">' +
      '<h3>🎯 4중 교차 필터 판정</h3>' +
      '<div class="verdict ' + esc(s.tone) + '"><span class="v1">' + esc(s.verdict) + '</span>' +
        '<span class="v2">' + s.filter_count + '/4 통과</span></div>' +
      (s.filters || []).map((f) =>
        '<div class="filter-row"><span class="fmark ' + (f.ok ? 'ok' : 'no') + '">' + (f.ok ? '✓' : '·') + '</span>' +
        '<div class="ftext"><b>' + esc(f.label) + '</b><div class="d">' + esc(f.detail) + '</div></div></div>').join('') +
      '<div class="hint" style="margin-top:8px">' + esc(s.golden_note || '') + '</div>' +
    '</div>';

    // 볼린저밴드 · 거래량 · 자금흐름
    const cmfV = s.cmf20;
    const cmfTxt = cmfV == null ? '–' : (cmfV > 0 ? '+' : '') + cmfV.toFixed(2) +
      (cmfV >= 0.05 ? ' (자금 유입 우위)' : cmfV <= -0.05 ? ' (자금 유출 우위)' : ' (중립)');
    const cmfCls = cmfV == null ? 'flat' : (cmfV >= 0.05 ? 'up' : cmfV <= -0.05 ? 'down' : 'flat');
    html += '<div class="card"><h3>📊 볼린저밴드 · 거래량 · 자금흐름</h3>' +
      '<div class="kv"><span class="k">볼린저밴드 위치</span><span class="v"><span class="chip bb' +
        (s.bb_pos_key || 'na') + '">' + esc(s.bb_pos || '–') + '</span></span></div>' +
      '<div class="kv"><span class="k">상단 / 중심 / 하단</span><span class="v">' +
        money(s.bb_upper, cur) + ' / ' + money(s.bb_mid, cur) + ' / ' + money(s.bb_lower, cur) + '</span></div>' +
      '<div class="kv"><span class="k">밴드 위치(%B)</span><span class="v">' +
        (s.bb_pct_b == null ? '–' : s.bb_pct_b + '<span class="hint"> (0=하단, 100=상단)</span>') + '</span></div>' +
      '<div class="kv"><span class="k">오늘 거래량 / 20일 평균</span><span class="v">' +
        (s.vol_ratio == null ? '–' : s.vol_ratio + '배') + (s.vol_spike ? ' 🔥 급증' : '') + '</span></div>' +
      '<div class="kv"><span class="k">20일 평균 거래량</span><span class="v">' +
        (s.vol_avg20 ? compact(s.vol_avg20) + '주' : '–') + '</span></div>' +
      '<div class="kv"><span class="k">CMF (20일 자금흐름)</span><span class="v ' + cmfCls + '">' + esc(cmfTxt) + '</span></div>' +
      '<div class="kv"><span class="k">최근 5일 등락</span><span class="v ' + pctCls(s.chg5) + '">' +
        (s.chg5 == null ? '–' : (s.chg5 > 0 ? '+' : '') + s.chg5 + '%') + '</span></div>' +
      '<div class="hint" style="margin-top:8px;line-height:1.6">' +
        '볼린저밴드 = 20일선 ±2표준편차. 종가가 <b>상단 위</b>면 단기 과열(추격보다 눌림 대기), ' +
        '<b>하단 근처</b>면 반등을 노려볼 자리이지만 하락 추세면 떨어지는 칼날일 수 있어요. ' +
        'CMF는 -1~+1로, 마이너스면 파는 힘이 더 크다는 뜻입니다.' +
      '</div>' +
    '</div>';

    // 월가 전망
    html += '<div class="card"><h3>🏦 월가 애널리스트 전망</h3>';
    if (an.available) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' +
        (an.recommendation && an.recommendation !== '집계 없음'
          ? '<span class="chip ' + (an.recommendation === '매수' || an.recommendation === '적극 매수' ? 'buy' : 'wait') + '">' + esc(an.recommendation) + '</span>'
          : '') +
        '<span class="hint">' + (an.analysts ? an.analysts + '명 애널리스트 집계' : '') +
        (an.recommendation_mean ? ' · 평균 점수 ' + an.recommendation_mean + '/5' : '') + '</span></div>' +
        '<div class="analyst-grid">' +
          '<div class="ag"><div class="k">평균 목표가</div><div class="v">' + money(an.mean, cur) + '</div></div>' +
          '<div class="ag"><div class="k">중간값</div><div class="v">' + money(an.median, cur) + '</div></div>' +
          '<div class="ag"><div class="k">최고 목표가</div><div class="v up">' + money(an.high, cur) + '</div></div>' +
          '<div class="ag"><div class="k">최저 목표가</div><div class="v down">' + money(an.low, cur) + '</div></div>' +
        '</div>' +
        '<div class="upside">평균 목표가까지 <b class="' + pctCls(an.upside_pct) + '">' + pct(an.upside_pct) + '</b> 여력' +
          (cur === 'USD' && an.upside_pct != null ? ' <span class="hint">(현재가 대비)</span>' : '') +
          (an.revenue_growth != null ? '<div class="hint" style="margin-top:4px">매출 성장률 ' + (an.revenue_growth * 100).toFixed(1) + '% (최근 분기 YoY)</div>' : '') +
        '</div>';
    } else {
      html += '<div class="notice" style="margin-top:8px"><div style="font-weight:800">' + esc(an.note) + '</div>' +
        '<div style="margin-top:4px">이 종목은 애널리스트 목표가가 집계되지 않습니다. 아래 차트의 200일선·골든존과 4중 필터 판정으로만 판단하세요.</div></div>';
    }
    html += '</div>';

    // 매수 가이드
    const g = s.guide || {};
    html += '<div class="card"><h3>🧭 매수 위치 가이드</h3>' +
      '<div class="guide-grid">' +
        '<div class="gg stop"><div class="k">손절가 (-3.5%)</div><div class="v">' + money(g.stop, cur) + '</div></div>' +
        '<div class="gg t1"><div class="k">1차 목표 (+4.5%)</div><div class="v">' + money(g.t1, cur) + '</div></div>' +
        '<div class="gg t2"><div class="k">2차 목표 (+9%)</div><div class="v">' + money(g.t2, cur) + '</div></div>' +
      '</div>' +
      '<div class="hint" style="margin-top:10px">' + esc(g.note || '') + '</div>' +
      (g.entry_note ? '<div class="hint" style="margin-top:4px">📍 ' + esc(g.entry_note) + '</div>' : '') +
      '<div class="kv" style="margin-top:8px"><span class="k">200일선(골든선)</span><span class="v">' +
        money(s.ma200, cur) + (s.ma200_dist_pct != null ? ' (' + (s.ma200_dist_pct > 0 ? '+' : '') + s.ma200_dist_pct + '%)' : '') + '</span></div>' +
      '<div class="kv"><span class="k">20일선 / 60일선</span><span class="v">' + money(s.ma20, cur) + ' / ' + money(s.ma60, cur) + '</span></div>' +
      '<div class="kv"><span class="k">RSI(14)</span><span class="v">' + (s.rsi14 == null ? '–' : s.rsi14) + '</span></div>' +
      '<div class="kv"><span class="k">거래량 / 20일 평균</span><span class="v">' + (s.vol_ratio == null ? '–' : s.vol_ratio + '배') + ' · ' + esc(s.candle || '') + '</span></div>' +
      '<div class="kv"><span class="k">시가총액</span><span class="v">' + mcapText(s) + '</span></div>' +
      '<div class="kv"><span class="k">PER</span><span class="v">' + (s.pe ? s.pe + '배' : '–') + '</span></div>' +
    '</div>';

    html += '<div class="card"><div class="hint">' +
      '💡 이 화면은 매매 판단을 돕는 참고 자료입니다. 가격은 15분 지연·일봉 기준이고, 목표가는 애널리스트 평균이라 보장이 아닙니다.' +
      '</div></div>';
    return html;
  }

  function kstShortLong(s) {
    const t = state.data.meta;
    return '갱신 ' + (t.generated_at_kst || '').replace(' KST', '');
  }
  function backTarget() {
    return state.prevHash || ('#/' + state.market + '/home');
  }

  /* ---------------------------------------------------------------- info */
  function viewInfo() {
    const meta = state.data.meta;
    const m = marketOf(state.market);
    return '<div class="pagehead"><button class="backbtn" data-go="' + href(state.market, 'home') + '">‹</button>' +
      '<div><h2>ℹ️ 안내 · 데이터 한계</h2><div class="ph-sub">정직하게 알고 쓰기</div></div></div>' +
      '<div class="card"><h3>데이터</h3>' +
      '<div class="kv"><span class="k">출처</span><span class="v">' + esc(meta.source) + '</span></div>' +
      '<div class="kv"><span class="k">갱신</span><span class="v">' + esc(meta.generated_at_kst) + '</span></div>' +
      '<div class="kv"><span class="k">지연</span><span class="v">' + esc(meta.delay_note) + '</span></div>' +
      '<div class="kv"><span class="k">환율</span><span class="v">1달러 = ' + money(meta.usd_krw, 'KRW') + '</span></div>' +
      '<div class="kv"><span class="k">종목 수</span><span class="v">미국 ' + Object.keys(state.data.markets.us.stocks).length +
        ' · 국장 ' + Object.keys(state.data.markets.kr.stocks).length + '</span></div>' +
      '</div>' +
      '<div class="card"><h3>계산 방식</h3>' +
      '<div class="kv"><span class="k">200일선</span><span class="v">일봉 종가 200개 단순평균</span></div>' +
      '<div class="kv"><span class="k">골든존</span><span class="v">200일선 ±3% 또는 RSI 35~45 & 200일선 위</span></div>' +
      '<div class="kv"><span class="k">4중 필터</span><span class="v">추세 · RSI · 거래량/양봉 · 손익비</span></div>' +
      '<div class="kv"><span class="k">볼린저밴드</span><span class="v">20일 단순평균 ±2표준편차(모집단)</span></div>' +
      '<div class="kv"><span class="k">거래량 배수</span><span class="v">오늘 거래량 ÷ 직전 20일 평균 · 2배 이상 = 급증</span></div>' +
      '<div class="kv"><span class="k">CMF(20일)</span><span class="v">자금흐름 합 ÷ 거래량 합 · -1~+1</span></div>' +
      '<div class="kv"><span class="k">목표가</span><span class="v">야후 집계 애널리스트 평균 (없으면 표기 안 함)</span></div>' +
      '<div class="kv"><span class="k">손익비 규칙</span><span class="v">손절 -3.5% · 1차 +4.5% · 2차 +9%</span></div>' +
      '</div>' +
      '<div class="card"><h3>한계</h3><div class="hint">' +
      '· 무료 공개 데이터라 <b>약 15분 지연</b>되고, 지표는 <b>일봉 종가</b> 기준이라 장중 흔들림은 반영이 늦습니다.<br>' +
      '· 애널리스트 목표가는 과거 실적·전망이 섞인 값이라 미래 가격을 보장하지 않습니다.<br>' +
      '· 국장 중소형주는 목표가 집계가 없어 차트와 4중 필터로만 판단합니다.<br>' +
      '· 거래량·수급 필터는 기관·외국인 수급 원자료가 아니라 거래량 비율로 대신합니다.<br>' +
      '· CMF는 종가 위치와 거래량만 보는 근사치라 실제 매수·매도 주체를 구분하지 못합니다(무료 데이터 한계).<br>' +
      '· 볼린저밴드는 20일 기준이라 급락·급등 직후에는 밴드가 비정상적으로 벌어질 수 있습니다.<br>' +
      '· 프리장·애프터장 가격은 종목에 따라 비어 있을 수 있습니다.' +
      '</div></div>' +
      '<div class="card"><h3>면책</h3><div class="hint">' + esc(meta.disclaimer) + '</div></div>' +
      ((m.errors && m.errors.length) ? '<div class="card"><h3>수집 실패 종목</h3><div class="hint">' + esc(m.errors.join(' / ')) + '</div></div>' : '');
  }

  /* ---------------------------------------------------------------- chart */
  const chartState = { mode: 'day', ma: true, zone: true, bb: false, rsi: true, sym: null };

  /* 볼린저밴드 (20일 · ±2 표준편차) — 차트용 포인트 */
  function bollingerPoints(candles, n, k) {
    const up = [];
    const mid = [];
    const lo = [];
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i].close;
      s += c;
      s2 += c * c;
      if (i >= n) { const o = candles[i - n].close; s -= o; s2 -= o * o; }
      if (i >= n - 1) {
        const m = s / n;
        const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
        up.push({ time: candles[i].time, value: +(m + k * sd).toFixed(4) });
        mid.push({ time: candles[i].time, value: +m.toFixed(4) });
        lo.push({ time: candles[i].time, value: +(m - k * sd).toFixed(4) });
      }
    }
    return { up, mid, lo };
  }

  /* 거래량 막대 + 20일 평균선 (2배 이상 급증한 날은 강조색) */
  function volumePoints(candles) {
    const bars = [];
    const avgLine = [];
    const ratios = {};
    const byTime = {};
    for (let i = 0; i < candles.length; i++) {
      const v = candles[i].volume || 0;
      const from = Math.max(0, i - 20);
      let sum = 0;
      let cnt = 0;
      for (let j = from; j < i; j++) { sum += candles[j].volume || 0; cnt++; }
      const avg = cnt ? sum / cnt : null;
      const spike = cnt >= 20 && avg > 0 && v / avg >= 2;
      if (cnt >= 20 && avg > 0) ratios[candles[i].time] = +(v / avg).toFixed(1);
      byTime[candles[i].time] = { v: v, r: ratios[candles[i].time] || null };
      bars.push({
        time: candles[i].time,
        value: v,
        color: spike ? '#f97316' : (candles[i].close >= candles[i].open ? 'rgba(224,52,43,.30)' : 'rgba(22,115,230,.26)'),
      });
      if (cnt >= 20 && avg > 0) avgLine.push({ time: candles[i].time, value: +avg.toFixed(0) });
    }
    return { bars, avgLine, ratios, byTime };
  }

  function smaPoints(candles, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].close;
      if (i >= n) sum -= candles[i - n].close;
      if (i >= n - 1) out.push({ time: candles[i].time, value: +(sum / n).toFixed(4) });
    }
    return out;
  }

  /* RSI(14) 전 구간 — 데이터에 저장된 시리즈가 있으면 그대로,
     없으면(옛 캐시·외부 히스토리) 같은 Wilder 공식으로 계산한다. 앞 14개는 값이 없어 건너뛴다. */
  function rsiPoints(candles, period, stored) {
    const n = candles.length;
    let s = (stored && stored.length === n) ? stored : null;
    if (!s) {
      s = new Array(n).fill(null);
      if (n > period) {
        let g = 0;
        let l = 0;
        for (let i = 1; i <= period; i++) {
          const d = candles[i].close - candles[i - 1].close;
          g += Math.max(d, 0);
          l += Math.max(-d, 0);
        }
        let ag = g / period;
        let al = l / period;
        const val = (a, b) => (b === 0 ? 100 : 100 - 100 / (1 + a / b));
        s[period] = +val(ag, al).toFixed(1);
        for (let i = period + 1; i < n; i++) {
          const d = candles[i].close - candles[i - 1].close;
          ag = (ag * (period - 1) + Math.max(d, 0)) / period;
          al = (al * (period - 1) + Math.max(-d, 0)) / period;
          s[i] = +val(ag, al).toFixed(1);
        }
      }
    }
    const points = [];
    const byTime = {};
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (v == null || Number.isNaN(Number(v))) continue;
      const val = +Number(v).toFixed(1);
      points.push({ time: candles[i].time, value: val });
      byTime[candles[i].time] = val;
    }
    return { points, byTime, last: points.length ? points[points.length - 1].value : null };
  }

  /* RSI 상태 문구·색 키 (목록 배지와 같은 기준: 35↓ 과매도 / 35~45 눌림목 / 70↑ 과열) */
  function rsiStateOf(v) {
    if (v == null) return { text: '–', key: 'na' };
    if (v <= 35) return { text: '과매도', key: 'oversold' };
    if (v <= 45) return { text: '눌림목', key: 'dip' };
    if (v >= 70) return { text: '과열', key: 'hot' };
    return { text: '중립', key: 'neutral' };
  }

  function seriesFor(hist) {
    const key = chartState.mode === 'week' ? 'weekly' : 'daily';
    const h = hist[key];
    if (!h || !h.t || !h.t.length) return null;
    const candles = [];
    for (let i = 0; i < h.t.length; i++) {
      candles.push({ time: h.t[i], open: h.o[i], high: h.h[i], low: h.l[i], close: h.c[i], volume: (h.v || [])[i] || 0 });
    }
    const isWeek = chartState.mode === 'week';
    const n200 = isWeek ? 40 : 200;
    const n20 = isWeek ? 10 : 20;
    const n60 = isWeek ? 30 : 60;
    const bb = bollingerPoints(candles, 20, 2);
    return {
      candles,
      ma200: smaPoints(candles, n200),
      ma20: smaPoints(candles, n20),
      ma60: smaPoints(candles, n60),
      bb,
      vol: volumePoints(candles),
      rsi: rsiPoints(candles, 14, h.rsi14),
      isWeek,
      cur: hist.currency || 'USD',
    };
  }

  async function mountChart(sym) {
    const el = document.getElementById('chart');
    if (!el) return;
    let hist;
    try {
      hist = await loadHist(sym);
    } catch (e) {
      el.innerHTML = '<div class="empty">차트 데이터를 불러오지 못했습니다.<br>잠시 후 다시 열어주세요.</div>';
      const lg = document.getElementById('chartLegend');
      if (lg) lg.textContent = '차트 로딩 실패 — 잠시 후 다시';
      return;
    }
    if (state.view !== 'stock' || state.arg !== sym) return;
    drawChart(el, hist, sym);
  }

  function drawChart(el, hist, sym) {
    if (state.charts) { state.charts.forEach((c) => { try { c.remove(); } catch (e) { /* ignore */ } }); state.charts = null; }
    if (state.chart) { try { state.chart.remove(); } catch (e) { /* ignore */ } state.chart = null; }
    if (state.ro) { try { state.ro.disconnect(); } catch (e) { /* ignore */ } state.ro = null; }
    el.innerHTML = '';
    const S = seriesFor(hist);
    if (!S) { el.innerHTML = '<div class="empty">차트 데이터가 없습니다.</div>'; return; }
    const cur = S.cur;
    const isKR = cur === 'KRW';
    const elf = window.LightweightCharts;
    if (!elf) { el.innerHTML = '<div class="empty">차트 라이브러리를 불러오지 못했습니다.</div>'; return; }

    /* 가격·거래량·RSI 패널을 따로 두고 시간축만 동기화한다 (축이 서로를 침범하지 않게) */
    const hostP = document.createElement('div');
    hostP.className = 'chart-pane chart-pane-price';
    const hostV = document.createElement('div');
    hostV.className = 'chart-pane chart-pane-vol';
    el.appendChild(hostP);
    el.appendChild(hostV);
    let hostR = null;
    if (chartState.rsi) {
      hostR = document.createElement('div');
      hostR.className = 'chart-pane chart-pane-rsi';
      el.appendChild(hostR);
    }

    const W = el.clientWidth || 320;
    const base = {
      width: W,
      layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#8b93a1', fontSize: 10, fontFamily: 'inherit' },
      crosshair: {
        mode: elf.CrosshairMode.Normal,
        vertLine: { color: '#c9ced6', width: 1, style: 2, labelBackgroundColor: '#111827' },
        horzLine: { color: '#c9ced6', width: 1, style: 2, labelBackgroundColor: '#111827' },
      },
    };

    const chart = elf.createChart(hostP, Object.assign({}, base, {
      height: 236,
      grid: { vertLines: { color: '#f4f5f7' }, horzLines: { color: '#f4f5f7' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { visible: false, rightOffset: 4, fixLeftEdge: true },
      localization: { priceFormatter: (v) => axisMoney(v, cur) },
    }));
    const volChart = elf.createChart(hostV, Object.assign({}, base, {
      height: 86,
      grid: { vertLines: { color: '#f4f5f7' }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0 } },
      /* RSI 패널이 켜지면 날짜축은 맨 아래 RSI 패널 하나만 보여준다 */
      timeScale: { visible: !chartState.rsi, borderVisible: false, rightOffset: 4, fixLeftEdge: true },
      localization: { priceFormatter: (v) => volAxis(v) },
    }));
    let rsiChart = null;
    if (hostR) {
      rsiChart = elf.createChart(hostR, Object.assign({}, base, {
        height: 84,
        grid: { vertLines: { color: '#f4f5f7' }, horzLines: { color: '#f4f5f7' } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.06 } },
        timeScale: { borderVisible: false, rightOffset: 4, fixLeftEdge: true },
        localization: { priceFormatter: (v) => String(Math.round(v)) },
      }));
    }
    state.chart = chart;
    state.charts = rsiChart ? [chart, volChart, rsiChart] : [chart, volChart];

    const pf = { type: 'price', precision: isKR ? 0 : 2, minMove: isKR ? 1 : 0.01 };

    /* 거래량 패널 — 20일 평균 2배 이상 터진 날은 주황색 */
    const volBar = volChart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
    });
    volBar.setData(S.vol.bars);
    const volAvg = volChart.addLineSeries({
      color: 'rgba(17,24,39,.35)', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'volume' },
    });
    volAvg.setData(S.vol.avgLine);

    /* RSI(14) 패널 — 세로축 0~100 고정, 70(과열)·30(과매도) 점선 기준선 */
    let rsiLine = null;
    if (rsiChart) {
      rsiLine = rsiChart.addLineSeries({
        color: '#4338ca', lineWidth: 2, title: 'RSI(14)',
        priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      });
      rsiLine.setData(S.rsi.points);
      rsiLine.createPriceLine({ price: 70, color: 'rgba(224,52,43,.75)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
      rsiLine.createPriceLine({ price: 30, color: 'rgba(22,115,230,.75)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
      rsiLine.createPriceLine({ price: 50, color: 'rgba(139,147,161,.30)', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
    }

    /* 가격 패널 */
    const candle = chart.addCandlestickSeries({
      upColor: state.colorUp, downColor: state.colorDown,
      borderUpColor: state.colorUp, borderDownColor: state.colorDown,
      wickUpColor: state.colorUp, wickDownColor: state.colorDown,
      borderVisible: false, priceFormat: pf,
    });
    candle.setData(S.candles);

    if (!chartState.bb) {              /* 볼린저 중심선이 20일선이라 중복 시 생략 */
      const ma20 = chart.addLineSeries({ color: '#b7bec9', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
      ma20.setData(S.ma20);
    }
    const ma60 = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
    ma60.setData(S.ma60);

    /* 볼린저밴드 토글 */
    if (chartState.bb && S.bb.up.length) {
      const bbUp = chart.addLineSeries({ color: '#a855f7', lineWidth: 1, lineStyle: 2, title: '볼린저 상단', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: pf });
      bbUp.setData(S.bb.up);
      const bbMid = chart.addLineSeries({ color: '#7c3aed', lineWidth: 1, title: '중심(20일선)', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
      bbMid.setData(S.bb.mid);
      const bbLo = chart.addLineSeries({ color: '#a855f7', lineWidth: 1, lineStyle: 2, title: '볼린저 하단', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: pf });
      bbLo.setData(S.bb.lo);
    }

    if (chartState.ma) {
      const ma200 = chart.addLineSeries({
        color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        title: S.isWeek ? '40주선' : '200일선', priceFormat: pf,
      });
      ma200.setData(S.ma200);
      if (chartState.zone && S.ma200.length) {
        const up = S.ma200.map((p) => ({ time: p.time, value: +(p.value * 1.03).toFixed(4) }));
        const dn = S.ma200.map((p) => ({ time: p.time, value: +(p.value * 0.97).toFixed(4) }));
        const zUp = chart.addLineSeries({ color: 'rgba(245,158,11,.55)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
        zUp.setData(up);
        const zDn = chart.addLineSeries({ color: 'rgba(245,158,11,.55)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf });
        zDn.setData(dn);
      }
    }
    chart.timeScale().fitContent();
    volChart.timeScale().fitContent();
    if (rsiChart) rsiChart.timeScale().fitContent();

    /* 패널 스크롤·확대 동기화 (가상·거래량·RSI 세 패널) */
    let syncing = false;
    const syncPanels = state.charts;
    syncPanels.forEach((a) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      syncPanels.forEach((b) => {
        if (b === a) return;
        try { b.timeScale().setVisibleLogicalRange(r); } catch (e) { /* ignore */ }
      });
      syncing = false;
    }));

    const legend = document.getElementById('chartLegend');
    const setLegend = (c) => {
      if (!legend) return;
      if (!c) {
        const last = S.candles[S.candles.length - 1];
        const m = S.ma200.length ? S.ma200[S.ma200.length - 1].value : null;
        const bbU = S.bb.up.length ? S.bb.up[S.bb.up.length - 1].value : null;
        const bbL = S.bb.lo.length ? S.bb.lo[S.bb.lo.length - 1].value : null;
        legend.innerHTML = esc(S.isWeek ? '주봉' : '일봉') + ' 종가 <b>' + axisMoney(last.close, cur) + '</b>' +
          (m ? ' · 200일선 <b style="color:#b45309">' + axisMoney(m, cur) + '</b>' : '') +
          (chartState.bb && bbU != null ? ' · 볼린저 <b style="color:#7c3aed">' + axisMoney(bbL, cur) + '~' + axisMoney(bbU, cur) + '</b>' : '');
        return;
      }
      const info = S.vol.byTime[c.time];
      legend.innerHTML = esc(c.time) + '  시 ' + axisMoney(c.open, cur) + ' · 고 ' + axisMoney(c.high, cur) +
        ' · 저 ' + axisMoney(c.low, cur) + ' · 종 <b>' + axisMoney(c.close, cur) + '</b>' +
        (info ? ' · 거래량 ' + compact(info.v) + (info.r ? ' (' + info.r + '배)' : '') : '');
    };
    const candleByTime = {};
    S.candles.forEach((c) => { candleByTime[c.time] = c; });

    /* RSI 범례 — 현재(또는 커서) RSI(14) 수치 + 상태 */
    const rsiLegend = document.getElementById('rsiLegend');
    const setRsiLegend = (v, timeStr) => {
      if (!rsiLegend) return;
      if (!chartState.rsi) { rsiLegend.hidden = true; return; }
      rsiLegend.hidden = false;
      const st = rsiStateOf(v);
      rsiLegend.innerHTML = (timeStr ? esc(timeStr) + ' · ' : '') +
        '<span class="rsi-tag">RSI(14)</span> ' +
        '<b class="rsi-num ' + st.key + '">' + (v == null ? '–' : v.toFixed(1)) + '</b> ' +
        '<span class="chip rsi ' + st.key + '">' + st.text + '</span>' +
        ' <span class="rsi-scale">과열 70 / 과매도 30 · ' + (S.isWeek ? '주봉' : '일봉') + ' 기준</span>';
    };

    const onMove = (param) => {
      let d = null;
      if (param && param.time && candleByTime[param.time]) d = candleByTime[param.time];
      setLegend(d);
      setRsiLegend(param && param.time ? S.rsi.byTime[param.time] : S.rsi.last, param && param.time ? param.time : null);
    };
    chart.subscribeCrosshairMove(onMove);
    if (rsiChart) rsiChart.subscribeCrosshairMove(onMove);
    setLegend(null);
    setRsiLegend(S.rsi.last, null);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!w) return;
      chart.applyOptions({ width: w });
      volChart.applyOptions({ width: w });
      if (rsiChart) rsiChart.applyOptions({ width: w });
    });
    ro.observe(el);
    state.ro = ro;
  }

  /* ---------------------------------------------------------------- search */
  function openSearch(prefill) {
    const ov = $('#searchOverlay');
    ov.hidden = false;
    const input = $('#searchInput');
    input.value = prefill || '';
    renderSearch(input.value);
    setTimeout(() => input.focus(), 50);
  }
  function closeSearch() { $('#searchOverlay').hidden = true; }

  function renderSearch(q) {
    const box = $('#searchResults');
    const query = q.trim().toLowerCase();
    if (!state.data) { box.innerHTML = ''; return; }
    const all = [];
    ['us', 'kr'].forEach((mk) => {
      const m = marketOf(mk);
      Object.keys(m.stocks).forEach((k) => all.push(m.stocks[k]));
    });
    const hit = all.filter((s) => {
      if (!query) return true;
      return s.name.toLowerCase().includes(query) ||
        s.symbol.toLowerCase().includes(query) ||
        (s.name_en || '').toLowerCase().includes(query);
    }).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

    if (!hit.length) {
      box.innerHTML = '<div class="empty">"' + esc(q) + '" 검색 결과가 없습니다.</div>';
      return;
    }
    const shown = hit.slice(0, 200);
    let html = '';
    ['us', 'kr'].forEach((mk) => {
      const all = hit.filter((s) => s.market === mk);
      const list = shown.filter((s) => s.market === mk);
      if (!list.length) return;
      html += '<div class="market-sep">' + (mk === 'us' ? '🇺🇸 미국장' : '🇰🇷 국장') + ' · ' + all.length + '</div>';
      html += list.map((s) => '<button class="row" style="width:100%;text-align:left" data-search-pick="' + esc(s.symbol) + '">' +
        '<div class="rname"><div class="n1">' + esc(s.name) + (s.golden_zone ? ' <span class="chip gz">골든존</span>' : '') + '</div>' +
        '<div class="n2">' + esc(s.symbol) + ' · ' + (s.sector || (mk === 'us' ? '미국' : '한국')) + '</div></div>' +
        '<div class="rprice"><div class="p1">' + money(s.price, s.currency) + '</div>' +
        '<div class="p2 ' + pctCls(s.change_pct) + '">' + pct(s.change_pct) + '</div></div></button>').join('');
    });
    box.innerHTML = html;
  }

  /* ---------------------------------------------------------------- events */
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-go],[data-star],[data-nav],[data-market],[data-search],[data-search-pick],[data-chart],[data-tg]');
      if (!t) return;

      if (t.dataset.star) {
        toggleWatch(t.dataset.star);
        const on = isWatched(t.dataset.star);
        t.classList.toggle('on', on);
        t.textContent = on ? '★' : '☆';
        return;
      }
      if (t.dataset.market) {
        const mk = t.dataset.market;
        closeSearch();
        go(href(mk, 'home'));
        return;
      }
      if (t.dataset.nav) {
        const nav = t.dataset.nav;
        if (nav === 'search') { openSearch(''); return; }
        closeSearch();
        go(href(state.market, nav));
        return;
      }
      if (t.dataset.search) { openSearch(''); return; }
      if (t.dataset.searchPick) {
        const s = findStock(t.dataset.searchPick);
        closeSearch();
        if (s) go(href(s.market, 'stock', s.symbol));
        return;
      }
      if (t.dataset.chart) {
        document.querySelectorAll('.chart-tab').forEach((b) => b.classList.toggle('on', b === t));
        chartState.mode = t.dataset.chart === 'week' ? 'week' : 'day';
        const el = document.getElementById('chart');
        if (el && state.hist[state.arg]) drawChart(el, state.hist[state.arg], state.arg);
        return;
      }
      if (t.dataset.tg) {
        const k = t.dataset.tg;
        chartState[k] = !chartState[k];
        t.classList.toggle('on', chartState[k]);
        const el = document.getElementById('chart');
        if (el && state.hist[state.arg]) drawChart(el, state.hist[state.arg], state.arg);
        return;
      }
      if (t.dataset.go) {
        const target = t.dataset.go;
        if (target.indexOf('#/') === 0) go(target);
        return;
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) {
        boot();
        return;
      }
      if (e.target.closest('#btnReload')) {
        toast('최신 데이터를 다시 불러옵니다');
        loadData().then(() => route()).catch(() => toast('새로고침 실패 — 잠시 후 다시'));
      }
    });

    $('#searchClose').addEventListener('click', closeSearch);
    $('#searchInput').addEventListener('input', (e) => renderSearch(e.target.value));
    $('#searchOverlay').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });

    window.addEventListener('hashchange', () => route());
  }

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    state.watch = loadWatch();
    const r = parseHash();
    state.market = r.market;
    state.view = r.view;
    state.arg = r.arg;
    if (!state.bound) { bindEvents(); state.bound = true; }
    if (!state.timer) state.timer = setInterval(tickClock, 1000);
    try {
      await loadData();
    } catch (e) {
      $('#app').innerHTML = '<div class="empty">데이터를 불러오지 못했습니다.<br>' + esc(e.message) + '<br><br>' +
        '<button class="chip" data-retry="1" style="margin-top:10px">⟳ 다시 시도</button></div>';
      $('#stamp').textContent = '오프라인';
      return;
    }
    route();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
