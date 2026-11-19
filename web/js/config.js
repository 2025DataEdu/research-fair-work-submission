/* 행사 설정 기본값 (모의 데이터)
   실제 운영에서는 GET /config 응답으로 대체된다 — 관리자 화면 '설정'에서 수정하는 값과 같은 구조.
   세부 프로그램 시간·장소·연사는 확정 전이므로 코드에 박지 말고 이 구조로만 다룬다. */

/* 확인 문자 연동 여부. false 이면 완료 화면의 '확인 문자를 보냈어요' 안내와 '수정 링크 다시 받기'를 숨긴다.
   문자 업체·발신번호가 정해져 Apps Script 에 연동되면 true 로 바꾼다. */
window.RFW_SMS_ENABLED = false;

/* 접수 API 주소 (Cloudflare Worker, docs/deploy-worker.md)
   운영 주소(rfw2026.pages.dev)에서 열릴 때만 실제 Worker 를 부른다.
   그 밖의 주소(GitHub Pages 시안, localhost)는 모의 API — ?mock=reset|closed|full, ?t=demo-token 으로 확인.
   실제 모드에서는 서버 설정이 아래 기본값 위에 덮어써지고, 서버 설정을 못 받으면 아래 값을 그대로 쓴다. */
window.RFW_LIVE_HOSTS = ["rfw2026.pages.dev"];
window.RFW_API_BASE = window.RFW_LIVE_HOSTS.indexOf(location.hostname) >= 0
  ? "https://rfw-api.rfw2026.workers.dev/"
  : "";

window.RFW_CONFIG = {
  open: true,                                   // 접수 열기/닫기 (관리자 설정)
  closeAt: "2026-12-19T18:00:00+09:00",         // 사전 접수 마감 — 이후 자동으로 마감 안내
  showSpeakers: false,                          // 연사 이름 노출 (기본 숨김)
  tagline: {                                    // (안) 고객사 확정 필요
    ko: [
      [{ t: "4단계", em: true }, { t: "의 " }, { t: "성과", em: true }],
      [{ t: "5단계", em: true }, { t: "의 " }, { t: "미래", em: true }, { t: "로 " }, { t: "잇다", em: true }]
    ],
    en: "From Phase 4 to Phase 5"
  },
  // 참석일 선택지 — 저장값 day1/day2/both. capacity: null 이면 정원 없음.
  // remaining: 서버가 계산해 내려주는 남은 자리(정원 있을 때만). 0이면 '마감'.
  days: [
    { value: "day1", capacity: null, remaining: null },
    { value: "day2", capacity: null, remaining: null },
    { value: "both", capacity: null, remaining: null }
  ],
  // 소속 구분 — 순서 = 화면 순서. 관리자 '설정'에서 수정. id 는 저장값이라 바꾸지 않는다.
  affiliations: [
    { id: "group", ko: "교육연구단", en: "BK21 Research Group" },
    { id: "grad", ko: "대학원", en: "Graduate School" },
    { id: "prof", ko: "교수", en: "Faculty" },
    { id: "student", ko: "학생", en: "Student" },
    { id: "external", ko: "외부참여자", en: "External Participant" }
  ],
  // 이틀 프로그램 안내 (확정 전). 신청 폼의 '참석할 프로그램' 선택지도 이 items 를 그대로 쓴다.
  // id: 세부 프로그램 저장·집계 기준 — 한 번 정해지면 이름을 바꿔도 유지(새 항목은 d1-/d2- + 무작위 4~6자)
  program: {
    day1: {
      ko: { title: "리서치 컨퍼런스", date: "12. 22.", dow: "Tue" },
      en: { title: "Research Conference", date: "12. 22.", dow: "Tue" },
      items: [
        { id: "d1-1", time: "13:00~14:05", ko: "개막식·기조강연", en: "Opening Ceremony & Keynote", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { id: "d1-2", time: "14:30~17:30", ko: "컨퍼런스 Session 1·2", en: "Conference Sessions 1 & 2", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { id: "d1-3", time: "", ko: "외국인 유학생 특강", en: "Special Lecture for International Students", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" }
      ]
    },
    day2: {
      ko: { title: "BK21 성과공유회", date: "12. 23.", dow: "Wed" },
      en: { title: "BK21 Achievement Sharing", date: "12. 23.", dow: "Wed" },
      items: [
        { id: "d2-1", time: "", ko: "BK21 4단계 성과공유회", en: "BK21 Phase 4 Achievement Sharing", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { id: "d2-2", time: "", ko: "대학원생 토크콘서트", en: "Graduate Student Talk Concert", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" },
        { id: "d2-3", time: "", ko: "교육연구단 학술행사", en: "Research Group Academic Sessions", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" }
      ]
    }
  },
  contact: { phone: "", email: "" },            // 확정 후 제공 — 비어 있으면 '추후 안내'
  privacyUrl: "#privacy"
};
