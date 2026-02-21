#!/usr/bin/env node
/**
 * 진단 스크립트 v2: initPage() 호출 + 소스 분석 + AJAX 캡처
 * 핵심: initPage()가 어떤 엔드포인트를 호출하는지 밝히기
 */
const puppeteer = require('puppeteer');
const fs = require('fs/promises');

const MAIN_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v2: initPage() 분석 ===\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();

  await page.setUserAgent(REAL_UA);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  // ========== 네트워크 캡처 ==========
  const allRequests = [];
  const allResponses = [];

  await page.setRequestInterception(true);
  page.on('request', req => {
    allRequests.push({
      url: req.url(),
      method: req.method(),
      type: req.resourceType(),
      postData: req.postData() || null,
      timestamp: Date.now(),
    });
    req.continue();
  });

  page.on('response', async res => {
    const entry = {
      url: res.url(),
      status: res.status(),
      ct: res.headers()['content-type'] || '',
      timestamp: Date.now(),
    };
    const ct = entry.ct.toLowerCase();
    if (ct.includes('html') || ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
      try {
        const body = await res.text();
        entry.bodySize = body.length;
        const phones = (body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
        entry.phoneCount = phones.length;
        if (phones.length > 0) entry.phoneSamples = phones.slice(0, 5);
        // initPage 관련 코드 검색
        if (ct.includes('javascript') && body.includes('initPage')) {
          entry.hasInitPage = true;
          // initPage 함수 정의 주변 코드 추출
          const idx = body.indexOf('initPage');
          entry.initPageContext = body.substring(Math.max(0, idx - 200), idx + 500);
        }
        entry.bodySnippet = body.substring(0, 300);
      } catch {}
    }
    allResponses.push(entry);
  });

  // 콘솔 + 에러
  const consoleLogs = [];
  const pageErrors = [];
  page.on('console', msg => consoleLogs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', err => pageErrors.push(err.message));

  // ========== 1. 세션 수립 ==========
  console.log('1. 세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   요청 ${allRequests.length}개`);

  const prePhoneIdx = allRequests.length;

  // ========== 2. 전화번호 페이지 ==========
  console.log('\n2. 전화번호 페이지...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   새 요청 ${allRequests.length - prePhoneIdx}개`);

  // ========== 3. 외부 JS 파일 분석 ==========
  console.log('\n3. 외부 JS 파일 분석...');
  const scriptSrcs = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map(s => s.src)
  );
  console.log(`   외부 JS ${scriptSrcs.length}개:`);
  scriptSrcs.forEach(s => console.log(`     ${s}`));

  // initPage를 포함하는 JS 파일 찾기
  const jsWithInitPage = allResponses.filter(r => r.hasInitPage);
  console.log(`\n   initPage 포함 JS: ${jsWithInitPage.length}개`);
  jsWithInitPage.forEach(r => {
    console.log(`     ${r.url}`);
    console.log(`     코드: ${r.initPageContext}`);
  });

  // ========== 4. initPage 소스코드 추출 ==========
  console.log('\n4. initPage() 소스코드...');
  const initPageInfo = await page.evaluate(() => {
    const result = { exists: false };
    if (typeof initPage === 'function') {
      result.exists = true;
      result.source = initPage.toString().substring(0, 3000);
      result.name = initPage.name;
      result.length = initPage.length; // 파라미터 수
    }

    // 다른 유용한 함수도 추출
    const fnNames = ['fnSearch', 'fn_search', 'doSearch', 'fnList', 'getList',
      'selectList', 'fnSelectList', 'searchList', 'goList', 'fnPhoneList',
      'fnLocalPhone', 'selectLocalPhone', 'fnInit', 'fn_init', 'pageInit',
      'fn_submit', 'doSubmit', 'fnStsfctn', 'goPage', 'fnPage', 'init',
      'fn_egov_link_page', 'fn_egov_modal_page'];
    result.otherFunctions = {};
    fnNames.forEach(fn => {
      if (typeof window[fn] === 'function') {
        result.otherFunctions[fn] = window[fn].toString().substring(0, 1000);
      }
    });

    // jQuery 존재 여부
    result.hasJQuery = typeof $ === 'function' || typeof jQuery === 'function';
    result.jQueryVersion = typeof $.fn === 'object' ? ($.fn.jquery || 'unknown') : 'none';

    return result;
  });

  if (initPageInfo.exists) {
    console.log(`   ✅ initPage 발견! (파라미터 ${initPageInfo.length}개)`);
    console.log(`   소스코드:\n${initPageInfo.source}`);
  } else {
    console.log('   ❌ initPage 없음');
  }

  console.log(`\n   jQuery: ${initPageInfo.hasJQuery ? `있음 (${initPageInfo.jQueryVersion})` : '없음'}`);
  console.log(`   기타 함수: ${Object.keys(initPageInfo.otherFunctions).join(', ') || '없음'}`);
  for (const [fn, src] of Object.entries(initPageInfo.otherFunctions)) {
    console.log(`\n   --- ${fn}() ---`);
    console.log(`   ${src.substring(0, 500)}`);
  }

  // ========== 5. initPage() 호출 + AJAX 캡처 ==========
  console.log('\n\n5. initPage() 호출...');
  const preCallIdx = allRequests.length;
  const preCallConsole = consoleLogs.length;
  const preCallErrors = pageErrors.length;

  const callResult = await page.evaluate(() => {
    if (typeof initPage !== 'function') return { called: false, reason: 'not a function' };
    try {
      const result = initPage();
      return {
        called: true,
        returnValue: result !== undefined ? String(result).substring(0, 200) : 'undefined',
      };
    } catch (e) {
      return { called: false, reason: e.message, stack: e.stack?.substring(0, 500) };
    }
  });

  console.log(`   호출 결과: ${JSON.stringify(callResult)}`);

  // 5초 대기 후 새 요청/응답 확인
  console.log('   5초 대기...');
  await new Promise(r => setTimeout(r, 5000));

  const newRequests = allRequests.slice(preCallIdx);
  const newConsole = consoleLogs.slice(preCallConsole);
  const newErrors = pageErrors.slice(preCallErrors);

  console.log(`   initPage() 후 새 요청: ${newRequests.length}개`);
  newRequests.forEach(r => {
    console.log(`     ${r.method} ${r.url}`);
    if (r.postData) console.log(`       POST: ${r.postData.substring(0, 200)}`);
  });

  console.log(`   새 콘솔 메시지: ${newConsole.length}개`);
  newConsole.forEach(c => console.log(`     [${c.type}] ${c.text.substring(0, 200)}`));

  console.log(`   새 에러: ${newErrors.length}개`);
  newErrors.forEach(e => console.log(`     ${e.substring(0, 200)}`));

  // initPage 후 DOM 확인
  const postCallDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    const tables = [];
    document.querySelectorAll('table').forEach((t, i) => {
      tables.push({
        idx: i, id: t.id, cls: t.className,
        thead: t.querySelectorAll('thead tr').length,
        tbody: t.querySelectorAll('tbody tr').length,
        allTr: t.querySelectorAll('tr').length,
        sample: [...t.querySelectorAll('tr')].slice(0, 3).map(r => r.textContent.trim().substring(0, 150)),
      });
    });
    return { phoneCount: phones.length, phoneSamples: phones.slice(0, 5), tables };
  });

  console.log(`\n   DOM 전화번호: ${postCallDOM.phoneCount}개`);
  if (postCallDOM.phoneSamples.length > 0) {
    console.log(`   샘플: ${postCallDOM.phoneSamples.join(', ')}`);
  }
  console.log(`   테이블:`);
  postCallDOM.tables.forEach(t => {
    console.log(`     [${t.idx}] id="${t.id}" cls="${t.cls}" thead=${t.thead} tbody=${t.tbody} allTr=${t.allTr}`);
    t.sample.forEach(s => console.log(`       행: ${s}`));
  });

  // ========== 6. 추가 10초 대기 후 재확인 ==========
  console.log('\n6. 추가 10초 대기...');
  await new Promise(r => setTimeout(r, 10000));

  const extraRequests = allRequests.slice(preCallIdx + newRequests.length);
  console.log(`   추가 요청: ${extraRequests.length}개`);
  extraRequests.forEach(r => {
    console.log(`     ${r.method} ${r.url}`);
    if (r.postData) console.log(`       POST: ${r.postData.substring(0, 200)}`);
  });

  const finalDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    const tbodyCount = document.querySelectorAll('table tbody tr').length;
    return { phoneCount: phones.length, phoneSamples: phones.slice(0, 10), tbodyRows: tbodyCount };
  });
  console.log(`   최종 전화번호: ${finalDOM.phoneCount}개, tbody행: ${finalDOM.tbodyRows}`);

  // ========== 7. 전체 HTML 및 보고서 저장 ==========
  const html = await page.content();
  await browser.close();

  // 보고서
  const report = {
    timestamp: new Date().toISOString(),
    initPageInfo,
    callResult,
    newRequestsAfterInit: newRequests,
    newConsoleAfterInit: newConsole,
    newErrorsAfterInit: newErrors,
    postCallDOM,
    finalDOM,
    scriptSrcs,
    jsWithInitPage: jsWithInitPage.map(r => ({ url: r.url, context: r.initPageContext })),
    allDoEndpoints: [...new Set(allRequests.filter(r => r.url.includes('.do')).map(r => `${r.method} ${r.url}`))],
    responsesWithPhones: allResponses.filter(r => r.phoneCount > 0),
    consoleLogs: consoleLogs.slice(0, 100),
    pageErrors,
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));
  await fs.writeFile('data/diag-phone.html', html);

  console.log('\n✅ data/diag-phone.json 저장');
  console.log('✅ data/diag-phone.html 저장');

  // ========== 핵심 요약 ==========
  console.log('\n========== 핵심 요약 ==========');
  console.log(`initPage 존재: ${initPageInfo.exists}`);
  console.log(`initPage 호출: ${callResult.called}`);
  console.log(`initPage 후 새 요청: ${newRequests.length}개`);
  console.log(`initPage 후 새 에러: ${newErrors.length}개`);
  console.log(`최종 전화번호: ${finalDOM.phoneCount}개`);
  console.log(`최종 tbody 행: ${finalDOM.tbodyRows}개`);
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
