/**
 * 지자체 공고문 첨부 → 텍스트 자산 (data/notice-text.json)
 *
 * ★지금 단계에서 원본 파일은 보관하지 않는다.
 *   원본 보관은 R2 가 맞는데(무료 한도 10GB 의 1% 미만), 이 저장소에 R2 자격증명이
 *   없다. 시크릿을 넣거나 vw-k 에 업로드 경로를 여는 게 선행이라, 그건 다음 단계다.
 *   ★텍스트가 가치의 대부분이다 — 환경부 쪽에서는 AI 가 본문을 못 읽으므로
 *     (난독화 + 파라미터), 우리가 텍스트로 만들면 읽을 수 있는 유일한 출처가 된다.
 *
 * ★안 바뀌면 안 받는다.
 *   공고문은 새 차수가 생길 때만 바뀐다. 지도(map)에 파일명·크기를 기억해 두고,
 *   HEAD 로 그 둘이 같으면 본문을 아예 받지 않는다. 평상시 트래픽이 거의 0 이 된다.
 *
 * ★★서버가 본문 다운로드를 제한한다 (실측)
 *   HEAD 는 1초 간격에 6/6 으로 멀쩡한데, **본문(GET)은 3초 간격 3/5, 5초 간격 4/5**.
 *   오류는 `UND_ERR_SOCKET: other side closed` — 서버가 연결을 끊는다.
 *   ⚠️처음엔 Node/undici 의 keep-alive 탓으로 몰았으나 **틀렸다.** 새 Agent·HTTP/2·
 *     node:https 로 바꿔도 같았고, curl 도 연속이면 1/10 이었다. 클라이언트 문제가 아니라
 *     **본문 대역폭에 걸린 제한**이다.
 *   → 그래서 한 회차에 전부 받으려 하지 않는다. **회차당 예산(budget)만큼만 받고,
 *     실패한 건 다음 회차에 자연히 다시 시도된다**(지도에 성공 기록이 없으니까).
 *     초기 수집은 며칠에 걸쳐 채워지고, 그 뒤로는 바뀐 것만 받으므로 거의 0 이 된다.
 */

const fs = require('fs').promises;
const { fetchOne, filenameOf, GUBUN, GUBUN_PROBE, url } = require('./notice-files');
const { extractText, extOf } = require('./notice-text');

const TEXT_PATH = 'data/notice-text.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; vw-k-subsidy-archive/1.0)' };

/** 본문 없이 "무엇이 있는지"만 본다. 없는 첨부의 240KB 에러 페이지를 안 받는다. */
async function head(code, gubun, year) {
  try {
    const res = await fetch(url(code, gubun, year), { method: 'HEAD', headers: UA });
    if (!res.ok) return null;
    const name = filenameOf(res.headers);
    if (!name) return null;
    return { name, size: Number(res.headers.get('content-length') || 0) };
  } catch { return null; }
}

/**
 * @param {Array<{code:string|number, localName?:string, parentName?:string}>} regions
 * @param {{year?:number, probe?:boolean, headDelayMs?:number, getDelayMs?:number,
 *          budget?:number, log?:Function}} opt
 */
async function collectNotices(regions, opt = {}) {
  const year = opt.year || new Date().getFullYear();
  const log = opt.log || console.log;
  const headDelay = opt.headDelayMs ?? 1000;   // HEAD 는 1초면 안정적(실측 6/6)
  const getDelay = opt.getDelayMs ?? 4000;     // 본문은 아무리 늦춰도 완벽하진 않다
  let budget = opt.budget ?? 60;               // 이번 회차에 받을 최대 건수
  const list = opt.probe ? [...GUBUN, ...GUBUN_PROBE] : GUBUN;

  let prev = null;
  try { prev = JSON.parse(await fs.readFile(TEXT_PATH, 'utf8')); } catch { /* 최초 */ }
  const prevItems = new Map();
  for (const it of (prev && prev.items) || []) prevItems.set(`${it.code}/${it.gubun}`, it);

  const items = [];
  const stats = { seen: 0, reused: 0, downloaded: 0, extracted: 0, unsupported: 0, failed: 0, deferred: 0, surprises: [] };

  for (const r of regions) {
    const code = String(r.code);
    for (const g of list) {
      const h = await head(code, g, year);
      await new Promise((s) => setTimeout(s, headDelay));
      if (!h) continue;
      stats.seen++;
      if (!GUBUN.includes(g)) stats.surprises.push(`${code}/${g}: ${h.name}`);

      const key = `${code}/${g}`;
      const old = prevItems.get(key);
      // ★파일명과 크기가 같으면 같은 파일로 본다 → 본문을 안 받는다.
      if (old && old.name === h.name && old.size === h.size) {
        items.push({ ...old, region: r.localName || old.region, sido: r.parentName || old.sido });
        stats.reused++;
        continue;
      }

      // ★예산 소진 — 이번 회차엔 안 받는다. 지도에 성공 기록이 안 남으므로
      //   다음 회차에 자연히 다시 시도된다(별도 큐가 필요 없다).
      if (budget <= 0) {
        items.push({ code, gubun: g, region: r.localName || '', sido: r.parentName || '',
          name: h.name, size: h.size, kind: extOf(h.name), text: null, chars: 0,
          textStatus: '이번 회차 예산 초과 — 다음 회차에 받음', fetchedAt: null });
        stats.deferred++;
        continue;
      }
      budget--;
      const f = await fetchOne(code, g, year);
      await new Promise((s) => setTimeout(s, getDelay));
      if (!f.ok) {
        items.push({ code, gubun: g, region: r.localName || '', sido: r.parentName || '',
          name: h.name, size: h.size, kind: extOf(h.name), text: null, chars: 0,
          textStatus: `받기 실패: ${f.reason}`, fetchedAt: new Date().toISOString() });
        stats.failed++;
        continue;
      }
      stats.downloaded++;

      const t = extractText(f.buf, f.name);
      const base = { code, gubun: g, region: r.localName || '', sido: r.parentName || '',
        name: f.name, size: f.size, kind: t.kind, fetchedAt: new Date().toISOString() };
      if (t.ok) {
        items.push({ ...base, text: t.text, chars: t.chars, textStatus: 'ok' });
        stats.extracted++;
      } else {
        // ★못 읽는 것도 목록에 남긴다. 빠뜨리면 "그 지역엔 공고문이 없다" 로 오해된다.
        items.push({ ...base, text: null, chars: 0, textStatus: t.reason });
        stats.unsupported++;
      }
    }
  }

  // 지역별 커버리지 — 리뉴얼 때 "이 지역은 원문이 있나" 를 바로 알 수 있게.
  const byRegion = {};
  for (const it of items) {
    const b = (byRegion[it.code] ||= { region: it.region, sido: it.sido, files: 0, readable: 0, chars: 0 });
    b.files++;
    if (it.textStatus === 'ok') { b.readable++; b.chars += it.chars; }
  }
  const readableRegions = Object.values(byRegion).filter((b) => b.readable > 0).length;

  const out = {
    year, timestamp: new Date().toISOString(),
    regionCount: Object.keys(byRegion).length,
    readableRegions,
    stats: { ...stats, surprises: stats.surprises.slice(0, 20) },
    byRegion,
    items,
  };
  log(`📄 첨부 ${stats.seen}건 · 재사용 ${stats.reused} · 신규 ${stats.downloaded} · 텍스트 ${stats.extracted} · 미지원 ${stats.unsupported} · 실패 ${stats.failed} · 미루기 ${stats.deferred}`);
  log(`   원문 확보 지역 ${readableRegions}/${out.regionCount}`);
  if (stats.surprises.length) log(`   ⚠️ 새 구분 발견: ${stats.surprises.join(' / ')} → notice-files.js 의 GUBUN 을 넓혀야 한다`);
  return out;
}

module.exports = { collectNotices, TEXT_PATH };
