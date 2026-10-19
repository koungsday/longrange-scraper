/**
 * 환경부 Excel 「요약」 시트의 **부가 필드** → data/quota-detail.json
 *
 * ★왜 별도 파일인가
 *   quota.json 은 **방문자 브라우저가 직접 받는다**(vw-k RegionSubsidyStatus.tsx,
 *   285KB). 거기에 9필드 × 161행을 더하면 방문자 대역폭이 그만큼 늘어난다.
 *   이 데이터는 리뉴얼 때나 쓸 것이므로 지금은 조용히 옆에 쌓아 둔다.
 *
 * ★★부가 필드는 절대 던지지 않는다 (핵심 설계)
 *   quota·모델 보조금 파서는 열을 못 찾으면 던진다 — 그게 옳다. 잘못된 숫자를
 *   배포하느니 멈추는 게 낫다.
 *   그러나 이 파일은 **부가**다. '연락처' 열 이름이 바뀌었다고 잔여대수 수집
 *   전체가 멈추면 손해가 훨씬 크다. 그래서 여기서는:
 *     · 못 찾은 열은 값을 비우고 `missing` 에 이유를 남긴다
 *     · 시트 자체가 없으면 available:false 로 돌려주고 끝낸다
 *   ★대신 **조용히 넘어가지는 않는다.** missing 은 파일에 남고 위생 다이제스트가
 *     그걸 본다. 안 보이는 실패가 이번 사고의 본질이었다.
 */

/** 화면에 붙일 때 이름을 다시 정할 수 있으므로, 키는 영문으로 고정해 둔다. */
const FIELDS = [
  { key: 'status', col: '접수상태' },
  { key: 'deadline', col: '최종 신청마감' },
  { key: 'selected', col: '선정대수(전체)', num: true },
  { key: 'selectedRemaining', col: '선정잔여(전체)', num: true },
  { key: 'budgetUsedPct', col: '예산소진율(%)', num: true },
  { key: 'budgetLeftPct', col: '잔여예산비율(%)', num: true },
  { key: 'noticeKinds', col: '공고종류' },
  { key: 'noticeCount', col: '공고건수', num: true },
  { key: 'applyMethod', col: '접수방법' },
  { key: 'dept', col: '담당부서' },
  { key: 'tel', col: '연락처' },
  { key: 'note', col: '비고' },
];

const norm = (s) => (s || '').replace(/\s/g, '');
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * @param {Record<string, string[][]>} sheets  readSheets() 결과
 * @returns {{available: boolean, timestamp: string, missing: string[], fields: string[], regions: object}}
 */
function parseQuotaDetail(sheets) {
  const timestamp = new Date().toISOString();
  const s = sheets && sheets['요약'];
  if (!Array.isArray(s) || s.length < 2) {
    return { available: false, timestamp, missing: ["'요약' 시트가 없거나 비어 있음"], fields: [], regions: {} };
  }
  const h = s[0];
  const idxOf = (col) => h.findIndex((x) => norm(x) === norm(col));

  const id = idxOf('관리번호');
  const sido = idxOf('시도');
  const region = idxOf('지역구분');
  if (id < 0) {
    return { available: false, timestamp, missing: ["'관리번호' 열이 없어 지역을 식별할 수 없음"], fields: [], regions: {} };
  }

  const missing = [];
  const use = [];
  for (const f of FIELDS) {
    const i = idxOf(f.col);
    if (i < 0) missing.push(`'${f.col}' 열을 찾지 못함 (키 ${f.key})`);
    else use.push({ ...f, i });
  }

  const regions = {};
  for (const r of s.slice(1)) {
    const code = String(r[id] || '').split('-')[1];
    if (!code) continue;
    const row = {
      sido: sido >= 0 ? String(r[sido] || '').trim() : '',
      region: region >= 0 ? String(r[region] || '').trim() : '',
    };
    for (const f of use) {
      const raw = r[f.i];
      row[f.key] = f.num ? num(raw) : String(raw ?? '').trim();
    }
    regions[code] = row;
  }

  return {
    available: true,
    timestamp,
    missing,                          // 비어 있어야 정상. 위생 다이제스트가 본다.
    fields: use.map((f) => f.key),
    regionCount: Object.keys(regions).length,
    regions,
  };
}

/**
 * 이전 detail 과 비교해 **바뀐 것만** 변경 이력으로 뽑는다.
 * ★{code, field, before, after} 모양이라 **필드가 늘어도 스키마가 안 바뀐다.**
 *   리뉴얼 때 표현을 바꿔도 과거 이력이 죽지 않게 하려는 것이다.
 */
function diffDetail(prev, next, date) {
  const out = [];
  if (!prev || !prev.regions || !next || !next.regions) return out;
  for (const [code, cur] of Object.entries(next.regions)) {
    const old = prev.regions[code];
    if (!old) continue;                      // 신규 지역은 '변경' 이 아니다
    for (const k of Object.keys(cur)) {
      if (k === 'sido' || k === 'region') continue;
      const a = old[k];
      const b = cur[k];
      if (a === undefined) continue;         // 이전에 없던 필드 = 우리가 추가한 것
      if (String(a ?? '') === String(b ?? '')) continue;
      out.push({ date, code, region: cur.region || '', field: k, before: a ?? null, after: b ?? null });
    }
  }
  return out;
}

module.exports = { parseQuotaDetail, diffDetail, FIELDS };
