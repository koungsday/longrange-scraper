#!/usr/bin/env node
/**
 * data/notice-links.json 생성기 (주 1회 실행).
 *
 * ★Pages 발행을 여기서 하지 않는다.
 *   data/ 에 커밋만 해두면 **다음 quota 런(10분 주기)이 data/ 전체를 발행**하면서
 *   같이 올라간다. Pages 동시 배포 충돌도 피한다.
 *
 * ★내용이 같으면 쓰지 않는다.
 *   timestamp 만 바뀐 파일을 매주 커밋하면 저장소만 분다(quota-detail 과 같은 처방).
 */

const fs = require('fs').promises;
const axios = require('axios');
const { buildNoticeLinks } = require('./notice-links');

const OUT = 'data/notice-links.json';

async function getRegions() {
  const res = await axios.get('https://api.donut.im/api/v1/regions/list');
  const out = [];
  for (const r of res.data.regions || []) {
    for (const l of r.local || []) out.push({ parentName: r.localType, localName: l.name, code: l.code });
  }
  return out;
}

async function main() {
  console.log('🔗 공고문 첨부 링크 목록 생성');
  console.log('⏰ ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));

  // ★주 1회(월요일)만. 다른 날은 즉시 끝난다 — 매일 도는 스크랩에 얹혀 있지만
  //   실제 작업은 주 1회다. 수동 실행은 NOTICE_FORCE=1 로 요일을 무시한다.
  const kstDay = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getDay();
  if (process.env.NOTICE_FORCE !== '1' && kstDay !== 1) {
    console.log(`⏭️  오늘은 ${'일월화수목금토'[kstDay]}요일 — 링크 목록은 월요일에만 갱신한다(건너뜀)`);
    return;
  }

  const regions = await getRegions();
  console.log(`📍 지역 ${regions.length}개`);

  // ★항상 넓게(11구분) 훑되 **주 1회만** 돈다.
  //   공고문은 연 1~3회만 바뀐다(실측: 게시일이 전부 2026-01·02, 3월 이후 신규 0건).
  //   매일 돌 이유가 없다. 주 1회 11분이면 충분하고, 넓게 훑으니 새 구분도 안 놓친다
  //   (처음에 A계열만 보다가 B 93건·C 25건을 통째로 놓쳤다).
  const data = await buildNoticeLinks(regions, { probe: true });

  if (!data.fileCount) {
    // ★0건이면 쓰지 않는다. 서버가 잠깐 막았을 때 멀쩡한 목록을 빈 목록으로
    //   덮어쓰면 화면에서 첨부가 통째로 사라진다.
    console.error('❌ 첨부 0건 — 기존 파일을 지키기 위해 쓰지 않는다');
    process.exit(1);
  }

  let prev = null;
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* 최초 */ }
  const same = prev && JSON.stringify({ ...prev, timestamp: 0 }) === JSON.stringify({ ...data, timestamp: 0 });
  if (same) {
    console.log('💾 변화 없음 → 미기록');
    return;
  }

  // 무엇이 달라졌는지 한 줄로 — 로그만 보고도 판단되게.
  if (prev) {
    const before = prev.fileCount, after = data.fileCount;
    console.log(`📝 변경: 첨부 ${before} → ${after}건 · 지역 ${prev.regionCount} → ${data.regionCount}`);
  }
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data));
  console.log(`💾 ${OUT} 저장 (${(JSON.stringify(data).length / 1024).toFixed(0)}KB)`);
}

main().catch((e) => { console.error('❌ 실패:', e.message); process.exit(1); });
