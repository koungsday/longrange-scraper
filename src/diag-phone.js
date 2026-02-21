#!/usr/bin/env node
/**
 * 진단 v10: 원본 HTML 분석 + Document.prototype.write 후킹
 *
 * v8-v9 결과: 585KB HTML 수신 → body=0자, scripts=1. pnp4web이 실행되지 않음.
 * 핵심 의문: 585KB에 뭐가 들어있는가? document.write 훅이 우회되고 있는가?
 *
 * 이번 진단:
 * 1. 원본 HTTP 응답 body를 파일로 저장 (data/raw-phone-response.html)
 * 2. 원본 HTML 구조 분석 (script, _ah_, body, table 등)
 * 3. Document.prototype.write/writeln 까지 후킹 (인스턴스 + 프로토타입)
 * 4. 모든 JS 에러 캡처
 * 5. 로드된 모든 외부 스크립트 URL 기록
 */
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const fs = require('fs/promises');

const BASE = 'https://ev.or.kr/nportal/buySupprt';
const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
const PHONE_URL = `${BASE}/psLocalPhone.do`;

async function main() {
  console.log('=== 진단 v10: 원본 HTML 분석 ===\n');
  await fs.mkdir('data', { recursive: true });

  const browser = await puppeteerExtra.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1920,1080', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // ========== 1. 후킹: 인스턴스 + 프로토타입 ==========
  await page.evaluateOnNewDocument(() => {
    window.__writes = [];     // document.write 캡처
    window.__protoWrites = []; // Document.prototype.write 캡처
    window.__evals = [];
    window.__errors = [];
    window.__allWriteHtml = '';

    // (A) document.write 인스턴스 후킹
    const origWrite = document.write.bind(document);
    const origWriteln = document.writeln.bind(document);
    document.write = function(html) {
      window.__writes.push({ len: String(html).length, t: Date.now(), snippet: String(html).substring(0, 500) });
      window.__allWriteHtml += String(html);
      return origWrite(html);
    };
    document.writeln = function(html) {
      window.__writes.push({ len: String(html).length, t: Date.now(), snippet: String(html).substring(0, 500) });
      window.__allWriteHtml += String(html) + '\n';
      return origWriteln(html);
    };

    // (B) Document.prototype.write 프로토타입 후킹
    const protoWrite = Document.prototype.write;
    const protoWriteln = Document.prototype.writeln;
    Document.prototype.write = function(html) {
      window.__protoWrites.push({ len: String(html).length, t: Date.now(), snippet: String(html).substring(0, 500) });
      window.__allWriteHtml += String(html);
      return protoWrite.call(this, html);
    };
    Document.prototype.writeln = function(html) {
      window.__protoWrites.push({ len: String(html).length, t: Date.now(), snippet: String(html).substring(0, 500) });
      window.__allWriteHtml += String(html) + '\n';
      return protoWriteln.call(this, html);
    };

    // (C) eval 후킹
    const origEval = window.eval;
    window.eval = function(code) {
      window.__evals.push({ len: String(code).length, snippet: String(code).substring(0, 1000) });
      return origEval.call(this, code);
    };

    // (D) 에러 캡처
    window.addEventListener('error', e => {
      window.__errors.push({ msg: e.message, file: e.filename, line: e.lineno, col: e.colno });
    });
  });

  // ========== 2. 네트워크: 원본 응답 저장 ==========
  const allScriptUrls = [];
  const allResponses = [];

  page.on('response', async res => {
    const url = res.url();
    // 모든 .do 응답 기록
    if (url.includes('.do')) {
      const entry = { url, status: res.status(), ct: res.headers()['content-type'] || '' };
      try {
        const body = await res.text();
        entry.size = body.length;
        entry.phones = (body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []).length;
        // psLocalPhone.do 원본 저장 (핵심!)
        if (url.includes('psLocalPhone.do')) {
          await fs.writeFile('data/raw-phone-response.html', body);
          console.log(`   ✅ 원본 응답 저장: ${body.length}자 → data/raw-phone-response.html`);
        }
      } catch {}
      allResponses.push(entry);
    }
    // JS 파일 URL 기록
    if (url.endsWith('.js') || url.includes('.js?')) {
      allScriptUrls.push(url);
    }
  });

  // 모든 콘솔 메시지 캡처
  const consoleMsgs = [];
  page.on('console', msg => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
  });

  // JS 에러 캡처
  page.on('pageerror', err => {
    consoleMsgs.push({ type: 'pageerror', text: err.message });
  });

  // ========== 3. 페이지 로딩 ==========
  console.log('===== PART A: 페이지 로딩 =====\n');

  console.log('   세션 수립...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  console.log('   전화번호 페이지...');
  const t0 = Date.now();
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   페이지 로드: ${Date.now() - t0}ms`);

  // 대기 (10초 — pnp4web + 데이터 로드)
  console.log('   대기 (10초)...');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if ((i + 1) % 5 === 0) {
      const s = await page.evaluate(() => ({
        body: (document.body?.innerText || '').length,
        html: (document.body?.innerHTML || '').length,
        scripts: document.querySelectorAll('script').length,
        writes: window.__writes.length,
        protoWrites: window.__protoWrites.length,
        evals: window.__evals.length,
        errors: window.__errors.length,
      }));
      console.log(`   ${i+1}초: body=${s.body}, html=${s.html}, scripts=${s.scripts}, writes=${s.writes}, protoWrites=${s.protoWrites}, evals=${s.evals}, errors=${s.errors}`);
    }
  }

  // ========== 4. 후킹 결과 ==========
  console.log('\n===== PART B: 후킹 캡처 =====\n');

  const hooks = await page.evaluate(() => ({
    writes: window.__writes.map(w => ({ len: w.len, snippet: w.snippet })),
    protoWrites: window.__protoWrites.map(w => ({ len: w.len, snippet: w.snippet })),
    evals: window.__evals.map(e => ({ len: e.len, snippet: e.snippet })),
    errors: window.__errors,
    totalWriteLen: window.__allWriteHtml.length,
    writeHtmlSample: window.__allWriteHtml.substring(0, 2000),
  }));

  console.log(`   document.write: ${hooks.writes.length}회`);
  hooks.writes.forEach((w, i) => console.log(`   [write ${i}] ${w.len}자: ${w.snippet.substring(0, 200)}`));

  console.log(`   Document.prototype.write: ${hooks.protoWrites.length}회`);
  hooks.protoWrites.forEach((w, i) => console.log(`   [proto ${i}] ${w.len}자: ${w.snippet.substring(0, 200)}`));

  console.log(`   eval: ${hooks.evals.length}회`);
  hooks.evals.forEach((e, i) => console.log(`   [eval ${i}] ${e.len}자: "${e.snippet}"`));

  console.log(`   JS 에러: ${hooks.errors.length}개`);
  hooks.errors.forEach((e, i) => console.log(`   [err ${i}] ${e.msg} @ ${e.file}:${e.line}`));

  if (hooks.totalWriteLen > 0) {
    console.log(`\n   write 총 출력: ${hooks.totalWriteLen}자`);
    console.log(`   샘플: ${hooks.writeHtmlSample}`);
    await fs.writeFile('data/write-output.html', await page.evaluate(() => window.__allWriteHtml)).catch(() => {});
  }

  // ========== 5. 원본 HTML 분석 ==========
  console.log('\n===== PART C: 원본 HTML 구조 분석 =====\n');

  let rawHtml = '';
  try { rawHtml = await fs.readFile('data/raw-phone-response.html', 'utf8'); } catch {}

  if (rawHtml) {
    console.log(`   원본 크기: ${rawHtml.length}자`);

    // 기본 구조
    const hasDoctype = rawHtml.startsWith('<!DOCTYPE') || rawHtml.startsWith('<!doctype');
    const headMatch = rawHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    console.log(`   DOCTYPE: ${hasDoctype}`);
    console.log(`   <head> 길이: ${headMatch ? headMatch[1].length : 'N/A'}자`);
    console.log(`   <body> 길이: ${bodyMatch ? bodyMatch[1].length : 'N/A'}자`);

    // script 태그
    const scriptTags = [...rawHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    console.log(`   <script> 태그: ${scriptTags.length}개`);
    scriptTags.forEach((m, i) => {
      const attrs = m[1].trim();
      const bodyLen = m[2].length;
      const hasSrc = attrs.includes('src=');
      const hasAjs = attrs.includes('_ajs_');
      const hasAh = attrs.includes('_ah_');
      console.log(`   [script ${i}] attrs="${attrs.substring(0, 150)}" body=${bodyLen}자 src=${hasSrc} _ajs_=${hasAjs} _ah_=${hasAh}`);
      if (!hasSrc && bodyLen > 0 && bodyLen < 500) {
        console.log(`     내용: ${m[2].substring(0, 300)}`);
      }
    });

    // _ah_ 속성 (스크립트 외에도 있을 수 있음)
    const ahAttrs = [...rawHtml.matchAll(/_ah_\s*=\s*['"]([^'"]*)['"]/g)];
    console.log(`\n   _ah_ 속성: ${ahAttrs.length}개`);
    ahAttrs.forEach((m, i) => {
      console.log(`   [ah ${i}] ${m[1].length}자: ${m[1].substring(0, 100)}...`);
    });

    // pnp4web 참조
    const pnpRefs = rawHtml.match(/pnp4web[^'"<>]*/gi) || [];
    console.log(`   pnp4web 참조: ${pnpRefs.length}개`);
    pnpRefs.forEach(r => console.log(`     ${r}`));

    // table 태그
    const tables = [...rawHtml.matchAll(/<table([^>]*)>/gi)];
    console.log(`   <table> 태그: ${tables.length}개`);

    // 전화번호 패턴
    const phonePatterns = rawHtml.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];
    console.log(`   전화번호 패턴: ${phonePatterns.length}개`);
    if (phonePatterns.length > 0) console.log(`   샘플: ${phonePatterns.slice(0, 5).join(', ')}`);

    // 처음/끝 500자
    console.log(`\n   === 원본 HTML 처음 500자 ===`);
    console.log(rawHtml.substring(0, 500));
    console.log(`\n   === 원본 HTML 마지막 500자 ===`);
    console.log(rawHtml.substring(rawHtml.length - 500));

    // body 태그 내용 처음 1000자
    if (bodyMatch) {
      console.log(`\n   === <body> 처음 1000자 ===`);
      console.log(bodyMatch[1].substring(0, 1000));
    }
  } else {
    console.log('   ⚠️ 원본 HTML 파일 없음');
  }

  // ========== 6. 현재 DOM 상태 ==========
  console.log('\n===== PART D: 현재 DOM 상태 =====\n');

  const dom = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyText: (document.body?.innerText || '').length,
    bodyHtml: (document.body?.innerHTML || '').length,
    allElements: document.querySelectorAll('*').length,
    scripts: document.querySelectorAll('script').length,
    scriptSrcs: [...document.querySelectorAll('script[src]')].map(s => s.src),
    tables: document.querySelectorAll('table').length,
    tds: document.querySelectorAll('td').length,
    docHtml: document.documentElement.outerHTML.substring(0, 1000),
  }));

  console.log(`   title: "${dom.title}"`);
  console.log(`   url: ${dom.url}`);
  console.log(`   body text: ${dom.bodyText}자, html: ${dom.bodyHtml}자`);
  console.log(`   전체 요소: ${dom.allElements}개`);
  console.log(`   scripts: ${dom.scripts}, tables: ${dom.tables}, tds: ${dom.tds}`);
  console.log(`   script srcs: ${dom.scriptSrcs.join(' | ') || '없음'}`);
  console.log(`\n   === 현재 DOM 처음 1000자 ===`);
  console.log(dom.docHtml);

  // ========== 7. 네트워크 요약 ==========
  console.log('\n===== PART E: 네트워크 =====\n');

  console.log(`   .do 응답: ${allResponses.length}개`);
  allResponses.forEach(r => console.log(`   ${r.status} ${r.url} size=${r.size || '?'} phones=${r.phones || 0}`));

  console.log(`\n   로드된 JS: ${allScriptUrls.length}개`);
  allScriptUrls.forEach(u => console.log(`   ${u}`));

  console.log(`\n   콘솔 메시지: ${consoleMsgs.length}개`);
  consoleMsgs.forEach(m => console.log(`   [${m.type}] ${m.text.substring(0, 200)}`));

  // ========== 저장 ==========
  const pageHtml = await page.content();
  await browser.close();

  await fs.writeFile('data/diag-phone.html', pageHtml);
  await fs.writeFile('data/diag-phone.json', JSON.stringify({
    timestamp: new Date().toISOString(), version: 'v10',
    hooks: { writes: hooks.writes.length, protoWrites: hooks.protoWrites.length, evals: hooks.evals.length, errors: hooks.errors.length },
    dom: { bodyText: dom.bodyText, bodyHtml: dom.bodyHtml, scripts: dom.scripts, tables: dom.tables },
    network: { responses: allResponses.length, jsFiles: allScriptUrls.length },
    rawHtmlSize: rawHtml.length,
  }, null, 2));

  console.log('\n✅ 진단 v10 완료');
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
