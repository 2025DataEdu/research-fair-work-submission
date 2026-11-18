/* 관리자 화면 모의 API (화면 개발용)
   Apps Script 이식 시 같은 이름의 서버 함수를 google.script.run 으로 호출하도록 이 파일만 교체한다.
   - 모든 함수는 Promise 를 돌려준다. 실패 시 Error(code, message) 로 reject.
   - 목록(adminList)은 휴대전화번호를 가운데 가린 값(phoneMasked)만 돌려준다.
     전체 번호는 내보내기 기록을 남기는 adminLogExport 응답에만 들어 있다(명세 8장 데이터 보호).
   - 기본 설정값은 ../web/js/config.js 의 RFW_CONFIG 를 복제해 쓴다. */
(function (global) {
  'use strict';

  var DELAY = 200;
  var ME = { email: 'admin@example.com', name: '운영팀' };
  // 화면 개발용 실패 재현: 주소에 ?mockFail=summary,list,export,config 처럼 붙이면 해당 호출이 실패한다.
  var FAIL = (function () { var m = /[?&]mockFail=([^&#]*)/.exec(global.location ? global.location.search : ''); return m ? decodeURIComponent(m[1]).split(',') : []; })();
  function failing(name) { return FAIL.indexOf(name) >= 0 || FAIL.indexOf('all') >= 0; }
  var NOW = '2026-12-18T23:50:00+09:00'; // 모의 기준 시각

  /* ---------- 결정적 난수 (mulberry32) ---------- */
  var seed = 20261222;
  function rnd() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  function weighted(pairs) {
    var total = 0, i;
    for (i = 0; i < pairs.length; i++) total += pairs[i][1];
    var r = rnd() * total;
    for (i = 0; i < pairs.length; i++) { r -= pairs[i][1]; if (r < 0) return pairs[i][0]; }
    return pairs[pairs.length - 1][0];
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 시각 문자열 (KST 고정, +09:00) ---------- */
  function iso(day, h, m, s) { return '2026-12-' + pad(day, 2) + 'T' + pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + '+09:00'; }
  function addHours(isoStr, hours) {
    var d = new Date(new Date(isoStr).getTime() + hours * 3600000 + 9 * 3600000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' +
      pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + '+09:00';
  }
  function nowIso() { return NOW; }
  function tick() { NOW = addHours(NOW, 1 / 60); return NOW; } // 관리자 작업마다 1분씩 흐르게

  /* ---------- 모의 원천 데이터 ---------- */
  var SURNAMES = [['김', 21], ['이', 15], ['박', 9], ['최', 5], ['정', 5], ['강', 3], ['조', 3], ['윤', 3], ['장', 3], ['임', 3],
    ['한', 2], ['오', 2], ['서', 2], ['신', 2], ['권', 2], ['황', 2], ['안', 2], ['송', 2], ['류', 1], ['홍', 1], ['전', 1], ['고', 1], ['문', 1], ['양', 1], ['손', 1]];
  var GIVEN = ['민준', '서연', '지훈', '하은', '도윤', '수빈', '예준', '지민', '현우', '서윤', '준서', '채원', '은지', '성민', '유진', '태현',
    '다은', '민서', '재원', '소연', '상훈', '혜진', '동현', '지아', '경민', '정우', '나연', '승현', '보람', '영훈', '미경', '정훈',
    '세영', '진호', '주원', '하린', '윤서', '시우', '가은', '우진', '형준', '수아', '종혁', '아름', '기현', '선영'];
  var INTL = ['Nguyen Van An', 'Muhammad Rizki', 'Li Wei', 'Aisha Rahman', 'Bui Thi Lan', 'Rahul Sharma', 'Dilnoza Karimova',
    'Tsogtbayar Bat-Erdene', 'Zhang Yuting', 'Fatima Zahra Benali', 'Tran Minh Duc', 'Sarah Kimani', 'Ahmad Fauzi', 'Wang Hao'];
  var DEPTS = ['화학공학과', '고분자나노공학과', '전자공학부', '기계공학과', '생명과학과', '농생물학과', '식품공학과', '컴퓨터공학부',
    '수의학과', '간호학과', '신소재공학부', '환경공학과', '수학과', '물리학과', '바이오메디컬공학부', '유기소재섬유공학과', '경영학과', '분자생물학과'];
  var BK = ['탄소융복합소재', '스마트팜', '바이오헬스', '미래수송기기', 'AI융합', '농생명', '에너지신소재', '정밀의료', '스마트시티'];
  var INSTITUTES = ['한국탄소산업진흥원', '전북테크노파크', '한국식품연구원 융합기술연구본부', '농촌진흥청 국립농업과학원',
    '한국과학기술연구원 전북분원', '전북특별자치도청 미래산업과', '한국원자력연구원 첨단방사선연구소', '안전성평가연구소 전북분소'];
  var COMPANIES = ['(주)한빛바이오 연구소', '(주)새만금에너지 기술연구소', '(주)카본웍스 연구개발팀', '(주)그린팜텍 기술연구소',
    '(주)제이엔소재 연구소', '(주)모아메디칼 기업부설연구소', '(주)온누리바이오 연구소'];
  var OTHER_UNIV = ['군산대학교 화학공학과', '원광대학교 약학과', '전주대학교 식품산업학과', '우석대학교 제약공학과'];

  function makeOrg(intl) {
    if (intl) return '전북대학교 ' + pick(DEPTS);
    var kind = weighted([['dept', 50], ['bk', 22], ['inst', 13], ['co', 10], ['univ', 5]]);
    if (kind === 'dept') return '전북대학교 ' + pick(DEPTS);
    if (kind === 'bk') return '전북대학교 BK21 ' + pick(BK) + '교육연구단';
    if (kind === 'inst') return pick(INSTITUTES);
    if (kind === 'co') return pick(COMPANIES);
    return pick(OTHER_UNIV);
  }

  // 12/1~12/18 일별 신청 수 (12/1 접수 오픈·1차 문자, 12/8 2차 문자, 12/15 마감 안내 문자, 12/18 마감 전날)
  var DAILY = [22, 14, 9, 7, 6, 4, 4, 20, 13, 9, 7, 6, 5, 4, 15, 11, 9, 15];
  var PROMOS = { 1: '접수 오픈 · 1차 홍보 문자', 8: '2차 홍보 문자', 15: '마감 안내 문자' };

  var regs = [];
  var history = [];
  var adminLog = [];
  var usedPhones = {};

  function newPhone() {
    var p;
    do { p = '010' + pad(Math.floor(rnd() * 1e8), 8); } while (usedPhones[p] || p.charAt(3) === '0');
    usedPhones[p] = 1;
    return p;
  }
  function token() {
    var s = '', c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 32; i++) s += c.charAt(Math.floor(rnd() * c.length));
    return s;
  }

  (function generate() {
    DAILY.forEach(function (n, i) {
      var day = i + 1;
      for (var k = 0; k < n; k++) {
        var promo = !!PROMOS[day];
        var h = promo && rnd() < 0.7
          ? 10 + Math.floor(Math.pow(rnd(), 2) * 6)                              // 오전 10시 문자 발송 직후 몰림
          : weighted([[8, 2], [9, 5], [10, 6], [11, 6], [12, 5], [13, 6], [14, 6], [15, 6], [16, 5], [17, 4], [18, 3], [19, 3], [20, 4], [21, 4], [22, 3], [23, 2]]);
        var intl = rnd() < 0.07;
        var src = promo
          ? weighted([['sms', 64], ['qr', 14], ['web', 12], ['direct', 10]])
          : weighted([['sms', 30], ['qr', 31], ['web', 24], ['direct', 15]]);
        var created = iso(day, h, Math.floor(rnd() * 60), Math.floor(rnd() * 60));
        regs.push({
          receiptNo: '', createdAt: created, updatedAt: created, status: 'active',
          name: intl ? pick(INTL) : weighted(SURNAMES) + pick(GIVEN),
          org: makeOrg(intl),
          phone: newPhone(),
          day: weighted([['day1', 45], ['day2', 30], ['both', 25]]),
          consentAt: created, lang: intl ? 'en' : 'ko', src: src, token: token()
        });
      }
    });
    regs.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    regs.forEach(function (r, i) { r.receiptNo = 'RF26-' + r.createdAt.slice(5, 7) + r.createdAt.slice(8, 10) + '-' + pad(i + 1, 4); });

    // 이력: 약 5% 취소, 일부 본인 수정, 관리자 수정·복원 몇 건
    regs.forEach(function (r, i) {
      var x = rnd();
      if (x < 0.05) {
        var at = addHours(r.createdAt, 6 + Math.floor(rnd() * 60));
        if (at > NOW) at = addHours(NOW, -2);
        if (at < r.createdAt) at = r.createdAt; // 취소가 신청보다 앞서지 않게
        var byAdmin = rnd() < 0.25;
        history.push({ at: at, receiptNo: r.receiptNo, by: byAdmin ? ME.email : '본인', kind: '취소', before: { status: 'active' }, after: { status: 'canceled' } });
        r.status = 'canceled'; r.updatedAt = at;
      } else if (x < 0.09) {
        var at2 = addHours(r.createdAt, 2 + Math.floor(rnd() * 48));
        if (at2 > NOW) at2 = addHours(NOW, -1);
        var nd = r.day === 'both' ? 'day1' : 'both';
        history.push({ at: at2, receiptNo: r.receiptNo, by: '본인', kind: '수정', before: { day: r.day }, after: { day: nd } });
        r.day = nd; r.updatedAt = at2;
      } else if (x < 0.105) {
        var at3 = addHours(r.createdAt, 20);
        if (at3 > NOW) at3 = addHours(NOW, -3);
        var before = r.org, after = r.org.indexOf('전북대학교 ') === 0 ? r.org + ' 대학원' : r.org;
        if (before !== after) {
          history.push({ at: at3, receiptNo: r.receiptNo, by: ME.email, kind: '수정', before: { org: before }, after: { org: after } });
          r.org = after; r.updatedAt = at3;
        }
      }
    });
    // 취소 후 복원된 사례 1건
    var rr = regs[37];
    if (rr && rr.status === 'active') {
      var c1 = addHours(rr.createdAt, 30), c2 = addHours(rr.createdAt, 52);
      history.push({ at: c1, receiptNo: rr.receiptNo, by: '본인', kind: '취소', before: { status: 'active' }, after: { status: 'canceled' } });
      history.push({ at: c2, receiptNo: rr.receiptNo, by: ME.email, kind: '복원', before: { status: 'canceled' }, after: { status: 'active' } });
      rr.updatedAt = c2;
    }

    adminLog.push({ at: '2026-12-08T09:12:00+09:00', email: 'bk21@example.com', name: 'BK21 담당', action: '내보내기', kind: 'xlsx', filterText: '전체 · 신청', count: 92 });
    adminLog.push({ at: '2026-12-15T17:40:00+09:00', email: ME.email, name: ME.name, action: '내보내기', kind: 'stats', filterText: '접수 통계', count: 0 });
    // 설정 변경 기록 (현재 모의 설정과 맞는 값)
    adminLog.push({ at: '2026-11-30T16:05:00+09:00', email: 'bk21@example.com', name: 'BK21 담당', action: '설정변경', changes: ['세부 프로그램(22일): 내용 수정'] });
    adminLog.push({ at: '2026-12-10T10:02:00+09:00', email: ME.email, name: ME.name, action: '설정변경', changes: ['22일 정원: 없음 → 200명', '23일 정원: 없음 → 150명'] });
    // 관리자 로그인 기록
    [['2026-12-01T08:51:00+09:00', ME], ['2026-12-01T09:30:00+09:00', { email: 'bk21@example.com', name: 'BK21 담당' }],
      ['2026-12-08T09:05:00+09:00', { email: 'bk21@example.com', name: 'BK21 담당' }], ['2026-12-10T09:58:00+09:00', ME],
      ['2026-12-15T17:31:00+09:00', ME], ['2026-12-17T14:12:00+09:00', { email: 'ops2@example.com', name: '운영팀 2' }],
      ['2026-12-18T23:41:00+09:00', ME]].forEach(function (x) {
      adminLog.push({ at: x[0], email: x[1].email, name: x[1].name, action: '로그인' });
    });
  })();

  /* ---------- 설정 ---------- */
  var config = (function () {
    var base = global.RFW_CONFIG ? clone(global.RFW_CONFIG) : {
      open: true, closeAt: '2026-12-19T18:00:00+09:00', showSpeakers: false,
      tagline: { ko: [[{ t: '4단계', em: true }, { t: '의 ' }, { t: '성과', em: true }], [{ t: '5단계', em: true }, { t: '의 ' }, { t: '미래', em: true }, { t: '로 ' }, { t: '잇다', em: true }]], en: 'From Phase 4 to Phase 5' },
      days: [{ value: 'day1', capacity: null, remaining: null }, { value: 'day2', capacity: null, remaining: null }, { value: 'both', capacity: null, remaining: null }],
      program: { day1: { items: [] }, day2: { items: [] } }, contact: { phone: '', email: '' }, privacyUrl: '#privacy'
    };
    // 모의 시연용 정원 (22일·23일 날짜별 정원). 'both' 행의 capacity 는 쓰지 않는다.
    base.days.forEach(function (d) {
      if (d.value === 'day1') d.capacity = 200;
      if (d.value === 'day2') d.capacity = 150;
    });
    return base;
  })();

  /* ---------- 공통 ---------- */
  function wait(v) { return new Promise(function (res) { setTimeout(function () { res(clone(v)); }, DELAY); }); }
  function fail(code, message, extra) {
    return new Promise(function (_, rej) {
      setTimeout(function () { var e = new Error(message || code); e.code = code; Object.assign(e, extra || {}); rej(e); }, DELAY);
    });
  }
  function mask(p) { return p.slice(0, 3) + '-****-' + p.slice(-4); }
  function hyphen(p) { return p.length === 11 ? p.slice(0, 3) + '-' + p.slice(3, 7) + '-' + p.slice(7) : p.slice(0, 3) + '-' + p.slice(3, 6) + '-' + p.slice(6); }
  function publicRow(r) {
    return { receiptNo: r.receiptNo, createdAt: r.createdAt, updatedAt: r.updatedAt, status: r.status, name: r.name, org: r.org,
      phoneMasked: mask(r.phone), phoneLast4: r.phone.slice(-4), day: r.day, consentAt: r.consentAt, lang: r.lang, src: r.src };
  }
  function capIn(cfg, v) { for (var i = 0; i < cfg.days.length; i++) if (cfg.days[i].value === v) return cfg.days[i].capacity; return null; }
  function capOf(v) { for (var i = 0; i < config.days.length; i++) if (config.days[i].value === v) return config.days[i].capacity; return null; }
  function counts() {
    var by = { day1: 0, day2: 0, both: 0 };
    regs.forEach(function (r) { if (r.status === 'active') by[r.day]++; });
    return { by: by, d22: by.day1 + by.both, d23: by.day2 + by.both };
  }
  function find(no) { for (var i = 0; i < regs.length; i++) if (regs[i].receiptNo === no) return regs[i]; return null; }
  function log(action, detail) { adminLog.push(Object.assign({ at: tick(), email: ME.email, name: ME.name, action: action }, detail || {})); }

  function filterRows(f) {
    f = f || {};
    var q = String(f.q || '').trim().toLowerCase();
    var qDigits = q.replace(/[^0-9]/g, '');
    var phoneLike = /^[0-9\s\-–.]+$/.test(q);
    var day = f.day || 'all', status = f.status || 'active';
    var out = regs.filter(function (r) {
      if (status !== 'all' && r.status !== status) return false;
      if (day === 'd22' && r.day === 'day2') return false;
      if (day === 'd23' && r.day === 'day1') return false;
      if ((day === 'day1' || day === 'day2' || day === 'both') && r.day !== day) return false;
      if (!q) return true;
      if (r.name.toLowerCase().indexOf(q) >= 0 || r.org.toLowerCase().indexOf(q) >= 0 || r.receiptNo.toLowerCase().indexOf(q) >= 0) return true;
      // 전화번호: 숫자·하이픈·공백만 있으면 번호로 본다. 4자리는 뒷자리 일치, 5자리 이상은 부분 일치(010-1234-5678, 1234-5678 등)
      if (!phoneLike || qDigits.length < 4) return false;
      return qDigits.length === 4 ? r.phone.slice(-4) === qDigits : r.phone.indexOf(qDigits) >= 0;
    });
    var parts = String(f.sort || 'createdAt:desc').split(':');
    var key = parts[0], dir = parts[1] === 'asc' ? 1 : -1;
    var dayOrder = { day1: 0, day2: 1, both: 2 };
    out.sort(function (a, b) {
      var va = a[key], vb = b[key], c;
      if (key === 'day') c = dayOrder[va] - dayOrder[vb];
      else if (key === 'name' || key === 'org') c = String(va).localeCompare(String(vb), 'ko');
      else c = va < vb ? -1 : va > vb ? 1 : 0;
      if (c === 0) c = a.receiptNo < b.receiptNo ? -1 : 1;
      return c * dir;
    });
    return out;
  }

  function logOf(action) {
    return adminLog.filter(function (l) { return l.action === action; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  }

  /* 설정 변경 요약 — 변경 기록에 남길 문장 */
  function configChanges(a, b) {
    var out = [];
    function dt(s) { return s ? s.slice(0, 10).replace(/-/g, '.') + ' ' + s.slice(11, 16) : '없음'; }
    function cap(v) { return v == null ? '없음' : v + '명'; }
    if (a.open !== b.open) out.push('접수 받기: ' + (a.open ? '켜짐' : '꺼짐') + ' → ' + (b.open ? '켜짐' : '꺼짐'));
    if (a.closeAt !== b.closeAt) out.push('마감 일시: ' + dt(a.closeAt) + ' → ' + dt(b.closeAt));
    [['day1', '22일'], ['day2', '23일']].forEach(function (x) {
      var ca = capIn(a, x[0]), cb = capIn(b, x[0]);
      if (ca !== cb) out.push(x[1] + ' 정원: ' + cap(ca) + ' → ' + cap(cb));
    });
    [['day1', '22일'], ['day2', '23일']].forEach(function (x) {
      var ia = (a.program[x[0]] || {}).items || [], ib = (b.program[x[0]] || {}).items || [];
      if (JSON.stringify(ia) === JSON.stringify(ib)) return;
      out.push('세부 프로그램(' + x[1] + '): ' + (ia.length !== ib.length ? '항목 ' + ia.length + '개 → ' + ib.length + '개' : '내용 수정'));
    });
    if (!!a.showSpeakers !== !!b.showSpeakers) out.push('연사 이름 공개: ' + (a.showSpeakers ? '켜짐' : '꺼짐') + ' → ' + (b.showSpeakers ? '켜짐' : '꺼짐'));
    if (JSON.stringify(a.tagline) !== JSON.stringify(b.tagline)) out.push('태그라인 수정');
    if (JSON.stringify(a.contact) !== JSON.stringify(b.contact)) out.push('문의처 수정');
    return out;
  }

  /* ---------- 공개 함수 ---------- */
  var API = {
    adminWhoAmI: function () { return wait(ME); },

    /* 집계 기준
       - total: 유효 신청(현재 상태 '신청'), canceled: 현재 상태 '취소', createdTotal = total + canceled (신청일 기준 전체)
       - daily[].count: 그날 새로 들어온 신청(신청일 기준, 이후 취소된 건 포함)
       - daily[].canceled / restored: 그날 처리된 취소·복원(처리일 기준)
       - daily[].cumulative: 그날 끝 기준 유효 신청 = 누적 신규 − 누적 취소 + 누적 복원. 마지막 값 = total */
    adminGetSummary: function () {
      if (failing('summary')) return fail('SERVER', '접수 현황을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      var c = counts();
      var canceled = regs.filter(function (r) { return r.status === 'canceled'; }).length;
      var src = { sms: 0, qr: 0, web: 0, direct: 0 };
      var perDay = {}, cancelDay = {}, restoreDay = {};
      regs.forEach(function (r) {
        if (r.status === 'active') src[r.src]++;
        var d = r.createdAt.slice(0, 10);
        perDay[d] = (perDay[d] || 0) + 1;
      });
      history.forEach(function (h) {
        var d = h.at.slice(0, 10);
        if (h.kind === '취소') cancelDay[d] = (cancelDay[d] || 0) + 1;
        if (h.kind === '복원') restoreDay[d] = (restoreDay[d] || 0) + 1;
      });
      var daily = [], cum = 0, last = Number(NOW.slice(8, 10));
      for (var d = 1; d <= Math.min(last, 19); d++) {
        var key = '2026-12-' + pad(d, 2), n = perDay[key] || 0, cx = cancelDay[key] || 0, rs = restoreDay[key] || 0;
        cum += n - cx + rs;
        daily.push({ date: key, count: n, canceled: cx, restored: rs, cumulative: cum, note: PROMOS[d] || '' });
      }
      return wait({
        total: c.by.day1 + c.by.day2 + c.by.both, canceled: canceled, createdTotal: regs.length, byDay: c.by,
        perDate: { d22: c.d22, d23: c.d23 },
        capacity: { d22: capOf('day1'), d23: capOf('day2') },
        daily: daily, bySrc: src, open: config.open, closeAt: config.closeAt, generatedAt: nowIso()
      });
    },

    /* {q, day: all|day1|day2|both|d22|d23, status: active|canceled|all, sort: 'key:asc|desc'} */
    adminList: function (f) {
      if (failing('list')) return fail('SERVER', '신청자 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      var rows = filterRows(f).map(publicRow);
      return wait({ rows: rows, total: rows.length, generatedAt: nowIso() });
    },

    adminUpdate: function (receiptNo, patch) {
      var r = find(receiptNo);
      if (!r) return fail('NOT_FOUND', '신청 건을 찾지 못했어요.');
      patch = patch || {};
      var fields = {};
      if ('name' in patch) { var n = String(patch.name).trim(); if (!n || n.length > 40) fields.name = true; else patch.name = n; }
      if ('org' in patch) { var o = String(patch.org).trim(); if (!o || o.length > 60) fields.org = true; else patch.org = o; }
      if ('phone' in patch) {
        var p = String(patch.phone).replace(/\D/g, '');
        if (!/^01[016789]\d{7,8}$/.test(p)) fields.phone = true;
        else {
          var dup = regs.some(function (x) { return x !== r && x.phone === p && x.status === 'active'; });
          if (dup) return fail('DUPLICATE', '같은 휴대전화번호로 신청한 건이 이미 있어요.');
          patch.phone = p;
        }
      }
      if ('day' in patch && ['day1', 'day2', 'both'].indexOf(patch.day) < 0) fields.day = true;
      if (Object.keys(fields).length) return fail('VALIDATION', '입력값을 확인해 주세요.', { fields: fields });
      if (r.status === 'canceled') return fail('CANCELED', '취소된 신청은 복원한 뒤 수정할 수 있어요.');
      var before = {}, after = {};
      ['name', 'org', 'phone', 'day'].forEach(function (k) {
        if (k in patch && patch[k] !== r[k]) {
          before[k] = k === 'phone' ? mask(r[k]) : r[k];
          after[k] = k === 'phone' ? mask(patch[k]) : patch[k];
        }
      });
      if (!Object.keys(after).length) return wait(publicRow(r));
      ['name', 'org', 'phone', 'day'].forEach(function (k) { if (k in patch) r[k] = patch[k]; });
      r.updatedAt = tick();
      history.push({ at: r.updatedAt, receiptNo: r.receiptNo, by: ME.email, kind: '수정', before: before, after: after });
      log('수정', { receiptNo: r.receiptNo });
      return wait(publicRow(r));
    },

    adminCancel: function (receiptNo) {
      var r = find(receiptNo);
      if (!r) return fail('NOT_FOUND', '신청 건을 찾지 못했어요.');
      if (r.status === 'canceled') return wait(publicRow(r));
      r.status = 'canceled'; r.updatedAt = tick();
      history.push({ at: r.updatedAt, receiptNo: r.receiptNo, by: ME.email, kind: '취소', before: { status: 'active' }, after: { status: 'canceled' } });
      log('수정', { receiptNo: r.receiptNo, detail: '취소' });
      return wait(publicRow(r));
    },

    adminRestore: function (receiptNo) {
      var r = find(receiptNo);
      if (!r) return fail('NOT_FOUND', '신청 건을 찾지 못했어요.');
      if (r.status === 'active') return wait(publicRow(r));
      var dup = regs.some(function (x) { return x !== r && x.phone === r.phone && x.status === 'active'; });
      if (dup) return fail('DUPLICATE', '같은 휴대전화번호로 신청한 다른 건이 있어 복원할 수 없어요.');
      var c = counts(), c22 = capOf('day1'), c23 = capOf('day2');
      if ((r.day !== 'day2' && c22 != null && c.d22 >= c22) || (r.day !== 'day1' && c23 != null && c.d23 >= c23)) {
        return fail('DAY_FULL', '참석일 정원이 가득 차 복원할 수 없어요. 정원을 늘리거나 참석일을 바꿔 주세요.');
      }
      r.status = 'active'; r.updatedAt = tick();
      history.push({ at: r.updatedAt, receiptNo: r.receiptNo, by: ME.email, kind: '복원', before: { status: 'canceled' }, after: { status: 'active' } });
      log('수정', { receiptNo: r.receiptNo, detail: '복원' });
      return wait(publicRow(r));
    },

    adminHistory: function (receiptNo) {
      return wait(history.filter(function (h) { return h.receiptNo === receiptNo; })
        .sort(function (a, b) { return a.at < b.at ? 1 : -1; }));
    },

    adminGetConfig: function () {
      if (failing('config')) return fail('SERVER', '설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      return wait(config);
    },

    adminSaveConfig: function (cfg) {
      if (!cfg || !cfg.days || !cfg.program) return fail('VALIDATION', '설정 형식이 올바르지 않아요.');
      var c = counts();
      cfg.days.forEach(function (d) {
        var cap = d.value === 'both' ? null : d.capacity;
        if (d.value === 'both') {
          var c1 = capIn(cfg, 'day1'), c2 = capIn(cfg, 'day2');
          var a = c1 == null ? Infinity : c1 - c.d22, b = c2 == null ? Infinity : c2 - c.d23;
          var m = Math.min(a, b);
          d.capacity = null; d.remaining = m === Infinity ? null : Math.max(0, m);
        } else {
          d.remaining = cap == null ? null : Math.max(0, cap - (d.value === 'day1' ? c.d22 : c.d23));
        }
      });
      var changes = configChanges(config, cfg);
      config = clone(cfg);
      if (changes.length) log('설정변경', { changes: changes });
      return wait(config);
    },

    /* kind: xlsx | csv | badge | stats | statsXlsx. 기록을 남기고, 명단 내보내기면 전체 번호가 든 행을 돌려준다. */
    adminLogExport: function (kind, filter) {
      if (failing('export')) return fail('SERVER', '내보내기 기록을 남기지 못해 파일을 만들지 않았어요. 잠시 후 다시 시도해 주세요.');
      var isStats = kind === 'stats' || kind === 'statsXlsx';
      var rows = isStats ? [] : filterRows(filter);
      if (kind === 'badge') rows = rows.filter(function (r) { return r.status === 'active'; });
      var full = rows.map(function (r) {
        var o = publicRow(r); o.phone = hyphen(r.phone); return o;
      });
      var entry = { at: tick(), email: ME.email, name: ME.name, action: '내보내기', kind: kind,
        filterText: (filter && filter.label) || (isStats ? '접수 통계' : '전체'), count: full.length };
      adminLog.push(entry);
      return wait({ entry: entry, rows: full });
    },

    /* 모의 전용 보조: 내보내기 기록 조회 (Apps Script 에서는 관리자로그 시트에서 action=내보내기 만 읽는다) */
    adminExportLog: function () { return wait(logOf('내보내기')); },

    /* 설정 변경 기록 (관리자로그 시트의 action=설정변경). changes: 사람이 읽는 변경 요약 문장 배열 */
    adminConfigLog: function () { return wait(logOf('설정변경')); },

    /* 관리자 로그인 기록 (관리자로그 시트의 action=로그인) */
    adminAccessLog: function () { return wait(logOf('로그인')); }
  };

  global.AdminAPI = API;
})(window);
