/* 행사 설정 기본값 (모의 데이터)
   실제 운영에서는 GET /config 응답으로 대체된다 — 관리자 화면 '설정'에서 수정하는 값과 같은 구조.
   세부 프로그램 시간·장소·연사는 확정 전이므로 코드에 박지 말고 이 구조로만 다룬다. */

/* 접수 API 주소 (Cloudflare Worker, docs/deploy-worker.md)
   비어 있으면 모의 API — GitHub Pages 시안에서 ?mock=reset|closed|full, ?t=demo-token 으로 확인.
   운영 때 Worker 주소를 넣는다. 예: "https://rfw-api.<계정>.workers.dev/"
   실제 모드에서는 서버 설정이 아래 기본값 위에 덮어써지고, 서버 설정을 못 받으면 아래 값을 그대로 쓴다. */
window.RFW_API_BASE = "";

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
  // 이틀 프로그램 안내 (안내용, 확정 전)
  program: {
    day1: {
      ko: { title: "리서치 컨퍼런스", date: "12. 22.", dow: "Tue" },
      en: { title: "Research Conference", date: "12. 22.", dow: "Tue" },
      items: [
        { time: "13:00~14:05", ko: "개막식·기조강연", en: "Opening Ceremony & Keynote", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { time: "14:30~17:30", ko: "컨퍼런스 Session 1·2", en: "Conference Sessions 1 & 2", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { time: "", ko: "외국인 유학생 특강", en: "Special Lecture for International Students", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" }
      ]
    },
    day2: {
      ko: { title: "BK21 성과공유회", date: "12. 23.", dow: "Wed" },
      en: { title: "BK21 Achievement Sharing", date: "12. 23.", dow: "Wed" },
      items: [
        { time: "", ko: "BK21 4단계 성과공유회", en: "BK21 Phase 4 Achievement Sharing", place: "진수당", placeEn: "Jinsudang", highlight: true, speaker: "" },
        { time: "", ko: "대학원생 토크콘서트", en: "Graduate Student Talk Concert", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" },
        { time: "", ko: "교육연구단 학술행사", en: "Research Group Academic Sessions", place: "진수당", placeEn: "Jinsudang", highlight: false, speaker: "" }
      ]
    }
  },
  contact: { phone: "", email: "" },            // 확정 후 제공 — 비어 있으면 '추후 안내'
  privacyUrl: "#privacy"
};
