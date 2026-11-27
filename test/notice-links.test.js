#!/usr/bin/env node
/**
 * 공고문 첨부 확인 회귀 테스트 — 가짜 fetch 로 서버 상태를 흉내낸다.
 *
 * ★지키는 것: 서버가 막혀도 ① 런이 시간 안에 끝나고 ② 실패가 '실패'로 남고(지우지 않음)
 *   ③ 그 런이 '전수 완료'로 찍히지 않는다. 2026-11-25~ 실제로 셋 다 깨져 있었다
 *   (러너 469/469 확인 실패 → 25분 강제 종료 → 기록 없음, 산출물은 멀쩡해 보임).
 * ★실제 배포 코드(src/notice-links.js)를 그대로 부른다. 네트워크는 쓰지 않는다.
 *
 * 실행: node test/notice-links.test.js
 */
const { buildNoticeLinks, trustworthy } = require('../src/notice-links');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { X509Certificate } = require('crypto');

const regions = [
  { code: '1100', parentName: '서울', localName: '서울특별시' },
  { code: '2600', parentName: '부산', localName: '부산광역시' },
  { code: '4111', parentName: '경기', localName: '수원시' },
];
const file = (gubun, name) => ({ gubun, name, ext: 'hwpx', kind: '한글문서', url: 'x' });
const known = Object.fromEntries(regions.map((r) => [r.code, {
  sido: r.parentName, region: r.localName, files: [file('A', `${r.code}-공고.hwpx`), file('B', `${r.code}-지침.hwpx`)],
}]));                                  // 알려진 첨부 6건

const FAKE = {
  ok: async () => ({ status: 200, ok: true,
    headers: new Headers({ 'content-disposition': `attachment; filename=${encodeURIComponent('공고문.hwpx')}` }) }),
  fail: async () => { throw new TypeError('fetch failed'); },                 // 연결이 끊김(빠른 실패)
  /* 답을 안 줌 — 끊어야만 끝난다. ★신호가 없으면 **정말로** 영원히 기다려야 한다.
     처음엔 init.signal 을 바로 읽어서, 신호가 없으면 그 자리에서 예외가 나 '빠른 실패'로
     바뀌었다 — 시간 제한을 빼도 이 테스트가 통과했다(변이 시험으로 잡음). */
  hang: (_u, init = {}) => new Promise((_, rej) => {
    init.signal?.addEventListener('abort', () => rej(init.signal.reason));
  }),
  empty500: async () => ({ status: 500, ok: false, headers: new Headers() }), // 이 서버의 '빈 칸' 정상 응답
};
const quiet = () => {};
const run = (fake, extra = {}) => {
  global.fetch = fake;
  const t0 = Date.now();
  /* 가드: 시간 제한이 빠져 있으면 hang 이 영원히 안 끝난다 — 테스트가 멈추지 말고 실패로 보고하게 */
  return Promise.race([
    buildNoticeLinks(regions, { known, log: quiet, ...extra }).then((r) => ({ r, ms: Date.now() - t0 })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('10초 안에 안 끝남 — 시간 제한이 안 걸린다')), 10_000)),
  ]);
};

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    const msg = await fn();
    if (msg === true) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}\n       ${msg}`); fail++; }
  } catch (e) { console.log(`  ❌ ${name}\n       예외: ${e.message}`); fail++; }
}

(async () => {
  console.log('\n■ 첨부 확인 — 서버 상태별');

  await t('정상이면 6건 확인·실패 0·믿을 수 있는 결과', async () => {
    const { r } = await run(FAKE.ok);
    return (r.fileCount === 6 && r.unknownCount === 0 && r.cutCount === 0 && trustworthy(r))
      || `file=${r.fileCount} unknown=${r.unknownCount} cut=${r.cutCount} trust=${trustworthy(r)}`;
  });

  await t('★연결이 다 끊기면 — 지우지 않고 6건 유지, 전부 확인 실패, 믿을 수 없는 결과', async () => {
    const { r } = await run(FAKE.fail);
    return (r.fileCount === 6 && r.unknownCount === 6 && !trustworthy(r))
      || `file=${r.fileCount} unknown=${r.unknownCount} trust=${trustworthy(r)}`;
  });

  await t('★★서버가 답을 안 주면 — 요청 시간 제한으로 끊고 끝까지 간다 (예전엔 영원히 대기)', async () => {
    const { r, ms } = await run(FAKE.hang, { peekTimeoutMs: 50 });
    return (r.unknownCount === 6 && r.fileCount === 6 && ms < 5000)
      || `unknown=${r.unknownCount} file=${r.fileCount} ${ms}ms`;
  });

  await t('★★실행 시간 상한 — 넘으면 남은 칸은 안 두드리고 이전 값 유지, 결과는 믿지 않는다', async () => {
    const { r, ms } = await run(FAKE.hang, { peekTimeoutMs: 200, budgetMs: 100 });
    return (r.cutCount > 0 && r.fileCount === 6 && !trustworthy(r) && ms < 5000)
      || `cut=${r.cutCount} file=${r.fileCount} trust=${trustworthy(r)} ${ms}ms`;
  });

  await t('기존 \'없음\' 경로는 그대로 — 500 은 확인 실패가 아니라 사라짐 의심으로 센다', async () => {
    const { r } = await run(FAKE.empty500);
    return (r.vanishingCount === 6 && r.unknownCount === 0 && r.cutCount === 0)
      || `vanishing=${r.vanishingCount} unknown=${r.unknownCount} cut=${r.cutCount}`;
  });

  await t('진단 콜백 — 칸마다 성공 여부·실패 사유·응답 시간을 받는다 (속도 시험용)', async () => {
    const seen = [];
    await run(FAKE.fail, { onPeek: (p) => seen.push(p) });
    return (seen.length === 6 && seen.every((p) => p.ok === false && p.why && typeof p.ms === 'number'))
      || JSON.stringify(seen.slice(0, 2));
  });

  console.log('\n■ 믿을 수 있는 결과인가 (lastFullAt 을 찍을지)');
  const T = (fileCount, unknownCount, cutCount) => trustworthy({ fileCount, unknownCount, cutCount });
  await t('평소 수준(14/469) 은 믿는다', async () => T(469, 14, 0) === true || 'false');
  await t('★11/25 이후 실제 값(469/469) 은 믿지 않는다', async () => T(469, 469, 0) === false || 'true');
  await t('경계 — 20% 는 믿지 않고 19% 는 믿는다', async () => (T(100, 20, 0) === false && T(100, 19, 0) === true) || 'mismatch');
  await t('시간 상한에 한 칸이라도 잘렸으면 믿지 않는다', async () => T(469, 0, 1) === false || 'true');
  await t('첨부 0건이면 믿지 않는다', async () => T(0, 0, 0) === false || 'true');

  console.log('\n■ 동봉한 중간 인증서 (환경부 서버가 빠뜨리는 고리)');
  const pem = fs.readFileSync(path.join(__dirname, '../certs/turingsign-rsa-secure-ca3.pem'), 'utf8');
  const ica = new X509Certificate(pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----')));
  await t('★Node 가 원래 믿는 최상위 기관이 서명했다 — 새 신뢰 대상을 만들지 않는다', async () => {
    const root = tls.rootCertificates.map((r) => new X509Certificate(r))
      .find((r) => ica.checkIssued(r) && ica.verify(r.publicKey));
    return !!root || `서명한 최상위 기관을 Node 기본 목록에서 못 찾음 (issuer: ${ica.issuer})`;
  });
  await t('만료까지 60일 넘게 남았다 — 가까워지면 여기서 먼저 운다', async () => {
    const days = (Date.parse(ica.validTo) - Date.now()) / 86400000;
    return days > 60 || `만료까지 ${Math.floor(days)}일 (${ica.validTo}) — 새 중간 인증서로 바꿀 것`;
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
