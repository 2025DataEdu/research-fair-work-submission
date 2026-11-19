/* 관리자 화면 — Apps Script 웹앱 (접속한 사용자로 실행, 액세스: Google 계정이 있는 모든 사용자).
   허용 명단(스크립트 속성 ADMIN_EMAILS)에 없는 계정은 화면을 받지 못한다.
   이 프로젝트에서 밑줄로 끝나지 않는 전역 함수는 누구나 google.script.run 으로 부를 수 있으므로
   모든 공개 함수는 첫 줄에서 허용 명단을 다시 확인한다.
   반환값은 언제나 {ok:true,data} / {ok:false,code,message,fields?} — data 는 admin/js/api.js 모의 구현과 같은 모양.
   google.script.run 은 Date 를 넘기지 못하므로 시각은 모두 '+09:00' ISO 문자열이다. */

/* ================= 허용 명단 ================= */
/** ADMIN_EMAILS: 쉼표로 구분. 'a@x.com:운영팀' 처럼 콜론 뒤에 화면에 보일 이름을 붙일 수 있다(없으면 @ 앞부분). */
function adminAllowlist_() {
  var map = {};
  String(prop_('ADMIN_EMAILS')).split(',').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var i = part.indexOf(':');
    var email = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase();
    var name = i >= 0 ? part.slice(i + 1).trim() : '';
    if (email) map[email] = name || email.split('@')[0];
  });
  return map;
}
function currentEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { return ''; }
}
/** 허용된 관리자면 {email, name}, 아니면 null */
function adminMe_() {
  var email = currentEmail_();
  if (!email) return null;
  var list = adminAllowlist_();
  return Object.prototype.hasOwnProperty.call(list, email) ? { email: email, name: list[email] } : null;
}

/** 모든 관리자 함수의 공통 틀: 명단 확인 → 실행 → 봉투. 예외는 클라이언트로 던지지 않는다. */
function adminRun_(fn, failMessage) {
  try {
    var me = adminMe_();
    if (!me) throw rfwError_('FORBIDDEN', '관리자 권한이 없어요. 허용된 구글 계정으로 다시 로그인해 주세요.');
    var data = fn(me, rfwSpreadsheet_());
    return { ok: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) };
  } catch (err) {
    return errorEnvelope_(err, failMessage);
  }
}
function adminLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw rfwError_('SERVER', '다른 관리자의 작업을 처리하고 있어요. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function adminLog_(ss, me, action, detail) {
  var entry = { at: kstIso_(), email: me.email, name: me.name, action: action };
  Object.keys(detail || {}).forEach(function (k) { entry[k] = detail[k]; });
  appendAdminLog_(ss, entry);
  return entry;
}

/* ================= 진입점 ================= */
function doGet() {
  var me = adminMe_();
  if (!me) {
    var email = currentEmail_();
    var who = email ? '지금 로그인한 계정(' + email.replace(/[&<>"']/g, '') + ')은 관리자 명단에 없어요.' : '로그인한 구글 계정을 확인하지 못했어요.';
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<body style="margin:0;background:#000;color:#fff;font-family:Pretendard,system-ui,sans-serif;padding:48px 20px;line-height:1.6">' +
      '<h1 style="font-size:20px;margin:0 0 12px">권한이 없어요</h1>' +
      '<p style="color:#cfcfcf;margin:0">' + who + ' 운영사무국에 관리자 등록을 요청해 주세요.</p></body>')
      .setTitle('권한이 없어요')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  try { adminLog_(rfwSpreadsheet_(), me, '로그인'); } catch (err) { console.error('로그인 기록 실패: ' + err); }
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('관리자 · 2026 JBNU-G 리서치페어 위크')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ================= 공개 함수 (docs/api.md 관리자 API) ================= */
function adminWhoAmI() {
  return adminRun_(function (me) { return { email: me.email, name: me.name }; });
}

/* 집계 기준 (admin/js/api.js 와 같음)
   - total = 유효 신청, canceled = 지금 취소 상태, createdTotal = total + canceled
   - daily[].count: 신청일 기준 신규(이후 취소 포함), canceled·restored: 변경이력의 처리일 기준
   - daily[].cumulative: 그날 끝 기준 유효 신청. 마지막 값 = total (상태를 시트에서 손으로 바꾸지 않는 한)
   - 날짜 범위: 첫 신청·처리일 ~ max(마지막 처리일, min(오늘, 마감일)), 빈 날은 0
   - visits·visitSubmits: 방문집계 탭 전체 날짜 합(경로별 + total). 방문은 api 프로젝트가 시트에 반영한 것까지만
     보인다(그쪽 캐시는 이 프로젝트에서 못 읽음). visitSubmits 는 취소 포함 접수 건수. conversion = 신청 ÷ 방문(방문 0 이면 null)
   - visitsUpdatedAt: 방문수 마지막 반영 시각(방문집계 G1), 없으면 null */
function adminGetSummary() {
  return adminRun_(function (me, ss) {
    var regs = readRegs_(ss), cfg = readConfig_(ss), hist = readHistory_(ss);
    var c = countsOf_(regs);
    var src = { sms: 0, qr: 0, web: 0, direct: 0 };
    var perDay = {}, cancelDay = {}, restoreDay = {}, dates = [];
    regs.forEach(function (r) {
      if (r.status === 'active') src[r.src] = (src[r.src] || 0) + 1;
      var d = r.createdAt.slice(0, 10);
      if (d) { perDay[d] = (perDay[d] || 0) + 1; dates.push(d); }
    });
    hist.forEach(function (h) {
      var d = h.at.slice(0, 10);
      if (!d) return;
      if (h.kind === '취소') { cancelDay[d] = (cancelDay[d] || 0) + 1; dates.push(d); }
      if (h.kind === '복원') { restoreDay[d] = (restoreDay[d] || 0) + 1; dates.push(d); }
    });
    var today = kstDate_();
    dates.sort();
    var start = dates.length ? dates[0] : today;
    var closeDay = isNaN(Date.parse(cfg.closeAt)) ? today : kstDate_(Date.parse(cfg.closeAt));
    var end = closeDay < today ? closeDay : today;
    if (dates.length && dates[dates.length - 1] > end) end = dates[dates.length - 1];
    if (end < start) end = start;
    var daily = [], cum = 0, notes = cfg._dailyNotes || {};
    for (var t = Date.parse(start + 'T00:00:00Z'), stop = Date.parse(end + 'T00:00:00Z'); t <= stop; t += 86400000) {
      var key = new Date(t).toISOString().slice(0, 10);
      var n = perDay[key] || 0, cx = cancelDay[key] || 0, rs = restoreDay[key] || 0;
      cum += n - cx + rs;
      daily.push({ date: key, count: n, canceled: cx, restored: rs, cumulative: cum, note: String(notes[key] || '') });
    }
    var canceled = regs.filter(function (r) { return r.status === 'canceled'; }).length;
    var capOf = function (v) { return cfg.days.filter(function (d) { return d.value === v; })[0].capacity; };
    var vs = readVisitStats_(ss);
    return {
      total: c.by.day1 + c.by.day2 + c.by.both, canceled: canceled, createdTotal: regs.length, byDay: c.by,
      perDate: { d22: c.d22, d23: c.d23 },
      capacity: { d22: capOf('day1'), d23: capOf('day2') },
      daily: daily, bySrc: src, open: cfg.open, closeAt: cfg.closeAt, generatedAt: kstIso_(),
      visits: vs.visits, visitSubmits: vs.submits, conversion: conversionOf_(vs.visits, vs.submits),
      visitsDaily: vs.daily, visitsUpdatedAt: vs.updatedAt
    };
  }, '접수 현황을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
}

/* {q, day: all|day1|day2|both|d22|d23, status: active|canceled|all, sort: 'key:asc|desc'} — admin/js/api.js filterRows 와 같음 */
function adminFilter_(regs, f) {
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
    // 전화번호: 숫자·하이픈·공백만 있으면 번호로 본다. 4자리는 뒷자리 일치, 5자리 이상은 부분 일치
    if (!phoneLike || qDigits.length < 4) return false;
    return qDigits.length === 4 ? r.phone.slice(-4) === qDigits : r.phone.indexOf(qDigits) >= 0;
  });
  var parts = String(f.sort || 'createdAt:desc').split(':');
  var key = parts[0], dir = parts[1] === 'asc' ? 1 : -1;
  var allowed = ['receiptNo', 'createdAt', 'updatedAt', 'status', 'name', 'org', 'day', 'lang', 'src', 'consentAt'];
  if (allowed.indexOf(key) < 0) key = 'createdAt';
  var dayOrder = { day1: 0, day2: 1, both: 2 };
  out.sort(function (a, b) {
    var va = a[key], vb = b[key], c;
    if (key === 'day') c = (dayOrder[va] || 0) - (dayOrder[vb] || 0);
    else if (key === 'name' || key === 'org') c = String(va).localeCompare(String(vb), 'ko');
    else c = va < vb ? -1 : va > vb ? 1 : 0;
    if (c === 0) c = a.receiptNo < b.receiptNo ? -1 : 1;
    return c * dir;
  });
  return out;
}

function adminList(f) {
  return adminRun_(function (me, ss) {
    var rows = adminFilter_(readRegs_(ss), f).map(publicRow_);
    return { rows: rows, total: rows.length, generatedAt: kstIso_() };
  }, '신청자 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function adminFind_(regs, receiptNo) {
  var r = findReg_(regs, 'receiptNo', String(receiptNo || ''));
  if (!r) throw rfwError_('NOT_FOUND', '신청 건을 찾지 못했어요.');
  return r;
}

/** patch: {name?, org?, phone?, day?} — 관리자는 정원과 무관하게 참석일을 바꿀 수 있다(모의 구현과 같음). */
function adminUpdate(receiptNo, patch) {
  return adminRun_(function (me, ss) {
    return adminLock_(function () {
      var regs = readRegs_(ss);
      var r = adminFind_(regs, receiptNo);
      var src = patch && typeof patch === 'object' ? patch : {};
      var next = {}, fields = {};
      if ('name' in src) { var n = String(src.name == null ? '' : src.name).trim(); if (!n || n.length > 40) fields.name = true; else next.name = n; }
      if ('org' in src) { var o = String(src.org == null ? '' : src.org).trim(); if (!o || o.length > 60) fields.org = true; else next.org = o; }
      if ('phone' in src) {
        var p = normPhone_(src.phone);
        if (!RFW_PHONE_RE.test(p)) fields.phone = true;
        else {
          if (regs.some(function (x) { return x !== r && x.phone === p && x.status === 'active'; })) {
            throw rfwError_('DUPLICATE', '같은 휴대전화번호로 신청한 건이 이미 있어요.');
          }
          next.phone = p;
        }
      }
      if ('day' in src) { if (RFW_DAYS.indexOf(src.day) < 0) fields.day = true; else next.day = src.day; }
      if (Object.keys(fields).length) throw rfwError_('VALIDATION', '입력값을 확인해 주세요.', { fields: fields });
      if (r.status === 'canceled') throw rfwError_('CANCELED', '취소된 신청은 복원한 뒤 수정할 수 있어요.');
      var diff = diffReg_(r, next);
      if (!diff.changed) return publicRow_(r);
      Object.keys(next).forEach(function (k) { r[k] = next[k]; });
      r.updatedAt = kstIso_();
      writeReg_(ss, r);
      appendHistory_(ss, { at: r.updatedAt, receiptNo: r.receiptNo, by: me.email, kind: '수정', before: diff.before, after: diff.after });
      adminLog_(ss, me, '수정', { receiptNo: r.receiptNo });
      return publicRow_(r);
    });
  }, '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function adminCancel(receiptNo) {
  return adminRun_(function (me, ss) {
    return adminLock_(function () {
      var r = adminFind_(readRegs_(ss), receiptNo);
      if (r.status === 'canceled') return publicRow_(r);
      r.status = 'canceled';
      r.updatedAt = kstIso_();
      writeReg_(ss, r);
      appendHistory_(ss, { at: r.updatedAt, receiptNo: r.receiptNo, by: me.email, kind: '취소', before: { status: 'active' }, after: { status: 'canceled' } });
      adminLog_(ss, me, '수정', { receiptNo: r.receiptNo, detail: '취소' });
      return publicRow_(r);
    });
  }, '취소 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function adminRestore(receiptNo) {
  return adminRun_(function (me, ss) {
    return adminLock_(function () {
      var regs = readRegs_(ss);
      var r = adminFind_(regs, receiptNo);
      if (r.status === 'active') return publicRow_(r);
      if (regs.some(function (x) { return x !== r && x.phone === r.phone && x.status === 'active'; })) {
        throw rfwError_('DUPLICATE', '같은 휴대전화번호로 신청한 다른 건이 있어 복원할 수 없어요.');
      }
      var cfg = readConfig_(ss), c = countsOf_(regs);
      var c22 = cfg.days[0].capacity, c23 = cfg.days[1].capacity;
      if ((r.day !== 'day2' && c22 != null && c.d22 >= c22) || (r.day !== 'day1' && c23 != null && c.d23 >= c23)) {
        throw rfwError_('DAY_FULL', '참석일 정원이 가득 차 복원할 수 없어요. 정원을 늘리거나 참석일을 바꿔 주세요.');
      }
      r.status = 'active';
      r.updatedAt = kstIso_();
      writeReg_(ss, r);
      appendHistory_(ss, { at: r.updatedAt, receiptNo: r.receiptNo, by: me.email, kind: '복원', before: { status: 'canceled' }, after: { status: 'active' } });
      adminLog_(ss, me, '수정', { receiptNo: r.receiptNo, detail: '복원' });
      return publicRow_(r);
    });
  }, '복원하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function adminHistory(receiptNo) {
  return adminRun_(function (me, ss) {
    var no = String(receiptNo || '');
    return newestFirst_(readHistory_(ss).filter(function (h) { return h.receiptNo === no; }));
  }, '변경 이력을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function adminGetConfig() {
  return adminRun_(function (me, ss) {
    return withRemaining_(readConfig_(ss), readRegs_(ss), true);
  }, '설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
}

/* 설정 변경 요약 — admin/js/api.js configChanges 와 같은 문장 */
function configChanges_(a, b) {
  var out = [];
  function capIn(cfg, v) { for (var i = 0; i < cfg.days.length; i++) if (cfg.days[i].value === v) return cfg.days[i].capacity; return null; }
  function dt(s) { return s ? s.slice(0, 10).replace(/-/g, '.') + ' ' + s.slice(11, 16) : '없음'; }
  function cap(v) { return v == null ? '없음' : v + '명'; }
  function onoff(v) { return v ? '켜짐' : '꺼짐'; }
  if (!!a.open !== !!b.open) out.push('접수 받기: ' + onoff(a.open) + ' → ' + onoff(b.open));
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
  if (!!a.showSpeakers !== !!b.showSpeakers) out.push('연사 이름 공개: ' + onoff(a.showSpeakers) + ' → ' + onoff(b.showSpeakers));
  if (JSON.stringify(a.tagline) !== JSON.stringify(b.tagline)) out.push('태그라인 수정');
  if (JSON.stringify(a.contact) !== JSON.stringify(b.contact)) out.push('문의처 수정');
  return out;
}

/** 화면에서 받은 설정을 저장할 형태로 정리. 형식이 틀리면 VALIDATION. */
function cleanConfig_(cfg, cur) {
  var bad = function () { return rfwError_('VALIDATION', '설정 형식이 올바르지 않아요.'); };
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.days) || !cfg.program || typeof cfg.program !== 'object') throw bad();
  if (cfg.closeAt && isNaN(Date.parse(cfg.closeAt))) throw rfwError_('VALIDATION', '마감 일시 형식이 올바르지 않아요.', { fields: { closeAt: true } });
  function capIn(v) {
    var d = cfg.days.filter(function (x) { return x && x.value === v; })[0];
    if (!d || d.capacity == null || d.capacity === '') return null;
    var n = Number(d.capacity);
    if (!isFinite(n) || n < 0) throw rfwError_('VALIDATION', '정원은 0 이상의 숫자로 입력해 주세요.', { fields: { capacity: true } });
    return Math.floor(n);
  }
  function str(v, max) { return String(v == null ? '' : v).slice(0, max || 200); }
  function items(day) {
    var list = ((cfg.program[day] || {}).items) || [];
    if (!Array.isArray(list) || list.length > 40) throw bad();
    return list.map(function (it) {
      it = it || {};
      return { time: str(it.time, 40), ko: str(it.ko), en: str(it.en), place: str(it.place, 80), placeEn: str(it.placeEn, 80),
        highlight: !!it.highlight, speaker: str(it.speaker) };
    });
  }
  function hdr(day, lang) {
    var h = ((cfg.program[day] || {})[lang]) || cur.program[day][lang] || {};
    return { title: str(h.title, 80), date: str(h.date, 20), dow: str(h.dow, 10) };
  }
  return {
    open: !!cfg.open,
    closeAt: str(cfg.closeAt || cur.closeAt, 40),
    showSpeakers: !!cfg.showSpeakers,
    tagline: cfg.tagline && typeof cfg.tagline === 'object' ? cfg.tagline : cur.tagline,
    days: [
      { value: 'day1', capacity: capIn('day1'), remaining: null },
      { value: 'day2', capacity: capIn('day2'), remaining: null },
      { value: 'both', capacity: null, remaining: null }
    ],
    program: {
      day1: { ko: hdr('day1', 'ko'), en: hdr('day1', 'en'), items: items('day1') },
      day2: { ko: hdr('day2', 'ko'), en: hdr('day2', 'en'), items: items('day2') }
    },
    contact: { phone: str((cfg.contact || {}).phone, 40), email: str((cfg.contact || {}).email, 80) },
    privacyUrl: str(cfg.privacyUrl == null ? cur.privacyUrl : cfg.privacyUrl, 300)
  };
}

function adminSaveConfig(cfg) {
  return adminRun_(function (me, ss) {
    return adminLock_(function () {
      var cur = readConfig_(ss);
      var next = cleanConfig_(cfg, cur);
      var changes = configChanges_(cur, next);
      writeConfig_(ss, next, false);
      if (changes.length) adminLog_(ss, me, '설정변경', { changes: changes });
      return withRemaining_(next, readRegs_(ss), true);
    });
  }, '설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

/** kind: xlsx | csv | badge | stats | statsXlsx. 기록을 먼저 남기고, 남기지 못하면 파일용 행을 주지 않는다.
    명단 내보내기면 전체 번호(하이픈)가 든 행을 돌려준다. */
function adminLogExport(kind, filter) {
  return adminRun_(function (me, ss) {
    var kinds = ['xlsx', 'csv', 'badge', 'stats', 'statsXlsx'];
    if (kinds.indexOf(kind) < 0) throw rfwError_('VALIDATION', '내보내기 종류를 확인해 주세요.');
    var isStats = kind === 'stats' || kind === 'statsXlsx';
    var rows = isStats ? [] : adminFilter_(readRegs_(ss), filter);
    if (kind === 'badge') rows = rows.filter(function (r) { return r.status === 'active'; });
    var full = rows.map(function (r) { var o = publicRow_(r); o.phone = hyphenPhone_(r.phone); return o; });
    var entry = adminLog_(ss, me, '내보내기', {
      kind: kind, filterText: String((filter && filter.label) || (isStats ? '접수 통계' : '전체')).slice(0, 200), count: full.length
    });
    return { entry: entry, rows: full };
  }, '내보내기 기록을 남기지 못해 파일을 만들지 않았어요. 잠시 후 다시 시도해 주세요.');
}

function adminExportLog() {
  return adminRun_(function (me, ss) { return readAdminLog_(ss, '내보내기'); }, '내보내기 기록을 불러오지 못했어요.');
}
function adminConfigLog() {
  return adminRun_(function (me, ss) { return readAdminLog_(ss, '설정변경'); }, '설정 변경 기록을 불러오지 못했어요.');
}
function adminAccessLog() {
  return adminRun_(function (me, ss) { return readAdminLog_(ss, '로그인'); }, '로그인 기록을 불러오지 못했어요.');
}

/* ================= 운영 (편집기에서 실행) ================= */
/** 스크립트 속성을 확인만 한다. 문제가 있으면 한국어로 알려 주고 멈춘다. */
function setup() {
  var problems = [];
  if (!prop_('SHEET_ID')) problems.push('SHEET_ID 가 비어 있어요. 접수 DB 스프레드시트 주소의 /d/ 와 /edit 사이 값을 넣어 주세요.');
  var list = adminAllowlist_();
  if (!Object.keys(list).length) problems.push('ADMIN_EMAILS 가 비어 있어요. 관리자 구글 계정을 쉼표로 구분해 넣어 주세요.');
  // 이 함수도 웹앱에서 google.script.run 으로 불릴 수 있으므로 명단이 있으면 명단 안 계정만 실행
  else if (!adminMe_()) throw new Error('관리자 명단(ADMIN_EMAILS)에 있는 계정으로 실행해 주세요.');
  if (!problems.length) {
    var ss = rfwSpreadsheet_();
    Object.keys(RFW_HEADERS).forEach(function (name) {
      if (!ss.getSheetByName(name)) problems.push("'" + name + "' 탭이 없어요. api 프로젝트에서 setup() 을 먼저 실행해 주세요.");
    });
  }
  if (problems.length) throw new Error('설정을 확인해 주세요.\n- ' + problems.join('\n- '));

  Logger.log('설정이 맞아요. 관리자 ' + Object.keys(list).length + '명: ' + Object.keys(list).join(', '));
  return 'ok';
}

/** 보유 기간 만료 후 개인정보 파기 (편집기에서 수동 실행).
    이름·소속·휴대전화번호·토큰을 비우고 접수번호·일시·상태·참석일·언어·유입경로는 통계용으로 남긴다.
    변경이력의 이름·소속·번호 변경 내용도 지운다. 되돌릴 수 없으므로 두 겹으로 막는다:
    1) 실행 계정이 ADMIN_EMAILS 에 있어야 하고 2) 스크립트 속성 PURGE_CONFIRM = YES 일 때만 실행(실행 후 자동 삭제).
    백업 사본·드라이브 휴지통·내보낸 파일은 따로 지워야 한다. */
function purgePersonalData() {
  var me = adminMe_();
  if (!me) throw new Error('관리자 명단에 있는 계정으로 실행해 주세요.');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PURGE_CONFIRM') !== 'YES') {
    throw new Error('파기하려면 스크립트 속성 PURGE_CONFIRM 에 YES 를 넣고 다시 실행해 주세요. (되돌릴 수 없어요)');
  }
  props.deleteProperty('PURGE_CONFIRM');
  var ss = rfwSpreadsheet_();
  var result = adminLock_(function () {
    var sh = sheet_(ss, RFW_SHEET.REG);
    var rows = dataRows_(sh, 12), n = 0;
    rows.forEach(function (row) {
      if (!String(row[REG_COL.receiptNo]).trim()) return;
      row[REG_COL.name] = ''; row[REG_COL.org] = ''; row[REG_COL.phone] = ''; row[REG_COL.token] = '';
      n++;
    });
    if (rows.length) sh.getRange(2, 1, rows.length, 12).setValues(rows);

    var hsh = sheet_(ss, RFW_SHEET.HIST);
    var hrows = dataRows_(hsh, 6), hn = 0;
    hrows.forEach(function (row) {
      [4, 5].forEach(function (i) {
        var o = jsonParse_(cellStr_(row[i]), null);
        if (!o || typeof o !== 'object') return;
        var touched = false;
        ['name', 'org', 'phone'].forEach(function (k) { if (k in o) { delete o[k]; touched = true; } });
        if (touched) { row[i] = JSON.stringify(o); hn++; }
      });
    });
    if (hrows.length) hsh.getRange(2, 1, hrows.length, 6).setValues(hrows);
    return { rows: n, historyCells: hn };
  });
  adminLog_(ss, me, '파기', { count: result.rows, detail: '이름·소속·휴대전화번호·토큰 파기, 변경이력 ' + result.historyCells + '칸 정리' });
  Logger.log('파기했어요: 신청 ' + result.rows + '건, 변경이력 ' + result.historyCells + '칸');
  return result;
}
