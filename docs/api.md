# API·데이터 계약 (v0)

참가자 화면은 **Cloudflare Worker 주소만** 호출한다. Worker → Apps Script 웹앱 → 구글 시트.
Worker가 IP당 횟수 제한을 하고, Apps Script에는 Worker만 아는 비밀값(`k`)을 붙여 전달한다(직접 호출 차단).
화면 개발 단계에서는 `web/js/api.js`의 모의 구현을 쓰며, 같은 함수 시그니처를 유지한 채 실제 호출로 바꾼다.

## 공통
- 요청: `POST {API_BASE}` , `Content-Type: text/plain;charset=utf-8` (CORS 사전요청 회피), 본문 JSON `{ "action": "...", ...payload }`
- 응답: `{ "ok": true, "data": {...} }` 또는 `{ "ok": false, "code": "ERROR_CODE", "message"?: "..." }`
- 오류 코드: `VALIDATION`(fields: {name|affType|org|phone|email|day|programs|consent: true}), `DUPLICATE`, `DAY_FULL`, `CLOSED`, `RATE_LIMITED`, `INVALID_TOKEN`, `SERVER`
  - Apps Script 전용: `FORBIDDEN`(`k` 없음·틀림, JSON 아님), `BAD_REQUEST`(모르는 action). Worker 는 이 둘을 참가자에게 `SERVER` 로 바꿔 보여도 된다
- Worker → Apps Script 본문: 위 본문에 `k`(스크립트 속성 `GAS_KEY` 와 같은 값)를 더한 것. Apps Script 실패 응답에는 항상 한국어 `message` 가 있고, `fields` 같은 추가 값은 봉투 최상위에 둔다
- Apps Script 웹앱의 POST 응답은 `script.googleusercontent.com` 으로 302 리다이렉트된다. Worker 는 리다이렉트를 따라가야 한다(`redirect: "follow"`)

## 참가자 API (`web/js/api.js` 가 노출하는 함수)
| 함수 | action | 입력 | 성공 data |
|---|---|---|---|
| `getConfig()` | `config` | – | `RFW_CONFIG` 와 같은 구조 |
| `submit(p)` | `submit` | `{name, affType, org, phone, email, day, programs, consent:true, lang, src, hp}` | `{receiptNo, name, affType, org, email, day, programs, token}` |
| `lookup(token)` | `lookup` | `{token}` | `{receiptNo, name, affType, org, phone, email, day, programs, status}` |
| `update(token, p)` | `update` | `{token, name, affType, org, phone, email, day, programs}` | `{receiptNo, name, affType, org, email, day, programs}` |
| `cancel(token)` | `cancel` | `{token}` | `{receiptNo, status:"canceled"}` |
| `resendLink(phone)` | `resend` | `{phone}` | `{sent:true}` |

- `phone`: 숫자만 저장(`01012345678`). 화면은 하이픈 자동 삽입. 검증: `^01[016789]\d{7,8}$`
- `day`: `day1` | `day2` | `both`
- `affType`: 소속 구분. 설정 `affiliations[].id` 중 하나(필수, 기본 `group` 교육연구단 · `grad` 대학원 · `prof` 교수 · `student` 학생 · `external` 외부참여자). `org` 는 세부 소속 직접 기재(필수, 1~60자)
- `email`: 필수. 앞뒤 공백을 빼고 소문자로 저장. 100자 이내, `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`
- `programs`: 고른 세부 프로그램 id 배열(`program.day1.items[].id` / `program.day2.items[].id`). 고른 참석일(day1 → 22일 항목, day2 → 23일 항목, both → 둘 다)에 속한 id 만 허용하고, 그날 항목이 하나라도 있으면 그날 것을 최소 1개 골라야 한다. 정원 없이 인원 집계만. 중복을 빼고 설정 순서(22일 먼저, items 순)로 정렬해 저장
- 새 칸이 빈 옛 신청은 `affType: ""`, `email: ""`, `programs: []` 로 읽는다. 본인이 수정(`update`)하려면 새 규칙대로 채워야 저장된다
- `config` 응답에 `affiliations`(`[{id, ko, en}]`, 화면 순서)와 프로그램 항목 `id` 가 들어 있다
- `src`: 유입 경로 `?src=` 값(`sms` | `qr` | `web` | 없으면 `direct`). 이 넷이 아니면 `direct` 로 저장
- `config` 에 `src` 를 붙이면 그날 그 유입경로의 방문수를 센다(없으면 세지 않음). 참가자 화면은 탭 세션의 첫 `config` 에만 `src` 를 붙인다(sessionStorage) — 방문 = 브라우저 탭 단위, 개인 식별 없음. 방문수는 캐시에 모았다가 시트에 더하는 근사치, 신청수는 신청 저장 때 바로 더해 정확
- 방문수 시트 반영(모두 api 프로젝트 스크립트 잠금 안): ① 방문이 들어왔을 때 마지막 반영이 60초(`API_VISIT_FLUSH_MS`)보다 오래됐으면 바로 ② `submit` 때 신청수와 같은 시트 쓰기로 ③ 매시간 트리거 `flushVisits`(조용해진 뒤 남은 꼬리). 방문이 이어지는 동안 관리자 화면 지연은 약 1분, 마지막 방문 뒤 조용하면 최대 1시간. 반영할 때마다 방문집계 탭 G1 에 시각을 남긴다
- `config` 응답은 30초 캐시(신청·수정·취소 때 비움). 마감·정원 판단은 `submit`·`update` 때 캐시 없이 다시 한다
- 같은 번호로 10분에 `submit` 5회를 넘으면 `RATE_LIMITED`. `resend` 는 같은 번호 1분에 1번만 실제로 보내고 응답은 언제나 `{sent:true}`(번호 존재·형식·횟수 초과를 드러내지 않음)
- `submit` 은 `hp` 가 비어 있지 않으면 저장 없이 `{receiptNo:"RF26-0000-0000", …, token:""}` 로 성공한 척한다(정상 응답과 같은 모양: `affType`·`email`·`programs` 포함)
- `update`·`cancel` 은 신청 상태가 `신청` 인 토큰만 받는다(취소된 건은 `INVALID_TOKEN`). 마감 뒤에도 수정·취소는 된다(모의 구현과 같음)
- `hp`: 허니팟 필드 값(사람은 항상 빈 문자열)
- 수정 링크: `{SITE}/?t={token}` — token 은 추측 불가능한 32자 이상 무작위 문자열
- 접수번호: `RF26-MMDD-NNNN` (MMDD = 신청일, NNNN = 전체 일련번호, 예 `RF26-1118-0042`)

## 시트 구조 (Apps Script 단계에서 생성)
시각은 모두 `2026-12-01T10:12:00+09:00` 꼴 문자열. 날짜·번호 열은 글자 서식(@)으로 만들어 자동 변환을 막는다. `api` 프로젝트 `setup()` 이 탭을 만든다.

**신청** 탭: 접수번호 | 신청일시 | 수정일시 | 상태(신청/취소) | 이름 | 소속 | 휴대전화번호 | 참석일(day1/day2/both) | 개인정보동의시각 | 언어 | 유입경로 | 토큰 | 소속구분 | 이메일 | 세부프로그램 (15열)
- '소속' 열 = 세부 소속, '소속구분' = affiliations id(예 `grad`), '세부프로그램' = 프로그램 id 를 쉼표로(`d1-1,d1-3,d2-2`)
- 옛 12열 시트는 `setup()` 을 다시 실행하면 머리행 뒤에 새 3열이 붙는다(기존 행은 새 칸이 빈 채로 둔다). 여러 번 실행해도 안전
- 운영 중 이 탭의 행을 지우거나 정렬하지 않는다(보기 정렬은 필터 보기). 상태를 시트에서 직접 바꾸면 변경이력이 남지 않아 일별 누적이 어긋난다
**변경이력**: 일시 | 접수번호 | 변경자(본인/관리자 이메일) | 구분(수정/취소/복원) | 변경 전 | 변경 후 — 변경 전·후는 바뀐 항목만 담은 JSON(`name`·`affType`·`org`·`phone`·`email`·`day`·`programs`). 번호는 가린 값(`010-****-5678`), 이메일도 가린 값(`ab***@example.com`, @ 앞 2자만), 세부 프로그램은 쉼표 문자열
**설정** (항목 | 값 | 설명): `open`, `closeAt`, `showSpeakers`, `capacity_day1`, `capacity_day2`(비우면 정원 없음), `tagline`·`affiliations`(소속 구분 목록 `[{id, ko, en}]`, 없으면 기본값. id 는 바꾸지 않는다)·`program_day1`·`program_day2`(제목·날짜)·`contact`(JSON), `privacyUrl`, `dailyNotes`(관리자 일별 현황 메모 JSON `{"2026-12-01":"접수 오픈"}`, 참가자 설정에는 안 나감)
**프로그램**: 날짜(day1/day2) | 시간 | 국문 | 영문 | 장소 | 장소(영문) | 강조(TRUE/FALSE) | 연사 | ID — 한 항목 한 행, 행 순서 = 화면 순서
- ID = 세부 프로그램 선택·집계 기준. 한 번 정하면 이름을 바꿔도 유지. 기본 `d1-1`~`d1-3`, `d2-1`~`d2-3`. 새 항목은 `d1-`/`d2-` + 무작위 base36 4~6자(관리자 저장 때 서버가 채움)
- ID 칸이 비어 있으면 읽을 때 그날 안 순서로 `d1-1`, `d1-2`… 를 쓴다. 옛 8열 시트는 `setup()` 이 `ID` 머리를 붙이고 빈 ID 칸을 같은 값으로 채운다
**관리자로그**: 일시 | 이메일 | 행위(로그인/내보내기/수정/설정변경/파기) | 상세 — 상세는 JSON(`name`, 내보내기면 `kind`·`filterText`·`count`, 설정변경이면 `changes`, 수정이면 `receiptNo`·`detail`)
**방문집계**: 날짜 | 유입경로 | 방문수 | 신청수 — 개인 정보 없이 날짜·경로별 숫자만. 신청수는 취소 포함 접수 건수. F1 = `방문수 마지막 반영`, G1 = 그 시각(+09:00, 글자 서식). 관리자(admin 프로젝트)는 api 프로젝트의 캐시·스크립트 속성을 읽지 못하고 `설정` 탭은 관리자 설정 저장이 통째로 다시 쓰므로, api 프로젝트만 쓰는 이 탭에 둔다

## 관리자 API (Apps Script `google.script.run`, 모든 함수가 허용 명단 확인)
모든 함수는 예외를 던지지 않고 `{ok:true, data}` / `{ok:false, code, message, fields?}` 를 돌려준다. `data` 는 `admin/js/api.js` 모의 구현이 resolve 하는 값과 같은 모양(Date 없음, 시각은 +09:00 문자열). 오류 코드: `FORBIDDEN`(허용 명단 밖), `NOT_FOUND`, `VALIDATION`, `DUPLICATE`, `CANCELED`, `DAY_FULL`, `SERVER`
허용 명단 = 스크립트 속성 `ADMIN_EMAILS`(쉼표 구분, 대소문자 무시, `a@x.com:운영팀` 처럼 화면 이름을 붙일 수 있음. 없으면 @ 앞부분)

`adminWhoAmI()`, `adminGetSummary()`, `adminList({q, day, status, aff, program, sort})`, `adminUpdate(receiptNo, patch)`, `adminCancel(receiptNo)`, `adminRestore(receiptNo)`, `adminHistory(receiptNo)`, `adminGetConfig()`, `adminSaveConfig(cfg)`, `adminLogExport(kind, filter)`, `adminExportLog()`, `adminConfigLog()`, `adminAccessLog()`
화면 개발 단계에서는 `admin/js/api.js` 모의 구현 사용.

- `adminGetSummary()` `daily[]` 날짜 범위: 첫 신청·처리일 ~ max(마지막 처리일, min(오늘, 마감일)), 빈 날은 0. `note` 는 설정 탭 `dailyNotes`
- `adminGetSummary()` 집계 기준: `total` = 유효 신청(상태 신청), `canceled` = 상태 취소, `createdTotal` = 신청일 기준 전체(= total + canceled). `daily[]` = `{date, count(신청일 기준 신규, 이후 취소 포함), canceled·restored(처리일 기준), cumulative(그날 끝 기준 유효 신청, 마지막 값 = total), note}`
- `adminGetSummary()` 방문·신청 전환(방문집계 탭 전체 날짜 합, 개인 식별 없음): `visits` / `visitSubmits` = `{sms, qr, web, direct, total}`(모르는 경로는 direct), `conversion` = 같은 키로 신청 ÷ 방문(소수 넷째 자리, 방문 0 이면 `null`), `visitsDaily` = `[{date, visits, submits}]` 날짜순(행이 있는 날만), `visitsUpdatedAt` = 방문수 마지막 반영 시각(+09:00, 없으면 `null`). 방문은 시트에 반영된 것까지만 보이고, 신청(`visitSubmits`)은 취소 포함이라 `bySrc`(유효 신청)와 다를 수 있다. 반영 시점 차이로 날짜별·경로별 전환율이 잠깐 100% 를 넘을 수 있다
- `adminGetSummary()` 소속 구분·세부 프로그램(유효 신청 기준): `byAff` = `{[affId]: n, _other: n}` — 설정의 구분은 0 이어도 나오고, 설정에 없는 id·빈 값은 `_other`. `byProgram` = `[{id, day:"day1"|"day2", ko, en, count}]` 설정 items 순서(22일 먼저). 설정에서 지워진 id 로 신청된 건은 `{id, day(d2- 로 시작하면 day2, 아니면 day1), ko:id, en:id, count, removed:true}` 로 id 순으로 뒤에 붙인다
- 목록·내보내기 행(`publicRow`)에 `affType`, `email`(원문 — 자료 발송용), `programs`(id 배열)가 있다
- `adminList` 필터 `aff`(소속 구분 id, `''` = 전체), `program`(세부 프로그램 id, `''` = 전체). 검색어 `q` 는 이름·소속·접수번호·이메일에 걸린다
- `adminUpdate(receiptNo, patch)` patch: `{name?, affType?, org?, phone?, email?, day?, programs?}` — 참가자와 같은 검증. 없는 항목은 기존 값 유지. `day` 나 `programs` 가 있으면 세부 프로그램을 (새) 참석일 기준으로 다시 검사한다(참석일만 바꿨는데 기존 프로그램이 맞지 않으면 `fields.programs`)
- `adminSaveConfig(cfg)`: `affiliations` 는 1~20개, id `^[a-z0-9_-]{1,20}$` 고유(`_other` 는 집계용이라 쓸 수 없음), 국문 이름 1~30자, 영문 0~40자 — 틀리면 `VALIDATION`(`fields.affiliations`). `affiliations` 를 빼고 보내면 지금 값 유지. 프로그램 항목 id 가 비면 채우고, 겹치거나 형식(`^[A-Za-z0-9_-]{1,30}$`)이 틀리면 `VALIDATION`(`fields.program`). 설정변경 기록에 `소속 구분: 추가 … · 삭제 … · 이름 수정 A → B · 순서 변경` 요약을 남긴다
- 개인정보 파기(`purgePersonalData`, 편집기 실행)는 이름·소속·휴대전화번호·이메일·토큰을 비우고 변경이력의 같은 항목도 지운다. 소속 구분·세부 프로그램은 통계용으로 남긴다
- `adminList` 검색어가 숫자·하이픈·공백뿐이면 전화번호로 본다: 4자리는 뒷자리 일치, 5자리 이상은 부분 일치(`010-1234-5678`, `1234-5678`)
- `adminLogExport` kind: `xlsx` | `csv` | `badge`(취소 제외 행만) | `stats` | `statsXlsx`(행 없음, 기록만)
- `adminExportLog()` / `adminConfigLog()` / `adminAccessLog()`: 관리자로그 시트에서 행위가 각각 내보내기 / 설정변경 / 로그인인 행, 최근 순. 설정변경 행은 `changes`(사람이 읽는 변경 요약 문장 배열)를 가진다. 로그인 기록은 Apps Script 진입(`doGet`) 때 남긴다
- 모의 전용: 주소에 `?mockFail=summary,list,export,config` 를 붙이면 해당 호출이 실패해 오류 화면을 확인할 수 있다

## 집계 규칙
- 날짜별 예상 인원: 22일 = day1 + both, 23일 = day2 + both (취소 제외)
- 정원이 있으면 남은 자리 = 정원 − 해당 날짜 예상 인원, 0 이하이면 그 날짜가 포함된 선택지를 '마감'
