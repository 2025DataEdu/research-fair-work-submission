# Cloudflare Worker 배포 안내

참가자 화면 → **Worker**(출처 확인 · IP당 횟수 제한) → Apps Script 웹앱 `/exec` → 구글 시트.
Worker 코드는 `worker/` 폴더에 있다. 계약은 `docs/api.md`.

## Worker가 하는 일

- `POST /` 만 받는다(`GET /health` 는 점검용). 그 밖의 주소는 404
- 허용한 출처(`ALLOWED_ORIGINS`)에서 온 요청만 받는다. 아니면 403
- 본문 4 KB 이하, JSON, `action` 이 `config · submit · lookup · update · cancel · resend` 중 하나여야 한다. 아니면 400
- IP당 횟수 제한: 쓰기(`submit · update · cancel · resend`) 1분 10회, 읽기(`config · lookup`) 1분 60회. 넘으면 `{ok:false, code:"RATE_LIMITED"}` (HTTP 200 — 화면이 이 값을 읽어 안내한다)
- 브라우저가 보낸 `k` 는 버리고, Worker 비밀값 `GAS_KEY` 를 `k` 로 붙여 Apps Script 에 넘긴다
- Apps Script 가 15초 안에 답하지 않거나, HTML·깨진 응답을 주거나, `FORBIDDEN`(비밀값 불일치)을 주면 화면에는 `SERVER` 로만 알린다
- `config` 응답을 30초 동안 엣지에 캐시한다. 방문 집계용 `src` 가 붙은 요청은 캐시를 건너뛴다(자세한 이유는 `worker/src/index.js` 위쪽 주석)

## 0. 준비물

- Node.js 18 이상 (개발 PC는 v24 사용)
- Cloudflare 계정 — 무료(Free) 요금제로 충분하다
- Apps Script 웹앱 배포 주소(`https://script.google.com/macros/s/<배포 ID>/exec`)와 Apps Script 에 넣은 비밀값

## 1. Cloudflare 가입·로그인

1. https://dash.cloudflare.com/sign-up 에서 이메일로 가입한다. 요금제는 **Free**. 카드 등록은 필요 없다
2. 처음 Workers 메뉴(Workers & Pages)에 들어가면 `*.workers.dev` 하위 도메인 이름을 정하라고 한다. 예: `jbnu-rfw` → Worker 주소가 `https://rfw-api.jbnu-rfw.workers.dev` 가 된다
3. 개발 PC에서 로그인한다

```bash
cd worker
npm install
npx wrangler login        # 브라우저가 열리면 '허용'
npx wrangler whoami       # 로그인된 계정 확인
```

## 2. 설정값 넣기

`worker/wrangler.toml` 의 `[vars]` 를 채운다.

```toml
[vars]
GAS_URL = "https://script.google.com/macros/s/<배포 ID>/exec"
ALLOWED_ORIGINS = "https://rfw2026.pages.dev,http://localhost:8787,http://127.0.0.1:8787"
```

- `ALLOWED_ORIGINS`: 참가자 화면이 열리는 **출처**(프로토콜+도메인+포트, 경로·끝 `/` 없이). 운영 참가자 화면은 Cloudflare Pages `https://rfw2026.pages.dev` 다. GitHub Pages 시안은 모의 API 만 쓰므로 넣지 않는다. 학교·별도 도메인이 생기면 쉼표로 덧붙이고, `web/js/config.js` 의 `RFW_LIVE_HOSTS` 에도 같은 호스트를 넣는다
- `GAS_URL` 은 비밀은 아니지만, 공개 저장소에 올리고 싶지 않으면 `npx wrangler secret put GAS_URL` 로 넣고 `wrangler.toml` 에서는 그 줄을 지운다(같은 이름을 변수와 비밀값 양쪽에 두지 않는다)

## 3. 배포와 비밀값

```bash
cd worker
npm run deploy                     # = npx wrangler deploy
npx wrangler secret put GAS_KEY    # 프롬프트에 Apps Script 와 같은 비밀값을 붙여 넣는다
```

- 배포가 끝나면 `https://rfw-api.<하위도메인>.workers.dev` 주소가 출력된다
- 비밀값은 저장 즉시 반영된다(다시 배포할 필요 없음). 비밀값을 바꾸면 Apps Script 쪽 값도 같이 바꾼다
- `GAS_KEY` 는 길고 무작위인 문자열로 만든다. 예: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 4. 확인

```bash
curl https://rfw-api.<하위도메인>.workers.dev/health
# {"ok":true,"data":{"service":"rfw-api","upstream":true,"key":true}}
#  upstream:false → GAS_URL 비어 있음,  key:false → GAS_KEY 비밀값 없음

curl -H "Origin: https://rfw2026.pages.dev" \
     -H "Content-Type: text/plain;charset=utf-8" \
     --data '{"action":"config"}' \
     https://rfw-api.<하위도메인>.workers.dev/
# {"ok":true,"data":{...행사 설정...}}  → Worker·Apps Script·시트 연결 정상
# {"ok":false,"code":"SERVER"}         → 아래 '문제 해결'
```

실시간 로그: `npx wrangler tail` (Apps Script 오류·FORBIDDEN·시간 초과가 여기에 찍힌다)

## 5. 참가자 화면 연결

`web/js/config.js` 의 `window.RFW_API_BASE` 에 Worker 주소를 넣고 배포한다.

```js
window.RFW_API_BASE = "https://rfw-api.<하위도메인>.workers.dev/";
```

비워 두면 모의 API(시안용, `?mock=reset|closed|full`, `?t=demo-token`)가 그대로 동작한다.

## 6. Apps Script 쪽에서 맞춰야 할 것

- 본문의 `k` 가 비밀값과 다르면 `{ok:false, code:"FORBIDDEN"}` 을 돌려준다(Worker 가 화면에는 `SERVER` 로 바꿔 보낸다)
- **방문 집계는 `src` 가 있는 `config` 요청만 센다.** 화면은 탭 세션의 첫 `config` 에만 `src` 를 붙이고(유입 경로 없으면 `direct`), 새로고침·재조회는 `src` 없이 보낸다. `src` 없는 `config` 는 세지 않아야 집계가 부풀지 않는다
- 응답은 항상 `ContentService` JSON(`{ok, data}` / `{ok:false, code, fields?}`)으로 준다. HTML 오류 화면이 나가면 화면에는 `SERVER` 로 보인다
- 웹앱 배포 설정: 실행 계정 '나', 액세스 '모든 사용자'(익명 포함). 코드를 고친 뒤에는 **같은 배포를 새 버전으로 갱신**해야 `/exec` 주소가 바뀌지 않는다

## 7. 횟수 제한 조정

`worker/wrangler.toml` 의 `[[ratelimits]]` 를 고친 뒤 `npm run deploy`.

```toml
[[ratelimits]]
name = "RL_WRITE"          # 쓰기: submit · update · cancel · resend
namespace_id = "2612201"
  [ratelimits.simple]
  limit = 10               # period 안에 허용하는 횟수
  period = 60              # 10 또는 60(초)만 가능
```

- 제한은 **IP 단위**다. 휴대폰 통신사망·학교 와이파이는 여러 사람이 한 IP 를 나눠 쓰므로 넉넉하게 잡았다. 행사장·강의실에서 한꺼번에 신청받을 계획이면 쓰기 한도를 30~60 으로 올린다
- Cloudflare 문서상 이 제한은 데이터센터(위치)별로 따로 세고 근사치다. 엄격한 차단이 아니라 자동 스팸을 걸러 내는 용도다
- 바인딩을 쓸 수 없는 환경이면 Worker 는 경고 로그만 남기고 제한 없이 통과시킨다(접수가 멈추지 않게)
- `namespace_id` 는 계정 안에서 겹치지 않는 양의 정수(문자열)면 된다. 다른 Worker 에서 같은 번호를 쓰면 횟수를 함께 센다

## 8. 비용 (2026-11 기준 Cloudflare 문서)

| 항목 | Workers Free |
|---|---|
| 요청 | 하루 100,000건 (UTC 자정 = 한국 오전 9시 초기화). 넘으면 Error 1027 |
| CPU 시간 | 요청당 10 ms (Apps Script 응답을 기다리는 시간은 포함되지 않는다) |
| 하위 요청 | 요청당 50건 (이 Worker 는 1건) |
| Rate Limiting 바인딩 | 요금표에 별도 항목 없음 — 무료 요금제 사용 가능 여부가 문서에 명시돼 있지 않아 배포 후 확인 필요(아래) |

**Rate Limiting 확인 방법**: `npm run deploy` 출력의 바인딩 목록에 `env.RL_WRITE (10 requests/60s)` 가 보이는지, 그리고 같은 PC에서 `resend` 를 1분 안에 11번 보내면 마지막이 `RATE_LIMITED` 인지 본다. 무료 요금제에서 바인딩이 거부되면 `wrangler.toml` 의 `[[ratelimits]]` 두 블록을 지우고 배포해도 Worker 는 동작한다(제한 없이 통과, 허니팟·Apps Script 중복 확인은 유지).

예상 규모(신청 300~600건, 동시 접속 100명)는 무료 한도의 1%도 쓰지 않는다. 출처:
- 한도: https://developers.cloudflare.com/workers/platform/limits/
- 요금: https://developers.cloudflare.com/workers/platform/pricing/
- Rate Limiting 바인딩: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

## 9. 로컬에서 시험

```bash
cd worker
npm test                              # 단위 시험 (Cloudflare 계정 불필요)
cp .dev.vars.example .dev.vars        # GAS_KEY 를 채운다 (git 제외 파일)
npm run dev                           # http://127.0.0.1:8787 — 로그인 없이 동작, 횟수 제한도 로컬에서 흉내 낸다
```

로컬 Worker 를 실제 Apps Script 에 붙이려면 `.dev.vars` 에 `GAS_URL=...` 을 넣는다. 참가자 화면을 다른 포트에서 띄우면 그 출처를 `ALLOWED_ORIGINS` 에 넣어야 한다(예: `npx wrangler dev --var ALLOWED_ORIGINS:http://127.0.0.1:5500`).

## 문제 해결

| 증상 | 원인 |
|---|---|
| `/health` 에서 `key:false` | `npx wrangler secret put GAS_KEY` 를 안 했다 |
| 모든 요청이 `SERVER`, `wrangler tail` 에 `FORBIDDEN` | Worker `GAS_KEY` 와 Apps Script 비밀값이 다르다 |
| 모든 요청이 `SERVER`, 로그에 `upstream non-JSON` | `GAS_URL` 이 `/exec` 가 아니거나(`/dev` 는 로그인 필요), 웹앱 액세스가 '모든 사용자'가 아니다 |
| 브라우저 콘솔에 CORS 오류, 응답 403 | 화면 출처가 `ALLOWED_ORIGINS` 에 없다 |
| 신청 화면에 '요청이 너무 많아요' | 같은 IP 에서 1분 안에 쓰기 10회 초과. 한도 조정은 7장 |

## 참가자 화면 운영 배포 (Cloudflare Pages)
- 프로젝트 `rfw2026` (직접 업로드 방식, Git 연결 없음) → `https://rfw2026.pages.dev`
- 배포: 저장소 밖 폴더에서 `npx wrangler pages deploy <저장소>/web --project-name rfw2026 --branch main` (worker 폴더 안에서 실행하면 Worker 설정을 집어 들 수 있으니 피한다)
- `web/_redirects`: `/admin` → 관리자 Apps Script 웹앱 주소(302). 관리자 배포 주소가 바뀌면 함께 고친다
- `main` 병합은 GitHub Pages 시안에만 반영되고, 운영 주소는 위 명령으로 따로 배포해야 바뀐다
