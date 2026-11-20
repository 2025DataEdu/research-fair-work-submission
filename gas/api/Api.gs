/* 참가자 API — Apps Script 웹앱 (나로 실행, 액세스: 모든 사용자).
   Cloudflare Worker 만 호출한다. 본문: {action, k, ...payload} (docs/api.md).
   k 가 스크립트 속성 GAS_KEY 와 다르면 FORBIDDEN. 응답은 {ok:true,data} / {ok:false,code,message?,fields?}. */

var API_CONFIG_CACHE_KEY = 'cfg:public:v2';   // 설정 모양이 바뀌면 올린다(v2: 소속 구분·프로그램 id)
var API_CONFIG_CACHE_SEC = 30;      // 설정 응답 캐시. 관리자 설정 변경은 최대 30초 뒤 참가자 화면에 반영된다.
var API_PHONE_LIMIT = 5;            // 같은 번호로 10분에 신청·재발송 5회까지
var API_PHONE_WINDOW_SEC = 600;
var API_RESEND_GAP_SEC = 60;        // 같은 번호로 수정 링크 문자는 1분에 1번
var API_VISIT_FLUSH_MS = 60000;     // 방문수 캐시 → 시트 반영 간격

var API_MESSAGES = {
  FORBIDDEN: '허용되지 않은 요청이에요.',
  BAD_REQUEST: '요청 형식을 확인해 주세요.',
  VALIDATION: '입력한 내용을 확인해 주세요.',
  DUPLICATE: '이 휴대전화번호로 이미 신청했어요.',
  DAY_FULL: '선택한 참석일의 자리가 모두 찼어요.',
  CLOSED: '사전 접수가 마감됐어요.',
  RATE_LIMITED: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  INVALID_TOKEN: '신청 정보를 찾지 못했어요. 문자로 받은 링크를 다시 확인해 주세요.'
};

/* ================= 진입점 ================= */
function doPost(e) {
  var res;
  try {
    var body = jsonParse_(e && e.postData ? e.postData.contents : '', null);
    var key = prop_('GAS_KEY');
    if (!body || typeof body !== 'object' || !key || !safeEqual_(body.k, key)) {
      res = { ok: false, code: 'FORBIDDEN', message: API_MESSAGES.FORBIDDEN };
    } else {
      res = { ok: true, data: apiRoute_(String(body.action || ''), body) };
    }
  } catch (err) {
    res = errorEnvelope_(err);
    if (res.code !== 'SERVER' && !res.message && API_MESSAGES[res.code]) res.message = API_MESSAGES[res.code];
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

/** 주소를 직접 열었을 때 — 아무 정보도 주지 않는다. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, code: 'FORBIDDEN', message: API_MESSAGES.FORBIDDEN }))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiRoute_(action, p) {
  switch (action) {
    case 'config': return apiConfig_(p);
    case 'submit': return apiSubmit_(p);
    case 'lookup': return apiLookup_(p);
    case 'update': return apiUpdate_(p);
    case 'cancel': return apiCancel_(p);
    case 'resend': return apiResend_(p);
    default: throw rfwError_('BAD_REQUEST', API_MESSAGES.BAD_REQUEST);
  }
}
function apiFail_(code, extra) { return rfwError_(code, API_MESSAGES[code], extra); }

/* ================= config ================= */
function apiConfig_(p) {
  if (p.src) {
    try { visitHit_(normSrc_(p.src)); } catch (err) { console.warn('방문 집계 실패: ' + err); } // 집계 실패로 화면을 막지 않는다
  }
  var cache = CacheService.getScriptCache();
  var hit = cache.get(API_CONFIG_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  var ss = rfwSpreadsheet_();
  var cfg = withRemaining_(readConfig_(ss), readRegs_(ss), false);
  cache.put(API_CONFIG_CACHE_KEY, JSON.stringify(cfg), API_CONFIG_CACHE_SEC);
  return cfg;
}
function dropConfigCache_() { try { CacheService.getScriptCache().remove(API_CONFIG_CACHE_KEY); } catch (e) { /* 무시 */ } }

/* 방문수 집계.
   방문마다 시트를 고치면 시트 쓰기(수백 ms)가 신청 저장과 같은 잠금을 두고 다투게 된다.
   그래서 캐시에 날짜·유입경로별로 모아 두고(잠금은 캐시 읽기·쓰기 동안만, 수 ms) 시트에는 몰아서 더한다.
   반영 시점(모두 같은 스크립트 잠금 안):
   - 방문이 들어왔을 때 마지막 반영이 1분(API_VISIT_FLUSH_MS)보다 오래됐으면 바로 → 방문이 이어지는 동안 지연은 1분 안
   - 신청 저장 때 신청수와 같은 시트 쓰기로 → 신청이 그 신청을 만든 방문보다 먼저 잡히지 않는다
   - 매시간 트리거(flushVisits) → 마지막 방문 뒤 조용해진 경우의 꼬리
   반영할 때마다 방문집계 탭 G1 에 시각을 남긴다(관리자 화면 '마지막 반영').
   잠금을 1초 안에 못 잡거나 캐시가 비워지면 그 몇 건은 빠질 수 있다 — 방문수는 참고용 근사치다.
   신청수는 신청 저장 때 잠금 안에서 바로 시트에 더하므로 정확하다. */
function visitHit_(src) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var cache = CacheService.getScriptCache();
    var pending = jsonParse_(cache.get('visit:pending'), {}) || {};
    var key = kstDate_() + '|' + src;
    pending[key] = (pending[key] || 0) + 1;
    var last = Number(cache.get('visit:flushedAt') || 0);
    if (Date.now() - last > API_VISIT_FLUSH_MS) {
      addVisitCounts_(rfwSpreadsheet_(), visitDeltas_(pending), kstIso_());
      pending = {};
      cache.put('visit:flushedAt', String(Date.now()), 21600);
    }
    cache.put('visit:pending', JSON.stringify(pending), 21600);
  } finally {
    lock.releaseLock();
  }
}
function visitDeltas_(pending) {
  return Object.keys(pending).map(function (k) {
    var parts = k.split('|');
    return { date: parts[0], src: parts[1], visits: pending[k], apps: 0 };
  });
}
/** 잠금 안에서: 모아 둔 방문(아직 비우지 않음). 캐시 오류는 [] — 신청 저장을 막지 않는다. */
function pendingVisits_() {
  try { return visitDeltas_(jsonParse_(CacheService.getScriptCache().get('visit:pending'), {}) || {}); }
  catch (err) { console.warn('방문 캐시 읽기 실패: ' + err); return []; }
}
/** 잠금 안에서: 시트에 반영한 뒤 캐시를 비운다. */
function clearPendingVisits_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.put('visit:pending', '{}', 21600);
    cache.put('visit:flushedAt', String(Date.now()), 21600);
  } catch (err) { console.warn('방문 캐시 비우기 실패: ' + err); }
}
/** 모아 둔 방문수를 지금 시트에 반영 (편집기에서 수동 실행 또는 매시간 트리거). 모아 둔 것이 없어도 반영 시각은 남긴다. */
function flushVisits() {
  withLock_(function () {
    var cache = CacheService.getScriptCache();
    addVisitCounts_(rfwSpreadsheet_(), visitDeltas_(jsonParse_(cache.get('visit:pending'), {}) || {}), kstIso_());
    cache.put('visit:pending', '{}', 21600);
    cache.put('visit:flushedAt', String(Date.now()), 21600);
  });
}

/* ================= submit ================= */
function apiSubmit_(p) {
  // 허니팟: 사람에게는 보이지 않는 칸. 값이 있으면 저장하지 않고 성공한 척한다(모의 구현과 같은 응답).
  if (p.hp) {
    var str = function (v) { return v == null ? '' : String(v); };
    return { receiptNo: 'RF26-0000-0000', name: str(p.name), affType: str(p.affType), org: str(p.org), email: str(p.email),
      day: str(p.day), programs: Array.isArray(p.programs) ? p.programs.map(str) : [], token: '' };
  }

  var ss = rfwSpreadsheet_();
  var cfg0 = readConfig_(ss);
  if (isClosed_(cfg0)) throw apiFail_('CLOSED');
  var fields = validateReg_(p, true, cfg0);
  if (fields) throw apiFail_('VALIDATION', { fields: fields });
  var phone = normPhone_(p.phone);
  phoneThrottle_(phone);

  var reg = withLock_(function () {
    var cfg = readConfig_(ss);                      // 잠금 안에서 다시 읽어 마감·정원을 정확히 판단
    if (isClosed_(cfg)) throw apiFail_('CLOSED');
    var f2 = validateReg_(p, true, cfg);            // 그 사이 세부 프로그램·소속 구분이 바뀌었을 수 있다
    if (f2) throw apiFail_('VALIDATION', { fields: f2 });
    var regs = readRegs_(ss);
    if (activeRegs_(regs).some(function (r) { return r.phone === phone; })) throw apiFail_('DUPLICATE');
    if (isDayFull_(withRemaining_(cfg, regs, false), p.day)) throw apiFail_('DAY_FULL');
    var now = kstIso_();
    var r = {
      receiptNo: nextReceiptNo_(regs), createdAt: now, updatedAt: now, status: 'active',
      name: String(p.name).trim(), org: String(p.org).trim(), phone: phone, day: p.day,
      consentAt: now, lang: normLang_(p.lang), src: normSrc_(p.src), token: newToken_(),
      affType: p.affType, email: normEmail_(p.email), programs: cleanPrograms_(p.programs, p.day, cfg)
    };
    appendReg_(ss, r);
    var pendingVisits = pendingVisits_();           // 모아 둔 방문도 같은 시트 쓰기로 반영
    addVisitCounts_(ss, pendingVisits.concat([{ date: now.slice(0, 10), src: r.src, visits: 0, apps: 1 }]),
      pendingVisits.length ? now : null);
    if (pendingVisits.length) clearPendingVisits_();
    return r;
  });
  dropConfigCache_();
  sendSms_(reg.phone, confirmText_(reg));           // 잠금 밖에서. 실패해도 신청은 유지
  return { receiptNo: reg.receiptNo, name: reg.name, affType: reg.affType, org: reg.org, email: reg.email,
    day: reg.day, programs: reg.programs, token: reg.token };
}

/* ================= lookup / update / cancel ================= */
function tokenOk_(t) { return typeof t === 'string' && t.length >= 20 && t.length <= 200; }

function apiLookup_(p) {
  if (!tokenOk_(p.token)) throw apiFail_('INVALID_TOKEN');
  var r = findReg_(readRegs_(rfwSpreadsheet_()), 'token', p.token);
  if (!r) throw apiFail_('INVALID_TOKEN');
  return { receiptNo: r.receiptNo, name: r.name, affType: r.affType, org: r.org, phone: r.phone, email: r.email,
    day: r.day, programs: r.programs, status: r.status };
}

function apiUpdate_(p) {
  if (!tokenOk_(p.token)) throw apiFail_('INVALID_TOKEN');
  var ss = rfwSpreadsheet_();
  var out = withLock_(function () {
    var regs = readRegs_(ss);
    var r = findReg_(regs, 'token', p.token);
    if (!r || r.status !== 'active') throw apiFail_('INVALID_TOKEN');
    var cfg = readConfig_(ss);
    // 새 칸(소속 구분·이메일·세부 프로그램)이 빈 옛 신청도 새 규칙대로 채워야 저장된다
    var fields = validateReg_(p, false, cfg);
    if (fields) throw apiFail_('VALIDATION', { fields: fields });
    var phone = normPhone_(p.phone);
    if (activeRegs_(regs).some(function (x) { return x !== r && x.phone === phone; })) throw apiFail_('DUPLICATE');
    if (p.day !== r.day && isDayFull_(withRemaining_(cfg, regs, false), p.day)) throw apiFail_('DAY_FULL');
    var next = {
      name: String(p.name).trim(), affType: p.affType, org: String(p.org).trim(), phone: phone,
      email: normEmail_(p.email), day: p.day, programs: cleanPrograms_(p.programs, p.day, cfg)
    };
    var diff = diffReg_(r, next);
    if (diff.changed) {
      Object.keys(next).forEach(function (k) { r[k] = next[k]; });
      r.updatedAt = kstIso_();
      writeReg_(ss, r);
      appendHistory_(ss, { at: r.updatedAt, receiptNo: r.receiptNo, by: '본인', kind: '수정', before: diff.before, after: diff.after });
    }
    return { receiptNo: r.receiptNo, name: r.name, affType: r.affType, org: r.org, email: r.email, day: r.day, programs: r.programs };
  });
  dropConfigCache_();
  return out;
}

function apiCancel_(p) {
  if (!tokenOk_(p.token)) throw apiFail_('INVALID_TOKEN');
  var ss = rfwSpreadsheet_();
  var out = withLock_(function () {
    var r = findReg_(readRegs_(ss), 'token', p.token);
    if (!r || r.status !== 'active') throw apiFail_('INVALID_TOKEN');
    r.status = 'canceled';
    r.updatedAt = kstIso_();
    writeReg_(ss, r);
    appendHistory_(ss, { at: r.updatedAt, receiptNo: r.receiptNo, by: '본인', kind: '취소', before: { status: 'active' }, after: { status: 'canceled' } });
    return { receiptNo: r.receiptNo, status: 'canceled' };
  });
  dropConfigCache_();
  return out;
}

/* ================= resend ================= */
// 번호가 있는지 없는지 드러나지 않게 언제나 {sent:true}. 형식이 틀린 번호·횟수 초과도 조용히 넘어간다.
function apiResend_(p) {
  var phone = normPhone_(p.phone);
  if (!RFW_PHONE_RE.test(phone)) return { sent: true };
  var cache = CacheService.getScriptCache();
  var gapKey = 'resend:' + phone;
  if (cache.get(gapKey)) return { sent: true };
  try { phoneThrottle_(phone); } catch (e) { return { sent: true }; }
  cache.put(gapKey, '1', API_RESEND_GAP_SEC);
  var r = activeRegs_(readRegs_(rfwSpreadsheet_())).filter(function (x) { return x.phone === phone; })[0];
  if (r) sendSms_(r.phone, linkText_(r));
  return { sent: true };
}

/* 같은 번호 요청 횟수 제한 (IP 제한은 Worker 가 한다). 캐시 증가가 원자적이지 않아 동시 요청에서는 조금 느슨할 수 있다. */
function phoneThrottle_(phone) {
  var cache = CacheService.getScriptCache();
  var key = 'tp:' + phone;
  var n = Number(cache.get(key) || 0);
  if (n >= API_PHONE_LIMIT) throw apiFail_('RATE_LIMITED');
  cache.put(key, String(n + 1), API_PHONE_WINDOW_SEC);
}

/* ================= 문자 ================= */
var API_DAY_TEXT = {
  ko: { day1: '12. 22.(화)', day2: '12. 23.(수)', both: '12. 22.(화)~23.(수) 양일' },
  en: { day1: 'Dec 22 (Tue)', day2: 'Dec 23 (Wed)', both: 'Dec 22-23 (both days)' }
};
function editLink_(r) { return String(prop_('SITE_URL')).replace(/\/+$/, '') + '/?t=' + encodeURIComponent(r.token); }
function confirmText_(r) {
  if (r.lang === 'en') {
    return '[2026 JBNU-BK Research Fair Week] ' + r.name + ', your registration is confirmed. No. ' + r.receiptNo +
      ' / ' + API_DAY_TEXT.en[r.day] + '. Edit or cancel: ' + editLink_(r);
  }
  return '[2026 JBNU-BK 리서치페어 위크] ' + r.name + '님, 신청이 접수됐어요. 접수번호 ' + r.receiptNo +
    ' / 참석일 ' + API_DAY_TEXT.ko[r.day] + '. 수정·취소: ' + editLink_(r);
}
function linkText_(r) {
  if (r.lang === 'en') return '[2026 JBNU-BK Research Fair Week] Your link to edit or cancel (' + r.receiptNo + '): ' + editLink_(r);
  return '[2026 JBNU-BK 리서치페어 위크] 신청 확인·수정·취소 링크예요(' + r.receiptNo + '). ' + editLink_(r);
}

/** 문자 발송. SMS_PROVIDER 가 비어 있으면 로그만 남기는 스텁(성공으로 본다). 실패해도 예외를 던지지 않는다. */
function sendSms_(phone, text) {
  var provider = prop_('SMS_PROVIDER');
  if (!provider) {
    Logger.log('[문자 스텁] ' + maskPhone_(phone) + ' ← ' + text);
    return true;
  }
  try {
    return smsProviderSend_(provider, phone, text) === true;
  } catch (err) {
    console.error('문자 발송 실패(' + provider + ', ' + maskPhone_(phone) + '): ' + err);
    return false;
  }
}
/* TODO(문자 연동): 발송 업체가 정해지면 여기만 채운다.
   - UrlFetchApp.fetch 로 업체 API 호출 (발신번호·API 키는 스크립트 속성 SMS_SENDER, SMS_API_KEY 등으로)
   - gas/api/appsscript.json oauthScopes 에 "https://www.googleapis.com/auth/script.external_request" 추가
   - 성공 시 true 를 돌려준다 */
function smsProviderSend_(provider, phone, text) {
  throw new Error('문자 발송 업체 "' + provider + '" 연동이 아직 구현되지 않았어요.');
}

/* ================= 운영 (편집기에서 실행) ================= */
/** 한 번 실행. 여러 번 실행해도 안전: 탭·머리행·기본 설정을 만들고, SHEET_ID·GAS_KEY 가 없으면 채운다. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHEET_ID')) {
    var active = SpreadsheetApp.getActiveSpreadsheet();   // api 프로젝트는 '2026 RFW 접수 DB' 시트에 묶인 스크립트
    if (!active) throw new Error('SHEET_ID 가 비어 있고 연결된 스프레드시트도 없어요. 스크립트 속성에 SHEET_ID 를 넣어 주세요.');
    props.setProperty('SHEET_ID', active.getId());
    Logger.log('SHEET_ID 를 연결된 스프레드시트로 채웠어요.');
  }
  var made = setupSheets_(rfwSpreadsheet_());
  Logger.log(made.length ? '새로 만든 것: ' + made.join(', ') : '탭은 모두 있어요. 서식만 다시 맞췄어요.');
  if (!props.getProperty('GAS_KEY')) {
    var key = newToken_() + newToken_().slice(0, 21);
    props.setProperty('GAS_KEY', key);
    Logger.log('GAS_KEY 를 만들었어요. Worker 비밀값(GAS_KEY)에 이 값을 넣어 주세요: ' + key);
  } else {
    Logger.log('GAS_KEY 는 이미 있어요(바꾸려면 스크립트 속성에서 지우고 다시 실행).');
  }
  if (!props.getProperty('SITE_URL')) Logger.log('주의: SITE_URL 이 비어 있어요. 문자 속 수정 링크가 /?t=… 로만 나가요.');
}

/** 매일 새벽 3시 백업, 매시간 방문수 반영 트리거를 만든다. 다시 실행하면 기존 것을 지우고 새로 만든다. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'backupSpreadsheet' || fn === 'flushVisits') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSpreadsheet').timeBased().everyDays(1).atHour(3).inTimezone('Asia/Seoul').create();
  ScriptApp.newTrigger('flushVisits').timeBased().everyHours(1).create();
  Logger.log('트리거를 만들었어요: backupSpreadsheet(매일 03시), flushVisits(매시간)');
}

/** 스프레드시트 사본을 만든다(실행한 계정의 내 드라이브 최상위). Drive 권한 없이 되는 Spreadsheet.copy 를 쓴다.
    사본에도 개인정보가 들어 있으니 보유 기간이 끝나면 사본도 같이 지워야 한다(docs/deploy-gas.md). */
function backupSpreadsheet() {
  var ss = rfwSpreadsheet_();
  var copy = ss.copy(ss.getName() + ' 백업 ' + kstIso_().slice(0, 16).replace('T', ' '));
  Logger.log('백업 사본: ' + copy.getId());
}
