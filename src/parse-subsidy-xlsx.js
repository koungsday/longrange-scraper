/**
 * 환경부 Excel 의 「모델별_지방비」 시트 → 기존 모델 보조금 산출물 3종.
 *
 * ★왜 필요했나 (2026-08-16)
 *   기존 대상이던 psPopupLocalCarModelPrice.do 가 **HTTP 500 으로 삭제**됐다.
 *   개편이 아니라 페이지가 없어진 것이라 고쳐 쓸 대상이 아예 없다.
 *   같은 데이터가 현황 Excel 안에 들어 있고, 오히려 더 많다
 *   (국비·지방비·전환지원금·총액·배터리·주행거리·지원여부).
 *
 * ★단위를 고정하지 않는다 — 사용자 요구
 *   금액 단위(만원/원)는 그쪽 사정으로 언제든 바뀔 수 있다. 그래서 **두 곳에서
 *   읽어 서로 대조**한다: 열 머리글 "지방비(만원)" 와 안내 시트의 "단위 … 금액=만원".
 *   · 둘이 다르면 던진다 — 조용히 한쪽을 고르면 값이 1만 배 틀어진 채로 배포된다.
 *   · 둘 다 없으면 던진다 — 추측하지 않는다.
 *   출력은 예전처럼 **원(KRW) 정수**로 통일한다(하류가 그렇게 읽고 있다).
 *
 * ★단종 모델은 안 나온다
 *   Excel 은 지원여부='지원' 만 싣는다. 기존 산출물엔 "(단종)…" 이 10종 있었고
 *   161개 지역 전부에서 정확히 그 10종만 빠진다(비단종 누락 0, 신규 누락 0).
 *   지역별 취급 차종 편차(97~121종)는 그대로 보존된다.
 */

const { readSheets } = require('./parse-quota-xlsx');

/** 단위 이름 → 원 환산 배수. 새 단위가 생기면 여기만 늘린다. */
const UNIT_TO_WON = { 원: 1, 천원: 1000, 만원: 10000, 백만원: 1000000, 억원: 100000000 };

/** "지방비(만원)" → 10000. 괄호 안이 단위표에 없으면 null. */
function unitFromHeader(header) {
  const m = /\(([^)]+)\)\s*$/.exec((header || '').trim());
  if (!m) return null;
  const u = m[1].replace(/\s/g, '');
  return UNIT_TO_WON[u] ?? null;
}

/** 안내 시트의 "단위 | 대수=대, 비율=%, 금액=만원" 에서 금액 단위를 뽑는다. */
function unitFromGuide(sheets) {
  const guide = sheets['안내'];
  if (!guide) return null;
  for (const row of guide) {
    if ((row[0] || '').replace(/\s/g, '') !== '단위') continue;
    const m = /금액\s*=\s*([^\s,·]+)/.exec(row[1] || '');
    if (m) return UNIT_TO_WON[m[1].replace(/\s/g, '')] ?? null;
  }
  return null;
}

/** 두 선언을 대조해 확정한다. 어긋나거나 없으면 던진다. */
function resolveMoneyUnit(sheets, header) {
  const a = unitFromHeader(header);
  const b = unitFromGuide(sheets);
  const nameOf = (v) => Object.keys(UNIT_TO_WON).find((k) => UNIT_TO_WON[k] === v) || String(v);
  if (a && b && a !== b) {
    throw new Error(`금액 단위 선언이 서로 다릅니다 — 열 머리글 '${nameOf(a)}' vs 안내 시트 '${nameOf(b)}'. 사람이 확인해야 합니다.`);
  }
  const u = a || b;
  if (!u) {
    throw new Error(`금액 단위를 읽지 못했습니다 (머리글='${header}'). 단위 표기가 바뀌었을 수 있습니다 — UNIT_TO_WON 을 확인하세요.`);
  }
  return u;
}

/** "400.0" → 4000000 (단위 배수 적용). 빈 칸은 0. */
const won = (v, unit) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * unit) : 0;
};

/**
 * @param {Buffer} buf 다운로드한 xlsx
 * @param {{year?: number}} opt
 * @returns {{subsidies: object, vehicles: object, legacy: object, meta: object}}
 */
function parseSubsidyXlsx(buf, opt = {}) {
  return buildFromSheets(readSheets(buf), opt);
}

/**
 * 시트 객체({시트이름: 2차원배열})에서 산출물을 만든다.
 * ★zip 과 분리해 둔 이유: 실패 경로(열 이름 변경·시트 소실·단위 소실)를
 *   **합성 입력으로 확실히** 시험하기 위해서다. xlsx 를 뜯어 고치는 방식은
 *   치환이 실제로 먹었는지 확신할 수 없어 검증을 못 믿게 만든다(실제로 겪음).
 */
function buildFromSheets(sheets, opt = {}) {
  const m = sheets['모델별_지방비'];
  if (!m || m.length < 2) throw new Error("Excel 에 '모델별_지방비' 시트가 없습니다");

  const h = m[0];
  const at = (name) => {
    // 머리글에 단위가 붙어 있으므로 괄호 앞부분으로 맞춘다.
    const norm = (s) => (s || '').replace(/\s/g, '').replace(/\([^)]*\)\s*$/, '');
    const i = h.findIndex((x) => norm(x) === norm(name));
    if (i < 0) throw new Error(`Excel 열 '${name}' 을 찾지 못했습니다`);
    return i;
  };
  const C = {
    id: at('관리번호'), sido: at('시도'), region: at('지역구분'), vtype: at('세부차종'),
    model: at('모델명'), maker: at('제조사'),
    national: at('국비'), local: at('지방비'), total: at('총지원금'),
    support: at('지원여부'),
    // ★2026-08-18 추가 — 전환지원금(내연기관 폐차·수출말소 시 추가)과 차량 제원.
    //   조건부 금액이라 화면에서 **반드시 조건과 함께** 써야 한다(정부 안내 확인:
    //   "내연기관 차량 폐차·수출말소 — 해당 시 추가 지원금 지원", 증빙서류 필요).
    convNational: at('전환지원금 국비'), convLocal: at('전환지원금 지방비'),
    convTotal: at('전환 포함 총액'),
    battery: at('배터리'), range: at('주행거리'),
  };
  const unit = resolveMoneyUnit(sheets, h[C.local]);

  const timestamp = new Date().toISOString();
  const regions = {};
  const vehicles = {};
  const nationalSeen = new Map();   // 국비는 전국 공통이어야 한다 — 어긋나면 알린다
  const nationalConflicts = [];
  let year = opt.year;

  for (const r of m.slice(1)) {
    const id = String(r[C.id] || '');
    const [y, code] = id.split('-');
    if (!code) continue;
    if (!year && y) year = Number(y);
    if ((r[C.support] || '').trim() && (r[C.support] || '').trim() !== '지원') continue;

    const maker = (r[C.maker] || '').trim();
    const model = (r[C.model] || '').trim();
    if (!model) continue;
    const key = `${maker}___${model}`;

    const national = won(r[C.national], unit);
    const local = won(r[C.local], unit);
    const total = won(r[C.total], unit);
    const convNational = won(r[C.convNational], unit);
    const convLocal = won(r[C.convLocal], unit);
    const convTotal = won(r[C.convTotal], unit);
    const type = (r[C.vtype] || '').trim();
    const battery = (r[C.battery] || '').trim();
    const range = (r[C.range] || '').trim();

    if (!regions[code]) {
      regions[code] = {
        parentName: (r[C.sido] || '').trim(),
        localName: (r[C.region] || '').trim(),
        code: Number(code),
        success: true,
        subsidies: {},
        _vehicles: {},
      };
    }
    // 예전 산출물과 같은 모양: 지역별 subsidies 는 **지방비만** 담는다.
    regions[code].subsidies[key] = local;
    regions[code]._vehicles[key] = {
      type, manufacturer: maker, model, national, local, total,
      convLocal, convTotal,          // 전환지원금 지방비 · 전환 포함 총액 (지역마다 다름)
    };

    // 전환지원금 국비·제원은 전국 공통이라 vehicles 쪽에 한 번만 싣는다.
    if (!vehicles[key]) vehicles[key] = { type, manufacturer: maker, model, national, convNational, battery, range };
    if (nationalSeen.has(key) && nationalSeen.get(key) !== national) {
      if (nationalConflicts.length < 10) nationalConflicts.push(`${key}: ${nationalSeen.get(key)} vs ${national}`);
    } else nationalSeen.set(key, national);
  }

  const codes = Object.keys(regions);
  const legacyData = codes.map((c) => {
    const r = regions[c];
    return {
      parentName: r.parentName, localName: r.localName, code: r.code,
      vehicles: r._vehicles, success: true, attempts: 1, timestamp,
    };
  });
  for (const c of codes) delete regions[c]._vehicles;

  const head = { year, timestamp, total_regions: codes.length, success_count: codes.length, failed_count: 0 };
  return {
    subsidies: { ...head, regions },
    vehicles: { year, timestamp, total_vehicles: Object.keys(vehicles).length, vehicles },
    legacy: { ...head, data: legacyData },
    meta: { unit, unitName: Object.keys(UNIT_TO_WON).find((k) => UNIT_TO_WON[k] === unit), nationalConflicts },
  };
}

module.exports = { parseSubsidyXlsx, buildFromSheets, resolveMoneyUnit, UNIT_TO_WON };
