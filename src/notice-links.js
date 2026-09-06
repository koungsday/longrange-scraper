/**
 * 지자체 공고문 첨부 **링크 목록** → data/notice-links.json
 *
 * ★파일을 받지 않는다. 링크만 만든다.
 *   - 방문자가 각자 자기 브라우저로 환경부에서 직접 받는다 → 우리 대역폭·저장소 0
 *   - 서버의 본문 다운로드 제한도 우리와 무관해진다(우리는 HEAD 만 쓴다)
 *   - 공고문은 **연초에 올라가고 안 바뀐다**(실측: 게시일이 전부 2026-01·02,
 *     3월 이후 신규 0건). 그래서 주 1회 갱신도 넉넉하다.
 *
 * ★★우리가 원본보다 나은 지점 — 이게 이 파일의 존재 이유다
 *   환경부 화면은 버튼이 **"다운로드 1 / 2 / 3"** 이 전부다. 호버해야
 *   "본공고 1 공고문 다운로드" 가 나오고, **형식도 크기도 파일명도 안 보인다**
 *   (실측: 본문에 hwp·pdf·KB·MB 어느 단어도 없음).
 *   → 뭘 받는지 모르고 누른다. 우리는 Content-Disposition 에서 파일명을 알므로
 *     **파일명과 형식(PDF·한글문서·엑셀)** 을 미리 보여줄 수 있다.
 *     ※"폰에서 열리는지" 까지는 말하지 않는다 — 뷰어 앱·브라우저가 있어 단정할 수
 *       없고, 우리가 판단할 영역도 아니다.
 *
 * ※크기는 넣지 않는다 — HEAD 응답의 Content-Length 가 0 이라 알 수 없고,
 *   알려면 본문을 받아야 하는데 그러면 이 설계의 이점이 사라진다.
 */

const { filenameOf, GUBUN, GUBUN_PROBE, url } = require('./notice-files');

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; vw-k-subsidy-links/1.0)' };

/**
 * 확장자 → 사람이 읽는 형식.
 * ★"폰에서 열리는지" 는 넣지 않는다. 한글 뷰어 앱도 브라우저 뷰어도 있어서
 *   우리가 단정할 수 없고, 애초에 우리가 판단할 영역이 아니다.
 *   **무슨 파일인지 알려주는 것까지**가 우리 몫이다.
 */
const KIND = {
  pdf:  { kind: 'PDF' },
  hwpx: { kind: '한글문서' },
  hwtx: { kind: '한글서식' },
  hwp:  { kind: '한글문서(구형)' },
  xlsx: { kind: '엑셀' },
  xls:  { kind: '엑셀(구형)' },
  zip:  { kind: '압축파일' },
};
const describe = (name) => {
  const s = String(name);
  // ★점이 없으면 확장자가 없는 것이다. split('.').pop() 은 이름 전체를 돌려주므로
  //   그대로 쓰면 "확장자없음" 같은 파일명이 형식으로 표시된다.
  const ext = s.includes('.') ? (s.split('.').pop() || '').toLowerCase() : '';
  return { ext, ...(KIND[ext] || { kind: ext ? ext.toUpperCase() : '파일' }) };
};

/**
 * 본문을 받지 않고 "무엇이 있는지"만.
 * @returns {{ok:true, name:string|null} | {ok:false}}  ok:false = 확인 실패(모름)
 * ★"없음"과 "확인 실패"를 반드시 구분한다. 둘을 섞으면 일시적 실패 하나가
 *   멀쩡한 첨부를 목록에서 지워 버린다(그러면 화면에서 공고문이 사라진다).
 */
async function peek(code, gubun, year, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url(code, gubun, year), { method: 'HEAD', headers: UA });
      if (res.status >= 500 && res.status !== 500) throw new Error('5xx');
      // 500 은 "그 칸에 첨부가 없다"는 이 서버의 정상 응답이다(실측).
      if (!res.ok) return { ok: true, name: null };
      return { ok: true, name: filenameOf(res.headers) || null };
    } catch {
      if (i === tries - 1) return { ok: false };
      await new Promise((s) => setTimeout(s, 300 * (i + 1)));
    }
  }
  return { ok: false };
}

/** 동시 실행. ★4가 최적 — 8·12는 오히려 느려지고 실패가 는다(실측). */
async function mapLimit(items, limit, fn) {
  const q = [...items];
  const out = [];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (q.length) { const it = q.shift(); out.push(await fn(it)); }
  }));
  return out;
}

/**
 * @param {Array<{code:string|number, localName?:string, parentName?:string}>} regions
 * @param {{year?:number, delayMs?:number, probe?:boolean, known?:object, log?:Function}} opt
 *   known: 이전 결과(regions). 주면 **알려진 칸만** 두드린다.
 */
async function buildNoticeLinks(regions, opt = {}) {
  const year = opt.year || new Date().getFullYear();
  // ★HEAD 는 **제한이 없다**(실측: 간격 0초에서도 12/12, 150ms 로 100건 연속 100/100).
  //   제한은 본문 다운로드에만 걸린다. 처음에 1초를 붙였던 건 근거 없는 과잉이었고
  //   그 탓에 1,771건이 30분+ 걸렸다. 150ms 면 예의도 지키고 11분이면 끝난다.
  const delay = opt.delayMs ?? 0;         // 병렬로 도니 개별 지연은 필요 없다
  const conc = opt.concurrency ?? 4;      // ★4가 최적(실측: 8·12는 더 느리고 실패 증가)
  const log = opt.log || console.log;
  // ★가끔 넓게 훑는다. 처음에 A계열만 보다가 B(93건)·C(25건)를 통째로 놓쳤다.
  const list = opt.probe ? [...GUBUN, ...GUBUN_PROBE] : GUBUN;

  const out = {};
  const surprises = [];
  let files = 0;
  let asked = 0;
  let unknown = 0;      // 확인 실패 — 이전 값을 그대로 지킨 건수
  for (const r of regions) {
    const code = String(r.code);
    const arr = [];
    // ★알려진 칸만 두드린다.
    //   전수로 훑으면 161×11=1,771 인데 실제 첨부는 388개다. 빈 칸 1,383개를
    //   매번 두드리는 게 전체 시간의 78% 였다. 어디에 있는지 이미 아는데도.
    //   새 첨부 발견은 주 1회 전수 훑기(known 없이 호출)가 맡는다.
    const slots = opt.known?.[code]
      ? list.filter((g) => opt.known[code].files.some((f) => f.gubun === g))
      : list;
    const results = await mapLimit(slots, conc, async (g) => {
      asked++;
      const r = await peek(code, g, year);
      if (delay) await new Promise((s) => setTimeout(s, delay));
      return [g, r];
    });
    for (const [g, r] of results.sort((a, b) => list.indexOf(a[0]) - list.indexOf(b[0]))) {
      let name = r.ok ? r.name : null;
      if (!r.ok) {
        // ★확인 실패 → 이전에 있던 건 그대로 지킨다. 지우지 않는다.
        const old = opt.known?.[code]?.files.find((f) => f.gubun === g)
          || opt.prev?.[code]?.files.find((f) => f.gubun === g);
        if (old) { arr.push({ ...old, stale: true }); files++; unknown++; }
        continue;
      }
      if (!name) continue;
      const d = describe(name);
      arr.push({ gubun: g, name, ext: d.ext, kind: d.kind, url: url(code, g, year) });
      files++;
      if (!GUBUN.includes(g)) surprises.push(`${code}/${g}: ${name}`);
    }
    if (arr.length) out[code] = { sido: r.parentName || '', region: r.localName || '', files: arr };
  }

  const byExt = {};
  for (const v of Object.values(out)) for (const f of v.files) byExt[f.ext] = (byExt[f.ext] || 0) + 1;

  const result = {
    year,
    timestamp: new Date().toISOString(),
    source: '기후에너지환경부 무공해차 통합누리집',
    note: '파일은 환경부 서버에서 직접 내려받습니다. 우리는 목록만 제공합니다.',
    regionCount: Object.keys(out).length,
    fileCount: files,
    askedCount: asked,      // 이번에 실제로 두드린 칸 수 — 낭비를 눈에 보이게
    unknownCount: unknown,  // 확인 실패로 이전 값을 유지한 건수 (0이어야 정상)
    scanMode: opt.known ? 'known' : 'full',
    byExt,
    surprises: surprises.slice(0, 20),
    regions: out,
  };
  log(`🔗 첨부 링크 ${files}건 · ${result.regionCount}개 지역 · ${opt.known ? '알려진 칸만' : '전수'} ${asked}회 두드림 · 형식 ${JSON.stringify(byExt)}`);
  if (unknown) log(`   ⚠️ 확인 실패 ${unknown}건 — 이전 값을 유지했다(지우지 않음)`);
  if (surprises.length) log(`   ⚠️ 새 구분: ${surprises.join(' / ')} → notice-files.js GUBUN 확장 필요`);
  return result;
}

module.exports = { buildNoticeLinks, describe, KIND };
