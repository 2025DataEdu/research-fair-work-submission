/* 관리자 화면 UI — AdminAPI(모의: js/api.js, 실제: google.script.run 래퍼)만 호출한다. */
(function () {
  'use strict';

  var API = window.AdminAPI;
  var HOST = API.host || null; // Apps Script(api-gas.js)에서만 있음: 최상위 주소창 해시 맞추기

  /* ---------- 상수 ---------- */
  var DAY_LABEL = {
    day1: '12월 22일(화) · 리서치 컨퍼런스',
    day2: '12월 23일(수) · BK21 성과공유회',
    both: '12월 22일(화)~23일(수) · 양일 모두 참석'
  };
  var DAY_SHORT = { day1: '22일', day2: '23일', both: '양일' };
  var STATUS_LABEL = { active: '신청', canceled: '취소', all: '전체' };
  var SRC_LABEL = { sms: '문자', qr: '포스터 QR', web: '홈페이지', direct: '직접 접속' };
  var SRC_SUB = { sms: '?src=sms', qr: '?src=qr', web: '?src=web', direct: '경로 값 없음' };
  var KIND_LABEL = { xlsx: '엑셀', csv: 'CSV', badge: '명찰 출력용', stats: '접수 통계 CSV', statsXlsx: '접수 통계 엑셀' };
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  var PAGE_SIZE = 50;
  var DEFAULT_FILTER = { q: '', day: 'all', includeBoth: true, status: 'active', sort: 'createdAt:desc' };
  var ORIGINAL = {
    title: '2026 JBNU-G 리서치페어 위크 참가 신청',
    intro: '전북대학교의 연구성과를 나누고 대학과 지역의 미래 발전 방향을 함께 모색하는 2026 JBNU-G 리서치페어 위크에 여러분을 초대합니다. 대학원생과 연구자의 발표를 통해 BK21 4단계의 성과를 살펴보고, 이를 바탕으로 5단계의 추진 과제와 지역 기업·연구기관과의 새로운 협력 기회를 논의합니다.',
    when: '▪일정 : 2026년 12월 22일(화)~23일(수) ▪장소 : 전북대학교 진수당',
    lead: '참가를 희망하시는 분은 아래 항목을 작성해 주세요.',
    fields: [['이름', '성함을 입력해 주세요.'], ['소속', '소속 학교·학과 또는 기관·부서명을 입력해 주세요.'], ['휴대전화번호', '예시) 010-1234-5678'], ['참석일', '참석 예정일을 선택해 주세요.']]
  };

  /* ---------- 상태 ---------- */
  var S = {
    me: null, summary: null,
    config: null, draft: null, progDay: 'day1',
    filter: clone(DEFAULT_FILTER),
    rows: [], page: 1, listReq: 0, listAsOf: null, rove: null,
    exportReq: 0,
    drawer: null, drawerReturn: null
  };

  /* ---------- 유틸 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtN(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // ISO(+09:00) 문자열을 그대로 잘라 KST 로 표시 (브라우저 시간대와 무관)
  function fmtDT(iso, withYear) {
    if (!iso) return '-';
    return iso.slice(withYear ? 0 : 5, 10).replace(/-/g, '.') + ' ' + iso.slice(11, 16);
  }
  function dow(dateStr) { var p = dateStr.split('-'); return WEEK[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()]; }
  function fmtDateKo(dateStr) { var p = dateStr.split('-'); return (+p[1]) + '월 ' + (+p[2]) + '일(' + dow(dateStr) + ')'; }
  function fmtCloseAt(iso) { return iso ? fmtDateKo(iso.slice(0, 10)) + ' ' + iso.slice(11, 16) : '없음'; }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function hyphenPhone(v) {
    var d = digits(v).slice(0, 11);
    if (d.length < 4) return d;
    if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  }
  function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
  function asOfText(iso) { return iso ? '기준 ' + fmtDT(iso, true) : ''; }

  /* 토스트: 성공은 polite 로 잠시 보이고 사라짐, 오류는 role=alert 로 닫을 때까지 남음 */
  function toast(msg, isError) {
    var el = document.createElement('div');
    el.className = 'toast' + (isError ? ' toast--error' : '');
    if (isError) {
      el.innerHTML = '<span class="toast__msg">' + esc(msg) + '</span><button type="button" class="toast__close">닫기<span class="sr-only"> 오류 알림</span></button>';
      el.querySelector('button').addEventListener('click', function () { el.remove(); });
      $('#toastAlert').appendChild(el);
    } else {
      el.textContent = msg;
      $('#toastPolite').appendChild(el);
      setTimeout(function () { el.remove(); }, 3200);
    }
  }
  function busy(btn, on) { if (!btn) return; btn.classList.toggle('is-busy', on); btn.setAttribute('aria-busy', on ? 'true' : 'false'); }
  function errMsg(e) { return (e && e.message) || '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'; }

  /* ---------- 라우팅 (#/list?day=d22&both=1&status=active&q=…&sort=…) ---------- */
  var VIEWS = ['dashboard', 'list', 'export', 'settings'];
  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, ''), qi = h.indexOf('?');
    var v = qi >= 0 ? h.slice(0, qi) : h;
    return { view: VIEWS.indexOf(v) >= 0 ? v : 'dashboard', qs: qi >= 0 ? h.slice(qi + 1) : null };
  }
  function currentView() { return parseHash().view; }
  function filterFromQs(qs) {
    var f = clone(DEFAULT_FILTER), p = new URLSearchParams(qs);
    if (['all', 'd22', 'd23', 'both'].indexOf(p.get('day')) >= 0) f.day = p.get('day');
    if (p.get('both') === '0') f.includeBoth = false;
    if (['active', 'canceled', 'all'].indexOf(p.get('status')) >= 0) f.status = p.get('status');
    if (p.get('q')) f.q = p.get('q').slice(0, 60);
    if (/^(receiptNo|createdAt|name|org|day|status):(asc|desc)$/.test(p.get('sort') || '')) f.sort = p.get('sort');
    return f;
  }
  function filterQs() {
    var f = S.filter, p = [];
    if (f.day !== 'all') p.push('day=' + f.day);
    if (f.day === 'd22' || f.day === 'd23') p.push('both=' + (f.includeBoth ? 1 : 0));
    p.push('status=' + f.status);
    if (f.q) p.push('q=' + encodeURIComponent(f.q));
    if (f.sort !== DEFAULT_FILTER.sort) p.push('sort=' + f.sort);
    return p.join('&');
  }
  // 필터가 바뀔 때마다 주소에 반영 (기록을 쌓지 않음 → 새로고침해도 유지)
  function writeHash() {
    var v = currentView(), qs = filterQs();
    if (v === 'list' || v === 'export') {
      var h = '#/' + v + '?' + qs;
      if (location.hash !== h) history.replaceState(null, '', h);
    }
    $('#lnkExport').setAttribute('href', '#/export?' + qs);
    $('#lnkEditFilter').setAttribute('href', '#/list?' + qs);
    if (HOST) HOST.syncHash(location.hash);
  }

  function route(focus) {
    var ph = parseHash(), v = ph.view;
    if ((v === 'list' || v === 'export') && ph.qs != null) S.filter = filterFromQs(ph.qs);
    writeHash();
    $all('[data-view]').forEach(function (sec) { sec.hidden = sec.getAttribute('data-view') !== v; });
    $all('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = $('#h-' + v).textContent + ' · 2026 JBNU-G 리서치페어 위크 관리자';
    if (v === 'dashboard') { if (!S.summary) loadSummary(); else { renderSummary(); } }
    if (v === 'list') loadList();
    if (v === 'export') { renderExport(); loadExportLog(); }
    if (v === 'settings') { if (!S.config) loadConfig(); loadSettingsLogs(); }
    if (focus) { var h = $('#h-' + v); h && h.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  window.addEventListener('hashchange', function () { route(true); });

  /* =========================================================
     1. 접수 현황
     ========================================================= */
  // 성공하면 true, 실패하면 false 로 끝난다 (실패 시 오류 영역 + 다시 불러오기)
  function loadSummary() {
    if (!S.summary) $('#kpis').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    $('#kpis').setAttribute('aria-busy', 'true');
    return API.adminGetSummary().then(function (s) {
      S.summary = s;
      $('#dashError').hidden = true;
      $('#dashBody').hidden = false; $('#kpis').hidden = false;
      renderSummary();
      renderOpenPill(s.open, s.closeAt);
      return true;
    }).catch(function (e) {
      $('#kpis').removeAttribute('aria-busy');
      var m = errMsg(e).replace(/^접수 현황을 불러오지 못했어요\.\s*/, '') || '잠시 후 다시 시도해 주세요.';
      $('#dashErrorMsg').textContent = m;
      $('#dashError').hidden = false;
      if (!S.summary) { $('#kpis').hidden = true; $('#dashBody').hidden = true; $('#dashMeta').textContent = '집계를 불러오지 못했어요.'; }
      else $('#dashErrorMsg').textContent = m + ' 아래 숫자는 ' + asOfText(S.summary.generatedAt) + ' 값이에요.';
      return false;
    });
  }

  function renderOpenPill(open, closeAt) {
    var pill = $('#openPill');
    var closed = !open || (closeAt && new Date(closeAt) < new Date(S.summary ? S.summary.generatedAt : Date.now()));
    pill.hidden = false;
    pill.className = 'status-pill ' + (closed ? 'is-closed' : 'is-open');
    pill.textContent = closed ? '접수 마감' : '접수 중';
  }

  function kpi(label, value, sub, lead) {
    return '<div class="kpi' + (lead ? ' kpi--lead' : '') + '"><span class="kpi__label">' + label + '</span>' +
      '<span class="kpi__value">' + fmtN(value) + '<small>명</small></span>' +
      '<p class="kpi__sub">' + sub + '</p></div>';
  }

  function hbar(label, sub, value, max, unit, base) {
    return '<li class="hbar"><span class="hbar__label">' + label + '<small>' + esc(sub) + '</small></span>' +
      '<span class="hbar__track" aria-hidden="true"><span class="hbar__fill" style="width:' + (value / max * 100) + '%"></span></span>' +
      '<span class="hbar__val tnum">' + fmtN(value) + unit + '<small>' + pct(value, base) + '%</small></span></li>';
  }

  function renderSummary() {
    var s = S.summary, b = s.byDay;
    $('#kpis').removeAttribute('aria-busy');
    $('#dashMeta').textContent = asOfText(s.generatedAt) + ' · 사전 접수 마감 ' + fmtCloseAt(s.closeAt);
    $('#kpis').innerHTML =
      kpi('전체 신청', s.total, '취소 제외 · 22일만 <b>' + fmtN(b.day1) + '</b> / 23일만 <b>' + fmtN(b.day2) + '</b> / 양일 <b>' + fmtN(b.both) + '</b>', true) +
      kpi('22일 예상 인원', s.perDate.d22, '22일만 <b>' + fmtN(b.day1) + '</b> + 양일 <b>' + fmtN(b.both) + '</b>') +
      kpi('23일 예상 인원', s.perDate.d23, '23일만 <b>' + fmtN(b.day2) + '</b> + 양일 <b>' + fmtN(b.both) + '</b>') +
      kpi('취소', s.canceled, '집계에서 제외 · 신청 합계 <b>' + fmtN(s.createdTotal) + '</b> = 유효 <b>' + fmtN(s.total) + '</b> + 취소 <b>' + fmtN(s.canceled) + '</b>');

    // 참석일 선택별 (유효 신청 기준)
    var maxDay = Math.max(b.day1, b.day2, b.both, 1);
    $('#dayBreak').innerHTML = '<ul class="hbars hbars--stacked">' + ['day1', 'day2', 'both'].map(function (k) {
      return hbar(k === 'both' ? '양일' : DAY_SHORT[k] + '만', DAY_LABEL[k], b[k], maxDay, '명', s.total);
    }).join('') + '</ul>';

    // 정원
    var caps = [['d22', '22일 (화)'], ['d23', '23일 (수)']];
    var anyCap = s.capacity.d22 != null || s.capacity.d23 != null;
    $('#capacity').innerHTML = !anyCap
      ? '<p class="empty">정원이 정해지지 않았어요. <a href="#/settings">설정</a>에서 날짜별 정원을 넣으면 남은 자리가 표시되고, 차면 접수 페이지에서 그 날짜 선택지가 마감돼요.</p>'
      : '<div class="cap">' + caps.map(function (c) {
        var cap = s.capacity[c[0]], n = s.perDate[c[0]];
        if (cap == null) return '<div class="cap__row"><div class="cap__top"><span class="cap__name">' + c[1] + '</span><span class="cap__nums"><b class="tnum">' + fmtN(n) + '</b>명 · 정원 없음</span></div></div>';
        var r = cap ? n / cap : 1, left = cap - n;
        var st = left <= 0 ? ['full', '마감'] : r >= 0.9 ? ['warn', '거의 참'] : ['ok', '여유'];
        return '<div class="cap__row">' +
          '<div class="cap__top"><span class="cap__name">' + c[1] + ' <span class="tag tag--' + st[0] + '">' + st[1] + '</span></span>' +
          '<span class="cap__nums tnum"><b>' + fmtN(n) + '</b> / ' + fmtN(cap) + '명</span></div>' +
          '<div class="cap__track" role="progressbar" aria-label="' + c[1] + ' 정원 대비 예상 인원" aria-valuemin="0" aria-valuemax="' + cap + '" aria-valuenow="' + Math.min(n, cap) + '">' +
          '<div class="cap__fill is-' + st[0] + '" style="width:' + Math.min(100, r * 100) + '%"></div></div>' +
          '<div class="cap__foot tnum"><span>' + Math.round(r * 100) + '% 찼어요</span><span>' + (left > 0 ? '남은 자리 ' + fmtN(left) + '석' : '초과 ' + fmtN(-left) + '명') + '</span></div></div>';
      }).join('') + '</div>';

    renderConversion(s);

    $('#trendRecon').innerHTML = '신청일 기준 신규 합계 <b>' + fmtN(s.createdTotal) + '</b>건 = 유효 <b>' + fmtN(s.total) + '</b> + 취소 <b>' + fmtN(s.canceled) + '</b>' +
      (sumOf(s.daily, 'restored') ? ' <span class="recon__note">(취소 처리 ' + fmtN(sumOf(s.daily, 'canceled')) + '건 중 ' + fmtN(sumOf(s.daily, 'restored')) + '건은 복원)</span>' : '');
    drawTrend();
    renderTrendTable();
  }
  function sumOf(list, key) { return list.reduce(function (a, d) { return a + (d[key] || 0); }, 0); }

  /* ---------- 유입 경로: 방문 → 신청 전환 (방문집계, 개인 식별 없음) ---------- */
  var SRC_KEYS = ['sms', 'qr', 'web', 'direct'];
  var ZERO_SRC = { sms: 0, qr: 0, web: 0, direct: 0, total: 0 };
  // 0.4722 → '47.2%', null(방문 0) → '–'
  function convPct(c) { return c == null ? null : Math.round(c * 1000) / 10; }
  function convText(c) { var p = convPct(c); return p == null ? '–' : p.toFixed(1) + '%'; }
  function visitsAsOf(s) {
    var at = s.visitsUpdatedAt;
    if (!at) return '아직 반영된 방문이 없어요';
    var same = s.generatedAt && at.slice(0, 10) === s.generatedAt.slice(0, 10);
    return '마지막 반영 ' + (same ? '' : fmtDateKo(at.slice(0, 10)) + ' ') + at.slice(11, 16);
  }
  function renderConversion(s) {
    var v = s.visits || ZERO_SRC, a = s.visitSubmits || ZERO_SRC, c = s.conversion || {};
    function cells(k) {
      var p = convPct(c[k]);
      return '<td class="num">' + fmtN(v[k]) + '</td><td class="num">' + fmtN(a[k]) + '</td>' +
        '<td class="num"><span class="conv__rate">' +
        (p == null ? '' : '<span class="conv__bar" aria-hidden="true"><span style="width:' + Math.min(100, p) + '%"></span></span>') +
        '<span class="conv__pct">' + convText(c[k]) + '</span></span></td>';
    }
    var rows = SRC_KEYS.map(function (k) {
      return '<tr><th scope="row"><span class="conv__src">' + SRC_LABEL[k] + '</span><small>' + esc(SRC_SUB[k]) + '</small></th>' + cells(k) + '</tr>';
    }).join('');
    $('#srcBreak').innerHTML =
      '<div class="table-wrap table-wrap--compact conv-wrap"><table class="data-table data-table--plain conv-table">' +
      '<caption class="sr-only">유입 경로별 방문, 신청, 전환율. 방문은 브라우저 탭 단위로 한 번만 센 값, 신청은 취소 포함 접수 건수, 전환율은 신청 나누기 방문이에요.</caption>' +
      '<thead><tr><th scope="col">경로</th><th scope="col" class="num">방문</th><th scope="col" class="num">신청</th><th scope="col" class="num">전환율</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr class="is-total"><th scope="row">합계</th>' + cells('total') + '</tr></tfoot></table></div>' +
      '<p class="conv-note">방문은 브라우저 탭 단위로 한 번만 세고 개인을 식별하지 않아요 · 약 1분마다 반영 (' + visitsAsOf(s) + ')</p>';
  }

  /* ---------- 일별 추이 차트 (손으로 그린 SVG, 공유 x축 2단: 막대=신청일 기준 신규, 선=유효 누적) ---------- */
  var trend = { active: -1, geo: null };

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function ticks(max, n) {
    var step = niceStep(Math.max(max, 1) / n), top = Math.ceil(Math.max(max, 1) / step) * step, out = [];
    for (var v = 0; v <= top + 1e-9; v += step) out.push(v);
    return { top: top, list: out };
  }
  function barPath(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    var b = y + h;
    return 'M' + x + ',' + b + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) +
      'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + b + 'Z';
  }

  function drawTrend() {
    var box = $('#trendChart');
    if (!S.summary || !box || box.offsetParent === null) return;
    var data = S.summary.daily, n = data.length;
    var W = Math.max(300, Math.round(box.clientWidth));
    var narrow = W < 520;
    var padL = 36, padR = narrow ? 16 : 24;
    var top1 = 24, h1 = narrow ? 130 : 160;            // 막대 구역
    var top2 = top1 + h1 + 52, h2 = narrow ? 72 : 90;  // 유효 누적 선 구역
    var axisY = top2 + h2 + 20, H = axisY + 10;
    var plotW = W - padL - padR, band = plotW / n;
    var barW = Math.max(3, Math.min(28, band - 2 - band * 0.3));
    var maxCum = Math.max.apply(null, data.map(function (d) { return d.cumulative; }));
    var t1 = ticks(Math.max.apply(null, data.map(function (d) { return d.count; })), 3);
    var t2 = ticks(maxCum, 2);
    var y1 = function (v) { return top1 + h1 - v / t1.top * h1; };
    var y2 = function (v) { return top2 + h2 - v / t2.top * h2; };
    var cx = function (i) { return padL + band * i + band / 2; };
    var every = Math.max(1, Math.ceil(30 / band));

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true" focusable="false">';
    svg += '<text class="panel-label" x="0" y="12">' + (narrow ? '일별 신규 신청 (건, 신청일 기준)' : '일별 신규 신청 (건) · 신청일 기준, 나중에 취소된 건 포함') + '</text>';
    svg += '<text class="panel-label panel-label--green" x="0" y="' + (top2 - 14) + '">' + (narrow ? '유효 신청 누적 (명, 취소 반영)' : '유효 신청 누적 (명) · 그날 끝 기준, 취소 반영') + '</text>';
    svg += '<g class="grid">';
    t1.list.forEach(function (v) { svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y1(v) + '" y2="' + y1(v) + '"/>'; });
    t2.list.forEach(function (v) { svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y2(v) + '" y2="' + y2(v) + '"/>'; });
    svg += '</g>';
    t1.list.forEach(function (v) { svg += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y1(v) + 4) + '" text-anchor="end">' + v + '</text>'; });
    t2.list.forEach(function (v) { svg += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y2(v) + 4) + '" text-anchor="end">' + v + '</text>'; });
    data.forEach(function (d, i) {
      svg += '<path class="bar" data-i="' + i + '" d="' + barPath(cx(i) - barW / 2, y1(d.count), barW, h1 - (y1(d.count) - top1), 4) + '"/>';
    });
    svg += '<line class="baseline" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (top1 + h1) + '" y2="' + (top1 + h1) + '"/>';
    var pts = data.map(function (d, i) { return cx(i).toFixed(1) + ',' + y2(d.cumulative).toFixed(1); });
    svg += '<path class="cum-area" d="M' + cx(0) + ',' + (top2 + h2) + 'L' + pts.join('L') + 'L' + cx(n - 1) + ',' + (top2 + h2) + 'Z"/>';
    svg += '<polyline class="cum-line" points="' + pts.join(' ') + '"/>';
    svg += '<line class="baseline" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (top2 + h2) + '" y2="' + (top2 + h2) + '"/>';
    var last = data[n - 1];
    svg += '<circle class="end-dot" cx="' + cx(n - 1) + '" cy="' + y2(last.cumulative) + '" r="4"/>';
    svg += '<text class="end-label" x="' + (cx(n - 1) - 8) + '" y="' + (y2(last.cumulative) - 10) + '" text-anchor="end">유효 ' + fmtN(last.cumulative) + '명</text>';
    data.forEach(function (d, i) {
      var day = +d.date.slice(8, 10);
      if (i % every === 0 || i === n - 1) {
        svg += '<text class="axis-text" x="' + cx(i) + '" y="' + axisY + '" text-anchor="middle">' + (i === 0 ? '12/' + day : day) + '</text>';
      }
      if (d.note) {
        var mx = cx(i), my = top1 + h1 + 6;
        svg += '<path class="promo-mark" d="M' + (mx - 4) + ',' + (my + 6) + 'L' + mx + ',' + my + 'L' + (mx + 4) + ',' + (my + 6) + 'Z"/>';
      }
    });
    svg += '<g id="trendHover" style="display:none"><line class="crosshair" id="chX1" y1="' + top1 + '" y2="' + (top1 + h1) + '"/>' +
      '<line class="crosshair" id="chX2" y1="' + top2 + '" y2="' + (top2 + h2) + '"/><circle class="hover-dot" id="chDot" r="5"/></g>';
    data.forEach(function (d, i) {
      svg += '<rect class="hit" data-i="' + i + '" x="' + (padL + band * i) + '" y="' + top1 + '" width="' + band + '" height="' + (top2 + h2 - top1) + '"/>';
    });
    svg += '</svg>';

    box.innerHTML = svg + '<div class="tooltip" id="trendTip" hidden></div><p class="sr-only" id="trendLive" aria-live="polite"></p>' +
      '<p class="panel__hint">▲ 표시는 홍보 문자 발송일이에요.</p>';
    box.setAttribute('tabindex', '0');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-roledescription', '차트');
    box.setAttribute('aria-label', '일별 신청 추이. 12월 1일부터 ' + (+last.date.slice(8, 10)) + '일까지 ' + n + '일. 신청일 기준 신규 합계 ' + fmtN(S.summary.createdTotal) + '건, 현재 유효 신청 ' + fmtN(last.cumulative) + '명. 왼쪽·오른쪽 화살표 키로 날짜별 값을 들을 수 있어요.');
    trend.geo = { cx: cx, y2: y2, W: W, top1: top1 };
    if (trend.active >= 0 && trend.active < n) setTrendActive(trend.active, false);
  }

  function setTrendActive(i, announce) {
    var box = $('#trendChart'), data = S.summary.daily, g = trend.geo;
    trend.active = i;
    var hov = $('#trendHover'), tip = $('#trendTip');
    if (i < 0) { box.classList.remove('has-active'); hov.style.display = 'none'; tip.hidden = true; $all('.bar.is-active', box).forEach(function (b) { b.classList.remove('is-active'); }); return; }
    var d = data[i], x = g.cx(i);
    box.classList.add('has-active');
    $all('.bar', box).forEach(function (b) { b.classList.toggle('is-active', +b.getAttribute('data-i') === i); });
    hov.style.display = '';
    ['#chX1', '#chX2'].forEach(function (id) { var l = $(id); l.setAttribute('x1', x); l.setAttribute('x2', x); });
    var dot = $('#chDot'); dot.setAttribute('cx', x); dot.setAttribute('cy', g.y2(d.cumulative));
    tip.innerHTML = '<div class="tooltip__date">' + fmtDateKo(d.date) + '</div>' +
      '<div class="tooltip__row"><span class="tooltip__key">신규 신청</span><b class="tnum">' + fmtN(d.count) + '건</b></div>' +
      (d.canceled ? '<div class="tooltip__row"><span class="tooltip__key tooltip__key--none">취소 처리</span><b class="tnum">' + fmtN(d.canceled) + '건</b></div>' : '') +
      (d.restored ? '<div class="tooltip__row"><span class="tooltip__key tooltip__key--none">복원</span><b class="tnum">' + fmtN(d.restored) + '건</b></div>' : '') +
      '<div class="tooltip__row"><span class="tooltip__key tooltip__key--line">유효 누적</span><b class="tnum">' + fmtN(d.cumulative) + '명</b></div>' +
      (d.note ? '<div class="tooltip__note">' + esc(d.note) + '</div>' : '');
    tip.hidden = false;
    var scale = box.clientWidth / g.W, tw = tip.offsetWidth;
    var left = x * scale + 14;
    if (left + tw > box.clientWidth) left = x * scale - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = (g.top1 * scale) + 'px';
    if (announce) $('#trendLive').textContent = fmtDateKo(d.date) + ' 신규 ' + d.count + '건' + (d.canceled ? ', 취소 ' + d.canceled + '건' : '') + ', 유효 누적 ' + d.cumulative + '명' + (d.note ? ', ' + d.note : '');
  }

  function bindTrend() {
    var box = $('#trendChart');
    box.addEventListener('pointermove', function (e) {
      var t = e.target.closest && e.target.closest('[data-i]');
      if (t) { var i = +t.getAttribute('data-i'); if (i !== trend.active) setTrendActive(i, false); }
    });
    box.addEventListener('pointerleave', function () { if (document.activeElement !== box) setTrendActive(-1); });
    box.addEventListener('focus', function () { if (trend.active < 0) setTrendActive(S.summary.daily.length - 1, true); });
    box.addEventListener('blur', function () { setTrendActive(-1); });
    box.addEventListener('keydown', function (e) {
      var n = S.summary.daily.length, i = trend.active;
      var map = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 };
      if (e.key === 'Escape') { setTrendActive(-1); return; }
      if (!(e.key in map)) return;
      e.preventDefault();
      setTrendActive(Math.max(0, Math.min(n - 1, map[e.key])), true);
    });
    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawTrend, 120); });
    $('#btnTrendTable').addEventListener('click', function () {
      var t = $('#trendTable'), open = t.hidden;
      t.hidden = !open;
      this.setAttribute('aria-expanded', String(open));
      this.textContent = open ? '표 닫기' : '표로 보기';
    });
  }

  function renderTrendTable() {
    var s = S.summary;
    var rows = s.daily.map(function (d) {
      return '<tr><td>' + fmtDateKo(d.date) + '</td><td class="num">' + fmtN(d.count) + '</td><td class="num">' + fmtN(d.canceled) + '</td><td class="num">' + fmtN(d.restored) + '</td><td class="num">' + fmtN(d.cumulative) + '</td><td>' + esc(d.note || '') + '</td></tr>';
    }).join('');
    var foot = '<tr class="is-total"><th scope="row">합계</th><td class="num">' + fmtN(sumOf(s.daily, 'count')) + '</td><td class="num">' + fmtN(sumOf(s.daily, 'canceled')) + '</td><td class="num">' + fmtN(sumOf(s.daily, 'restored')) + '</td><td class="num">' + fmtN(s.total) + '</td><td></td></tr>';
    $('#trendTable').innerHTML = '<table class="data-table data-table--plain"><caption class="sr-only">일별 신청 추이 표. 신규는 신청일 기준, 취소·복원은 처리일 기준, 유효 누적은 그날 끝 기준.</caption>' +
      '<thead><tr><th scope="col">날짜</th><th scope="col" class="num">신규 (신청일)</th><th scope="col" class="num">취소 (처리일)</th><th scope="col" class="num">복원</th><th scope="col" class="num">유효 누적</th><th scope="col">비고</th></tr></thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table>';
  }

  /* ---------- 결과보고 통계 (CSV·엑셀 공용 표) ---------- */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 수식 주입 방지
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(aoa) { return aoa.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }
  function downloadBlob(content, name, type) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function downloadCsv(aoa, name) { downloadBlob('﻿' + toCsv(aoa), name, 'text/csv;charset=utf-8'); }

  function statsAoa(s, who) {
    var b = s.byDay, sc = sumOf(s.daily, 'canceled'), sr = sumOf(s.daily, 'restored');
    return [
      ['2026 JBNU-G 리서치페어 위크 사전 접수 통계'],
      ['기준 일시', fmtDT(s.generatedAt, true)],
      ['내보낸 사람', who || ''],
      ['용어', '유효 신청 = 지금 상태가 ‘신청’인 건(취소 제외). 양일 신청자는 22일·23일 예상 인원에 모두 더함.'],
      [],
      ['[신청 건수 맞춤] 기준: 신청일 기준 전체 접수', '건수', '비고'],
      ['신청일 기준 합계', s.createdTotal, '지금까지 접수된 모든 신청(취소 포함)'],
      ['유효 신청', s.total, '지금 상태가 신청'],
      ['취소', s.canceled, '지금 상태가 취소 · 아래 집계에서 제외'],
      ['맞춤', fmtN(s.createdTotal) + ' = 유효 ' + fmtN(s.total) + ' + 취소 ' + fmtN(s.canceled), s.createdTotal === s.total + s.canceled ? '일치' : '불일치 — 개발팀 확인 필요'],
      [],
      ['[참석일별 인원] 기준: 유효 신청(취소 제외)', '인원(명)', '비고'],
      ['22일만 (day1)', b.day1, DAY_LABEL.day1],
      ['23일만 (day2)', b.day2, DAY_LABEL.day2],
      ['양일 (both)', b.both, DAY_LABEL.both],
      ['합계', s.total, '= 유효 신청'],
      ['22일 예상 인원', s.perDate.d22, '22일만 + 양일'],
      ['23일 예상 인원', s.perDate.d23, '23일만 + 양일'],
      [],
      ['[유입 경로] 기준: 유효 신청(취소 제외)', '건수', '비고'],
      ['문자 (sms)', s.bySrc.sms, ''], ['포스터 QR (qr)', s.bySrc.qr, ''], ['홈페이지 (web)', s.bySrc.web, ''], ['직접 접속 (direct)', s.bySrc.direct, ''],
      ['합계', s.bySrc.sms + s.bySrc.qr + s.bySrc.web + s.bySrc.direct, '= 유효 신청'],
      [],
      ['[방문·신청 전환율] 기준: 방문 = 브라우저 탭 단위 첫 접속(개인 식별 없음) · 신청 = 그 경로로 접수된 전체 건(취소 포함) · 전환율 = 신청 ÷ 방문', '방문', '신청(건)', '전환율(%)'],
      ['문자 (sms)'].concat(convRow(s, 'sms')), ['포스터 QR (qr)'].concat(convRow(s, 'qr')),
      ['홈페이지 (web)'].concat(convRow(s, 'web')), ['직접 접속 (direct)'].concat(convRow(s, 'direct')),
      ['합계'].concat(convRow(s, 'total')),
      ['방문수 마지막 반영', s.visitsUpdatedAt ? fmtDT(s.visitsUpdatedAt, true) : '없음', '방문수는 약 1분마다 반영하는 근사치'],
      [],
      ['[일별 추이] 기준: 신규 = 신청일 기준(나중에 취소된 건 포함) · 취소·복원 = 처리일 기준 · 유효 누적 = 그날 끝 기준'],
      ['날짜', '신규 신청(건)', '취소 처리(건)', '복원(건)', '유효 누적(명)', '비고']
    ].concat(s.daily.map(function (d) { return [d.date, d.count, d.canceled, d.restored, d.cumulative, d.note || '']; }))
      .concat([['합계', sumOf(s.daily, 'count'), sc, sr, s.total, '신규 − 취소 처리 + 복원 = 유효 신청' + (sr ? ' (취소 처리 ' + sc + '건 중 ' + sr + '건 복원 → 지금 취소 ' + s.canceled + '건)' : '')]])
      .concat([[], ['[일별 방문·신청] 기준: 방문 = 접속한 날(KST) · 신청 = 신청일 기준(취소 포함)'], ['날짜', '방문', '신청(건)', '전환율(%)']])
      .concat((s.visitsDaily || []).map(function (d) { return [d.date, d.visits, d.submits, d.visits ? convPct(d.submits / d.visits) : '']; }));
  }
  // 경로별 [방문, 신청, 전환율(%)] — 방문 0 이면 전환율 빈칸
  function convRow(s, k) {
    var v = (s.visits || ZERO_SRC)[k], a = (s.visitSubmits || ZERO_SRC)[k], c = (s.conversion || {})[k];
    return [v, a, c == null ? '' : convPct(c)];
  }

  function exportStats(kind, btn) {
    if (kind === 'statsXlsx' && !window.XLSX) { toast('엑셀 도구를 불러오지 못했어요. 인터넷 연결을 확인하거나 통계 CSV로 내려받아 주세요.', true); return; }
    busy(btn, true);
    var s;
    API.adminGetSummary().then(function (sum) {
      s = S.summary = sum;
      return API.adminLogExport(kind, { label: '접수 통계 (전체 기준)' });
    }).then(function (res) {
      var aoa = statsAoa(s, res.entry.email);
      if (kind === 'stats') downloadCsv(aoa, 'RFW2026_접수통계_' + stamp() + '.csv');
      else {
        var wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 40 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 40 }];
        XLSX.utils.book_append_sheet(wb, ws, '접수 통계');
        XLSX.writeFile(wb, 'RFW2026_접수통계_' + stamp() + '.xlsx');
      }
      var msg = KIND_LABEL[kind] + '를 내려받았어요. 유효 ' + fmtN(s.total) + '명 · 취소 ' + fmtN(s.canceled) + '건 기준이에요.';
      if (currentView() === 'export') { $('#exportNotice').textContent = msg; loadExportLog(); renderExport(); }
      else { toast(msg + ' 내보내기 기록에 남겼어요.'); renderSummary(); }
    }).catch(function (e) { toast(errMsg(e), true); }).then(function () { busy(btn, false); });
  }

  /* =========================================================
     2. 신청자 목록
     ========================================================= */
  function apiDay() {
    var f = S.filter;
    if (f.day === 'd22') return f.includeBoth ? 'd22' : 'day1';
    if (f.day === 'd23') return f.includeBoth ? 'd23' : 'day2';
    return f.day;
  }
  function dayFilterText() {
    var f = S.filter;
    if (f.day === 'all') return '참석일 전체';
    if (f.day === 'both') return '양일 신청자만';
    var d = f.day === 'd22' ? '22일' : '23일';
    return f.includeBoth ? d + ' 참석자 (' + d + '만 + 양일)' : d + '만 신청자 (양일 제외)';
  }
  function filterLabel() {
    var f = S.filter, parts = ['상태 ' + STATUS_LABEL[f.status], dayFilterText()];
    if (f.q) parts.push('검색 "' + f.q + '"');
    return parts.join(' · ');
  }
  function apiFilter() { return { q: S.filter.q, day: apiDay(), status: S.filter.status, sort: S.filter.sort, label: filterLabel() }; }
  function isDefaultFilter() { var f = S.filter, d = DEFAULT_FILTER; return f.q === d.q && f.day === d.day && f.status === d.status; }

  function setRadios(root, attr, value) {
    var items = $all('[' + attr + ']', root), any = false;
    items.forEach(function (b) { var on = b.getAttribute(attr) === value; any = any || on; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    if (!any && items[0]) items[0].tabIndex = 0;
  }

  function syncFilterUI() {
    var f = S.filter, dated = f.day === 'd22' || f.day === 'd23';
    setRadios($('#statusSeg'), 'data-status', f.status);
    setRadios($('#dayChips'), 'data-day', f.day);
    $('[data-chip-label="d22"]').textContent = f.day === 'd22' && !f.includeBoth ? '22일만' : '22일';
    $('[data-chip-label="d23"]').textContent = f.day === 'd23' && !f.includeBoth ? '23일만' : '23일';
    $('#includeBothWrap').hidden = !dated;
    $('#includeBoth').checked = f.includeBoth;
    $('#includeBothText').textContent = (f.day === 'd23' ? '23일' : '22일') + ' 참석자에 양일 신청자 포함';
    var q = $('#q'); if (document.activeElement !== q && q.value.trim() !== f.q) q.value = f.q;
    $all('#listTable th[data-sort]').forEach(function (th) {
      var p = f.sort.split(':');
      if (th.getAttribute('data-sort') === p[0]) th.setAttribute('aria-sort', p[1] === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  function setFilter(patch) {
    Object.keys(patch).forEach(function (k) { S.filter[k] = patch[k]; });
    writeHash();
    if (currentView() === 'list') loadList(); else if (currentView() === 'export') renderExport();
  }
  function resetFilter() {
    S.filter = clone(DEFAULT_FILTER);
    $('#q').value = '';
    writeHash();
    if (currentView() === 'list') loadList(); else if (currentView() === 'export') renderExport();
  }

  function loadList(keepPage) {
    var req = ++S.listReq;
    syncFilterUI();
    $('#listWrap').setAttribute('aria-busy', 'true');
    return API.adminList(apiFilter()).then(function (res) {
      if (req !== S.listReq) return;
      S.rows = res.rows; S.listAsOf = res.generatedAt;
      if (!keepPage) { S.page = 1; S.rove = null; }
      S.page = Math.min(S.page, Math.max(1, Math.ceil(S.rows.length / PAGE_SIZE)));
      renderList();
    }).catch(function (e) {
      if (req !== S.listReq) return;
      $('#resultText').textContent = '목록을 불러오지 못했어요.';
      $('#listBody').innerHTML = '<tr class="list-empty"><td colspan="7"><p>' + esc(errMsg(e)) + '</p><button type="button" class="btn btn--outline btn--sm" data-retry-list>다시 불러오기</button></td></tr>';
      $('#pager').innerHTML = '';
    }).then(function () { $('#listWrap').removeAttribute('aria-busy'); });
  }

  function renderList() {
    var rows = S.rows, total = rows.length, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    var start = (S.page - 1) * PAGE_SIZE, slice = rows.slice(start, start + PAGE_SIZE);
    $('#resultText').innerHTML = '<b class="tnum">' + fmtN(total) + '</b>건 · ' + esc(filterLabel());
    $('#listAsOf').textContent = asOfText(S.listAsOf);
    var roveNo = S.rove && slice.some(function (r) { return r.receiptNo === S.rove; }) ? S.rove : (slice[0] && slice[0].receiptNo);
    $('#listBody').innerHTML = slice.length ? slice.map(function (r) {
      return '<tr data-no="' + esc(r.receiptNo) + '" class="' + (r.status === 'canceled' ? 'is-canceled' : '') + '">' +
        '<td data-col="no" class="cell-no">' + esc(r.receiptNo) + '</td>' +
        '<td data-col="created" class="tnum">' + fmtDT(r.createdAt) + '</td>' +
        '<td data-col="name" class="cell-name"><div class="name-wrap"><button type="button" class="row-open" tabindex="' + (r.receiptNo === roveNo ? 0 : -1) + '" title="' + esc(r.name) + '">' + esc(r.name) +
        '<span class="sr-only"> · ' + esc(r.receiptNo) + ' 상세 열기</span></button>' + (r.lang === 'en' ? '<span class="lang" title="영문 화면 신청">EN</span>' : '') + '</div></td>' +
        '<td data-col="org" class="cell-org" title="' + esc(r.org) + '">' + esc(r.org) + '</td>' +
        '<td data-col="phone" class="tnum">' + esc(r.phoneMasked) + '</td>' +
        '<td data-col="day"><span class="day-chip' + (r.day === 'both' ? ' day-chip--both' : '') + '" title="' + esc(DAY_LABEL[r.day]) + '">' + DAY_SHORT[r.day] + '</span></td>' +
        '<td data-col="status"><span class="st st--' + r.status + '">' + STATUS_LABEL[r.status] + '</span></td></tr>';
    }).join('') : '<tr class="list-empty"><td colspan="7"><p>조건에 맞는 신청이 없어요. 검색어나 필터를 바꿔 보세요.</p>' +
      (isDefaultFilter() ? '' : '<button type="button" class="btn btn--outline btn--sm" data-reset-filter>필터 초기화</button>') + '</td></tr>';

    var pager = $('#pager');
    if (total <= PAGE_SIZE) { pager.innerHTML = '<span class="pager__info tnum">' + fmtN(total) + '건 모두 표시</span>'; return; }
    var btns = [], from = Math.max(1, S.page - 2), to = Math.min(pages, from + 4);
    from = Math.max(1, to - 4);
    btns.push('<button type="button" data-page="' + (S.page - 1) + '"' + (S.page === 1 ? ' disabled' : '') + ' aria-label="이전 페이지">이전</button>');
    for (var p = from; p <= to; p++) btns.push('<button type="button" class="tnum" data-page="' + p + '"' + (p === S.page ? ' aria-current="page"' : '') + ' aria-label="' + p + '페이지">' + p + '</button>');
    btns.push('<button type="button" data-page="' + (S.page + 1) + '"' + (S.page === pages ? ' disabled' : '') + ' aria-label="다음 페이지">다음</button>');
    pager.innerHTML = '<span class="pager__info tnum">' + fmtN(start + 1) + '–' + fmtN(Math.min(total, start + PAGE_SIZE)) + ' / ' + fmtN(total) + '건</span><div class="pager__btns">' + btns.join('') + '</div>';
  }

  // 라디오 그룹: 클릭·화살표로 값 바꾸기 (목록 상태·참석일, 내보내기 빠른 선택 공용)
  function radioGroup(root, attr, onPick) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[' + attr + ']'); if (!b) return;
      onPick(b.getAttribute(attr));
    });
    root.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      var items = $all('[' + attr + ']', root), i = items.indexOf(document.activeElement);
      var next = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      onPick(next.getAttribute(attr)); next.focus();
    });
  }

  function moveRove(btn) {
    $all('#listBody .row-open').forEach(function (b) { b.tabIndex = b === btn ? 0 : -1; });
    S.rove = btn.closest('tr').getAttribute('data-no');
    btn.focus();
  }

  function bindList() {
    var qt;
    $('#q').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(qt);
      qt = setTimeout(function () { setFilter({ q: v.trim() }); }, 220);
    });
    radioGroup($('#statusSeg'), 'data-status', function (v) { setFilter({ status: v }); });
    radioGroup($('#dayChips'), 'data-day', function (v) { setFilter({ day: v }); });
    $('#includeBoth').addEventListener('change', function () { setFilter({ includeBoth: this.checked }); });
    $all('#listTable th[data-sort] button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.parentNode.getAttribute('data-sort'), p = S.filter.sort.split(':');
        var dir = p[0] === key ? (p[1] === 'asc' ? 'desc' : 'asc') : (key === 'createdAt' || key === 'receiptNo' ? 'desc' : 'asc');
        setFilter({ sort: key + ':' + dir });
      });
    });
    $('#listBody').addEventListener('click', function (e) {
      if (e.target.closest('[data-reset-filter]')) { resetFilter(); $('#q').focus(); return; }
      if (e.target.closest('[data-retry-list]')) { loadList(true); return; }
      var tr = e.target.closest('tr[data-no]'); if (!tr) return;
      var btn = $('.row-open', tr); moveRove(btn);
      openDrawer(tr.getAttribute('data-no'), btn);
    });
    // 행 이동: 탭 정지는 한 곳(현재 행의 이름 버튼), 위아래 화살표·Home·End 로 이동, Enter·Space 로 열기(버튼 기본 동작)
    $('#listBody').addEventListener('keydown', function (e) {
      var btn = e.target.closest('.row-open'); if (!btn) return;
      var list = $all('#listBody .row-open'), i = list.indexOf(btn), to = -1;
      if (e.key === 'ArrowDown') to = Math.min(list.length - 1, i + 1);
      else if (e.key === 'ArrowUp') to = Math.max(0, i - 1);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = list.length - 1;
      if (to < 0) return;
      e.preventDefault(); moveRove(list[to]);
    });
    $('#pager').addEventListener('click', function (e) {
      var b = e.target.closest('[data-page]'); if (!b || b.disabled) return;
      S.page = +b.getAttribute('data-page'); S.rove = null; renderList();
      $('#listWrap').scrollIntoView({ block: 'start' });
      var first = $('#listBody .row-open'); first && first.focus({ preventScroll: true });
    });
    // 단축키: / 로 검색칸 (입력 중이 아닐 때)
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || currentView() !== 'list' || !$('#drawer').hidden) return;
      var t = e.target; if (t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault(); $('#q').focus(); $('#q').select();
    });
  }

  /* ---------- 상세 서랍 ---------- */
  function rowByNo(no) { for (var i = 0; i < S.rows.length; i++) if (S.rows[i].receiptNo === no) return S.rows[i]; return null; }

  function openDrawer(no, returnEl) {
    var r = rowByNo(no); if (!r) return;
    S.drawer = clone(r);
    S.drawerReturn = returnEl || document.activeElement;
    $('#scrim').hidden = false; $('#drawer').hidden = false; $('#discardBox').hidden = true;
    document.body.style.overflow = 'hidden';
    renderDrawer();
    $('#drawerClose').focus();
  }
  function drawerDirty() { return !!(S.drawer && S.drawer.status !== 'canceled' && $('#editForm') && Object.keys(editPatch()).length); }
  // 닫기 요청: 저장하지 않은 수정이 있으면 서랍 안에서 먼저 묻는다
  function requestCloseDrawer() {
    if (drawerDirty()) { $('#discardBox').hidden = false; $('#btnKeepEditing').focus(); return; }
    closeDrawer();
  }
  function closeDrawer() {
    $('#scrim').hidden = true; $('#drawer').hidden = true; $('#discardBox').hidden = true; document.body.style.overflow = '';
    var no = S.drawer && S.drawer.receiptNo; S.drawer = null;
    var back = no && $('#listBody tr[data-no="' + no + '"] .row-open');
    var target = back || S.drawerReturn;
    target && target.focus && target.focus();
  }

  function renderDrawer() {
    var r = S.drawer, canceled = r.status === 'canceled';
    $('#drawerNo').textContent = r.receiptNo;
    var dayRadios = ['day1', 'day2', 'both'].map(function (k) {
      return '<label class="radio"><input type="radio" name="d-day" value="' + k + '"' + (r.day === k ? ' checked' : '') + (canceled ? ' disabled' : '') + '>' + esc(DAY_LABEL[k]) + '</label>';
    }).join('');
    $('#drawerBody').innerHTML =
      '<section aria-labelledby="dh-info"><h3 id="dh-info">신청 정보</h3><dl class="dl">' +
      '<dt>상태</dt><dd><span class="st st--' + r.status + '">' + STATUS_LABEL[r.status] + '</span></dd>' +
      '<dt>신청일시</dt><dd class="tnum">' + fmtDT(r.createdAt, true) + '</dd>' +
      '<dt>수정일시</dt><dd class="tnum">' + fmtDT(r.updatedAt, true) + '</dd>' +
      '<dt>참석일</dt><dd>' + esc(DAY_LABEL[r.day]) + '</dd>' +
      '<dt>휴대전화번호</dt><dd class="tnum">' + esc(r.phoneMasked) + '</dd>' +
      '<dt>개인정보 동의</dt><dd class="tnum">' + fmtDT(r.consentAt, true) + '</dd>' +
      '<dt>신청 화면</dt><dd>' + (r.lang === 'en' ? '영문' : '국문') + ' · 유입 ' + SRC_LABEL[r.src] + '</dd></dl></section>' +

      '<section aria-labelledby="dh-edit"><h3 id="dh-edit">신청 내용 수정</h3>' +
      (canceled ? '<p class="lock-note">취소된 신청이에요. 아래에서 복원한 뒤 수정할 수 있어요.</p>' : '') +
      '<form class="form-stack" id="editForm" novalidate>' +
      '<div class="field"><label for="d-name">이름</label><input id="d-name" type="text" maxlength="40" autocomplete="off" value="' + esc(r.name) + '"' + (canceled ? ' disabled' : '') + ' aria-describedby="d-name-err"><p class="field__error" id="d-name-err" hidden>이름을 입력해 주세요.</p></div>' +
      '<div class="field"><label for="d-org">소속</label><input id="d-org" type="text" maxlength="60" autocomplete="off" value="' + esc(r.org) + '"' + (canceled ? ' disabled' : '') + ' aria-describedby="d-org-err"><p class="field__error" id="d-org-err" hidden>소속을 입력해 주세요.</p></div>' +
      '<div class="field"><label for="d-phone">휴대전화번호 (바꿀 때만 입력)</label><input id="d-phone" type="tel" inputmode="numeric" autocomplete="off" placeholder="현재 ' + esc(r.phoneMasked) + '"' + (canceled ? ' disabled' : '') + ' aria-describedby="d-phone-help d-phone-err">' +
      '<p class="field__help" id="d-phone-help">목록에서는 전체 번호를 보여 주지 않아요. 새 번호를 넣으면 바뀌어요.</p><p class="field__error" id="d-phone-err" hidden>휴대전화번호를 확인해 주세요.</p></div>' +
      '<fieldset class="radio-list"><legend>참석일</legend>' + dayRadios + '</fieldset>' +
      '<div class="form-actions"><button type="submit" class="btn btn--outline" id="btnEditSave" disabled' + (canceled ? ' hidden' : '') + '>수정 저장</button><p class="form-msg" id="editMsg" role="status"></p></div>' +
      '</form></section>' +

      '<section class="danger-zone" aria-labelledby="dh-status"><h3 id="dh-status">' + (canceled ? '신청 복원' : '신청 취소') + '</h3>' +
      (canceled
        ? '<p class="panel__hint">복원하면 다시 집계에 들어가요. 정원이 찼으면 복원할 수 없어요.</p><button type="button" class="btn btn--outline" id="btnAskStatus" aria-expanded="false" aria-controls="confirmBox">신청 복원</button>' +
        '<div class="confirm confirm--restore" id="confirmBox" hidden><p>' + esc(r.name) + ' 님의 신청을 복원할까요?</p><div class="form-actions"><button type="button" class="btn btn--ghost" id="btnCancelAsk">그대로 두기</button><button type="button" class="btn btn--outline" id="btnDoStatus">복원하기</button></div></div>'
        : '<p class="panel__hint">취소한 신청은 집계·명단에서 빠지고, 이력에 남아요. 참가자에게 자동으로 문자가 가지는 않아요.</p><button type="button" class="btn btn--danger" id="btnAskStatus" aria-expanded="false" aria-controls="confirmBox">신청 취소</button>' +
        '<div class="confirm" id="confirmBox" hidden><p><strong>' + esc(r.name) + '</strong> 님의 신청(' + esc(r.receiptNo) + ')을 취소할까요? 나중에 복원할 수 있어요.</p><div class="form-actions"><button type="button" class="btn btn--ghost" id="btnCancelAsk">취소 안 함</button><button type="button" class="btn btn--danger-solid" id="btnDoStatus">취소 처리</button></div></div>') +
      '<p class="form-msg is-error" id="statusMsg" role="alert" hidden></p></section>' +

      '<section aria-labelledby="dh-hist"><h3 id="dh-hist">변경 이력</h3><div id="histBox"><p class="panel__hint">불러오는 중…</p></div></section>';

    bindDrawer();
    loadHistory(r.receiptNo);
  }

  function editPatch() {
    var r = S.drawer, p = {};
    var name = $('#d-name').value.trim(), org = $('#d-org').value.trim(), phone = digits($('#d-phone').value);
    var dayEl = $('input[name="d-day"]:checked'), day = dayEl && dayEl.value;
    if (name !== r.name) p.name = name;
    if (org !== r.org) p.org = org;
    if (phone) p.phone = phone;
    if (day && day !== r.day) p.day = day;
    return p;
  }

  function bindDrawer() {
    var form = $('#editForm');
    form.addEventListener('input', function (e) {
      if (e.target.id === 'd-phone') e.target.value = hyphenPhone(e.target.value);
      var dirty = Object.keys(editPatch()).length > 0;
      $('#btnEditSave').disabled = !dirty;
      $('#editMsg').textContent = dirty ? '저장하지 않은 수정 내용이 있어요.' : '';
      $('#editMsg').classList.remove('is-error');
      if (!dirty) $('#discardBox').hidden = true;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var p = editPatch(), errs = {};
      if ('name' in p && (!p.name || p.name.length > 40)) errs.name = 1;
      if ('org' in p && (!p.org || p.org.length > 60)) errs.org = 1;
      if ('phone' in p && !/^01[016789]\d{7,8}$/.test(p.phone)) errs.phone = 1;
      showFieldErrors(errs);
      if (Object.keys(errs).length) return;
      var btn = $('#btnEditSave'); busy(btn, true);
      API.adminUpdate(S.drawer.receiptNo, p).then(function (row) {
        afterChange(row, '수정 내용을 저장했어요.');
      }).catch(function (err) {
        if (err.fields) showFieldErrors(err.fields);
        var m = $('#editMsg'); m.textContent = errMsg(err); m.classList.add('is-error');
      }).then(function () { busy(btn, false); });
    });
    var ask = $('#btnAskStatus'), box = $('#confirmBox');
    // 확인 상자를 열면 안전한 쪽(취소 안 함 / 그대로 두기)에 먼저 포커스
    ask.addEventListener('click', function () { box.hidden = false; ask.setAttribute('aria-expanded', 'true'); ask.hidden = true; $('#btnCancelAsk').focus(); });
    $('#btnCancelAsk').addEventListener('click', function () { box.hidden = true; ask.hidden = false; ask.setAttribute('aria-expanded', 'false'); ask.focus(); });
    $('#btnDoStatus').addEventListener('click', function () {
      var btn = this, canceled = S.drawer.status === 'canceled';
      busy(btn, true);
      (canceled ? API.adminRestore : API.adminCancel)(S.drawer.receiptNo).then(function (row) {
        afterChange(row, canceled ? '신청을 복원했어요.' : '신청을 취소했어요.');
        $('#btnAskStatus') && $('#btnAskStatus').focus();
      }).catch(function (err) {
        busy(btn, false);
        var m = $('#statusMsg'); m.hidden = false; m.textContent = errMsg(err);
      });
    });
  }

  function showFieldErrors(errs) {
    ['name', 'org', 'phone'].forEach(function (k) {
      var on = !!errs[k];
      $('#d-' + k).setAttribute('aria-invalid', String(on));
      $('#d-' + k + '-err').hidden = !on;
    });
    var first = ['name', 'org', 'phone'].filter(function (k) { return errs[k]; })[0];
    if (first) $('#d-' + first).focus();
  }

  function afterChange(row, msg) {
    for (var i = 0; i < S.rows.length; i++) if (S.rows[i].receiptNo === row.receiptNo) S.rows[i] = row;
    S.drawer = clone(row);
    renderList();
    renderDrawer();
    toast(msg);
    S.summary = null; // 다음에 접수 현황을 열 때 다시 집계
    API.adminGetSummary().then(function (s) { S.summary = s; if (currentView() === 'dashboard') renderSummary(); }).catch(function () {});
  }

  var HIST_FIELD = { name: '이름', org: '소속', phone: '휴대전화번호', day: '참석일', status: '상태' };
  function histVal(k, v) { return k === 'day' ? DAY_SHORT[v] || v : k === 'status' ? STATUS_LABEL[v] || v : v; }
  function loadHistory(no) {
    API.adminHistory(no).then(function (list) {
      if (!S.drawer || S.drawer.receiptNo !== no) return;
      var created = '<li><div><span class="timeline__kind">신청</span><span class="timeline__meta tnum">' + fmtDT(S.drawer.createdAt, true) + ' · 본인</span></div></li>';
      $('#histBox').innerHTML = '<ol class="timeline">' + list.map(function (h) {
        var diffs = Object.keys(h.after || {}).filter(function (k) { return k !== 'status'; }).map(function (k) {
          return '<div class="timeline__diff">' + HIST_FIELD[k] + ': <del>' + esc(histVal(k, h.before[k])) + '</del> → ' + esc(histVal(k, h.after[k])) + '</div>';
        }).join('');
        return '<li><div><span class="timeline__kind">' + esc(h.kind) + '</span><span class="timeline__meta tnum">' + fmtDT(h.at, true) + ' · ' + esc(h.by) + '</span></div>' + diffs + '</li>';
      }).join('') + created + '</ol>' + (list.length ? '' : '<p class="panel__hint">신청 후 바뀐 내용이 없어요.</p>');
    }).catch(function (e) {
      if (S.drawer && S.drawer.receiptNo === no) $('#histBox').innerHTML = '<p class="form-msg is-error">' + esc(errMsg(e)) + '</p>';
    });
  }

  function bindDrawerShell() {
    $('#drawerClose').addEventListener('click', requestCloseDrawer);
    $('#scrim').addEventListener('click', requestCloseDrawer);
    $('#btnKeepEditing').addEventListener('click', function () { $('#discardBox').hidden = true; var f = $('#d-name'); f && f.focus(); });
    $('#btnDiscardClose').addEventListener('click', closeDrawer);
    $('#drawer').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!$('#discardBox').hidden) { $('#btnKeepEditing').click(); return; }
        requestCloseDrawer(); return;
      }
      if (e.key !== 'Tab') return;
      var f = $all('button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex="0"]', $('#drawer')).filter(function (el) { return el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* =========================================================
     3. 내보내기
     ========================================================= */
  var COLS = ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '참석일(저장값)', '언어', '유입경로', '개인정보동의시각'];
  function rowAoa(r) {
    return [r.receiptNo, fmtDT(r.createdAt, true), fmtDT(r.updatedAt, true), STATUS_LABEL[r.status], r.name, r.org, r.phone,
      DAY_LABEL[r.day], r.day, r.lang === 'en' ? '영문' : '국문', SRC_LABEL[r.src], fmtDT(r.consentAt, true)];
  }
  // 명찰 시트: 22일 = day1 + both, 23일 = day2 + both (취소 제외), 이름 가나다순
  function badgeSplit(rows) {
    var act = rows.filter(function (r) { return r.status === 'active'; });
    return {
      all: act,
      d22: act.filter(function (r) { return r.day !== 'day2'; }),
      d23: act.filter(function (r) { return r.day !== 'day1'; })
    };
  }

  function setCard(kind, countHtml, why) {
    $('#cnt-' + kind).innerHTML = countHtml;
    var w = $('#why-' + kind); w.hidden = !why; w.textContent = why || '';
    $all('[data-export]').forEach(function (b) {
      var k = b.getAttribute('data-export');
      if (k === kind || (kind === 'stats' && k === 'statsXlsx')) b.disabled = !!why;
    });
  }

  function renderExport() {
    var f = S.filter, req = ++S.exportReq;
    syncFilterUI();
    setRadios($('#exportDays'), 'data-xday', f.day);
    var tags = ['<span class="tag' + (f.status !== 'active' ? ' tag--warn' : '') + '">상태: ' + STATUS_LABEL[f.status] + '</span>', '<span class="tag">' + esc(dayFilterText()) + '</span>'];
    if (f.q) tags.push('<span class="tag tag--warn">검색어: ' + esc(f.q) + '</span>');
    var stale = f.q || f.status !== 'active';
    $('#filterSummary').innerHTML = tags.join('') + (stale ? '<span class="filter-summary__warn">검색어나 상태 조건이 남아 있어요. 필요 없으면 ‘조건 초기화’를 눌러 주세요.</span>' : '');
    $('#btnResetFilter').disabled = isDefaultFilter() && f.includeBoth;
    $('#cols-xlsx').textContent = '열 ' + COLS.length + '개: ' + COLS.join(' · ') + '. 휴대전화번호는 전체 번호예요. 두 번째 시트에 내보낸 조건과 담당자를 적어요.';
    ['xlsx', 'csv', 'badge', 'stats'].forEach(function (k) { $('#cnt-' + k).textContent = '세는 중…'; });
    $all('[data-export]').forEach(function (b) { b.disabled = true; });

    API.adminList(apiFilter()).then(function (res) {
      if (req !== S.exportReq) return;
      $('#exportAsOf').textContent = asOfText(res.generatedAt);
      var n = res.rows.length, bs = badgeSplit(res.rows), none = n ? '' : '현재 조건에 맞는 신청이 없어 내려받을 수 없어요. 조건을 바꾸거나 초기화해 주세요.';
      setCard('xlsx', '<b>' + fmtN(n) + '</b>건', none);
      setCard('csv', '<b>' + fmtN(n) + '</b>건', none);
      setCard('badge', '<b>' + fmtN(bs.all.length) + '</b>명 <span class="export-card__sub">취소 제외 · 22일 시트 ' + fmtN(bs.d22.length) + ' · 23일 시트 ' + fmtN(bs.d23.length) + '</span>',
        bs.all.length ? '' : (n ? '현재 조건의 ' + fmtN(n) + '건이 모두 취소 건이라 명찰에 넣을 사람이 없어요. 상태를 ‘신청’으로 바꿔 주세요.' : none));
    }).catch(function (e) {
      if (req !== S.exportReq) return;
      ['xlsx', 'csv', 'badge'].forEach(function (k) { setCard(k, '-', '건수를 세지 못했어요. ' + errMsg(e)); });
    });
    API.adminGetSummary().then(function (s) {
      if (req !== S.exportReq) return;
      S.summary = s;
      setCard('stats', '유효 <b>' + fmtN(s.total) + '</b>명 <span class="export-card__sub">취소 ' + fmtN(s.canceled) + ' · 신청 합계 ' + fmtN(s.createdTotal) + '</span>', s.createdTotal ? '' : '아직 신청이 없어 통계를 만들 수 없어요.');
    }).catch(function (e) {
      if (req !== S.exportReq) return;
      setCard('stats', '-', '집계를 불러오지 못했어요. ' + errMsg(e));
    });
  }

  function loadExportLog() {
    API.adminExportLog().then(function (list) {
      $('#exportLog').innerHTML = list.length ? list.map(function (l) {
        var stats = l.kind === 'stats' || l.kind === 'statsXlsx';
        return '<tr><td class="tnum">' + fmtDT(l.at, true) + '</td><td>' + esc(l.name) + ' <span class="timeline__meta">' + esc(l.email) + '</span></td><td>' + esc(KIND_LABEL[l.kind] || l.kind) + '</td><td>' + esc(l.filterText) + '</td><td class="num">' + (stats ? '-' : fmtN(l.count)) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">아직 내보낸 기록이 없어요.</td></tr>';
    }).catch(function (e) { $('#exportLog').innerHTML = '<tr><td colspan="5" class="empty">' + esc(errMsg(e)) + '</td></tr>'; });
  }

  function doExport(kind, btn) {
    if (kind === 'stats' || kind === 'statsXlsx') { exportStats(kind, btn); return; }
    if ((kind === 'xlsx' || kind === 'badge') && !window.XLSX) {
      toast('엑셀 도구를 불러오지 못했어요. 인터넷 연결을 확인하거나 CSV로 내려받아 주세요.', true); return;
    }
    busy(btn, true);
    var f = apiFilter();
    API.adminLogExport(kind, f).then(function (res) {
      var rows = res.rows, done;
      var meta = [['행사', '2026 JBNU-G 리서치페어 위크'], ['내보낸 일시', fmtDT(res.entry.at, true)], ['내보낸 사람', res.entry.email], ['조건', f.label]];
      if (kind === 'csv') {
        downloadCsv([COLS].concat(rows.map(rowAoa)), 'RFW2026_신청자_' + stamp() + '.csv');
        done = fmtN(rows.length) + '건';
      } else if (kind === 'xlsx') {
        var wb = XLSX.utils.book_new();
        var ws = XLSX.utils.aoa_to_sheet([COLS].concat(rows.map(rowAoa)));
        ws['!cols'] = [16, 17, 17, 6, 12, 32, 15, 34, 10, 6, 10, 17].map(function (w) { return { wch: w }; });
        ws['!autofilter'] = { ref: 'A1:' + String.fromCharCode(64 + COLS.length) + (rows.length + 1) };
        XLSX.utils.book_append_sheet(wb, ws, '신청자');
        var ws2 = XLSX.utils.aoa_to_sheet(meta.concat([['건수', rows.length]])); ws2['!cols'] = [{ wch: 12 }, { wch: 60 }];
        XLSX.utils.book_append_sheet(wb, ws2, '내보내기 정보');
        XLSX.writeFile(wb, 'RFW2026_신청자_' + stamp() + '.xlsx');
        done = fmtN(rows.length) + '건';
      } else if (kind === 'badge') {
        var bs = badgeSplit(rows), byName = function (a, b) { return a.name.localeCompare(b.name, 'ko'); };
        var wb2 = XLSX.utils.book_new();
        [['22일', bs.d22], ['23일', bs.d23]].forEach(function (x) {
          if (!x[1].length) return;
          var list = x[1].slice().sort(byName);
          var sh = XLSX.utils.aoa_to_sheet([['이름', '소속', '참석일']].concat(list.map(function (r) { return [r.name, r.org, DAY_SHORT[r.day]]; })));
          sh['!cols'] = [{ wch: 18 }, { wch: 40 }, { wch: 8 }];
          XLSX.utils.book_append_sheet(wb2, sh, x[0] + ' 명찰');
        });
        var ws4 = XLSX.utils.aoa_to_sheet(meta.concat([['명단 인원', bs.all.length + '명 (취소 제외)'], ['22일 시트', bs.d22.length + '명 (22일만 + 양일)'], ['23일 시트', bs.d23.length + '명 (23일만 + 양일)'], ['참고', '양일 신청자는 두 시트에 모두 들어 있어요.']]));
        ws4['!cols'] = [{ wch: 12 }, { wch: 60 }];
        XLSX.utils.book_append_sheet(wb2, ws4, '내보내기 정보');
        XLSX.writeFile(wb2, 'RFW2026_명찰_' + stamp() + '.xlsx');
        done = fmtN(bs.all.length) + '명(22일 시트 ' + fmtN(bs.d22.length) + ' · 23일 시트 ' + fmtN(bs.d23.length) + ')';
      }
      $('#exportNotice').textContent = KIND_LABEL[kind] + ' 파일로 ' + done + '을 내려받았어요. (' + fmtDT(res.entry.at, true) + ')';
      loadExportLog();
    }).catch(function (e) { toast(errMsg(e), true); }).then(function () { busy(btn, false); });
  }

  function bindExport() {
    $all('[data-export]').forEach(function (b) { b.addEventListener('click', function () { doExport(b.getAttribute('data-export'), b); }); });
    radioGroup($('#exportDays'), 'data-xday', function (v) { setFilter({ day: v, includeBoth: true }); });
    $('#btnResetFilter').addEventListener('click', function () { resetFilter(); toast('내보내기 조건을 초기화했어요. 상태 신청 · 참석일 전체예요.'); });
  }

  /* =========================================================
     4. 설정
     ========================================================= */
  function loadConfig() {
    return Promise.all([API.adminGetConfig(), S.summary ? Promise.resolve(S.summary) : API.adminGetSummary().catch(function () { return null; })]).then(function (res) {
      if (res[1]) S.summary = res[1];
      S.config = res[0]; S.draft = clone(res[0]);
      renderSettings(); updateDirty();
    }).catch(function (e) {
      $('#settingsBody').innerHTML = '<div class="load-error" role="alert"><p><strong>설정을 불러오지 못했어요.</strong> ' + esc(errMsg(e)) + '</p><button type="button" class="btn btn--outline" id="btnRetryConfig">다시 불러오기</button></div>';
      $('#btnRetryConfig').addEventListener('click', loadConfig);
    });
  }
  function dayCfg(cfg, v) { for (var i = 0; i < cfg.days.length; i++) if (cfg.days[i].value === v) return cfg.days[i]; return {}; }

  function loadSettingsLogs() {
    function who(l) { return esc(l.name) + ' <span class="log-list__email">' + esc(l.email) + '</span>'; }
    API.adminConfigLog().then(function (list) {
      $('#cfgLog').innerHTML = list.length ? list.slice(0, 20).map(function (l) {
        return '<li><div class="log-list__meta"><span class="tnum">' + fmtDT(l.at, true) + '</span> · ' + who(l) + '</div><ul class="log-list__changes">' +
          (l.changes || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></li>';
      }).join('') : '<li class="log-list__empty">아직 바꾼 기록이 없어요.</li>';
    }).catch(function (e) { $('#cfgLog').innerHTML = '<li class="log-list__empty">' + esc(errMsg(e)) + '</li>'; });
    API.adminAccessLog().then(function (list) {
      $('#accessLog').innerHTML = list.length ? list.slice(0, 20).map(function (l) {
        return '<li><div class="log-list__meta"><span class="tnum">' + fmtDT(l.at, true) + '</span> · ' + who(l) + '</div></li>';
      }).join('') : '<li class="log-list__empty">기록이 없어요.</li>';
    }).catch(function (e) { $('#accessLog').innerHTML = '<li class="log-list__empty">' + esc(errMsg(e)) + '</li>'; });
  }

  // 태그라인: [강조] 표기 ↔ 세그먼트 배열
  function taglineToText(line) { return (line || []).map(function (s) { return s.em ? '[' + s.t + ']' : s.t; }).join(''); }
  function textToTagline(text) {
    var out = [], re = /\[([^\]]*)\]|([^\[]+)/g, m;
    while ((m = re.exec(text))) { if (m[1] != null && m[1] !== '') out.push({ t: m[1], em: true }); else if (m[2]) out.push({ t: m[2] }); }
    return out;
  }
  function taglinePreview(line) { return (line || []).map(function (s) { return s.em ? '<em>' + esc(s.t) + '</em>' : esc(s.t); }).join(''); }
  function toLocalInput(iso) { return iso ? iso.slice(0, 16) : ''; }

  function sw(id, checked, label, bind) {
    return '<label class="switch"><input type="checkbox" id="' + id + '" data-bind="' + bind + '"' + (checked ? ' checked' : '') + '><span class="switch__track" aria-hidden="true"></span><span>' + label + '</span></label>';
  }

  function renderSettings() {
    var d = S.draft, s = S.summary;
    var c1 = dayCfg(d, 'day1').capacity, c2 = dayCfg(d, 'day2').capacity;
    var lines = d.tagline.ko || [];
    $('#settingsBody').innerHTML =
      '<section class="set-section" aria-labelledby="sh-open"><header><h2 id="sh-open">접수 상태</h2><p>닫으면 접수 페이지의 폼 자리에 \'사전 접수가 끝났어요. 현장 등록은 행사 당일 가능합니다\' 안내가 나와요. 마감 일시가 지나도 자동으로 닫혀요.</p></header>' +
      '<div class="set-row"><div class="field">' + sw('s-open', d.open, '<strong>접수 받기</strong> (켜면 접수 중)', 'open') + '</div>' +
      '<div class="field"><label for="s-close">사전 접수 마감 일시 (한국 시간)</label><input id="s-close" type="datetime-local" data-bind="closeAt" value="' + toLocalInput(d.closeAt) + '"><p class="field__help">지금 저장된 값: ' + esc(fmtCloseAt(S.config.closeAt)) + '</p></div></div></section>' +

      '<section class="set-section" aria-labelledby="sh-cap"><header><h2 id="sh-cap">날짜별 정원</h2><p>비워 두면 정원 없음. 양일 신청자는 두 날짜 정원에 모두 들어가요. 남은 자리가 0이 되면 그 날짜가 포함된 선택지(양일 포함)가 마감돼요.</p></header>' +
      '<div class="set-row">' +
      capField('s-cap1', '22일(화) 정원', c1, 'day1', s ? s.perDate.d22 : null) +
      capField('s-cap2', '23일(수) 정원', c2, 'day2', s ? s.perDate.d23 : null) + '</div></section>' +

      '<section class="set-section" aria-labelledby="sh-prog"><header><h2 id="sh-prog">세부 프로그램 안내</h2><p>접수 페이지의 이틀 프로그램 표에 그대로 나와요. 시간·장소·연사가 정해지면 여기서 고쳐 주세요. 시간을 비워 두면 접수 페이지에 시간이 나오지 않아요. 강조한 행은 하늘색 글씨로 표시돼요.</p></header>' +
      '<div class="day-tabs" role="tablist" aria-label="프로그램 날짜">' +
      ['day1', 'day2'].map(function (k) { return '<button type="button" role="tab" id="pt-' + k + '" aria-controls="progPanel" aria-selected="' + (S.progDay === k) + '" tabindex="' + (S.progDay === k ? 0 : -1) + '" data-prog-day="' + k + '">' + DAY_SHORT[k] + ' · ' + esc((d.program[k].ko || {}).title || '') + '</button>'; }).join('') +
      '</div><div id="progPanel" role="tabpanel" aria-labelledby="pt-' + S.progDay + '"></div>' +
      '<div class="set-row--switches set-row">' + sw('s-speakers', d.showSpeakers, '<strong>연사 이름 공개</strong> (끄면 연사 칸이 접수 페이지에 나오지 않아요)', 'showSpeakers') + '</div></section>' +

      '<section class="set-section" aria-labelledby="sh-tag"><header><h2 id="sh-tag">태그라인</h2><p>(안) 고객사 확정 필요. 강조할 낱말은 대괄호로 감싸 주세요. 예) [4단계]의 [성과]</p></header>' +
      '<div class="set-row">' +
      '<div class="field"><label for="s-tag1">국문 첫째 줄</label><input id="s-tag1" type="text" data-bind="tagline.ko.0" value="' + esc(taglineToText(lines[0])) + '"></div>' +
      '<div class="field"><label for="s-tag2">국문 둘째 줄</label><input id="s-tag2" type="text" data-bind="tagline.ko.1" value="' + esc(taglineToText(lines[1])) + '"></div>' +
      '<div class="field"><label for="s-tagen">영문 보조 문구</label><input id="s-tagen" type="text" data-bind="tagline.en" value="' + esc(d.tagline.en || '') + '"></div></div>' +
      '<div class="preview"><span class="field__label">미리보기 (접수 페이지와 같은 강조)</span><p class="preview-tagline" id="tagPreview"></p></div></section>' +

      '<section class="set-section" aria-labelledby="sh-contact"><header><h2 id="sh-contact">문의처 (운영사무국)</h2><p>비어 있으면 접수 페이지 하단에 \'추후 안내\'로 나와요.</p></header>' +
      '<div class="set-row"><div class="field"><label for="s-phone">전화</label><input id="s-phone" type="tel" data-bind="contact.phone" placeholder="예) 063-000-0000" value="' + esc(d.contact.phone || '') + '"></div>' +
      '<div class="field"><label for="s-email">이메일</label><input id="s-email" type="email" data-bind="contact.email" placeholder="예) rfw@example.com" value="' + esc(d.contact.email || '') + '" aria-describedby="s-email-err"><p class="field__error" id="s-email-err" hidden>이메일 형식을 확인해 주세요.</p></div></div></section>' +

      // 원문 (읽기 전용) — 카드 안 카드 대신 섹션 안의 평범한 정의 목록
      '<section class="set-section" aria-labelledby="sh-orig"><header><h2 id="sh-orig">소개 문단·신청서 문구</h2>' +
      '<p class="lock-line"><span class="lock-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>읽기 전용</span> 고객사 양식 원문이라 여기서 바꿀 수 없어요. 바꿔야 하면 운영사무국을 거쳐 고객사 승인을 받은 뒤 개발팀에 요청해 주세요.</p></header>' +
      '<dl class="readonly-list">' +
      '<dt>제목</dt><dd>' + esc(ORIGINAL.title) + '</dd>' +
      '<dt>소개 문단</dt><dd>' + esc(ORIGINAL.intro) + '</dd>' +
      '<dt>일정·장소</dt><dd>' + esc(ORIGINAL.when) + '</dd>' +
      '<dt>폼 안내</dt><dd>' + esc(ORIGINAL.lead) + '</dd>' +
      ORIGINAL.fields.map(function (f, i) { return '<dt>' + (i + 1) + '. ' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') +
      '<dt>참석일 선택지</dt><dd>' + ['day1', 'day2', 'both'].map(function (k) { return esc(DAY_LABEL[k]); }).join('<br>') + '</dd>' +
      '</dl></section>';

    renderProgram();
    renderTagPreview();
  }

  function capField(id, label, val, day, current) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="number" min="0" step="1" inputmode="numeric" data-bind="cap.' + day + '" placeholder="정원 없음" value="' + (val == null ? '' : val) + '" aria-describedby="' + id + '-help ' + id + '-warn">' +
      '<p class="field__help" id="' + id + '-help">' + (current != null ? '현재 예상 인원 ' + fmtN(current) + '명' : '') + '</p><p class="field__warn" id="' + id + '-warn" hidden></p></div>';
  }

  function renderTagPreview() {
    var t = S.draft.tagline;
    $('#tagPreview').innerHTML = taglinePreview(t.ko[0]) + '<br>' + taglinePreview(t.ko[1]) + (t.en ? '<small>' + esc(t.en) + '</small>' : '');
  }

  function renderProgram(focusSel) {
    var day = S.progDay, items = S.draft.program[day].items, n = items.length;
    $('#progPanel').setAttribute('aria-labelledby', 'pt-' + day);
    $('#progPanel').innerHTML = '<ol class="prog-list">' + items.map(function (it, i) {
      var p = 'program.' + day + '.items.' + i + '.', id = 'pg-' + day + '-' + i + '-';
      function f(key, label, ph, wide) {
        return '<div class="field' + (wide ? ' field--wide' : '') + '"><label for="' + id + key + '">' + label + '</label><input id="' + id + key + '" type="text" data-bind="' + p + key + '" placeholder="' + ph + '" value="' + esc(it[key] || '') + '"></div>';
      }
      return '<li class="prog-item' + (it.highlight ? ' is-highlight' : '') + '" aria-label="' + (i + 1) + '번째 항목">' +
        '<span class="prog-item__idx tnum" aria-hidden="true">' + (i + 1) + '</span>' +
        '<div class="prog-item__fields">' +
        f('time', '시간', '시간 미정', false) +
        f('ko', '내용 (국문)', '예) 개막식·기조강연', true) +
        f('en', '내용 (영문)', 'e.g. Opening Ceremony', true) +
        f('place', '장소', '예) 진수당', false) +
        f('placeEn', '장소 (영문)', 'e.g. Jinsudang', false) +
        f('speaker', '연사', '확정 후 입력', false) +
        '<div class="field">' + sw(id + 'hl', it.highlight, '강조 행', p + 'highlight') + '</div>' +
        '</div><div class="prog-item__actions">' +
        '<button type="button" class="icon-btn" data-prog-act="up" data-i="' + i + '" aria-label="' + (i + 1) + '번째 항목 위로"' + (i === 0 ? ' disabled' : '') + '><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 12l5-5 5 5"/></svg></button>' +
        '<button type="button" class="icon-btn" data-prog-act="down" data-i="' + i + '" aria-label="' + (i + 1) + '번째 항목 아래로"' + (i === n - 1 ? ' disabled' : '') + '><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg></button>' +
        '<button type="button" class="icon-btn" data-prog-act="del" data-i="' + i + '" aria-label="' + (i + 1) + '번째 항목 삭제"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10"/></svg></button>' +
        '</div></li>';
    }).join('') + '</ol>' + (n ? '' : '<p class="empty">항목이 없어요.</p>') +
      '<div class="prog-add"><button type="button" class="btn btn--ghost btn--sm" data-prog-act="add">항목 추가</button></div>';
    if (focusSel) { var el = $(focusSel); el && !el.disabled ? el.focus() : $('[data-prog-act="add"]').focus(); }
  }

  function setPath(obj, path, val) {
    var k = path.split('.'), o = obj;
    for (var i = 0; i < k.length - 1; i++) o = o[k[i]];
    o[k[k.length - 1]] = val;
  }

  function onSettingsInput(e) {
    var el = e.target, bind = el.getAttribute('data-bind');
    if (!bind) return;
    var d = S.draft;
    if (bind === 'closeAt') d.closeAt = el.value ? el.value + ':00+09:00' : '';
    else if (bind.indexOf('cap.') === 0) {
      var v = el.value.trim(), day = bind.slice(4);
      dayCfg(d, day).capacity = v === '' ? null : Math.max(0, Math.floor(Number(v)));
      var cur = S.summary && (day === 'day1' ? S.summary.perDate.d22 : S.summary.perDate.d23);
      var warn = el.parentNode.querySelector('.field__warn'), cap = dayCfg(d, day).capacity;
      warn.hidden = !(cap != null && cur != null && cap <= cur);
      warn.textContent = cap != null && cur != null && cap <= cur ? '현재 예상 인원(' + fmtN(cur) + '명)보다 적거나 같아요. 저장하면 이 날짜 선택지가 바로 마감돼요.' : '';
    } else if (bind.indexOf('tagline.ko.') === 0) { d.tagline.ko[+bind.slice(11)] = textToTagline(el.value); renderTagPreview(); }
    else if (bind === 'tagline.en') { d.tagline.en = el.value; renderTagPreview(); }
    else if (el.type === 'checkbox') {
      setPath(d, bind, el.checked);
      if (/\.highlight$/.test(bind)) el.closest('.prog-item').classList.toggle('is-highlight', el.checked);
    }
    else setPath(d, bind, el.value);
    updateDirty();
  }

  /* ---------- 변경 요약 ---------- */
  var SECTIONS = [
    ['접수 상태', function (c) { return [c.open, c.closeAt]; }],
    ['날짜별 정원', function (c) { return [dayCfg(c, 'day1').capacity, dayCfg(c, 'day2').capacity]; }],
    ['세부 프로그램 안내', function (c) { return [c.program, c.showSpeakers]; }],
    ['태그라인', function (c) { return c.tagline; }],
    ['문의처', function (c) { return c.contact; }]
  ];
  function changedSections() {
    if (!S.config || !S.draft) return [];
    return SECTIONS.filter(function (x) { return JSON.stringify(x[1](S.config)) !== JSON.stringify(x[1](S.draft)); }).map(function (x) { return x[0]; });
  }
  function nowMs() { return S.summary ? Date.parse(S.summary.generatedAt) : Date.now(); }
  function capText(v) { return v == null ? '정원 없음' : fmtN(v) + '명'; }

  // 접수 페이지에 바로 드러나는 변경(접수 열기/닫기, 마감 일시, 정원)과 그 결과를 쉬운 말로
  function publicChanges() {
    var a = S.config, b = S.draft, out = [];
    var pastB = b.closeAt && Date.parse(b.closeAt) <= nowMs();
    if (a.open !== b.open) {
      if (!b.open) out.push({ what: '접수 받기: 켜짐 → 꺼짐', effect: '접수 페이지가 바로 닫혀요. 폼 자리에 ‘사전 접수가 끝났어요’ 안내가 나와요.', warn: true });
      else out.push({ what: '접수 받기: 꺼짐 → 켜짐', effect: pastB ? '마감 일시가 이미 지나 있어서 접수 페이지는 계속 닫혀 있어요. 다시 받으려면 마감 일시도 바꿔 주세요.' : '접수 페이지에 신청 폼이 다시 나와요.', warn: !!pastB });
    }
    if (a.closeAt !== b.closeAt) {
      var what = '마감 일시: ' + fmtCloseAt(a.closeAt) + ' → ' + fmtCloseAt(b.closeAt);
      if (!b.closeAt) out.push({ what: what, effect: '마감 일시가 없어져요. 직접 닫기 전까지 계속 접수해요.', warn: true });
      else if (pastB) out.push({ what: what, effect: '마감 일시가 이미 지났어요 — 저장하면 접수 페이지가 바로 마감돼요.', warn: true });
      else out.push({ what: what, effect: '접수 페이지의 마감 안내가 ' + fmtCloseAt(b.closeAt) + '(으)로 바뀌고, 그때 자동으로 닫혀요.', warn: false });
    }
    [['day1', '22일', 'd22'], ['day2', '23일', 'd23']].forEach(function (x) {
      var ca = dayCfg(a, x[0]).capacity, cb = dayCfg(b, x[0]).capacity;
      if (ca === cb) return;
      var cur = S.summary ? S.summary.perDate[x[2]] : null, what = x[1] + ' 정원: ' + capText(ca) + ' → ' + capText(cb), opts = x[1] + '·양일';
      if (cb == null) out.push({ what: what, effect: '남은 자리 표시가 사라지고, ' + x[1] + '이 들어간 선택지는 인원 때문에 마감되지 않아요.', warn: false });
      else if (cur == null) out.push({ what: what, effect: '현재 인원을 불러오지 못해 마감 여부를 미리 알 수 없어요. 저장 뒤 접수 현황에서 확인해 주세요.', warn: true });
      else if (cb < cur) out.push({ what: what, effect: x[1] + ' 정원이 현재 인원(' + fmtN(cur) + '명)보다 적어요 — ' + opts + ' 선택지가 바로 마감돼요. 이미 신청한 사람은 그대로 남아요.', warn: true });
      else if (cb === cur) out.push({ what: what, effect: x[1] + ' 정원이 현재 인원(' + fmtN(cur) + '명)과 같아요 — ' + opts + ' 선택지가 바로 마감돼요.', warn: true });
      else out.push({ what: what, effect: '접수 페이지에 ' + x[1] + ' 남은 자리 ' + fmtN(cb - cur) + '석으로 나와요.' + (ca != null && ca <= cur ? ' 마감됐던 ' + opts + ' 선택지가 다시 열려요.' : ''), warn: false });
    });
    return out;
  }

  function isDirty() { return !!(S.config && JSON.stringify(S.config) !== JSON.stringify(S.draft)); }
  function updateDirty() {
    var dirty = isDirty(), secs = changedSections();
    $('#savebar').classList.toggle('is-dirty', dirty);
    $('#saveState').textContent = dirty ? '저장하지 않은 변경: ' + (secs.length ? secs.join(' · ') : '설정') : '변경 사항 없음 · 저장된 설정과 같아요';
    $('#btnSave').disabled = !dirty; $('#btnRevert').disabled = !dirty;
    $('#navDirty').hidden = !dirty;
    if (!$('#saveConfirm').hidden) hideConfirm(false); // 확인 중에 내용이 바뀌면 다시 확인받는다
  }

  function showConfirm(list) {
    $('#saveConfirmList').innerHTML = list.map(function (c) {
      return '<li class="' + (c.warn ? 'is-warn' : '') + '"><b>' + esc(c.what) + '</b><span>' + esc(c.effect) + '</span></li>';
    }).join('');
    $('#saveConfirm').hidden = false;
    $('#savebar').classList.add('is-confirming');
    $('#btnConfirmBack').focus(); // 안전한 쪽에 먼저 포커스
  }
  function hideConfirm(focusSave) {
    $('#saveConfirm').hidden = true;
    $('#savebar').classList.remove('is-confirming');
    if (focusSave) $('#btnSave').focus();
  }

  function doSave() {
    var btn = $('#btnSave'); busy(btn, true); busy($('#btnConfirmSave'), true);
    API.adminSaveConfig(clone(S.draft)).then(function (c) {
      S.config = c; S.draft = clone(c);
      hideConfirm(false); updateDirty();
      renderOpenPill(c.open, c.closeAt);
      S.summary = null;
      toast('설정을 저장했어요. 접수 페이지에 반영돼요.');
      loadSettingsLogs();
      btn.focus();
    }).catch(function (err) { toast(errMsg(err), true); }).then(function () { busy(btn, false); busy($('#btnConfirmSave'), false); });
  }

  function bindSettings() {
    var form = $('#settingsForm');
    form.addEventListener('input', onSettingsInput);
    form.addEventListener('change', function (e) { if (e.target.type === 'checkbox') onSettingsInput(e); });
    form.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-prog-day]');
      if (tab) { S.progDay = tab.getAttribute('data-prog-day'); $all('[data-prog-day]').forEach(function (t) { var on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }); renderProgram(); return; }
      var b = e.target.closest('[data-prog-act]'); if (!b) return;
      var items = S.draft.program[S.progDay].items, i = +b.getAttribute('data-i'), act = b.getAttribute('data-prog-act'), focus;
      if (act === 'add') { items.push({ time: '', ko: '', en: '', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' }); focus = '#pg-' + S.progDay + '-' + (items.length - 1) + '-time'; }
      if (act === 'del') { items.splice(i, 1); focus = '[data-prog-act="del"][data-i="' + Math.min(i, items.length - 1) + '"]'; toast((i + 1) + '번째 항목을 지웠어요. 저장 전에는 되돌리기로 복구할 수 있어요.'); }
      if (act === 'up' && i > 0) { items.splice(i - 1, 0, items.splice(i, 1)[0]); focus = '[data-prog-act="up"][data-i="' + (i - 1) + '"]'; }
      if (act === 'down' && i < items.length - 1) { items.splice(i + 1, 0, items.splice(i, 1)[0]); focus = '[data-prog-act="down"][data-i="' + (i + 1) + '"]'; }
      renderProgram(focus); updateDirty();
    });
    form.addEventListener('keydown', function (e) {
      var tab = e.target.closest('[data-prog-day]');
      if (!tab || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      var other = $all('[data-prog-day]').filter(function (t) { return t !== tab; })[0];
      other.click(); other.focus();
    });
    $('#btnRevert').addEventListener('click', function () { S.draft = clone(S.config); hideConfirm(false); renderSettings(); updateDirty(); toast('저장된 설정으로 되돌렸어요.'); });
    $('#btnConfirmBack').addEventListener('click', function () { hideConfirm(true); });
    $('#btnConfirmSave').addEventListener('click', doSave);
    $('#saveConfirm').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); hideConfirm(true); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!isDirty()) return;
      var email = S.draft.contact.email, emailBad = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      $('#s-email-err').hidden = !emailBad; $('#s-email').setAttribute('aria-invalid', String(!!emailBad));
      if (emailBad) { $('#s-email').focus(); return; }
      var pub = publicChanges();
      if (pub.length) { showConfirm(pub); return; } // 공개 화면에 바로 드러나는 변경은 먼저 확인
      doSave();
    });
    window.addEventListener('beforeunload', function (e) { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  }

  /* =========================================================
     시작
     ========================================================= */
  function init() {
    bindTrend(); bindList(); bindDrawerShell(); bindSettings(); bindExport();
    $('#btnRefresh').addEventListener('click', function () {
      var b = this; busy(b, true);
      loadSummary().then(function (ok) { busy(b, false); if (ok) toast('접수 현황을 새로 불러왔어요. ' + asOfText(S.summary.generatedAt)); });
    });
    $('#btnRetry').addEventListener('click', function () {
      var b = this; busy(b, true);
      loadSummary().then(function (ok) { busy(b, false); if (ok) { toast('접수 현황을 불러왔어요.'); $('#h-dashboard').focus(); } });
    });
    $('#btnStats').addEventListener('click', function () { exportStats('stats', this); });
    API.adminWhoAmI().then(function (me) { S.me = me; $('#whoami').textContent = me.name + ' · ' + me.email; }).catch(function () { $('#whoami').textContent = '계정 확인 실패'; });
    API.adminGetConfig().then(function (c) { renderOpenPill(c.open, c.closeAt); }).catch(function () {});
    function start(deep) {
      if (deep) history.replaceState(null, '', '#' + deep); // Apps Script: 최상위 주소(…/exec#/list?…)의 깊은 링크
      if (!location.hash) history.replaceState(null, '', '#/dashboard');
      route(false);
    }
    if (HOST) HOST.initialHash().then(start, function () { start(''); });
    else start('');
  }
  init();
})();
