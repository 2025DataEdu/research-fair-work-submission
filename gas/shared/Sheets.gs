/* 시트 구조와 읽기·쓰기 — docs/api.md '시트 구조'.
   운영 중 '신청' 탭의 행을 지우거나 정렬하지 말 것(행 번호로 고쳐 쓴다). 보기 정렬은 필터 보기를 쓴다. */

var RFW_SHEET = {
  REG: '신청', HIST: '변경이력', CONF: '설정', PROG: '프로그램', ALOG: '관리자로그', VISIT: '방문집계'
};
var RFW_HEADERS = {
  '신청': ['접수번호', '신청일시', '수정일시', '상태', '이름', '소속', '휴대전화번호', '참석일', '개인정보동의시각', '언어', '유입경로', '토큰', '소속구분', '이메일', '세부프로그램'],
  '변경이력': ['일시', '접수번호', '변경자', '구분', '변경 전', '변경 후'],
  '설정': ['항목', '값', '설명'],
  '프로그램': ['날짜', '시간', '국문', '영문', '장소', '장소(영문)', '강조', '연사', 'ID'],
  '관리자로그': ['일시', '이메일', '행위', '상세'],
  '방문집계': ['날짜', '유입경로', '방문수', '신청수']
};
// 글자 서식(@)으로 고정할 열 수 — 전화번호 앞자리 0, 날짜 문자열이 자동 변환되지 않게. 방문집계는 숫자 열 제외.
var RFW_TEXT_COLS = { '신청': 15, '변경이력': 6, '설정': 3, '프로그램': 9, '관리자로그': 4, '방문집계': 2 };
var RFW_MIN_ROWS = 3000;

// '신청' 탭 열 위치 (0부터)
var REG_COL = {
  receiptNo: 0, createdAt: 1, updatedAt: 2, status: 3, name: 4, org: 5, phone: 6, day: 7, consentAt: 8, lang: 9, src: 10, token: 11,
  affType: 12, email: 13, programs: 14
};
var REG_WIDTH = 15;
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
      var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(function (v) { return String(v).trim(); });
      // 옛 머리행(뒤 열이 빈 채로 앞부분만 같음)이면 새 열 머리를 뒤에 붙인다. 예: 신청 12열 → 15열, 프로그램 8열 → 9열
      var n = 0;
      while (n < cur.length && cur[n] !== '') n++;
      var older = n < headers.length && cur.slice(0, n).join('|') === headers.slice(0, n).join('|') &&
        cur.slice(n).every(function (v) { return v === ''; });
      if (older && n > 0) {
        sh.getRange(1, n + 1, 1, headers.length - n).setValues([headers.slice(n)]).setFontWeight('bold');
        made.push(name + ' 탭 열 추가(' + headers.slice(n).join(', ') + ')');
      } else if (cur.join('|') !== headers.join('|')) {
        Logger.log("주의: '" + name + "' 탭 머리행이 예상과 달라요. 기대값: " + headers.join(' | '));
      }
    }
    sh.setFrozenRows(1);
  });
  var filled = fillProgramSheetIds_(ss);
  if (filled) made.push('프로그램 ID ' + filled + '칸 채움');
  var conf = sheet_(ss, RFW_SHEET.CONF);
  if (conf.getLastRow() >= 2 && !dataRows_(conf, 1).some(function (row) { return cellStr_(row[0]).trim() === 'affiliations'; })) {
    var desc = RFW_CONF_KEYS.filter(function (kd) { return kd[0] === 'affiliations'; })[0][1];
    conf.getRange(conf.getLastRow() + 1, 1, 1, 3).setValues([['affiliations', JSON.stringify(RFW_DEFAULT_CONFIG.affiliations), desc]]);
    made.push('설정 affiliations 기본값');
  }
  if (sheet_(ss, RFW_SHEET.CONF).getLastRow() < 2 && sheet_(ss, RFW_SHEET.PROG).getLastRow() < 2) {
    writeConfig_(ss, clone_(RFW_DEFAULT_CONFIG), true);
    made.push('설정·프로그램 기본값');
  }
  return made;
}

/** '프로그램' 탭에서 ID 칸이 빈 행에 그날 안 순서대로 'd1-1', 'd1-2'… 를 채운다(readConfig_ 대체 id 와 같은 값).
    채운 칸 수를 돌려준다. 여러 번 실행해도 안전. */
function fillProgramSheetIds_(ss) {
  var sh = sheet_(ss, RFW_SHEET.PROG);
  var rows = dataRows_(sh, RFW_PROG_WIDTH), idCol = RFW_PROG_WIDTH - 1, seen = { day1: 0, day2: 0 }, n = 0;
  var ids = rows.map(function (row) {
    var day = cellStr_(row[0]).trim(), id = cellStr_(row[idCol]).trim();
    if (seen[day] == null) return [row[idCol]];
    var idx = seen[day]++;
    if (id) return [row[idCol]];
    n++;
    return [fallbackProgramId_(day, idx)];
  });
  if (n) sh.getRange(2, RFW_PROG_WIDTH, ids.length, 1).setValues(ids);
  return n;
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
    token: cellStr_(row[REG_COL.token]),
    affType: cellStr_(row[REG_COL.affType]).trim(),
    email: cellStr_(row[REG_COL.email]).trim(),
    programs: cellStr_(row[REG_COL.programs]).split(',').map(function (s) { return s.trim(); }).filter(String)
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
  row[REG_COL.affType] = safeCell_(r.affType || '');
  row[REG_COL.email] = safeCell_(r.email || '');
  row[REG_COL.programs] = safeCell_((r.programs || []).join(','));
  return row;
}
/** 접수번호가 있는 행만. 각 객체의 _row 는 시트 행 번호. */
function readRegs_(ss) {
  var rows = dataRows_(sheet_(ss, RFW_SHEET.REG), REG_WIDTH), out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][REG_COL.receiptNo]).trim()) out.push(rowToReg_(rows[i], i + 2));
  }
  return out;
}
/** 잠금 안에서만 부른다. */
function appendReg_(ss, r) {
  var sh = sheet_(ss, RFW_SHEET.REG);
  var rowNum = sh.getLastRow() + 1;
  var rg = sh.getRange(rowNum, 1, 1, REG_WIDTH);
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
  sh.getRange(rowNum, 1, 1, REG_WIDTH).setValues([regToRow_(r)]);
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
    receiptNo: r.receiptNo, createdAt: r.createdAt, updatedAt: r.updatedAt, status: r.status, name: r.name,
    affType: r.affType, org: r.org, email: r.email,      // 이메일은 자료 발송용이라 관리자에게 원문
    phoneMasked: maskPhone_(r.phone), phoneLast4: r.phone.slice(-4), day: r.day, programs: (r.programs || []).slice(),
    consentAt: r.consentAt, lang: r.lang, src: r.src
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
/** 바뀐 항목만 before/after 로. 전화번호·이메일은 가린 값, 세부 프로그램은 쉼표 문자열로 남긴다(admin/js/api.js 와 같음). */
function diffReg_(r, next) {
  var before = {}, after = {};
  function val(k, v) {
    if (k === 'phone') return maskPhone_(v);
    if (k === 'email') return maskEmail_(v);
    if (k === 'programs') return (v || []).join(',');
    return v == null ? '' : v;
  }
  ['name', 'affType', 'org', 'phone', 'email', 'day', 'programs'].forEach(function (k) {
    if (!(k in next)) return;
    var same = k === 'programs' ? val(k, next[k]) === val(k, r[k]) : next[k] === r[k];
    if (!same) { before[k] = val(k, r[k]); after[k] = val(k, next[k]); }
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

/* ---------- 방문집계 (날짜 | 유입경로 | 방문수 | 신청수) ----------
   마지막 반영 시각은 같은 탭 머리행 오른쪽 F1(이름)·G1(값)에 둔다. 표(A~D)와 한 칸 띄워 데이터 행과 섞이지 않는다.
   api 프로젝트의 캐시·스크립트 속성은 admin 프로젝트가 읽지 못하고, '설정' 탭은 관리자 설정 저장이
   다른 잠금(admin 프로젝트)으로 통째로 다시 쓰므로 api 쪽 쓰기와 겹칠 수 있다. 방문집계 탭은 api 프로젝트만 쓴다. */
var VISIT_STAMP_LABEL = '방문수 마지막 반영';

/** deltas: [{date, src, visits, apps}] 를 더한다. stampIso 가 있으면 마지막 반영 시각도 쓴다. 잠금 안에서만 부른다. */
function addVisitCounts_(ss, deltas, stampIso) {
  if (stampIso) {
    var st = sheet_(ss, RFW_SHEET.VISIT).getRange(1, 6, 1, 2);
    st.setNumberFormat('@');                       // ISO 문자열이 날짜로 바뀌지 않게
    st.setValues([[VISIT_STAMP_LABEL, stampIso]]);
  }
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

/** 방문집계 전체 합계 (관리자 집계용). 개인 정보 없음 — 날짜·경로별 숫자만.
    {visits:{sms,qr,web,direct,total}, submits:{…}, daily:[{date, visits, submits}], updatedAt: ISO|null} */
function readVisitStats_(ss) {
  var sh = sheet_(ss, RFW_SHEET.VISIT);
  var zero = function () { return { sms: 0, qr: 0, web: 0, direct: 0, total: 0 }; };
  var visits = zero(), submits = zero(), perDay = {};
  dataRows_(sh, 4).forEach(function (row) {
    var date = cellIso_(row[0]).slice(0, 10);
    if (!date) return;
    var src = normSrc_(cellStr_(row[1]));
    var v = Math.max(0, Number(row[2]) || 0), a = Math.max(0, Number(row[3]) || 0);
    visits[src] += v; visits.total += v;
    submits[src] += a; submits.total += a;
    var d = perDay[date] || (perDay[date] = { date: date, visits: 0, submits: 0 });
    d.visits += v; d.submits += a;
  });
  var stamp = cellIso_(sh.getRange(1, 7, 1, 1).getValues()[0][0]);
  return {
    visits: visits, submits: submits,
    daily: Object.keys(perDay).sort().map(function (k) { return perDay[k]; }),
    updatedAt: stamp || null
  };
}
/** 신청 ÷ 방문 (소수 넷째 자리). 방문이 0 이면 null */
function conversionOf_(visits, submits) {
  var out = {};
  ['sms', 'qr', 'web', 'direct', 'total'].forEach(function (k) {
    out[k] = visits[k] > 0 ? Math.round(submits[k] / visits[k] * 10000) / 10000 : null;
  });
  return out;
}
