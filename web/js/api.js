/* 참가자 API — docs/api.md 계약.
   API_BASE 가 비어 있으면 모의 구현(메모리 + localStorage)을 쓰고,
   채워져 있으면 같은 함수 시그니처로 실제 Worker 를 호출한다.
   모든 함수는 { ok: true, data } 또는 { ok: false, code, fields? } 로 resolve 한다.
   네트워크 오류만 reject 한다. */

// Cloudflare Worker URL 로 교체 예정 (예: "https://rfw-api.<account>.workers.dev")
const API_BASE = "";

(function () {
  "use strict";

  var PHONE_RE = /^01[016789]\d{7,8}$/;
  var DAYS = ["day1", "day2", "both"];

  /* ── 실제 호출 ── */
  function call(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    return fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (res) { return res.json(); });
  }

  /* ── 모의 구현 ── */
  var params = new URLSearchParams(location.search);
  var MOCK = params.get("mock"); // closed | full | reset
  var STORE_KEY = "rfw-mock-v1";
  var SEED = {
    receiptNo: "RF26-1118-0041",
    createdAt: "2026-11-18T10:12:00+09:00",
    updatedAt: "2026-11-18T10:12:00+09:00",
    status: "active",
    name: "김전북",
    org: "전북대학교 대학원 기계공학과",
    phone: "01011112222",
    day: "both",
    consentAt: "2026-11-18T10:12:00+09:00",
    lang: "ko",
    src: "sms",
    token: "demo-token"
  };

  function storageGet() {
    try {
      if (MOCK === "reset") localStorage.removeItem(STORE_KEY);
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function storageSet(db) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { /* 저장 불가 — 메모리로만 유지 */ }
  }

  var db = storageGet();
  if (!db || !Array.isArray(db.regs)) db = { seq: 41, regs: [] };
  if (!db.regs.some(function (r) { return r.token === SEED.token; })) db.regs.unshift(Object.assign({}, SEED));
  storageSet(db);

  function wait(value, ms) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, ms == null ? 400 : ms); });
  }
  function ok(data) { return wait({ ok: true, data: data }); }
  function fail(code, extra) { return wait(Object.assign({ ok: false, code: code }, extra || {})); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowIso() { return new Date().toISOString(); }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }

  function randomToken() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    var out = "";
    var buf = new Uint8Array(40);
    try { crypto.getRandomValues(buf); } catch (e) { for (var i = 0; i < 40; i++) buf[i] = Math.floor(Math.random() * 256); }
    for (var j = 0; j < buf.length; j++) out += chars[buf[j] % chars.length];
    return out;
  }

  function active() { return db.regs.filter(function (r) { return r.status === "active"; }); }

  function buildConfig() {
    var cfg = clone(window.RFW_CONFIG || {});
    if (MOCK === "closed") cfg.open = false;

    // 집계: 22일 = day1 + both, 23일 = day2 + both
    var list = active();
    var c1 = list.filter(function (r) { return r.day === "day1" || r.day === "both"; }).length;
    var c2 = list.filter(function (r) { return r.day === "day2" || r.day === "both"; }).length;
    var byVal = {};
    (cfg.days || []).forEach(function (d) { byVal[d.value] = d; });
    function rem(d, count) { return d && d.capacity != null ? d.capacity - count : null; }
    var r1 = rem(byVal.day1, c1), r2 = rem(byVal.day2, c2);
    if (byVal.day1) byVal.day1.remaining = r1;
    if (byVal.day2) byVal.day2.remaining = r2;
    if (byVal.both) {
      var parts = [r1, r2].filter(function (v) { return v != null; });
      byVal.both.remaining = parts.length ? Math.min.apply(null, parts) : null;
    }

    if (MOCK === "full") {
      if (byVal.day1) { byVal.day1.capacity = 200; byVal.day1.remaining = 0; }
      if (byVal.day2) { byVal.day2.capacity = 200; byVal.day2.remaining = 38; }
      if (byVal.both) { byVal.both.remaining = 0; }
    }
    return cfg;
  }

  function isClosed(cfg) {
    if (!cfg.open) return true;
    var t = Date.parse(cfg.closeAt);
    return !isNaN(t) && Date.now() > t;
  }

  function dayFull(cfg, day) {
    var d = (cfg.days || []).filter(function (x) { return x.value === day; })[0];
    return !!(d && d.remaining != null && d.remaining <= 0);
  }

  function validate(p, needConsent) {
    var f = {};
    var name = String(p.name || "").trim();
    var org = String(p.org || "").trim();
    if (!name || name.length > 40) f.name = true;
    if (!org || org.length > 60) f.org = true;
    if (!PHONE_RE.test(digits(p.phone))) f.phone = true;
    if (DAYS.indexOf(p.day) < 0) f.day = true;
    if (needConsent && p.consent !== true) f.consent = true;
    return Object.keys(f).length ? f : null;
  }

  function receiptNo() {
    db.seq += 1;
    var d = new Date();
    var mmdd = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    return "RF26-" + mmdd + "-" + String(db.seq).padStart(4, "0");
  }

  var mock = {
    getConfig: function () { return ok(buildConfig()); },

    submit: function (p) {
      p = p || {};
      var cfg = buildConfig();
      if (p.hp) return ok({ receiptNo: "RF26-0000-0000", name: p.name, org: p.org, day: p.day, token: "" }); // 봇: 조용히 버림
      if (isClosed(cfg)) return fail("CLOSED");
      var fields = validate(p, true);
      if (fields) return fail("VALIDATION", { fields: fields });
      var phone = digits(p.phone);
      if (active().some(function (r) { return r.phone === phone; })) return fail("DUPLICATE");
      if (dayFull(cfg, p.day)) return fail("DAY_FULL");
      var now = nowIso();
      var reg = {
        receiptNo: receiptNo(), createdAt: now, updatedAt: now, status: "active",
        name: String(p.name).trim(), org: String(p.org).trim(), phone: phone, day: p.day,
        consentAt: now, lang: p.lang || "ko", src: p.src || "direct", token: randomToken()
      };
      db.regs.push(reg);
      storageSet(db);
      return ok({ receiptNo: reg.receiptNo, name: reg.name, org: reg.org, day: reg.day, token: reg.token });
    },

    lookup: function (token) {
      var r = db.regs.filter(function (x) { return token && x.token === token; })[0];
      if (!r) return fail("INVALID_TOKEN");
      return ok({ receiptNo: r.receiptNo, name: r.name, org: r.org, phone: r.phone, day: r.day, status: r.status });
    },

    update: function (token, p) {
      p = p || {};
      var r = db.regs.filter(function (x) { return token && x.token === token; })[0];
      if (!r || r.status !== "active") return fail("INVALID_TOKEN");
      var fields = validate(p, false);
      if (fields) return fail("VALIDATION", { fields: fields });
      var phone = digits(p.phone);
      if (active().some(function (x) { return x !== r && x.phone === phone; })) return fail("DUPLICATE");
      if (p.day !== r.day && dayFull(buildConfig(), p.day)) return fail("DAY_FULL");
      r.name = String(p.name).trim(); r.org = String(p.org).trim(); r.phone = phone; r.day = p.day;
      r.updatedAt = nowIso();
      storageSet(db);
      return ok({ receiptNo: r.receiptNo, name: r.name, org: r.org, day: r.day });
    },

    cancel: function (token) {
      var r = db.regs.filter(function (x) { return token && x.token === token; })[0];
      if (!r || r.status !== "active") return fail("INVALID_TOKEN");
      r.status = "canceled";
      r.updatedAt = nowIso();
      storageSet(db);
      return ok({ receiptNo: r.receiptNo, status: "canceled" });
    },

    // 번호 존재 여부를 노출하지 않도록 항상 성공으로 응답한다.
    resendLink: function () { return ok({ sent: true }); }
  };

  var real = {
    getConfig: function () { return call("config"); },
    submit: function (p) { return call("submit", p); },
    lookup: function (token) { return call("lookup", { token: token }); },
    update: function (token, p) { return call("update", Object.assign({ token: token }, p)); },
    cancel: function (token) { return call("cancel", { token: token }); },
    resendLink: function (phone) { return call("resend", { phone: phone }); }
  };

  window.RFW_API = API_BASE ? real : mock;
})();
