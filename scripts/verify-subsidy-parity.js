#!/usr/bin/env node
/**
 * 적대검증 — Excel 기반 모델 보조금 파서가 옛 팝업 스크래퍼와 같은 값을 내는가.
 *
 * 기준선 = 개편 직전 마지막 정상본(2026-08-16 11:15 KST) 3종.
 * ★단종 10종은 Excel 에 없는 게 **정상**이다(지원여부='지원' 만 싣는다).
 *   그래서 "기준선에서 (단종) 제거한 집합" 과 비교한다. 그 밖의 차이는 전부 실패다.
 *
 * 사용: node scripts/verify-subsidy-parity.js <subsidies.json> <legacy.json> <vehicles.json> <xlsx>
 */
const fs = require('fs');
const { parseSubsidyXlsx, resolveMoneyUnit, UNIT_TO_WON } = require('../src/parse-subsidy-xlsx');

const [, , sPath, lPath, vPath, xPath] = process.argv;
if (!xPath) {
  console.error('사용: node scripts/verify-subsidy-parity.js <subsidies.json> <legacy.json> <vehicles.json> <xlsx>');
  process.exit(2);
}
const base = JSON.parse(fs.readFileSync(sPath, 'utf8'));
const baseLegacy = JSON.parse(fs.readFileSync(lPath, 'utf8'));
const baseVeh = JSON.parse(fs.readFileSync(vPath, 'utf8'));
const now = parseSubsidyXlsx(fs.readFileSync(xPath));

let fail = 0;
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const isDisc = (k) => /___\(단종\)/.test(k);

console.log('── 0) 단위 자동 감지');
console.log(`   감지된 금액 단위: ${now.meta.unitName} (×${now.meta.unit})`);
if (!now.meta.unit) bad('단위를 못 읽었다');
if (now.meta.nationalConflicts.length) bad(`국비가 지역마다 다르다: ${now.meta.nationalConflicts.join(', ')}`);
else console.log('   ✅ 국비는 전국 공통(불일치 0)');

console.log('\n── 1) 지역 집합');
const bCodes = Object.keys(base.regions).sort();
const nCodes = Object.keys(now.subsidies.regions).sort();
console.log(`   지역 수 ${bCodes.length} → ${nCodes.length}`);
if (JSON.stringify(bCodes) !== JSON.stringify(nCodes)) bad('지역 코드 집합 불일치');
else console.log('   ✅ 지역 코드 완전 일치');

console.log('\n── 2) 모델 집합 (단종 제외 후 완전 일치해야 한다)');
let missLive = 0, extra = 0, discDropped = 0;
for (const c of nCodes) {
  const b = base.regions[c]?.subsidies || {};
  const n = now.subsidies.regions[c].subsidies;
  for (const k of Object.keys(b)) {
    if (k in n) continue;
    if (isDisc(k)) { discDropped++; continue; }
    missLive++;
    if (missLive <= 8) console.log(`   · 사라진 비단종 모델 ${base.regions[c].localName} / ${k}`);
  }
  for (const k of Object.keys(n)) if (!(k in b)) { extra++; if (extra <= 8) console.log(`   · 새로 생긴 모델 ${now.subsidies.regions[c].localName} / ${k}`); }
}
console.log(`   단종으로 빠진 조합 ${discDropped}건 (정상) · 비단종 누락 ${missLive}건 · 신규 ${extra}건`);
if (missLive) bad(`단종이 아닌데 사라진 모델이 ${missLive}건`);
if (extra) bad(`기준선에 없던 모델이 ${extra}건 — 확인 필요`);

/**
 * ★옛 스크래퍼의 알려진 버그 하나만 예외로 허용한다.
 *   `parseInt(cells[4]) * 10000` — parseInt("1,065") 는 콤마에서 멈춰 1 이 되고
 *   ×10000 = 10,000원이 된다. 즉 **1,000만원 이상 금액이 전부 1만원으로** 기록됐다.
 *   (지방비 30건=전부 울릉군, legacy total 3,015건/19,159 = 16%)
 *   이 서명(기준선이 정확히 10000 && 새 값이 1,000만원 이상)에만 통과를 준다.
 *   그 밖의 불일치는 전부 실패다 — 넓게 봐주면 검증이 아니라 변명이 된다.
 */
const OLD_PARSEINT_BUG = (oldV, newV) => oldV === 10000 && newV >= 10000000;

console.log('\n── 3) 지방비 값 (subsidies.json)');
let diff = 0, cmp = 0, fixed = 0;
for (const c of nCodes) {
  const b = base.regions[c].subsidies, n = now.subsidies.regions[c].subsidies;
  for (const k of Object.keys(n)) {
    if (!(k in b)) continue;
    cmp++;
    if (b[k] === n[k]) continue;
    if (OLD_PARSEINT_BUG(b[k], n[k])) { fixed++; continue; }
    diff++;
    if (diff <= 8) console.log(`   · ${now.subsidies.regions[c].localName} / ${k}: ${b[k]} → ${n[k]}`);
  }
}
console.log(`   대조 ${cmp}칸 · 옛 버그 교정 ${fixed}건 · 설명 안 되는 불일치 ${diff}건`);
if (diff) bad(`지방비 불일치 ${diff}건`);
else console.log('   ✅ 나머지 전부 일치');

console.log('\n── 4) legacy 3금액 (국비·지방비·총액)');
const bl = new Map(baseLegacy.data.map((d) => [String(d.code), d.vehicles]));
let ld = 0, lc = 0, lfixed = 0;
for (const d of now.legacy.data) {
  const b = bl.get(String(d.code)) || {};
  for (const [k, v] of Object.entries(d.vehicles)) {
    if (!(k in b)) continue;
    lc++;
    for (const f of ['national', 'local', 'total', 'type', 'manufacturer', 'model']) {
      if (String(b[k][f]) === String(v[f])) continue;
      if (['national', 'local', 'total'].includes(f) && OLD_PARSEINT_BUG(b[k][f], v[f])) { lfixed++; continue; }
      ld++;
      if (ld <= 8) console.log(`   · ${d.localName} / ${k} ${f}: ${b[k][f]} → ${v[f]}`);
    }
  }
}
console.log(`   대조 ${lc}항목 · 옛 버그 교정 ${lfixed}건 · 설명 안 되는 불일치 ${ld}건`);
if (ld) bad(`legacy 값 불일치 ${ld}건`);
else console.log('   ✅ 전부 일치');

console.log('\n── 5) vehicles.json 국비');
let vd = 0, vc = 0;
for (const [k, v] of Object.entries(now.vehicles.vehicles)) {
  const b = baseVeh.vehicles[k];
  if (!b) continue;
  vc++;
  if (b.national !== v.national || b.type !== v.type) { vd++; if (vd <= 5) console.log(`   · ${k}: ${b.national}/${b.type} → ${v.national}/${v.type}`); }
}
console.log(`   대조 ${vc}종 · 불일치 ${vd}건`);
if (vd) bad(`vehicles 불일치 ${vd}건`);
else console.log('   ✅ 전부 일치');

// ── 6) 단위 자동 대응 — 사용자 요구사항의 핵심. 합성 입력으로 직접 시험한다.
console.log('\n── 6) 단위 표기가 바뀌면 자동으로 따라가는가');
const guide = (u) => ({ 안내: [['항목', '내용'], ['단위', `대수=대, 비율=%, 금액=${u}`]] });
const cases = [
  ['둘 다 만원', guide('만원'), '지방비(만원)', 10000],
  ['둘 다 원', guide('원'), '지방비(원)', 1],
  ['둘 다 천원', guide('천원'), '지방비(천원)', 1000],
  ['안내만 있음', guide('원'), '지방비', 1],
  ['머리글만 있음', {}, '지방비(만원)', 10000],
];
for (const [label, sheets, header, expect] of cases) {
  let got = null, err = null;
  try { got = resolveMoneyUnit(sheets, header); } catch (e) { err = e.message; }
  const ok = got === expect;
  if (!ok) bad(`단위 케이스 '${label}': 기대 ${expect}, 결과 ${got ?? 'throw: ' + err}`);
  else console.log(`   ✅ ${label} → ×${got}`);
}
// 어긋남·부재는 반드시 던져야 한다(조용히 한쪽을 고르면 1만 배 틀어진다)
for (const [label, sheets, header] of [
  ['머리글 만원 vs 안내 원 (모순)', guide('원'), '지방비(만원)'],
  ['둘 다 없음', {}, '지방비'],
  ['모르는 단위', guide('갤런'), '지방비(갤런)'],
]) {
  let threw = false;
  try { resolveMoneyUnit(sheets, header); } catch { threw = true; }
  if (!threw) bad(`단위 케이스 '${label}': 던져야 하는데 통과했다`);
  else console.log(`   ✅ ${label} → 실패로 처리`);
}

console.log('\n' + (fail ? `❌ ${fail}건 실패` : '✅ 전부 통과'));
process.exit(fail ? 1 : 0);
