#!/usr/bin/env node
/**
 * 진단 v7: 2단계 암호화 해독 — _ah_ 속성에서 _getListSearch 추출
 *
 * v6 발견:
 * - 1단계 복호화 성공 (436KB document.write)
 * - 34개 스크립트 존재, 대부분 외부
 * - tbody 빈 상태 + 바로 뒤에 <script _ajs_='30_...' _ah_='57...'> 존재
 * - _ah_ 속성 = 2단계 암호화된 JS (여기에 _getListSearch가 있을 것)
 *
 * 전략:
 * 1. <script _ajs_ _ah_> 태그 전체 추출
 * 2. common_page.js, common_grid.js 등 외부 JS에서 _getListSearch 검색
 * 3. pnp4web의 S() 함수 분석 → _ah_ 복호화 시도
 */
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs/promises');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 진단 v7: _ah_ 속성 복호화 ===\n');
  await fs.mkdir('data', { recursive: true });

  // ========== PART A: 외부 JS에서 _getListSearch 검색 ==========
  console.log('===== PART A: 외부 JS 분석 =====\n');

  const jsFiles = [
    '/nportal/js/common/common_page.js',
    '/nportal/js/common/common_grid.js',
    '/nportal/js/common/common.js',
    '/nportal/js/common.js',
    '/nportal/js/common/cmnReady.js',
    '/nportal/js/common_util.js',
    '/nportal/js/paging.js',
  ];

  for (const jsPath of jsFiles) {
    try {
      const resp = await axios.get(`https://ev.or.kr${jsPath}`, {
        headers: { 'User-Agent': REAL_UA },
        timeout: 10000, validateStatus: () => true,
      });
      const src = typeof resp.data === 'string' ? resp.data : '';
      const hasGetList = src.includes('_getListSearch');
      const hasGetListDef = src.includes('function _getListSearch');
      console.log(`   ${jsPath}: ${src.length}자, _getListSearch=${hasGetList}, def=${hasGetListDef}`);

      if (hasGetList) {
        const idx = src.indexOf('_getListSearch');
        console.log(`   ✅ 발견! 주변 코드:`);
        console.log(src.substring(Math.max(0, idx - 200), idx + 500));
        await fs.writeFile(`data/${jsPath.split('/').pop()}`, src);
      }
    } catch (err) {
      console.log(`   ${jsPath}: ${err.message}`);
    }
  }

  // ========== PART B: Puppeteer + _ah_ 스크립트 추출 ==========
  console.log('\n===== PART B: _ah_ 스크립트 추출 =====\n');

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

  // _ah_ 스크립트 추출
  console.log('\n   _ah_ 스크립트 태그 추출...');
  const ahScripts = await page.evaluate(() => {
    const html = window.__pnpWriteAll || '';
    const result = [];

    // <script _ajs_=... _ah_=...> 태그 찾기
    // 정규식으로 _ajs_, _ah_ 속성 포함 스크립트 태그 추출
    const scriptTagRegex = /<script\s+[^>]*_ajs_\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
    let match;
    while ((match = scriptTagRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const ajs = match[1];

      // _ah_ 속성 추출
      const ahMatch = fullTag.match(/_ah_\s*=\s*['"]([^'"]*)['"]/);
      const ah = ahMatch ? ahMatch[1] : '';

      // 태그 시작 위치에서 </script>까지의 내용
      const startPos = match.index;
      const endTag = '</script>';
      const endPos = html.indexOf(endTag, startPos);
      const fullContent = endPos >= 0 ? html.substring(startPos, endPos + endTag.length) : '';
      const innerContent = endPos >= 0 ? html.substring(match.index + fullTag.length, endPos) : '';

      result.push({
        position: startPos,
        ajs,
        ahLength: ah.length,
        ahSnippet: ah.substring(0, 500),
        fullTagLength: fullTag.length,
        fullTag: fullTag.substring(0, 300),
        innerContentLength: innerContent.length,
        innerContentSnippet: innerContent.substring(0, 300),
        fullContentLength: fullContent.length,
      });
    }

    // aap='vs' 속성 스크립트도 확인 (1단계 암호화)
    const aapRegex = /<script[^>]*aap\s*=\s*['"]vs['"][^>]*>([\s\S]*?)<\/script>/gi;
    const aapScripts = [];
    while ((match = aapRegex.exec(html)) !== null) {
      aapScripts.push({
        position: match.index,
        contentLength: match[1].length,
        contentSnippet: match[1].substring(0, 200),
      });
    }

    return { ahScripts: result, aapScripts };
  });

  console.log(`\n   _ajs_/_ah_ 스크립트: ${ahScripts.ahScripts.length}개`);
  ahScripts.ahScripts.forEach((s, i) => {
    console.log(`   [${i}] pos=${s.position} _ajs_="${s.ajs}" _ah_=${s.ahLength}자`);
    console.log(`       fullTag: ${s.fullTag}`);
    console.log(`       _ah_ snippet: ${s.ahSnippet.substring(0, 200)}`);
    console.log(`       inner: ${s.innerContentLength}자 "${s.innerContentSnippet.substring(0, 100)}"`);
  });

  console.log(`\n   aap='vs' 스크립트: ${ahScripts.aapScripts.length}개`);
  ahScripts.aapScripts.forEach((s, i) => {
    console.log(`   [${i}] pos=${s.position} content=${s.contentLength}자: ${s.contentSnippet}`);
  });

  // ========== PART C: pnp4web S() 함수로 _ah_ 복호화 시도 ==========
  console.log('\n===== PART C: _ah_ 복호화 시도 =====\n');

  // pnp4web 내부의 S() 함수가 _ajs_ 스크립트를 처리
  // Puppeteer에서 직접 복호화 시도
  const decryptResult = await page.evaluate(() => {
    const result = {};

    // DOM에서 _ajs_ 스크립트 태그 찾기
    const ajsScripts = document.querySelectorAll('script[_ajs_]');
    result.domAjsCount = ajsScripts.length;

    if (ajsScripts.length > 0) {
      result.domAjsDetails = [...ajsScripts].map((s, i) => ({
        idx: i,
        ajs: s.getAttribute('_ajs_'),
        ah: (s.getAttribute('_ah_') || '').substring(0, 200),
        ahLen: (s.getAttribute('_ah_') || '').length,
        text: s.textContent.substring(0, 200),
        textLen: s.textContent.length,
      }));
    }

    // pnp4web 전역 함수/변수 탐색
    const pnpKeys = Object.keys(window).filter(k =>
      k.startsWith('_0x') || k.startsWith('_a') || k.startsWith('$a') ||
      k === 'zn' || k === 'Zn' || k.startsWith('_$')
    );
    result.pnpKeys = pnpKeys;

    // 특히 $aaq (pnp4web의 jQuery alias) 확인
    result.has$aaq = typeof $aaq !== 'undefined';
    if (result.has$aaq) {
      result.$aaqType = typeof $aaq;
    }

    // pnp4web이 eval을 사용해 스크립트를 실행하는지 확인
    // eval 후킹
    const origEval = window.eval;
    const evalCalls = [];
    try {
      window.eval = function(code) {
        evalCalls.push(typeof code === 'string' ? code.substring(0, 500) : String(code));
        return origEval.call(window, code);
      };

      // _ajs_ 스크립트 수동 트리거 시도
      if (ajsScripts.length > 0) {
        const script = ajsScripts[0];
        const ah = script.getAttribute('_ah_') || '';
        const ajs = script.getAttribute('_ajs_') || '';

        // pnp4web의 _avt_ 변수로 키 추출 시도
        if (typeof _avt_ !== 'undefined') {
          result._avt_ = String(_avt_).substring(0, 100);
        }
        if (typeof _aevl_ !== 'undefined') {
          result._aevl_ = String(_aevl_).substring(0, 200);
        }
      }
    } catch (e) {
      result.evalError = e.message;
    } finally {
      window.eval = origEval;
    }

    result.evalCalls = evalCalls.length;

    return result;
  });

  console.log(`   DOM _ajs_ 스크립트: ${decryptResult.domAjsCount}개`);
  if (decryptResult.domAjsDetails) {
    decryptResult.domAjsDetails.forEach(d => {
      console.log(`   [${d.idx}] _ajs_="${d.ajs}" _ah_=${d.ahLen}자 text=${d.textLen}자`);
      if (d.ahLen > 0) console.log(`       _ah_: ${d.ah}`);
      if (d.textLen > 0) console.log(`       text: ${d.text}`);
    });
  }
  console.log(`   pnp 전역: ${decryptResult.pnpKeys.join(', ')}`);
  console.log(`   $aaq: ${decryptResult.has$aaq}`);
  if (decryptResult._avt_) console.log(`   _avt_: ${decryptResult._avt_}`);
  if (decryptResult._aevl_) console.log(`   _aevl_: ${decryptResult._aevl_}`);

  // ========== PART D: _ah_ 속성의 전체 내용 저장 ==========
  console.log('\n===== PART D: _ah_ 전체 저장 =====\n');

  const ahFull = await page.evaluate(() => {
    const html = window.__pnpWriteAll || '';
    // tbody 뒤의 script _ajs_ 태그에서 _ah_ 전체 추출
    const ahRegex = /_ah_\s*=\s*'([^']*)'/g;
    const results = [];
    let m;
    while ((m = ahRegex.exec(html)) !== null) {
      results.push({ pos: m.index, length: m[1].length, content: m[1] });
    }
    // 큰따옴표도 시도
    const ahRegex2 = /_ah_\s*=\s*"([^"]*)"/g;
    while ((m = ahRegex2.exec(html)) !== null) {
      results.push({ pos: m.index, length: m[1].length, content: m[1] });
    }
    return results;
  });

  console.log(`   _ah_ 속성 ${ahFull.length}개:`);
  for (const ah of ahFull) {
    console.log(`   pos=${ah.pos}, ${ah.length}자`);
    console.log(`   처음 500자: ${ah.content.substring(0, 500)}`);
    if (ah.length > 500) console.log(`   마지막 200자: ${ah.content.substring(ah.length - 200)}`);

    // 저장
    await fs.writeFile('data/ah-encrypted.txt', ah.content);
    console.log(`   ✅ data/ah-encrypted.txt 저장 (${ah.length}자)`);
  }

  // ========== PART E: pnp4web S() 함수로 복호화 재시도 ==========
  console.log('\n===== PART E: S() 함수 복호화 =====\n');

  // pnp4web.js를 다시 가져와서 S() 함수 분석
  try {
    const pnpResp = await axios.get('https://ev.or.kr/nportal/js/pnp4web/pnp4web.js?v=20190219', {
      headers: { 'User-Agent': REAL_UA },
      timeout: 30000,
    });
    const pnpSrc = pnpResp.data;

    // S(e,t) 함수 찾기 - _ajs_ 처리 부분
    const sIdx = pnpSrc.indexOf('getAttribute("_ajs_")');
    if (sIdx >= 0) {
      console.log(`   _ajs_ 처리 코드 위치: ${sIdx}`);
      console.log(`   코드:\n${pnpSrc.substring(Math.max(0, sIdx - 500), sIdx + 1000)}`);
    }

    // _ah_ 처리 부분
    const ahIdx = pnpSrc.indexOf('_ah_');
    if (ahIdx >= 0) {
      console.log(`\n   _ah_ 처리 코드 위치: ${ahIdx}`);
      console.log(`   코드:\n${pnpSrc.substring(Math.max(0, ahIdx - 300), ahIdx + 500)}`);
    }

    // dc 함수 (복호화) 찾기
    const dcIdx = pnpSrc.indexOf('.dc(');
    if (dcIdx >= 0) {
      console.log(`\n   .dc() 호출 위치: ${dcIdx}`);
      console.log(`   코드:\n${pnpSrc.substring(Math.max(0, dcIdx - 300), dcIdx + 300)}`);
    }

  } catch (err) {
    console.log(`   ⚠️ pnp4web 분석 실패: ${err.message}`);
  }

  // ========== PART F: Puppeteer에서 pnp4web 내부 호출로 _ah_ 복호화 ==========
  console.log('\n===== PART F: 브라우저 내 _ah_ 복호화 =====\n');

  if (ahFull.length > 0) {
    const ahContent = ahFull[0].content;
    const browserDecrypt = await page.evaluate((encrypted) => {
      const result = {};

      // 방법 1: _aevl_ 키를 사용한 base64 디코딩 시도
      try {
        const decoded = atob(encrypted);
        result.base64 = { length: decoded.length, snippet: decoded.substring(0, 200) };
      } catch (e) {
        result.base64Error = e.message;
      }

      // 방법 2: pnp4web의 내부 복호화 함수 찾기
      // _0xc792 배열 (pnp4web의 난독화 배열) 확인
      try {
        if (typeof _0xc792 !== 'undefined') {
          result._0xc792 = { type: typeof _0xc792, length: _0xc792.length };
        }
      } catch {}

      // 방법 3: pnp4web이 전역에 남긴 복호화 유틸리티
      const decryptCandidates = ['_$d', '_$dc', '_$decrypt', '$aaq'];
      for (const name of decryptCandidates) {
        try {
          if (typeof window[name] !== 'undefined') {
            result[name] = typeof window[name];
          }
        } catch {}
      }

      // 방법 4: script 태그에서 직접 처리 시도
      const scripts = document.querySelectorAll('script[_ajs_]');
      if (scripts.length > 0) {
        const s = scripts[0];
        // pnp4web이 이 스크립트를 아직 처리 안 했는지 확인
        result.scriptProcessed = s.textContent.length > 0;
        result.scriptAttributes = {};
        for (const attr of s.attributes) {
          result.scriptAttributes[attr.name] = attr.value.substring(0, 100);
        }
      }

      return result;
    }, ahFull[0].content);

    console.log(`   복호화 시도 결과: ${JSON.stringify(browserDecrypt, null, 2)}`);
  }

  const html = await page.content();
  await browser.close();

  await fs.writeFile('data/diag-phone.html', html);
  const report = { timestamp: new Date().toISOString(), ahScripts, decryptResult, ahFull: ahFull.map(a => ({ pos: a.pos, length: a.length })) };
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));

  console.log('\n✅ 저장 완료');
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
