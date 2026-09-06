#!/usr/bin/env node
/**
 * data/quota-detail-history.json (통짜) → data/detail-history/{code}.json 시드.
 *
 * ★왜 필요한가: 스크래퍼는 **앞으로의 변경만** 지역별 파일에 쌓는다. 그러면 화면의
 *   "N일째 변동 없음" 이 오늘부터 쌓인 것만 보게 되어, 이미 8/17 에 바뀐 양주시가
 *   여전히 "14일째" 로 남는다. 통짜에 3,983건이 이미 있으므로 한 번 갈라 넣는다.
 * ★한 번만 돌린다. 이후는 스크래퍼가 이어 쓴다(같은 스키마·같은 규칙).
 * ★숫자 필드는 뺀다 — 스크래퍼의 KEEP 집합과 **반드시 같아야** 한다.
 *   다르면 시드분과 이후분의 성격이 갈려 판정이 날짜에 따라 튄다.
 */
const fs = require('fs').promises;

const KEEP = new Set(['status', 'deadline', 'note', 'applyMethod', 'dept', 'tel', 'noticeKinds', 'noticeCount']);

async function main() {
  const dry = !process.argv.includes('--commit');
  const src = JSON.parse(await fs.readFile('data/quota-detail-history.json', 'utf8'));
  const year = src.year;
  /* ★대량 배치(같은 타임스탬프에 30지역 초과)는 파서 아티팩트다 — 제외한다.
     실측: 2026-08-17T15:41:04 에 161개 지역 전부의 deadline 이 바뀌었고
     72건은 포맷만 추가된 것이었다(`2026-08-07 → 2026-08-07 18:00`).
     안 거르면 아무것도 안 바뀐 119곳이 "8/17 에 바뀜" 이라고 말한다.
     ★스크래퍼의 ARTIFACT_REGIONS 와 **같은 임계**를 써야 한다 —
       다르면 시드분과 이후분의 판정 기준이 갈린다. */
  const ARTIFACT_REGIONS = 30;
  const perTs = {};
  for (const c of src.changes || []) {
    if (!KEEP.has(c.field)) continue;
    (perTs[c.date] ||= new Set()).add(String(c.code));
  }
  const artifactTs = new Set(Object.entries(perTs).filter(([, s]) => s.size > ARTIFACT_REGIONS).map(([k]) => k));
  if (artifactTs.size) console.log(`⚠️ 파서 아티팩트로 판정해 제외: ${[...artifactTs].join(', ')}`);

  const byCode = {};
  for (const c of src.changes || []) {
    if (!KEEP.has(c.field)) continue;
    if (artifactTs.has(c.date)) continue;
    if (Number(String(c.date).slice(0, 4)) !== year) continue;
    const code = String(c.code || '').replace(/[^0-9]/g, '');
    if (!code) continue;
    (byCode[code] ||= []).push({
      date: c.date, field: c.field,
      before: String(c.before ?? '').slice(0, 200),
      after: String(c.after ?? '').slice(0, 200),
    });
  }
  const codes = Object.keys(byCode);
  console.log(`📦 통짜 ${src.changes.length}건 → 대상 필드 ${codes.reduce((n, c) => n + byCode[c].length, 0)}건 · ${codes.length}지역`);

  let written = 0;
  for (const code of codes) {
    /* 최신이 위로 — 스크래퍼가 unshift 하는 것과 같은 방향 */
    const history = byCode[code].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
    const body = JSON.stringify({ code, lastUpdated: src.lastUpdated || '', history });
    if (dry) { if (written < 3) console.log(`   [dry] ${code} ${history.length}건 · 최신 ${history[0].date.slice(0, 10)} ${history[0].field}`); }
    else { await fs.mkdir('data/detail-history', { recursive: true }); await fs.writeFile(`data/detail-history/${code}.json`, body); }
    written++;
  }
  console.log(dry ? `\n🔍 dry-run — ${written}개 파일을 쓸 예정. 실제로 쓰려면 --commit` : `\n💾 ${written}개 파일 기록`);
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
