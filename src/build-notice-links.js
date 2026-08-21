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


  const regions = await getRegions();
  console.log(`📍 지역 ${regions.length}개`);

  // ★평소엔 **알려진 칸만** 두드린다 (388회 ≈ 4.5분).
  //   전수는 161×11=1,771 인데 실제 첨부는 388개다. 어디 있는지 이미 아는데도
  //   빈 칸 1,383개를 매번 두드리던 게 전체 시간의 78% 였다.
  // ★월요일엔 전수(1,771회 ≈ 20분) — 새로 생긴 첨부·새 구분을 찾는다.
  //   처음에 A계열만 보다가 B 93건·C 25건을 통째로 놓쳤으므로 주 1회는 넓게 본다.
  //   NOTICE_FULL=1 로 강제 전수 가능.
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* 최초 */ }
  // ★전수는 **하루 1회(새벽 4시대)** 면 충분하다 — 새 '칸' 이 생기는 건 드물다.
  //   나머지 시간은 알려진 칸만 보므로 3분이면 끝난다.
  const kstHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }));
  /* ★전수를 하루 1회(04시)만 돌렸더니 **새로 생긴 첨부를 최대 24시간 놓쳤다**.
     2026-08-21 함평군 실측 — 환경부에는 A(1차)와 A02(3차) 두 건이 있는데 우리는 A 하나만.
     '알려진 칸만' 최적화는 이미 아는 칸을 다시 확인할 뿐이라, 지역이 **새 칸에** 파일을 올리면
     다음 전수까지 보이지 않는다. 새 공고가 뜨는 건 드문 일이 아니고(오늘도 추경1차가 떴다)
     그때 첨부가 같이 올라오므로, 하루 1회는 너무 성기다.
     → 4시간마다 전수(00·04·08·12·16·20시). 전수는 1,771회 ≈ 20분이고 30분 주기 안에 들어간다.
       나머지 시간(하루 20회)은 그대로 알려진 칸만 본다 — 최적화의 이득은 유지된다. */
  const full = process.env.NOTICE_FULL === '1' || kstHour % 4 === 0 || !prev;
  console.log(full ? '🔍 전수 훑기 (새 첨부 탐색)' : '🔎 알려진 칸만 확인');
  const data = await buildNoticeLinks(regions, { probe: true, known: full ? null : prev.regions });

  if (!data.fileCount) {
    // ★0건이면 쓰지 않는다. 서버가 잠깐 막았을 때 멀쩡한 목록을 빈 목록으로
    //   덮어쓰면 화면에서 첨부가 통째로 사라진다.
    console.error('❌ 첨부 0건 — 기존 파일을 지키기 위해 쓰지 않는다');
    process.exit(1);
  }

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
