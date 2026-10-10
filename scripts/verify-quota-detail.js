#!/usr/bin/env node
/**
 * 적대검증 — 부가 필드 파서.
 *
 * 핵심 주장 두 가지를 공격한다:
 *   ① 열이 사라져도 **던지지 않고** 사유를 남기는가 (본체를 안 죽이는가)
 *   ② 조용히 넘어가지는 **않는가** (missing 이 실제로 채워지는가)
 * 그리고 diff 가 '바뀐 것만' 잡는지, 안 바뀐 걸 잡지는 않는지.
 *
 * 사용: node scripts/verify-quota-detail.js <xlsx>
 */
const fs = require('fs');
const { readSheets } = require('../src/parse-quota-xlsx');
const { parseQuotaDetail, diffDetail, FIELDS } = require('../src/parse-quota-detail');

const xlsx = process.argv[2];
let fail = 0;
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const ok = (m) => console.log('   ✅ ' + m);

// ── 합성 입력 — 실패 경로를 확실히 주입하기 위해(xlsx 치환은 못 믿는다)
const HDR = ['관리번호', '기준년도', '시도', '지역구분', '차종', '세부차종', '접수방법', '접수상태',
  '공고종류', '공고건수', '최종 신청마감', '공고대수(전체)', '접수대수(전체)', '선정대수(전체)',
  '출고대수(전체)', '선정잔여(전체)', '출고잔여(전체)', '접수율(%)', '선정률(%)', '출고율(%)',
  '예산소진율(%)', '잔여예산비율(%)', '담당부서', '연락처', '비고'];
const ROW = (over = {}) => {
  const r = ['2026-1100', '2026', '서울', '서울특별시', '전기승용', '전기승용', '*일반: 출고등록순', '마감',
    '본공고', '3.0', '2026-08-07', '15430.0', '15404.0', '14641.0', '13665.0', '789.0', '1765.0',
    '100.0', '95.0', '89.0', '95.0', '5.0', '서울시 친환경차량과', '02-0000-0000', '메모'];
  for (const [i, v] of Object.entries(over)) r[i] = v;
  return r;
};
const sheets = (hdr = HDR, rows = [ROW()]) => ({ 요약: [hdr.slice(), ...rows] });

console.log('── 1) 합성 정상 입력이 옳은 값을 내는가 (이게 안 되면 아래가 무의미)');
{
  const d = parseQuotaDetail(sheets());
  const r = d.regions['1100'];
  if (!d.available) bad('available=false');
  else if (d.missing.length) bad(`missing 이 비어 있어야 하는데: ${d.missing.join(', ')}`);
  else if (r.status !== '마감' || r.selected !== 14641 || r.selectedRemaining !== 789
    || r.tel !== '02-0000-0000' || r.applyMethod !== '*일반: 출고등록순') bad(`값이 틀림: ${JSON.stringify(r)}`);
  else ok(`12필드 정상 · 접수상태=마감 · 선정 14641 · 연락처 그대로 보존(더미도 가공 안 함)`);
}

console.log('\n── 2) ★열이 사라져도 던지지 않는가 (본체를 안 죽이는가)');
for (const col of ['연락처', '담당부서', '접수상태', '예산소진율(%)']) {
  const h = HDR.map((x) => (x === col ? `${col}_변경됨` : x));
  let threw = null, d = null;
  try { d = parseQuotaDetail(sheets(h)); } catch (e) { threw = e.message; }
  if (threw) bad(`'${col}' 열 변경에서 던졌다 — 부가 필드가 본체를 죽인다: ${threw}`);
  else if (!d.available) bad(`'${col}' 열 변경으로 available=false 가 됐다 (과잉 반응)`);
  else if (!d.missing.some((m) => m.includes(col))) bad(`'${col}' 이 missing 에 안 남았다 — 조용한 실패`);
  else ok(`'${col}' 사라짐 → 던지지 않고 missing 기록, 나머지 ${d.fields.length}필드는 정상 수집`);
}

console.log('\n── 3) 시트 자체가 없으면');
{
  const d = parseQuotaDetail({});
  if (d.available !== false) bad('시트 없음인데 available=true');
  else if (!d.missing.length) bad('시트 없음인데 사유가 없다');
  else ok(`available=false + 사유 "${d.missing[0]}"`);
}
{
  const h = HDR.map((x) => (x === '관리번호' ? '번호' : x));
  const d = parseQuotaDetail(sheets(h));
  if (d.available !== false) bad("'관리번호' 가 없는데 available=true — 지역 식별 불가인데 진행했다");
  else ok('관리번호 소실 → available=false (지역을 못 가르면 데이터가 무의미하므로 옳다)');
}

console.log('\n── 4) 변경 이력 diff');
{
  const prev = parseQuotaDetail(sheets());
  const next = parseQuotaDetail(sheets(HDR, [ROW({ 7: '접수중', 13: '14700.0' })]));
  const ch = diffDetail(prev, next, '2026-08-17');
  const keys = ch.map((c) => c.field).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['selected', 'status'])) bad(`바뀐 필드만 잡아야 하는데: ${JSON.stringify(keys)}`);
  else ok(`바뀐 2필드만 기록: ${ch.map((c) => `${c.field} ${c.before}→${c.after}`).join(' / ')}`);

  const none = diffDetail(prev, parseQuotaDetail(sheets()), '2026-08-17');
  if (none.length) bad(`안 바뀌었는데 ${none.length}건을 잡았다 — 이력이 매 10분마다 부풀어 오른다`);
  else ok('변화 없으면 0건 (10분마다 헛 이력이 안 쌓인다)');

  // 새 필드를 추가해도 과거 이력이 '변경' 으로 폭발하지 않아야 한다
  const prevNoTel = JSON.parse(JSON.stringify(prev));
  for (const r of Object.values(prevNoTel.regions)) delete r.tel;
  const added = diffDetail(prevNoTel, next, '2026-08-17');
  if (added.some((c) => c.field === 'tel')) bad('이전에 없던 필드를 변경으로 잡았다 — 필드 추가 시 전 지역이 변경으로 폭발한다');
  else ok('이전에 없던 필드는 변경으로 안 잡음 (필드 추가가 이력을 오염 안 시킴)');
}

if (xlsx && fs.existsSync(xlsx)) {
  console.log('\n── 5) 실제 Excel 로');
  const d = parseQuotaDetail(readSheets(fs.readFileSync(xlsx)));
  console.log(`   지역 ${d.regionCount} · 필드 ${d.fields.length}/${FIELDS.length} · missing ${d.missing.length}건`);
  if (!d.available) bad('실제 파일에서 available=false');
  if (d.missing.length) bad(`실제 파일에서 못 찾은 열: ${d.missing.join(' / ')}`);
  if (d.regionCount !== 161) bad(`지역 수가 161 이 아님: ${d.regionCount}`);
  const empty = Object.entries(d.regions).filter(([, r]) => !r.status || !r.dept);
  if (empty.length) bad(`핵심 값이 빈 지역 ${empty.length}곳`);
  if (d.available && !d.missing.length && d.regionCount === 161 && !empty.length) {
    const s = d.regions['1100'];
    ok(`161지역 전부 채움 · 서울: ${s.status} / 마감 ${s.deadline} / 선정 ${s.selected} / ${s.dept} ${s.tel}`);
    const size = JSON.stringify({ ...d }).length;
    console.log(`   파일 크기(비압축): ${(size / 1024).toFixed(0)}KB  ← quota.json 285KB 와 별개`);
  }
}

console.log('\n' + (fail ? `❌ ${fail}건 실패` : '✅ 전부 통과'));
process.exit(fail ? 1 : 0);
