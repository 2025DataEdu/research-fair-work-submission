// npm test (= node --test test/*.test.mjs) — Worker 를 직접 import 해 가짜 env·fetch·caches 로 시험한다.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ORIGIN = "https://2025dataedu.github.io";
const GAS_URL = "https://script.google.com/macros/s/TEST/exec";
const realFetch = globalThis.fetch;

let upstream;   // 가짜 Apps Script 응답 함수 (body) => Response | Promise
let calls;      // Apps Script 로 간 본문 목록
let cacheStore;

function limiter(success = true) {
  const keys = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } };
}

function makeEnv(over = {}) {
  return {
    GAS_URL,
    GAS_KEY: "secret-key",
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8787`,
    RL_WRITE: limiter(true),
    RL_READ: limiter(true),
    ...over
  };
}

function makeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), done: () => Promise.all(pending) };
}

function post(body, { origin = ORIGIN, ip = "203.0.113.7", raw } = {}) {
  const headers = { "Content-Type": "text/plain;charset=utf-8", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return new Request("https://rfw-api.example.workers.dev/", {
    method: "POST", headers, body: raw !== undefined ? raw : JSON.stringify(body)
  });
}

function gasJson(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function run(req, env = makeEnv(), ctx = makeCtx()) {
  const res = await worker.fetch(req, env, ctx);
  await ctx.done();
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 일반 텍스트 */ }
  return { res, body, text };
}

beforeEach(() => {
  calls = [];
  upstream = () => gasJson({ ok: true, data: { receiptNo: "RF26-1119-0001" } });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, GAS_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "follow");
    assert.match(init.headers["Content-Type"], /^text\/plain/);
    const body = JSON.parse(init.body);
    calls.push(body);
    return upstream(body, init);
  };
  cacheStore = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => { const v = cacheStore.get(req.url); return v ? new Response(v) : undefined; },
      put: async (req, res) => { cacheStore.set(req.url, await res.text()); },
      delete: async (req) => cacheStore.delete(req.url)
    }
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

/* ── 경로·출처 ── */
test("GET /health 는 200", async () => {
  const { res, body } = await run(new Request("https://x.workers.dev/health"));
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.key, true);
  assert.ok(!JSON.stringify(body).includes("secret-key"), "비밀값이 노출되면 안 된다");
});

test("알 수 없는 경로는 404, / 의 GET 은 405", async () => {
  assert.equal((await run(new Request("https://x.workers.dev/exec", { method: "POST" }))).res.status, 404);
  assert.equal((await run(new Request("https://x.workers.dev/"))).res.status, 405);
});

test("허용된 출처는 CORS 헤더를 받는다", async () => {
  const { res, body } = await run(post({ action: "lookup", token: "abc" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Vary"), /Origin/);
  assert.equal(body.ok, true);
});

test("허용되지 않은 출처·출처 없음은 403 이고 Apps Script 를 부르지 않는다", async () => {
  for (const origin of ["https://evil.example", null]) {
    const { res } = await run(post({ action: "submit" }, { origin }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(calls.length, 0);
});

test("OPTIONS 사전요청: 허용 출처 204, 아니면 403", async () => {
  const mk = (origin) => new Request("https://x.workers.dev/", { method: "OPTIONS", headers: { Origin: origin } });
  const ok = await run(mk(ORIGIN));
  assert.equal(ok.res.status, 204);
  assert.match(ok.res.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.equal((await run(mk("https://evil.example"))).res.status, 403);
});

test("ALLOWED_ORIGINS 가 없으면 기본 목록(GitHub Pages·localhost:8787)을 쓴다", async () => {
  const env = makeEnv(); delete env.ALLOWED_ORIGINS;
  assert.equal((await run(post({ action: "lookup", token: "a" }, { origin: "http://127.0.0.1:8787" }), env)).res.status, 200);
  assert.equal((await run(post({ action: "lookup", token: "a" }, { origin: "http://localhost:3000" }), env)).res.status, 403);
});

/* ── 본문 검증 ── */
test("깨진 JSON → 400 BAD_REQUEST", async () => {
  const { res, body } = await run(post(null, { raw: "{not json" }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { ok: false, code: "BAD_REQUEST" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(calls.length, 0);
});

test("JSON 이지만 객체가 아니면 400", async () => {
  for (const raw of ["[1,2]", "null", "\"config\""]) {
    assert.equal((await run(post(null, { raw }))).res.status, 400);
  }
});

test("알 수 없는 action → 400", async () => {
  for (const action of ["adminList", "", undefined, 3]) {
    const { res } = await run(post({ action }));
    assert.equal(res.status, 400);
  }
  assert.equal(calls.length, 0);
});

test("4 KB 넘는 본문 → 413", async () => {
  const { res } = await run(post({ action: "submit", name: "가".repeat(2000) }));
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test("클라이언트가 보낸 k 는 버리고 Worker 의 GAS_KEY 를 붙인다", async () => {
  await run(post({ action: "submit", name: "홍길동", k: "attacker" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].k, "secret-key");
  assert.equal(calls[0].action, "submit");
  assert.equal(calls[0].name, "홍길동");
});

/* ── 횟수 제한 ── */
test("쓰기 action 은 RL_WRITE, 읽기 action 은 RL_READ 로 IP 단위 확인", async () => {
  const env = makeEnv();
  await run(post({ action: "submit" }, { ip: "198.51.100.1" }), env);
  await run(post({ action: "resend", phone: "01012345678" }, { ip: "198.51.100.1" }), env);
  await run(post({ action: "lookup", token: "t" }, { ip: "198.51.100.2" }), env);
  assert.deepEqual(env.RL_WRITE.keys, ["w:198.51.100.1", "w:198.51.100.1"]);
  assert.deepEqual(env.RL_READ.keys, ["r:198.51.100.2"]);
});

test("한도 초과 → HTTP 200 {ok:false, code:RATE_LIMITED}, Apps Script 호출 없음", async () => {
  const env = makeEnv({ RL_WRITE: limiter(false) });
  const { res, body } = await run(post({ action: "submit" }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: false, code: "RATE_LIMITED" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(calls.length, 0);
});

test("바인딩이 없으면 경고만 남기고 통과(fail open)", async () => {
  const env = makeEnv(); delete env.RL_WRITE; delete env.RL_READ;
  const { body } = await run(post({ action: "submit" }), env);
  assert.equal(body.ok, true);
  assert.equal(calls.length, 1);
});

test("limit() 가 예외를 던져도 통과", async () => {
  const env = makeEnv({ RL_READ: { limit: async () => { throw new Error("boom"); } } });
  assert.equal((await run(post({ action: "lookup", token: "t" }), env)).body.ok, true);
});

/* ── Apps Script 응답 처리 ── */
test("성공 응답과 공개 오류 코드는 그대로 전달 (VALIDATION fields 포함)", async () => {
  upstream = () => gasJson({ ok: false, code: "VALIDATION", fields: { phone: true } });
  assert.deepEqual((await run(post({ action: "submit" }))).body, { ok: false, code: "VALIDATION", fields: { phone: true } });
  for (const code of ["DUPLICATE", "DAY_FULL", "CLOSED", "INVALID_TOKEN"]) {
    upstream = () => gasJson({ ok: false, code });
    assert.deepEqual((await run(post({ action: "update", token: "t" }))).body, { ok: false, code });
  }
});

test("Apps Script 가 HTML(오류·로그인 화면)을 주면 SERVER", async () => {
  upstream = () => new Response("<!DOCTYPE html><html><body>Script function not found: doPost</body></html>", {
    status: 200, headers: { "Content-Type": "text/html" }
  });
  const { res, body } = await run(post({ action: "submit" }));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: false, code: "SERVER" });
});

test("Apps Script HTTP 오류·모양이 다른 JSON → SERVER", async () => {
  upstream = () => new Response("oops", { status: 500 });
  assert.deepEqual((await run(post({ action: "submit" }))).body, { ok: false, code: "SERVER" });
  upstream = () => gasJson({ result: "ok" });
  assert.deepEqual((await run(post({ action: "submit" }))).body, { ok: false, code: "SERVER" });
});

test("Apps Script 가 FORBIDDEN(비밀값 불일치)을 주면 브라우저에는 SERVER 만 보인다", async () => {
  upstream = () => gasJson({ ok: false, code: "FORBIDDEN", message: "bad key" });
  const { body, text } = await run(post({ action: "submit" }));
  assert.deepEqual(body, { ok: false, code: "SERVER" });
  assert.ok(!text.includes("FORBIDDEN"));
});

test("알 수 없는 오류 코드도 SERVER 로 바꾼다", async () => {
  upstream = () => gasJson({ ok: false, code: "LOCK_TIMEOUT" });
  assert.deepEqual((await run(post({ action: "submit" }))).body, { ok: false, code: "SERVER" });
});

test("fetch 실패(네트워크) → SERVER", async () => {
  upstream = () => { throw new TypeError("network down"); };
  assert.deepEqual((await run(post({ action: "cancel", token: "t" }))).body, { ok: false, code: "SERVER" });
});

test("Apps Script 가 15초 안에 답하지 않으면 SERVER (AbortController)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  upstream = (_body, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const pending = worker.fetch(post({ action: "submit" }), makeEnv(), makeCtx());
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(14999);
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "15초 전에는 기다린다");
  t.mock.timers.tick(1);
  const res = await pending;
  assert.deepEqual(await res.json(), { ok: false, code: "SERVER" });
});

test("GAS_URL·GAS_KEY 가 없으면 SERVER", async () => {
  const env = makeEnv(); delete env.GAS_KEY;
  assert.deepEqual((await run(post({ action: "submit" }), env)).body, { ok: false, code: "SERVER" });
  assert.equal(calls.length, 0);
});

/* ── config 캐시 · 방문 집계 ── */
const CFG = { ok: true, data: { open: true, days: [] } };

test("src 있는 config 는 매번 Apps Script 로 가고(방문 집계), 결과를 캐시에 넣는다", async () => {
  upstream = () => gasJson(CFG);
  await run(post({ action: "config", src: "sms" }));
  await run(post({ action: "config", src: "qr" }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.src), ["sms", "qr"]);
  assert.equal(cacheStore.size, 1);
});

test("src 없는 config 는 캐시에서 응답한다", async () => {
  upstream = () => gasJson(CFG);
  const first = await run(post({ action: "config" }));
  const second = await run(post({ action: "config" }));
  assert.deepEqual(first.body, CFG);
  assert.deepEqual(second.body, CFG);
  assert.equal(calls.length, 1);
  assert.equal(second.res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("실패한 config 는 캐시하지 않는다", async () => {
  upstream = () => new Response("<html>", { status: 200 });
  await run(post({ action: "config" }));
  assert.equal(cacheStore.size, 0);
});

test("src 있는 config 가 실패하면 캐시된 설정으로 대신 응답", async () => {
  upstream = () => gasJson(CFG);
  await run(post({ action: "config" }));
  upstream = () => { throw new TypeError("down"); };
  const { body } = await run(post({ action: "config", src: "sms" }));
  assert.deepEqual(body, CFG);
});

test("신청 성공·DAY_FULL 뒤에는 config 캐시를 지운다 (남은 자리 갱신)", async () => {
  upstream = () => gasJson(CFG);
  await run(post({ action: "config" }));
  assert.equal(cacheStore.size, 1);
  upstream = () => gasJson({ ok: true, data: { receiptNo: "RF26-1119-0002" } });
  await run(post({ action: "submit" }));
  assert.equal(cacheStore.size, 0);

  upstream = () => gasJson(CFG);
  await run(post({ action: "config" }));
  upstream = () => gasJson({ ok: false, code: "DAY_FULL" });
  await run(post({ action: "update", token: "t" }));
  assert.equal(cacheStore.size, 0);

  upstream = () => gasJson(CFG);
  await run(post({ action: "config" }));
  upstream = () => gasJson({ ok: false, code: "DUPLICATE" });
  await run(post({ action: "submit" }));
  assert.equal(cacheStore.size, 1, "DUPLICATE 는 인원이 바뀌지 않으므로 유지");
});

test("caches 가 없는 환경에서도 config 가 동작한다", async () => {
  delete globalThis.caches;
  upstream = () => gasJson(CFG);
  assert.deepEqual((await run(post({ action: "config" }))).body, CFG);
  assert.deepEqual((await run(post({ action: "config" }))).body, CFG);
  assert.equal(calls.length, 2);
});
