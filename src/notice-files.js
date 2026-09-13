/**
 * 지자체 공고문·첨부파일 수집.
 *
 * ★Excel 과 달리 브라우저가 필요 없다.
 *   현황 데이터는 페이지 본문이 난독화(pnp4web)돼 있어 Excel 버튼을 눌러야 하지만,
 *   **파일은 난독화 대상이 아니다.** 평범한 GET 으로 받아진다(pnph 토큰도 불필요).
 *   그래서 이 모듈은 puppeteer 를 안 쓴다 — 훨씬 빠르고 싸다.
 *
 * ★★없는 첨부는 HTTP 200 + 240KB HTML 에러 페이지로 온다.
 *   크기(240,018)로 거르면 그쪽이 에러 페이지 디자인만 바꿔도 뚫린다.
 *   **Content-Disposition 유무**로 판정한다 — 그게 "파일을 준다"는 유일한 선언이다.
 *   이 가드가 없으면 에러 HTML 을 .hwpx 로 저장하고, 나중에 열어야 알게 된다.
 *
 * ★attach_gubun 공간은 관찰로 알아낸 것이지 문서화된 API 가 아니다.
 *   처음에 A/A02/A03 만 훑어 **B(92/161 지역)를 통째로 놓쳤고**, 넓혀 보니 C 도 있었다.
 *   그래서 목록을 상수로 박아 두되, 주기적으로 넓게 훑어 새 값이 생겼는지 본다.
 */

const BASE = 'https://ev.or.kr/nportal/ps/comm/noticeFile/download.do';

/** 전수 탐색으로 확인된 구분. 새 값이 생길 수 있으므로 여유분을 함께 훑는다.
 *  ★D 승격(2026-09-03) — 탐침이 경남 김해시(4825)에서 잡았다:
 *    "2026년 전기자동차(승용 화물 승합) 보급사업 4차 공고.hwpx".
 *    그 지역의 A/B 는 2차, C 는 3차라 **D 가 가장 최신 차수**다. 진짜 값이다.
 *    ⚠️ 승격해도 요청 수는 안 는다 — 호출부 둘 다 probe:true 라 D 는 이미 두드리고 있었다
 *       (scraper-quota.js:655 · build-notice-links.js:59). 바뀌는 건 '놀람' 으로 계속
 *       알림이 울리느냐뿐이다. 안 넓히면 같은 알림이 매일 온다. */
const GUBUN = ['A', 'A02', 'A03', 'B', 'C', 'D'];
/** 정기 점검용 — 여기서 뭔가 잡히면 GUBUN 을 넓혀야 한다는 신호다.
 *  ★E 를 새 최전선으로 둔다 — **성장은 알파벳으로 일어났다**(A→B→C→D).
 *    2026-09-03 실측(402건 전수): A 144 · B 99 · A02 93 · C 33 · A03 32 · D 1.
 *  ⚠️ **A04·A05·B02·B03·C02 는 한 번도 잡힌 적이 없다.** 숫자 변형은 A 계열에만 있다.
 *     지우지는 않았다(넣은 사람의 판단을 뒤집을 근거가 부족하다). 다만 전수 훑기에서
 *     지역당 5칸씩 = 주당 805회를 헛두드린다. 정리하려면 이 줄을 근거로 삼으면 된다. */
const GUBUN_PROBE = ['A04', 'A05', 'B02', 'B03', 'C02', 'E'];

const url = (code, gubun, year) =>
  `${BASE}?year=${year}&local_cd=${code}&attach_gubun=${gubun}&model_gubun=car&car_type=11`;

/** Content-Disposition 의 filename 을 사람이 읽는 이름으로. URL 인코딩돼 온다. */
function filenameOf(headers) {
  const cd = headers.get('content-disposition');
  if (!cd) return null;                       // ★파일이 아니다. 에러 페이지다.
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
}

/** 확장자별 매직바이트 — 이름만 믿지 않는다. */
function looksLike(buf, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const hex = buf.subarray(0, 4).toString('hex');
  if (['hwpx', 'xlsx', 'docx', 'zip', 'hwtx'].includes(ext)) return hex.startsWith('504b');   // PK
  if (ext === 'pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (['hwp', 'xls', 'doc'].includes(ext)) return hex === 'd0cf11e0';                          // CFB
  return true;                                                                                 // 모르는 형식은 통과
}

/**
 * 한 건 받기.
 * @returns {{ok:true,name,buf,size} | {ok:false,reason:string}}
 */
async function fetchOne(code, gubun, year = new Date().getFullYear()) {
  let res;
  try {
    res = await fetch(url(code, gubun, year), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vw-k-subsidy-archive/1.0)' },
    });
  } catch (e) {
    return { ok: false, reason: `요청 실패: ${e.message}` };
  }
  // ★실패 응답도 본문이 240KB 다(에러 페이지). 읽지 말고 즉시 버린다 —
  //   안 그러면 없는 첨부 하나당 240KB 를 괜히 받는다.
  if (!res.ok) {
    res.body?.cancel?.().catch(() => {});
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  const name = filenameOf(res.headers);
  if (!name) {
    res.body?.cancel?.().catch(() => {});
    return { ok: false, reason: '첨부 없음(Content-Disposition 없음)' };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, reason: '본문 0바이트' };
  if (!looksLike(buf, name)) {
    // 이름은 .hwpx 인데 내용이 zip 이 아닌 경우 등 — 조용히 저장하면 나중에 열어야 안다.
    return { ok: false, reason: `내용이 확장자와 다름 (${name}, 앞 4바이트 ${buf.subarray(0, 4).toString('hex')})` };
  }
  return { ok: true, name, buf, size: buf.length };
}

/**
 * 전 지역 훑기.
 * @param {string[]} codes 지역코드
 * @param {{year?:number, gubun?:string[], probe?:boolean, onFile?:Function, delayMs?:number}} opt
 */
async function collect(codes, opt = {}) {
  const year = opt.year || new Date().getFullYear();
  const list = opt.gubun || (opt.probe ? [...GUBUN, ...GUBUN_PROBE] : GUBUN);
  const files = [];
  const misses = [];
  const surprises = [];      // GUBUN 밖에서 잡힌 것 = 공간이 넓어졌다는 신호
  for (const code of codes) {
    for (const g of list) {
      const r = await fetchOne(code, g, year);
      if (r.ok) {
        files.push({ code, gubun: g, name: r.name, size: r.size, buf: r.buf });
        if (!GUBUN.includes(g)) surprises.push(`${code}/${g}: ${r.name}`);
        if (opt.onFile) await opt.onFile(files[files.length - 1]);
      } else if (!/첨부 없음/.test(r.reason)) {
        misses.push({ code, gubun: g, reason: r.reason });   // '없음' 은 정상이라 안 센다
      }
      if (opt.delayMs) await new Promise((s) => setTimeout(s, opt.delayMs));
    }
  }
  return { files, misses, surprises };
}

module.exports = { collect, fetchOne, filenameOf, looksLike, GUBUN, GUBUN_PROBE, url };
