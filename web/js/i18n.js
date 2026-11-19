/* 화면 문구 — 한국어는 명세서 4장 '고객사 양식' 원문을 글자 하나까지 그대로 쓴다.
   ⚠ ko 의 form/intro/days 문구는 수정 금지 (검수 기준: 원문과 글자 단위 일치). 바꾸려면 고객사 승인 필요.
   2026-11-19 고객사 요청(피드백 2)으로 소속 구분·이메일·참석할 프로그램 문구를 더했다 — 요청 원문 그대로.
   말투: '…해 주세요 / …했어요'. 버튼은 눌렀을 때 일어나는 일 그대로. */
window.RFW_I18N = {
  ko: {
    topbar: { brand: "JBNU BK21 · 리서치페어 위크", dates: "2026. 12. 22 – 23", toggle: "EN", toggleLabel: "Switch to English" },

    hero: {
      rfwAlt: "RFW — 리서치페어 위크 대표 그래픽",
      nameKo: "2026 JBNU-G 리서치페어 위크",   // 작은 국문 행사명
      nameEn: "2026 JBNU-G RFW",               // 초대형 영문 행사명
      dateStart: { y: "2026.", md: "12. 22.", dow: "Tue" },
      dateEnd: { md: "12. 23.", dow: "Wed" },
      place: "전북대학교 진수당",
      slogan: "Bridge to JeonbuK NU : From Phase 4 to Phase 5"
    },

    // ── 4장 양식 원문 (수정 금지) ──
    intro: {
      title: "2026 JBNU-G 리서치페어 위크 참가 신청",
      body: "전북대학교의 연구성과를 나누고 대학과 지역의 미래 발전 방향을 함께 모색하는 2026 JBNU-G 리서치페어 위크에 여러분을 초대합니다. 대학원생과 연구자의 발표를 통해 BK21 4단계의 성과를 살펴보고, 이를 바탕으로 5단계의 추진 과제와 지역 기업·연구기관과의 새로운 협력 기회를 논의합니다.",
      schedule: "▪일정 : 2026년 12월 22일(화)~23일(수)",
      venue: "▪장소 : 전북대학교 진수당"
    },
    form: {
      lead: "참가를 희망하시는 분은 아래 항목을 작성해 주세요.",
      mailNotice: "신청하시면 행사 전에 행사 관련 자료를 이메일로 보내 드려요.",   // 피드백 2 — 폼 머리 강조 안내
      name: { label: "이름", hint: "성함을 입력해 주세요.", error: "이름을 입력해 주세요." },
      org: {
        label: "소속", hint: "소속 학교·학과 또는 기관·부서명을 입력해 주세요.", error: "소속을 입력해 주세요.",
        typeLabel: "소속 구분", typeError: "소속 구분을 선택해 주세요.",   // 피드백 2
        detailLabel: "세부 소속"
      },
      phone: { label: "휴대전화번호", placeholder: "예시) 010-1234-5678", error: "휴대전화번호를 확인해 주세요.", hint: "" },  // hint: 영문 전용 — 국문 양식에는 안내 문구 없음 (빈 값이면 표시 안 함)
      email: { label: "이메일", hint: "행사 전에 행사 관련 자료를 이 주소로 보내 드려요.", placeholder: "예시) name@example.com", error: "이메일 주소를 확인해 주세요." },   // 피드백 2
      day: { label: "참석일", hint: "참석 예정일을 선택해 주세요.", error: "참석일을 선택해 주세요." },
      programs: { label: "참석할 프로그램", hint: "참석하실 프로그램을 모두 선택해 주세요.", error: "참석하실 프로그램을 날짜별로 하나 이상 선택해 주세요." },   // 피드백 2
      consent: {
        label: "개인정보 수집·이용에 동의합니다.",
        required: "(필수)",
        more: "내용 보기",
        less: "접기",
        error: "동의해 주셔야 신청할 수 있어요.",
        locked: "신청할 때 동의하셨어요."   // 추가 — 수정 모드 안내
      },
      submit: "신청하기",
      submitting: "신청하는 중…",
      full: "마감",
      remaining: "남은 자리 {n}석"
    },
    days: {
      day1: "12월 22일(화) · 리서치 컨퍼런스",
      day2: "12월 23일(수) · BK21 성과공유회",
      both: "12월 22일(화)~23일(수) · 양일 모두 참석"
    },
    // ── 원문 끝 ──

    privacy: {
      title: "개인정보 수집·이용 안내",
      rows: [
        ["수집 항목", "이름, 소속(구분·세부 소속), 휴대전화번호, 이메일, 참석일·참석 프로그램"],
        ["수집·이용 목적", "참가 확인, 행사 안내 문자 발송, 행사 자료 이메일 발송, 명찰·좌석 준비, 결과보고 통계"],
        ["보유·이용 기간", "행사 종료 6개월 후 파기"],
        ["동의 거부 권리", "동의를 거부할 수 있어요. 다만 동의하지 않으면 사전 참가 신청을 할 수 없어요."]
      ]
    },

    program: { title: "프로그램 안내", note: "세부 시간·장소는 확정 후 안내해 드려요.", time: "시간", content: "주요내용", place: "장소", tbd: "추후 안내" },

    done: {
      title: "신청이 완료됐어요",
      receipt: "접수번호",
      name: "이름", org: "소속", email: "이메일", day: "참석일", programs: "참석 프로그램", when: "일시·장소",
      mail: "행사 전에 {email} 로 행사 자료를 보내 드릴게요.",
      sms: "확인 문자를 보냈어요. 문자 속 링크로 언제든 신청 내용을 수정하거나 취소할 수 있어요.",
      edit: "신청 내용 수정"
    },
    edit: {
      title: "신청 내용 수정",
      save: "수정 내용 저장",
      saving: "저장하는 중…",
      cancel: "신청 취소",
      cancelConfirm: "정말 신청을 취소할까요? 취소한 뒤에는 다시 신청해 주셔야 해요.",
      cancelYes: "신청 취소하기",
      cancelNo: "돌아가기",
      saved: "수정 내용을 저장했어요.",
      canceled: "신청을 취소했어요.",
      canceledBody: "다시 참가를 원하시면 새로 신청해 주세요.",
      reapply: "다시 신청하기",
      invalid: "링크가 올바르지 않거나 만료됐어요. 확인 문자의 링크로 다시 들어와 주세요."
    },
    duplicate: {
      message: "이미 신청하셨어요. 수정 링크를 문자로 다시 보내 드릴까요?",
      messageNoSms: "이미 신청하셨어요.",   // 문자 연동 전(RFW_SMS_ENABLED=false) 임시 — 원문 첫 문장만
      resend: "수정 링크 다시 받기",
      sent: "수정 링크를 문자로 다시 보냈어요."
    },
    closed: {
      title: "사전 접수가 끝났어요",
      body: "사전 접수가 끝났어요. 현장 등록은 행사 당일 가능합니다"
    },
    errors: {
      network: "잠시 연결이 원활하지 않아요. 다시 시도해 주세요.",
      rate: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
      dayFull: "선택하신 참석일이 마감됐어요. 다른 날을 선택해 주세요."
    },
    cta: "신청하기",
    ctaEdit: "신청 내용 수정",
    skip: "신청 폼으로 바로가기",
    footer: {
      host: "주최·운영",
      hostValue: "전북대학교 BK21 / 운영 케이브레인컴퍼니",
      contact: "문의",
      contactTbd: "운영사무국 연락처는 추후 안내해 드려요.",
      privacy: "개인정보 처리방침",
      logoAlt: "전북대학교 BK혁신추진단"
    }
  },

  en: {
    topbar: { brand: "JBNU BK21 · Research Fair Week", dates: "Dec 22 – 23, 2026", toggle: "한", toggleLabel: "한국어로 보기" },
    hero: {
      rfwAlt: "RFW — Research Fair Week key graphic",
      nameKo: "2026 JBNU-G Research Fair Week",
      nameEn: "2026 JBNU-G RFW",
      dateStart: { y: "2026.", md: "12. 22.", dow: "Tue" },
      dateEnd: { md: "12. 23.", dow: "Wed" },
      place: "Jinsudang, Jeonbuk National University",
      slogan: "Bridge to JeonbuK NU : From Phase 4 to Phase 5"
    },
    intro: {
      title: "2026 JBNU-G Research Fair Week Registration",
      body: "You are invited to the 2026 JBNU-G Research Fair Week, where we share Jeonbuk National University's research achievements and explore the future of the university and the region together. Through presentations by graduate students and researchers, we will review the achievements of BK21 Phase 4 and discuss Phase 5 initiatives and new opportunities for collaboration with local companies and research institutes.",
      schedule: "▪Date : Dec 22 (Tue) – 23 (Wed), 2026",
      venue: "▪Venue : Jinsudang, Jeonbuk National University"
    },
    form: {
      lead: "If you would like to attend, please fill out the form below.",
      mailNotice: "Once you register, we'll email you the event materials before the event.",
      name: { label: "Name", hint: "Please enter your full name.", error: "Please enter your name." },
      org: {
        label: "Affiliation", hint: "Please enter your school/department or organization/division.", error: "Please enter your affiliation.",
        typeLabel: "Affiliation type", typeError: "Please select your affiliation type.",
        detailLabel: "Affiliation details"
      },
      phone: { label: "Mobile phone", placeholder: "e.g. 010-1234-5678", error: "Please check your mobile phone number.", hint: "Korean mobile number (starts with 010)" },
      email: { label: "Email", hint: "We'll send the event materials to this address before the event.", placeholder: "e.g. name@example.com", error: "Please check your email address." },
      day: { label: "Attendance date", hint: "Please select the day you plan to attend.", error: "Please select an attendance date." },
      programs: { label: "Sessions you'll attend", hint: "Please select all the sessions you plan to attend.", error: "Please select at least one session for each day." },
      consent: {
        label: "I agree to the collection and use of personal information.",
        required: "(Required)",
        more: "View details",
        less: "Hide",
        error: "You need to agree before registering.",
        locked: "You agreed to this when you registered."
      },
      submit: "Register",
      submitting: "Registering…",
      full: "Full",
      remaining: "{n} seats left"
    },
    days: {
      day1: "Dec 22 (Tue) · Research Conference",
      day2: "Dec 23 (Wed) · BK21 Achievement Sharing",
      both: "Dec 22 (Tue) – 23 (Wed) · Both days"
    },
    privacy: {
      title: "Collection and Use of Personal Information",
      rows: [
        ["Items collected", "Name, affiliation (type and details), mobile phone number, email, attendance date and sessions"],
        ["Purpose", "Confirming attendance, event text messages, emailing event materials, name tags and seating, statistics for the final report"],
        ["Retention", "Destroyed 6 months after the event"],
        ["Right to refuse", "You may refuse, but you cannot pre-register without agreeing."]
      ]
    },
    program: { title: "Program", note: "Detailed times and rooms will be announced once confirmed.", time: "Time", content: "Program", place: "Venue", tbd: "TBA" },
    done: {
      title: "You're registered",
      receipt: "Registration No.",
      name: "Name", org: "Affiliation", email: "Email", day: "Date", programs: "Sessions", when: "When & where",
      mail: "We'll send the event materials to {email} before the event.",
      sms: "We sent you a confirmation text. Use the link in it to change or cancel your registration anytime.",
      edit: "Edit registration"
    },
    edit: {
      title: "Edit registration",
      save: "Save changes",
      saving: "Saving…",
      cancel: "Cancel registration",
      cancelConfirm: "Cancel your registration? You'll need to register again to attend.",
      cancelYes: "Cancel registration",
      cancelNo: "Go back",
      saved: "Your changes have been saved.",
      canceled: "Your registration has been canceled.",
      canceledBody: "If you'd like to attend, please register again.",
      reapply: "Register again",
      invalid: "This link is invalid or has expired. Please use the link in your confirmation text."
    },
    duplicate: {
      message: "You've already registered. Shall we text you your edit link again?",
      messageNoSms: "You've already registered.",
      resend: "Resend edit link",
      sent: "We've texted you your edit link again."
    },
    closed: {
      title: "Pre-registration has closed",
      body: "Pre-registration has closed. On-site registration is available on the day of the event."
    },
    errors: {
      network: "Connection problem. Please try again.",
      rate: "Too many requests. Please try again shortly.",
      dayFull: "The date you selected is full. Please choose another."
    },
    cta: "Register",
    ctaEdit: "Edit registration",
    skip: "Skip to registration form",
    footer: {
      host: "Hosted by",
      hostValue: "Jeonbuk National University BK21 / Operated by KBrain Company",
      contact: "Contact",
      contactTbd: "Contact details will be announced.",
      privacy: "Privacy Policy",
      logoAlt: "Jeonbuk National University BK21 Innovation Division"
    }
  }
};
