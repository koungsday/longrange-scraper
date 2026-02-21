#!/usr/bin/env node
/**
 * 진단 v6: document.write 전체 캡처 + v() 필터 우회 + innerHTML 구조 분석
 *
 * v5 발견:
 * - pnp4web 복호화 성공: document.write로 436KB 출력
 * - 하지만 스크립트 0개, _getListSearch 없음, 전화번호 0개
 * - body innerHTML 412KB인데 innerText 73자 (대부분 숨겨진 HTML)
 * - v(t) 함수가 스크립트를 필터링하는 것으로 추정
 *
 * 전략:
 * 1. document.write 전체 436KB 저장 + 완전한 패턴 검색
 * 2. Puppeteer에서 zn.dc() 직접 호출 (v() 필터 우회)
 * 3. innerHTML 구조 분석 (412KB의 실체)
 */
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs/promises');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v6: 전체 캡처 + v() 우회 ===\n');
  await fs.mkdir('data', { recursive: true });

  // 암호화 blob 추출
  console.log('1. 암호화 blob 추출...');
  let encryptedBlob = '';
  try {
    const sessionResp = await axios.get(MAIN_URL, {
      headers: { 'User-Agent': REAL_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      timeout: 30000, validateStatus: () => true,
    });
    const cookies = (sessionResp.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const phoneResp = await axios.get(PHONE_URL, {
      headers: { 'User-Agent': REAL_UA, 'Cookie': cookies, 'Referer': MAIN_URL, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      timeout: 30000, validateStatus: () => true,
    });
    const rawHtml = typeof phoneResp.data === 'string' ? phoneResp.data : '';

    const onloadMatch = rawHtml.match(/onload='_0xac\("([^"]+)"\)/);
    if (onloadMatch) {
      encryptedBlob = onloadMatch[1];
      console.log(`   blob: ${encryptedBlob.length}자`);
    } else {
      console.log('   ❌ blob 추출 실패');
    }
  } catch (err) {
    console.log(`   ⚠️ ${err.message}`);
  }

  // ========== Puppeteer ==========
  console.log('\n2. Puppeteer...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setUserAgent(REAL_UA);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  // document.write 전체 캡처
  await page.evaluateOnNewDocument(() => {
    window.__pnpWriteAll = '';
    const origOpen = document.open.bind(document);
    const origWrite = document.write.bind(document);
    const origClose = document.close.bind(document);
    document.open = function() { window.__pnpWriteAll = ''; return origOpen(); };
    document.write = function(html) { window.__pnpWriteAll += html; return origWrite(html); };
    document.close = function() { return origClose(); };
  });

  console.log('   세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('   전화번호 페이지...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // ========== 3. document.write 전체 저장 + 분석 ==========
  console.log('\n3. document.write 전체 분석...');
  const writeAnalysis = await page.evaluate(() => {
    const html = window.__pnpWriteAll || '';
    const result = {
      totalLength: html.length,
    };

    // 패턴 검색
    const patterns = [
      '_getListSearch', 'getListSearch', 'listSearch', 'fnSearch',
      '$.ajax', 'jQuery.ajax', '$.post', '$.get',
      'function _get', 'function fn', 'function search',
      'selectPsLocalPhone', 'phoneList', 'Phone.do',
      'searchForm', 'listForm', '#searchForm', '#listForm',
      'spageId', 'spageNo', 'srecordCountPerPage',
      'pageIndex', 'pageUnit',
      '<script', '</script>', '<form', '</form>',
      '<tbody', '<td', 'tel', '전화', '연락처',
    ];

    result.patterns = {};
    for (const p of patterns) {
      const idx = html.indexOf(p);
      result.patterns[p] = idx >= 0 ? {
        found: true, pos: idx,
        context: html.substring(Math.max(0, idx - 100), idx + 300),
      } : { found: false };
    }

    // script 태그 추출
    const scriptMatches = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    result.scriptCount = scriptMatches.length;
    result.scripts = scriptMatches.map((s, i) => {
      const src = s.match(/src=["']([^"']+)["']/);
      const content = s.replace(/<\/?script[^>]*>/gi, '').trim();
      return {
        idx: i,
        src: src ? src[1] : null,
        contentLen: content.length,
        content: content.substring(0, 1000),
      };
    });

    // form 태그 추출
    const formMatches = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
    result.formCount = formMatches.length;
    result.forms = formMatches.map((f, i) => f.substring(0, 500));

    // input 태그 추출
    const inputMatches = html.match(/<input[^>]*>/gi) || [];
    result.inputCount = inputMatches.length;
    result.inputs = inputMatches;

    // table 구조
    const tableMatches = html.match(/<table[^>]*>/gi) || [];
    result.tableCount = tableMatches.length;

    // tbody 내용
    const tbodyMatch = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/gi) || [];
    result.tbodyCount = tbodyMatch.length;
    result.tbodies = tbodyMatch.map((t, i) => ({
      idx: i, length: t.length, snippet: t.substring(0, 500),
    }));

    // 전화번호 패턴
    const phones = (html.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    result.phoneCount = phones.length;
    result.phoneSamples = phones.slice(0, 10);

    return result;
  });

  console.log(`   전체 길이: ${writeAnalysis.totalLength}자`);
  console.log(`   스크립트: ${writeAnalysis.scriptCount}개`);
  console.log(`   폼: ${writeAnalysis.formCount}개`);
  console.log(`   인풋: ${writeAnalysis.inputCount}개`);
  console.log(`   테이블: ${writeAnalysis.tableCount}개`);
  console.log(`   tbody: ${writeAnalysis.tbodyCount}개`);
  console.log(`   전화번호: ${writeAnalysis.phoneCount}개`);
  if (writeAnalysis.phoneSamples.length > 0) {
    console.log(`   샘플: ${writeAnalysis.phoneSamples.join(', ')}`);
  }

  console.log('\n   패턴 검색 결과:');
  for (const [p, info] of Object.entries(writeAnalysis.patterns)) {
    if (info.found) {
      console.log(`   ✅ "${p}" pos=${info.pos}: ${info.context.substring(0, 200).replace(/\n/g, '\\n')}`);
    }
  }

  console.log('\n   스크립트 상세:');
  writeAnalysis.scripts.forEach(s => {
    if (s.src) {
      console.log(`   [${s.idx}] 외부: ${s.src}`);
    } else {
      console.log(`   [${s.idx}] 인라인 (${s.contentLen}자): ${s.content.substring(0, 500)}`);
    }
  });

  console.log('\n   폼 상세:');
  writeAnalysis.forms.forEach((f, i) => console.log(`   [${i}] ${f.substring(0, 300).replace(/\n/g, '\\n')}`));

  console.log('\n   인풋 상세:');
  writeAnalysis.inputs.forEach((inp, i) => console.log(`   [${i}] ${inp}`));

  console.log('\n   tbody 상세:');
  writeAnalysis.tbodies.forEach(t => {
    console.log(`   [${t.idx}] ${t.length}자: ${t.snippet.substring(0, 300).replace(/\n/g, '\\n')}`);
  });

  // 전체 document.write 내용 저장
  const fullWrite = await page.evaluate(() => window.__pnpWriteAll || '');
  if (fullWrite.length > 0) {
    await fs.writeFile('data/decrypted-full.html', fullWrite);
    console.log(`\n   ✅ data/decrypted-full.html 저장 (${fullWrite.length}자)`);
  }

  // ========== 4. zn.dc() 직접 호출 (v() 우회) ==========
  console.log('\n4. zn.dc() 직접 호출 시도 (v() 필터 우회)...');

  if (encryptedBlob) {
    const rawDecrypt = await page.evaluate((blob) => {
      // pnp4web 내부 객체 탐색
      const result = { znExists: false, dcResult: null };

      // zn 객체 찾기
      if (typeof zn !== 'undefined') {
        result.znExists = true;
        result.znType = typeof zn;
        result.znKeys = Object.keys(zn).join(', ');
        if (typeof zn.dc === 'function') {
          try {
            const raw = zn.dc(blob);
            result.dcResult = {
              length: raw.length,
              snippet: raw.substring(0, 1000),
              hasScript: raw.includes('<script'),
              hasGetList: raw.includes('_getListSearch'),
              hasAjax: raw.includes('$.ajax'),
              phoneCount: (raw.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []).length,
            };
          } catch (e) {
            result.dcError = e.message;
          }
        }
      }

      // 전역에서 복호화 관련 함수 찾기
      const candidates = ['zn', 'Zn', '_zn', 'dc', '_dc', 'decrypt', '_decrypt'];
      result.globalSearch = {};
      for (const name of candidates) {
        try {
          result.globalSearch[name] = typeof window[name];
        } catch {}
      }

      // pnp4web의 난독화 변수 확인
      try {
        result.pnpGlobals = Object.keys(window).filter(k =>
          k.startsWith('_0x') || k.startsWith('_a') || k.startsWith('zn') || k.startsWith('Zn')
        ).slice(0, 30);
      } catch {}

      return result;
    }, encryptedBlob);

    console.log(`   zn 존재: ${rawDecrypt.znExists}`);
    console.log(`   전역 검색: ${JSON.stringify(rawDecrypt.globalSearch)}`);
    if (rawDecrypt.pnpGlobals) console.log(`   pnp 전역변수: ${rawDecrypt.pnpGlobals.join(', ')}`);

    if (rawDecrypt.dcResult) {
      console.log(`\n   ✅ zn.dc() 성공!`);
      console.log(`   결과: ${rawDecrypt.dcResult.length}자`);
      console.log(`   <script>: ${rawDecrypt.dcResult.hasScript}`);
      console.log(`   _getListSearch: ${rawDecrypt.dcResult.hasGetList}`);
      console.log(`   $.ajax: ${rawDecrypt.dcResult.hasAjax}`);
      console.log(`   전화번호: ${rawDecrypt.dcResult.phoneCount}`);
      console.log(`   snippet: ${rawDecrypt.dcResult.snippet}`);

      // raw 복호화 결과 저장
      if (rawDecrypt.dcResult.hasScript || rawDecrypt.dcResult.hasGetList || rawDecrypt.dcResult.phoneCount > 0) {
        const fullRaw = await page.evaluate((blob) => {
          try { return zn.dc(blob); } catch { return ''; }
        }, encryptedBlob);
        if (fullRaw) {
          await fs.writeFile('data/decrypted-raw.html', fullRaw);
          console.log(`   ✅ data/decrypted-raw.html 저장 (${fullRaw.length}자)`);

          // _getListSearch 추출
          if (fullRaw.includes('_getListSearch')) {
            const idx = fullRaw.indexOf('_getListSearch');
            console.log(`\n   _getListSearch 컨텍스트:`);
            console.log(fullRaw.substring(Math.max(0, idx - 500), idx + 1000));
          }
        }
      }
    }
    if (rawDecrypt.dcError) console.log(`   ⚠️ zn.dc() 에러: ${rawDecrypt.dcError}`);
  }

  // ========== 5. innerHTML 구조 분석 ==========
  console.log('\n5. innerHTML 구조 분석...');
  const htmlAnalysis = await page.evaluate(() => {
    const body = document.body;
    if (!body) return { error: 'no body' };

    // 최상위 자식 요소 분석
    const children = [...body.children].map((el, i) => ({
      idx: i,
      tag: el.tagName,
      id: el.id,
      className: el.className?.toString().substring(0, 100) || '',
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
      htmlLen: el.innerHTML.length,
      textLen: el.innerText.length,
    }));

    // display:none 요소
    const hiddenEls = body.querySelectorAll('[style*="display:none"], [style*="display: none"], .hidden, .hide');
    const hiddenInfo = [...hiddenEls].slice(0, 10).map(el => ({
      tag: el.tagName, id: el.id, cls: el.className?.toString().substring(0, 50),
      htmlLen: el.innerHTML.length,
    }));

    // 보이는 텍스트
    const visibleText = body.innerText;

    return {
      childCount: children.length,
      children: children.slice(0, 30),
      hiddenCount: hiddenEls.length,
      hiddenInfo,
      visibleText: visibleText.substring(0, 500),
      visibleTextLen: visibleText.length,
    };
  });

  console.log(`   body 자식: ${htmlAnalysis.childCount}개`);
  console.log(`   숨겨진 요소: ${htmlAnalysis.hiddenCount}개`);
  console.log(`   보이는 텍스트 (${htmlAnalysis.visibleTextLen}자): ${htmlAnalysis.visibleText}`);

  console.log('\n   자식 요소:');
  htmlAnalysis.children.forEach(c => {
    console.log(`   [${c.idx}] <${c.tag}> id="${c.id}" class="${c.className}" display=${c.display} vis=${c.visibility} html=${c.htmlLen} text=${c.textLen}`);
  });

  // 전체 HTML 저장
  const html = await page.content();
  await browser.close();

  await fs.writeFile('data/diag-phone.html', html);

  const report = { timestamp: new Date().toISOString(), writeAnalysis, htmlAnalysis };
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));

  console.log('\n✅ 저장 완료');
  console.log('\n========== 핵심 요약 ==========');
  console.log(`document.write: ${writeAnalysis.totalLength}자`);
  console.log(`스크립트: ${writeAnalysis.scriptCount}개`);
  console.log(`전화번호: ${writeAnalysis.phoneCount}개`);
  console.log(`폼: ${writeAnalysis.formCount}개, 인풋: ${writeAnalysis.inputCount}개`);
  console.log(`tbody: ${writeAnalysis.tbodyCount}개`);
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
