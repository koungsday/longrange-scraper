/**
 * 환경부 「지자체별 보조금 현황」 페이지에서 Excel 을 받아 Buffer 로 돌려준다.
 *
 * ★두 스크래퍼(현황·모델별 보조금)가 같은 파일 하나를 쓴다.
 *   2026-08-16 개편으로 둘 다 대상이 사라졌고(현황=table 소멸, 모델=페이지 500),
 *   그 데이터가 전부 이 Excel 한 장에 들어 있다. 받는 곳을 한 군데로 모아
 *   다음에 또 바뀌면 여기만 고치면 되게 한다.
 *
 * ★POST 를 직접 흉내내지 않는다: 요청에 난독화 스크립트(pnp4web)가 만드는 pnph
 *   토큰이 붙는다. 버튼을 누르면 그 토큰은 사이트가 알아서 만든다.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const PAGE_URL = (code = 1100) =>
  `https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do?local_cd=${code}`;

/** 파일이 1.9MB 라 보통 몇 초면 끝난다. */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * @param {import('puppeteer').Page} page  이미 PAGE_URL 로 이동해 둔 페이지
 * @returns {Promise<Buffer>} xlsx 내용
 */
async function downloadExcel(page, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evxlsx-'));
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

    // 버튼 문구가 'Excel 다운로드' 다. 아이콘만 바뀌어도 견디도록 부분일치로 찾는다.
    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, input[type=button]')];
      const t = els.find((e) => ((e.innerText || e.value || '').replace(/\s/g, '')).includes('Excel'));
      if (!t) return false;
      t.click();
      return true;
    });
    if (!clicked) throw new Error("'Excel 다운로드' 버튼을 찾지 못했습니다 (페이지가 또 바뀌었을 수 있음)");

    // .crdownload 가 사라지고 .xlsx 가 안정될 때까지 기다린다.
    const deadline = Date.now() + timeoutMs;
    let file = null;
    while (Date.now() < deadline) {
      const names = await fs.readdir(dir);
      const done = names.filter((n) => n.toLowerCase().endsWith('.xlsx'));
      if (done.length && !names.some((n) => n.endsWith('.crdownload'))) { file = path.join(dir, done[0]); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!file) throw new Error(`Excel 다운로드가 ${timeoutMs / 1000}초 안에 끝나지 않았습니다`);

    const buf = await fs.readFile(file);
    if (buf.slice(0, 2).toString('hex') !== '504b') {
      throw new Error('받은 파일이 xlsx(zip) 가 아닙니다 — 오류 페이지를 받았을 수 있습니다');
    }
    return buf;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { downloadExcel, PAGE_URL, DEFAULT_TIMEOUT_MS };
