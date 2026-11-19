// Apps Script 배포본 만들기 (의존성 없음)
//   node tools/build-gas.mjs [--site=https://…/web/] [--preview]
// 결과
//   gas/dist/api/    = gas/shared/*.gs + gas/api/*   (clasp.json 제외) + .clasp.json(= gas/api/clasp.json 그대로)
//   gas/dist/admin/  = gas/shared/*.gs + gas/admin/* (clasp.json 제외) + .clasp.json + Admin.html
//     Admin.html = admin/index.html 에 로컬 CSS·JS 를 모두 인라인. js/api.js(모의) 대신 js/api-gas.js.
//     ../web/js/config.js 는 관리자 화면이 RFW_CONFIG 를 쓰지 않으면 뺀다. 외부 CDN 태그는 그대로 둔다.
//   --preview: gas/dist/preview/Admin.html — 같은 Admin.html 에 가짜 google.script(모의 api.js 연결)를 넣은 로컬 확인용.
//              clasp rootDir(dist/api, dist/admin) 밖이라 배포되지 않는다.
// dist 는 매번 비우고 새로 쓴다(clasp 가 받아 둔 appsscript.json 등도 지움). gas/<p>/clasp.json 이 없을 때만 기존 .clasp.json 을 남긴다.
// 배포: cd gas/dist/<p> && npx @google/clasp@3.4.1 --user rfw push -f
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAS = path.join(ROOT, 'gas');
const DIST = path.join(GAS, 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const a = args.find((x) => x === '--' + name || x.startsWith('--' + name + '=')); return a == null ? null : (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true); };
// 관리자 화면의 '접수 페이지 보기' 링크. 상대 경로(../web/index.html)는 Apps Script 에서 의미가 없어 절대 주소로 바꾼다.
const SITE = opt('site') || process.env.RFW_SITE_URL || 'https://2025dataedu.github.io/research-fair-work-submission/web/';
const PREVIEW = !!opt('preview');

const CLASP_SRC = 'clasp.json'; // gas/<p>/clasp.json (rootDir "") → dist/<p>/.clasp.json
const SKIP = new Set([CLASP_SRC, '.clasp.json']);
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('! ' + m); };
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- dist 정리·복사 ---------- */
function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === '.clasp.json') continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) { warn(rel(dir) + '/ 가 없어요 — 건너뜀'); return []; }
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (!SKIP.has(ent.name) && (!filter || filter(ent.name))) out.push(p);
    }
  })(dir);
  if (!out.length) warn(rel(dir) + '/ 에 복사할 파일이 없어요');
  return out;
}

function copyInto(target, sources) {
  const seen = new Map();
  const copied = [];
  for (const { base, file } of sources) {
    const r = path.relative(base, file);
    const key = r.toLowerCase();
    if (seen.has(key)) warn(rel(target) + '/' + r + ': ' + rel(seen.get(key)) + ' 를 ' + rel(file) + ' 가 덮어씀');
    seen.set(key, file);
    const dest = path.join(target, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    copied.push(r.replace(/\\/g, '/'));
  }
  return copied;
}

function buildProject(name, extra) {
  const target = path.join(DIST, name);
  cleanDir(target);
  const shared = path.join(GAS, 'shared'), own = path.join(GAS, name);
  const sources = [
    ...listFiles(shared, (f) => f.endsWith('.gs')).map((file) => ({ base: shared, file })),
    ...listFiles(own).map((file) => ({ base: own, file }))
  ];
  const copied = copyInto(target, sources);
  const claspSrc = path.join(own, CLASP_SRC);
  if (fs.existsSync(claspSrc)) fs.copyFileSync(claspSrc, path.join(target, '.clasp.json'));
  else if (fs.existsSync(path.join(target, '.clasp.json'))) warn(rel(claspSrc) + ' 가 없어 dist 의 기존 .clasp.json 을 그대로 둠');
  else warn(rel(claspSrc) + ' 가 없어요 — clasp push 를 하려면 필요');
  if (!copied.some((f) => f === 'appsscript.json')) warn(rel(target) + '/appsscript.json 이 없어요 (gas/' + name + '/appsscript.json 필요)');
  if (extra) for (const [file, content] of Object.entries(extra)) {
    if (copied.includes(file)) warn(rel(own) + '/' + file + ' 는 빌드가 만든 파일로 덮어씀');
    fs.writeFileSync(path.join(target, file), content);
    if (!copied.includes(file)) copied.push(file);
  }
  return { target, files: copied.sort() };
}

/* ---------- Admin.html 인라인 ---------- */
const isLocal = (u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function readText(file) {
  if (!fs.existsSync(file)) throw new Error('파일 없음: ' + rel(file));
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

// CSS: 로컬 @import 를 펼치고, 로컬 url() 은 data URI 로
function inlineCss(file, stack = []) {
  if (stack.includes(file)) throw new Error('CSS @import 순환: ' + rel(file));
  const dir = path.dirname(file);
  let css = readText(file);
  css = css.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?\s*([^;]*);/g, (m, q, url, media) => {
    if (!isLocal(url)) return m;
    const body = inlineCss(path.resolve(dir, url), [...stack, file]);
    return media.trim() ? '@media ' + media.trim() + ' {\n' + body + '\n}' : body;
  });
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, url) => {
    if (!isLocal(url) || url.startsWith('#') || url.startsWith('data:')) return m;
    const p = path.resolve(dir, url.split(/[?#]/)[0]);
    if (!fs.existsSync(p)) { warn('CSS ' + rel(file) + ' 의 url(' + url + ') 파일이 없어 뺌'); return 'none'; }
    const mime = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
    return 'url("data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64') + '")';
  });
  return css;
}

// 인라인 <script> 안에서 HTML 파서가 끊지 않게
const safeJs = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const safeCss = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

function buildAdminHtml({ preview } = {}) {
  const adminDir = path.join(ROOT, 'admin');
  let html = readText(path.join(adminDir, 'index.html'));
  const used = [];

  // RFW_CONFIG 를 실제로 쓰는지 (모의 api.js 만 쓰면 Apps Script 판에서는 필요 없음)
  const needsConfig = /RFW_CONFIG/.test(readText(path.join(adminDir, 'js/admin.js')) + readText(path.join(adminDir, 'js/api-gas.js')));

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel=["']?stylesheet/i.test(tag)) return tag;
    const href = (/\bhref=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href || !isLocal(href)) return tag;
    const file = path.resolve(adminDir, href);
    used.push(rel(file));
    return '<style>/* ' + href + ' */\n' + safeCss(inlineCss(file)) + '\n</style>';
  });

  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src) => {
    if (!isLocal(src)) return tag;
    let file = path.resolve(adminDir, src);
    if (/(^|\/)web\/js\/config\.js$/.test(src) && !preview && !needsConfig) return '<!-- ' + src + ': Apps Script 판에서는 쓰지 않음 -->';
    if (/(^|\/)js\/api\.js$/.test(src)) {
      if (preview) used.push(rel(path.join(adminDir, 'js/api.js')) + ' (preview mock)');
      const gasFile = path.join(adminDir, 'js/api-gas.js');
      used.push(rel(gasFile));
      // preview: 모의 api.js 를 먼저 읽어 두고(__RFW_MOCK) 가짜 google.script 가 그것을 부른다
      const pre = preview
        ? '<script>/* js/api.js (preview mock) */\n' + safeJs(readText(file)) + '\nwindow.__RFW_MOCK = window.AdminAPI;\n</script>\n' +
          '<script>/* tools/gas-preview-shim.js */\n' + safeJs(readText(path.join(ROOT, 'tools/gas-preview-shim.js'))) + '\n</script>\n'
        : '';
      return pre + '<script>/* js/api-gas.js */\n' + safeJs(readText(gasFile)) + '\n</script>';
    }
    used.push(rel(file));
    return '<script>/* ' + src + ' */\n' + safeJs(readText(file)) + '\n</script>';
  });

  // 참가자 화면 링크: 절대 주소로 (새 창, HtmlService IFRAME 은 _blank/_top 만 허용)
  html = html.replace(/href=["'](?:\.\.\/)+web\/(?:index\.html)?["']/g, 'href="' + SITE + '"');

  // 남은 로컬 참조 점검
  const leftovers = [...html.matchAll(/\b(?:src|href)=["']([^"'#][^"']*)["']/gi)].map((m) => m[1]).filter(isLocal);
  if (leftovers.length) warn('Admin.html 에 로컬 참조가 남아 있어요: ' + leftovers.join(', '));
  if (html.includes('<?')) warn('Admin.html 에 "<?" 가 있어요 — createTemplateFromFile 로 바꾸면 스크립틀릿으로 해석돼요');
  return { html, used };
}

/* ---------- 실행 ---------- */
fs.mkdirSync(DIST, { recursive: true });
const admin = buildAdminHtml();
const api = buildProject('api');
const adm = buildProject('admin', { 'Admin.html': admin.html });
let previewFile = null;
if (PREVIEW) {
  const dir = path.join(DIST, 'preview');
  cleanDir(dir);
  previewFile = path.join(dir, 'Admin.html');
  fs.writeFileSync(previewFile, buildAdminHtml({ preview: true }).html);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('\nApps Script 빌드 완료');
console.log('  ' + rel(api.target) + '/   ' + (api.files.length ? api.files.join(', ') : '(비어 있음)'));
console.log('  ' + rel(adm.target) + '/ ' + adm.files.join(', '));
console.log('  Admin.html ' + kb(Buffer.byteLength(admin.html)) + ' — 인라인: ' + admin.used.join(', '));
console.log('  접수 페이지 링크: ' + SITE + (opt('site') || process.env.RFW_SITE_URL ? '' : ' (기본값 — --site=… 로 바꿀 수 있음)'));
console.log('  배포: cd gas/dist/<api|admin> && npx @google/clasp@3.4.1 --user rfw push -f');
if (previewFile) console.log('  미리보기: ' + rel(previewFile) + ' (배포되지 않음, 가짜 google.script + 모의 데이터)');
if (warnings.length) console.log('  경고 ' + warnings.length + '건 (위 참고)');
