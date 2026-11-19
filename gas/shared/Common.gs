/* 공통 유틸 — api·admin 두 프로젝트에 같이 들어간다.
   Apps Script 는 모든 .gs 파일이 전역 범위 하나를 공유하고, admin 웹앱에서는 밑줄로 끝나지 않는
   전역 함수를 누구나 google.script.run 으로 부를 수 있다. 그래서 이 폴더의 함수는 모두 밑줄(_)로 끝낸다. */

var RFW_PHONE_RE = /^01[016789]\d{7,8}$/;
var RFW_DAYS = ['day1', 'day2', 'both'];
var RFW_SRCS = ['sms', 'qr', 'web', 'direct'];
var RFW_LANGS = ['ko', 'en'];
var RFW_KST_MS = 9 * 3600000;

/* ---------- 시각 (KST 고정, '+09:00' 붙인 ISO 문자열) ---------- */
function rfwPad_(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

/** ms(기본: 지금) → '2026-12-01T10:12:00+09:00' */
function kstIso_(ms) {
  var d = new Date((ms == null ? Date.now() : ms) + RFW_KST_MS);
  return d.toISOString().slice(0, 19) + '+09:00';
}
/** ms(기본: 지금) → '2026-12-01' (KST 날짜) */
function kstDate_(ms) { return kstIso_(ms).slice(0, 10); }

/** 시트 셀 값 → ISO 문자열. 사람이 시트에서 고쳐 Date 로 바뀐 셀도 KST ISO 로 돌려놓는다. */
function cellIso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : kstIso_(v.getTime());
  return v == null ? '' : String(v);
}

/* ---------- 문자열·셀 ---------- */
function cellStr_(v) {
  if (v == null) return '';
  var s = String(v);
  // 수식 주입 방지로 앞에 붙인 작은따옴표가 그대로 읽히는 경우 대비
  if (/^'[=+\-@]/.test(s)) s = s.slice(1);
  return s;
}
/** 시트에 쓸 사용자 입력 문자열: = + - @ 로 시작하면 수식으로 해석되지 않게 작은따옴표를 붙인다. */
function safeCell_(s) {
  s = s == null ? '' : String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function jsonParse_(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}
function clone_(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function toBool_(v, dflt) {
  if (v === true || v === false) return v;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return dflt;
  return s === 'true' || s === '1' || s === 'y' || s === 'yes' || s === 'o' || s === '예';
}

/* ---------- 휴대전화번호 ---------- */
/** 입력값 → 숫자만. 국가번호 82 로 시작하면 0 으로 바꾼다(+82 10-…, +82 010-… 모두). */
function normPhone_(s) {
  var d = String(s == null ? '' : s).replace(/\D/g, '');
  if (/^82/.test(d)) d = ('0' + d.slice(2)).replace(/^00/, '0');
  return d;
}
/** 시트 셀 → 번호. 셀이 숫자로 바뀌어 앞자리 0 이 빠진 경우(1012345678)도 복구한다. */
function cellPhone_(v) {
  var s = String(v == null ? '' : v).replace(/\D/g, '');
  if (/^1[016789]\d{7,8}$/.test(s)) s = '0' + s;
  return s;
}
function maskPhone_(p) { p = String(p || ''); return p ? p.slice(0, 3) + '-****-' + p.slice(-4) : ''; }
function hyphenPhone_(p) {
  p = String(p || '');
  return p.length === 11 ? p.slice(0, 3) + '-' + p.slice(3, 7) + '-' + p.slice(7) : p.slice(0, 3) + '-' + p.slice(3, 6) + '-' + p.slice(6);
}

/* ---------- 토큰 · 키 ---------- */
/** 수정 링크용 토큰: UUID 두 개(무작위 244비트)를 SHA-256 으로 섞어 base64url 43자. */
function newToken_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Date.now(), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
/** 비밀값 비교 (글자마다 끊지 않고 끝까지 비교) */
function safeEqual_(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (!a || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- 이메일 ---------- */
var RFW_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function normEmail_(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function emailOk_(e) { return e.length <= 100 && RFW_EMAIL_RE.test(e); }
/** 'abcd@example.com' → 'ab***@example.com' (@ 앞 2자만 보인다) */
function maskEmail_(e) {
  e = String(e || '');
  if (!e) return '';
  var at = e.indexOf('@');
  if (at < 0) return e.slice(0, 2) + '***';
  return e.slice(0, Math.min(2, at)) + '***' + e.slice(at);
}

/* ---------- 소속 구분 · 세부 프로그램 ---------- */
function affTypeOk_(v, cfg) {
  var list = (cfg && cfg.affiliations) || [];
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === v) return true;
  return false;
}
/** 참석일 → 그날(양일이면 두 날) 세부 프로그램 id 목록 [{day, ids}] (설정 순서) */
function programDays_(cfg, day) {
  var days = day === 'both' ? ['day1', 'day2'] : [day];
  return days.map(function (d) {
    var items = ((cfg.program || {})[d] || {}).items || [];
    return { day: d, ids: items.map(function (it) { return it.id; }) };
  });
}
/** 고른 프로그램 검사. 맞으면 중복 없이 설정 순서(22일 먼저)로 정렬한 배열, 틀리면 null.
    고른 날에 속한 id 만 허용하고, 그날 항목이 하나라도 있으면 그날 것을 최소 1개 골라야 한다. */
function cleanPrograms_(list, day, cfg) {
  if (list == null) list = [];
  if (!Array.isArray(list)) return null;
  var picked = {};
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string') return null;
    picked[list[i]] = true;
  }
  var out = [], used = 0;
  var groups = programDays_(cfg, day);
  for (var g = 0; g < groups.length; g++) {
    var n = 0;
    groups[g].ids.forEach(function (id) { if (picked[id]) { out.push(id); n++; } });
    if (groups[g].ids.length && !n) return null;
    used += n;
  }
  return used === Object.keys(picked).length ? out : null;   // 다른 날·없는 id 가 섞이면 거부
}

/* ---------- 검증 (web/js/api.js 모의 구현과 같은 규칙) ---------- */
/** cfg: 소속 구분·세부 프로그램 확인용 설정(readConfig_). 없으면 기본 설정. */
function validateReg_(p, needConsent, cfg) {
  cfg = cfg || RFW_DEFAULT_CONFIG;
  var f = {};
  var name = String(p.name == null ? '' : p.name).trim();
  var org = String(p.org == null ? '' : p.org).trim();
  if (!name || name.length > 40) f.name = true;
  if (!affTypeOk_(p.affType, cfg)) f.affType = true;
  if (!org || org.length > 60) f.org = true;
  if (!RFW_PHONE_RE.test(normPhone_(p.phone))) f.phone = true;
  if (!emailOk_(normEmail_(p.email))) f.email = true;
  if (RFW_DAYS.indexOf(p.day) < 0) f.day = true;
  else if (!cleanPrograms_(p.programs, p.day, cfg)) f.programs = true;
  if (needConsent && p.consent !== true) f.consent = true;
  return Object.keys(f).length ? f : null;
}
function normSrc_(s) { s = String(s || '').toLowerCase(); return RFW_SRCS.indexOf(s) >= 0 ? s : 'direct'; }
function normLang_(s) { s = String(s || '').toLowerCase(); return RFW_LANGS.indexOf(s) >= 0 ? s : 'ko'; }

/* ---------- 오류 ---------- */
/** 처리 중 의도한 실패를 던질 때 쓴다. 바깥에서 {ok:false, code, message, ...extra} 로 바꾼다. */
function rfwError_(code, message, extra) {
  var e = new Error(message || code);
  e.rfwCode = code;
  e.rfwExtra = extra || null;
  return e;
}
function errorEnvelope_(err, fallbackMessage) {
  if (err && err.rfwCode) {
    var out = { ok: false, code: err.rfwCode };
    if (err.message && err.message !== err.rfwCode) out.message = err.message;
    if (err.rfwExtra) for (var k in err.rfwExtra) out[k] = err.rfwExtra[k];
    return out;
  }
  console.error(err && err.stack ? err.stack : err);
  return { ok: false, code: 'SERVER', message: fallbackMessage || '처리하지 못했어요. 잠시 후 다시 시도해 주세요.' };
}

/* ---------- 스크립트 속성 · 잠금 ---------- */
function prop_(key) { return PropertiesService.getScriptProperties().getProperty(key) || ''; }

/** 스크립트 잠금 안에서 fn 실행. 잠금을 못 잡으면 SERVER(혼잡) 오류. */
function withLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 20000)) throw rfwError_('SERVER', '신청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}
