#!/usr/bin/env node
/**
 * 진단 v3: _getListSearch() 추출 + 호출 + AJAX 캡처
 * goPage() → _getListSearch() 가 실제 데이터 fetch 함수
 */
const puppeteer = require('puppeteer');
const fs = require('fs/promises');

const MAIN_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v3: _getListSearch() 분석 ===\n');

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
        if (phones.length > 0) {
          entry.phoneSamples = phones.slice(0, 5);
          entry.bodyFull = body.substring(0, 10000);
        }
        entry.bodySnippet = body.substring(0, 500);
      } catch {}
    }
    allResponses.push(entry);
  });

  const consoleLogs = [];
  const pageErrors = [];
  page.on('console', msg => consoleLogs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', err => pageErrors.push(err.message));

  // ========== 1. 세션 + 페이지 ==========
  console.log('1. 세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   요청 ${allRequests.length}개`);

  console.log('\n2. 전화번호 페이지...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // ========== 2. 모든 인라인 스크립트 추출 ==========
  console.log('\n3. 인라인 스크립트 분석...');
  const inlineScripts = await page.evaluate(() => {
    return [...document.querySelectorAll('script:not([src])')].map((s, i) => ({
      idx: i,
      length: s.textContent.length,
      text: s.textContent.trim(),
    })).filter(s => s.length > 0);
  });

  console.log(`   인라인 스크립트 ${inlineScripts.length}개`);
  inlineScripts.forEach(s => {
    console.log(`   [${s.idx}] ${s.length}자: ${s.text.substring(0, 150).replace(/\n/g, '\\n')}`);
  });

  // _getListSearch 포함 스크립트 찾기
  const listSearchScripts = inlineScripts.filter(s =>
    s.text.includes('_getListSearch') || s.text.includes('getListSearch')
  );
  console.log(`\n   _getListSearch 포함 스크립트: ${listSearchScripts.length}개`);
  listSearchScripts.forEach(s => {
    console.log(`   [${s.idx}] 전체 내용:\n${s.text}`);
  });

  // ========== 3. 핵심 함수 추출 ==========
  console.log('\n4. 핵심 함수 소스코드...');
  const fnInfo = await page.evaluate(() => {
    const result = {};

    // _getListSearch 관련
    const searchNames = ['_getListSearch', 'getListSearch', '_getList', 'getList',
      '_search', 'fnSearch', 'fn_search', 'doSearch', 'listSearch',
      'selectList', 'fnSelectList', 'searchList', 'goList',
      'fnPhoneList', 'fnLocalPhone', 'selectLocalPhone',
      'fnInit', 'fn_init', 'pageInit', 'fn_submit', 'doSubmit',
      'goPage', 'prePage', 'nextPage'];

    searchNames.forEach(fn => {
      try {
        if (typeof window[fn] === 'function') {
          result[fn] = window[fn].toString().substring(0, 2000);
        }
      } catch {}
    });

    // 폼 데이터 확인
    result._forms = {};
    document.querySelectorAll('form').forEach(f => {
      const formData = {};
      [...f.querySelectorAll('input, select, textarea')].forEach(el => {
        if (el.name) formData[el.name] = el.value;
      });
      result._forms[f.id || f.name || 'unnamed'] = {
        action: f.action, method: f.method, data: formData
      };
    });

    // hidden input 확인 (특히 pageId, pageNo 등)
    result._hiddenInputs = {};
    document.querySelectorAll('input[type="hidden"]').forEach(el => {
      result._hiddenInputs[el.name || el.id] = el.value;
    });

    return result;
  });

  console.log('\n   발견된 함수:');
  for (const [fn, src] of Object.entries(fnInfo)) {
    if (fn.startsWith('_')) {
      if (fn === '_forms') {
        console.log(`\n   --- 폼 ---`);
        console.log(JSON.stringify(fnInfo._forms, null, 2));
      } else if (fn === '_hiddenInputs') {
        console.log(`\n   --- Hidden inputs ---`);
        console.log(JSON.stringify(fnInfo._hiddenInputs, null, 2));
      }
      continue;
    }
    console.log(`\n   --- ${fn}() ---`);
    console.log(`   ${src}`);
  }

  // ========== 4. _getListSearch() 호출 ==========
  console.log('\n\n5. _getListSearch() 호출...');
  const preCallIdx = allRequests.length;
  const preCallResp = allResponses.length;

  const callResult = await page.evaluate(() => {
    // _getListSearch 먼저 시도
    if (typeof _getListSearch === 'function') {
      try { _getListSearch(); return { fn: '_getListSearch', called: true }; } catch (e) { return { fn: '_getListSearch', error: e.message }; }
    }
    if (typeof getListSearch === 'function') {
      try { getListSearch(); return { fn: 'getListSearch', called: true }; } catch (e) { return { fn: 'getListSearch', error: e.message }; }
    }
    // goPage 시도 (기본 파라미터)
    if (typeof goPage === 'function') {
      try {
        // goPage의 소스에서 확인: goPage(pageId, recordCountPerPage, currentPage)
        // hidden input에서 pageId 추출
        const pageId = document.querySelector('#spageId')?.value || '';
        const recordCount = document.querySelector('#srecordCountPerPage')?.value || '10';
        goPage(pageId, parseInt(recordCount) || 10, 1);
        return { fn: 'goPage', called: true, args: [pageId, recordCount, 1] };
      } catch (e) { return { fn: 'goPage', error: e.message }; }
    }
    return { fn: 'none', called: false };
  });

  console.log(`   결과: ${JSON.stringify(callResult)}`);

  // 5초 대기
  console.log('   5초 대기...');
  await new Promise(r => setTimeout(r, 5000));

  const newRequests = allRequests.slice(preCallIdx);
  const newResponses = allResponses.slice(preCallResp);

  console.log(`\n   새 요청 ${newRequests.length}개:`);
  newRequests.forEach(r => {
    console.log(`     ${r.method} ${r.url}`);
    if (r.postData) console.log(`       POST: ${r.postData.substring(0, 500)}`);
  });

  console.log(`\n   새 응답 ${newResponses.length}개:`);
  newResponses.forEach(r => {
    console.log(`     ${r.status} ${r.url} ct=${r.ct} size=${r.bodySize || '?'} phones=${r.phoneCount || 0}`);
    if (r.phoneSamples) console.log(`       전화샘플: ${r.phoneSamples.join(', ')}`);
    if (r.bodySnippet) console.log(`       본문: ${r.bodySnippet.substring(0, 300)}`);
  });

  // DOM 확인
  const postDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    const tbodyTrs = document.querySelectorAll('table tbody tr');
    const samples = [...tbodyTrs].slice(0, 5).map(tr => tr.textContent.trim().substring(0, 200));
    return {
      phoneCount: phones.length,
      phoneSamples: phones.slice(0, 10),
      tbodyRows: tbodyTrs.length,
      rowSamples: samples,
    };
  });

  console.log(`\n   DOM: 전화번호=${postDOM.phoneCount}개, tbody행=${postDOM.tbodyRows}`);
  if (postDOM.phoneSamples.length > 0) console.log(`   샘플: ${postDOM.phoneSamples.join(', ')}`);
  postDOM.rowSamples.forEach((s, i) => console.log(`   행[${i}]: ${s}`));

  // ========== 5. 추가 10초 대기 ==========
  console.log('\n6. 추가 10초 대기...');
  await new Promise(r => setTimeout(r, 10000));

  const extraReqs = allRequests.slice(preCallIdx + newRequests.length);
  const extraResps = allResponses.slice(preCallResp + newResponses.length);
  console.log(`   추가 요청 ${extraReqs.length}개, 응답 ${extraResps.length}개`);
  extraReqs.forEach(r => {
    console.log(`     ${r.method} ${r.url}`);
    if (r.postData) console.log(`       POST: ${r.postData.substring(0, 500)}`);
  });
  extraResps.forEach(r => {
    console.log(`     ${r.status} ${r.url} phones=${r.phoneCount || 0}`);
    if (r.phoneSamples) console.log(`       전화: ${r.phoneSamples.join(', ')}`);
    if (r.bodySnippet) console.log(`       본문: ${r.bodySnippet.substring(0, 300)}`);
  });

  const finalDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    const tbodyTrs = document.querySelectorAll('table tbody tr');
    return {
      phoneCount: phones.length,
      phoneSamples: phones.slice(0, 10),
      tbodyRows: tbodyTrs.length,
      rowSamples: [...tbodyTrs].slice(0, 5).map(tr => tr.textContent.trim().substring(0, 200)),
    };
  });
  console.log(`\n   최종: 전화번호=${finalDOM.phoneCount}개, tbody행=${finalDOM.tbodyRows}`);
  if (finalDOM.phoneSamples.length > 0) console.log(`   샘플: ${finalDOM.phoneSamples.join(', ')}`);
  finalDOM.rowSamples.forEach((s, i) => console.log(`   행[${i}]: ${s}`));

  // ========== 6. 전체 HTML 저장 ==========
  const html = await page.content();
  await browser.close();

  const report = {
    timestamp: new Date().toISOString(),
    inlineScripts: inlineScripts.map(s => ({ idx: s.idx, length: s.length, text: s.text })),
    listSearchScripts,
    fnInfo,
    callResult,
    newRequestsAfterCall: newRequests,
    newResponsesAfterCall: newResponses.map(r => ({ url: r.url, status: r.status, ct: r.ct, bodySize: r.bodySize, phoneCount: r.phoneCount, phoneSamples: r.phoneSamples, bodySnippet: r.bodySnippet, bodyFull: r.bodyFull })),
    postDOM,
    finalDOM,
    consoleLogs: consoleLogs.slice(0, 100),
    pageErrors,
    allDoEndpoints: [...new Set(allRequests.filter(r => r.url.includes('.do')).map(r => `${r.method} ${r.url}`))],
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));
  await fs.writeFile('data/diag-phone.html', html);

  console.log('\n✅ data/diag-phone.json');
  console.log('✅ data/diag-phone.html');

  console.log('\n========== 핵심 요약 ==========');
  console.log(`_getListSearch 존재: ${!!fnInfo._getListSearch || !!fnInfo.getListSearch}`);
  console.log(`goPage 존재: ${!!fnInfo.goPage}`);
  console.log(`호출 결과: ${JSON.stringify(callResult)}`);
  console.log(`호출 후 새 요청: ${newRequests.length}개`);
  console.log(`최종 전화번호: ${finalDOM.phoneCount}개`);
  console.log(`최종 tbody 행: ${finalDOM.tbodyRows}개`);
  console.log(`인라인 스크립트: ${inlineScripts.length}개`);
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
