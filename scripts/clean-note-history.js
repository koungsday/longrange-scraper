#!/usr/bin/env node
/**
 * note-history 에서 **내용은 같고 표기만 다른** 기록을 제거한다.
 *
 * ★왜: 2026-08-17 00:03 에 133곳이 일괄 기록됐는데, 전부 `&#xa;` 같은 **HTML 엔티티가
 *   삽입된 것**뿐이고 글자는 동일했다. 원본 소스가 줄바꿈을 이스케이프하기 시작한 것이다.
 *   이걸 "변경" 으로 세면 화면이 "6일째 변동 없음" 이라고 말하는데 실제 마지막 변경은
 *   그보다 4~8일 전이다 — 실제보다 **젊게** 말하는 거짓이다(적대적 검증 실측 18곳).
 * ★공백 정규화만으로는 안 잡힌다 — `&#xa;` 는 공백이 아니라 문자열이다.
 *   엔티티를 공백으로 바꾼 뒤 비교해야 잡힌다(그래서 처음 검사에서 0건이 나왔다).
 * ★앞으로도 같은 일이 생기지 않게 스크래퍼에도 같은 정규화를 넣는다(별도).
 *
 * dry-run 기본. 실제로 쓰려면 --commit
 */
const fs = require('fs').promises;

/** 표기 차이를 지운 형태 — HTML 엔티티·공백을 모두 없앤다 */
const norm = (s) => String(s || '').replace(/&#x?[0-9a-fA-F]+;/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();

async function main() {
  const dry = !process.argv.includes('--commit');
  const dir = 'data/note-history';
  const files = await fs.readdir(dir);
  let removed = 0, touched = 0, ex = [];
  for (const f of files) {
    const path = `${dir}/${f}`;
    const j = JSON.parse(await fs.readFile(path, 'utf8'));
    const h = Array.isArray(j.history) ? j.history : [];
    /* 최신→오래된 순. 앞 항목이 다음 항목과 표기만 다르면 **앞 항목을 버린다**
       (오래된 쪽이 진짜 변경 시점이다). */
    const keep = [];
    for (let i = 0; i < h.length; i++) {
      const next = h[i + 1];
      if (next && norm(h[i].note) === norm(next.note)) {
        removed++;
        if (ex.length < 5) ex.push(`   ${f.replace('.json', '')} ${h[i].date.slice(0, 16)} 제거 (표기만 다름)`);
        continue;
      }
      keep.push(h[i]);
    }
    if (keep.length !== h.length) {
      touched++;
      if (!dry) await fs.writeFile(path, JSON.stringify({ ...j, history: keep }));
    }
  }
  console.log(ex.join('\n'));
  console.log(`\n${dry ? '🔍 dry-run' : '💾 기록'} — ${removed}건 제거 · ${touched}개 파일 변경${dry ? ' (실제로 쓰려면 --commit)' : ''}`);
}
main().catch((e) => { console.error('❌', e.message); process.exit(1); });
