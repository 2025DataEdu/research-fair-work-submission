# API·데이터 계약 (v0)

참가자 화면은 **Cloudflare Worker 주소만** 호출한다. Worker → Apps Script 웹앱 → 구글 시트.
Worker가 IP당 횟수 제한을 하고, Apps Script에는 Worker만 아는 비밀값(`k`)을 붙여 전달한다(직접 호출 차단).
화면 개발 단계에서는 `web/js/api.js`의 모의 구현을 쓰며, 같은 함수 시그니처를 유지한 채 실제 호출로 바꾼다.

## 공통
- 요청: `POST {API_BASE}` , `Content-Type: text/plain;charset=utf-8` (CORS 사전요청 회피), 본문 JSON `{ "action": "...", ...payload }`
- 응답: `{ "ok": true, "data": {...} }` 또는 `{ "ok": false, "code": "ERROR_CODE", "message"?: "..." }`
- 오류 코드: `VALIDATION`(fields: {name|org|phone|day|consent: true}), `DUPLICATE`, `DAY_FULL`, `CLOSED`, `RATE_LIMITED`, `INVALID_TOKEN`, `SERVER`

## 참가자 API (`web/js/api.js` 가 노출하는 함수)
| 함수 | action | 입력 | 성공 data |
|---|---|---|---|
| `getConfig()` | `config` | – | `RFW_CONFIG` 와 같은 구조 |
| `submit(p)` | `submit` | `{name, org, phone, day, consent:true, lang, src, hp}` | `{receiptNo, name, org, day, token}` |
| `lookup(token)` | `lookup` | `{token}` | `{receiptNo, name, org, phone, day, status}` |
| `update(token, p)` | `update` | `{token, name, org, phone, day}` | `{receiptNo, name, org, day}` |
| `cancel(token)` | `cancel` | `{token}` | `{receiptNo, status:"canceled"}` |
| `resendLink(phone)` | `resend` | `{phone}` | `{sent:true}` |

- `phone`: 숫자만 저장(`01012345678`). 화면은 하이픈 자동 삽입. 검증: `^01[016789]\d{7,8}$`
- `day`: `day1` | `day2` | `both`
- `src`: 유입 경로 `?src=` 값(`sms` | `qr` | `web` | 없으면 `direct`)
- `hp`: 허니팟 필드 값(사람은 항상 빈 문자열)
- 수정 링크: `{SITE}/?t={token}` — token 은 추측 불가능한 32자 이상 무작위 문자열
- 접수번호: `RF26-MMDD-NNNN` (MMDD = 신청일, NNNN = 전체 일련번호, 예 `RF26-1118-0042`)

## 시트 구조 (Apps Script 단계에서 생성)
**신청** 탭: 접수번호 | 신청일시 | 수정일시 | 상태(신청/취소) | 이름 | 소속 | 휴대전화번호 | 참석일(day1/day2/both) | 개인정보동의시각 | 언어 | 유입경로 | 토큰
**변경이력**: 일시 | 접수번호 | 변경자(본인/관리자 이메일) | 구분(수정/취소/복원) | 변경 전 | 변경 후
**설정** / **프로그램**: `RFW_CONFIG` 와 같은 값
**관리자로그**: 일시 | 이메일 | 행위(로그인/내보내기/수정/설정변경) | 상세
**방문집계**: 날짜 | 유입경로 | 방문수 | 신청수

## 관리자 API (Apps Script `google.script.run`, 모든 함수가 허용 명단 확인)
`adminWhoAmI()`, `adminGetSummary()`, `adminList({q, day, status, sort})`, `adminUpdate(receiptNo, patch)`, `adminCancel(receiptNo)`, `adminRestore(receiptNo)`, `adminHistory(receiptNo)`, `adminGetConfig()`, `adminSaveConfig(cfg)`, `adminLogExport(kind, filter)`, `adminExportLog()`, `adminConfigLog()`, `adminAccessLog()`
화면 개발 단계에서는 `admin/js/api.js` 모의 구현 사용.

- `adminGetSummary()` 집계 기준: `total` = 유효 신청(상태 신청), `canceled` = 상태 취소, `createdTotal` = 신청일 기준 전체(= total + canceled). `daily[]` = `{date, count(신청일 기준 신규, 이후 취소 포함), canceled·restored(처리일 기준), cumulative(그날 끝 기준 유효 신청, 마지막 값 = total), note}`
- `adminList` 검색어가 숫자·하이픈·공백뿐이면 전화번호로 본다: 4자리는 뒷자리 일치, 5자리 이상은 부분 일치(`010-1234-5678`, `1234-5678`)
- `adminLogExport` kind: `xlsx` | `csv` | `badge`(취소 제외 행만) | `stats` | `statsXlsx`(행 없음, 기록만)
- `adminExportLog()` / `adminConfigLog()` / `adminAccessLog()`: 관리자로그 시트에서 행위가 각각 내보내기 / 설정변경 / 로그인인 행, 최근 순. 설정변경 행은 `changes`(사람이 읽는 변경 요약 문장 배열)를 가진다. 로그인 기록은 Apps Script 진입(`doGet`) 때 남긴다
- 모의 전용: 주소에 `?mockFail=summary,list,export,config` 를 붙이면 해당 호출이 실패해 오류 화면을 확인할 수 있다

## 집계 규칙
- 날짜별 예상 인원: 22일 = day1 + both, 23일 = day2 + both (취소 제외)
- 정원이 있으면 남은 자리 = 정원 − 해당 날짜 예상 인원, 0 이하이면 그 날짜가 포함된 선택지를 '마감'
