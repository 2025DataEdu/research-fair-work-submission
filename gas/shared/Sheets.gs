/* 시트 구조와 읽기·쓰기 — docs/api.md '시트 구조'.
   운영 중 '신청' 탭의 행을 지우거나 정렬하지 말 것(행 번호로 고쳐 쓴다). 보기 정렬은 필터 보기를 쓴다. */

var RFW_SHEET = {
  REG: '신청', HIST: '변경이력', CONF: '설정', PROG: '프로그램', ALOG: '관리자로그', VISIT: '방문집계'
};
var RFW_HEADERS = {
  '신청': ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '개인정보동의시각', '언어', '유입경로', '토큰'],
  '변경이력': ['일시', '접수번호', '변경자', '구분', '변경 전', '변경 후'],
  '설정': ['항목', '값', '설명'],
  '프로그램': ['날짜', '시간', '국문', '영문', '장소', '장소(영문)', '강조', '연사'],
  '관리자로그': ['일시', '이메일', '행위', '상세'],
  '방문집계': ['날짜', '유입경로', '방문수', '신청수']
};
// 글자 서식(@)으로 고정할 열 수 — 전화번호 앞자리 0, 날짜 문자열이 자동 변환되지 않게. 방문집계는 숫자 열 제외.
var RFW_TEXT_COLS = { '신청': 12, '변경이력': 6, '설정': 3, '프로그램': 8, '관리자로그': 4, '방문집계': 2 };
var RFW_MIN_ROWS = 3000;

// '신청' 탭 열 위치 (0부터)
var REG_COL = { receiptNo: 0, createdAt: 1, updatedAt: 2, status: 3, name: 4, org: 5, phone: 6, day: 7, consentAt: 8, lang: 9, src: 10, token: 11 };
var REG_STATUS_KO = { active: '신청', canceled: '취소' };

/* ---------- 스프레드시트 ---------- */
function rfwSpreadsheet_() {
  var id = prop_('SHEET_ID');
  if (!id) throw new Error('스크립트 속성 SHEET_ID 가 비어 있어요. docs/deploy-gas.md 를 보고 설정해 주세요.');
  return SpreadsheetApp.openById(id);
}
function sheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error("'" + name + "' 탭이 없어요. api 프로젝트에서 setup() 을 먼저 실행해 주세요.");
  return sh;
}
/** 머리행 아래 데이터 전체 (없으면 []) */
function dataRows_(sh, width) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

/* ---------- 탭 만들기 (여러 번 실행해도 안전) ---------- */
function setupSheets_(ss) {
  var made = [];
  Object.keys(RFW_HEADERS).forEach(function (name) {
    var headers = RFW_HEADERS[name];
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); made.push(name); }
    if (sh.getMaxRows() < RFW_MIN_ROWS) sh.insertRowsAfter(sh.getMaxRows(), RFW_MIN_ROWS - sh.getMaxRows());
    sh.getRange(1, 1, sh.getMaxRows(), RFW_TEXT_COLS[name]).setNumberFormat('@');
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    } else {
      var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(String);
      if (cur.join('|') !== headers.join('|')) {
        Logger.log("주의: '" + name + "' 탭 머리행이 예상과 달라요. 기대값: " + headers.join(' | '));
      }
    }
    sh.setFrozenRows(1);
  });
  if (sheet_(ss, RFW_SHEET.CONF).getLastRow() < 2 && sheet_(ss, RFW_SHEET.PROG).getLastRow() < 2) {
    writeConfig_(ss, clone_(RFW_DEFAULT_CONFIG), true);
    made.push('설정·프로그램 기본값');
  }
  return made;
}

/* ---------- 신청 ---------- */
function rowToReg_(row, rowNum) {
  return {
    _row: rowNum,
    receiptNo: cellStr_(row[REG_COL.receiptNo]),
    createdAt: cellIso_(row[REG_COL.createdAt]),
    updatedAt: cellIso_(row[REG_COL.updatedAt]),
    status: cellStr_(row[REG_COL.status]) === REG_STATUS_KO.canceled ? 'canceled' : 'active',
    name: cellStr_(row[REG_COL.name]),
    org: cellStr_(row[REG_COL.org]),
    phone: cellPhone_(row[REG_COL.phone]),
    day: cellStr_(row[REG_COL.day]),
    consentAt: cellIso_(row[REG_COL.consentAt]),
    lang: cellStr_(row[REG_COL.lang]) || 'ko',
    src: normSrc_(cellStr_(row[REG_COL.src])),
    token: cellStr_(row[REG_COL.token])
  };
}
function regToRow_(r) {
  var row = [];
  row[REG_COL.receiptNo] = r.receiptNo;
  row[REG_COL.createdAt] = r.createdAt;
  row[REG_COL.updatedAt] = r.updatedAt;
  row[REG_COL.status] = REG_STATUS_KO[r.status] || REG_STATUS_KO.active;
  row[REG_COL.name] = safeCell_(r.name);
  row[REG_COL.org] = safeCell_(r.org);
  row[REG_COL.phone] = r.phone;
  row[REG_COL.day] = r.day;
  row[REG_COL.consentAt] = r.consentAt;
  row[REG_COL.lang] = r.lang;
  row[REG_COL.src] = r.src;
  row[REG_COL.token] = r.token;
  return row;
}
/** 접수번호가 있는 행만. 각 객체의 _row 는 시트 행 번호. */
function readRegs_(ss) {
  var rows = dataRows_(sheet_(ss, RFW_SHEET.REG), 12), out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][REG_COL.receiptNo]).trim()) out.push(rowToReg_(rows[i], i + 2));
  }
  return out;
}
/** 잠금 안에서만 부른다. */
function appendReg_(ss, r) {
  var sh = sheet_(ss, RFW_SHEET.REG);
  var rowNum = sh.getLastRow() + 1;
  var rg = sh.getRange(rowNum, 1, 1, 12);
  rg.setNumberFormat('@');
  rg.setValues([regToRow_(r)]);
  r._row = rowNum;
  return r;
}
/** 잠금 안에서만 부른다. 그 사이 행이 밀렸으면(사람이 정렬 등) 접수번호로 다시 찾는다. */
function writeReg_(ss, r) {
  var sh = sheet_(ss, RFW_SHEET.REG);
  var rowNum = r._row;
  var at = rowNum ? String(sh.getRange(rowNum, 1, 1, 1).getValues()[0][0]) : '';
  if (at !== r.receiptNo) {
    var found = findReg_(readRegs_(ss), 'receiptNo', r.receiptNo);
    if (!found) throw new Error('신청 행을 찾지 못했어요: ' + r.receiptNo);
    rowNum = found._row;
  }
  sh.getRange(rowNum, 1, 1, 12).setValues([regToRow_(r)]);
}
function findReg_(regs, key, value) {
  if (!value) return null;
  for (var i = 0; i < regs.length; i++) if (regs[i][key] === value) return regs[i];
  return null;
}
function activeRegs_(regs) { return regs.filter(function (r) { return r.status === 'active'; }); }

/** 날짜별 예상 인원: 22일 = day1 + both, 23일 = day2 + both (취소 제외) */
function countsOf_(regs) {
  var by = { day1: 0, day2: 0, both: 0 };
  regs.forEach(function (r) { if (r.status === 'active' && by[r.day] != null) by[r.day]++; });
  return { by: by, d22: by.day1 + by.both, d23: by.day2 + by.both };
}

/** 접수번호 RF26-MMDD-NNNN. NNNN = 지금까지 가장 큰 일련번호 + 1 (잠금 안에서만 부른다) */
function nextReceiptNo_(regs) {
  var max = 0;
  regs.forEach(function (r) {
    var m = /-(\d+)$/.exec(r.receiptNo);
    if (m) max = Math.max(max, Number(m[1]));
  });
  var today = kstDate_();
  return 'RF26-' + today.slice(5, 7) + today.slice(8, 10) + '-' + rfwPad_(max + 1, 4);
}

/** 관리자 목록·내보내기용 행 (admin/js/api.js publicRow 와 같은 모양) */
function publicRow_(r) {
  return {
    receiptNo: r.receiptNo, createdAt: r.createdAt, updatedAt: r.updatedAt, status: r.status, name: r.name, org: r.org,
    phoneMasked: maskPhone_(r.phone), phoneLast4: r.phone.slice(-4), day: r.day, consentAt: r.consentAt, lang: r.lang, src: r.src
  };
}

/* ---------- 변경이력 ---------- */
function appendHistory_(ss, h) {
  sheet_(ss, RFW_SHEET.HIST).appendRow([h.at, h.receiptNo, safeCell_(h.by), h.kind,
    JSON.stringify(h.before || {}), JSON.stringify(h.after || {})]);
}
/** 시트 순서(오래된 것 먼저) 그대로 */
function readHistory_(ss) {
  return dataRows_(sheet_(ss, RFW_SHEET.HIST), 6).filter(function (row) { return String(row[1]).trim(); }).map(function (row) {
    return { at: cellIso_(row[0]), receiptNo: cellStr_(row[1]), by: cellStr_(row[2]), kind: cellStr_(row[3]),
      before: jsonParse_(cellStr_(row[4]), {}), after: jsonParse_(cellStr_(row[5]), {}) };
  });
}
/** 최근 순. 시각이 같은 초면 시트에서 뒤에 있는(나중에 쓴) 행이 먼저. */
function newestFirst_(list) {
  return list.map(function (x, i) { return { x: x, i: i }; })
    .sort(function (a, b) { return a.x.at < b.x.at ? 1 : a.x.at > b.x.at ? -1 : b.i - a.i; })
    .map(function (o) { return o.x; });
}
/** 바뀐 항목만 before/after 로. 전화번호는 가린 값으로 남긴다(admin/js/api.js 와 같음). */
function diffReg_(r, next) {
  var before = {}, after = {};
  ['name', 'org', 'phone', 'day'].forEach(function (k) {
    if (k in next && next[k] !== r[k]) {
      before[k] = k === 'phone' ? maskPhone_(r[k]) : r[k];
      after[k] = k === 'phone' ? maskPhone_(next[k]) : next[k];
    }
  });
  return { before: before, after: after, changed: Object.keys(after).length > 0 };
}

/* ---------- 관리자로그 (일시 | 이메일 | 행위 | 상세 JSON) ---------- */
function appendAdminLog_(ss, entry) {
  var detail = {};
  Object.keys(entry).forEach(function (k) { if (k !== 'at' && k !== 'email' && k !== 'action') detail[k] = entry[k]; });
  sheet_(ss, RFW_SHEET.ALOG).appendRow([entry.at, entry.email, entry.action, JSON.stringify(detail)]);
}
/** 행위가 action 인 행, 최근 순. 모양: {at, email, name, action, ...상세} */
function readAdminLog_(ss, action) {
  return newestFirst_(dataRows_(sheet_(ss, RFW_SHEET.ALOG), 4).filter(function (row) { return cellStr_(row[2]) === action; }).map(function (row) {
    var detail = jsonParse_(cellStr_(row[3]), {});
    var out = { at: cellIso_(row[0]), email: cellStr_(row[1]), name: '', action: cellStr_(row[2]) };
    Object.keys(detail || {}).forEach(function (k) { out[k] = detail[k]; });
    if (!out.name) out.name = out.email.split('@')[0];
    return out;
  }));
}

/* ---------- 방문집계 (날짜 | 유입경로 | 방문수 | 신청수) ---------- */
/** deltas: [{date, src, visits, apps}] 를 더한다. 잠금 안에서만 부른다. */
function addVisitCounts_(ss, deltas) {
  if (!deltas.length) return;
  var sh = sheet_(ss, RFW_SHEET.VISIT);
  var rows = dataRows_(sh, 4), index = {};
  rows.forEach(function (row, i) { index[cellStr_(row[0]) + '|' + cellStr_(row[1])] = i; });
  deltas.forEach(function (d) {
    var key = d.date + '|' + d.src, i = index[key];
    if (i == null) {
      rows.push([d.date, d.src, 0, 0]);
      i = index[key] = rows.length - 1;
    }
    rows[i][2] = (Number(rows[i][2]) || 0) + (d.visits || 0);
    rows[i][3] = (Number(rows[i][3]) || 0) + (d.apps || 0);
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
}
