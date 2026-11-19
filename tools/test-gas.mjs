// Apps Script 백엔드 테스트 (의존성 없음): node tools/test-gas.mjs [-v]
// gas/shared/*.gs + gas/api/Api.gs 를 'api' vm 컨텍스트에, gas/shared/*.gs + gas/admin/AdminApi.gs 를 'admin' 컨텍스트에 올린다.
// 두 프로젝트는 setup()·doGet() 처럼 같은 이름의 전역 함수를 가지므로 실제처럼 따로 띄우고,
// 스프레드시트 하나(가짜)만 같이 쓴다. 스크립트 속성·캐시·잠금은 실제와 같이 프로젝트마다 따로다.
// 가짜 시트는 실제 시트의 함정을 흉내 낸다: 글자 서식(@)이 아닌 칸에 숫자 문자열을 쓰면 숫자로 바뀌고(앞자리 0 사라짐),
// = 로 시작하는 문자열은 수식이 되므로 오류로 잡는다. '신청' 탭 데이터 행은 잠금 없이 쓰면 오류.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('-v');

/* =================== 가짜 Google 서비스 =================== */
const shared = { locksHeld: 0, books: new Map() };

class FakeRange {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`범위 오류 getRange(${r},${c},${nr},${nc}) — 실제 시트도 0행 범위는 예외`);
    if (r + nr - 1 > sheet.maxRows) throw new Error(`범위가 시트 크기(${sheet.maxRows}행)를 넘어요: ${r}+${nr}`);
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.get(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) {
      throw new Error(`setValues 크기 불일치: 범위 ${this.nr}x${this.nc}, 값 ${vals.length}x${vals[0] && vals[0].length}`);
    }
    this.sheet.guard(this.r, this.nr);
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    this.sheet.guard(this.r, this.nr);
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.cells.delete(`${this.r + i},${this.c + j}`);
    return this;
  }
  setNumberFormat(f) { this.sheet.formats.push({ r1: this.r, r2: this.r + this.nr - 1, c1: this.c, c2: this.c + this.nc - 1, f }); return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.cells = new Map(); this.formats = []; this.maxRows = 1000; this.frozen = 0; }
  fmt(r, c) { for (let i = this.formats.length - 1; i >= 0; i--) { const x = this.formats[i]; if (r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2) return x.f; } return ''; }
  get(r, c) { const v = this.cells.get(`${r},${c}`); return v === undefined ? '' : v; }
  set(r, c, v) {
    if (v === null || v === undefined) v = '';
    if (typeof v === 'string') {
      if (v.startsWith("'")) v = v.slice(1);                       // 작은따옴표 = 글자로 강제, 표시·읽기에는 빠짐
      else if (v.startsWith('=')) throw new Error(`수식이 써졌어요(${this.name} ${r},${c}): ${v}`);
      else if (this.fmt(r, c) !== '@') {                            // 자동 서식: 숫자·참거짓 문자열은 값이 바뀐다
        if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
        else if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
      }
    }
    if (v === '') this.cells.delete(`${r},${c}`); else this.cells.set(`${r},${c}`, v);
  }
  guard(r, nr) {
    if (this.name === '신청' && r + nr - 1 >= 2 && shared.locksHeld === 0) throw new Error("'신청' 탭 데이터를 잠금 없이 썼어요");
  }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0])); return m; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  appendRow(row) {
    const r = this.getLastRow() + 1;
    this.guard(r, 1);
    if (r > this.maxRows) this.maxRows = r;
    row.forEach((v, j) => this.set(r, j + 1, v));
    return this;
  }
  setFrozenRows(n) { this.frozen = n; }
  getName() { return this.name; }
}

class FakeBook {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = new Map(); shared.books.set(id, this); }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { if (this.sheets.has(n)) throw new Error('이미 있는 탭: ' + n); const s = new FakeSheet(n); this.sheets.set(n, s); return s; }
  copy(name) {
    const b = new FakeBook('copy-' + crypto.randomUUID(), name);
    for (const [n, s] of this.sheets) { const t = b.insertSheet(n); t.cells = new Map(s.cells); t.maxRows = s.maxRows; }
    return b;
  }
}

function makeProject(name, files, opts) {
  const props = new Map(Object.entries(opts.props || {}));
  const cache = new Map();
  const logs = [];
  const state = { user: '', lockOwned: 0 };
  const triggers = [];
  const ctx = {
    console: {
      log: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' '))
    },
    Logger: { log: (s) => { logs.push(String(s)); } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
        put: (k, v, ttl = 600) => {
          if (typeof v !== 'string') throw new Error('CacheService 값은 문자열만');
          if (ttl > 21600) throw new Error('CacheService TTL 최대 21600초');
          cache.set(k, { v, exp: Date.now() + ttl * 1000 });
        },
        remove: (k) => { cache.delete(k); }
      })
    },
    LockService: {
      getScriptLock: () => {
        let mine = false;
        return {
          tryLock: () => { if (state.lockOwned) return false; state.lockOwned = 1; shared.locksHeld++; mine = true; return true; },
          waitLock: () => { if (state.lockOwned) throw new Error('잠금 시간 초과'); state.lockOwned = 1; shared.locksHeld++; mine = true; },
          releaseLock: () => { if (mine) { mine = false; state.lockOwned = 0; shared.locksHeld--; } },
          hasLock: () => mine
        };
      }
    },
    SpreadsheetApp: {
      openById: (id) => { const b = shared.books.get(id); if (!b) throw new Error('스프레드시트 없음: ' + id); return b; },
      getActiveSpreadsheet: () => (opts.boundTo ? shared.books.get(opts.boundTo) : null)
    },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput: (s) => ({ content: String(s), mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } })
    },
    HtmlService: {
      createHtmlOutputFromFile: (f) => htmlOut({ file: f }),
      createHtmlOutput: (h) => htmlOut({ html: String(h) })
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.user }),
      getEffectiveUser: () => ({ getEmail: () => state.user })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => {
        if (alg !== 'SHA_256') throw new Error('지원하지 않는 알고리즘');
        return Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b));
      },
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      sleep: () => {}
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => {
        const t = { fn, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, everyDays: () => b, everyHours: () => b, atHour: () => b, inTimezone: () => b, create: () => { triggers.push(t); return t; } };
        return b;
      }
    }
  };
  function htmlOut(o) {
    return Object.assign(o, { title: '', metas: {}, setTitle(t) { this.title = t; return this; }, addMetaTag(k, v) { this.metas[k] = v; return this; } });
  }
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return { name, ctx, props, cache, logs, state, triggers };
}

/* =================== 테스트 도구 =================== */
let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  ok  ' + label); }
  else { failed++; failures.push(label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n# ' + t); }
const plain = (x) => JSON.parse(JSON.stringify(x));
const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x;
const deepEq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function hasDate(x) {
  if (x instanceof Date || Object.prototype.toString.call(x) === '[object Date]') return true;
  if (x && typeof x === 'object') return Object.values(x).some(hasDate);
  return false;
}
// 키 경로 모음: 배열은 모든 원소의 합집합. before/after 같은 자유 형식은 그 아래로 내려가지 않는다.
function paths(x, pre = '', stop = ['before', 'after'], out = new Set()) {
  if (Array.isArray(x)) { out.add(pre + '[]'); x.forEach((v) => paths(v, pre + '[]', stop, out)); return out; }
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) { const p = pre ? pre + '.' + k : k; out.add(p); if (!stop.includes(k)) paths(x[k], p, stop, out); }
  }
  return out;
}
function sameShape(label, ours, mock) {
  const a = paths(ours), b = paths(mock);
  const missing = [...b].filter((p) => !a.has(p)), extra = [...a].filter((p) => !b.has(p));
  check(label, !missing.length && !extra.length, { missing, extra });
}

/* =================== 준비 =================== */
const SHEET_ID = 'sheet-test-1';
new FakeBook(SHEET_ID, '2026 RFW 접수 DB');
const SHARED = fs.readdirSync(path.join(ROOT, 'gas/shared')).filter((f) => f.endsWith('.gs')).sort().map((f) => 'gas/shared/' + f);
const api = makeProject('api', [...SHARED, 'gas/api/Api.gs'], { boundTo: SHEET_ID, props: { SITE_URL: 'https://rfw.example/' } });
const ADMIN = 'ops@example.com';
const admin = makeProject('admin', [...SHARED, 'gas/admin/AdminApi.gs'], {
  props: { SHEET_ID, ADMIN_EMAILS: ` ${ADMIN.toUpperCase()}:운영팀 , bk21@example.com` }
});
const book = shared.books.get(SHEET_ID);
const tab = (n) => book.getSheetByName(n);

function post(body, key) {
  const k = key === undefined ? api.props.get('GAS_KEY') : key;
  const out = api.ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(Object.assign({ k }, body)) } });
  check('응답 MIME 은 JSON', out.mime === 'JSON');
  return JSON.parse(out.getContent());
}
function as(user) { admin.state.user = user; }
function A(fn, ...args) {
  const res = admin.ctx[fn](...args);
  check(`${fn}: Date 객체 없음·JSON 안전`, !hasDate(res) && deepEq(plain(res), res));
  return plain(res);
}
const kstNow = () => new Date(Date.now() + 9 * 3600000).toISOString();
const MMDD = kstNow().slice(5, 7) + kstNow().slice(8, 10);
let phoneSeq = 10000000;
const newPhone = () => '0105' + String(phoneSeq++).slice(1);   // 01050000000, 01050000001, …
let mailSeq = 0;
const PROGS = { day1: ['d1-1'], day2: ['d2-1'], both: ['d1-1', 'd2-1'] };   // 참석일마다 고른 세부 프로그램 기본값
const person = (o = {}) => {
  const p = Object.assign({ name: '김전북', affType: 'grad', org: '전북대학교 대학원', phone: newPhone(), email: `user${++mailSeq}@example.com`,
    day: 'day1', consent: true, lang: 'ko', src: 'web', hp: '' }, o);
  if (!('programs' in o)) p.programs = (PROGS[p.day] || []).slice();
  return p;
};

/* =================== 1. 공통 유틸 =================== */
section('공통 유틸');
{
  const c = api.ctx;
  check('normPhone_ 하이픈', c.normPhone_('010-1234-5678') === '01012345678');
  check('normPhone_ +82 10', c.normPhone_('+82 10-1234-5678') === '01012345678');
  check('normPhone_ +82 010', c.normPhone_('+82 010 1234 5678') === '01012345678');
  check('PHONE_RE 거부 02', !c.RFW_PHONE_RE.test(c.normPhone_('02-123-4567')));
  check('cellPhone_ 숫자로 바뀐 칸 복구', c.cellPhone_(1012345678) === '01012345678');
  check('maskPhone_', c.maskPhone_('01012345678') === '010-****-5678');
  check('hyphenPhone_ 10자리', c.hyphenPhone_('0111234567') === '011-123-4567');
  const iso = c.kstIso_(Date.parse('2026-12-01T00:30:00Z'));
  check('kstIso_ +09:00', iso === '2026-12-01T09:30:00+09:00', iso);
  const t = c.newToken_();
  check('토큰 32자 이상·URL 안전', t.length >= 32 && /^[A-Za-z0-9_-]+$/.test(t), t);
  check('토큰 매번 다름', t !== c.newToken_());
}

/* =================== 2. setup =================== */
section('api setup()');
api.ctx.setup();
check('SHEET_ID 를 연결된 시트로 채움', api.props.get('SHEET_ID') === SHEET_ID);
check('GAS_KEY 생성(32자 이상)', (api.props.get('GAS_KEY') || '').length >= 32);
for (const n of ['신청', '변경이력', '설정', '프로그램', '관리자로그', '방문집계']) {
  check(`탭 ${n} 머리행·고정`, tab(n) && tab(n).get(1, 1) !== '' && tab(n).frozen === 1);
}
check('신청 머리행 15열', deepEq(tab('신청').getRange(1, 1, 1, 15).getValues()[0], ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '개인정보동의시각', '언어', '유입경로', '토큰', '소속구분', '이메일', '세부프로그램']));
check('프로그램 머리행 9열(ID)', deepEq(tab('프로그램').getRange(1, 1, 1, 9).getValues()[0], ['날짜', '시간', '국문', '영문', '장소', '장소(영문)', '강조', '연사', 'ID']));
check('프로그램 ID 기본값', deepEq(tab('프로그램').getRange(2, 9, 6, 1).getValues().map((r) => r[0]), ['d1-1', 'd1-2', 'd1-3', 'd2-1', 'd2-2', 'd2-3']));
check('설정 affiliations 항목', tab('설정').getRange(2, 1, tab('설정').getLastRow() - 1, 1).getValues().some((r) => r[0] === 'affiliations'));
const confRows = tab('설정').getLastRow(), progRows = tab('프로그램').getLastRow();
check('프로그램 기본 6행', progRows === 7, progRows);
const key1 = api.props.get('GAS_KEY');
api.ctx.setup();
check('setup 재실행: 설정·프로그램 그대로, 키 유지', tab('설정').getLastRow() === confRows && tab('프로그램').getLastRow() === progRows && api.props.get('GAS_KEY') === key1);

section('admin setup()');
as(ADMIN);
check('admin setup 통과', admin.ctx.setup() === 'ok');
{
  const p = admin.props.get('SHEET_ID'); admin.props.delete('SHEET_ID');
  let msg = ''; try { admin.ctx.setup(); } catch (e) { msg = e.message; }
  check('admin setup: SHEET_ID 없으면 한국어 오류', /SHEET_ID 가 비어 있어요/.test(msg), msg);
  admin.props.set('SHEET_ID', p);
}

/* =================== 3. 키 =================== */
section('비밀키');
check('키 틀림 → FORBIDDEN', post({ action: 'config' }, 'nope').code === 'FORBIDDEN');
check('키 없음 → FORBIDDEN', post({ action: 'config' }, null).code === 'FORBIDDEN');
check('JSON 아님 → FORBIDDEN', post('not json').code === 'FORBIDDEN');
check('doGet → FORBIDDEN', JSON.parse(api.ctx.doGet().getContent()).code === 'FORBIDDEN');
check('모르는 action → BAD_REQUEST', post({ action: 'drop' }).code === 'BAD_REQUEST');

/* =================== 4. config =================== */
section('config');
{
  const web = { window: {}, location: { hostname: 'localhost' } }; vm.createContext(web);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/config.js'), 'utf8'), web);
  const res = post({ action: 'config', src: 'sms' });
  check('config ok', res.ok === true);
  check('config = web/js/config.js RFW_CONFIG (시드)', deepEq(res.data, plain(web.window.RFW_CONFIG)), res.data);
  const v = tab('방문집계').getRange(2, 1, 1, 4).getValues()[0];
  check('방문집계: 첫 방문 바로 반영', v[0] === kstNow().slice(0, 10) && v[1] === 'sms' && v[2] === 1, v);
  post({ action: 'config', src: 'sms' }); post({ action: 'config', src: 'evil<script>' });
  api.ctx.flushVisits();
  const rows = tab('방문집계').getRange(2, 1, tab('방문집계').getLastRow() - 1, 4).getValues();
  check('방문집계: 모아 둔 방문 flush, 모르는 src → direct', rows.find((r) => r[1] === 'sms')[2] === 2 && rows.find((r) => r[1] === 'direct')[2] === 1, rows);
}

/* =================== 5. submit =================== */
section('submit');
const p1 = person({ name: '  홍길동 ', phone: '010-1234-5678', email: ' Hong.GD@Example.COM ', day: 'both', programs: ['d2-1', 'd1-3', 'd1-1', 'd1-3'], src: 'sms' });
const s1 = post({ action: 'submit', ...p1 });
check('신청 성공', s1.ok === true, s1);
check('접수번호 RF26-MMDD-0001', s1.data.receiptNo === `RF26-${MMDD}-0001`, s1.data.receiptNo);
check('응답 모양 {receiptNo,name,affType,org,email,day,programs,token}', deepEq(Object.keys(s1.data).sort(), ['affType', 'day', 'email', 'name', 'org', 'programs', 'receiptNo', 'token']));
check('이메일 trim·소문자', s1.data.email === 'hong.gd@example.com', s1.data.email);
check('세부 프로그램 중복 제거·설정 순서', deepEq(s1.data.programs, ['d1-1', 'd1-3', 'd2-1']), s1.data.programs);
check('이름 앞뒤 공백 제거', s1.data.name === '홍길동');
check('토큰 32자 이상', s1.data.token.length >= 32);
{
  const row = tab('신청').getRange(2, 1, 1, 15).getValues()[0];
  check('시트: 소속구분·이메일·세부프로그램(쉼표)', row[12] === 'grad' && row[13] === 'hong.gd@example.com' && row[14] === 'd1-1,d1-3,d2-1', row.slice(12));
  check('시트: 번호는 0 으로 시작하는 문자열', row[6] === '01012345678', row[6]);
  check('시트: 상태 신청, 시각 +09:00', row[3] === '신청' && /\+09:00$/.test(row[1]), row);
  const v = tab('방문집계').getRange(2, 1, tab('방문집계').getLastRow() - 1, 4).getValues().find((r) => r[1] === 'sms');
  check('방문집계 신청수 +1', v[3] === 1, v);
  check('확인 문자(스텁) 로그에 수정 링크', api.logs.some((l) => l.includes('[문자 스텁] 010-****-5678') && l.includes('https://rfw.example/?t=' + s1.data.token)));
}
const s2 = post({ action: 'submit', ...person({ phone: '+82 10-1234-5678' }) });
check('같은 번호(+82 표기) → DUPLICATE', s2.code === 'DUPLICATE', s2);
const s3 = post({ action: 'submit', name: '', org: 'x'.repeat(61), phone: '010-12', day: 'day9', consent: false });
check('검증 → VALIDATION + fields 7개(참석일이 틀리면 프로그램은 보지 않음)', s3.code === 'VALIDATION' && deepEq(s3.fields, { name: true, affType: true, org: true, phone: true, email: true, day: true, consent: true }), s3);
const s3b = post({ action: 'submit', ...person({ day: 'day1', programs: ['d2-1'] }) });
check('다른 날 프로그램 → VALIDATION fields.programs', s3b.code === 'VALIDATION' && deepEq(s3b.fields, { programs: true }), s3b);
check('오류에 한국어 message', typeof s3.message === 'string' && /[가-힣]/.test(s3.message));
{
  const before = tab('신청').getLastRow();
  const h = post({ action: 'submit', ...person({ hp: 'http://spam' }) });
  check('허니팟: 성공처럼 응답', h.ok === true && h.data.receiptNo === 'RF26-0000-0000' && h.data.token === '');
  check('허니팟: 응답 모양 같음', deepEq(Object.keys(h.data).sort(), Object.keys(s1.data).sort()) && Array.isArray(h.data.programs), h.data);
  const h2 = post({ action: 'submit', hp: 'x' });
  check('허니팟: 빈 본문도 같은 모양', h2.ok && deepEq(Object.keys(h2.data).sort(), Object.keys(s1.data).sort()) && deepEq(h2.data.programs, []), h2);
  check('허니팟: 저장 안 함', tab('신청').getLastRow() === before);
}
const s4 = post({ action: 'submit', ...person({ name: '=HYPERLINK("http://x","y")', org: '+org', src: 'qr' }) });
check('수식 같은 이름도 저장(작은따옴표 처리)', s4.ok === true, s4);
check('접수번호 일련 0002', s4.data.receiptNo === `RF26-${MMDD}-0002`);
check('수식 이름 그대로 조회', post({ action: 'lookup', token: s4.data.token }).data.name === '=HYPERLINK("http://x","y")');

/* =================== 6. lookup/update/cancel =================== */
section('lookup · update · cancel');
{
  const t = s1.data.token;
  const l = post({ action: 'lookup', token: t });
  check('lookup', l.ok && deepEq(l.data, { receiptNo: s1.data.receiptNo, name: '홍길동', affType: 'grad', org: p1.org, phone: '01012345678', email: 'hong.gd@example.com', day: 'both', programs: ['d1-1', 'd1-3', 'd2-1'], status: 'active' }), l);
  check('lookup 틀린 토큰 → INVALID_TOKEN', post({ action: 'lookup', token: 'x'.repeat(43) }).code === 'INVALID_TOKEN');
  check('lookup 짧은 토큰 → INVALID_TOKEN', post({ action: 'lookup', token: '' }).code === 'INVALID_TOKEN');
  const u = post({ action: 'update', token: t, name: '홍길동', affType: 'grad', org: '전북대 화학공학과', phone: '01012345678', email: 'hong.gd@example.com', day: 'day2', programs: ['d2-1'] });
  check('update', u.ok && deepEq(u.data, { receiptNo: s1.data.receiptNo, name: '홍길동', affType: 'grad', org: '전북대 화학공학과', email: 'hong.gd@example.com', day: 'day2', programs: ['d2-1'] }), u);
  const hist = tab('변경이력').getRange(2, 1, 1, 6).getValues()[0];
  check('변경이력: 본인 수정, 바뀐 항목만(프로그램은 쉼표 문자열)', hist[2] === '본인' && hist[3] === '수정' &&
    deepEq(JSON.parse(hist[4]), { org: p1.org, day: 'both', programs: 'd1-1,d1-3,d2-1' }) &&
    deepEq(JSON.parse(hist[5]), { org: '전북대 화학공학과', day: 'day2', programs: 'd2-1' }), hist);
  const uMiss = post({ action: 'update', token: t, name: '홍길동', org: '전북대 화학공학과', phone: '01012345678', day: 'day2' });
  check('update 새 칸 빠짐 → VALIDATION affType·email·programs', uMiss.code === 'VALIDATION' && deepEq(uMiss.fields, { affType: true, email: true, programs: true }), uMiss);
  const uDup = post({ action: 'update', token: t, name: 'a', affType: 'grad', org: 'b', phone: post({ action: 'lookup', token: s4.data.token }).data.phone, email: 'a@b.co', day: 'day2', programs: ['d2-1'] });
  check('update 다른 신청 번호 → DUPLICATE', uDup.code === 'DUPLICATE', uDup);
  check('update 검증', post({ action: 'update', token: t, name: '', org: 'b', phone: '010', day: 'x' }).code === 'VALIDATION');
  const c = post({ action: 'cancel', token: t });
  check('cancel', c.ok && deepEq(c.data, { receiptNo: s1.data.receiptNo, status: 'canceled' }), c);
  check('취소 뒤 lookup status canceled', post({ action: 'lookup', token: t }).data.status === 'canceled');
  check('취소 뒤 update → INVALID_TOKEN', post({ action: 'update', token: t, name: 'a', org: 'b', phone: '01012345678', day: 'day1' }).code === 'INVALID_TOKEN');
  check('취소 뒤 다시 cancel → INVALID_TOKEN', post({ action: 'cancel', token: t }).code === 'INVALID_TOKEN');
  const again = post({ action: 'submit', ...person({ phone: '01012345678', day: 'day1' }) });
  check('취소한 번호로 다시 신청 가능(모의와 같음)', again.ok && again.data.receiptNo === `RF26-${MMDD}-0003`, again);
}

/* =================== 7. resend =================== */
section('resend');
{
  const n0 = api.logs.length;
  check('resend 있는 번호 → sent', deepEq(post({ action: 'resend', phone: '010-1234-5678' }).data, { sent: true }));
  check('resend 문자 스텁 발송', api.logs.slice(n0).some((l) => l.includes('신청 확인·수정·취소 링크') && l.includes('https://rfw.example/?t=')));
  const n1 = api.logs.length;
  check('resend 1분 안 재요청 → sent(발송 안 함)', post({ action: 'resend', phone: '01012345678' }).data.sent === true && api.logs.length === n1);
  check('resend 없는 번호 → sent', post({ action: 'resend', phone: '01099998888' }).data.sent === true && api.logs.length === n1);
  check('resend 형식 틀림 → sent', post({ action: 'resend', phone: 'abc' }).data.sent === true);
}

/* =================== 8. 관리자 권한 =================== */
section('관리자 권한');
{
  as('stranger@example.com');
  const g = admin.ctx.doGet();
  check('명단 밖 doGet → 권한 없음 화면(관리자 화면 아님)', g.html && !g.file && g.title === '권한이 없어요' && g.html.includes('권한이 없어요'));
  for (const fn of ['adminWhoAmI', 'adminGetSummary', 'adminList', 'adminUpdate', 'adminCancel', 'adminRestore', 'adminHistory', 'adminGetConfig', 'adminSaveConfig', 'adminLogExport', 'adminExportLog', 'adminConfigLog', 'adminAccessLog']) {
    const r = A(fn);
    check(`명단 밖 ${fn} → FORBIDDEN`, r.ok === false && r.code === 'FORBIDDEN' && /[가-힣]/.test(r.message), r);
  }
  let threw = ''; try { admin.ctx.purgePersonalData(); } catch (e) { threw = e.message; }
  check('명단 밖 purgePersonalData 거부', /관리자 명단/.test(threw));
  let threw2 = ''; try { admin.ctx.setup(); } catch (e) { threw2 = e.message; }
  check('명단 밖 setup 거부', /관리자 명단/.test(threw2), threw2);
  as('');
  check('이메일 없음 → FORBIDDEN', A('adminWhoAmI').code === 'FORBIDDEN');
  as(ADMIN);
  const g2 = admin.ctx.doGet();
  check('명단 안 doGet → Admin.html', g2.file === 'Admin' && g2.title === '관리자 · 2026 JBNU-G 리서치페어 위크' && g2.metas.viewport === 'width=device-width, initial-scale=1');
  check('adminWhoAmI (대소문자 무시, 이름)', deepEq(A('adminWhoAmI').data, { email: ADMIN, name: '운영팀' }));
  const acc = A('adminAccessLog').data;
  check('로그인 기록', acc.length === 1 && acc[0].email === ADMIN && acc[0].name === '운영팀' && acc[0].action === '로그인', acc);
}

/* =================== 9. 집계 =================== */
section('adminGetSummary');
const regs = {};
{
  // 지금 유효: s4(day1, qr) + again(day1, web). 취소: s1(day2→취소, sms)
  regs.a = post({ action: 'submit', ...person({ day: 'day1', src: 'qr', phone: '010-2222-5678' }) }).data;
  regs.b = post({ action: 'submit', ...person({ day: 'day2', src: 'direct', phone: '010-3333-1234' }) }).data;
  regs.c = post({ action: 'submit', ...person({ day: 'both', src: 'sms', phone: '011-456-7890' }) }).data;
  regs.d = post({ action: 'submit', ...person({ day: 'both', src: 'web' }) }).data;
  post({ action: 'cancel', token: regs.d.token });
  const s = A('adminGetSummary');
  check('summary ok', s.ok, s);
  const d = s.data;
  // 유효: s4 day1, again day1, a day1, b day2, c both → day1 3, day2 1, both 1
  check('byDay (취소 제외)', deepEq(d.byDay, { day1: 3, day2: 1, both: 1 }), d.byDay);
  check('total = 5', d.total === 5);
  check('canceled = 2', d.canceled === 2);
  check('createdTotal = total + canceled', d.createdTotal === d.total + d.canceled && d.createdTotal === 7);
  check('perDate: 22일 = day1+both, 23일 = day2+both', deepEq(d.perDate, { d22: 4, d23: 2 }), d.perDate);
  check('bySrc (유효만)', deepEq(d.bySrc, { sms: 1, qr: 2, web: 1, direct: 1 }), d.bySrc);
  check('capacity 없음', deepEq(d.capacity, { d22: null, d23: null }));
  const last = d.daily[d.daily.length - 1];
  check('daily 마지막 cumulative = total', last.cumulative === d.total, d.daily);
  check('daily 오늘 count 7, canceled 2', last.date === kstNow().slice(0, 10) && last.count === 7 && last.canceled === 2 && last.restored === 0, last);
  check('generatedAt +09:00', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(d.generatedAt));
}

/* =================== 10. 목록·검색 =================== */
section('adminList');
{
  const all = A('adminList', { status: 'all' }).data;
  check('목록 전체 7건', all.total === 7 && all.rows.length === 7);
  check('목록 행: 가린 번호만', all.rows.every((r) => /^01\d-\*{4}-\d{4}$/.test(r.phoneMasked) && !('phone' in r) && !('token' in r)));
  check('기본 정렬 createdAt desc', all.rows[0].createdAt >= all.rows[all.rows.length - 1].createdAt);
  const def = A('adminList', {}).data;
  check('기본 상태 필터 = 신청', def.total === 5 && def.rows.every((r) => r.status === 'active'));
  check('뒷자리 4자리 검색', deepEq(A('adminList', { q: '5678', status: 'all' }).data.rows.map((r) => r.receiptNo).sort(), [s1.data.receiptNo, regs.a.receiptNo, `RF26-${MMDD}-0003`].sort()));
  check('4자리는 뒷자리만(가운데 일치 제외)', A('adminList', { q: '2222' }).data.total === 0);
  check('5자리 이상 부분 일치 (2222-56)', deepEq(A('adminList', { q: '2222-56' }).data.rows.map((r) => r.receiptNo), [regs.a.receiptNo]));
  check('전체 번호 하이픈 검색', A('adminList', { q: '011-456-7890' }).data.rows[0].receiptNo === regs.c.receiptNo);
  check('접수번호 검색', A('adminList', { q: regs.b.receiptNo.toLowerCase() }).data.total === 1);
  check('d22 = day1+both', A('adminList', { day: 'd22' }).data.total === 4);
  check('d23 = day2+both', A('adminList', { day: 'd23' }).data.total === 2);
  check('canceled 필터', A('adminList', { status: 'canceled' }).data.total === 2);
  const byName = A('adminList', { sort: 'name:asc', status: 'all' }).data.rows.map((r) => r.name);
  check('이름 정렬', deepEq(byName, byName.slice().sort((a, b) => a.localeCompare(b, 'ko'))));
}

/* =================== 11. 관리자 수정·취소·복원 =================== */
section('adminUpdate · adminCancel · adminRestore · adminHistory');
{
  check('없는 접수번호 → NOT_FOUND', A('adminUpdate', 'RF26-0000-9999', { name: 'x' }).code === 'NOT_FOUND');
  const v = A('adminUpdate', regs.a.receiptNo, { name: '', phone: '123' });
  check('수정 검증 → VALIDATION fields(최상위)', v.code === 'VALIDATION' && deepEq(v.fields, { name: true, phone: true }), v);
  check('수정 다른 번호 → DUPLICATE', A('adminUpdate', regs.a.receiptNo, { phone: '010-3333-1234' }).code === 'DUPLICATE');
  check('취소 건 수정 → CANCELED', A('adminUpdate', regs.d.receiptNo, { name: '새이름' }).code === 'CANCELED');
  const u = A('adminUpdate', regs.a.receiptNo, { phone: '010-2222-9999', org: ' 새 소속 ', day: 'day1' });
  check('관리자 수정', u.ok && u.data.phoneMasked === '010-****-9999' && u.data.org === '새 소속', u);
  const h = A('adminHistory', regs.a.receiptNo).data;
  check('이력: 관리자 이메일, 번호 가림', h.length === 1 && h[0].by === ADMIN && h[0].kind === '수정' && deepEq(h[0].before, { phone: '010-****-5678', org: '전북대학교 대학원' }) && deepEq(h[0].after, { phone: '010-****-9999', org: '새 소속' }), h);
  check('바뀐 것 없으면 이력 안 남김', A('adminUpdate', regs.a.receiptNo, { day: 'day1' }).ok && A('adminHistory', regs.a.receiptNo).data.length === 1);
  const c = A('adminCancel', regs.b.receiptNo);
  check('관리자 취소', c.ok && c.data.status === 'canceled');
  check('이미 취소 → 그대로', A('adminCancel', regs.b.receiptNo).data.status === 'canceled' && A('adminHistory', regs.b.receiptNo).data.length === 1);
  const r = A('adminRestore', regs.b.receiptNo);
  check('관리자 복원', r.ok && r.data.status === 'active');
  const hb = A('adminHistory', regs.b.receiptNo).data;
  check('이력 최근 순(복원 → 취소)', hb.length === 2 && hb[0].kind === '복원' && hb[1].kind === '취소', hb);
  // 같은 번호 유효 신청이 있으면 복원 불가: s1(취소, 01012345678) vs again(유효, 같은 번호)
  check('복원 시 같은 번호 유효 신청 → DUPLICATE', A('adminRestore', s1.data.receiptNo).code === 'DUPLICATE');
  const sum = A('adminGetSummary').data;
  check('복원이 daily.restored 에 잡힘, 누적 = total', sum.daily[sum.daily.length - 1].restored === 1 && sum.daily[sum.daily.length - 1].cumulative === sum.total, sum.daily);
}

/* =================== 12. 설정·정원·마감 =================== */
section('설정 · 정원 · 마감');
{
  const g = A('adminGetConfig');
  check('adminGetConfig', g.ok && g.data.days.length === 3 && g.data.program.day1.items.length === 3);
  const cfg = plain(g.data);
  const cur = A('adminGetSummary').data.perDate;       // 지금 22일 4, 23일 2
  cfg.days[0].capacity = cur.d22 + 1;                  // 22일 한 자리 남김
  cfg.days[1].capacity = 50;
  cfg.program.day2.items.push({ time: '10:00', ko: '추가', en: 'Extra', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' });
  const s = A('adminSaveConfig', cfg);
  check('설정 저장', s.ok, s);
  check('저장 응답 remaining', s.data.days[0].remaining === 1 && s.data.days[1].remaining === 48 && s.data.days[2].remaining === 1 && s.data.days[2].capacity === null, s.data.days);
  const log = A('adminConfigLog').data;
  check('설정변경 기록 changes', log.length === 1 && deepEq(log[0].changes, [`22일 정원: 없음 → ${cur.d22 + 1}명`, '23일 정원: 없음 → 50명', '세부 프로그램(23일): 항목 3개 → 4개']), log);
  check('설정 시트 → 참가자 config 반영', (() => { api.cache.clear(); const c = post({ action: 'config' }).data; return c.days[0].capacity === cur.d22 + 1 && c.program.day2.items.length === 4; })());
  check('정원 남은 1자리 신청', post({ action: 'submit', ...person({ day: 'day1' }) }).ok);
  check('22일 꽉 참 → day1 DAY_FULL', post({ action: 'submit', ...person({ day: 'day1' }) }).code === 'DAY_FULL');
  check('22일 꽉 참 → both DAY_FULL', post({ action: 'submit', ...person({ day: 'both' }) }).code === 'DAY_FULL');
  check('23일은 신청 가능', post({ action: 'submit', ...person({ day: 'day2' }) }).ok);
  const pc = post({ action: 'config' }).data;
  check('config remaining: day1 0, both 0 (신청 후 캐시 갱신)', pc.days[0].remaining === 0 && pc.days[2].remaining === 0, pc.days);
  check('정원 찬 날로 update → DAY_FULL', post({ action: 'update', token: regs.b.token, name: 'a', affType: 'grad', org: 'b', phone: '010-3333-1234', email: 'b@b.co', day: 'both', programs: ['d1-1', 'd2-1'] }).code === 'DAY_FULL');
  check('정원 찬 날 복원 → DAY_FULL', A('adminRestore', regs.d.receiptNo).code === 'DAY_FULL');

  const closed = plain(A('adminGetConfig').data); closed.open = false;
  A('adminSaveConfig', closed);
  const r1 = post({ action: 'submit', ...person({ day: 'day2' }) });
  check('open:false → CLOSED (설정 캐시와 무관하게 즉시)', r1.code === 'CLOSED', r1);
  const past = plain(closed); past.open = true; past.closeAt = '2026-01-01T00:00:00+09:00';
  A('adminSaveConfig', past);
  check('마감 시각 지남 → CLOSED', post({ action: 'submit', ...person({ day: 'day2' }) }).code === 'CLOSED');
  const log2 = A('adminConfigLog').data;
  check('설정변경 기록 최근 순', log2.length === 3 && deepEq(log2[0].changes, ['접수 받기: 꺼짐 → 켜짐', '마감 일시: 2026.12.19 18:00 → 2026.01.01 00:00']), log2[0]);
  const reopen = plain(past); reopen.closeAt = '2026-12-19T18:00:00+09:00'; reopen.days[0].capacity = null; reopen.days[1].capacity = null;
  A('adminSaveConfig', reopen);
  check('다시 열면 신청 가능', post({ action: 'submit', ...person({ day: 'both' }) }).ok);
  check('잘못된 설정 → VALIDATION', A('adminSaveConfig', { days: 'x' }).code === 'VALIDATION');
}

/* =================== 13. 내보내기 =================== */
section('adminLogExport · 로그');
{
  const x = A('adminLogExport', 'xlsx', { status: 'all', label: '전체 · 전체 상태' });
  check('명단 내보내기: 전체 번호(하이픈)', x.ok && x.data.rows.length > 0 && x.data.rows.every((r) => /^01\d-\d{3,4}-\d{4}$/.test(r.phone) && r.phoneMasked));
  check('내보내기 entry', x.data.entry.action === '내보내기' && x.data.entry.kind === 'xlsx' && x.data.entry.filterText === '전체 · 전체 상태' && x.data.entry.count === x.data.rows.length && x.data.entry.email === ADMIN);
  const b = A('adminLogExport', 'badge', { status: 'all' }).data;
  check('명찰: 취소 제외', b.rows.length > 0 && b.rows.every((r) => r.status === 'active'));
  const st = A('adminLogExport', 'stats', {}).data;
  check('통계: 행 없음, filterText 접수 통계', st.rows.length === 0 && st.entry.filterText === '접수 통계' && st.entry.count === 0);
  check('잘못된 kind → VALIDATION', A('adminLogExport', 'pdf', {}).code === 'VALIDATION');
  const el = A('adminExportLog').data;
  check('내보내기 기록 3건 최근 순', el.length === 3 && el.every((e) => e.action === '내보내기') && el[0].at >= el[2].at);
}

/* =================== 14. 모의 구현과 모양 비교 =================== */
section('admin/js/api.js 모의 구현과 모양 비교');
{
  const w = { setTimeout, Promise, location: { search: '' } };
  w.window = w;
  const mc = vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/config.js'), 'utf8'), mc);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'admin/js/api.js'), 'utf8'), mc);
  const M = w.AdminAPI;
  const mSum = plain(await M.adminGetSummary());
  const mList = plain(await M.adminList({ status: 'all' }));
  let mHist = [];
  for (const r of mList.rows) { mHist = plain(await M.adminHistory(r.receiptNo)); if (mHist.length) break; }
  const mCfg = plain(await M.adminGetConfig());
  const mExp = plain(await M.adminLogExport('xlsx', { label: 'x' }));
  const mRow = plain(await M.adminUpdate(mList.rows[0].receiptNo, {}));

  sameShape('adminWhoAmI', A('adminWhoAmI').data, plain(await M.adminWhoAmI()));
  sameShape('adminGetSummary', A('adminGetSummary').data, mSum);
  sameShape('adminList', A('adminList', { status: 'all' }).data, mList);
  sameShape('adminUpdate 행', A('adminUpdate', regs.a.receiptNo, {}).data, mRow);
  sameShape('adminCancel 행', A('adminCancel', regs.c.receiptNo).data, mRow);
  sameShape('adminRestore 행', A('adminRestore', regs.c.receiptNo).data, mRow);
  sameShape('adminHistory', A('adminHistory', regs.b.receiptNo).data, mHist);
  sameShape('adminGetConfig', A('adminGetConfig').data, mCfg);
  sameShape('adminSaveConfig', A('adminSaveConfig', A('adminGetConfig').data).data, mCfg);
  sameShape('adminLogExport', A('adminLogExport', 'csv', { label: 'x' }).data, mExp);
  sameShape('adminExportLog', A('adminExportLog').data, plain(await M.adminExportLog()));
  sameShape('adminConfigLog', A('adminConfigLog').data, plain(await M.adminConfigLog()));
  sameShape('adminAccessLog', A('adminAccessLog').data, plain(await M.adminAccessLog()));
}

/* =================== 15. 시트를 사람이 고친 경우 =================== */
section('시트 손편집 내성');
{
  const sh = tab('신청');
  // 누군가 서식을 자동으로 바꿔 번호가 숫자가 된 경우
  sh.formats.push({ r1: 2, r2: 2, c1: 7, c2: 7, f: '' });
  shared.locksHeld++; sh.getRange(2, 7).setValue('01012345678'); shared.locksHeld--;
  check('숫자로 바뀐 번호 칸', typeof sh.get(2, 7) === 'number');
  check('숫자 칸도 번호로 읽음', A('adminList', { q: s1.data.receiptNo, status: 'all' }).data.rows[0].phoneMasked === '010-****-5678');
  check('잠금 없이 신청 탭 쓰기는 가짜 시트가 잡음', (() => { try { sh.getRange(3, 1).setValue('x'); return false; } catch (e) { return /잠금/.test(e.message); } })());
}

section('번호별 횟수 제한');
{
  const ph = newPhone();
  let last;
  const seen = [];
  for (let i = 0; i < 6; i++) { last = post({ action: 'submit', ...person({ phone: ph }) }); seen.push(last.ok ? 'ok' : last.code); }
  check('같은 번호 10분 5회 넘으면 RATE_LIMITED', seen.join() === 'ok,DUPLICATE,DUPLICATE,DUPLICATE,DUPLICATE,RATE_LIMITED', seen);
}

/* =================== 15-1. 방문·신청 전환 =================== */
section('방문·신청 전환 (방문집계 → adminGetSummary)');
{
  const vs = tab('방문집계');
  const visitRow = (src) => vs.getRange(2, 1, vs.getLastRow() - 1, 4).getValues().find((r) => r[0] === kstNow().slice(0, 10) && r[1] === src) || ['', src, 0, 0];
  const cache = api.ctx.CacheService.getScriptCache();
  const isoRe = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/;
  check('반영 시각: 방문집계 F1·G1 (글자 서식)', vs.get(1, 6) === '방문수 마지막 반영' && isoRe.test(vs.get(1, 7)) && vs.fmt(1, 7) === '@', [vs.get(1, 6), vs.get(1, 7)]);
  check('머리행 A~D 그대로', deepEq(vs.getRange(1, 1, 1, 4).getValues()[0], ['날짜', '유입경로', '방문수', '신청수']));

  // 1) 기회 반영: 마지막 반영이 1분 안이면 캐시에만, 1분이 지나면 다음 방문 때 시트로
  const qr0 = visitRow('qr')[2];
  cache.put('visit:flushedAt', String(Date.now() - 30000), 21600);
  post({ action: 'config', src: 'qr' });
  check('1분 안: 시트에 아직 없음(캐시에 모음)', visitRow('qr')[2] === qr0 && JSON.parse(cache.get('visit:pending'))[kstNow().slice(0, 10) + '|qr'] === 1);
  const seen0 = A('adminGetSummary').data.visits.qr;
  check('관리자는 반영 전 방문을 못 봄', seen0 === qr0, { seen0, qr0 });
  cache.put('visit:flushedAt', String(Date.now() - 61000), 21600);
  vs.set(1, 7, '2000-01-01T00:00:00+09:00');
  post({ action: 'config', src: 'qr' });
  check('1분 지남: 다음 방문 때 모아 둔 것까지 시트에', visitRow('qr')[2] === qr0 + 2 && cache.get('visit:pending') === '{}', visitRow('qr'));
  check('반영 시각 갱신', vs.get(1, 7) > '2000-01-01T00:00:00+09:00' && isoRe.test(vs.get(1, 7)), vs.get(1, 7));
  check('관리자는 반영된 방문을 봄', A('adminGetSummary').data.visits.qr === qr0 + 2);

  // 2) 신청 저장 때 모아 둔 방문도 같은 쓰기로
  cache.put('visit:flushedAt', String(Date.now()), 21600);
  const web0 = visitRow('web');
  post({ action: 'config', src: 'web' });
  check('방문 캐시에만', visitRow('web')[2] === web0[2]);
  vs.set(1, 7, '2000-01-01T00:00:00+09:00');
  const sub = post({ action: 'submit', ...person({ day: 'day2', src: 'web' }) });
  const web1 = visitRow('web');
  check('신청 저장 때 모아 둔 방문 함께 반영', sub.ok && web1[2] === web0[2] + 1 && web1[3] === web0[3] + 1 && cache.get('visit:pending') === '{}', { web0, web1 });
  check('신청 저장 때 반영 시각 갱신', isoRe.test(vs.get(1, 7)) && vs.get(1, 7) > '2000-01-01T00:00:00+09:00');
  const stampBefore = vs.get(1, 7);
  post({ action: 'submit', ...person({ day: 'day2', src: 'web' }) });
  check('모아 둔 방문이 없으면 신청은 반영 시각을 건드리지 않음', vs.get(1, 7) === stampBefore);

  // 3) 매시간 트리거: 모아 둔 것이 없어도 반영 시각은 남김
  vs.set(1, 7, '2000-01-01T00:00:00+09:00');
  api.ctx.flushVisits();
  check('flushVisits: 빈 캐시도 반영 시각 갱신', vs.get(1, 7) > '2000-01-01T00:00:00+09:00');

  // 4) 집계 계산: 방문집계를 알려진 값으로 바꿔 확인 후 되돌림
  const saved = new Map(vs.cells);
  for (const k of [...vs.cells.keys()]) if (Number(k.split(',')[0]) >= 2) vs.cells.delete(k);
  [['2026-12-01', 'sms', 10, 4], ['2026-12-01', 'qr', 5, 0], ['2026-12-02', 'sms', 6, 2], ['2026-12-02', 'web', 0, 1], ['2026-12-02', 'evil', 3, 1]]
    .forEach((r, i) => r.forEach((v, j) => vs.cells.set(`${i + 2},${j + 1}`, v)));
  vs.cells.set('7,1', vm.runInContext("new Date('2026-12-03T01:00:00Z')", admin.ctx));          // 사람이 고쳐 Date 가 된 날짜 칸
  vs.cells.set('7,2', 'direct'); vs.cells.set('7,3', 1); vs.cells.set('7,4', 0);
  vs.cells.set('1,7', '2026-12-03T10:00:00+09:00');
  const d = A('adminGetSummary').data;
  check('visits 경로별·합계 (모르는 경로 → direct)', deepEq(d.visits, { sms: 16, qr: 5, web: 0, direct: 4, total: 25 }), d.visits);
  check('visitSubmits 경로별·합계', deepEq(d.visitSubmits, { sms: 6, qr: 0, web: 1, direct: 1, total: 8 }), d.visitSubmits);
  check('conversion = 신청 ÷ 방문, 방문 0 이면 null', deepEq(d.conversion, { sms: 0.375, qr: 0, web: null, direct: 0.25, total: 0.32 }), d.conversion);
  check('visitsDaily 날짜순', deepEq(d.visitsDaily, [{ date: '2026-12-01', visits: 15, submits: 4 }, { date: '2026-12-02', visits: 9, submits: 4 }, { date: '2026-12-03', visits: 1, submits: 0 }]), d.visitsDaily);
  check('visitsUpdatedAt = G1', d.visitsUpdatedAt === '2026-12-03T10:00:00+09:00', d.visitsUpdatedAt);
  vs.cells.set('1,7', vm.runInContext("new Date('2026-12-03T01:05:00Z')", admin.ctx));
  check('visitsUpdatedAt: Date 칸도 +09:00', A('adminGetSummary').data.visitsUpdatedAt === '2026-12-03T10:05:00+09:00');
  vs.cells.delete('1,7');
  for (const k of [...vs.cells.keys()]) if (Number(k.split(',')[0]) >= 2) vs.cells.delete(k);
  const empty = A('adminGetSummary').data;
  check('방문집계 비어 있으면 0·null', empty.visits.total === 0 && empty.conversion.total === null && empty.visitsDaily.length === 0 && empty.visitsUpdatedAt === null, empty);
  vs.cells = saved;
  check('개인 정보 없음(숫자·날짜만)', !JSON.stringify({ a: d.visits, b: d.visitSubmits, c: d.visitsDaily }).match(/010|@|김전북/));
}

/* =================== 15-2. 소속 구분 · 이메일 · 세부 프로그램 (피드백 2) =================== */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const regRowOf = (no) => { const sh = tab('신청'); for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, 1) === no) return r; return 0; };
function setRegCells(no, values) {      // {열번호(1부터): 값} — 사람이 시트를 고친 것처럼
  const r = regRowOf(no);
  shared.locksHeld++;
  try { for (const [c, v] of Object.entries(values)) tab('신청').getRange(r, Number(c)).setValue(v); } finally { shared.locksHeld--; }
}

section('검증 규칙: 소속 구분 · 이메일 · 세부 프로그램');
{
  const c = api.ctx;
  const cfg = plain(c.RFW_DEFAULT_CONFIG);
  const base = { name: '김', affType: 'grad', org: 'x', phone: '01012345678', email: 'a@example.com', day: 'day1', programs: ['d1-1'], consent: true };
  const v = (o, conf = cfg) => plain(c.validateReg_(Object.assign({}, base, o), true, conf));
  check('기본 통과', v({}) === null, v({}));
  check('소속 구분 없음 → affType', deepEq(v({ affType: undefined }), { affType: true }));
  check('소속 구분 빈 값 → affType', deepEq(v({ affType: '' }), { affType: true }));
  check('설정에 없는 소속 구분 → affType', deepEq(v({ affType: 'alien' }), { affType: true }));
  check('소속 구분 _other → affType', deepEq(v({ affType: '_other' }), { affType: true }));
  for (const e of ['', 'no-at', 'a@b', 'a@b.c', 'a b@c.com', 'a@@b.com', 'x'.repeat(95) + '@a.com']) {
    check(`이메일 틀림 ${JSON.stringify(e.slice(0, 20))} → email`, deepEq(v({ email: e }), { email: true }));
  }
  check('이메일 없음 → email', deepEq(v({ email: undefined }), { email: true }));
  check('이메일 앞뒤 공백·대문자 허용', v({ email: '  Kim.JB@JBNU.ac.kr ' }) === null);
  check('이메일 100자 허용', v({ email: 'x'.repeat(94) + '@a.com' }) === null);
  check('고른 날 프로그램 없음([]) → programs', deepEq(v({ programs: [] }), { programs: true }));
  check('프로그램 칸 없음 → programs', deepEq(v({ programs: undefined }), { programs: true }));
  check('다른 날 프로그램만 → programs', deepEq(v({ programs: ['d2-1'] }), { programs: true }));
  check('다른 날 프로그램 섞임 → programs', deepEq(v({ programs: ['d1-1', 'd2-1'] }), { programs: true }));
  check('없는 프로그램 id → programs', deepEq(v({ programs: ['d1-1', 'nope'] }), { programs: true }));
  check('배열 아님 → programs', deepEq(v({ programs: 'd1-1' }), { programs: true }));
  check('문자열 아닌 원소 → programs', deepEq(v({ programs: [1] }), { programs: true }));
  check('양일: 22일 것만 → programs', deepEq(v({ day: 'both', programs: ['d1-1'] }), { programs: true }));
  check('양일: 23일 것만 → programs', deepEq(v({ day: 'both', programs: ['d2-2'] }), { programs: true }));
  check('양일: 날마다 하나씩 → 통과', v({ day: 'both', programs: ['d1-2', 'd2-3'] }) === null);
  check('23일: 23일 것 여러 개 → 통과', v({ day: 'day2', programs: ['d2-3', 'd2-1'] }) === null);
  const noDay2 = plain(cfg); noDay2.program.day2.items = [];
  check('항목 없는 날(23일): 빈 선택 통과', v({ day: 'day2', programs: [] }, noDay2) === null);
  check('항목 없는 날(23일): 프로그램 칸 없어도 통과', v({ day: 'day2', programs: undefined }, noDay2) === null);
  check('항목 없는 날(23일): 지워진 id → programs', deepEq(v({ day: 'day2', programs: ['d2-1'] }, noDay2), { programs: true }));
  check('양일 + 23일 항목 없음: 22일 것 하나면 통과', v({ day: 'both', programs: ['d1-1'] }, noDay2) === null);
  check('양일 + 23일 항목 없음: 22일 것도 없으면 → programs', deepEq(v({ day: 'both', programs: [] }, noDay2), { programs: true }));
  check('cleanPrograms_: 중복 제거·설정 순서(22일 먼저)', deepEq(plain(c.cleanPrograms_(['d2-2', 'd1-3', 'd1-1', 'd1-3'], 'both', cfg)), ['d1-1', 'd1-3', 'd2-2']));
  check('maskEmail_', c.maskEmail_('abcd@example.com') === 'ab***@example.com' && c.maskEmail_('a@x.com') === 'a***@x.com' && c.maskEmail_('') === '');
  const r = post({ action: 'submit', ...person({ day: 'both', programs: [] }) });
  check('API submit: 양일 프로그램 없음 → VALIDATION programs', r.code === 'VALIDATION' && deepEq(r.fields, { programs: true }), r);
  const r2 = post({ action: 'submit', ...person({ affType: 'nope', email: 'nope' }) });
  check('API submit: 소속 구분·이메일 → VALIDATION', r2.code === 'VALIDATION' && deepEq(r2.fields, { affType: true, email: true }), r2);
}

section('옛 시트 이전(setup) · 프로그램 ID 대체값 · writeConfig_ id 채움');
{
  const c = api.ctx;
  const old = new FakeBook('sheet-old', '옛 시트');
  const put = (sh, r, vals) => vals.forEach((v, j) => sh.set(r, j + 1, v));
  const reg = old.insertSheet('신청');
  reg.formats.push({ r1: 1, r2: 1000, c1: 1, c2: 12, f: '@' });
  put(reg, 1, ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '개인정보동의시각', '언어', '유입경로', '토큰']);
  put(reg, 2, ['RF26-1201-0001', '2026-12-01T10:00:00+09:00', '2026-12-01T10:00:00+09:00', '신청', '옛사람', '옛소속', '01077778888', 'day1',
    '2026-12-01T10:00:00+09:00', 'ko', 'web', 'x'.repeat(43)]);
  const prog = old.insertSheet('프로그램');
  prog.formats.push({ r1: 1, r2: 1000, c1: 1, c2: 8, f: '@' });
  put(prog, 1, ['날짜', '시간', '국문', '영문', '장소', '장소(영문)', '강조', '연사']);
  put(prog, 2, ['day1', '10:00', '가', 'A', '진수당', 'J', 'TRUE', '']);
  put(prog, 3, ['day1', '', '나', 'B', '진수당', 'J', 'FALSE', '', 'd1-keep']);   // 누군가 ID 를 손으로 넣은 행
  put(prog, 4, ['day2', '', '다', 'C', '진수당', 'J', 'FALSE', '']);
  put(prog, 5, ['day1', '', '라', 'D', '진수당', 'J', 'FALSE', '']);
  const conf = old.insertSheet('설정');
  put(conf, 1, ['항목', '값', '설명']);
  put(conf, 2, ['open', 'true', '접수 받기']);

  const ids = (cfg) => ['day1', 'day2'].map((d) => cfg.program[d].items.map((it) => it.id));
  const before = plain(c.readConfig_(old));
  check('readConfig_: 빈 ID 는 그날 안 순서로 d1-1… (손으로 넣은 ID 는 그대로)', deepEq(ids(before), [['d1-1', 'd1-keep', 'd1-3'], ['d2-1']]), ids(before));
  check('readConfig_: affiliations 항목 없으면 기본값', deepEq(before.affiliations, plain(c.RFW_DEFAULT_CONFIG.affiliations)));
  const oldReg = plain(c.readRegs_(old))[0];
  check('옛 신청 행: affType "", email "", programs []', oldReg.affType === '' && oldReg.email === '' && deepEq(oldReg.programs, []) && oldReg.name === '옛사람', oldReg);

  const made = plain(c.setupSheets_(old));
  check('setup: 신청 머리행 뒤에 3열', deepEq(reg.getRange(1, 1, 1, 15).getValues()[0].slice(11), ['토큰', '소속구분', '이메일', '세부프로그램']), reg.getRange(1, 1, 1, 15).getValues()[0]);
  check('setup: 프로그램 머리행 뒤에 ID', prog.get(1, 9) === 'ID');
  check('setup: 빈 ID 칸 채움(그날 안 순서)', deepEq(prog.getRange(2, 9, 4, 1).getValues().map((r) => r[0]), ['d1-1', 'd1-keep', 'd2-1', 'd1-3']));
  check('setup: 새 열도 글자 서식', reg.fmt(2, 15) === '@' && prog.fmt(2, 9) === '@');
  check('setup: 설정에 affiliations 행 추가', conf.get(3, 1) === 'affiliations' && deepEq(JSON.parse(conf.get(3, 2)), plain(c.RFW_DEFAULT_CONFIG.affiliations)));
  check('setup: 한 일 기록', made.some((m) => /신청 탭 열 추가/.test(m)) && made.some((m) => /프로그램 ID 3칸/.test(m)) && made.some((m) => /affiliations/.test(m)), made);
  check('setup: 옛 신청 행 데이터 그대로', deepEq(reg.getRange(2, 1, 1, 12).getValues()[0].slice(0, 5), ['RF26-1201-0001', '2026-12-01T10:00:00+09:00', '2026-12-01T10:00:00+09:00', '신청', '옛사람']));
  check('setup: 이전 뒤 id 가 이전 전 대체값과 같음', deepEq(ids(plain(c.readConfig_(old))), ids(before)));
  check('setup: 설정·프로그램 기본값으로 덮어쓰지 않음', prog.get(2, 3) === '가' && conf.get(2, 1) === 'open');
  const snap = JSON.stringify([[...reg.cells], [...prog.cells], [...conf.cells]]);
  const made2 = plain(c.setupSheets_(old));
  check('setup 다시 실행: 바뀌는 것 없음', made2.length === 0 && JSON.stringify([[...reg.cells], [...prog.cells], [...conf.cells]]) === snap, made2);

  // writeConfig_: id 가 빈 항목을 채우고(cfg 도 같이), 9열로 쓴다
  const cfg = c.readConfig_(old);
  cfg.program.day2.items.push({ time: '', ko: '새 항목', en: 'New', place: '', placeEn: '', highlight: false, speaker: '', id: '' });
  c.writeConfig_(old, cfg, false);
  const newId = cfg.program.day2.items[1].id;
  check('writeConfig_: 빈 id → d2- + base36 4~6자', /^d2-[0-9a-z]{4,6}$/.test(newId), newId);
  const back = plain(c.readConfig_(old));
  check('writeConfig_ → readConfig_: id 유지', deepEq(ids(back), [['d1-1', 'd1-keep', 'd1-3'], ['d2-1', newId]]), ids(back));
  const ids2 = {}; for (let i = 0; i < 200; i++) { const x = c.newProgramId_('day1', ids2); ids2[x] = true; }
  check('newProgramId_: 겹치지 않음·형식', Object.keys(ids2).length === 200 && Object.keys(ids2).every((x) => /^d1-[0-9a-z]{4,6}$/.test(x)));
}

section('옛 신청 건 본인 수정: 새 칸을 채워야 저장');
{
  const leg = post({ action: 'submit', ...person({ day: 'day2', email: 'legacy@example.com' }) }).data;
  setRegCells(leg.receiptNo, { 13: '', 14: '', 15: '' });
  const l = post({ action: 'lookup', token: leg.token }).data;
  check('새 칸이 빈 신청 lookup: "" / []', l.affType === '' && l.email === '' && deepEq(l.programs, []), l);
  const bad = post({ action: 'update', token: leg.token, name: l.name, org: l.org, phone: l.phone, day: 'day2' });
  check('옛 모양 update → VALIDATION affType·email·programs', bad.code === 'VALIDATION' && deepEq(bad.fields, { affType: true, email: true, programs: true }), bad);
  const ok = post({ action: 'update', token: leg.token, name: l.name, affType: 'prof', org: l.org, phone: l.phone, email: 'New.Mail@Example.com', day: 'day2', programs: ['d2-2'] });
  check('채워서 update → 저장', ok.ok && ok.data.affType === 'prof' && ok.data.email === 'new.mail@example.com' && deepEq(ok.data.programs, ['d2-2']), ok);
  const h = A('adminHistory', leg.receiptNo).data[0];
  check('변경이력: 이메일 가림, 프로그램 쉼표 문자열', deepEq(h.before, { affType: '', email: '', programs: '' }) && deepEq(h.after, { affType: 'prof', email: 'ne***@example.com', programs: 'd2-2' }), h);
}

section('adminGetSummary byAff · byProgram, adminList aff · program · 이메일 검색');
{
  const cfg = A('adminGetConfig').data;
  const expect = (rows) => {
    const aff = { _other: 0 }; cfg.affiliations.forEach((a) => { aff[a.id] = 0; });
    const pc = {};
    rows.forEach((r) => {
      const k = r.affType && hasOwn(aff, r.affType) && r.affType !== '_other' ? r.affType : '_other';
      aff[k]++;
      r.programs.forEach((id) => { pc[id] = (pc[id] || 0) + 1; });
    });
    const prog = [];
    ['day1', 'day2'].forEach((d) => cfg.program[d].items.forEach((it) => prog.push({ id: it.id, day: d, ko: it.ko, en: it.en, count: pc[it.id] || 0 })));
    return { aff, prog };
  };
  const s0 = A('adminGetSummary').data;
  const e0 = expect(A('adminList', {}).data.rows);
  check('byAff = 유효 신청 소속 구분별(설정 구분 0 포함, _other)', deepEq(s0.byAff, e0.aff), { got: s0.byAff, want: e0.aff });
  check('byProgram = 설정 순서·유효 신청 기준', deepEq(s0.byProgram, e0.prog), { got: s0.byProgram, want: e0.prog });
  check('byProgram 순서 = 설정 순서(22일 먼저)', deepEq(s0.byProgram.map((p) => p.id), ['day1', 'day2'].flatMap((d) => cfg.program[d].items.map((it) => it.id))));

  const mk = (o) => post({ action: 'submit', ...person(o) }).data;
  mk({ affType: 'prof', day: 'day1', programs: ['d1-2', 'd1-3'] });
  mk({ affType: 'prof', day: 'day1', programs: ['d1-3', 'd1-2'] });
  const st = mk({ affType: 'student', day: 'both', programs: ['d1-2', 'd2-2'], email: 'Unique.Search@Example.org' });
  const cx = mk({ affType: 'prof', day: 'day1', programs: ['d1-2'] });
  post({ action: 'cancel', token: cx.token });
  const s1x = A('adminGetSummary').data;
  const cnt = (s, id) => s.byProgram.find((p) => p.id === id).count;
  check('byAff: 취소 제외하고 더해짐', s1x.byAff.prof === s0.byAff.prof + 2 && s1x.byAff.student === s0.byAff.student + 1, { before: s0.byAff, after: s1x.byAff });
  check('byProgram: 취소 제외하고 더해짐', cnt(s1x, 'd1-2') === cnt(s0, 'd1-2') + 3 && cnt(s1x, 'd1-3') === cnt(s0, 'd1-3') + 2 && cnt(s1x, 'd2-2') === cnt(s0, 'd2-2') + 1);

  // 설정에 없는 소속 구분·빈 값 → _other, 설정에서 지워진 프로그램 id → removed
  setRegCells(st.receiptNo, { 13: '', 15: 'd1-2,d2-gone,d2-2' });
  const s2x = A('adminGetSummary').data;
  check('빈 소속 구분 → _other', s2x.byAff._other === s1x.byAff._other + 1 && s2x.byAff.student === s1x.byAff.student - 1, s2x.byAff);
  const last = s2x.byProgram[s2x.byProgram.length - 1];
  check('지워진 프로그램 id → removed 로 뒤에', deepEq(last, { id: 'd2-gone', day: 'day2', ko: 'd2-gone', en: 'd2-gone', count: 1, removed: true }), last);
  setRegCells(st.receiptNo, { 13: 'student', 15: 'd1-2,d2-2' });
  check('되돌리면 removed 없음', !A('adminGetSummary').data.byProgram.some((p) => p.removed));

  const L = (f) => A('adminList', f).data;
  check('adminList aff 필터', L({ aff: 'prof' }).total === s1x.byAff.prof && L({ aff: 'prof' }).rows.every((r) => r.affType === 'prof'));
  check('adminList aff + 상태 전체 = 신청 + 취소', L({ aff: 'prof', status: 'all' }).total === L({ aff: 'prof' }).total + L({ aff: 'prof', status: 'canceled' }).total && L({ aff: 'prof', status: 'canceled' }).total >= 1);
  check('adminList program 필터', L({ program: 'd1-2' }).total === cnt(s1x, 'd1-2') && L({ program: 'd1-2' }).rows.every((r) => r.programs.includes('d1-2')));
  check('adminList aff + program', deepEq(L({ aff: 'student', program: 'd2-2' }).rows.map((r) => r.receiptNo).filter((n) => n === st.receiptNo), [st.receiptNo]));
  check('adminList 빈 필터 = 전체', L({ aff: '', program: '' }).total === L({}).total);
  check('adminList 이메일 검색(대소문자 무시)', L({ q: 'UNIQUE.SEARCH@' }).total === 1 && L({ q: 'unique.search' }).rows[0].receiptNo === st.receiptNo);
  const row = L({ q: st.receiptNo }).rows[0];
  check('목록 행: 이메일 원문·programs 배열·affType', row.email === 'unique.search@example.org' && deepEq(row.programs, ['d1-2', 'd2-2']) && row.affType === 'student', row);
  const x = A('adminLogExport', 'csv', { q: st.receiptNo }).data.rows[0];
  check('내보내기 행: affType·email·programs', x.affType === 'student' && x.email === 'unique.search@example.org' && deepEq(x.programs, ['d1-2', 'd2-2']) && /^010-/.test(x.phone), x);
}

section('adminUpdate: 소속 구분 · 이메일 · 세부 프로그램');
{
  const t = post({ action: 'submit', ...person({ day: 'day1', programs: ['d1-1'], email: 'abcd@example.com' }) }).data;
  const U = (patch) => A('adminUpdate', t.receiptNo, patch);
  const fieldsOf = (r) => r.code === 'VALIDATION' ? r.fields : r;
  check('affType 틀림 → fields.affType', deepEq(fieldsOf(U({ affType: 'alien' })), { affType: true }));
  check('email 틀림 → fields.email', deepEq(fieldsOf(U({ email: 'bad' })), { email: true }));
  check('programs 다른 날 → fields.programs', deepEq(fieldsOf(U({ programs: ['d2-1'] })), { programs: true }));
  check('programs 빈 배열 → fields.programs', deepEq(fieldsOf(U({ programs: [] })), { programs: true }));
  check('참석일만 바꿔 기존 프로그램이 안 맞음 → fields.programs', deepEq(fieldsOf(U({ day: 'day2' })), { programs: true }));
  check('참석일 틀리면 프로그램은 보지 않음', deepEq(fieldsOf(U({ day: 'day9', programs: ['x'] })), { day: true }));
  const n = U({ name: '새이름' });
  check('patch 에 없는 새 칸은 기존 값 유지', n.ok && n.data.affType === 'grad' && n.data.email === 'abcd@example.com' && deepEq(n.data.programs, ['d1-1']), n);
  const u = U({ affType: 'prof', email: ' NEW.Mail@Example.com ', programs: ['d1-3', 'd1-1'] });
  check('관리자 수정: 소속 구분·이메일(소문자)·프로그램(정렬)', u.ok && u.data.affType === 'prof' && u.data.email === 'new.mail@example.com' && deepEq(u.data.programs, ['d1-1', 'd1-3']), u);
  const h = A('adminHistory', t.receiptNo).data[0];
  check('변경이력: 이메일 가림·프로그램 쉼표', deepEq(h.before, { affType: 'grad', email: 'ab***@example.com', programs: 'd1-1' }) &&
    deepEq(h.after, { affType: 'prof', email: 'ne***@example.com', programs: 'd1-1,d1-3' }), h);
  const histText = JSON.stringify(tab('변경이력').getRange(2, 1, tab('변경이력').getLastRow() - 1, 6).getValues());
  check('변경이력 시트에 이메일 원문 없음', !histText.includes('abcd@example.com') && !histText.includes('new.mail@example.com'));
  check('참석일 + 프로그램 같이 바꾸기', U({ day: 'both', programs: ['d2-3', 'd1-1'] }).data.day === 'both');
  check('양일 → 22일, 프로그램에 23일 것이 남으면 → fields.programs', deepEq(fieldsOf(U({ day: 'day1' })), { programs: true }));
  const d1 = U({ day: 'day1', programs: ['d1-1'] });
  check('22일 + 22일 프로그램 → 저장', d1.ok && d1.data.day === 'day1' && deepEq(d1.data.programs, ['d1-1']), d1);
  const nHist = A('adminHistory', t.receiptNo).data.length;
  check('같은 값(프로그램 순서만 다름)이면 이력 안 남김', U({ programs: ['d1-1', 'd1-1'] }).ok && A('adminHistory', t.receiptNo).data.length === nHist);
}

section('설정: 소속 구분 · 세부 프로그램 ID (adminSaveConfig)');
{
  const g = () => plain(A('adminGetConfig').data);
  const cur = g();
  check('adminGetConfig: 소속 구분 기본값', deepEq(cur.affiliations, plain(api.ctx.RFW_DEFAULT_CONFIG.affiliations)));
  check('adminGetConfig: 모든 항목에 id', ['day1', 'day2'].every((d) => cur.program[d].items.every((it) => it.id)));
  const nLog = A('adminConfigLog').data.length;
  const affBad = (affs, label) => {
    const c = g(); c.affiliations = affs;
    const r = A('adminSaveConfig', c);
    check('소속 구분 검증: ' + label, r.code === 'VALIDATION' && deepEq(r.fields, { affiliations: true }) && /[가-힣]/.test(r.message), r);
  };
  const A1 = (o) => Object.assign({ id: 'a', ko: '가', en: 'A' }, o);
  affBad('x', '배열 아님');
  affBad([], '0개');
  affBad(Array.from({ length: 21 }, (_, i) => A1({ id: 'a' + i })), '21개');
  affBad([A1({ id: 'Bad ID' })], 'id 형식');
  affBad([A1({ id: 'x'.repeat(21) })], 'id 21자');
  affBad([A1({ id: '_other' })], 'id _other(집계용 예약)');
  affBad([A1(), A1({ ko: '나' })], 'id 중복');
  affBad([A1({ ko: '  ' })], '국문 이름 빈 값');
  affBad([A1({ ko: '가'.repeat(31) })], '국문 이름 31자');
  affBad([A1({ en: 'e'.repeat(41) })], '영문 이름 41자');
  affBad([null], '항목이 객체 아님');
  {
    const c = g(); c.program.day2.items[0].id = 'd1-1';
    const r = A('adminSaveConfig', c);
    check('프로그램 id 중복 → VALIDATION', r.code === 'VALIDATION' && deepEq(r.fields, { program: true }), r);
    const c2 = g(); c2.program.day1.items[0].id = 'd1,1';
    check('프로그램 id 에 쉼표 → VALIDATION', A('adminSaveConfig', c2).code === 'VALIDATION');
  }
  check('실패한 저장은 기록 없음', A('adminConfigLog').data.length === nLog);
  check('20개·영문 빈 값은 허용', (() => { const c = g(); c.affiliations = Array.from({ length: 20 }, (_, i) => A1({ id: 'a' + i, en: '' })); const r = A('adminSaveConfig', c); A('adminSaveConfig', cur); return r.ok && r.data.affiliations.length === 20; })());
  const nLog2 = A('adminConfigLog').data.length;

  const c = g();
  c.affiliations.push({ id: 'staff', ko: ' 직원 ', en: 'Staff' });
  c.affiliations.find((a) => a.id === 'student').ko = '학부생';
  c.program.day1.items.push({ time: '', ko: '새 세션', en: 'New Session', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' });
  c.program.day1.items[1].ko = '컨퍼런스 세션';
  const s = A('adminSaveConfig', c);
  check('저장: 소속 구분 6개(앞뒤 공백 정리)', s.ok && s.data.affiliations.length === 6 && s.data.affiliations[5].ko === '직원', s);
  const newId = s.data.program.day1.items[3].id;
  check('저장: 새 항목 id 채움(d1- + base36)', /^d1-[0-9a-z]{4,6}$/.test(newId), newId);
  check('저장: 이름 바꾼 항목 id 유지', s.data.program.day1.items[1].id === 'd1-2' && s.data.program.day1.items[1].ko === '컨퍼런스 세션');
  check('저장: 시트 프로그램 탭 ID 열', tab('프로그램').getRange(2, 9, 4, 1).getValues().map((r) => r[0]).join() === ['d1-1', 'd1-2', 'd1-3', newId].join());
  const log = A('adminConfigLog').data;
  check('설정변경 기록: 소속 구분 요약(정원 다음, 세부 프로그램 앞)', log.length === nLog2 + 1 &&
    deepEq(log[0].changes, ['소속 구분: 추가 직원 · 이름 수정 학생 → 학부생', '세부 프로그램(22일): 항목 3개 → 4개']), log[0]);
  api.cache.clear();
  const pc = post({ action: 'config' }).data;
  check('참가자 config: 소속 구분·새 프로그램 id 반영', pc.affiliations.length === 6 && pc.affiliations[5].id === 'staff' && pc.program.day1.items[3].id === newId, pc.affiliations);
  const sub = post({ action: 'submit', ...person({ affType: 'staff', day: 'day1', programs: [newId] }) });
  check('새 소속 구분·새 프로그램으로 신청', sub.ok && sub.data.affType === 'staff' && deepEq(sub.data.programs, [newId]), sub);

  const c3 = g(); c3.affiliations = [c3.affiliations[1], c3.affiliations[0]].concat(c3.affiliations.slice(2));
  A('adminSaveConfig', c3);
  check('설정변경 기록: 순서 변경', deepEq(A('adminConfigLog').data[0].changes, ['소속 구분: 순서 변경']), A('adminConfigLog').data[0]);
  const c4 = g(); c4.affiliations = c4.affiliations.filter((a) => a.id !== 'staff'); c4.affiliations.find((a) => a.id === 'prof').en = 'Professor';
  A('adminSaveConfig', c4);
  check('설정변경 기록: 삭제 · 영문 이름 수정', deepEq(A('adminConfigLog').data[0].changes, ['소속 구분: 삭제 직원 · 이름 수정 교수(영문)']), A('adminConfigLog').data[0]);
  const sum = A('adminGetSummary').data;
  check('지운 소속 구분으로 신청한 건 → _other', !('staff' in sum.byAff) && sum.byAff._other >= 1, sum.byAff);
  const c5 = g(); delete c5.affiliations;
  const r5 = A('adminSaveConfig', c5);
  check('affiliations 없이 저장하면 지금 값 유지', r5.ok && r5.data.affiliations.length === 5 && r5.data.affiliations[0].id === 'grad');
  A('adminSaveConfig', Object.assign(g(), { affiliations: cur.affiliations }));
}

/* =================== 16. 트리거·백업 =================== */
section('트리거 · 백업');
{
  api.ctx.installTriggers(); api.ctx.installTriggers();
  check('트리거 두 번 설치해도 2개', api.triggers.length === 2 && api.triggers.map((t) => t.fn).sort().join() === 'backupSpreadsheet,flushVisits');
  const n = shared.books.size;
  api.ctx.backupSpreadsheet();
  check('백업 사본 생성', shared.books.size === n + 1);
}

/* =================== 17. 개인정보 파기 =================== */
section('purgePersonalData');
{
  as(ADMIN);
  let msg = ''; try { admin.ctx.purgePersonalData(); } catch (e) { msg = e.message; }
  check('PURGE_CONFIRM 없으면 거부', /PURGE_CONFIRM/.test(msg), msg);
  const before = A('adminGetSummary').data;
  admin.props.set('PURGE_CONFIRM', 'YES');
  const res = admin.ctx.purgePersonalData();
  check('파기 실행', res.rows === before.createdTotal, res);
  check('PURGE_CONFIRM 자동 삭제', !admin.props.has('PURGE_CONFIRM'));
  const after = A('adminGetSummary').data;
  check('파기 후 통계 유지', after.total === before.total && after.createdTotal === before.createdTotal && deepEq(after.perDate, before.perDate));
  const rows = A('adminList', { status: 'all' }).data.rows;
  check('파기 후 이름·소속·번호·이메일 비어 있음', rows.every((r) => r.name === '' && r.org === '' && r.phoneMasked === '' && r.email === ''));
  check('파기 후 소속 구분·세부 프로그램은 통계용으로 남음', rows.some((r) => r.affType && r.programs.length));
  check('파기 후 토큰 무효', post({ action: 'lookup', token: s4.data.token }).code === 'INVALID_TOKEN');
  const h = A('adminHistory', regs.a.receiptNo).data;
  check('파기 후 이력에서 이름·소속·번호 지움', h.every((x) => !('phone' in x.before) && !('org' in x.after)), h);
  const allHist = tab('변경이력').getRange(2, 1, tab('변경이력').getLastRow() - 1, 6).getValues();
  check('파기 후 이력에서 이메일 지움', allHist.every((row) => !/"email"/.test(row[4]) && !/"email"/.test(row[5])));
  check('파기 기록', A('adminAccessLog').data.length >= 1 && tab('관리자로그').getRange(tab('관리자로그').getLastRow(), 3).getValues()[0][0] === '파기');
}

/* =================== 결과 =================== */
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
if (VERBOSE) { console.log('\n[api logs]\n' + api.logs.join('\n')); console.log('\n[admin logs]\n' + admin.logs.join('\n')); }
