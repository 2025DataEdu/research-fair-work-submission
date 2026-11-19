/* 로컬 미리보기 전용 가짜 google.script (node tools/build-gas.mjs --preview 가 넣음. 배포본에는 들어가지 않음)
   google.script.run.xxx(...) → 모의 api.js(window.__RFW_MOCK)를 불러 Apps Script 처럼 {ok, data} 봉투로 돌려준다.
   인자·결과는 JSON 으로 한 번 직렬화해 google.script.run 의 값 전달을 흉내 낸다.
   주소에 ?gasFail=adminList 처럼 붙이면 그 호출이 실패 처리기로 간다(네트워크 오류 흉내).
   ?gasHash=%2Flist%3Fday%3Dd23 은 최상위 주소의 해시(…/exec#/list?day=d23, 깊은 링크)를 흉내 낸다. */
(function (global) {
  'use strict';
  var mock = global.__RFW_MOCK;
  var failing = (/[?&]gasFail=([^&#]*)/.exec(location.search) || [])[1];
  failing = failing ? decodeURIComponent(failing).split(',') : [];
  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(fn, fail); };
        if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
        if (name === 'withUserObject') return function () { return runner(ok, fail); };
        return function () {
          var args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          setTimeout(function () {
            if (failing.indexOf(name) >= 0) { fail && fail(new Error('NetworkError: Connection failure due to HTTP 0')); return; }
            if (typeof mock[name] !== 'function') { fail && fail(new Error('ScriptError: Script function not found: ' + name)); return; }
            mock[name].apply(null, args).then(function (data) {
              ok && ok(JSON.parse(JSON.stringify({ ok: true, data: data })));
            }, function (e) {
              var env = { ok: false, code: e.code, message: e.message };
              Object.keys(e).forEach(function (k) { if (k !== 'code') env[k] = e[k]; });
              ok && ok(JSON.parse(JSON.stringify(env)));
            });
          }, 0);
        };
      }
    });
  }
  var topHash = decodeURIComponent((/[?&]gasHash=([^&#]*)/.exec(location.search) || [])[1] || '');
  global.google = {
    script: {
      get run() { return runner(null, null); },
      url: { getLocation: function (cb) { setTimeout(function () { cb({ hash: topHash, parameter: {}, parameters: {} }); }, 0); } },
      history: {
        push: function (s, p, h) { if (h != null) topHash = h; },
        replace: function (s, p, h) { if (h != null) topHash = h; global.__RFW_TOP_HASH = topHash; },
        setChangeHandler: function () {}
      },
      host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: { focus: function () {} } }
    }
  };
})(window);
