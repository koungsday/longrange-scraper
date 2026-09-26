#!/usr/bin/env node
/**
 * 적대검증 — 새 Excel 파서가 옛 HTML 표 파서와 같은 값을 내는가.
 *
 * 기준선 = 개편 직전 마지막 정상 quota.json (2026-08-16 02:01Z, 281,907B, 161행).
 * 비교 대상 = 같은 시점 이후의 Excel 을 파싱한 결과.
 *
 * ★값이 다를 수 있는 정당한 이유가 하나 있다: 기준선과 Excel 사이에 시간이 흘러
 *   접수·출고 대수가 실제로 늘었다. 그래서 "전부 같아야 한다" 로 재면 안 된다.
 *   대신 나눠서 본다.
 *     · 구조(지역 수·코드·이름·차종·필드)      → 완전 일치해야 한다
 *     · 공고대수(quota_*)                      → 공고는 잘 안 바뀐다. 거의 일치해야 한다
 *     · 접수·출고(registered_ 계열, delivered_ 계열) → 단조 증가여야 한다(줄면 이상)
 *   각각을 따로 세고, 어긋난 건은 전부 찍는다.
 *
 * 사용: node scripts/verify-xlsx-parity.js <baseline.json> <download.xlsx>
 */
const fs = require('fs');
const { parseQuotaXlsx } = require('../src/parse-quota-xlsx');

const [, , baselinePath, xlsxPath] = process.argv;
if (!baselinePath || !xlsxPath) {
  console.error('사용: node scripts/verify-xlsx-parity.js <baseline.json> <download.xlsx>');
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).data[0].quotaData;
const now = parseQuotaXlsx(fs.readFileSync(xlsxPath));

let fail = 0;
const bad = (msg) => { fail++; console.log('  ❌ ' + msg); };

console.log('── 1) 구조');
console.log(`   행 수  기준선 ${base.length} · 새 파서 ${now.length}`);
if (base.length !== now.length) bad(`행 수 불일치`);

const key = (r) => `${r.sido}\t${r.region}\t${r.vehicleType}`;
const bKeys = base.map(key), nKeys = now.map(key);
const missing = bKeys.filter((k) => !nKeys.includes(k));
const extra = nKeys.filter((k) => !bKeys.includes(k));
if (missing.length) bad(`새 파서에 없는 지역 ${missing.length}건: ${missing.slice(0, 5).join(' / ')}`);
if (extra.length) bad(`기준선에 없는 지역 ${extra.length}건: ${extra.slice(0, 5).join(' / ')}`);
if (!missing.length && !extra.length) console.log('   ✅ 지역 집합 완전 일치');

const bFields = Object.keys(base[0]).sort();
const nFields = Object.keys(now[0] || {}).sort();
if (JSON.stringify(bFields) !== JSON.stringify(nFields)) {
  bad(`필드 불일치\n      기준선: ${bFields.join(',')}\n      새것  : ${nFields.join(',')}`);
} else console.log(`   ✅ 필드 ${bFields.length}개 완전 일치`);

const bMap = new Map(base.map((r) => [key(r), r]));
const QUOTA = ['quota_total', 'quota_priority', 'quota_corporate', 'quota_taxi', 'quota_general'];
const GROW = ['registered_total', 'delivered_total'];

console.log('\n── 2) 공고대수 — 거의 안 변하는 값');
let qDiff = 0;
for (const r of now) {
  const b = bMap.get(key(r));
  if (!b) continue;
  for (const f of QUOTA) {
    if (b[f] !== r[f]) {
      qDiff++;
      if (qDiff <= 8) console.log(`   · ${r.region} ${f}: ${b[f]} → ${r[f]}`);
    }
  }
}
console.log(`   공고대수 불일치 ${qDiff}건 / ${now.length * QUOTA.length}칸`);
if (qDiff > now.length * 0.15) bad('공고대수가 너무 많이 다르다 — 매핑이 틀렸을 수 있다');
else console.log('   ✅ 공고대수 일치(또는 실제 공고 변경 수준)');

console.log('\n── 3) 접수·출고 — 시간이 흘렀으니 늘기만 해야 한다');
let dec = 0;
for (const r of now) {
  const b = bMap.get(key(r));
  if (!b) continue;
  for (const f of GROW) {
    if (r[f] < b[f]) {
      dec++;
      if (dec <= 8) console.log(`   · ${r.region} ${f}: ${b[f]} → ${r[f]} (감소)`);
    }
  }
}
console.log(`   감소한 칸 ${dec}건`);
if (dec > now.length * 0.1) bad('접수·출고가 광범위하게 감소 — 매핑이 밀렸을 수 있다');
else console.log('   ✅ 감소 없음(또는 지자체 정정 수준)');

// ★불변식 — 사이트가 화면에 명시한 정의 그대로다("출고잔여 = 공고대수 − 출고대수").
//   기준선 161행 전부에서 성립함을 먼저 확인하고 넣었다(성립 161 / 불성립 0).
//   기준선 대조와 달리 **바깥 정답지가 필요 없어서**, 열이 밀리는 사고를 혼자서 잡는다.
console.log('\n── 4) 불변식: 출고잔여 = max(0, 공고대수 − 출고대수)');
let inv = 0;
for (const r of now) {
  const exp = Math.max(0, r.quota_total - r.delivered_total);
  if (r.remaining_total !== exp) {
    inv++;
    if (inv <= 8) console.log(`   · ${r.region}: 잔여 ${r.remaining_total} vs 기대 ${exp} (공고 ${r.quota_total} − 출고 ${r.delivered_total})`);
  }
}
if (inv) bad(`불변식 위반 ${inv}건 — 열이 밀렸을 가능성이 높다`);
else console.log(`   ✅ ${now.length}행 전부 성립`);

console.log('\n── 5) 표본 대조 (서울)');
const bSeoul = base.find((r) => r.region === '서울특별시');
const nSeoul = now.find((r) => r.region === '서울특별시');
if (!bSeoul || !nSeoul) bad('서울 행을 못 찾음');
else {
  // 공고대수는 그대로여야 하고, 접수·출고는 늘 수 있다. 그 외 값이 다르면 실패다.
  const mayGrow = (f) => f.startsWith('registered_') || f.startsWith('delivered_') || f.startsWith('remaining_');
  for (const f of Object.keys(bSeoul)) {
    if (f === 'note') continue;
    const same = String(bSeoul[f]) === String(nSeoul[f]);
    console.log(`   ${same ? '=' : '≠'} ${f.padEnd(22)} ${String(bSeoul[f]).padStart(8)} → ${String(nSeoul[f]).padStart(8)}`);
    if (!same && !mayGrow(f)) bad(`서울 ${f} 가 달라졌다 — 변할 값이 아니다`);
  }
}

console.log('\n' + (fail ? `❌ ${fail}건 실패` : '✅ 전부 통과'));
process.exit(fail ? 1 : 0);
