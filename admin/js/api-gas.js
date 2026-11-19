/* 관리자 화면 API — Apps Script(HtmlService) 판
   js/api.js(모의)와 같은 window.AdminAPI 인터페이스. tools/build-gas.mjs 가 Admin.html 을 만들 때 api.js 대신 넣는다.
   - 서버 함수(gas/admin/AdminApi.gs)는 같은 이름으로 { ok:true, data } 또는 { ok:false, code, message, ...추가값 } 을 돌려준다.
   - 성공하면 data 로 resolve, 실패하면 모의와 같은 모양의 Error(message, .code, 추가값 예: .fields) 로 reject.
   - google.script.run 실패 처리기(네트워크·권한·스크립트 오류)와 시간 초과는 code 'SERVER' 로 바꾼다.
   - AdminAPI.host: HtmlService 환경 보조(주소창 해시 맞추기). 모의 api.js 에는 없고, admin.js 는 있을 때만 쓴다. */
(function (global) {
  'use strict';

  var TIMEOUT = 30000;
  var METHODS = ['adminWhoAmI', 'adminGetSummary', 'adminList', 'adminUpdate', 'adminCancel', 'adminRestore', 'adminHistory',
    'adminGetConfig', 'adminSaveConfig', 'adminLogExport', 'adminExportLog', 'adminConfigLog', 'adminAccessLog'];
  // 서버에 기록이 남는 호출 — 응답을 못 받으면 처리됐을 수도 있다고 알린다
  var WRITES = { adminUpdate: 1, adminCancel: 1, adminRestore: 1, adminSaveConfig: 1, adminLogExport: 1 };
  // 서버가 message 를 비워 보냈을 때 쓸 문구
  var DEFAULT_MSG = {
    VALIDATION: '입력값을 확인해 주세요.',
    DUPLICATE: '같은 휴대전화번호로 신청한 건이 이미 있어요.',
    DAY_FULL: '참석일 정원이 가득 찼어요.',
    CANCELED: '취소된 신청은 복원한 뒤 수정할 수 있어요.',
    NOT_FOUND: '신청 건을 찾지 못했어요.',
    FORBIDDEN: '관리자 명단에 없는 계정이에요. 운영팀에 권한을 요청해 주세요.',
    SERVER: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'
  };

  function makeError(code, message, extra) {
    var e = new Error(message || DEFAULT_MSG[code] || DEFAULT_MSG.SERVER);
    e.code = code || 'SERVER';
    if (extra) Object.keys(extra).forEach(function (k) { if (k !== 'ok' && k !== 'code' && k !== 'message') e[k] = extra[k]; });
    return e;
  }

  // 실패 처리기로 오는 오류: 네트워크 끊김, 로그인 만료·권한, 서버 스크립트 예외 등
  function failureError(name, err) {
    var raw = String((err && err.message) || err || '');
    var msg = /auth|permission|login|sign.?in|권한|로그인/i.test(raw)
      ? '로그인이 만료됐거나 권한이 없어요. 페이지를 새로고침해 주세요.'
      : /network|connection|http 0|offline/i.test(raw)
        ? '서버와 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
        : DEFAULT_MSG.SERVER;
    if (WRITES[name]) msg += ' 처리됐는지 확인하려면 새로고침해 주세요.';
    return makeError('SERVER', msg, { detail: raw });
  }

  function call(name, args) {
    return new Promise(function (resolve, reject) {
      var settled = false, timer;
      function settle(fn, v) { if (settled) return; settled = true; clearTimeout(timer); fn(v); }
      var gs = global.google && global.google.script;
      if (!gs || !gs.run) { settle(reject, makeError('SERVER', 'Apps Script 환경이 아니에요. 배포된 관리자 주소로 열어 주세요.')); return; }
      timer = setTimeout(function () {
        settle(reject, makeError('SERVER', WRITES[name]
          ? '서버 응답이 늦어요. 처리됐을 수도 있으니 새로고침해 확인해 주세요.'
          : '서버 응답이 늦어요. 잠시 후 다시 시도해 주세요.', { timeout: true }));
      }, TIMEOUT);
      try {
        var runner = gs.run
          .withSuccessHandler(function (res) {
            if (res && res.ok === true) settle(resolve, res.data);
            else if (res && res.ok === false) settle(reject, makeError(res.code || 'SERVER', res.message, res));
            else settle(reject, makeError('SERVER', '서버 응답 형식이 올바르지 않아요. 개발팀에 알려 주세요.'));
          })
          .withFailureHandler(function (err) {
            if (global.console) console.warn('[AdminAPI] ' + name + ' 실패:', err);
            settle(reject, failureError(name, err));
          });
        runner[name].apply(runner, args);
      } catch (e) {
        settle(reject, failureError(name, e));
      }
    });
  }

  var API = {};
  METHODS.forEach(function (name) {
    API[name] = function () { return call(name, Array.prototype.slice.call(arguments)); };
  });

  /* HtmlService 의 화면은 *.googleusercontent.com iframe 안에서 돈다. iframe 의 location.hash 는 그대로 쓰되,
     - 시작할 때 최상위 주소(…/exec#/list?day=d22)의 해시를 읽어 깊은 링크를 살리고
     - 화면·조건이 바뀔 때마다 최상위 주소의 해시를 바꿔(replace, 기록은 쌓지 않음) 주소를 복사·즐겨찾기할 수 있게 한다.
     뒤로 가기는 iframe 안의 해시 이동 기록이 맡는다. */
  var lastHash = null;
  API.host = {
    kind: 'gas',
    initialHash: function () {
      return new Promise(function (resolve) {
        var done = false;
        function fin(h) { if (!done) { done = true; resolve(h || ''); } }
        setTimeout(function () { fin(''); }, 2000);
        try {
          global.google.script.url.getLocation(function (loc) { fin(loc && loc.hash ? String(loc.hash).replace(/^#/, '') : ''); });
        } catch (e) { fin(''); }
      });
    },
    syncHash: function (hash) {
      var h = String(hash || '').replace(/^#/, '');
      if (h === lastHash) return;
      lastHash = h;
      try { global.google.script.history.replace(null, null, h); } catch (e) { /* 주소창 동기화는 실패해도 화면에는 영향 없음 */ }
    }
  };

  global.AdminAPI = API;
})(window);
