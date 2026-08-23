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
const { computeChangedCodes, auxChangedCodes, auxFingerprint, buildKeyToCode } = require('../src/changed-codes');

const read = (f) => JSON.parse(execSync(`git show HEAD:${f}`, { maxBuffer: 1e9 }));
const clone = (o) => JSON.parse(JSON.stringify(o));
const AUX = ['quota-detail', 'notice-schedule', 'notice-links', 'change-history'];

const quota = read('data/quota.json');
const aux = {}; for (const f of AUX) { try { aux[f] = read(`data/${f}.json`); } catch { aux[f] = null; } }

/* ★keyToCode 는 **본체가 쓰는 그 함수**로 만든다(buildKeyToCode).
   예전엔 테스트가 자기 방식으로 만들었는데, 그러면 본체 배선을 예전(이름만)으로 되돌려도
   테스트가 17/17 초록불이고 프로덕션만 영구히 0곳이 된다(적대적 검증이 실제로 재현).
   donut 을 네트워크로 부르지 않으려고 그 응답 형태({parentName, localName, code})를
   quota-detail 에서 합성한다 — 형태만 흉내내고 **키 생성은 본체 코드가 한다.** */
const donutLike = Object.entries(aux['quota-detail']?.regions || {})
  .map(([code, d]) => ({ parentName: d.sido || '', localName: d.region || '', code }));
const keyToCode = buildKeyToCode(donutLike);

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

console.log('\n■ 공고 계열 — 저장된 기준선과 비교 (구 로직이 통째로 놓치던 것)');

/* 헬퍼: 기준선 = 현재 상태의 지문. 거기서 무엇을 바꾸면 잡히는지 본다. */
const base = auxFingerprint(aux);
const changed = (mutate) => { const n = clone(aux); mutate(n); return auxChangedCodes(base, n).codes; };

t('변경이 없으면 0곳', () => changed(() => {}).length === 0 || '오탐');

t('status 만 바뀌면 그 지역이 잡힌다', () => {
  const code = Object.keys(aux['quota-detail'].regions)[0];
  return eq(changed(n => {
    /* ★고정값을 넣으면 안 된다 — 서울은 이미 status:'마감' 이라 무변경이 된다(첫 시도에서 오탐) */
    const cur = n['quota-detail'].regions[code].status;
    n['quota-detail'].regions[code].status = cur === '접수중' ? '마감' : '접수중';
  }), [code]) || '못 잡음';
});

t('deadline 만 바뀌어도 잡힌다', () => {
  const code = Object.keys(aux['quota-detail'].regions)[2];
  return eq(changed(n => { n['quota-detail'].regions[code].deadline = '2026-12-31 18:00'; }), [code]) || '못 잡음';
});

t('접수 안내(note) 만 바뀌어도 잡힌다', () => {
  const code = Object.keys(aux['quota-detail'].regions)[3];
  return eq(changed(n => { n['quota-detail'].regions[code].note = '테스트 변경'; }), [code]) || '못 잡음';
});

t('★공고문 첨부(notice-links) 만 바뀌어도 잡힌다 — 별도 워크플로가 쓰는 파일', () => {
  const code = Object.keys(aux['notice-links'].regions)[5];
  return eq(changed(n => {
    n['notice-links'].regions[code].files.push({ gubun: 'Z', name: '테스트.hwp', ext: 'hwp', kind: '공고문', url: 'x' });
  }), [code]) || '못 잡음 — 기준선 방식의 존재 이유가 이것이다';
});

t('공고 일정(notice-schedule) 만 바뀌어도 잡힌다 — items 키가 code|kind', () => {
  const k = Object.keys(aux['notice-schedule'].items)[0];
  return eq(changed(n => { n['notice-schedule'].items[k].start = '2026-12-01 09:00'; }), [k.split('|')[0]]) || '못 잡음';
});

t('여러 파일이 서로 다른 지역에서 바뀌면 합집합', () => {
  const a = Object.keys(aux['quota-detail'].regions)[10];
  const b = Object.keys(aux['notice-links'].regions)[20];
  return eq(changed(n => {
    const cur = n['quota-detail'].regions[a].status;
    n['quota-detail'].regions[a].status = cur === '접수중' ? '마감' : '접수중';
    n['notice-links'].regions[b].files = [];
  }), [a, b]) || '합집합 아님';
});

console.log('\n■ 폭탄 방지 — 한 번에 161곳이 나가면 안 된다');

t('★지문에 없는 필드를 추가해도 0곳 (화이트리스트라 스키마 변경에 면역)', () => {
  const c = changed(n => { for (const r of Object.values(n['quota-detail'].regions)) r.newField = 1; });
  return c.length === 0 || `${c.length}곳 — 파서가 필드 하나 늘리면 161발이 나간다`;
});

t('★키 순서만 뒤집어도 0곳', () => {
  const c = changed(n => {
    for (const [code, r] of Object.entries(n['quota-detail'].regions)) {
      n['quota-detail'].regions[code] = Object.fromEntries(Object.entries(r).reverse());
    }
  });
  return c.length === 0 || `${c.length}곳 — 객체 통째 비교의 병`;
});

t('★notice-links 의 stale 플래그가 붙었다 떨어져도 0곳 (신안군 27h 19회 진동)', () => {
  const c = changed(n => { for (const r of Object.values(n['notice-links'].regions)) for (const f of r.files || []) f.stale = true; });
  return c.length === 0 || `${c.length}곳 — 잡음이 통보가 된다`;
});

t('★available:false 는 그 파일을 통째로 무시 (stale regions 가 남아 있어도)', () => {
  /* 검증 지적: 기존 테스트는 regions:{} 를 같이 넣어 **빈 객체 경로**만 밟았다.
     가드만 지워도 17/17 초록불이었다. 여기서는 regions 를 채운 채 available:false 로 둔다. */
  const c = changed(n => {
    n['quota-detail'].available = false;
    for (const r of Object.values(n['quota-detail'].regions)) r.status = '테스트';
  });
  return c.length === 0 || `${c.length}곳 — 수집 실패본이 통보가 된다`;
});

t('regions 가 빈 객체여도 0곳', () => {
  const c = changed(n => { n['quota-detail'] = { available: true, regions: {} }; });
  return c.length === 0 || '폭탄';
});

t('기준선이 없으면(최초) 0곳 — 전 지역 통보 방지', () => {
  return auxChangedCodes(null, aux).codes.length === 0 || '최초 실행에 전 지역이 잡혔다';
});

t('기준선이 빈 객체여도 0곳', () => {
  return auxChangedCodes({}, aux).codes.length === 0 || '폭탄';
});

t('파일이 통째로 없어도 예외 없이 0곳', () => {
  return auxChangedCodes(base, {}).codes.length === 0 || '예외/오탐';
});

t('기준선에 없던 지역이 생기면 통보하지 않는다 (판단 보류)', () => {
  /* 변이 실험 ⑧ 이 안 잡혀서 동작을 고정한다. 기준선에 없는 지역을 '변경' 으로 보면,
     기준선이 부분적으로만 쓰인 상황에서 수십 곳이 한꺼번에 나갈 수 있다.
     진짜 신규 지역은 다음 런에 기준선이 생기고 그 뒤 변경부터 잡힌다. */
  const partial = {}; const keys = Object.keys(base).slice(0, 100);
  for (const k of keys) partial[k] = base[k];
  const c = auxChangedCodes(partial, aux).codes;
  return c.length === 0 || `${c.length}곳 — 기준선에 없는 지역이 통보됐다`;
});

t('★기준선에 없던 출처가 생겨도 0곳 — 장애 중 기준선이 쓰인 뒤 복구되는 경우', () => {
  /* 변이 실험에서 이 경로가 안 잡혔다. `old[src] !== undefined` 가드를 빼면
     복구 런에서 161곳이 통째로 나간다 — 우리가 없애려던 폭탄이다. */
  const partial = {};
  for (const [code, parts] of Object.entries(base)) { const { d, ...rest } = parts; partial[code] = rest; }
  const c = auxChangedCodes(partial, aux).codes;
  return c.length === 0 || `${c.length}곳 — 기준선에 없던 출처를 '변경' 으로 읽는다`;
});

t('기준선 병합 — 이번 런에 실패한 출처는 옛 조각을 물려받는다', () => {
  const n = clone(aux); n['quota-detail'] = { available: false, regions: {} };
  const { fingerprint } = auxChangedCodes(base, n);
  const code = Object.keys(base)[0];
  return fingerprint[code]?.d === base[code].d || '실패한 출처의 기준선이 지워졌다 — 복구 시 전 지역 통보';
});

t('지문은 다음 비교를 위해 항상 반환된다', () => {
  const { fingerprint } = auxChangedCodes(base, aux);
  return Object.keys(fingerprint).length >= 160 || `지문 ${Object.keys(fingerprint).length}곳`;
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
