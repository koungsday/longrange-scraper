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
  /* ★전수를 언제 도느냐 — **실행된 시각(분)으로 정하지 않는다.**
     예전 판정식: (kstHour % 4 === 0 && kstMin < 20)
     의도는 "4시간마다 :05 런에서만 전수" 였는데, GitHub Actions 의 schedule 은
     예약 시각을 안 지킨다(실측 2026-09-04~08, 최근 런 30건의 지연 0~59분).
     그래서 4의 배수 시각에 20분 안에 시작한 런이 **30건 중 0건**이었고,
     전수는 2026-09-03 00:10 을 마지막으로 **5일간 한 번도 돌지 않았다.**
     의도 12회/일 → 6회/일 로 줄이려던 조건이 실제로는 0회/일을 만들었다.
     → 어느 cron 이 우리를 깨웠는지는 GitHub 이 알려준다(github.event.schedule).
       워크플로가 그걸 보고 NOTICE_FULL 을 넣어 준다. 지각해도 판정이 안 흔들린다. */
  const full = process.env.NOTICE_FULL === '1' || !prev;
  console.log(full ? '🔍 전수 훑기 (새 첨부 탐색)' : '🔎 알려진 칸만 확인');
  // ★prev 도 넘긴다. 안 넘기면 **전수 모드에서** 네트워크 예외가 난 칸의 이전 값을
  //   되살릴 방법이 없다(notice-links.js 의 복구 경로가 opt.prev 를 본다).
  const data = await buildNoticeLinks(regions, {
    probe: true,
    known: full ? null : prev.regions,
    prev: prev?.regions,
  });

  if (!data.fileCount) {
    // ★0건이면 쓰지 않는다. 서버가 잠깐 막았을 때 멀쩡한 목록을 빈 목록으로
    //   덮어쓰면 화면에서 첨부가 통째로 사라진다.
    console.error('❌ 첨부 0건 — 기존 파일을 지키기 위해 쓰지 않는다');
    process.exit(1);
  }

  /* ★대량 삭제 가드 — 가드가 '총 0건' 하나뿐이라 **18% 삭제가 그냥 통과했다.**
     2026-09-03 13:06 KST 런: 402 → 330건(72건, 61개 지역)을 한 번에 지우고 커밋했다.
     그 파일들은 지금도 환경부 서버에서 정상으로 내려받힌다 — 전부 거짓 삭제였다.
     정상 감소는 한 번에 몇 건이다. 두 자릿수가 한 번에 빠지면 그건 사고다.
     진짜로 대량 정리를 해야 하면 NOTICE_ALLOW_DROP=1 로 명시적으로 넘긴다. */
  const dropped = prev ? prev.fileCount - data.fileCount : 0;
  const dropPct = prev && prev.fileCount ? dropped / prev.fileCount : 0;
  if (dropped >= 10 && dropPct > 0.05 && process.env.NOTICE_ALLOW_DROP !== '1') {
    console.error(`❌ 한 번에 ${dropped}건(${(dropPct * 100).toFixed(1)}%) 감소 — 사고로 보고 쓰지 않는다`);
    console.error('   (의도한 정리라면 NOTICE_ALLOW_DROP=1 로 다시 실행)');
    process.exit(1);
  }

  /* ★마지막 전수 시각을 파일에 남긴다 — **감시할 방법이 이것뿐이다.**
     2026-09-03~08 사고의 결정타는 삭제가 아니라 '전수가 5일간 0회 돌았는데 아무도 몰랐다' 였다.
     산출물은 그동안 완전히 건강해 보였다(fileCount 344·regionCount 161·unknownCount 0).
     이 한 줄이 있으면 위생 다이제스트가 "전수가 N시간째 안 돌았다" 를 말할 수 있다.
     ★전수 판정은 이제 cron 이 하는데(github.event.schedule), GitHub 은 예약을 자주 건너뛴다
       — 실측 하루 48회 중 5~8회만 돈다. 즉 '조용히 known 모드만 도는' 상태는 여전히 가능하다. */
  data.lastFullAt = full ? new Date().toISOString() : (prev?.lastFullAt ?? null);

  const strip = (o) => JSON.stringify({ ...o, timestamp: 0, lastFullAt: 0 });
  const same = prev && strip(prev) === strip(data);
  /* 내용이 같아도 **전수 시각이 12시간 넘게 굳었으면** 한 번 쓴다.
     안 그러면 전수가 멀쩡히 도는데도 lastFullAt 이 안 갱신돼 다이제스트가 헛경보를 낸다.
     상한은 하루 2회 — 커밋 소음은 이 정도면 감당된다(그래서 timestamp 만 바뀐 커밋은 계속 막는다). */
  const staleStamp = full && (!prev?.lastFullAt
    || (Date.now() - Date.parse(prev.lastFullAt)) > 12 * 3600 * 1000);
  if (same && !staleStamp) {
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
