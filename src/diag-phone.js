#!/usr/bin/env node
/**
 * 진단 v5: pnp4web 직접 복호화
 *
 * 발견 사실 요약:
 * - 원본 HTML = 단 1개 script: pnp4web.js + onload='_0xac("encrypted...")'
 * - 전체 페이지(폼, 테이블, 인라인 스크립트, 데이터)가 암호화된 blob 안에 있음
 * - 별도 AJAX 엔드포인트 없음 (13개 모두 404)
 * - Puppeteer에서 pnp4web이 일부 HTML은 복호화하지만 인라인 스크립트는 실행 안 됨
 *
 * 전략:
 * 1. pnp4web.js 소스 분석 → _0xac 복호화 알고리즘 이해
 * 2. Puppeteer에서 복호화된 HTML body의 innerHTML 추출
 * 3. 복호화된 HTML에서 _getListSearch 정의 + 전화번호 데이터 추출
 * 4. pnp4web.js를 Node.js에서 실행해 직접 복호화 시도
 */
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs/promises');
const vm = require('vm');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;
const PNP4WEB_URL = 'https://ev.or.kr/nportal/js/pnp4web/pnp4web.js?v=20190219';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v5: pnp4web 직접 복호화 ===\n');

  await fs.mkdir('data', { recursive: true });

  // ========== PART A: pnp4web.js 소스 분석 ==========
  console.log('===== PART A: pnp4web.js 소스 분석 =====\n');

  let pnpSource = '';
  try {
    const resp = await axios.get(PNP4WEB_URL, {
      headers: { 'User-Agent': REAL_UA },
      timeout: 30000, validateStatus: () => true,
    });
    pnpSource = typeof resp.data === 'string' ? resp.data : '';
    console.log(`   pnp4web.js: ${resp.status}, ${pnpSource.length}자`);
    await fs.writeFile('data/pnp4web.js', pnpSource);
    console.log('   ✅ data/pnp4web.js 저장');

    // 구조 분석
    console.log(`\n   처음 2000자:\n${pnpSource.substring(0, 2000)}`);
    console.log(`\n   마지막 500자:\n${pnpSource.substring(pnpSource.length - 500)}`);

    // _0xac 함수 찾기
    const oxacIdx = pnpSource.indexOf('_0xac');
    if (oxacIdx >= 0) {
      console.log(`\n   _0xac 위치: ${oxacIdx}`);
      console.log(`   주변: ${pnpSource.substring(Math.max(0, oxacIdx - 100), oxacIdx + 500)}`);
    }

    // 주요 함수명 찾기
    const funcPattern = /function\s+([a-zA-Z_$][\w$]*)/g;
    const funcs = [];
    let m;
    while ((m = funcPattern.exec(pnpSource)) !== null) {
      funcs.push(m[1]);
    }
    console.log(`\n   정의된 함수: ${funcs.join(', ')}`);

    // var 할당 찾기 (난독화된 함수명)
    const varPattern = /var\s+(_0x[a-f0-9]+)\s*=/g;
    const vars = [];
    while ((m = varPattern.exec(pnpSource)) !== null) {
      if (!vars.includes(m[1])) vars.push(m[1]);
    }
    console.log(`   난독화 변수: ${vars.slice(0, 20).join(', ')}${vars.length > 20 ? '...' : ''}`);

    // document.write 패턴 찾기
    if (pnpSource.includes('document.write')) {
      const dwIdx = pnpSource.indexOf('document.write');
      console.log(`\n   document.write 위치: ${dwIdx}`);
      console.log(`   주변: ${pnpSource.substring(Math.max(0, dwIdx - 200), dwIdx + 300)}`);
    }
    if (pnpSource.includes('innerHTML')) {
      const ihIdx = pnpSource.indexOf('innerHTML');
      console.log(`\n   innerHTML 위치: ${ihIdx}`);
      console.log(`   주변: ${pnpSource.substring(Math.max(0, ihIdx - 200), ihIdx + 300)}`);
    }

  } catch (err) {
    console.log(`   ⚠️ pnp4web.js 분석 실패: ${err.message}`);
  }

  // ========== PART B: 원본 HTML에서 암호화 blob 추출 ==========
  console.log('\n\n===== PART B: 암호화 blob 추출 =====\n');

  let encryptedBlob = '';
  let rawHtml = '';
  try {
    // 세션 수립
    const sessionResp = await axios.get(MAIN_URL, {
      headers: { 'User-Agent': REAL_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      timeout: 30000, validateStatus: () => true,
    });
    const setCookies = sessionResp.headers['set-cookie'];
    const cookies = setCookies ? setCookies.map(c => c.split(';')[0]).join('; ') : '';

    // 전화번호 페이지
    const phoneResp = await axios.get(PHONE_URL, {
      headers: { 'User-Agent': REAL_UA, 'Cookie': cookies, 'Referer': MAIN_URL, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      timeout: 30000, validateStatus: () => true,
    });
    rawHtml = typeof phoneResp.data === 'string' ? phoneResp.data : '';
    console.log(`   원본 HTML: ${rawHtml.length}자`);

    // onload에서 암호화 데이터 추출
    const onloadMatch = rawHtml.match(/onload='_0xac\("([^"]+)"\)/);
    if (onloadMatch) {
      encryptedBlob = onloadMatch[1];
      console.log(`   암호화 blob: ${encryptedBlob.length}자`);
      console.log(`   처음 200자: ${encryptedBlob.substring(0, 200)}`);
      console.log(`   마지막 200자: ${encryptedBlob.substring(encryptedBlob.length - 200)}`);
      await fs.writeFile('data/encrypted-blob.txt', encryptedBlob);
      console.log('   ✅ data/encrypted-blob.txt 저장');
    } else {
      console.log('   ❌ onload 패턴 미발견');
      // 다른 패턴 시도
      const altMatch = rawHtml.match(/_0xac\(["']([^"']+)["']\)/);
      if (altMatch) {
        encryptedBlob = altMatch[1];
        console.log(`   대안 매칭: ${encryptedBlob.length}자`);
      }
    }
  } catch (err) {
    console.log(`   ⚠️ blob 추출 실패: ${err.message}`);
  }

  // ========== PART C: Node.js에서 pnp4web 복호화 시도 ==========
  console.log('\n\n===== PART C: Node.js 복호화 시도 =====\n');

  if (pnpSource && encryptedBlob) {
    try {
      // 방법 1: vm 컨텍스트에서 pnp4web.js 실행
      console.log('C1. VM 컨텍스트에서 복호화 시도...');

      let decryptedHtml = '';
      const sandbox = {
        document: {
          write: (html) => { decryptedHtml += html; },
          writeln: (html) => { decryptedHtml += html + '\n'; },
          createElement: (tag) => ({
            tagName: tag, style: {}, setAttribute: () => {},
            appendChild: () => {}, innerHTML: '',
          }),
          getElementsByTagName: () => [],
          getElementById: () => null,
          body: { innerHTML: '', appendChild: () => {} },
          head: { appendChild: () => {} },
          documentElement: { innerHTML: '' },
          createTextNode: (text) => ({ textContent: text }),
        },
        window: {},
        navigator: {
          userAgent: REAL_UA,
          webdriver: false,
          plugins: { length: 3 },
          languages: ['ko-KR', 'ko'],
          platform: 'Win32',
          vendor: 'Google Inc.',
        },
        location: { href: PHONE_URL, protocol: 'https:', hostname: 'ev.or.kr', pathname: '/nportal/buySupprt/psLocalPhone.do' },
        screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn) => { try { fn(); } catch {} },
        setInterval: () => {},
        XMLHttpRequest: function() {
          return { open: () => {}, send: () => {}, setRequestHeader: () => {} };
        },
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        unescape: global.unescape,
        escape: global.escape,
        encodeURIComponent: global.encodeURIComponent,
        decodeURIComponent: global.decodeURIComponent,
        parseInt: global.parseInt,
        parseFloat: global.parseFloat,
        String: global.String,
        Number: global.Number,
        Array: global.Array,
        Object: global.Object,
        Math: global.Math,
        Date: global.Date,
        RegExp: global.RegExp,
        JSON: global.JSON,
        Error: global.Error,
        TypeError: global.TypeError,
        isNaN: global.isNaN,
        isFinite: global.isFinite,
        undefined: undefined,
        NaN: NaN,
        Infinity: Infinity,
      };

      // window 자기참조
      sandbox.window = sandbox;
      sandbox.self = sandbox;
      sandbox.top = sandbox;
      sandbox.parent = sandbox;

      const context = vm.createContext(sandbox);

      // pnp4web.js 실행
      try {
        vm.runInContext(pnpSource, context, { timeout: 10000 });
        console.log('   pnp4web.js 로드 성공');

        // _0xac 함수가 정의되었는지 확인
        const hasOxac = vm.runInContext('typeof _0xac', context);
        console.log(`   _0xac 타입: ${hasOxac}`);

        if (hasOxac === 'function') {
          console.log('   _0xac 호출 중...');
          decryptedHtml = '';
          vm.runInContext(`_0xac("${encryptedBlob}")`, context, { timeout: 30000 });
          console.log(`   document.write 출력: ${decryptedHtml.length}자`);

          if (decryptedHtml.length > 0) {
            await fs.writeFile('data/decrypted-phone.html', decryptedHtml);
            console.log('   ✅ data/decrypted-phone.html 저장');

            // 전화번호 검색
            const phones = (decryptedHtml.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
            console.log(`   전화번호: ${phones.length}개`);
            if (phones.length > 0) console.log(`   샘플: ${phones.slice(0, 10).join(', ')}`);

            // _getListSearch 검색
            if (decryptedHtml.includes('_getListSearch')) {
              const idx = decryptedHtml.indexOf('_getListSearch');
              console.log(`\n   _getListSearch 발견! 위치 ${idx}`);
              console.log(`   주변: ${decryptedHtml.substring(Math.max(0, idx - 200), idx + 500)}`);
            }

            // form 분석
            const formMatch = decryptedHtml.match(/<form[^>]*>[\s\S]*?<\/form>/gi);
            if (formMatch) {
              console.log(`\n   복호화된 폼 ${formMatch.length}개:`);
              formMatch.forEach((f, i) => console.log(`   [${i}] ${f.substring(0, 300)}`));
            }

            // script 분석
            const scriptMatch = decryptedHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi);
            if (scriptMatch) {
              console.log(`\n   복호화된 스크립트 ${scriptMatch.length}개:`);
              scriptMatch.forEach((s, i) => {
                const src = s.match(/src=["']([^"']+)["']/);
                if (src) {
                  console.log(`   [${i}] 외부: ${src[1]}`);
                } else {
                  const content = s.replace(/<\/?script[^>]*>/gi, '').trim();
                  console.log(`   [${i}] 인라인 (${content.length}자): ${content.substring(0, 500)}`);
                }
              });
            }
          }
        } else {
          // _0xac이 없다면 다른 전역 함수 확인
          const globalFns = vm.runInContext(
            'Object.keys(this).filter(k => typeof this[k] === "function").join(", ")',
            context
          );
          console.log(`   전역 함수: ${globalFns}`);
        }
      } catch (err) {
        console.log(`   ⚠️ VM 실행 에러: ${err.message}`);
        console.log(`   스택: ${err.stack?.substring(0, 500)}`);
      }
    } catch (err) {
      console.log(`   ⚠️ 복호화 시도 실패: ${err.message}`);
    }
  }

  // ========== PART D: Puppeteer에서 복호화된 DOM 추출 ==========
  console.log('\n\n===== PART D: Puppeteer DOM 추출 =====\n');

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
    // Permission 쿼리 오버라이드
    const origQuery = window.navigator.permissions?.query;
    if (window.navigator.permissions) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
  });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  // document.write 후킹으로 pnp4web 복호화 내용 캡처
  await page.evaluateOnNewDocument(() => {
    window.__pnpDecrypted = [];
    const origWrite = document.write.bind(document);
    document.write = function(html) {
      window.__pnpDecrypted.push(html);
      origWrite(html);
    };
    const origWriteln = document.writeln.bind(document);
    document.writeln = function(html) {
      window.__pnpDecrypted.push(html);
      origWriteln(html);
    };
  });

  console.log('D1. 세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('D2. 전화번호 페이지...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // 5초 대기
  await new Promise(r => setTimeout(r, 5000));

  // document.write로 캡처된 내용 확인
  const pnpDecrypted = await page.evaluate(() => {
    return {
      count: (window.__pnpDecrypted || []).length,
      totalLength: (window.__pnpDecrypted || []).reduce((sum, s) => sum + s.length, 0),
      snippets: (window.__pnpDecrypted || []).map(s => s.substring(0, 500)),
    };
  });

  console.log(`\n   document.write 호출: ${pnpDecrypted.count}회, 총 ${pnpDecrypted.totalLength}자`);
  pnpDecrypted.snippets.forEach((s, i) => {
    console.log(`   [${i}] ${s.replace(/\n/g, '\\n')}`);
  });

  // DOM 전체 분석
  const domAnalysis = await page.evaluate(() => {
    const bodyHTML = document.body ? document.body.innerHTML : '';
    const bodyText = document.body ? document.body.innerText : '';
    const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);

    // _getListSearch 검색 (innerHTML에서)
    const hasGetListInHTML = bodyHTML.includes('_getListSearch');
    let getListContext = '';
    if (hasGetListInHTML) {
      const idx = bodyHTML.indexOf('_getListSearch');
      getListContext = bodyHTML.substring(Math.max(0, idx - 200), idx + 500);
    }

    // 모든 스크립트 태그 (text 포함)
    const scripts = [...document.querySelectorAll('script')].map((s, i) => ({
      idx: i, src: s.src || '', textLen: s.textContent.length,
      textSnippet: s.textContent.trim().substring(0, 300),
    }));

    // 테이블 분석
    const tables = [...document.querySelectorAll('table')].map((t, i) => ({
      idx: i, id: t.id, className: t.className,
      thead: t.querySelectorAll('thead tr').length,
      tbody: t.querySelectorAll('tbody tr').length,
      allTr: t.querySelectorAll('tr').length,
      headerText: t.querySelector('thead tr') ? t.querySelector('thead tr').textContent.trim().substring(0, 200) : '',
    }));

    return {
      bodyHTMLLen: bodyHTML.length,
      bodyTextLen: bodyText.length,
      phoneCount: phones.length,
      phoneSamples: phones.slice(0, 10),
      hasGetListInHTML,
      getListContext,
      scripts,
      tables,
      // pnp4web 관련 전역변수
      hasOxac: typeof _0xac === 'function' || typeof _0xac !== 'undefined',
      oxacType: typeof _0xac,
    };
  });

  console.log(`\n   body innerHTML: ${domAnalysis.bodyHTMLLen}자`);
  console.log(`   body innerText: ${domAnalysis.bodyTextLen}자`);
  console.log(`   전화번호: ${domAnalysis.phoneCount}개`);
  console.log(`   _getListSearch in HTML: ${domAnalysis.hasGetListInHTML}`);
  if (domAnalysis.getListContext) console.log(`   context: ${domAnalysis.getListContext}`);
  console.log(`   _0xac 타입: ${domAnalysis.oxacType}`);
  console.log(`   스크립트: ${domAnalysis.scripts.length}개`);
  domAnalysis.scripts.forEach(s => {
    console.log(`     [${s.idx}] src="${s.src}" text=${s.textLen}자 ${s.textSnippet.substring(0, 100)}`);
  });
  console.log(`   테이블: ${domAnalysis.tables.length}개`);
  domAnalysis.tables.forEach(t => {
    console.log(`     [${t.idx}] id="${t.id}" class="${t.className}" thead=${t.thead} tbody=${t.tbody} tr=${t.allTr} header="${t.headerText}"`);
  });

  // _0xac가 존재하면 Puppeteer 내에서 직접 호출 시도
  if (domAnalysis.oxacType === 'function' && encryptedBlob) {
    console.log('\n   _0xac 직접 호출 시도...');
    const callResult = await page.evaluate((blob) => {
      try {
        _0xac(blob);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, encryptedBlob);
    console.log(`   결과: ${JSON.stringify(callResult)}`);

    await new Promise(r => setTimeout(r, 3000));
    const afterCall = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const phones = (bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
      return { phoneCount: phones.length, phoneSamples: phones.slice(0, 10), hasGetList: typeof _getListSearch === 'function' };
    });
    console.log(`   호출 후: phones=${afterCall.phoneCount}, _getListSearch=${afterCall.hasGetList}`);
  }

  // 전체 HTML 저장
  const html = await page.content();
  await browser.close();

  await fs.writeFile('data/diag-phone.html', html);
  console.log('\n✅ data/diag-phone.html 저장');

  // 보고서
  const report = {
    timestamp: new Date().toISOString(),
    pnpSourceSize: pnpSource.length,
    encryptedBlobSize: encryptedBlob.length,
    pnpDecrypted,
    domAnalysis,
  };
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));
  console.log('✅ data/diag-phone.json 저장');

  console.log('\n========== 핵심 요약 ==========');
  console.log(`pnp4web.js: ${pnpSource.length}자`);
  console.log(`암호화 blob: ${encryptedBlob.length}자`);
  console.log(`document.write 캡처: ${pnpDecrypted.count}회, ${pnpDecrypted.totalLength}자`);
  console.log(`DOM 전화번호: ${domAnalysis.phoneCount}개`);
  console.log(`_getListSearch in HTML: ${domAnalysis.hasGetListInHTML}`);
  console.log(`_0xac 타입: ${domAnalysis.oxacType}`);
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
