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
 *   → 모바일에서 .hwp 를 받으면 열지도 못한다. 우리는 Content-Disposition 에서
 *     파일명을 알므로 **무슨 형식인지, 폰에서 열리는지**를 미리 알려줄 수 있다.
 *
 * ※크기는 넣지 않는다 — HEAD 응답의 Content-Length 가 0 이라 알 수 없고,
 *   알려면 본문을 받아야 하는데 그러면 이 설계의 이점이 사라진다.
 */

const { filenameOf, GUBUN, GUBUN_PROBE, url } = require('./notice-files');

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; vw-k-subsidy-links/1.0)' };

/** 확장자 → 사람이 읽는 형식 + 폰에서 바로 열리는지. */
const KIND = {
  pdf:  { kind: 'PDF',    mobileOpen: true,  note: '' },
  hwpx: { kind: '한글문서', mobileOpen: false, note: '한글 프로그램 또는 뷰어 필요' },
  hwtx: { kind: '한글서식', mobileOpen: false, note: '한글 프로그램 또는 뷰어 필요' },
  hwp:  { kind: '한글문서(구형)', mobileOpen: false, note: '한글 프로그램 또는 뷰어 필요' },
  xlsx: { kind: '엑셀',    mobileOpen: false, note: '엑셀 또는 뷰어 필요' },
  xls:  { kind: '엑셀(구형)', mobileOpen: false, note: '엑셀 또는 뷰어 필요' },
  zip:  { kind: '압축파일', mobileOpen: false, note: '압축을 풀어야 함' },
};
const describe = (name) => {
  const s = String(name);
  // ★점이 없으면 확장자가 없는 것이다. split('.').pop() 은 이름 전체를 돌려주므로
  //   그대로 쓰면 "확장자없음" 같은 파일명이 형식으로 표시된다.
  const ext = s.includes('.') ? (s.split('.').pop() || '').toLowerCase() : '';
  return { ext, ...(KIND[ext] || { kind: ext ? ext.toUpperCase() : '파일', mobileOpen: false, note: '' }) };
};

/** 본문을 받지 않고 "무엇이 있는지"만. 없으면 null. */
async function peek(code, gubun, year) {
  try {
    const res = await fetch(url(code, gubun, year), { method: 'HEAD', headers: UA });
    if (!res.ok) return null;
    const name = filenameOf(res.headers);
    return name ? name : null;
  } catch { return null; }
}

/**
 * @param {Array<{code:string|number, localName?:string, parentName?:string}>} regions
 * @param {{year?:number, delayMs?:number, probe?:boolean, log?:Function}} opt
 */
async function buildNoticeLinks(regions, opt = {}) {
  const year = opt.year || new Date().getFullYear();
  const delay = opt.delayMs ?? 1000;      // HEAD 는 1초면 안정적(실측 6/6)
  const log = opt.log || console.log;
  // ★가끔 넓게 훑는다. 처음에 A계열만 보다가 B(93건)·C(25건)를 통째로 놓쳤다.
  const list = opt.probe ? [...GUBUN, ...GUBUN_PROBE] : GUBUN;

  const out = {};
  const surprises = [];
  let files = 0;
  for (const r of regions) {
    const code = String(r.code);
    const arr = [];
    for (const g of list) {
      const name = await peek(code, g, year);
      await new Promise((s) => setTimeout(s, delay));
      if (!name) continue;
      const d = describe(name);
      arr.push({ gubun: g, name, ext: d.ext, kind: d.kind, mobileOpen: d.mobileOpen, note: d.note,
        url: url(code, g, year) });
      files++;
      if (!GUBUN.includes(g)) surprises.push(`${code}/${g}: ${name}`);
    }
    if (arr.length) out[code] = { sido: r.parentName || '', region: r.localName || '', files: arr };
  }

  const byExt = {};
  for (const v of Object.values(out)) for (const f of v.files) byExt[f.ext] = (byExt[f.ext] || 0) + 1;
  const withPdf = Object.values(out).filter((v) => v.files.some((f) => f.ext === 'pdf')).length;

  const result = {
    year,
    timestamp: new Date().toISOString(),
    source: '기후에너지환경부 무공해차 통합누리집',
    note: '파일은 환경부 서버에서 직접 내려받습니다. 우리는 목록만 제공합니다.',
    regionCount: Object.keys(out).length,
    fileCount: files,
    byExt,
    regionsWithPdf: withPdf,
    surprises: surprises.slice(0, 20),
    regions: out,
  };
  log(`🔗 첨부 링크 ${files}건 · ${result.regionCount}개 지역 · 형식 ${JSON.stringify(byExt)}`);
  log(`   PDF 가 있는 지역 ${withPdf}/${result.regionCount} (폰에서 바로 열림)`);
  if (surprises.length) log(`   ⚠️ 새 구분: ${surprises.join(' / ')} → notice-files.js GUBUN 확장 필요`);
  return result;
}

module.exports = { buildNoticeLinks, describe, KIND };
