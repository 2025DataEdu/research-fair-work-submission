/* 행사 설정 — '설정' 탭(항목 | 값 | 설명)과 '프로그램' 탭(세부 프로그램 한 줄 = 한 행).
   값 칸은 글자 서식. 객체·true/false·숫자는 JSON 으로 읽고, JSON 이 아니면 문자열 그대로 쓴다.
   기본값은 web/js/config.js 의 RFW_CONFIG 와 같다(바꾸면 둘 다 맞춰 주세요). */

var RFW_DEFAULT_CONFIG = {
  open: true,
  closeAt: '2026-12-19T18:00:00+09:00',
  showSpeakers: false,
  tagline: {
    ko: [
      [{ t: '4단계', em: true }, { t: '의 ' }, { t: '성과', em: true }],
      [{ t: '5단계', em: true }, { t: '의 ' }, { t: '미래', em: true }, { t: '로 ' }, { t: '잇다', em: true }]
    ],
    en: 'From Phase 4 to Phase 5'
  },
  days: [
    { value: 'day1', capacity: null, remaining: null },
    { value: 'day2', capacity: null, remaining: null },
    { value: 'both', capacity: null, remaining: null }
  ],
  // 소속 구분. 순서 = 화면 순서. id 는 신청 데이터·집계에 쓰이므로 바꾸지 않는다.
  affiliations: [
    { id: 'group', ko: '교육연구단', en: 'BK21 Research Group' },
    { id: 'grad', ko: '대학원', en: 'Graduate School' },
    { id: 'prof', ko: '교수', en: 'Faculty' },
    { id: 'student', ko: '학생', en: 'Student' },
    { id: 'external', ko: '외부참여자', en: 'External Participant' }
  ],
  // 세부 프로그램 items[].id 는 참석 프로그램 선택·집계 기준. 한 번 정하면 이름을 바꿔도 유지한다.
  program: {
    day1: {
      ko: { title: '리서치 컨퍼런스', date: '12. 22.', dow: 'Tue' },
      en: { title: 'Research Conference', date: '12. 22.', dow: 'Tue' },
      items: [
        { id: 'd1-1', time: '13:00~14:05', ko: '개막식·기조강연', en: 'Opening Ceremony & Keynote', place: '진수당', placeEn: 'Jinsudang', highlight: true, speaker: '' },
        { id: 'd1-2', time: '14:30~17:30', ko: '컨퍼런스 Session 1·2', en: 'Conference Sessions 1 & 2', place: '진수당', placeEn: 'Jinsudang', highlight: true, speaker: '' },
        { id: 'd1-3', time: '', ko: '외국인 유학생 특강', en: 'Special Lecture for International Students', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' }
      ]
    },
    day2: {
      ko: { title: 'BK21 성과공유회', date: '12. 23.', dow: 'Wed' },
      en: { title: 'BK21 Achievement Sharing', date: '12. 23.', dow: 'Wed' },
      items: [
        { id: 'd2-1', time: '', ko: 'BK21 4단계 성과공유회', en: 'BK21 Phase 4 Achievement Sharing', place: '진수당', placeEn: 'Jinsudang', highlight: true, speaker: '' },
        { id: 'd2-2', time: '', ko: '대학원생 토크콘서트', en: 'Graduate Student Talk Concert', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' },
        { id: 'd2-3', time: '', ko: '교육연구단 학술행사', en: 'Research Group Academic Sessions', place: '진수당', placeEn: 'Jinsudang', highlight: false, speaker: '' }
      ]
    }
  },
  contact: { phone: '', email: '' },
  privacyUrl: '#privacy'
};

// '설정' 탭 항목 (순서대로 기록). dailyNotes 는 참가자 설정에 나가지 않는 관리자 현황용 메모.
var RFW_CONF_KEYS = [
  ['open', '접수 받기 (true / false)'],
  ['closeAt', '사전 접수 마감 일시 (예: 2026-12-19T18:00:00+09:00)'],
  ['showSpeakers', '연사 이름 공개 (true / false)'],
  ['capacity_day1', '22일 정원 (비우면 정원 없음). 22일 = 22일만 + 양일'],
  ['capacity_day2', '23일 정원 (비우면 정원 없음). 23일 = 23일만 + 양일'],
  ['tagline', '태그라인 (JSON)'],
  ['affiliations', '소속 구분 목록 (JSON). id 는 바꾸지 마세요'],
  ['program_day1', '22일 프로그램 제목·날짜 (JSON). 세부 항목은 프로그램 탭'],
  ['program_day2', '23일 프로그램 제목·날짜 (JSON). 세부 항목은 프로그램 탭'],
  ['contact', '문의처 (JSON)'],
  ['privacyUrl', '개인정보 처리방침 주소'],
  ['dailyNotes', '관리자 일별 현황 메모 (JSON, 예: {"2026-12-01":"접수 오픈 · 1차 홍보 문자"})']
];
var RFW_PROG_FIELDS = ['time', 'ko', 'en', 'place', 'placeEn', 'highlight', 'speaker', 'id']; // 프로그램 탭 2열부터 (ID 는 9열)
var RFW_PROG_WIDTH = RFW_PROG_FIELDS.length + 1;
var RFW_PROG_ID_RE = /^[A-Za-z0-9_-]{1,30}$/;   // 신청 시트에 쉼표로 이어 적으므로 쉼표·공백 없이

/** 읽을 때 ID 가 빈 항목의 대체 id: 그날 안 순서(1부터)로 'd1-1', 'd1-2'… (기존 시트 호환) */
function fallbackProgramId_(day, index) { return (day === 'day2' ? 'd2-' : 'd1-') + (index + 1); }
/** 새 항목 id: 'd1-' / 'd2-' + 무작위 base36 4~6자. used 에 있는 값은 피한다. */
function newProgramId_(day, used) {
  for (;;) {
    var len = 4 + Math.floor(Math.random() * 3), s = '';
    while (s.length < len) s += Math.floor(Math.random() * 36).toString(36);
    var id = (day === 'day2' ? 'd2-' : 'd1-') + s;
    if (!used[id]) return id;
  }
}
/** cfg.program 의 id 가 빈 항목에 새 id 를 채운다(cfg 를 고침). 이미 있는 id 는 그대로. */
function fillProgramIds_(cfg) {
  var used = {};
  ['day1', 'day2'].forEach(function (day) {
    (((cfg.program || {})[day] || {}).items || []).forEach(function (it) { if (it && it.id) used[it.id] = true; });
  });
  ['day1', 'day2'].forEach(function (day) {
    (((cfg.program || {})[day] || {}).items || []).forEach(function (it) {
      if (it && !it.id) { it.id = newProgramId_(day, used); used[it.id] = true; }
    });
  });
  return cfg;
}
/** 설정 칸의 소속 구분 목록 → [{id, ko, en}]. 형식이 틀리거나 비면 기본값. */
function readAffiliations_(v) {
  var list = Array.isArray(v) ? v.filter(function (a) { return a && typeof a === 'object' && a.id; }) : [];
  if (!list.length) return clone_(RFW_DEFAULT_CONFIG.affiliations);
  return list.map(function (a) { return { id: String(a.id), ko: String(a.ko == null ? '' : a.ko), en: String(a.en == null ? '' : a.en) }; });
}

function confCell_(v) {
  if (v instanceof Date) return kstIso_(v.getTime());
  var s = cellStr_(v).trim();
  if (s === '') return null;
  try { return JSON.parse(s); } catch (e) { return s; }
}
function capOfCell_(v) {
  if (v == null || v === '') return null;
  var n = Math.floor(Number(v));
  return isFinite(n) && n >= 0 ? n : null;
}

/** 시트 → 설정 객체 (RFW_CONFIG 구조, remaining 은 null). dailyNotes 는 별도 필드 _dailyNotes. */
function readConfig_(ss) {
  var d = RFW_DEFAULT_CONFIG, kv = {};
  dataRows_(sheet_(ss, RFW_SHEET.CONF), 2).forEach(function (row) {
    var k = cellStr_(row[0]).trim();
    if (k) kv[k] = confCell_(row[1]);
  });
  var items = { day1: [], day2: [] };
  dataRows_(sheet_(ss, RFW_SHEET.PROG), RFW_PROG_WIDTH).forEach(function (row) {
    var day = cellStr_(row[0]).trim();
    if (!items[day]) return;
    var it = {};
    RFW_PROG_FIELDS.forEach(function (f, i) {
      it[f] = f === 'highlight' ? toBool_(row[i + 1], false) : f === 'id' ? cellStr_(row[i + 1]).trim() : cellStr_(row[i + 1]);
    });
    if (!it.id) it.id = fallbackProgramId_(day, items[day].length);   // ID 칸이 빈 옛 시트
    items[day].push(it);
  });
  function header(day) {
    var h = kv['program_' + day];
    var base = h && typeof h === 'object' ? h : d.program[day];
    return { ko: clone_(base.ko || d.program[day].ko), en: clone_(base.en || d.program[day].en), items: items[day] };
  }
  return {
    open: toBool_(kv.open, d.open),
    closeAt: kv.closeAt == null ? d.closeAt : String(kv.closeAt),
    showSpeakers: toBool_(kv.showSpeakers, d.showSpeakers),
    tagline: kv.tagline && typeof kv.tagline === 'object' ? kv.tagline : clone_(d.tagline),
    days: [
      { value: 'day1', capacity: capOfCell_(kv.capacity_day1), remaining: null },
      { value: 'day2', capacity: capOfCell_(kv.capacity_day2), remaining: null },
      { value: 'both', capacity: null, remaining: null }
    ],
    affiliations: readAffiliations_(kv.affiliations),
    program: { day1: header('day1'), day2: header('day2') },
    contact: kv.contact && typeof kv.contact === 'object' ? kv.contact : clone_(d.contact),
    privacyUrl: kv.privacyUrl == null ? d.privacyUrl : String(kv.privacyUrl),
    _dailyNotes: kv.dailyNotes && typeof kv.dailyNotes === 'object' ? kv.dailyNotes : {}
  };
}

/** 설정 객체 → 시트. 설명 칸과 모르는 항목, dailyNotes 는 그대로 둔다(seed 때만 새로 씀).
    세부 프로그램 id 가 빈 항목에는 새 id 를 채운다(cfg 도 같이 바뀐다). */
function writeConfig_(ss, cfg, seed) {
  fillProgramIds_(cfg);
  function capIn(v) { for (var i = 0; i < cfg.days.length; i++) if (cfg.days[i].value === v) return cfg.days[i].capacity; return null; }
  function hdr(day) { var p = cfg.program[day] || {}; return { ko: p.ko || {}, en: p.en || {} }; }
  var values = {
    open: !!cfg.open, closeAt: cfg.closeAt || '', showSpeakers: !!cfg.showSpeakers,
    capacity_day1: capIn('day1'), capacity_day2: capIn('day2'),
    tagline: cfg.tagline, affiliations: cfg.affiliations || clone_(RFW_DEFAULT_CONFIG.affiliations),
    program_day1: hdr('day1'), program_day2: hdr('day2'),
    contact: cfg.contact || { phone: '', email: '' }, privacyUrl: cfg.privacyUrl || ''
  };
  if (seed) values.dailyNotes = {};
  function enc(v) { return v == null ? '' : typeof v === 'string' ? safeCell_(v) : JSON.stringify(v); }

  var sh = sheet_(ss, RFW_SHEET.CONF);
  var rows = dataRows_(sh, 3), index = {};
  rows.forEach(function (row, i) { index[cellStr_(row[0]).trim()] = i; });
  RFW_CONF_KEYS.forEach(function (kd) {
    if (!(kd[0] in values)) return;
    var i = index[kd[0]];
    if (i == null) { rows.push([kd[0], enc(values[kd[0]]), kd[1]]); index[kd[0]] = rows.length - 1; }
    else rows[i][1] = enc(values[kd[0]]);
  });
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);

  var psh = sheet_(ss, RFW_SHEET.PROG);
  var old = psh.getLastRow();
  if (old >= 2) psh.getRange(2, 1, old - 1, RFW_PROG_WIDTH).clearContent();
  var prow = [];
  ['day1', 'day2'].forEach(function (day) {
    ((cfg.program[day] || {}).items || []).forEach(function (it) {
      prow.push([day].concat(RFW_PROG_FIELDS.map(function (f) {
        return f === 'highlight' ? (it.highlight ? 'TRUE' : 'FALSE') : safeCell_(it[f] == null ? '' : String(it[f]));
      })));
    });
  });
  if (prow.length) psh.getRange(2, 1, prow.length, RFW_PROG_WIDTH).setValues(prow);
}

/** remaining 계산 (web/js/api.js buildConfig 와 같음: 양일 = 두 날 중 적은 쪽). clamp=true 면 0 아래로 내려가지 않게(관리자 화면). */
function withRemaining_(cfg, regs, clamp) {
  var out = clone_(cfg);
  delete out._dailyNotes;
  var c = countsOf_(regs), byVal = {};
  out.days.forEach(function (d) { byVal[d.value] = d; });
  function rem(d, n) { if (!d || d.capacity == null) return null; var r = d.capacity - n; return clamp ? Math.max(0, r) : r; }
  var r1 = rem(byVal.day1, c.d22), r2 = rem(byVal.day2, c.d23);
  if (byVal.day1) byVal.day1.remaining = r1;
  if (byVal.day2) byVal.day2.remaining = r2;
  if (byVal.both) {
    var parts = [r1, r2].filter(function (v) { return v != null; });
    byVal.both.capacity = null;
    byVal.both.remaining = parts.length ? Math.min.apply(null, parts) : null;
  }
  return out;
}
function isClosed_(cfg, nowMs) {
  if (!cfg.open) return true;
  var t = Date.parse(cfg.closeAt);
  return !isNaN(t) && (nowMs == null ? Date.now() : nowMs) > t;
}
/** cfg 는 withRemaining_ 을 거친 값 */
function isDayFull_(cfg, day) {
  var d = cfg.days.filter(function (x) { return x.value === day; })[0];
  return !!(d && d.remaining != null && d.remaining <= 0);
}
