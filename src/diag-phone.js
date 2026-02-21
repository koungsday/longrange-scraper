#!/usr/bin/env node
/**
 * 진단 v8: xvfb + headless:false로 pnp4web headless 감지 완전 우회
 *
 * 핵심 전략:
 * 1. xvfb 가상 디스플레이로 headless:false 사용 → pnp4web이 실제 브라우저로 인식
 * 2. eval() / new Function() / createElement('script') 전부 후킹 → _ah_ 복호화 캡처
 * 3. _getListSearch 발견 시 즉시 호출 → AJAX 요청/응답 캡처
 * 4. 네트워크 레벨에서도 모든 .do 요청 캡처
 */
const puppeteer = require('puppeteer');
const fs = require('fs/promises');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v8: xvfb + headless:false ===\n');
  await fs.mkdir('data', { recursive: true });

  // headless:false가 가능한지 확인 (DISPLAY 환경변수)
  const hasDisplay = !!process.env.DISPLAY;
  const useHeadless = !hasDisplay;
  console.log(`   DISPLAY=${process.env.DISPLAY || '(없음)'}, headless=${useHeadless}`);

  const browser = await puppeteer.launch({
    headless: useHeadless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      // 추가 anti-detection
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(REAL_UA);
  await page.setViewport({ width: 1920, height: 1080 });

  // ========== 종합 anti-detection ==========
  await page.evaluateOnNewDocument(() => {
    // webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      }
    });
    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    // platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    // hardwareConcurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    // deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    // chrome object
    window.chrome = {
      runtime: { onMessage: { addListener: () => {}, removeListener: () => {} } },
      loadTimes: () => ({
        commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000,
        navigationType: 'Other', npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 0.1, startLoadTime: Date.now() / 1000 - 0.2,
        wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      }),
      csi: () => ({ pageT: Date.now(), startE: Date.now(), onloadT: Date.now() }),
    };
    // permissions
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (params) => {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery(params);
      };
    }
    // screen properties
    Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
    Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    // outerWidth/Height (key headless indicator!)
    Object.defineProperty(window, 'outerWidth', { get: () => 1920 });
    Object.defineProperty(window, 'outerHeight', { get: () => 1040 });
    // hasFocus
    document.hasFocus = () => true;
  });

  // ========== eval/Function/createElement 후킹 ==========
  await page.evaluateOnNewDocument(() => {
    window.__capturedEvals = [];
    window.__capturedFunctions = [];
    window.__capturedScriptCreates = [];
    window.__capturedDocWrites = [];
    window.__getListSearchFound = false;
    window.__getListSearchCode = '';
    window.__ajaxEndpoints = [];

    // eval 후킹
    const origEval = window.eval;
    window.eval = function(code) {
      if (typeof code === 'string') {
        window.__capturedEvals.push({
          time: Date.now(),
          length: code.length,
          snippet: code.substring(0, 2000),
          hasGetList: code.includes('_getListSearch'),
          hasAjax: code.includes('$.ajax') || code.includes('$.post'),
        });
        if (code.includes('_getListSearch')) {
          window.__getListSearchFound = true;
          window.__getListSearchCode = code;
          console.log('[HOOK] eval: _getListSearch FOUND! length=' + code.length);
        }
        // AJAX URL 추출
        const doMatches = code.match(/['"]([^'"]*\.do)['"]/g);
        if (doMatches) {
          doMatches.forEach(m => window.__ajaxEndpoints.push(m.replace(/['"]/g, '')));
        }
      }
      return origEval.call(this, code);
    };

    // Function 생성자 후킹
    const OrigFunction = Function;
    window.Function = function() {
      const args = Array.from(arguments);
      const body = args.length > 0 ? String(args[args.length - 1]) : '';
      window.__capturedFunctions.push({
        time: Date.now(),
        length: body.length,
        snippet: body.substring(0, 2000),
        hasGetList: body.includes('_getListSearch'),
        hasAjax: body.includes('$.ajax') || body.includes('$.post'),
      });
      if (body.includes('_getListSearch')) {
        window.__getListSearchFound = true;
        window.__getListSearchCode = body;
        console.log('[HOOK] Function: _getListSearch FOUND! length=' + body.length);
      }
      const doMatches = body.match(/['"]([^'"]*\.do)['"]/g);
      if (doMatches) {
        doMatches.forEach(m => window.__ajaxEndpoints.push(m.replace(/['"]/g, '')));
      }
      return new OrigFunction(...args);
    };
    window.Function.prototype = OrigFunction.prototype;

    // document.write 후킹
    window.__pnpWriteAll = '';
    const origOpen = document.open.bind(document);
    const origWrite = document.write.bind(document);
    const origClose = document.close.bind(document);
    document.open = function() { window.__pnpWriteAll = ''; return origOpen(); };
    document.write = function(html) {
      window.__pnpWriteAll += html;
      window.__capturedDocWrites.push({
        time: Date.now(),
        length: html.length,
        hasGetList: html.includes('_getListSearch'),
        hasAjax: html.includes('$.ajax'),
      });
      if (html.includes('_getListSearch')) {
        window.__getListSearchFound = true;
        window.__getListSearchCode = html;
        console.log('[HOOK] document.write: _getListSearch FOUND! length=' + html.length);
      }
      return origWrite(html);
    };
    document.close = function() { return origClose(); };

    // script createElement 후킹
    const origCreate = document.createElement.bind(document);
    document.createElement = function(tag) {
      const el = origCreate(tag);
      if (tag.toLowerCase() === 'script') {
        const origTextSetter = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'text')?.set;
        const origInnerHTMLSetter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set;
        if (origTextSetter) {
          Object.defineProperty(el, 'text', {
            set: function(val) {
              window.__capturedScriptCreates.push({
                time: Date.now(), length: val.length,
                snippet: val.substring(0, 2000),
                hasGetList: val.includes('_getListSearch'),
              });
              if (val.includes('_getListSearch')) {
                window.__getListSearchFound = true;
                window.__getListSearchCode = val;
                console.log('[HOOK] script.text: _getListSearch FOUND!');
              }
              return origTextSetter.call(this, val);
            },
            get: function() {
              return Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'text').get.call(this);
            }
          });
        }
      }
      return el;
    };
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });

  // ========== 네트워크 캡처 ==========
  const networkRequests = [];
  const networkResponses = [];

  page.on('request', req => {
    const url = req.url();
    if (url.includes('.do') || url.includes('/api/') || url.includes('ajax')) {
      networkRequests.push({
        url, method: req.method(),
        postData: req.postData() || null,
        time: Date.now(),
      });
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('.do') || url.includes('/api/') || url.includes('ajax')) {
      const entry = { url, status: res.status(), ct: (res.headers()['content-type'] || ''), time: Date.now() };
      try {
        const body = await res.text();
        entry.bodySize = body.length;
        const phones = (body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
        entry.phoneCount = phones.length;
        if (phones.length > 0) {
          entry.phoneSample = phones.slice(0, 5);
          entry.bodySnippet = body.substring(0, 1000);
        }
        // 전화번호 데이터가 있으면 전체 저장
        if (phones.length > 5) {
          await fs.writeFile('data/phone-ajax-response.html', body).catch(() => {});
          console.log(`   ✅ AJAX 전화번호 응답 저장! phones=${phones.length} url=${url}`);
        }
      } catch {}
      networkResponses.push(entry);
    }
  });

  // 콘솔 메시지 캡처 (HOOK 로그 확인용)
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[HOOK]') || text.includes('_getListSearch')) {
      console.log(`   [browser] ${text}`);
    }
  });

  // ========== 페이지 로딩 ==========
  console.log('\n===== PART A: 페이지 로딩 =====\n');

  console.log('   세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  console.log('   전화번호 페이지...');
  const phoneNavStart = Date.now();
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   페이지 로드: ${Date.now() - phoneNavStart}ms`);

  // 충분히 대기 — pnp4web _ah_ 처리 시간
  console.log('   _ah_ 처리 대기 (15초)...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const found = await page.evaluate(() => window.__getListSearchFound);
    if (found) {
      console.log(`   ✅ _getListSearch 발견! (${i+1}초)`);
      break;
    }
    // 매 3초마다 상태 출력
    if ((i + 1) % 3 === 0) {
      const status = await page.evaluate(() => ({
        evals: window.__capturedEvals.length,
        funcs: window.__capturedFunctions.length,
        scripts: window.__capturedScriptCreates.length,
        writes: window.__capturedDocWrites.length,
        getListFound: window.__getListSearchFound,
        ajaxEndpoints: window.__ajaxEndpoints.length,
      }));
      console.log(`   ${i+1}초: evals=${status.evals}, funcs=${status.funcs}, scripts=${status.scripts}, writes=${status.writes}, ajax=${status.ajaxEndpoints}, found=${status.getListFound}`);
    }
  }

  // ========== PART B: 후킹 결과 분석 ==========
  console.log('\n===== PART B: 후킹 캡처 결과 =====\n');

  const hookResults = await page.evaluate(() => {
    return {
      evalCount: window.__capturedEvals.length,
      evals: window.__capturedEvals.map(e => ({
        length: e.length, snippet: e.snippet, hasGetList: e.hasGetList, hasAjax: e.hasAjax,
      })),
      funcCount: window.__capturedFunctions.length,
      funcs: window.__capturedFunctions.map(f => ({
        length: f.length, snippet: f.snippet, hasGetList: f.hasGetList, hasAjax: f.hasAjax,
      })),
      scriptCount: window.__capturedScriptCreates.length,
      scripts: window.__capturedScriptCreates.map(s => ({
        length: s.length, snippet: s.snippet, hasGetList: s.hasGetList,
      })),
      writeCount: window.__capturedDocWrites.length,
      writes: window.__capturedDocWrites.map(w => ({
        length: w.length, hasGetList: w.hasGetList, hasAjax: w.hasAjax,
      })),
      getListFound: window.__getListSearchFound,
      getListCodeLength: window.__getListSearchCode.length,
      getListCodeSnippet: window.__getListSearchCode.substring(0, 3000),
      ajaxEndpoints: [...new Set(window.__ajaxEndpoints)],
    };
  });

  console.log(`   eval 캡처: ${hookResults.evalCount}개`);
  hookResults.evals.forEach((e, i) => {
    console.log(`   [eval ${i}] ${e.length}자, getList=${e.hasGetList}, ajax=${e.hasAjax}`);
    if (e.hasGetList || e.hasAjax) {
      console.log(`   코드: ${e.snippet.substring(0, 500)}`);
    }
  });

  console.log(`\n   Function 캡처: ${hookResults.funcCount}개`);
  hookResults.funcs.forEach((f, i) => {
    console.log(`   [func ${i}] ${f.length}자, getList=${f.hasGetList}, ajax=${f.hasAjax}`);
    if (f.hasGetList || f.hasAjax) {
      console.log(`   코드: ${f.snippet.substring(0, 500)}`);
    }
  });

  console.log(`\n   createElement('script') 캡처: ${hookResults.scriptCount}개`);
  hookResults.scripts.forEach((s, i) => {
    console.log(`   [script ${i}] ${s.length}자, getList=${s.hasGetList}`);
    if (s.hasGetList) {
      console.log(`   코드: ${s.snippet.substring(0, 500)}`);
    }
  });

  console.log(`\n   document.write 캡처: ${hookResults.writeCount}개`);
  hookResults.writes.forEach((w, i) => {
    console.log(`   [write ${i}] ${w.length}자, getList=${w.hasGetList}, ajax=${w.hasAjax}`);
  });

  console.log(`\n   _getListSearch 발견: ${hookResults.getListFound}`);
  if (hookResults.getListFound) {
    console.log(`   코드 길이: ${hookResults.getListCodeLength}자`);
    console.log(`   코드:\n${hookResults.getListCodeSnippet}`);
  }

  console.log(`\n   AJAX 엔드포인트: ${hookResults.ajaxEndpoints.join(', ') || '(없음)'}`);

  // ========== PART C: 직접 _getListSearch 호출 시도 ==========
  console.log('\n===== PART C: _getListSearch 직접 호출 =====\n');

  const fnCheck = await page.evaluate(() => {
    const result = {
      hasGetListSearch: typeof _getListSearch === 'function',
      hasGoPage: typeof goPage === 'function',
      hasFnSearch: typeof fnSearch === 'function',
      hasInitPage: typeof initPage === 'function',
    };

    // 모든 전역 함수 중 관련 있어 보이는 것들
    const interestingFns = Object.keys(window).filter(k => {
      try {
        return typeof window[k] === 'function' &&
          (k.toLowerCase().includes('search') || k.toLowerCase().includes('list') ||
           k.toLowerCase().includes('phone') || k.toLowerCase().includes('ajax') ||
           k.toLowerCase().includes('grid') || k.toLowerCase().includes('page') ||
           k.toLowerCase().includes('submit') || k.toLowerCase().includes('query'));
      } catch { return false; }
    });
    result.globalFns = interestingFns;

    // DOM 상태
    result.tbodyRows = document.querySelectorAll('table tbody tr').length;
    result.allTds = document.querySelectorAll('table tbody tr td').length;
    result.ajsScripts = document.querySelectorAll('script[_ajs_]').length;
    result.allScripts = document.querySelectorAll('script').length;

    return result;
  });

  console.log(`   _getListSearch: ${fnCheck.hasGetListSearch}`);
  console.log(`   goPage: ${fnCheck.hasGoPage}`);
  console.log(`   fnSearch: ${fnCheck.hasFnSearch}`);
  console.log(`   initPage: ${fnCheck.hasInitPage}`);
  console.log(`   전역 관련 함수: ${fnCheck.globalFns.join(', ')}`);
  console.log(`   tbody rows: ${fnCheck.tbodyRows}, tds: ${fnCheck.allTds}`);
  console.log(`   _ajs_ scripts: ${fnCheck.ajsScripts}, all scripts: ${fnCheck.allScripts}`);

  // _getListSearch가 있으면 호출!
  if (fnCheck.hasGetListSearch) {
    console.log('\n   🎯 _getListSearch 호출!');
    const preReqCount = networkRequests.length;
    await page.evaluate(() => {
      try { _getListSearch(); } catch (e) { console.log('[HOOK] _getListSearch error: ' + e.message); }
    });
    await new Promise(r => setTimeout(r, 5000));

    const newReqs = networkRequests.slice(preReqCount);
    console.log(`   _getListSearch 후 새 요청: ${newReqs.length}개`);
    newReqs.forEach(r => {
      console.log(`   ${r.method} ${r.url}`);
      if (r.postData) console.log(`   POST data: ${r.postData.substring(0, 300)}`);
    });

    // tbody 확인
    const afterRows = await page.evaluate(() => ({
      rows: document.querySelectorAll('table tbody tr').length,
      tds: document.querySelectorAll('table tbody tr td').length,
      text: document.querySelector('table tbody')?.innerText?.substring(0, 500) || '',
    }));
    console.log(`   호출 후: rows=${afterRows.rows}, tds=${afterRows.tds}`);
    if (afterRows.text) console.log(`   tbody 텍스트: ${afterRows.text}`);
  }

  // goPage가 있으면 시도
  if (fnCheck.hasGoPage && !fnCheck.hasGetListSearch) {
    console.log('\n   📞 goPage(1) 시도...');
    const preReqCount = networkRequests.length;
    try {
      await page.evaluate(() => {
        try { goPage(1); } catch (e) { console.log('[HOOK] goPage error: ' + e.message); }
      });
    } catch {}
    await new Promise(r => setTimeout(r, 5000));

    const newReqs = networkRequests.slice(preReqCount);
    console.log(`   goPage 후 새 요청: ${newReqs.length}개`);
    newReqs.forEach(r => {
      console.log(`   ${r.method} ${r.url}`);
      if (r.postData) console.log(`   POST data: ${r.postData.substring(0, 300)}`);
    });
  }

  // ========== PART D: 네트워크 요약 ==========
  console.log('\n===== PART D: 네트워크 요약 =====\n');

  console.log(`   총 .do 요청: ${networkRequests.length}개`);
  networkRequests.forEach((r, i) => {
    console.log(`   [req ${i}] ${r.method} ${r.url}`);
    if (r.postData) console.log(`           POST: ${r.postData.substring(0, 200)}`);
  });

  console.log(`\n   총 .do 응답: ${networkResponses.length}개`);
  networkResponses.forEach((r, i) => {
    console.log(`   [res ${i}] ${r.status} ${r.url} ct=${r.ct} size=${r.bodySize || 0} phones=${r.phoneCount || 0}`);
    if (r.phoneCount > 0) {
      console.log(`   📞 전화: ${r.phoneSample?.join(', ')}`);
    }
  });

  // ========== PART E: document.write HTML 분석 ==========
  console.log('\n===== PART E: 복호화 HTML 분석 =====\n');

  const htmlAnalysis = await page.evaluate(() => {
    const html = window.__pnpWriteAll || '';
    if (!html) return { empty: true };

    // _ah_ 스크립트 검색
    const ahMatches = [...html.matchAll(/_ah_\s*=\s*['"]([^'"]*)['"]/g)];
    // 모든 스크립트 태그 검색
    const scriptMatches = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    // _getListSearch 검색
    const getListIdx = html.indexOf('_getListSearch');

    return {
      empty: false,
      totalLength: html.length,
      ahScriptCount: ahMatches.length,
      ahLengths: ahMatches.map(m => m[1].length),
      ahSnippets: ahMatches.map(m => m[1].substring(0, 200)),
      totalScripts: scriptMatches.length,
      inlineScripts: scriptMatches.filter(m => !m[1].includes('src=')).length,
      getListSearchFound: getListIdx >= 0,
      getListSearchContext: getListIdx >= 0 ? html.substring(Math.max(0, getListIdx - 200), getListIdx + 500) : '',
      // tbody 내용 확인
      tbodyMatch: html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1]?.substring(0, 500) || '',
    };
  });

  if (htmlAnalysis.empty) {
    console.log('   ⚠️ document.write 캡처 없음!');
  } else {
    console.log(`   HTML 길이: ${htmlAnalysis.totalLength}자`);
    console.log(`   스크립트: ${htmlAnalysis.totalScripts}개 (인라인: ${htmlAnalysis.inlineScripts}개)`);
    console.log(`   _ah_ 스크립트: ${htmlAnalysis.ahScriptCount}개`);
    htmlAnalysis.ahLengths.forEach((len, i) => {
      console.log(`   [ah ${i}] ${len}자: ${htmlAnalysis.ahSnippets[i]}`);
    });
    console.log(`   _getListSearch in write HTML: ${htmlAnalysis.getListSearchFound}`);
    if (htmlAnalysis.getListSearchFound) {
      console.log(`   컨텍스트: ${htmlAnalysis.getListSearchContext}`);
    }
    console.log(`   tbody: "${htmlAnalysis.tbodyMatch}"`);
  }

  // ========== PART F: _ah_ 수동 분석 ==========
  console.log('\n===== PART F: _ah_ 수동 분석 =====\n');

  // _ah_ 속성이 있으면 그 내용의 패턴 분석
  if (htmlAnalysis.ahScriptCount > 0) {
    const ahContent = await page.evaluate(() => {
      const html = window.__pnpWriteAll || '';
      const ahMatches = [...html.matchAll(/_ah_\s*=\s*['"]([^'"]*)['"]/g)];
      if (ahMatches.length === 0) return null;
      const content = ahMatches[0][1];
      return {
        total: content.length,
        first500: content.substring(0, 500),
        last200: content.substring(content.length - 200),
        // 바이트 패턴 분석
        isHex: /^[0-9a-f]+$/i.test(content),
        isBase64: /^[A-Za-z0-9+/=]+$/.test(content),
        uniqueChars: [...new Set(content)].sort().join(''),
        charFreq: (() => {
          const freq = {};
          for (const c of content.substring(0, 10000)) {
            freq[c] = (freq[c] || 0) + 1;
          }
          return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20);
        })(),
      };
    });

    if (ahContent) {
      console.log(`   _ah_ 내용: ${ahContent.total}자`);
      console.log(`   처음: ${ahContent.first500}`);
      console.log(`   마지막: ${ahContent.last200}`);
      console.log(`   hex: ${ahContent.isHex}, base64: ${ahContent.isBase64}`);
      console.log(`   고유 문자: ${ahContent.uniqueChars}`);
      console.log(`   빈도: ${ahContent.charFreq.map(([c, n]) => `${c}:${n}`).join(', ')}`);

      // _ah_ 내용 저장
      const fullAh = await page.evaluate(() => {
        const html = window.__pnpWriteAll || '';
        const m = html.match(/_ah_\s*=\s*['"]([^'"]*)['"]/);
        return m ? m[1] : '';
      });
      if (fullAh) {
        await fs.writeFile('data/ah-encrypted.txt', fullAh);
        console.log(`   ✅ data/ah-encrypted.txt 저장 (${fullAh.length}자)`);
      }
    }
  }

  // DOM _ajs_ 스크립트도 확인 (이미 처리된 것)
  const domAjs = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[_ajs_]');
    return [...scripts].map(s => ({
      ajs: s.getAttribute('_ajs_'),
      ah: (s.getAttribute('_ah_') || '').length,
      text: s.textContent.substring(0, 500),
      textLen: s.textContent.length,
    }));
  });
  console.log(`\n   DOM _ajs_ 스크립트: ${domAjs.length}개`);
  domAjs.forEach((s, i) => {
    console.log(`   [${i}] _ajs_="${s.ajs}" _ah_=${s.ah}자 text=${s.textLen}자`);
    if (s.textLen > 0) console.log(`   텍스트: ${s.text}`);
  });

  // ========== PART G: 전체 DOM 텍스트에서 전화번호 찾기 ==========
  console.log('\n===== PART G: DOM 전화번호 검색 =====\n');

  const phoneSearch = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const bodyHtml = document.body?.innerHTML || '';
    const phones = bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];
    const htmlPhones = bodyHtml.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];

    return {
      bodyTextLen: bodyText.length,
      bodyHtmlLen: bodyHtml.length,
      textPhones: phones.length,
      htmlPhones: htmlPhones.length,
      phoneSamples: phones.slice(0, 10),
      // 테이블 텍스트
      tableText: document.querySelector('table')?.innerText?.substring(0, 1000) || '(테이블 없음)',
      // 전체 본문 일부
      bodyTextSample: bodyText.substring(0, 500),
    };
  });

  console.log(`   body text: ${phoneSearch.bodyTextLen}자, html: ${phoneSearch.bodyHtmlLen}자`);
  console.log(`   텍스트 전화번호: ${phoneSearch.textPhones}개`);
  console.log(`   HTML 전화번호: ${phoneSearch.htmlPhones}개`);
  if (phoneSearch.phoneSamples.length > 0) {
    console.log(`   샘플: ${phoneSearch.phoneSamples.join(', ')}`);
  }
  console.log(`   테이블: ${phoneSearch.tableText}`);
  console.log(`   본문: ${phoneSearch.bodyTextSample}`);

  // ========== 저장 ==========
  const html = await page.content();
  await browser.close();

  await fs.writeFile('data/diag-phone.html', html);

  // document.write HTML도 저장
  const writeHtml = await fs.readFile('data/diag-phone.html', 'utf8').catch(() => '');
  // 결과 JSON
  const report = {
    timestamp: new Date().toISOString(),
    headless: useHeadless,
    display: process.env.DISPLAY || null,
    hookResults: {
      evalCount: hookResults.evalCount,
      funcCount: hookResults.funcCount,
      scriptCount: hookResults.scriptCount,
      writeCount: hookResults.writeCount,
      getListFound: hookResults.getListFound,
      ajaxEndpoints: hookResults.ajaxEndpoints,
    },
    fnCheck,
    networkRequests: networkRequests.length,
    networkResponses: networkResponses.map(r => ({ url: r.url, status: r.status, phones: r.phoneCount })),
    phoneSearch: { textPhones: phoneSearch.textPhones, htmlPhones: phoneSearch.htmlPhones },
  };
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));

  console.log('\n✅ 진단 v8 완료');
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
