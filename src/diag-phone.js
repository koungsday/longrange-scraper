#!/usr/bin/env node
/**
 * 진단 스크립트: psLocalPhone.do 페이지의 모든 네트워크 요청을 캡처
 * pnp4web이 복호화 후 어떤 AJAX 엔드포인트를 호출하는지 확인
 */
const puppeteer = require('puppeteer');
const fs = require('fs/promises');

const MAIN_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function main() {
  console.log('=== 전화번호 페이지 네트워크 진단 ===\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();

  // 봇 감지 우회
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

  // ========== 1. 모든 네트워크 요청 캡처 ==========
  const requests = [];
  const responses = [];

  await page.setRequestInterception(true);
  page.on('request', req => {
    requests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      headers: req.headers(),
      postData: req.postData() || null,
    });
    req.continue();
  });

  page.on('response', async res => {
    const entry = {
      url: res.url(),
      status: res.status(),
      contentType: res.headers()['content-type'] || '',
      bodySnippet: null,
    };

    // HTML/JSON/text 응답만 본문 캡처 (이미지/폰트 제외)
    const ct = entry.contentType.toLowerCase();
    if (ct.includes('html') || ct.includes('json') || ct.includes('text') || ct.includes('javascript') || ct.includes('properties')) {
      try {
        const body = await res.text();
        entry.bodySize = body.length;
        // 전화번호 패턴 확인
        const phoneMatches = body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];
        entry.phonePatterns = phoneMatches.length;
        if (phoneMatches.length > 0) {
          entry.phoneSamples = phoneMatches.slice(0, 5);
        }
        // 본문 스니펫 (처음 500자)
        entry.bodySnippet = body.substring(0, 500);
        // 전화번호가 있는 응답은 더 많이 저장
        if (phoneMatches.length > 0) {
          entry.bodyFull = body.substring(0, 5000);
        }
      } catch {}
    }

    responses.push(entry);
  });

  // 콘솔 메시지 캡처
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push({ type: msg.type(), text: msg.text() });
  });

  // 에러 캡처
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  // ========== 2. 세션 수립 → 전화번호 페이지 ==========
  console.log('1. 세션 수립 (메인 페이지)...');
  await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   완료. 요청 ${requests.length}개`);

  const prePhoneRequestCount = requests.length;

  console.log('\n2. 전화번호 페이지 이동...');
  await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`   완료. 새 요청 ${requests.length - prePhoneRequestCount}개`);

  // ========== 3. pnp4web 복호화 대기 ==========
  console.log('\n3. pnp4web 복호화 대기 (20초)...');
  await new Promise(r => setTimeout(r, 20000));
  console.log(`   완료. 총 요청 ${requests.length}개`);

  // ========== 4. DOM 상태 분석 ==========
  console.log('\n4. DOM 상태 분석...');
  const domAnalysis = await page.evaluate(() => {
    const result = {
      title: document.title,
      allTables: [],
      allForms: [],
      allButtons: [],
      allIframes: [],
      allScriptSrcs: [],
      inlineScripts: [],
      globalFunctions: [],
      phoneInDOM: [],
    };

    // 테이블 분석
    document.querySelectorAll('table').forEach((t, i) => {
      const rows = t.querySelectorAll('tr');
      const firstRowText = rows[0] ? rows[0].textContent.trim().substring(0, 200) : '';
      result.allTables.push({
        index: i,
        id: t.id || '',
        className: t.className || '',
        rows: rows.length,
        firstRow: firstRowText,
      });
    });

    // 폼 분석
    document.querySelectorAll('form').forEach(f => {
      result.allForms.push({
        id: f.id || '',
        action: f.action || '',
        method: f.method || '',
        inputs: [...f.querySelectorAll('input')].map(i => ({
          name: i.name, type: i.type, value: i.value
        })).slice(0, 10),
      });
    });

    // 버튼 분석
    document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, .btn, [onclick]').forEach(b => {
      result.allButtons.push({
        tag: b.tagName,
        text: (b.textContent || b.value || '').trim().substring(0, 50),
        onclick: (b.getAttribute('onclick') || '').substring(0, 100),
        id: b.id || '',
        className: b.className || '',
      });
    });

    // iframe 분석
    document.querySelectorAll('iframe').forEach(f => {
      result.allIframes.push({ src: f.src, id: f.id || '' });
    });

    // 스크립트 분석
    document.querySelectorAll('script').forEach(s => {
      if (s.src) {
        result.allScriptSrcs.push(s.src);
      } else {
        const text = s.textContent.trim();
        if (text.length > 0 && text.length < 2000) {
          result.inlineScripts.push(text.substring(0, 500));
        } else if (text.length >= 2000) {
          result.inlineScripts.push(`[${text.length}chars] ${text.substring(0, 300)}...`);
        }
      }
    });

    // 주요 전역 함수 검색
    const fnCandidates = ['fnSearch', 'fn_search', 'doSearch', 'fnList', 'getList',
      'selectList', 'fnSelectList', 'searchList', 'fn_selectList', 'goList',
      'fn_goList', 'fnPhoneList', 'fnLocalPhone', 'selectLocalPhone',
      'psLocalPhoneList', 'fnInit', 'fn_init', 'initPage', 'pageInit',
      'fn_pageInit', 'onload', 'ready', 'fn_submit', 'doSubmit'];
    fnCandidates.forEach(fn => {
      if (typeof window[fn] === 'function') {
        result.globalFunctions.push(fn);
      }
    });

    // DOM 내 전화번호 패턴
    const bodyText = document.body.innerText;
    const phoneMatches = bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];
    result.phoneInDOM = phoneMatches.slice(0, 10);
    result.totalPhonesInDOM = phoneMatches.length;

    // 전체 body text 길이
    result.bodyTextLength = bodyText.length;
    result.bodyTextSnippet = bodyText.substring(0, 1000);

    return result;
  });

  console.log(`   제목: ${domAnalysis.title}`);
  console.log(`   테이블: ${domAnalysis.allTables.length}개`);
  console.log(`   폼: ${domAnalysis.allForms.length}개`);
  console.log(`   버튼: ${domAnalysis.allButtons.length}개`);
  console.log(`   전역함수: [${domAnalysis.globalFunctions.join(', ')}]`);
  console.log(`   DOM내 전화번호: ${domAnalysis.totalPhonesInDOM}개`);

  // ========== 5. 버튼 클릭 시도 후 추가 요청 캡처 ==========
  const preClickRequests = requests.length;
  console.log('\n5. 조회 버튼 클릭 시도...');

  const clickResult = await page.evaluate(() => {
    const results = [];
    const els = document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, .btn, [onclick]');
    for (const el of els) {
      const text = (el.textContent || el.value || '').trim();
      const onclick = el.getAttribute('onclick') || '';
      if (text.includes('조회') || text.includes('검색') || text.includes('Search') ||
          onclick.includes('search') || onclick.includes('Phone') || onclick.includes('list') || onclick.includes('List')) {
        try {
          el.click();
          results.push(`Clicked: "${text}" onclick="${onclick.substring(0, 50)}"`);
        } catch (e) {
          results.push(`Error clicking "${text}": ${e.message}`);
        }
      }
    }
    return results;
  });

  console.log(`   클릭 결과: ${JSON.stringify(clickResult)}`);

  // 클릭 후 10초 대기
  console.log('   클릭 후 10초 대기...');
  await new Promise(r => setTimeout(r, 10000));
  console.log(`   새 요청 ${requests.length - preClickRequests}개 발생`);

  // ========== 6. 최종 DOM 재분석 ==========
  console.log('\n6. 최종 DOM 재분석...');
  const finalDOM = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const phoneMatches = bodyText.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [];

    const tables = [];
    document.querySelectorAll('table').forEach((t, i) => {
      const rows = t.querySelectorAll('tr');
      const tbodyRows = t.querySelectorAll('tbody tr');
      tables.push({
        index: i,
        id: t.id,
        className: t.className,
        totalRows: rows.length,
        tbodyRows: tbodyRows.length,
        // 처음 3행의 텍스트
        sampleRows: [...rows].slice(0, 3).map(r => r.textContent.trim().substring(0, 200)),
      });
    });

    return {
      totalPhonesInDOM: phoneMatches.length,
      phoneSamples: phoneMatches.slice(0, 10),
      bodyTextLength: bodyText.length,
      tables,
    };
  });

  console.log(`   최종 전화번호: ${finalDOM.totalPhonesInDOM}개`);
  if (finalDOM.phoneSamples.length > 0) {
    console.log(`   샘플: ${finalDOM.phoneSamples.join(', ')}`);
  }

  // ========== 7. 전체 HTML 저장 ==========
  const html = await page.content();

  await browser.close();

  // ========== 8. 결과 저장 ==========
  const report = {
    timestamp: new Date().toISOString(),
    urls: { main: MAIN_URL, phone: PHONE_URL },
    totalRequests: requests.length,
    totalResponses: responses.length,

    // 전화번호 페이지 요청만 필터 (세션수립 이후)
    phonePageRequests: requests.slice(prePhoneRequestCount).map(r => ({
      url: r.url,
      method: r.method,
      type: r.resourceType,
      postData: r.postData,
    })),

    // 전화번호 패턴이 있는 응답
    responsesWithPhones: responses.filter(r => r.phonePatterns > 0),

    // 모든 XHR/fetch 응답
    xhrResponses: responses.filter(r => {
      const url = r.url;
      return url.includes('.do') || url.includes('/api/') || url.includes('ajax') ||
             url.includes('Action') || r.contentType.includes('json');
    }),

    domAnalysis,
    finalDOM,
    consoleLogs: consoleLogs.slice(0, 50),
    errors,

    // HTML 크기
    htmlSize: html.length,
  };

  // 보고서 저장
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/diag-phone.json', JSON.stringify(report, null, 2));
  console.log('\n✅ 진단 보고서 저장: data/diag-phone.json');

  // 원본 HTML 저장
  await fs.writeFile('data/diag-phone.html', html);
  console.log('✅ 원본 HTML 저장: data/diag-phone.html');

  // ========== 9. 핵심 요약 출력 ==========
  console.log('\n========== 핵심 요약 ==========');
  console.log(`총 네트워크 요청: ${requests.length}개`);
  console.log(`전화번호 페이지 이후 요청: ${requests.length - prePhoneRequestCount}개`);
  console.log(`전화번호 포함 응답: ${report.responsesWithPhones.length}개`);
  console.log(`.do/.Action 응답: ${report.xhrResponses.length}개`);
  console.log(`DOM 내 전화번호 (초기): ${domAnalysis.totalPhonesInDOM}개`);
  console.log(`DOM 내 전화번호 (최종): ${finalDOM.totalPhonesInDOM}개`);

  console.log('\n--- .do 엔드포인트 목록 ---');
  const doUrls = [...new Set(requests.filter(r => r.url.includes('.do')).map(r => `${r.method} ${r.url}`))];
  doUrls.forEach(u => console.log(`  ${u}`));

  console.log('\n--- 전화번호 포함 응답 ---');
  report.responsesWithPhones.forEach(r => {
    console.log(`  ${r.url}`);
    console.log(`    status=${r.status}, phones=${r.phonePatterns}, size=${r.bodySize}`);
    if (r.phoneSamples) console.log(`    samples: ${r.phoneSamples.join(', ')}`);
  });

  console.log('\n--- 전역 JS 함수 ---');
  console.log(`  ${domAnalysis.globalFunctions.join(', ') || '(없음)'}`);

  console.log('\n--- 버튼/클릭 가능 요소 ---');
  domAnalysis.allButtons.forEach(b => {
    console.log(`  [${b.tag}] "${b.text}" onclick="${b.onclick}" id="${b.id}"`);
  });

  console.log('\n--- 폼 ---');
  domAnalysis.allForms.forEach(f => {
    console.log(`  action="${f.action}" method="${f.method}" id="${f.id}"`);
    f.inputs.forEach(i => console.log(`    <input name="${i.name}" type="${i.type}" value="${i.value}">`));
  });

  console.log('\n--- 인라인 스크립트 (처음 5개) ---');
  domAnalysis.inlineScripts.slice(0, 5).forEach((s, i) => {
    console.log(`  [${i}] ${s.substring(0, 200)}`);
  });
}

main().catch(err => {
  console.error('💥 진단 실패:', err);
  process.exit(1);
});
