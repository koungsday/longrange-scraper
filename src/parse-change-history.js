/**
 * 환경부 Excel 「변경이력」 시트 → 지역별 신청기간 변경 이력.
 *
 * ★왜 이게 값이 되는가 (2026-08-18 적대검증)
 *   1,237건 / 161지역 / 최근 30일에도 160건 — 살아있는 데이터다.
 *   그중 **마감을 앞당긴 것이 284건, 미룬 것이 136건** — 조기마감이 두 배다.
 *   "이 지역은 마감을 앞당긴 적이 있다"는 구매자가 실제로 알아야 할 위험 신호이고,
 *   우리가 자체 구축한 note-history(비고 텍스트 diff)보다 정확하다 —
 *   무엇이·언제·무엇에서 무엇으로 바뀌었는지가 구조화되어 있다.
 *
 * ★범위 한계를 숨기지 않는다. 안내 시트 원문:
 *     "변경이력 — 신청기간 변경분만 제공 · 이력 스냅샷 연속 비교 결과이며
 *      마지막 상태는 현재값 기준"
 *   즉 대수·금액 변경은 여기 없다. 신청기간(접수시작·접수마감)뿐이다.
 *
 * ★변경자(담당자 ID)는 싣지 않는다 — 공무원 식별자이고 우리 쓸 곳이 없다.
 */

const KEYS = ['관리번호', '지역', '변경일시', '변경 항목', '변경 전', '변경 후'];

const norm = (s) => (s || '').replace(/\s/g, '');

/**
 * @param {Record<string,string[][]>} sheets readSheets() 결과
 * @returns {{available:boolean, timestamp:string, count:number, missing:string[], regions:object}}
 */
function parseChangeHistory(sheets) {
  const timestamp = new Date().toISOString();
  const s = sheets && sheets['변경이력'];
  if (!Array.isArray(s) || s.length < 2) {
    return { available: false, timestamp, count: 0, missing: ["'변경이력' 시트가 없거나 비어 있음"], regions: {} };
  }
  const h = s[0];
  const at = (n) => h.findIndex((x) => norm(x) === norm(n));
  const idx = {};
  const missing = [];
  for (const k of KEYS) {
    const i = at(k);
    if (i < 0) missing.push(`'${k}' 열 없음`);
    else idx[k] = i;
  }
  // 관리번호·변경일시·변경 항목이 없으면 이력을 식별할 수 없다 — 그때만 포기한다.
  if (idx['관리번호'] === undefined || idx['변경일시'] === undefined || idx['변경 항목'] === undefined) {
    return { available: false, timestamp, count: 0, missing, regions: {} };
  }

  const regions = {};
  let count = 0;
  for (const r of s.slice(1)) {
    const id = String(r[idx['관리번호']] || '');
    const code = id.split('-')[1];
    if (!code) continue;
    const when = String(r[idx['변경일시']] || '').trim();
    const item = String(r[idx['변경 항목']] || '').trim();
    if (!when || !item) continue;

    const before = idx['변경 전'] !== undefined ? String(r[idx['변경 전']] || '').trim() : '';
    const after = idx['변경 후'] !== undefined ? String(r[idx['변경 후']] || '').trim() : '';

    if (!regions[code]) {
      regions[code] = { region: idx['지역'] !== undefined ? String(r[idx['지역']] || '').trim() : '', items: [] };
    }
    regions[code].items.push({ when, item, before, after });
    count++;
  }

  // 지역마다 최신순으로 정렬하고 요약을 붙인다 — 화면이 매번 계산하지 않게.
  for (const v of Object.values(regions)) {
    v.items.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    v.summary = summarize(v.items);
  }

  return { available: true, timestamp, count, missing, regions };
}

/**
 * 지역 한 곳의 이력 → 화면이 바로 쓸 요약.
 * ★"앞당김"만 센다. 미룬 것(연장)은 구매자에게 나쁜 소식이 아니라 신호가 아니다.
 */
function summarize(items) {
  let earlier = 0;      // 마감을 앞당긴 횟수
  let later = 0;        // 마감을 미룬 횟수
  let lastEarlier = ''; // 가장 최근 앞당김
  for (const it of items) {
    if (!/마감/.test(it.item)) continue;
    if (!it.before || !it.after) continue;   // 최초 등록(빈 값 → 날짜)은 변경이 아니다
    if (it.after < it.before) { earlier++; if (!lastEarlier) lastEarlier = it.when; }
    else if (it.after > it.before) later++;
  }
  return {
    total: items.length,
    earlier,
    later,
    lastChanged: items.length ? items[0].when : '',
    lastEarlier,
  };
}

/** 이전 수집분과 비교해 새로 생긴 이력만. 알림에 쓴다. */
function diffHistory(prev, next) {
  const out = { added: [], total: 0 };
  if (!next || !next.regions) return out;
  const seen = new Set();
  if (prev && prev.regions) {
    for (const [code, v] of Object.entries(prev.regions)) {
      for (const it of v.items || []) seen.add(code + '|' + it.when + '|' + it.item);
    }
  }
  for (const [code, v] of Object.entries(next.regions)) {
    for (const it of v.items || []) {
      if (seen.has(code + '|' + it.when + '|' + it.item)) continue;
      out.added.push({ code, region: v.region, ...it });
    }
  }
  // 최초 수집이면 전부 '신규'라 알릴 것이 아니다 — 호출부가 prev 없음을 보고 판단한다.
  out.total = out.added.length;
  return out;
}

module.exports = { parseChangeHistory, diffHistory, summarize };
