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
const person = (o = {}) => Object.assign({ name: '김전북', org: '전북대학교 대학원', phone: newPhone(), day: 'day1', consent: true, lang: 'ko', src: 'web', hp: '' }, o);

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
check('신청 머리행', deepEq(tab('신청').getRange(1, 1, 1, 12).getValues()[0], ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '개인정보동의시각', '언어', '유입경로', '토큰']));
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
  const web = { window: {} }; vm.createContext(web);
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
const p1 = person({ name: '  홍길동 ', phone: '010-1234-5678', day: 'both', src: 'sms' });
const s1 = post({ action: 'submit', ...p1 });
check('신청 성공', s1.ok === true, s1);
check('접수번호 RF26-MMDD-0001', s1.data.receiptNo === `RF26-${MMDD}-0001`, s1.data.receiptNo);
check('응답 모양 {receiptNo,name,org,day,token}', deepEq(Object.keys(s1.data).sort(), ['day', 'name', 'org', 'receiptNo', 'token']));
check('이름 앞뒤 공백 제거', s1.data.name === '홍길동');
check('토큰 32자 이상', s1.data.token.length >= 32);
{
  const row = tab('신청').getRange(2, 1, 1, 12).getValues()[0];
  check('시트: 번호는 0 으로 시작하는 문자열', row[6] === '01012345678', row[6]);
  check('시트: 상태 신청, 시각 +09:00', row[3] === '신청' && /\+09:00$/.test(row[1]), row);
  const v = tab('방문집계').getRange(2, 1, tab('방문집계').getLastRow() - 1, 4).getValues().find((r) => r[1] === 'sms');
  check('방문집계 신청수 +1', v[3] === 1, v);
  check('확인 문자(스텁) 로그에 수정 링크', api.logs.some((l) => l.includes('[문자 스텁] 010-****-5678') && l.includes('https://rfw.example/?t=' + s1.data.token)));
}
const s2 = post({ action: 'submit', ...person({ phone: '+82 10-1234-5678' }) });
check('같은 번호(+82 표기) → DUPLICATE', s2.code === 'DUPLICATE', s2);
const s3 = post({ action: 'submit', name: '', org: 'x'.repeat(61), phone: '010-12', day: 'day9', consent: false });
check('검증 → VALIDATION + fields 5개', s3.code === 'VALIDATION' && deepEq(s3.fields, { name: true, org: true, phone: true, day: true, consent: true }), s3);
check('오류에 한국어 message', typeof s3.message === 'string' && /[가-힣]/.test(s3.message));
{
  const before = tab('신청').getLastRow();
  const h = post({ action: 'submit', ...person({ hp: 'http://spam' }) });
  check('허니팟: 성공처럼 응답', h.ok === true && h.data.receiptNo === 'RF26-0000-0000' && h.data.token === '');
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
  check('lookup', l.ok && deepEq(l.data, { receiptNo: s1.data.receiptNo, name: '홍길동', org: p1.org, phone: '01012345678', day: 'both', status: 'active' }), l);
  check('lookup 틀린 토큰 → INVALID_TOKEN', post({ action: 'lookup', token: 'x'.repeat(43) }).code === 'INVALID_TOKEN');
  check('lookup 짧은 토큰 → INVALID_TOKEN', post({ action: 'lookup', token: '' }).code === 'INVALID_TOKEN');
  const u = post({ action: 'update', token: t, name: '홍길동', org: '전북대 화학공학과', phone: '01012345678', day: 'day2' });
  check('update', u.ok && deepEq(u.data, { receiptNo: s1.data.receiptNo, name: '홍길동', org: '전북대 화학공학과', day: 'day2' }), u);
  const hist = tab('변경이력').getRange(2, 1, 1, 6).getValues()[0];
  check('변경이력: 본인 수정, 바뀐 항목만', hist[2] === '본인' && hist[3] === '수정' && deepEq(JSON.parse(hist[5]), { org: '전북대 화학공학과', day: 'day2' }), hist);
  const uDup = post({ action: 'update', token: t, name: 'a', org: 'b', phone: post({ action: 'lookup', token: s4.data.token }).data.phone, day: 'day2' });
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
  check('정원 찬 날로 update → DAY_FULL', post({ action: 'update', token: regs.b.token, name: 'a', org: 'b', phone: '010-3333-1234', day: 'both' }).code === 'DAY_FULL');
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
  check('파기 후 이름·소속·번호 비어 있음', rows.every((r) => r.name === '' && r.org === '' && r.phoneMasked === ''));
  check('파기 후 토큰 무효', post({ action: 'lookup', token: s4.data.token }).code === 'INVALID_TOKEN');
  const h = A('adminHistory', regs.a.receiptNo).data;
  check('파기 후 이력에서 이름·소속·번호 지움', h.every((x) => !('phone' in x.before) && !('org' in x.after)), h);
  check('파기 기록', A('adminAccessLog').data.length >= 1 && tab('관리자로그').getRange(tab('관리자로그').getLastRow(), 3).getValues()[0][0] === '파기');
}

/* =================== 결과 =================== */
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
if (VERBOSE) { console.log('\n[api logs]\n' + api.logs.join('\n')); console.log('\n[admin logs]\n' + admin.logs.join('\n')); }
