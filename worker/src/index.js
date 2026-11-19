/* 리서치페어 위크 접수 API 프록시 (Cloudflare Worker)
   브라우저 → 이 Worker(출처 확인·IP당 횟수 제한) → Apps Script 웹앱 /exec (doPost) → 구글 시트.
   계약: docs/api.md — 요청 POST text/plain JSON {action,...}, 응답 {ok,data} | {ok:false,code}.

   환경 값 (wrangler.toml [vars] / 비밀값)
   - GAS_URL          Apps Script 웹앱 /exec 주소
   - GAS_KEY          (secret) Apps Script 가 확인하는 비밀값. 본문 필드 k 로 붙인다 — Apps Script 는 헤더를 읽지 못한다
   - ALLOWED_ORIGINS  허용 출처, 쉼표 구분
   - RL_WRITE/RL_READ Rate Limiting 바인딩 (wrangler.toml [[ratelimits]]) */

const ACTIONS = new Set(["config", "submit", "lookup", "update", "cancel", "resend"]);
const WRITE_ACTIONS = new Set(["submit", "update", "cancel", "resend"]);
// 브라우저에 그대로 넘겨도 되는 오류 코드. 그 밖(FORBIDDEN 등 내부 코드)은 모두 SERVER 로 바꾼다.
const PUBLIC_CODES = new Set(["VALIDATION", "DUPLICATE", "DAY_FULL", "CLOSED", "RATE_LIMITED", "INVALID_TOKEN", "SERVER"]);

const MAX_BODY = 4 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;
const CONFIG_TTL = 30; // 초

const DEFAULT_ORIGINS = "https://2025dataedu.github.io,http://localhost:8787,http://127.0.0.1:8787";

/* ── 설정 캐시와 방문 집계 ──
   config 요청은 페이지를 열 때마다 오므로 Apps Script 호출의 대부분을 차지한다.
   방문 집계는 src 가 붙은 config 요청으로만 센다(Apps Script 쪽 규칙: src 없는 config 는 세지 않는다).
   참가자 화면(web/js/api.js)은 src 를 "탭 세션의 첫 config 요청"에만 붙인다 —
   새로고침·DAY_FULL 뒤 재조회·취소 뒤 재조회는 src 없이 보낸다.
   그래서 이 Worker 는
     · src 있는 config → 캐시를 건너뛰고 항상 Apps Script 로 보낸다(방문 1회 = 호출 1회, 집계가 정확하다).
                         성공 응답은 캐시에 넣어 둔다(추가 비용 없음).
                         Apps Script 가 실패해도 30초 안에 캐시된 설정이 있으면 그것을 돌려준다(방문 1건은 잃지만 화면은 정상).
     · src 없는 config → 30초 캐시(caches.default, 데이터센터 단위)에서 응답한다.
     · submit/update/cancel 이 성공하거나 DAY_FULL/CLOSED 이면 남은 자리가 바뀌었을 수 있으므로 캐시를 지운다.
   결과적으로 Apps Script 호출 수 ≈ 실제 방문자 수 + 쓰기 요청 수 이고, 반복 조회는 엣지에서 끝난다.
   한꺼번에 몰리는 문자 발송 직후에도 방문자당 1회라 Apps Script 동시 실행 한도(30) 안쪽에서 처리되는 것을 기대한다.
   그래도 몰림이 문제가 되면 방문 집계를 Worker 에서 모아 보내는 방식으로 바꿀 것. */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "method not allowed");
      return json(200, { ok: true, data: { service: "rfw-api", upstream: !!env.GAS_URL, key: !!env.GAS_KEY } }, null);
    }
    if (url.pathname !== "/") return plain(404, "not found");

    const allowed = allowedOrigin(origin, env);

    if (request.method === "OPTIONS") {
      if (!allowed) return plain(403, "forbidden");
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(allowed),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    if (request.method !== "POST") return plain(405, "method not allowed");
    if (!allowed) return plain(403, "forbidden");

    // 본문: 4 KB 이하, JSON 객체, 알려진 action
    const raw = await readCapped(request, MAX_BODY);
    if (raw === null) return json(413, { ok: false, code: "BAD_REQUEST" }, allowed);
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { ok: false, code: "BAD_REQUEST" }, allowed); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { ok: false, code: "BAD_REQUEST" }, allowed);
    const action = body.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) return json(400, { ok: false, code: "BAD_REQUEST" }, allowed);
    delete body.k; // 클라이언트가 보낸 k 는 절대 믿지 않는다

    // IP당 횟수 제한 — 휴대폰 통신사는 여러 사람이 IP 를 나눠 쓰므로 넉넉하게 잡는다
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const limiter = WRITE_ACTIONS.has(action) ? env.RL_WRITE : env.RL_READ;
    if (!(await withinLimit(limiter, (WRITE_ACTIONS.has(action) ? "w:" : "r:") + ip))) {
      return json(200, { ok: false, code: "RATE_LIMITED" }, allowed);
    }

    if (action === "config") return handleConfig(body, request, env, ctx, allowed);

    const result = await forward(body, env);
    if (action !== "resend" && (result.ok || result.code === "DAY_FULL" || result.code === "CLOSED")) {
      ctx?.waitUntil?.(cacheDelete(configCacheKey(request)));
    }
    return json(200, result, allowed);
  }
};

async function handleConfig(body, request, env, ctx, allowed) {
  const key = configCacheKey(request);
  const counting = typeof body.src === "string" && body.src !== "";

  if (!counting) {
    const hit = await cacheMatch(key);
    if (hit) return json(200, hit, allowed);
  }

  const result = await forward(body, env);
  if (result.ok) {
    ctx?.waitUntil?.(cachePut(key, result));
  } else if (counting && result.code === "SERVER") {
    const stale = await cacheMatch(key);
    if (stale) return json(200, stale, allowed);
  }
  return json(200, result, allowed);
}

/* ── Apps Script 호출 ──
   POST /exec 는 doPost 를 실행한 뒤 302 로 script.googleusercontent.com 을 가리킨다.
   fetch 의 redirect:"follow" 는 302 를 표준대로 GET(본문 없음)으로 따라가므로 그대로 결과를 받는다. */
async function forward(body, env) {
  if (!env.GAS_URL || !env.GAS_KEY) {
    console.error("GAS_URL 또는 GAS_KEY 가 설정되지 않았어요");
    return { ok: false, code: "SERVER" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(env.GAS_URL, {
      method: "POST",
      body: JSON.stringify({ ...body, k: env.GAS_KEY }),
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      redirect: "follow",
      signal: controller.signal
    });
    text = await res.text();
    if (!res.ok) {
      console.error("upstream HTTP", res.status, text.slice(0, 200));
      return { ok: false, code: "SERVER" };
    }
  } catch (err) {
    console.error("upstream fetch failed:", err && err.name === "AbortError" ? "timeout" : String(err));
    return { ok: false, code: "SERVER" };
  } finally {
    clearTimeout(timer);
  }
  return sanitize(text);
}

// Apps Script 응답을 계약 모양으로 좁힌다. HTML 오류 화면·로그인 화면·깨진 JSON → SERVER.
function sanitize(text) {
  let r;
  try { r = JSON.parse(text); } catch {
    console.error("upstream non-JSON:", String(text).slice(0, 200));
    return { ok: false, code: "SERVER" };
  }
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") return { ok: false, code: "SERVER" };
  if (r.ok) return { ok: true, data: r.data === undefined ? null : r.data };
  if (r.code === "FORBIDDEN") console.error("upstream FORBIDDEN — GAS_KEY 가 Apps Script 의 값과 다른지 확인하세요");
  if (!PUBLIC_CODES.has(r.code)) return { ok: false, code: "SERVER" };
  const out = { ok: false, code: r.code };
  if (r.code === "VALIDATION" && r.fields && typeof r.fields === "object") out.fields = r.fields;
  if (typeof r.message === "string") out.message = r.message;
  return out;
}

/* ── 횟수 제한 ── 바인딩이 없거나 오류면 막지 않고 통과시킨다(경고만 남김). */
let warnedNoLimiter = false;
async function withinLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== "function") {
    if (!warnedNoLimiter) { console.warn("rate limit binding 없음 — 제한 없이 통과"); warnedNoLimiter = true; }
    return true;
  }
  try {
    const { success } = await limiter.limit({ key });
    return success !== false;
  } catch (err) {
    console.warn("rate limit 확인 실패 — 통과:", String(err));
    return true;
  }
}

/* ── 출처(CORS) ── */
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function plain(status, text) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// 본문을 최대 max 바이트까지만 읽는다. 넘으면 null.
async function readCapped(request, max) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* noop */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/* ── 설정 캐시 (caches.default — 없으면 조용히 건너뜀) ── */
function configCacheKey(request) {
  return new URL("/__cache/config", request.url).toString();
}
function edgeCache() {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; } catch { return null; }
}
async function cacheMatch(key) {
  const c = edgeCache();
  if (!c) return null;
  try {
    const res = await c.match(new Request(key));
    return res ? await res.json() : null;
  } catch { return null; }
}
async function cachePut(key, obj) {
  const c = edgeCache();
  if (!c) return;
  try {
    await c.put(new Request(key), new Response(JSON.stringify(obj), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + CONFIG_TTL }
    }));
  } catch { /* noop */ }
}
async function cacheDelete(key) {
  const c = edgeCache();
  if (!c) return;
  try { await c.delete(new Request(key)); } catch { /* noop */ }
}
