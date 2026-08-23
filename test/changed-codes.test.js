#!/usr/bin/env node
/**
 * 변경 감지 회귀 테스트 — 합성 환경.
 *
 * ★왜 합성인가: 실제 변경을 기다리면 "변경이 없던 날" 에는 검증 자체가 안 된다.
 *   그리고 우리가 고친 버그들(공고 계열 누락·고성군 코드 뒤바뀜)은 **드물게** 일어나서
 *   실환경 관찰로는 몇 주가 걸린다.
 * ★실제 배포 코드(src/changed-codes.js)를 그대로 부른다. 사본을 두지 않는다.
 * ★입력은 git HEAD 의 실제 데이터다 — 손으로 만든 가짜 스키마로 통과시키지 않기 위해.
 *
 * 실행: node test/changed-codes.test.js
 */
const { execSync } = require('child_process');
const { computeChangedCodes, auxChangedCodes } = require('../src/changed-codes');

const read = (f) => JSON.parse(execSync(`git show HEAD:${f}`, { maxBuffer: 1e9 }));
const clone = (o) => JSON.parse(JSON.stringify(o));
const AUX = ['quota-detail', 'notice-schedule', 'notice-links', 'change-history'];

const quota = read('data/quota.json');
const aux = {}; for (const f of AUX) { try { aux[f] = read(`data/${f}.json`); } catch { aux[f] = null; } }

/* keyToCode — 본체(scraper-quota.js)가 만드는 것과 같은 방식.
   quota.json 의 sido+region 조합에서 코드를 역으로 얻는다(donut 호출 없이 테스트하려고). */
const keyToCode = {};
{
  const detail = aux['quota-detail']?.regions || {};
  for (const [code, d] of Object.entries(detail)) keyToCode[`${d.sido || ''}\t${d.region || ''}`] = code;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const msg = fn();
    if (msg === true) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}\n       ${msg}`); fail++; }
  } catch (e) { console.log(`  ❌ ${name}\n       예외: ${e.message}`); fail++; }
}
const rowOf = (q, sido, region) => q.data[0].quotaData.find(r => r.sido === sido && r.region === region);
const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('\n■ quota 기반 변경 감지');

t('변경이 없으면 통보 0곳 (웹훅 발사 안 함)', () => {
  const { codes } = computeChangedCodes(quota, clone(quota), keyToCode);
  return codes.length === 0 || `codes=${codes}`;
});

t('서울 잔여만 바뀌면 서울만', () => {
  const n = clone(quota); rowOf(n, '서울', '서울특별시').remaining_total += 5;
  const { codes } = computeChangedCodes(quota, n, keyToCode);
  return eq(codes, ['1100']) || `codes=${codes}`;
});

t('★강원 고성군만 바뀌면 4282 (경남 4882 아님)', () => {
  const n = clone(quota); rowOf(n, '강원', '고성군').remaining_total += 7;
  const { codes } = computeChangedCodes(quota, n, keyToCode);
  return eq(codes, ['4282']) || `codes=${codes} — 이름만 키로 쓰면 4882 가 나온다`;
});

t('★경남 고성군만 바뀌면 4882 (강원 4282 아님)', () => {
  const n = clone(quota); rowOf(n, '경남', '고성군').remaining_total += 7;
  const { codes } = computeChangedCodes(quota, n, keyToCode);
  return eq(codes, ['4882']) || `codes=${codes}`;
});

t('두 고성군이 동시에 바뀌면 둘 다', () => {
  const n = clone(quota);
  rowOf(n, '강원', '고성군').remaining_total += 1; rowOf(n, '경남', '고성군').remaining_total += 1;
  const { codes } = computeChangedCodes(quota, n, keyToCode);
  return eq(codes, ['4282', '4882']) || `codes=${codes}`;
});

t('최초 실행(이전값 없음)은 전 지역', () => {
  const { codes } = computeChangedCodes(null, quota, keyToCode);
  return codes.length >= 160 || `codes=${codes.length}곳 — 전 지역이어야 한다`;
});

console.log('\n■ 공고 계열(부가 파일) 변경 감지 — 구 로직이 통째로 놓치던 것');

t('quota 는 그대로, status 만 바뀌면 그 지역이 잡힌다', () => {
  const n = clone(aux); const code = Object.keys(n['quota-detail'].regions)[0];
  /* ★고정값을 넣으면 안 된다 — 서울은 이미 status:'마감' 이라 '마감' 을 넣으면 무변경이다
     (첫 시도에서 이걸로 오탐이 났다). 반드시 **현재값과 다른 값**으로 뒤집는다. */
  const cur = n['quota-detail'].regions[code].status;
  n['quota-detail'].regions[code].status = cur === '접수중' ? '마감' : '접수중';
  const extra = auxChangedCodes(aux, n);
  return eq(extra, [code]) || `extra=${extra} (기대 ${code}, 현재 status=${cur})`;
});

t('deadline 만 바뀌어도 잡힌다', () => {
  const n = clone(aux); const code = Object.keys(n['quota-detail'].regions)[2];
  n['quota-detail'].regions[code].deadline = '2026-12-31 18:00';
  return eq(auxChangedCodes(aux, n), [code]) || '못 잡음';
});

t('접수 안내(note) 만 바뀌어도 잡힌다', () => {
  const n = clone(aux); const code = Object.keys(n['quota-detail'].regions)[3];
  n['quota-detail'].regions[code].note = '테스트 변경';
  return eq(auxChangedCodes(aux, n), [code]) || '못 잡음';
});

t('공고문 첨부(notice-links) 만 바뀌어도 잡힌다', () => {
  const n = clone(aux); const code = Object.keys(n['notice-links'].regions)[5];
  n['notice-links'].regions[code].files.push({ gubun: 'Z', name: '테스트.hwp', ext: 'hwp', kind: '공고문', url: 'x' });
  return eq(auxChangedCodes(aux, n), [code]) || '못 잡음';
});

t('공고 일정(notice-schedule) 만 바뀌어도 잡힌다 — items 키가 code|kind 인 파일', () => {
  const n = clone(aux); const k = Object.keys(n['notice-schedule'].items)[0];
  const code = k.split('|')[0];
  n['notice-schedule'].items[k].start = '2026-12-01 09:00';
  return eq(auxChangedCodes(aux, n), [code]) || `못 잡음 (키 ${k})`;
});

t('여러 파일이 서로 다른 지역에서 바뀌면 합집합', () => {
  const n = clone(aux);
  const a = Object.keys(n['quota-detail'].regions)[10];
  const b = Object.keys(n['notice-links'].regions)[20];
  const cur = n['quota-detail'].regions[a].status;
  n['quota-detail'].regions[a].status = cur === '접수중' ? '마감' : '접수중';   /* 현재값과 다르게 */
  n['notice-links'].regions[b].files = [];
  return eq(auxChangedCodes(aux, n), [a, b]) || '합집합 아님';
});

console.log('\n■ 폭탄 방지 — 수집 실패본이 "전 지역 변경" 으로 둔갑하지 않아야 한다');

t('available:false 면 그 파일은 판정 보류 (161곳 폭탄 방지)', () => {
  const n = clone(aux); n['quota-detail'] = { available: false, missing: ['x'], regions: {} };
  const extra = auxChangedCodes(aux, n);
  return extra.length === 0 || `${extra.length}곳이 잡혔다 — 폭탄`;
});

t('regions 가 빈 객체여도 판정 보류', () => {
  const n = clone(aux); n['quota-detail'] = { available: true, regions: {} };
  return auxChangedCodes(aux, n).length === 0 || '폭탄';
});

t('이전값이 없으면(최초) 판정 보류 — 전 지역 통보 방지', () => {
  const prev = { 'quota-detail': null, 'notice-schedule': null, 'notice-links': null, 'change-history': null };
  return auxChangedCodes(prev, aux).length === 0 || '최초 실행에 전 지역이 잡혔다';
});

t('파일 자체가 없어도(null) 예외 없이 0곳', () => {
  return auxChangedCodes({}, {}).length === 0 || '예외/오탐';
});

t('변경이 없으면 0곳', () => {
  return auxChangedCodes(aux, clone(aux)).length === 0 || '오탐';
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
