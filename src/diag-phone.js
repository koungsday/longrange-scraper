#!/usr/bin/env node
/**
 * 진단 v4: pnp4web 우회 — 원본 HTML 분석 + _getListSearch 주입 + 엔드포인트 브루트포스
 *
 * 발견 사실:
 * - initPage() = 페이지네이션 헬퍼 (paging.js)
 * - goPage() → _getListSearch() = 실제 AJAX 함수
 * - _getListSearch is NOT defined → pnp4web이 인라인 스크립트를 복호화 못함
 * - 인라인 스크립트 0개 → pnp4web 암호화가 브라우저 감지로 차단
 *
 * 전략: 원본 HTML에서 _getListSearch 엔드포인트를 찾거나 직접 주입하여 호출
 */
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs/promises');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v4: pnp4web 우회 + 엔드포인트 탐색 ===\n');

  // ========== PART A: 원본 HTTP 응답 분석 (Puppeteer 없이) ==========
  console.log('===== PART A: 원본 HTTP 분석 =====\n');

  let cookies = '';
  try {
    // 세션 수립
    console.log('A1. 세션 수립 (axios)...');
    const sessionResp = await axios.get(MAIN_URL, {
      headers: { 'User-Agent': REAL_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      timeout: 30000, validateStatus: () => true,
    });
    const setCookies = sessionResp.headers['set-cookie'];
    if (setCookies) cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log(`   쿠키: ${cookies.substring(0, 100)}`);

    // 전화번호 페이지 원본 HTML
    console.log('\nA2. 원본 HTML 가져오기...');
    const phoneResp = await axios.get(PHONE_URL, {
      headers: {
        'User-Agent': REAL_UA, 'Cookie': cookies,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': MAIN_URL,
      },
      timeout: 30000, validateStatus: () => true,
    });

    const rawHtml = typeof phoneResp.data === 'string' ? phoneResp.data : JSON.stringify(phoneResp.data);
    console.log(`   상태: ${phoneResp.status}, 크기: ${rawHtml.length}`);

    // 원본 HTML 저장
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile('data/raw-phone.html', rawHtml);
    console.log('   ✅ data/raw-phone.html 저장');

    // 원본 HTML 분석
    console.log('\nA3. 원본 HTML 패턴 분석...');

    // _getListSearch 검색
    const getListIdx = rawHtml.indexOf('_getListSearch');
    if (getListIdx >= 0) {
      console.log(`   ✅ _getListSearch 발견! 위치: ${getListIdx}`);
      console.log(`   주변 코드: ${rawHtml.substring(Math.max(0, getListIdx - 300), getListIdx + 500)}`);
    } else {
      console.log('   ❌ _getListSearch 없음 (원본 HTML)');
    }

    // eGovFrame 패턴 검색
    const patterns = ['selectPsLocalPhone', 'LocalPhone', 'phoneList', 'Phone.do',
      'selectList', 'listSearch', 'ajax', '$.ajax', '$.post', '$.get',
      'searchForm', 'listForm', 'pageIndex', 'pageUnit', 'pageSize',
      'spageId', 'spageNo', 'srecordCountPerPage',
      'function _get', 'function fn', 'function search'];

    console.log('\n   패턴 검색:');
    for (const p of patterns) {
      const idx = rawHtml.indexOf(p);
      if (idx >= 0) {
        console.log(`   ✅ "${p}" 위치 ${idx}: ${rawHtml.substring(Math.max(0, idx - 50), idx + 200).replace(/\n/g, '\\n')}`);
      }
    }

    // script 태그 분석
    const scriptMatches = rawHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    console.log(`\n   <script> 태그: ${scriptMatches.length}개`);
    scriptMatches.forEach((s, i) => {
      const isSrc = s.match(/src\s*=\s*["']([^"']+)["']/);
      if (isSrc) {
        console.log(`   [${i}] 외부: ${isSrc[1]}`);
      } else {
        const content = s.replace(/<\/?script[^>]*>/gi, '').trim();
        if (content.length > 0) {
          console.log(`   [${i}] 인라인 (${content.length}자): ${content.substring(0, 300).replace(/\n/g, '\\n')}`);
        } else {
          console.log(`   [${i}] 빈 스크립트`);
        }
      }
    });

    // pnp4web 관련 패턴
    const pnpPatterns = ['pnp4web', 'pnp_', 'evbm.ev.or.kr', 'encrypt', 'decrypt', 'cipher'];
    console.log('\n   pnp4web 패턴:');
    for (const p of pnpPatterns) {
      const idx = rawHtml.indexOf(p);
      if (idx >= 0) {
        console.log(`   ✅ "${p}" 위치 ${idx}: ${rawHtml.substring(Math.max(0, idx - 30), idx + 150).replace(/\n/g, '\\n')}`);
      }
    }

    // form 태그 분석
    const formMatches = rawHtml.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
    console.log(`\n   <form> 태그: ${formMatches.length}개`);
    formMatches.forEach((f, i) => {
      console.log(`   [${i}] ${f.substring(0, 500).replace(/\n/g, '\\n')}`);
    });

    // input 분석
    const inputMatches = rawHtml.match(/<input[^>]*>/gi) || [];
    console.log(`\n   <input> 태그: ${inputMatches.length}개`);
    inputMatches.forEach((inp, i) => {
      console.log(`   [${i}] ${inp}`);
    });

  } catch (err) {
    console.log(`   ⚠️ HTTP 분석 실패: ${err.message}`);
  }

  // ========== PART B: 직접 AJAX 엔드포인트 테스트 ==========
  console.log('\n\n===== PART B: AJAX 엔드포인트 브루트포스 =====\n');

  // goPage 파라미터 기반 + eGovFrame 표준 파라미터
  const paramSets = [
    // goPage 스타일
    { spageNo: '1', srecordCountPerPage: '200', spageId: '', sageSize: '10' },
    // eGovFrame 표준
    { pageIndex: '1', pageUnit: '200', pageSize: '200' },
    // 혼합
    { pageIndex: '1', pageUnit: '200', pageSize: '200', spageNo: '1', srecordCountPerPage: '200' },
    // 빈 파라미터
    {},
  ];

  const endpoints = [
    PHONE_URL,                                    // 같은 URL POST
    `${BASE}/selectPsLocalPhoneList.do`,          // eGovFrame select + List
    `${BASE}/psLocalPhoneList.do`,                // 리스트
    `${BASE}/selectLocalPhoneList.do`,            // select + List
    `${BASE}/localPhoneList.do`,                  // 리스트
    `${BASE}/selectPsLocalPhone.do`,              // select
    `${BASE}/psLocalPhoneListAction.do`,          // Action
    `${BASE}/selectBuySupprtPhoneList.do`,        // 보조금 전화
    `${BASE}/buySupprtPhoneList.do`,              // 보조금 전화
    `${BASE}/selectPhoneList.do`,                 // 일반 전화
    `${BASE}/phoneList.do`,                       // 일반 전화
    `${BASE}/psLocalPhoneAjax.do`,                // ajax
    `${BASE}/selectPsLocalPhoneListAjax.do`,      // ajax
  ];

  const commonHeaders = {
    'User-Agent': REAL_UA,
    'Cookie': cookies,
    'Referer': PHONE_URL,
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Origin': 'https://ev.or.kr',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, */*; q=0.01',
  };

  for (const url of endpoints) {
    for (let pi = 0; pi < paramSets.length; pi++) {
      const params = paramSets[pi];
      const body = new URLSearchParams(params).toString();
      try {
        const resp = await axios.post(url, body, {
          headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000, validateStatus: () => true,
          maxRedirects: 0,
        });

        const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        const phoneMatches = (raw.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
        const hasTable = raw.includes('<table') || raw.includes('<tr');
        const hasTbody = raw.includes('<tbody');
        const hasTd = raw.includes('<td');

        // 의미있는 결과만 출력
        if (phoneMatches.length > 0 || (resp.status === 200 && hasTd)) {
          console.log(`✅ POST ${url} [params${pi}] → ${resp.status} size=${raw.length} phones=${phoneMatches.length} table=${hasTable} td=${hasTd}`);
          if (phoneMatches.length > 0) {
            console.log(`   전화: ${phoneMatches.slice(0, 5).join(', ')}`);
          }
          console.log(`   응답: ${raw.substring(0, 500).replace(/\n/g, '\\n')}`);

          // 전화번호 데이터 발견! 전체 저장
          if (phoneMatches.length > 0) {
            await fs.writeFile('data/phone-ajax-response.html', raw);
            console.log(`   ✅ data/phone-ajax-response.html 저장 (${raw.length}자, ${phoneMatches.length} 전화번호)`);
          }
        } else if (resp.status === 200 && raw.length > 100) {
          console.log(`ℹ️ POST ${url} [params${pi}] → ${resp.status} size=${raw.length} phones=0 table=${hasTable}`);
        } else {
          console.log(`❌ POST ${url} [params${pi}] → ${resp.status} size=${raw.length}`);
        }
      } catch (err) {
        console.log(`❌ POST ${url} [params${pi}] → ${err.message}`);
      }
    }

    // GET도 시도
    try {
      const resp = await axios.get(url, {
        headers: { ...commonHeaders },
        timeout: 10000, validateStatus: () => true,
        maxRedirects: 0,
      });
      const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      const phoneMatches = (raw.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
      if (phoneMatches.length > 0) {
        console.log(`✅ GET ${url} → ${resp.status} size=${raw.length} phones=${phoneMatches.length}`);
        console.log(`   전화: ${phoneMatches.slice(0, 5).join(', ')}`);
        await fs.writeFile('data/phone-ajax-response.html', raw);
      }
    } catch {}
  }

  // ========== PART C: Puppeteer + _getListSearch 주입 ==========
  console.log('\n\n===== PART C: Puppeteer + _getListSearch 주입 =====\n');

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

  // 네트워크 캡처
  const ajaxRequests = [];
  const ajaxResponses = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    ajaxRequests.push({ url: req.url(), method: req.method(), postData: req.postData() || null });
    req.continue();
  });
  page.on('response', async res => {
    const entry = { url: res.url(), status: res.status(), ct: res.headers()['content-type'] || '' };
    try {
      const ct = entry.ct.toLowerCase();
      if (ct.includes('html') || ct.includes('json') || ct.includes('text')) {
        const body = await res.text();
        entry.bodySize = body.length;
        const phones = (body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
        entry.phoneCount = phones.length;
        if (phones.length > 0) {
          entry.phoneSamples = phones.slice(0, 5);
          entry.body = body.substring(0, 5000);
        }
      }
    } catch {}
    ajaxResponses.push(entry);
  });

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push({ type: msg.type(), text: msg.text() }));

  // 페이지 로드
  console.log('C1. 세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('C2. 전화번호 페이지...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // pnp4web 복호화 폴링 (30초)
  console.log('\nC3. pnp4web 복호화 대기 (30초 폴링)...');
  let decrypted = false;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await page.evaluate(() => {
      const hasGetList = typeof _getListSearch === 'function';
      const inlineCount = [...document.querySelectorAll('script:not([src])')].filter(s => s.textContent.trim().length > 0).length;
      const tbodyRows = document.querySelectorAll('table tbody tr').length;
      return { hasGetList, inlineCount, tbodyRows };
    });
    console.log(`   ${(i + 1) * 2}s: _getListSearch=${check.hasGetList} inline=${check.inlineCount} tbody=${check.tbodyRows}`);
    if (check.hasGetList || check.tbodyRows > 0) {
      decrypted = true;
      console.log('   ✅ 복호화 성공!');
      break;
    }
  }

  if (!decrypted) {
    console.log('   ❌ 30초 후에도 복호화 안 됨');
  }

  // _getListSearch 주입 후 AJAX 호출
  console.log('\nC4. _getListSearch 주입 + AJAX 엔드포인트 테스트...');

  // 먼저 검색폼 생성 (없을 수 있으므로)
  const injectionResults = [];
  const testEndpoints = [
    `${BASE}/selectPsLocalPhoneList.do`,
    PHONE_URL,
    `${BASE}/psLocalPhoneList.do`,
    `${BASE}/selectLocalPhoneList.do`,
  ];

  const preInjectIdx = ajaxRequests.length;

  for (const ep of testEndpoints) {
    const preReq = ajaxRequests.length;
    console.log(`\n   _getListSearch 주입 → POST ${ep}...`);

    const result = await page.evaluate((url) => {
      return new Promise((resolve) => {
        // 검색폼 hidden inputs 생성 (없으면)
        if (!document.querySelector('#searchForm')) {
          const form = document.createElement('form');
          form.id = 'searchForm';
          form.style.display = 'none';
          ['spageNo', 'srecordCountPerPage', 'spageId', 'sageSize', 'pageIndex', 'pageUnit', 'pageSize'].forEach(name => {
            const inp = document.createElement('input');
            inp.type = 'hidden';
            inp.name = name;
            inp.id = name;
            form.appendChild(inp);
          });
          document.body.appendChild(form);
        }

        // 값 설정
        const setVal = (id, val) => { const el = document.querySelector(`#${id}`); if (el) el.value = val; };
        setVal('spageNo', '1');
        setVal('srecordCountPerPage', '200');
        setVal('spageId', '');
        setVal('sageSize', '10');
        setVal('pageIndex', '1');
        setVal('pageUnit', '200');
        setVal('pageSize', '200');

        $.ajax({
          type: 'POST',
          url: url,
          data: $('#searchForm').serialize(),
          dataType: 'html',
          timeout: 10000,
          success: function(data) {
            const phones = (data.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
            resolve({
              url, success: true, size: data.length,
              phoneCount: phones.length,
              phoneSamples: phones.slice(0, 5),
              snippet: data.substring(0, 500),
              hasTd: data.includes('<td'),
            });
          },
          error: function(xhr, status, err) {
            resolve({ url, success: false, status: xhr.status, error: err || status });
          },
        });
      });
    }, ep);

    console.log(`   결과: ${JSON.stringify(result)}`);
    injectionResults.push(result);

    if (result.success && result.phoneCount > 0) {
      console.log(`   🎉 전화번호 ${result.phoneCount}개 발견!`);
      console.log(`   샘플: ${result.phoneSamples.join(', ')}`);

      // 전체 데이터 가져오기
      const fullData = await page.evaluate((url) => {
        return new Promise((resolve) => {
          $.ajax({
            type: 'POST', url: url,
            data: $('#searchForm').serialize(),
            dataType: 'html', timeout: 15000,
            success: function(data) { resolve(data); },
            error: function() { resolve(''); },
          });
        });
      }, ep);

      if (fullData) {
        await fs.writeFile('data/phone-ajax-response.html', fullData);
        console.log(`   ✅ data/phone-ajax-response.html 저장 (${fullData.length}자)`);
      }
      break; // 성공하면 중단
    }
  }

  // 최종 DOM 확인
  const finalDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    return {
      phoneCount: phones.length,
      phoneSamples: phones.slice(0, 10),
      tbodyRows: document.querySelectorAll('table tbody tr').length,
    };
  });

  const html = await page.content();
  await browser.close();

  // 보고서
  const report = {
    timestamp: new Date().toISOString(),
    partB_endpoints: endpoints.length,
    partC_decrypted: decrypted,
    partC_injectionResults: injectionResults,
    finalDOM,
    consoleLogs: consoleLogs.slice(0, 50),
  };

  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));
  await fs.writeFile('data/diag-phone.html', html);

  console.log('\n✅ data/diag-phone.json');
  console.log('✅ data/diag-phone.html');

  console.log('\n========== 핵심 요약 ==========');
  console.log(`pnp4web 복호화: ${decrypted}`);
  console.log(`AJAX 주입 결과: ${injectionResults.filter(r => r.success && r.phoneCount > 0).length}개 성공`);
  console.log(`최종 전화번호: ${finalDOM.phoneCount}개`);

  const successEndpoints = injectionResults.filter(r => r.success && r.phoneCount > 0);
  if (successEndpoints.length > 0) {
    console.log(`\n🎉 발견된 엔드포인트:`);
    successEndpoints.forEach(r => console.log(`   POST ${r.url} → ${r.phoneCount}개 전화번호`));
  }
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
