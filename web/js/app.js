/* 참가자 신청 페이지 — 화면 문구는 모두 RFW_I18N, 행사 설정은 RFW_API.getConfig() 에서 읽는다. */
(function () {
  "use strict";

  var I18N = window.RFW_I18N;
  var API = window.RFW_API;
  var PHONE_RE = /^01[016789]\d{7,8}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var DAYS = ["day1", "day2", "both"];
  // 화면 순서 = 오류가 있을 때 포커스가 갈 순서
  var FIELDS = ["name", "affType", "org", "phone", "email", "day", "programs", "consent"];
  // 여러 입력(라디오·체크박스)으로 된 칸 — 오류 표시는 묶음(#f-칸)과 각 입력에 단다
  var GROUP_FIELDS = { affType: 1, day: 1, programs: 1 };
  var ERROR_KEYS = {
    name: "form.name.error", affType: "form.org.typeError", org: "form.org.error", phone: "form.phone.error",
    email: "form.email.error", day: "form.day.error", programs: "form.programs.error", consent: "form.consent.error"
  };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var params = new URLSearchParams(location.search);
  var src = (params.get("src") || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "direct";

  var SMS_ON = window.RFW_SMS_ENABLED !== false;   // 문자 연동 전에는 문자 관련 안내를 숨김 (js/config.js)

  var state = {
    lang: initialLang(),
    config: window.RFW_CONFIG,
    view: "loading",      // loading | form | done | canceled | closed
    mode: "new",          // new | edit
    token: params.get("t") || "",
    reg: null,            // 현재 신청 건 (완료·수정 모드)
    draft: emptyDraft(),
    submitted: false,     // 첫 제출 이후에만 오류 표시
    errors: {},           // { field: i18nKey }
    notice: null,         // { type, key }
    busy: false,
    confirmCancel: false,
    privacyOpen: false
  };

  /* ── 유틸 ── */
  function emptyDraft() {
    return { name: "", affType: "", org: "", phone: "", email: "", day: "", programs: [], consent: false };
  }
  function initialLang() {
    var q = params.get("lang");
    if (q === "en" || q === "ko") return q;
    try { var s = localStorage.getItem("rfw-lang"); if (s === "en" || s === "ko") return s; } catch (e) { /* noop */ }
    return "ko";
  }
  function t(path, vars) {
    var v = path.split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, I18N[state.lang]);
    if (v == null) v = path.split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, I18N.ko);
    if (typeof v === "string" && vars) v = v.replace(/\{(\w+)\}/g, function (_, k) { return vars[k]; });
    return v == null ? "" : v;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  // 휴대전화 숫자만 — 국가번호 +82 로 붙여 넣거나 자동완성돼도 국내 형식(0으로 시작)으로 바꾼다.
  // "+82 10-1234-5678" → 01012345678, "+82 010-…" → 010…
  function phoneDigits(s) {
    var d = digits(s);
    if (d.slice(0, 2) === "82") {
      d = d.slice(2);
      if (d.charAt(0) !== "0") d = "0" + d;
    }
    return d;
  }
  function formatPhone(raw) {
    var d = phoneDigits(raw).slice(0, 11);
    if (d.length < 4) return d;
    if (d.length < 8) return d.slice(0, 3) + "-" + d.slice(3);
    if (d.length === 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
    return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7);
  }
  function scrollToEl(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }
  function isClosed(cfg) {
    if (!cfg || !cfg.open) return true;
    var end = Date.parse(cfg.closeAt);
    return !isNaN(end) && Date.now() > end;
  }
  function icon(name) {
    var p = {
      check: '<path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
      alert: '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5.8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14" r="1.2" fill="currentColor"/>',
      info: '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="6.2" r="1.2" fill="currentColor"/>',
      chevron: '<path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    }[name];
    return '<svg class="i i--' + name + '" aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20">' + p + "</svg>";
  }

  /* ── 정적 문구 ── */
  function applyStatic() {
    var html = document.documentElement;
    html.lang = state.lang;
    document.title = t("intro.title");
    $all("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });

    var toggle = $("#lang-toggle");
    toggle.textContent = t("topbar.toggle");
    // 접근 가능한 이름이 보이는 글자(EN/한)로 시작하도록 (WCAG 2.5.3 label in name)
    toggle.setAttribute("aria-label", t("topbar.toggle") + " — " + t("topbar.toggleLabel"));
    toggle.setAttribute("lang", state.lang === "ko" ? "en" : "ko");

    var rfw = $("#rfw");
    rfw.setAttribute("aria-label", t("hero.rfwAlt"));

    var s = t("hero.dateStart"), e = t("hero.dateEnd");
    $("#hero-date").innerHTML =
      '<span class="nowrap">' + esc(s.y) + " " + esc(s.md) + '<sup lang="en">' + esc(s.dow) + "</sup></span>" +
      ' <span class="hero__tilde">~</span> ' +
      '<span class="nowrap">' + esc(e.md) + '<sup lang="en">' + esc(e.dow) + "</sup></span>";

    renderTagline();
    renderProgram();
    renderFooter();
  }

  function renderTagline() {
    var tg = (state.config && state.config.tagline) || {};
    var lines;
    if (state.lang === "ko" && Array.isArray(tg.ko)) {
      lines = tg.ko;
    } else {
      // 영문 태그라인은 문자열 — ' to ' 기준 두 줄, 'Phase N' 강조
      var str = typeof tg.en === "string" ? tg.en : "";
      var parts = str.split(/ (?=to )/);
      lines = parts.map(function (line) {
        return line.split(/(Phase \d+)/).filter(Boolean).map(function (seg) {
          return { t: seg, em: /^Phase \d+$/.test(seg) };
        });
      });
    }
    $("#tagline").innerHTML = lines.map(function (line, i) {
      return '<span class="tagline__line">' + line.map(function (seg) {
        if (!seg.em) return '<span class="tagline__rest">' + esc(seg.t) + "</span>";
        // 첫 줄 강조어에는 포스터처럼 글자 위 점을 찍는다
        var dots = i === 0 && state.lang === "ko"
          ? '<span class="tagline__dots" aria-hidden="true">' + Array.from(seg.t).map(function (ch) {
              return /\s/.test(ch) ? " " : "<span>" + esc(ch) + "</span>";
            }).join("") + "</span>"
          : "";
        return '<span class="tagline__em">' + esc(seg.t) + dots + "</span>";
      }).join("") + "</span>";
    }).join("");
  }

  function renderProgram() {
    var prog = (state.config && state.config.program) || {};
    var show = !!(state.config && state.config.showSpeakers);
    var L = state.lang;
    $("#program").innerHTML = ["day1", "day2"].filter(function (k) { return prog[k]; }).map(function (k) {
      var day = prog[k];
      var head = day[L] || day.ko;
      var items = day.items || [];
      var placeOf = function (it) { return L === "en" ? (it.placeEn || it.place || "") : (it.place || ""); };
      // 그날 모든 행의 장소가 같으면 머리에 한 번만 쓰고 행마다 반복하지 않는다
      var shared = items.length && items.every(function (it) { return placeOf(it) && placeOf(it) === placeOf(items[0]); })
        ? placeOf(items[0]) : "";
      var tbd = '<span class="prog__tbd">' + esc(t("program.tbd")) + "</span>";
      var rows = items.map(function (it) {
        var what = L === "en" ? (it.en || it.ko) : it.ko;
        var place = placeOf(it);
        var speaker = show && it.speaker ? '<span class="prog__speaker">' + esc(it.speaker) + "</span>" : "";
        return '<tr class="' + (it.highlight ? "is-hl" : "") + '">' +
          '<td class="prog__time' + (it.time ? "" : " is-empty") + '">' + (it.time ? esc(it.time) : tbd) + "</td>" +
          '<td class="prog__what">' + esc(what) + speaker + "</td>" +
          (shared ? "" : '<td class="prog__place">' + (place ? esc(place) : tbd) + "</td>") +
          "</tr>";
      }).join("");
      return '<article class="prog" aria-labelledby="prog-' + k + '">' +
        '<div class="prog__head">' +
          '<h3 class="prog__heading" id="prog-' + k + '">' +
            '<span class="prog__date">' + esc(head.date) + '<sup lang="en">' + esc(head.dow) + "</sup></span>" +
            '<span class="prog__title">' + esc(head.title) + "</span>" +
          "</h3>" +
          (shared ? '<p class="prog__where"><span class="sr-only">' + esc(t("program.place")) + " </span>" + esc(shared) + "</p>" : "") +
        "</div>" +
        '<table class="prog__table">' +
          "<thead><tr>" +
            '<th scope="col" class="prog__th-time">' + esc(t("program.time")) + "</th>" +
            '<th scope="col">' + esc(t("program.content")) + "</th>" +
            (shared ? "" : '<th scope="col" class="prog__th-place">' + esc(t("program.place")) + "</th>") +
          "</tr></thead><tbody>" + rows + "</tbody></table>" +
        "</article>";
    }).join("");
  }

  function privacyTable() {
    return '<table class="ptable"><tbody>' + t("privacy.rows").map(function (r) {
      return '<tr><th scope="row">' + esc(r[0]) + "</th><td>" + esc(r[1]) + "</td></tr>";
    }).join("") + "</tbody></table>";
  }

  function renderFooter() {
    var c = (state.config && state.config.contact) || {};
    var parts = [];
    if (c.phone) parts.push('<a href="tel:' + esc(digits(c.phone)) + '">' + esc(c.phone) + "</a>");
    if (c.email) parts.push('<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a>");
    $("#footer-contact").innerHTML = parts.length ? parts.join('<span class="sep" aria-hidden="true"> · </span>') : esc(t("footer.contactTbd"));

    var link = $("#footer-privacy");
    var url = (state.config && state.config.privacyUrl) || "#privacy";
    link.setAttribute("href", url);
    if (url.charAt(0) === "#") {
      link.setAttribute("aria-controls", "privacy");
      link.setAttribute("aria-expanded", String(state.privacyOpen));
    }
    $all("[data-privacy]").forEach(function (el) { el.innerHTML = privacyTable(); });
  }

  /* ── RFW 그래픽 ── */
  function loadRfw() {
    var box = $("#rfw");
    var fallback = function () { box.innerHTML = '<span class="rfw-fallback" aria-hidden="true">RFW</span>'; box.classList.add("rfw--fallback"); };
    if (!window.fetch) return fallback();
    fetch("assets/rfw.svg").then(function (r) {
      if (!r.ok) throw new Error("rfw " + r.status);
      return r.text();
    }).then(function (svg) {
      if (svg.indexOf("<svg") < 0) throw new Error("not svg");
      box.innerHTML = svg;
      var el = box.querySelector("svg");
      if (el) { el.setAttribute("aria-hidden", "true"); el.setAttribute("focusable", "false"); }
    }).catch(fallback);
  }

  /* ── 카드 렌더링 ── */
  function dayOptions() {
    var cfg = (state.config && state.config.days) || DAYS.map(function (v) { return { value: v }; });
    return cfg.filter(function (d) { return DAYS.indexOf(d.value) >= 0; });
  }

  // 선택지 문구를 ' · ' 뒤에서만 줄바꿈되게 감싼다 — 글자는 원문 그대로 (textContent 동일)
  function dayLabel(value) {
    var s = t("days." + value);
    var i = s.indexOf(" · ");
    if (i < 0) return esc(s);
    return '<span class="nowrap">' + esc(s.slice(0, i + 2)) + "</span> " +
      '<span class="nowrap">' + esc(s.slice(i + 3)) + "</span>";
  }

  /* ── 소속 구분·세부 프로그램 (피드백 2) ── */
  function affiliations() {
    var list = (state.config && state.config.affiliations) || [];
    return list.filter(function (a) { return a && a.id; });
  }
  function affLabel(id) {
    var a = affiliations().filter(function (x) { return x.id === id; })[0];
    if (!a) return "";
    return state.lang === "en" ? (a.en || a.ko) : a.ko;
  }
  // 고른 참석일에 속한 날 — day1 → [day1], day2 → [day2], both → 둘 다
  function dayKeys(day) { return day === "both" ? ["day1", "day2"] : (day === "day1" || day === "day2" ? [day] : []); }
  // 그날 세부 프로그램 — 안내 표와 같은 원본(program.items). id 가 없으면(옛 설정) 그날 순서로 d1-1… 을 쓴다
  function programItems(k) {
    var p = ((state.config && state.config.program) || {})[k];
    return ((p && p.items) || []).map(function (it, i) {
      return { id: String(it.id || (k === "day1" ? "d1-" : "d2-") + (i + 1)), ko: it.ko || "", en: it.en || "", time: it.time || "" };
    });
  }
  function programName(it) { return state.lang === "en" ? (it.en || it.ko) : it.ko; }
  function findProgram(id) {
    var hit = null;
    ["day1", "day2"].forEach(function (k) {
      programItems(k).forEach(function (it) { if (!hit && it.id === id) hit = { day: k, item: it }; });
    });
    return hit;
  }
  // 체크박스 id — 프로그램 id 기준이라 다시 그려도 같다(포커스 복원)
  function progInputId(id) { return "f-prog-" + String(id).replace(/[^a-z0-9_-]/gi, "_"); }
  // 고른 날에 속한 것만 남긴다(중복 제거, 설정 순서)
  function keepPrograms(day, list) {
    var out = [];
    dayKeys(day).forEach(function (k) {
      programItems(k).forEach(function (it) { if ((list || []).indexOf(it.id) >= 0 && out.indexOf(it.id) < 0) out.push(it.id); });
    });
    return out;
  }

  function affBlock(d) {
    var pills = affiliations().map(function (a) {
      var id = "f-aff-" + String(a.id).replace(/[^a-z0-9_-]/gi, "_");
      return '<label class="pill" for="' + id + '">' +
        '<input class="pill__input" type="radio" name="affType" id="' + id + '" value="' + esc(a.id) + '"' + (d.affType === a.id ? " checked" : "") + ">" +
        '<span class="pill__box"><span class="pill__check">' + icon("check") + "</span>" +
          '<span class="pill__text">' + esc(state.lang === "en" ? (a.en || a.ko) : a.ko) + "</span></span>" +
        "</label>";
    }).join("");
    return '<fieldset class="field field--org" id="f-org-group">' +
      '<legend class="field__label"><span class="field__no" aria-hidden="true">2</span>' + esc(t("form.org.label")) + "</legend>" +
      '<div class="sub" data-field="affType">' +
        '<p class="sub__label" id="f-affType-label">' + esc(t("form.org.typeLabel")) + "</p>" +
        '<div class="pills" role="radiogroup" id="f-affType" aria-labelledby="f-affType-label" aria-required="true">' + pills + "</div>" +
        '<p class="field__error" id="f-affType-err" hidden></p>' +
      "</div>" +
      '<div class="sub" data-field="org">' +
        '<label class="sub__label" for="f-org">' + esc(t("form.org.detailLabel")) + "</label>" +
        '<p class="field__hint" id="f-org-hint">' + esc(t("form.org.hint")) + "</p>" +
        '<input class="input" id="f-org" name="org" type="text" autocomplete="organization" maxlength="60" aria-required="true" aria-describedby="f-org-hint" value="' + esc(d.org) + '">' +
        '<p class="field__error" id="f-org-err" hidden></p>' +
      "</div>" +
    "</fieldset>";
  }

  // 참석할 프로그램 — 고른 날마다 묶음 하나. prevDay 가 있으면 새로 나타난 날의 묶음만 부드럽게 보인다.
  function programsBlock(day, selected, prevDay) {
    var prog = (state.config && state.config.program) || {};
    var L = state.lang;
    var before = prevDay == null ? null : dayKeys(prevDay);
    var groups = dayKeys(day).map(function (k) {
      var items = programItems(k);
      if (!items.length) return "";   // 프로그램이 없는 날은 고를 것도, 요구할 것도 없다
      var head = (prog[k] && (prog[k][L] || prog[k].ko)) || {};
      var fresh = before && before.length && before.indexOf(k) < 0;   // 처음 나타날 때는 묶음 전체(.progs)가 움직인다
      var rows = items.map(function (it) {
        var id = progInputId(it.id);
        return '<label class="pcheck" for="' + id + '">' +
          '<input class="check__input" type="checkbox" name="programs" id="' + id + '" value="' + esc(it.id) + '"' +
            ((selected || []).indexOf(it.id) >= 0 ? " checked" : "") + ">" +
          '<span class="check__box">' + icon("check") + "</span>" +
          '<span class="pcheck__text"><span class="pcheck__name">' + esc(programName(it)) + "</span>" +
            (it.time ? '<span class="pcheck__time">' + esc(it.time) + "</span>" : "") +
          "</span></label>";
      }).join("");
      return '<fieldset class="pgroup' + (fresh ? " is-new" : "") + '">' +
        '<legend class="pgroup__head"><span class="pgroup__date">' + esc(head.date || "") +
          (head.dow ? ' <span lang="en">' + esc(head.dow) + "</span>" : "") + "</span> " +
          '<span class="pgroup__title">' + esc(head.title || "") + "</span></legend>" +
        rows + "</fieldset>";
    }).join("");
    if (!groups) return "";
    return '<div class="progs' + (before && !before.length ? " is-new" : "") + '" data-field="programs" id="f-programs" role="group" aria-labelledby="f-programs-label" aria-describedby="f-programs-hint">' +
      '<p class="sub__label" id="f-programs-label">' + esc(t("form.programs.label")) + "</p>" +
      '<p class="field__hint" id="f-programs-hint">' + esc(t("form.programs.hint")) + "</p>" +
      groups +
      '<p class="field__error" id="f-programs-err" hidden></p>' +
    "</div>";
  }

  function fieldBlock(id, no, opts) {
    var hint = opts.hint ? '<p class="field__hint" id="f-' + id + '-hint">' + esc(opts.hint) + "</p>" : "";
    return '<div class="field" data-field="' + id + '">' +
      '<label class="field__label" for="f-' + id + '"><span class="field__no" aria-hidden="true">' + no + "</span>" + esc(opts.label) + "</label>" +
      hint + opts.control +
      '<p class="field__error" id="f-' + id + '-err" hidden></p>' +
      "</div>";
  }

  function renderForm() {
    var d = state.draft;
    var edit = state.mode === "edit";
    var cur = state.reg && state.reg.day;

    var days = dayOptions().map(function (opt) {
      var full = opt.remaining != null && opt.remaining <= 0 && opt.value !== cur;
      var status = "";
      if (full) status = '<span class="badge">' + esc(t("form.full")) + "</span>";
      else if (opt.capacity != null && opt.remaining != null) status = '<span class="day__remain">' + esc(t("form.remaining", { n: opt.remaining })) + "</span>";
      var sid = "f-day-" + opt.value + "-st";
      return '<label class="day' + (full ? " is-full" : "") + '" for="f-day-' + opt.value + '">' +
        '<input class="day__input" type="radio" name="day" id="f-day-' + opt.value + '" value="' + opt.value + '"' +
          (d.day === opt.value ? " checked" : "") + (full ? " disabled" : "") +
          (status ? ' aria-describedby="' + sid + '" data-describedby="' + sid + '"' : "") + ">" +
        '<span class="day__box">' +
          '<span class="day__text"><span class="day__label">' + dayLabel(opt.value) + "</span>" +
            (status ? '<span class="day__status" id="' + sid + '">' + status + "</span>" : "") +
          "</span>" +
          '<span class="day__check">' + icon("check") + "</span>" +
        "</span></label>";
    }).join("");

    var phoneHint = t("form.phone.hint"); // 영문 전용 — 국문은 빈 값이라 표시하지 않는다

    var head = edit
      ? '<p class="card__eyebrow">' + esc(t("done.receipt")) + ' <span class="mono">' + esc(state.reg.receiptNo) + "</span></p>" +
        '<h2 class="card__title" id="apply-title" tabindex="-1">' + esc(t("edit.title")) + "</h2>"
      : '<h2 class="card__title" id="apply-title" tabindex="-1">' + esc(t("intro.title")) + "</h2>";

    var html =
      '<form class="form" id="reg-form" novalidate>' +
        '<div class="card__head">' + head + '<p class="card__lead">' + esc(t("form.lead")) + "</p>" +
          '<p class="info-line card__mail">' + icon("info") + "<span>" + esc(t("form.mailNotice")) + "</span></p>" +
        "</div>" +
        '<div class="notice-slot" id="top-notice"></div>' +

        fieldBlock("name", 1, {
          label: t("form.name.label"), hint: t("form.name.hint"),
          control: '<input class="input" id="f-name" name="name" type="text" autocomplete="name" maxlength="40" aria-required="true" aria-describedby="f-name-hint" value="' + esc(d.name) + '">'
        }) +
        affBlock(d) +
        // maxlength 없음: "+82 10-1234-5678" 처럼 국가번호째 붙여 넣어도 잘리지 않게. 숫자 11자리는 formatPhone 이 제한한다.
        fieldBlock("phone", 3, {
          label: t("form.phone.label"), hint: phoneHint,
          control: '<input class="input input--tel" id="f-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" aria-required="true"' +
            (phoneHint ? ' aria-describedby="f-phone-hint"' : "") +
            ' placeholder="' + esc(t("form.phone.placeholder")) + '" value="' + esc(formatPhone(d.phone)) + '">'
        }) +
        fieldBlock("email", 4, {
          label: t("form.email.label"), hint: t("form.email.hint"),
          control: '<input class="input" id="f-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="100" aria-required="true" aria-describedby="f-email-hint"' +
            ' placeholder="' + esc(t("form.email.placeholder")) + '" value="' + esc(d.email) + '">'
        }) +

        '<fieldset class="field field--day" data-field="day" id="f-day" aria-describedby="f-day-hint">' +
          '<legend class="field__label"><span class="field__no" aria-hidden="true">5</span>' + esc(t("form.day.label")) + "</legend>" +
          '<p class="field__hint" id="f-day-hint">' + esc(t("form.day.hint")) + "</p>" +
          '<div class="days">' + days + "</div>" +
          '<p class="field__error" id="f-day-err" hidden></p>' +
          // 참석할 프로그램 — 고른 날에 따라 이 부분만 다시 그린다(onDayChange)
          '<div class="progs-slot" id="programs-slot" data-day="' + esc(d.day) + '">' + programsBlock(d.day, d.programs) + "</div>" +
        "</fieldset>" +

        '<div class="field field--consent" data-field="consent">' +
          '<div class="consent">' +
            // 수정 모드: 신청 때 받은 동의라 체크된 채로 잠근다 — 해제해서 저장이 막히는 일이 없게
            '<label class="check' + (edit ? " is-locked" : "") + '" for="f-consent">' +
              '<input class="check__input" type="checkbox" id="f-consent" name="consent" aria-required="true"' +
                (edit || d.consent ? " checked" : "") + (edit ? ' disabled aria-describedby="f-consent-note"' : "") + ">" +
              '<span class="check__box">' + icon("check") + "</span>" +
              '<span class="check__text">' + esc(t("form.consent.label")) + ' <span class="check__req">' + esc(t("form.consent.required")) + "</span></span>" +
            "</label>" +
            '<button type="button" class="disclose" id="consent-more" aria-expanded="false" aria-controls="consent-panel">' +
              '<span class="disclose__text"><span class="disclose__more">' + esc(t("form.consent.more")) + "</span>" +
                '<span class="disclose__less">' + esc(t("form.consent.less")) + "</span></span>" + icon("chevron") +
            "</button>" +
          "</div>" +
          (edit ? '<p class="consent__note" id="f-consent-note">' + esc(t("form.consent.locked")) + "</p>" : "") +
          '<div class="consent__panel" id="consent-panel" hidden>' +
            '<p class="consent__title">' + esc(t("privacy.title")) + "</p>" + privacyTable() +
          "</div>" +
          '<p class="field__error" id="f-consent-err" hidden></p>' +
        "</div>" +

        '<div class="hp" aria-hidden="true"><input type="text" name="website" id="f-website" tabindex="-1" autocomplete="off"></div>' +

        '<div class="notice-slot" id="form-notice"></div>' +
        '<button type="submit" class="btn-primary" id="submit-btn">' + esc(edit ? t("edit.save") : t("form.submit")) + "</button>" +
        (edit ? cancelBlock() : "") +
      "</form>";
    return html;
  }

  function cancelBlock() {
    if (!state.confirmCancel) {
      return '<div class="cancel-zone"><button type="button" class="btn-text btn-text--danger" id="cancel-open">' + esc(t("edit.cancel")) + "</button></div>";
    }
    return '<div class="cancel-zone cancel-zone--confirm" role="group" aria-labelledby="cancel-msg">' +
      '<p class="cancel-zone__msg" id="cancel-msg" tabindex="-1">' + icon("alert") + "<span>" + esc(t("edit.cancelConfirm")) + "</span></p>" +
      '<div class="cancel-zone__actions">' +
        '<button type="button" class="btn-outline btn-outline--danger" id="cancel-yes"' + (state.busy ? " disabled" : "") + ">" + esc(t("edit.cancelYes")) + "</button>" +
        '<button type="button" class="btn-text" id="cancel-no">' + esc(t("edit.cancelNo")) + "</button>" +
      "</div></div>";
  }

  // 고른 참석일의 날짜(+확정된 시작 시간)와 장소 — 설정(program)과 문구(hero.place)에서 만든다
  // 예) "12. 23. Wed · 전북대학교 진수당", 양일은 "12. 22. Tue ~ 12. 23. Wed · …"
  function whenWhere(day) {
    var prog = (state.config && state.config.program) || {};
    var L = state.lang;
    var part = function (k) {
      var p = prog[k];
      if (!p) return "";
      var h = p[L] || p.ko || {};
      var first = (p.items || [])[0];
      var time = first && first.time ? " " + first.time.split("~")[0] : "";
      return '<span class="nowrap">' + esc(h.date) + " " + '<span lang="en">' + esc(h.dow) + "</span>" + esc(time) + "</span>";
    };
    var keys = day === "both" ? ["day1", "day2"] : [day];
    var dates = keys.map(part).filter(Boolean);
    if (!dates.length) return "";
    return dates.join(" ~ ") + " · " + esc(t("hero.place"));
  }

  // 완료 화면의 참석 프로그램 목록 — 양일 참석이면 이름 앞에 날짜를 붙여 어느 날인지 보이게
  function doneProgramList(r) {
    var both = r.day === "both";
    var prog = (state.config && state.config.program) || {};
    var lis = (r.programs || []).map(function (id) {
      var hit = findProgram(id);
      if (!hit) return "<li>" + esc(id) + "</li>";   // 설정에서 지워진 프로그램 — id 라도 보여 준다
      var head = prog[hit.day] && (prog[hit.day][state.lang] || prog[hit.day].ko);
      var pre = both && head && head.date ? '<span class="summary__pday">' + esc(head.date) + "</span> " : "";
      return "<li>" + pre + esc(programName(hit.item)) + "</li>";
    }).join("");
    return lis ? '<ul class="summary__list">' + lis + "</ul>" : "";
  }

  function renderDone() {
    var r = state.reg;
    var when = whenWhere(r.day);
    var aff = affLabel(r.affType);
    var progs = doneProgramList(r);
    // "행사 전에 {email} 로 …" — 주소만 굵게, 나머지 문구는 원문 그대로
    var mail = "";
    if (r.email) {
      mail = t("done.mail").split("{email}").map(esc).join('<strong class="done__email">' + esc(r.email) + "</strong>");
    }
    return '<div class="done">' +
      '<div class="done__mark">' + icon("check") + "</div>" +
      '<h2 class="card__title" id="apply-title" tabindex="-1">' + esc(t("done.title")) + "</h2>" +
      '<div class="receipt"><p class="receipt__label">' + esc(t("done.receipt")) + '</p><p class="receipt__no">' + esc(r.receiptNo) + "</p></div>" +
      '<dl class="summary">' +
        "<div><dt>" + esc(t("done.name")) + "</dt><dd>" + esc(r.name) + "</dd></div>" +
        "<div><dt>" + esc(t("done.org")) + "</dt><dd>" + (aff ? esc(aff) + ' <span class="summary__sep">·</span> ' : "") + esc(r.org) + "</dd></div>" +
        (r.email ? "<div><dt>" + esc(t("done.email")) + '</dt><dd class="summary__email">' + esc(r.email) + "</dd></div>" : "") +
        "<div><dt>" + esc(t("done.day")) + "</dt><dd>" + dayLabel(r.day) + "</dd></div>" +
        (progs ? "<div><dt>" + esc(t("done.programs")) + "</dt><dd>" + progs + "</dd></div>" : "") +
        (when ? "<div><dt>" + esc(t("done.when")) + '</dt><dd class="summary__when">' + when + "</dd></div>" : "") +
      "</dl>" +
      (mail ? '<p class="info-line done__mail">' + icon("info") + "<span>" + mail + "</span></p>" : "") +
      (SMS_ON ? '<p class="done__sms">' + icon("info") + "<span>" + esc(t("done.sms")) + "</span></p>" : "") +
      '<button type="button" class="btn-outline" id="to-edit">' + esc(t("done.edit")) + "</button>" +
      "</div>";
  }

  function renderCanceled() {
    return '<div class="state">' +
      '<h2 class="card__title" id="apply-title" tabindex="-1">' + esc(t("edit.canceled")) + "</h2>" +
      '<p class="state__body">' + esc(t("edit.canceledBody")) + "</p>" +
      '<button type="button" class="btn-outline" id="reapply">' + esc(t("edit.reapply")) + "</button>" +
      "</div>";
  }

  function renderClosed() {
    var title = t("closed.title"), body = t("closed.body");
    // 본문이 제목으로 시작하면 제목 + 나머지로 나눠 같은 문장을 두 번 보이지 않게 한다 (글자는 원문 그대로)
    var rest = body.indexOf(title) === 0 ? body.slice(title.length).replace(/^[.\s]+/, "") : body;
    return '<div class="state">' +
      '<h2 class="card__title" id="apply-title" tabindex="-1">' + esc(title) + (rest !== body ? '<span class="sr-only">.</span>' : "") + "</h2>" +
      '<p class="state__body">' + esc(rest) + "</p>" +
      "</div>";
  }

  function renderCard(opts) {
    opts = opts || {};
    var card = $("#card");
    card.setAttribute("aria-busy", String(state.view === "loading"));
    card.className = "card card--" + state.view;
    if (state.view === "loading") { card.innerHTML = '<div class="card__loading"></div>'; }
    else if (state.view === "form") card.innerHTML = renderForm();
    else if (state.view === "done") card.innerHTML = renderDone();
    else if (state.view === "canceled") card.innerHTML = renderCanceled();
    else if (state.view === "closed") card.innerHTML = renderClosed();

    if (state.view === "form") {
      bindForm();
      renderNotice();
      if (state.submitted) showErrors(state.errors, false);
    }
    bindCard();
    updateCta();
    if (opts.focus) focusTitle(opts.scroll);
  }

  function focusTitle(scroll) {
    var h = $("#apply-title");
    if (!h) return;
    h.focus({ preventScroll: true });
    if (scroll) scrollToEl($("#apply"));
  }

  /* ── 알림(중복·오류·저장·잘못된 링크) ── */
  function renderNotice() {
    var top = $("#top-notice"), bottom = $("#form-notice");
    if (!top || !bottom) return;
    top.innerHTML = ""; bottom.innerHTML = "";
    var n = state.notice;
    if (!n) return;
    var html = "";
    if (n.type === "duplicate") {
      html = '<div class="notice notice--warn" role="alert">' + icon("info") +
        '<div class="notice__body"><p>' + esc(t(SMS_ON ? "duplicate.message" : "duplicate.messageNoSms")) + "</p>" +
        (SMS_ON ? '<button type="button" class="btn-outline btn-outline--sm" id="resend"' + (state.busy ? " disabled" : "") + ">" + esc(t("duplicate.resend")) + "</button>" : "") + "</div></div>";
    } else if (n.type === "sent") {
      html = '<div class="notice notice--ok" role="status">' + icon("check") + '<div class="notice__body"><p>' + esc(t("duplicate.sent")) + "</p></div></div>";
    } else if (n.type === "error") {
      html = '<div class="notice notice--error" role="alert">' + icon("alert") + '<div class="notice__body"><p>' + esc(t(n.key)) + "</p></div></div>";
    } else if (n.type === "saved") {
      html = '<div class="notice notice--ok" role="status" tabindex="-1" id="saved-notice">' + icon("check") + '<div class="notice__body"><p>' + esc(t("edit.saved")) + "</p></div></div>";
    } else if (n.type === "invalid") {
      html = '<div class="notice notice--error" role="alert">' + icon("alert") + '<div class="notice__body"><p>' + esc(t("edit.invalid")) + "</p></div></div>";
    }
    (n.where === "top" ? top : bottom).innerHTML = html;
    var resend = $("#resend");
    if (resend) resend.addEventListener("click", onResend);
  }

  /* ── 검증 ── */
  function readForm() {
    var f = $("#reg-form");
    if (!f) return state.draft;
    var checked = function (name) { return $all('input[name="' + name + '"]', f).filter(function (r) { return r.checked; }); };
    var day = checked("day")[0];
    var aff = checked("affType")[0];
    state.draft = {
      name: f.elements.name.value,
      affType: aff ? aff.value : "",
      org: f.elements.org.value,
      phone: phoneDigits(f.elements.phone.value),
      email: f.elements.email.value,
      day: day ? day.value : "",
      // 화면에 있는 체크박스 = 고른 날의 프로그램뿐이라 다른 날 것은 자연히 빠진다
      programs: checked("programs").map(function (c) { return c.value; }),
      consent: state.mode === "edit" || f.elements.consent.checked
    };
    return state.draft;
  }

  function validate(v) {
    var e = {};
    var name = v.name.trim(), org = v.org.trim(), email = v.email.trim();
    if (!name || name.length > 40) e.name = ERROR_KEYS.name;
    if (!affiliations().some(function (a) { return a.id === v.affType; })) e.affType = ERROR_KEYS.affType;
    if (!org || org.length > 60) e.org = ERROR_KEYS.org;
    if (!PHONE_RE.test(phoneDigits(v.phone))) e.phone = ERROR_KEYS.phone;
    if (!email || email.length > 100 || !EMAIL_RE.test(email)) e.email = ERROR_KEYS.email;
    if (DAYS.indexOf(v.day) < 0) e.day = ERROR_KEYS.day;
    // 프로그램이 있는 날마다 그날 것을 하나 이상
    else if (dayKeys(v.day).some(function (k) {
      var ids = programItems(k).map(function (it) { return it.id; });
      return ids.length && !v.programs.some(function (id) { return ids.indexOf(id) >= 0; });
    })) e.programs = ERROR_KEYS.programs;
    if (!v.consent && state.mode !== "edit") e.consent = ERROR_KEYS.consent;
    return e;
  }

  function setFieldError(field, key) {
    var err = $("#f-" + field + "-err");
    if (!err) return;
    var hintId = $("#f-" + field + "-hint") ? "f-" + field + "-hint" : ($("#f-" + field + "-note") ? "f-" + field + "-note" : "");
    var group = !!GROUP_FIELDS[field];
    var targets = group ? $all('input[name="' + field + '"]') : [$("#f-" + field)];
    var wrap = $('[data-field="' + field + '"]');
    if (key) {
      err.innerHTML = icon("alert") + "<span>" + esc(t(key)) + "</span>";
      err.hidden = false;
      if (wrap) wrap.classList.add("is-invalid");
    } else {
      err.innerHTML = "";
      err.hidden = true;
      if (wrap) wrap.classList.remove("is-invalid");
    }
    var describedBy = [hintId, key ? err.id : ""].filter(Boolean).join(" ");
    if (group) {
      // 묶음(fieldset·radiogroup·group)에도 안내 + 오류
      var box = $("#f-" + field);
      if (box) { if (describedBy) box.setAttribute("aria-describedby", describedBy); else box.removeAttribute("aria-describedby"); }
    }
    targets.forEach(function (el) {
      if (!el) return;
      if (key) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
      // 라디오·체크박스는 각자 안내(data-describedby, 남은 자리) + 오류 — 입력에 포커스가 가도 오류를 읽어 준다
      var ids = group
        ? [el.getAttribute("data-describedby") || "", key ? err.id : ""].filter(Boolean).join(" ")
        : describedBy;
      if (ids) el.setAttribute("aria-describedby", ids); else el.removeAttribute("aria-describedby");
    });
  }

  function showErrors(errors, moveFocus) {
    FIELDS.forEach(function (f) { setFieldError(f, errors[f]); });
    if (!moveFocus) return;
    var first = FIELDS.filter(function (f) { return errors[f]; })[0];
    if (!first) return;
    var target;
    if (first === "programs") {
      // 아직 하나도 고르지 않은 날의 첫 칸
      var empty = $all(".pgroup").filter(function (g) { return !$all("input:checked", g).length; })[0];
      target = $("input", empty || $("#f-programs") || document.createElement("div"));
    } else if (GROUP_FIELDS[first]) {
      var radios = $all('input[name="' + first + '"]').filter(function (r) { return !r.disabled; });
      target = radios.filter(function (r) { return r.checked; })[0] || radios[0];
    } else {
      target = $("#f-" + first);
    }
    if (target) {
      target.focus({ preventScroll: true });
      var wrap = $('[data-field="' + first + '"]');
      if (wrap) wrap.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }
  }

  // onlyClear: 고쳐졌으면 오류를 지우기만 하고 새 오류는 띄우지 않는다(방금 나타난 프로그램 칸에 바로 빨간 글씨가 뜨지 않게)
  function revalidate(field, onlyClear) {
    if (!state.submitted) return;
    var e = validate(readForm());
    if (field) {
      if (e[field]) { if (!onlyClear || state.errors[field]) state.errors[field] = e[field]; }
      else delete state.errors[field];
      setFieldError(field, state.errors[field]);
    }
  }

  // 참석일을 바꾸면 프로그램 칸만 다시 그린다 — 다른 날 프로그램은 빼고, 고른 칸은 그대로
  function onDayChange() {
    var slot = $("#programs-slot");
    var d = readForm();
    d.programs = keepPrograms(d.day, d.programs);
    if (slot) {
      slot.innerHTML = programsBlock(d.day, d.programs, slot.getAttribute("data-day") || "");
      slot.setAttribute("data-day", d.day);
      bindPrograms();
    }
    revalidate("day");
    revalidate("programs", true);
  }
  function bindPrograms() {
    $all('input[name="programs"]').forEach(function (c) {
      c.addEventListener("change", function () { revalidate("programs"); });
    });
  }

  /* ── 이벤트 ── */
  function bindForm() {
    var f = $("#reg-form");
    f.addEventListener("submit", onSubmit);

    var phone = $("#f-phone");
    phone.addEventListener("input", function () {
      var pos = phone.selectionStart == null ? phone.value.length : phone.selectionStart;
      // 커서 앞 숫자 수 — 앞부분의 +82 를 0 으로 바꾼 뒤 기준으로 센다
      var before = Math.min(phoneDigits(phone.value.slice(0, pos)).length, 11);
      var next = formatPhone(phone.value);
      if (next !== phone.value) {
        phone.value = next;
        var i = 0, seen = 0;
        while (i < next.length && seen < before) { if (/\d/.test(next[i])) seen++; i++; }
        try { phone.setSelectionRange(i, i); } catch (e) { /* noop */ }
      }
    });

    ["name", "org", "phone", "email"].forEach(function (k) {
      $("#f-" + k).addEventListener("input", function () { revalidate(k); });
    });
    $all('input[name="affType"]').forEach(function (r) {
      r.addEventListener("change", function () { revalidate("affType"); });
    });
    $all('input[name="day"]').forEach(function (r) {
      r.addEventListener("change", onDayChange);
    });
    bindPrograms();
    $("#f-consent").addEventListener("change", function () { revalidate("consent"); });

    var more = $("#consent-more"), panel = $("#consent-panel");
    more.addEventListener("click", function () {
      var open = panel.hidden;
      panel.hidden = !open;
      more.setAttribute("aria-expanded", String(open)); // 문구 전환은 CSS(겹친 두 문구) — 폭이 변하지 않는다
    });

    var co = $("#cancel-open");
    if (co) co.addEventListener("click", function () {
      readForm();
      state.confirmCancel = true;
      renderCard();
      var m = $("#cancel-msg"); if (m) m.focus();
    });
    var cn = $("#cancel-no");
    if (cn) cn.addEventListener("click", function () {
      readForm();
      state.confirmCancel = false;
      renderCard();
      var o = $("#cancel-open"); if (o) o.focus();
    });
    var cy = $("#cancel-yes");
    if (cy) cy.addEventListener("click", onCancel);
  }

  function bindCard() {
    var toEdit = $("#to-edit");
    if (toEdit) toEdit.addEventListener("click", function () {
      enterEdit(state.reg);
      renderCard({ focus: true, scroll: true });
    });
    var reapply = $("#reapply");
    if (reapply) reapply.addEventListener("click", function () {
      startNew();
      renderCard({ focus: true, scroll: true });
    });
  }

  function enterEdit(reg) {
    state.view = "form";
    state.mode = "edit";
    state.reg = reg;
    // 피드백 2 이전 신청 건은 affType·email·programs 가 비어 있다 — 새 규칙대로 채워야 저장된다
    state.draft = {
      name: reg.name, affType: reg.affType || "", org: reg.org, phone: digits(reg.phone),
      email: reg.email || "", day: reg.day, programs: (reg.programs || []).slice(), consent: true
    };
    state.submitted = false;
    state.errors = {};
    state.notice = null;
    state.confirmCancel = false;
  }

  function startNew() {
    state.view = isClosed(state.config) ? "closed" : "form";
    state.mode = "new";
    state.reg = null;
    state.token = "";
    state.draft = emptyDraft();
    state.submitted = false;
    state.errors = {};
    state.notice = null;
    state.confirmCancel = false;
    clearTokenFromUrl();
  }

  function clearTokenFromUrl() {
    if (!params.has("t")) return;
    params.delete("t");
    var q = params.toString();
    try { history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash); } catch (e) { /* noop */ }
  }

  function setBusy(on, label) {
    state.busy = on;
    var btn = $("#submit-btn");
    if (!btn) return;
    btn.disabled = on;
    btn.setAttribute("aria-busy", String(on));
    btn.textContent = label;
  }

  function handleFailure(res) {
    var code = res && res.code;
    // 화면에 표시할 칸이 없는 VALIDATION 은 일반 오류로 알린다(아무 반응 없는 화면 방지)
    if (code === "VALIDATION" && !Object.keys((res && res.fields) || {}).some(function (k) { return ERROR_KEYS[k]; })) code = "SERVER";
    if (code === "VALIDATION") {
      var fields = res.fields || {};
      state.errors = {};
      Object.keys(fields).forEach(function (k) { if (ERROR_KEYS[k]) state.errors[k] = ERROR_KEYS[k]; });
      state.notice = null;
      if (fields.affType || fields.programs) {
        // 소속 구분·프로그램 목록이 서버 설정과 달랐을 수 있다 — 설정을 다시 받아 선택지를 새로 그린다(입력값은 유지)
        readForm();
        refreshConfig().then(function () {
          state.draft.programs = keepPrograms(state.draft.day, state.draft.programs);
          renderCard();
          showErrors(state.errors, true);
        });
        return;
      }
      renderNotice();
      showErrors(state.errors, true);
    } else if (code === "DUPLICATE") {
      state.notice = { type: "duplicate" };
      renderNotice();
      var r = $("#resend") || $("#f-phone"); if (r) r.focus();
    } else if (code === "DAY_FULL") {
      state.errors = { day: "errors.dayFull" };
      state.draft.day = "";
      refreshConfig().then(function () { renderCard(); showErrors(state.errors, true); });
    } else if (code === "CLOSED") {
      state.view = "closed";
      renderCard({ focus: true });
    } else if (code === "INVALID_TOKEN") {
      startNew();
      state.notice = { type: "invalid", where: "top" };
      renderCard({ focus: true, scroll: true });
    } else {
      state.notice = { type: "error", key: code === "RATE_LIMITED" ? "errors.rate" : "errors.network" };
      renderNotice();
    }
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    var v = readForm();
    state.submitted = true;
    state.errors = validate(v);
    if (state.notice && state.notice.type !== "invalid") { state.notice = null; renderNotice(); }
    showErrors(state.errors, true);
    if (Object.keys(state.errors).length) return;

    var payload = {
      name: v.name.trim(), affType: v.affType, org: v.org.trim(), phone: phoneDigits(v.phone),
      email: v.email.trim().toLowerCase(), day: v.day, programs: keepPrograms(v.day, v.programs)
    };
    var edit = state.mode === "edit";
    setBusy(true, edit ? t("edit.saving") : t("form.submitting"));

    var req = edit
      ? API.update(state.token, payload)
      : API.submit(Object.assign({}, payload, { consent: true, lang: state.lang, src: src, hp: $("#f-website").value }));

    req.then(function (res) {
      setBusy(false, edit ? t("edit.save") : t("form.submit"));
      if (!res || !res.ok) return handleFailure(res);
      if (edit) {
        state.reg = Object.assign({}, state.reg, res.data, { phone: payload.phone });
        state.notice = { type: "saved", where: "top" };
        renderNotice();
        var s = $("#saved-notice");
        if (s) { s.focus({ preventScroll: true }); scrollToEl($("#apply")); }
      } else {
        state.token = res.data.token;
        state.reg = Object.assign({}, res.data, { phone: payload.phone });
        state.view = "done";
        state.notice = null;
        renderCard({ focus: true, scroll: true });
      }
    }).catch(function () {
      setBusy(false, edit ? t("edit.save") : t("form.submit"));
      state.notice = { type: "error", key: "errors.network" };
      renderNotice();
    });
  }

  function onResend() {
    if (state.busy) return;
    var phone = phoneDigits(readForm().phone);
    state.busy = true;
    var btn = $("#resend"); if (btn) btn.disabled = true;
    API.resendLink(phone).then(function (res) {
      state.busy = false;
      if (res && res.ok) {
        state.notice = { type: "sent" };
        renderNotice();
        var n = $("#form-notice .notice"); if (n) { n.setAttribute("tabindex", "-1"); n.focus(); }
      } else handleFailure(res);
    }).catch(function () {
      state.busy = false;
      state.notice = { type: "error", key: "errors.network" };
      renderNotice();
    });
  }

  function onCancel() {
    if (state.busy) return;
    state.busy = true;
    var btn = $("#cancel-yes"); if (btn) btn.disabled = true;
    API.cancel(state.token).then(function (res) {
      state.busy = false;
      if (res && res.ok) {
        state.view = "canceled";
        state.confirmCancel = false;
        state.token = "";
        clearTokenFromUrl();
        refreshConfig();
        renderCard({ focus: true, scroll: true });
      } else {
        if (btn) btn.disabled = false; // 일시 오류(RATE_LIMITED·SERVER) 뒤 다시 누를 수 있게
        handleFailure(res);
      }
    }).catch(function () {
      state.busy = false;
      if (btn) btn.disabled = false;
      state.notice = { type: "error", key: "errors.network" };
      renderNotice();
    });
  }

  /* ── 언어 전환 ── */
  function switchLang() {
    if (state.view === "form") readForm();
    var consentOpen = !!($("#consent-panel") && !$("#consent-panel").hidden);
    state.lang = state.lang === "ko" ? "en" : "ko";
    try { localStorage.setItem("rfw-lang", state.lang); } catch (e) { /* noop */ }
    applyStatic();
    renderCard();
    if (consentOpen) $("#consent-more") && $("#consent-more").click();
  }

  /* ── 모바일 하단 CTA ── */
  // 상태별: 새 신청 → '신청하기 ↓', 수정 링크 → '신청 내용 수정 ↓', 완료·취소·마감 → 숨김.
  // 푸터 '신청하기'는 새 신청 폼일 때만, 히어로 마감 안내는 마감일 때만.
  var formInView = false;
  function updateCta() {
    var bar = $("#cta-bar");
    var isNew = state.view === "form" && state.mode === "new";
    var isEdit = state.view === "form" && state.mode === "edit";
    bar.hidden = formInView || !(isNew || isEdit);
    $("#cta-label").textContent = isEdit ? t("ctaEdit") : t("cta");
    $("#footer-apply").hidden = !isNew;

    var status = $("#hero-status");
    var closed = state.view !== "loading" && isClosed(state.config);
    if (closed) {
      var html = icon("info") + "<span>" + esc(t("closed.body")) + "</span>";
      if (status.innerHTML !== html) status.innerHTML = html;
    } else if (status.innerHTML) {
      status.innerHTML = "";
    }
    status.hidden = !closed;
  }
  function watchForm() {
    var target = $("#apply");
    if (!("IntersectionObserver" in window)) { formInView = false; updateCta(); return; }
    new IntersectionObserver(function (entries) {
      formInView = entries[0].isIntersecting;
      updateCta();
    }, { rootMargin: "0px 0px -15% 0px", threshold: 0 }).observe(target);
  }
  // 새 신청이면 바로 입력할 수 있게 이름 칸에, 그 밖의 상태는 카드 제목에 포커스
  function goToForm(ev) {
    ev.preventDefault();
    scrollToEl($("#apply"));
    var target = state.view === "form" && state.mode === "new" ? $("#f-name") : $("#apply-title");
    if (target) target.focus({ preventScroll: true });
  }

  /* ── 시작 ── */
  function refreshConfig() {
    return API.getConfig().then(function (res) {
      if (res && res.ok && res.data) state.config = res.data;
    }).catch(function () { /* 기본 설정 유지 */ });
  }

  // 신청 카드 모양을 바꾸는 설정만 비교(접수 열림·마감, 날짜별 남은 자리, 소속 구분, 세부 프로그램 선택지)
  function cardKey(c) {
    c = c || {};
    var prog = c.program || {};
    var items = function (k) {
      return ((prog[k] && prog[k].items) || []).map(function (it, i) { return [it.id || i, it.ko, it.en, it.time]; });
    };
    return JSON.stringify([
      isClosed(c),
      (c.days || []).map(function (d) { return [d.value, d.capacity, d.remaining]; }),
      (c.affiliations || []).map(function (a) { return [a.id, a.ko, a.en]; }),
      items("day1"), items("day2"),
      [prog.day1 && prog.day1.ko, prog.day1 && prog.day1.en, prog.day2 && prog.day2.ko, prog.day2 && prog.day2.en]   // 프로그램 묶음 머리(날짜·제목)
    ]);
  }
  // 입력 중이던 값·커서를 지키면서 카드를 다시 그린다
  function rerenderKeepingFocus() {
    if (state.view === "form") {
      readForm();
      // 서버 설정에서 없어진 프로그램은 뺀다(다른 날 것도)
      state.draft.programs = keepPrograms(state.draft.day, state.draft.programs);
    }
    var a = document.activeElement, id = a && a.id, s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (x) { /* 선택 범위 없는 요소 */ }
    state.view = isClosed(state.config) ? "closed" : "form";
    renderCard();
    var el = id && document.getElementById(id);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try { if (s != null) el.setSelectionRange(s, e); } catch (x) { /* 라디오·체크박스 */ }
    }
  }

  function init() {
    applyStatic();
    loadRfw();
    renderCard();
    watchForm();

    $("#lang-toggle").addEventListener("click", switchLang);
    $("#cta").addEventListener("click", goToForm);
    $("#footer-apply").addEventListener("click", goToForm);
    $(".skip").addEventListener("click", goToForm);
    $("#footer-privacy").addEventListener("click", function (ev) {
      var href = this.getAttribute("href") || "";
      if (href.charAt(0) !== "#") return;
      ev.preventDefault();
      state.privacyOpen = !state.privacyOpen;
      $("#privacy").hidden = !state.privacyOpen;
      this.setAttribute("aria-expanded", String(state.privacyOpen));
      if (state.privacyOpen) scrollToEl($("#privacy"));
    });

    // 새 신청: 서버 설정을 기다리지 않고 기본 설정으로 폼을 먼저 띄운다(명세 8장: 4G 첫 화면 3초 이내).
    // 마감·정원은 신청할 때 서버가 다시 확인하므로, 설정이 늦게 와도 잘못 접수되지 않는다.
    if (!state.token) {
      state.view = isClosed(state.config) ? "closed" : "form";
      renderCard();
      var before = cardKey(state.config);
      refreshConfig().then(function () {
        applyStatic();
        if (state.mode !== "new" || state.busy) return;
        if (state.view !== "form" && state.view !== "closed") return;
        if (cardKey(state.config) === before) return;
        rerenderKeepingFocus();
      });
      return;
    }

    // 확인 문자의 개인 링크(?t=)로 들어오면 휴대폰에서도 바로 신청 카드(수정·취소·잘못된 링크)가 보이게
    var fromLink = !!state.token;
    refreshConfig().then(function () {
      applyStatic();
      if (state.token) {
        return API.lookup(state.token).then(function (res) {
          if (res && res.ok) {
            if (res.data.status === "canceled") { state.view = "canceled"; return; }
            enterEdit(res.data);
          } else if (res && (res.code === "SERVER" || res.code === "RATE_LIMITED")) {
            // 일시 오류 — 링크(?t=)는 주소에 남겨 새로고침으로 다시 시도할 수 있게
            state.notice = { type: "error", key: res.code === "RATE_LIMITED" ? "errors.rate" : "errors.network", where: "top" };
          } else {
            startNew();
            state.notice = { type: "invalid", where: "top" };
          }
        }).catch(function () {
          startNew();
          state.notice = { type: "error", key: "errors.network", where: "top" };
        });
      }
      state.view = isClosed(state.config) ? "closed" : "form";
    }).then(function () {
      if (state.view === "loading") state.view = isClosed(state.config) ? "closed" : "form";
      renderCard(fromLink ? { focus: true, scroll: true } : {});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
