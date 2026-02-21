const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const TEST_MODE = false; // false = 전체 161개 지역
const MAX_RETRIES = 3;

// 연도 자동 계산 (한국 시간 기준)
const CURRENT_YEAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getFullYear();

// ==========================================
// 데이터 정규화 유틸리티
// ==========================================

/**
 * 차량 마스터 데이터 추출 (국고 보조금 포함)
 * 첫 번째 성공한 지역에서 추출하여 재사용
 */
function extractVehicleMaster(allResults) {
  const vehicles = {};

  // 성공한 첫 번째 지역에서 차량 정보 추출
  const firstSuccess = allResults.find(r => r.success && Object.keys(r.vehicles).length > 0);
  if (!firstSuccess) return vehicles;

  for (const [key, vehicle] of Object.entries(firstSuccess.vehicles)) {
    vehicles[key] = {
      type: vehicle.type,
      manufacturer: vehicle.manufacturer,
      model: vehicle.model,
      national: vehicle.national  // 국고 보조금은 전국 동일
    };
  }

  return vehicles;
}

/**
 * 연도 목록 업데이트 (years.json)
 * 프론트엔드에서 사용 가능한 연도 목록을 관리
 */
async function updateYearsList(currentYear) {
  const yearsFile = 'data/years.json';
  let yearsData = { years: [], lastUpdated: null };

  try {
    const existing = await fs.readFile(yearsFile, 'utf-8');
    yearsData = JSON.parse(existing);
  } catch (e) {
    // 파일이 없으면 새로 생성
  }

  // 현재 연도 추가 (중복 방지, 내림차순 정렬)
  if (!yearsData.years.includes(currentYear)) {
    yearsData.years.push(currentYear);
  }
  yearsData.years = yearsData.years.sort((a, b) => b - a); // 내림차순 (최신이 먼저)
  yearsData.lastUpdated = new Date().toISOString();
  yearsData.currentYear = currentYear;

  await fs.writeFile(yearsFile, JSON.stringify(yearsData, null, 2));
  console.log(`💾 data/years.json 업데이트 (사용 가능 연도: ${yearsData.years.join(', ')})`);
}

/**
 * 정규화된 지역별 보조금 데이터 생성
 * 지자체 보조금(local)만 저장하여 크기 대폭 감소
 */
function normalizeSubsidies(allResults) {
  const regions = {};

  for (const result of allResults) {
    const regionKey = String(result.code);

    // 지역별 지자체 보조금만 추출
    const subsidies = {};
    for (const [vehicleKey, vehicle] of Object.entries(result.vehicles)) {
      subsidies[vehicleKey] = vehicle.local;  // 지자체 보조금만
    }

    regions[regionKey] = {
      parentName: result.parentName,
      localName: result.localName,
      code: result.code,
      success: result.success,
      subsidies: subsidies
    };
  }

  return regions;
}

// ==========================================
// 1. 지역 목록 가져오기
// ==========================================
async function getAllRegions() {
  console.log('📍 지역 목록 로딩...');
  
  try {
    const response = await axios.get('https://api.donut.im/api/v1/regions/list');
    const allRegions = [];
    
    response.data.regions.forEach(region => {
      const localType = region.localType;
      
      if (region.local && Array.isArray(region.local)) {
        region.local.forEach(local => {
          allRegions.push({
            parentName: localType,
            localName: local.name,
            code: local.code
          });
        });
      }
    });
    
    console.log(`✅ 총 ${allRegions.length}개 지역`);
    
    if (TEST_MODE) {
      console.log(`🧪 테스트 모드: 10개만 처리`);
      return allRegions.slice(0, 10);
    }
    
    return allRegions;
    
  } catch (error) {
    console.error('❌ 지역 목록 로딩 실패:', error.message);
    throw error;
  }
}

// ==========================================
// 2. HTML 파싱 - 모든 제조사
// ==========================================
function parseEVTableALL(html) {
  const vehicles = {};
  
  if (!html || typeof html !== 'string') return vehicles;
  
  const $ = cheerio.load(html);
  
  $('tr').each((i, row) => {
    const cells = [];
    
    $(row).find('td').each((j, cell) => {
      let text = $(cell).text().trim().replace(/\s+/g, ' ');
      cells.push(text);
    });
    
    // 제조사 필터 없음 - 모든 차량
    if (cells.length >= 6 && cells[1] && cells[2]) {
      const manufacturer = cells[1];
      const model = cells[2];
      const key = `${manufacturer}___${model}`; // 고유 키 (3개 언더스코어로 구분)
      
      try {
        vehicles[key] = {
          type: cells[0],
          manufacturer: manufacturer,
          model: model,
          national: parseInt(cells[3]) * 10000,
          local: parseInt(cells[4]) * 10000,
          total: parseInt(cells[5]) * 10000
        };
      } catch (e) {
        // 파싱 오류 무시
      }
    }
  });
  
  return vehicles;
}

// ==========================================
// 3. 재시도 로직 포함 스크래핑
// ==========================================
async function scrapeRegionWithRetry(browser, region) {
  const targetUrl = `https://ev.or.kr/nportal/buySupprt/psPopupLocalCarModelPrice.do?year=${CURRENT_YEAR}&local_cd=${region.code}&local_nm=${encodeURIComponent(region.localName)}&car_type=11&pnph=`;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;
    
    try {
      // ⭐ 브라우저 재사용: 새로운 페이지(탭)만 생성
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(30000);
      await page.setDefaultTimeout(30000);
      
      await page.goto(targetUrl, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      await page.waitForSelector('table', { timeout: 10000 });
      const html = await page.content();
      
      // 서울과 부산만 HTML 저장
      if (region.code === 1100 || region.code === 2600) {
        try {
          await fs.mkdir('data', { recursive: true });
          await fs.writeFile(`data/debug-subsidy-${region.code}.html`, html);
          console.log(`    💾 debug-subsidy-${region.code}.html 저장됨`);
        } catch (e) {
          console.log(`    ⚠️ HTML 저장 실패 (무시)`);
        }
      }
      
      // ⭐ 브라우저 재사용: 페이지(탭)만 종료
      await page.close();
      
      const vehicles = parseEVTableALL(html);
      
      if (attempt > 1) {
        console.log(`    ✅ 재시도 ${attempt}회 성공`);
      }
      
      return {
        parentName: region.parentName,
        localName: region.localName,
        code: region.code,
        vehicles: vehicles,
        success: true,
        attempts: attempt,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      if (page) await page.close();
      
      if (attempt < MAX_RETRIES) {
        console.log(`    ⚠️ 재시도 ${attempt}/${MAX_RETRIES}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      } else {
        console.error(`    ❌ 최종 실패: ${error.message}`);
        return {
          parentName: region.parentName,
          localName: region.localName,
          code: region.code,
          vehicles: {},
          success: false,
          error: error.message,
          attempts: attempt,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
}

// ==========================================
// 4. 지역별 부처 전화번호 스크래핑
// ==========================================
// 진단 결과:
//   - 전역함수: initPage (데이터 로드 트리거로 추정)
//   - 폼 ffrm: 만족도 조사 폼 (데이터 로드와 무관)
//   - script=0 (인라인), 외부 JS에서 initPage 정의
//   - 페이지 로드 시 initPage 자동호출 안 됨 → 명시적 호출 필요
// 전략: initPage() 호출 → AJAX 캡처 → 직접 엔드포인트 요청
async function scrapeLocalPhones(browser) {
  console.log('📞 지역별 부처 전화번호 스크래핑...');
  const BASE = 'https://ev.or.kr/nportal/buySupprt';
  const MAIN_URL = `${BASE}/initSubsidyPaymentCheckAction.do`;
  const PHONE_URL = `${BASE}/psLocalPhone.do`;
  const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  // ── 전략 1: Puppeteer + initPage() 호출 + AJAX 엔드포인트 캡처 ──
  let discoveredEndpoints = []; // Puppeteer에서 발견한 AJAX 엔드포인트

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;
    try {
      page = await browser.newPage();

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

      // 네트워크 요청/응답 캡처 (initPage가 호출하는 AJAX 엔드포인트 발견)
      const capturedRequests = [];
      const capturedResponses = [];
      page.on('request', req => {
        if (req.url().includes('.do') || req.url().includes('/api/')) {
          capturedRequests.push({
            url: req.url(), method: req.method(),
            postData: req.postData() || null,
          });
        }
      });
      page.on('response', async res => {
        const url = res.url();
        if (url.includes('.do') || url.includes('/api/')) {
          const entry = { url, status: res.status(), ct: (res.headers()['content-type'] || '') };
          // 응답 본문 캡처 (전화번호 확인용)
          try {
            const body = await res.text();
            const phones = (body.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
            entry.phoneCount = phones.length;
            entry.bodySize = body.length;
            if (phones.length > 0) {
              entry.phoneSample = phones.slice(0, 3);
              entry.bodySnippet = body.substring(0, 500);
            }
          } catch {}
          capturedResponses.push(entry);
        }
      });

      // 세션 수립 → 전화번호 페이지
      await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      const prePhoneReqCount = capturedRequests.length;
      await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      // (A) 자동 로드 대기 (짧게)
      let found = false;
      try {
        await page.waitForSelector('table tbody tr td', { timeout: 5000 });
        found = true;
        console.log('   ✅ 자동 로드 성공');
      } catch {}

      // (B) initPage() 즉시 호출 (핵심!)
      if (!found) {
        const preCallReqCount = capturedRequests.length;
        console.log('   📞 initPage() 호출...');
        const callResult = await page.evaluate(() => {
          if (typeof initPage === 'function') {
            try { initPage(); return 'called'; } catch (e) { return `err:${e.message}`; }
          }
          return 'not-found';
        });
        console.log(`   ℹ️ initPage() → ${callResult}`);

        if (callResult === 'called') {
          // initPage가 트리거한 AJAX 요청 대기
          await new Promise(r => setTimeout(r, 5000));
          const newReqs = capturedRequests.slice(preCallReqCount);
          if (newReqs.length > 0) {
            console.log(`   ℹ️ initPage() 후 새 요청 ${newReqs.length}개:`);
            newReqs.forEach(r => console.log(`      ${r.method} ${r.url} ${r.postData ? `POST: ${r.postData.substring(0, 100)}` : ''}`));
            // 발견된 엔드포인트 저장 (HTTP 폴백에서 사용)
            discoveredEndpoints = newReqs.map(r => ({ url: r.url, method: r.method, postData: r.postData }));
          }

          // 데이터 확인
          const rows = await page.evaluate(() =>
            document.querySelectorAll('table tbody tr td').length
          );
          if (rows > 0) {
            found = true;
            console.log(`   ✅ initPage() 성공: td=${rows}`);
          }

          // 좀 더 대기 (AJAX 응답 처리 시간)
          if (!found) {
            await new Promise(r => setTimeout(r, 5000));
            const rows2 = await page.evaluate(() =>
              document.querySelectorAll('table tbody tr td').length
            );
            if (rows2 > 0) {
              found = true;
              console.log(`   ✅ initPage() 지연 성공: td=${rows2}`);
            }
          }
        }
      }

      // (C) 다른 전역 함수 시도
      if (!found) {
        const globalFns = await page.evaluate(() => {
          const fns = ['fnSearch', 'fn_search', 'doSearch', 'fnList', 'getList',
            'selectList', 'fnSelectList', 'searchList', 'goList', 'fnPhoneList',
            'fnLocalPhone', 'selectLocalPhone', 'fn_submit', 'doSubmit'];
          return fns.filter(fn => typeof window[fn] === 'function');
        });

        for (const fn of globalFns) {
          console.log(`   📞 ${fn}() 호출...`);
          await page.evaluate(fn => { try { window[fn](); } catch {} }, fn);
          await new Promise(r => setTimeout(r, 3000));
          const rows = await page.evaluate(() =>
            document.querySelectorAll('table tbody tr td').length
          );
          if (rows > 0) { found = true; console.log(`   ✅ ${fn}() 성공: td=${rows}`); break; }
        }
      }

      // 페이지 분석 로그
      const pageInfo = await page.evaluate(() => {
        const tables = [];
        document.querySelectorAll('table').forEach((t, i) => {
          tables.push({
            idx: i, id: t.id, cls: t.className,
            thead: t.querySelectorAll('thead tr').length,
            tbody: t.querySelectorAll('tbody tr').length,
            allTr: t.querySelectorAll('tr').length,
          });
        });
        return {
          tables,
          scripts: document.querySelectorAll('script').length,
          scriptSrcs: [...document.querySelectorAll('script[src]')].map(s => s.src).slice(0, 10),
          bodyTextLen: (document.body ? document.body.innerText.length : 0),
        };
      });
      console.log(`   ℹ️ tables=${JSON.stringify(pageInfo.tables)}, scripts=${pageInfo.scripts}`);
      if (pageInfo.scriptSrcs.length > 0) {
        console.log(`   ℹ️ 외부JS: ${pageInfo.scriptSrcs.join(' | ')}`);
      }

      // 캡처된 .do 응답 로그
      const phoneResponses = capturedResponses.filter(r => r.phoneCount > 0);
      if (phoneResponses.length > 0) {
        console.log(`   ℹ️ 전화번호 포함 응답:`);
        phoneResponses.forEach(r => {
          console.log(`      ${r.url} phones=${r.phoneCount} size=${r.bodySize}`);
          if (r.bodySnippet) console.log(`      snippet: ${r.bodySnippet.substring(0, 200)}`);
        });
      }

      // 전체 캡처된 .do 엔드포인트 (전화번호 페이지 이후만)
      const phonePageResps = capturedResponses.slice(
        capturedResponses.findIndex(r => r.url.includes('psLocalPhone'))
      );
      if (phonePageResps.length > 0) {
        console.log(`   ℹ️ .do 응답 (phone 페이지 이후):`);
        phonePageResps.forEach(r => console.log(`      ${r.status} ${r.url} ct=${r.ct} phones=${r.phoneCount || 0}`));
      }

      // HTML 추출
      const html = await page.content();

      // 디버그 HTML 저장 (첫 시도만)
      if (attempt === 1) {
        await fs.writeFile('data/debug-phones.html', html).catch(() => {});
      }

      const phonePatterns = (html.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
      if (phonePatterns.length > 0) {
        console.log(`   ℹ️ HTML 내 전화번호 패턴 ${phonePatterns.length}개: ${phonePatterns.slice(0, 3).join(', ')}`);
      }

      await page.close();

      const phones = parsePhonesFromHtml(html);
      if (phones.length > 0) {
        if (attempt > 1) console.log(`   ✅ 재시도 ${attempt}회 성공`);
        return phones;
      }

      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ Puppeteer 0건 - 재시도 ${attempt}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    } catch (err) {
      if (page) await page.close().catch(() => {});
      console.log(`   ⚠️ 에러 ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }

  // ── 전략 2: Puppeteer에서 발견한 AJAX 엔드포인트에 직접 요청 ──
  if (discoveredEndpoints.length > 0) {
    console.log(`   📡 발견된 AJAX 엔드포인트 ${discoveredEndpoints.length}개에 직접 요청...`);
    try {
      // 먼저 세션 쿠키 획득
      let cookies = '';
      const sessionResp = await axios.get(PHONE_URL, {
        headers: { 'User-Agent': REAL_UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: MAIN_URL },
        timeout: 30000,
        validateStatus: () => true,
      });
      const setCookies = sessionResp.headers['set-cookie'];
      if (setCookies) cookies = setCookies.map(c => c.split(';')[0]).join('; ');

      for (const ep of discoveredEndpoints) {
        try {
          const resp = ep.method === 'POST'
            ? await axios.post(ep.url, ep.postData || '', {
                headers: {
                  'User-Agent': REAL_UA, 'Cookie': cookies, 'Referer': PHONE_URL,
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Accept-Language': 'ko-KR,ko;q=0.9',
                  'X-Requested-With': 'XMLHttpRequest',
                },
                timeout: 30000, validateStatus: () => true,
              })
            : await axios.get(ep.url, {
                headers: { 'User-Agent': REAL_UA, 'Cookie': cookies, 'Referer': PHONE_URL, 'Accept-Language': 'ko-KR,ko;q=0.9' },
                timeout: 30000, validateStatus: () => true,
              });

          if (resp.status === 200 && resp.data) {
            const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
            const phones = parsePhonesFromHtml(raw);
            if (phones.length > 0) {
              console.log(`   ✅ ${ep.method} ${ep.url} → ${phones.length}개 수집`);
              return phones;
            }
            const matches = (raw.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
            console.log(`   ℹ️ ${ep.method} ${ep.url} → status=${resp.status}, phonePatterns=${matches.length}`);
            if (matches.length > 0) {
              console.log(`   ℹ️ 응답 샘플: ${raw.substring(0, 300)}`);
            }
          }
        } catch (e) {
          console.log(`   ℹ️ ${ep.method} ${ep.url} → ${e.message}`);
        }
      }
    } catch (err) {
      console.log(`   ⚠️ AJAX 직접 요청 실패: ${err.message}`);
    }
  }

  // ── 전략 3: eGovFrame 공통 엔드포인트 탐색 ──
  console.log('   📡 eGovFrame 엔드포인트 탐색...');
  const LIST_ENDPOINTS = [
    `${BASE}/selectPsLocalPhoneList.do`,
    `${BASE}/psLocalPhoneList.do`,
    `${BASE}/selectLocalPhoneList.do`,
    `${BASE}/localPhoneList.do`,
    `${BASE}/selectPsLocalPhone.do`,
    `${BASE}/psLocalPhoneListAction.do`,
  ];

  try {
    let cookies = '';
    const sessionResp = await axios.get(PHONE_URL, {
      headers: { 'User-Agent': REAL_UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: MAIN_URL },
      timeout: 30000, validateStatus: () => true,
    });
    const setCookies = sessionResp.headers['set-cookie'];
    if (setCookies) cookies = setCookies.map(c => c.split(';')[0]).join('; ');

    const commonHeaders = {
      'User-Agent': REAL_UA, 'Cookie': cookies, 'Referer': PHONE_URL,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Origin': 'https://ev.or.kr',
    };

    for (const target of [PHONE_URL, ...LIST_ENDPOINTS]) {
      // POST 시도
      try {
        const resp = await axios.post(target,
          new URLSearchParams({ pageIndex: '1', pageUnit: '1000', pageSize: '1000' }).toString(),
          {
            headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 15000, validateStatus: () => true,
          }
        );
        if (resp.status === 200 && resp.data) {
          const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
          const phones = parsePhonesFromHtml(raw);
          if (phones.length > 0) {
            console.log(`   ✅ POST ${target} → ${phones.length}개 수집`);
            return phones;
          }
          const matches = (raw.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
          console.log(`   ℹ️ POST ${target} → ${resp.status}, phones=${matches.length}, size=${raw.length}`);
        }
      } catch {}
    }
  } catch (err) {
    console.log(`   ⚠️ 엔드포인트 탐색 실패: ${err.message}`);
  }

  console.log('   ❌ 전화번호 수집 실패');
  return [];
}

function parsePhonesFromHtml(html) {
  const $ = cheerio.load(html);
  const phones = [];

  // table.table01 우선, 없으면 데이터가 가장 많은 테이블
  let $table = $('table.table01');
  if ($table.length === 0) {
    let maxRows = 0;
    let targetTableIndex = 0;
    $('table').each((i, t) => {
      const rows = $(t).find('tbody tr').length || $(t).find('tr').length;
      if (rows > maxRows) { maxRows = rows; targetTableIndex = i; }
    });
    $table = $('table').eq(targetTableIndex);
  }

  const theadRows = $table.find('thead tr').length;
  const tbodyRows = $table.find('tbody tr').length;
  const allRows = $table.find('tr').length;
  console.log(`   ℹ️ 테이블: thead ${theadRows}행, tbody ${tbodyRows}행, 전체 ${allRows}행`);

  // 헤더 추출: thead가 있으면 thead에서, 없으면 첫 번째 tr에서
  const headerCells = [];
  const $headerRow = $table.find('thead tr').first();
  if ($headerRow.length > 0) {
    $headerRow.find('th, td').each((j, cell) => {
      headerCells.push($(cell).text().trim().replace(/\s+/g, ' '));
    });
  } else {
    $table.find('tr').first().find('th, td').each((j, cell) => {
      headerCells.push($(cell).text().trim().replace(/\s+/g, ' '));
    });
  }
  console.log(`   ℹ️ 헤더: [${headerCells.join(', ')}]`);

  // 컬럼 인덱스 자동 감지
  let regionIdx = -1, subRegionIdx = -1, deptIdx = -1, phoneIdx = -1, noteIdx = -1;
  headerCells.forEach((h, idx) => {
    const lower = h.toLowerCase();
    if (regionIdx === -1 && (lower.includes('시도') || lower === '지역')) {
      regionIdx = idx;
    } else if (subRegionIdx === -1 && (lower.includes('지역구분') || lower.includes('지자체') || lower.includes('시군구'))) {
      subRegionIdx = idx;
    } else if (regionIdx === -1 && (lower.includes('지역') || lower.includes('local'))) {
      regionIdx = idx;
    } else if (deptIdx === -1 && (lower.includes('부서') || lower.includes('부처') || lower.includes('담당') || lower.includes('기관') || lower.includes('dept'))) {
      deptIdx = idx;
    } else if (phoneIdx === -1 && (lower.includes('전화') || lower.includes('연락처') || lower.includes('tel') || lower.includes('phone'))) {
      phoneIdx = idx;
    } else if (noteIdx === -1 && (lower.includes('기타') || lower.includes('비고') || lower.includes('참고') || lower.includes('note') || lower.includes('remark'))) {
      noteIdx = idx;
    }
  });

  console.log(`   ℹ️ 컬럼 매핑: region=${regionIdx}, subRegion=${subRegionIdx}, dept=${deptIdx}, phone=${phoneIdx}, note=${noteIdx}`);

  // 헤더 감지 실패 시 폴백
  if (regionIdx === -1 && headerCells.length >= 3) {
    const first = headerCells[0].toLowerCase();
    const hasNumberCol = first.includes('번호') || first.includes('no') || first.includes('순번') || first === '';
    const offset = hasNumberCol ? 1 : 0;
    regionIdx = offset;
    deptIdx = offset + 1;
    phoneIdx = offset + 2;
    noteIdx = offset + 3 < headerCells.length ? offset + 3 : -1;
    console.log(`   ℹ️ 폴백 매핑 (offset=${offset}): region=${regionIdx}, dept=${deptIdx}, phone=${phoneIdx}, note=${noteIdx}`);
  }

  // 데이터 행: tbody가 있으면 tbody tr, 없으면 td가 있는 모든 tr
  const $dataRows = $table.find('tbody tr').length > 0
    ? $table.find('tbody tr')
    : $table.find('tr').filter((i, row) => $(row).find('td').length > 0);

  $dataRows.each((i, row) => {
    const cells = [];
    $(row).find('td').each((j, cell) => {
      cells.push($(cell).text().trim().replace(/\s+/g, ' '));
    });

    if (cells.length < 2) return;

    const region = regionIdx >= 0 && regionIdx < cells.length ? cells[regionIdx] : cells[0];
    const subRegion = subRegionIdx >= 0 && subRegionIdx < cells.length ? cells[subRegionIdx] : '';
    const department = deptIdx >= 0 && deptIdx < cells.length ? cells[deptIdx] : (cells[1] || '');
    const phone = phoneIdx >= 0 && phoneIdx < cells.length ? cells[phoneIdx] : (cells[2] || '');
    const note = noteIdx >= 0 && noteIdx < cells.length ? cells[noteIdx] : '';

    // 빈 행이나 숫자만 있는 행 스킵
    if (!region || /^\d+$/.test(region)) return;

    const entry = { region, department, phone, note };
    if (subRegion) entry.subRegion = subRegion;
    phones.push(entry);
  });

  console.log(`   ✅ ${phones.length}개 지역 전화번호 수집`);
  return phones;
}

// ==========================================
// 5. 메인 실행
// ==========================================
async function main() {
  console.log('🚀 전기차 보조금 스크래핑 시작');
  console.log('⏰ ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
  console.log(`📅 대상 연도: ${CURRENT_YEAR}년`);
  console.log('');
  
  const startTime = Date.now();
  let browser = null;
  
  try {
    const regions = await getAllRegions();
    console.log('');
    
    // ⭐ 핵심: 브라우저를 단 한 번만 시작 (Launch Once)
    console.log('🌐 브라우저 시작...');
    browser = await puppeteer.launch({
      headless: 'new', // 최신 Headless 모드를 사용하면 더 빠르고 안정적입니다.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ 브라우저 준비 완료');
    console.log('');
    
    console.log('🟢 ===== 전체 스크래핑 시작 =====');
    // ⚡ 최적화: 병렬 처리 개수를 5에서 8로 상향 조정
    console.log('⚡ 병렬 처리: 8개씩 동시 스크래핑');
    const results = [];
    const CONCURRENT = 8; // 기존 5 -> 8로 증가
    const BATCH_DELAY = 500; // 배치 사이 대기 시간 500ms -> 300ms로 감소
    
    for (let i = 0; i < regions.length; i += CONCURRENT) {
      const batch = regions.slice(i, i + CONCURRENT);
      const batchStart = i + 1;
      const batchEnd = Math.min(i + CONCURRENT, regions.length);
      
      console.log(`\n📦 배치 [${batchStart}-${batchEnd}/${regions.length}]`);
      
      // 8개 동시 실행
      const batchResults = await Promise.all(
        batch.map(async (region, idx) => {
          const regionNum = i + idx + 1;
          console.log(`[${regionNum}/${regions.length}] ${region.parentName} ${region.localName}`);
          
          // ⭐ 브라우저 인스턴스를 전달
          const result = await scrapeRegionWithRetry(browser, region);
          
          if (result.success && Object.keys(result.vehicles).length > 0) {
            console.log(`    ✅ [${regionNum}] ${Object.keys(result.vehicles).length}개 차량`);
          } else if (!result.success) {
            console.log(`    ❌ [${regionNum}] 실패`);
          } else {
            console.log(`    ⚠️ [${regionNum}] 차량 없음`);
          }
          
          return result;
        })
      );
      
      results.push(...batchResults);
      
      // 배치 사이 대기 (서버 부하 방지)
      if (i + CONCURRENT < regions.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY)); // 500ms -> 300ms로 감소
      }
    }
    
    // 전화번호 스크래핑 (브라우저 닫기 전)
    console.log('');
    console.log('📞 ===== 지역 전화번호 스크래핑 =====');
    const phones = await scrapeLocalPhones(browser);

    // ⭐ 핵심: 모든 작업이 끝난 후 브라우저를 종료 (Close Once)
    await browser.close();
    console.log('');
    console.log('🟢 ===== 스크래핑 완료 =====');
    
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ 성공: ${success}개`);
    console.log(`❌ 실패: ${failed}개`);
    console.log('');
    
    // 저장 (연도별 폴더)
    const yearDir = `data/${CURRENT_YEAR}`;
    await fs.mkdir(yearDir, { recursive: true });
    console.log(`📁 저장 폴더: ${yearDir}`);

    const timestamp = new Date().toISOString();

    // ==========================================
    // 1. 차량 마스터 데이터 (vehicles.json)
    // ==========================================
    const vehicleMaster = extractVehicleMaster(results);
    const vehiclesData = {
      year: CURRENT_YEAR,
      timestamp: timestamp,
      total_vehicles: Object.keys(vehicleMaster).length,
      vehicles: vehicleMaster
    };

    await fs.writeFile(
      `${yearDir}/vehicles.json`,
      JSON.stringify(vehiclesData, null, 2)
    );

    const vehiclesSize = JSON.stringify(vehiclesData).length;
    console.log(`💾 ${yearDir}/vehicles.json 저장 완료 (${(vehiclesSize / 1024).toFixed(1)}KB, ${Object.keys(vehicleMaster).length}개 차종)`);

    // ==========================================
    // 2. 정규화된 보조금 데이터 (subsidies.json)
    // ==========================================
    const normalizedRegions = normalizeSubsidies(results);
    const normalizedData = {
      year: CURRENT_YEAR,
      timestamp: timestamp,
      total_regions: results.length,
      success_count: success,
      failed_count: failed,
      regions: normalizedRegions,
      phones: phones
    };

    await fs.writeFile(
      `${yearDir}/subsidies.json`,
      JSON.stringify(normalizedData, null, 2)
    );

    const subsidiesSize = JSON.stringify(normalizedData).length;
    console.log(`💾 ${yearDir}/subsidies.json 저장 완료 (${(subsidiesSize / 1024).toFixed(1)}KB, 정규화됨)`);

    // ==========================================
    // 3. 레거시 형식 (subsidies-legacy.json) - 하위 호환성
    // ==========================================
    const legacyData = {
      year: CURRENT_YEAR,
      timestamp: timestamp,
      total_regions: results.length,
      success_count: success,
      failed_count: failed,
      data: results
    };

    await fs.writeFile(
      `${yearDir}/subsidies-legacy.json`,
      JSON.stringify(legacyData, null, 2)
    );

    const legacySize = JSON.stringify(legacyData).length;
    console.log(`💾 ${yearDir}/subsidies-legacy.json 저장 완료 (${(legacySize / 1024).toFixed(1)}KB, 레거시)`);

    // ==========================================
    // 4. 연도 목록 업데이트 (years.json)
    // ==========================================
    await updateYearsList(CURRENT_YEAR);

    // ==========================================
    // 5. 지역별 부처 전화번호 (phones.json)
    // ==========================================
    if (phones.length > 0) {
      const phonesData = {
        timestamp: timestamp,
        source_url: 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do',
        total: phones.length,
        phones: phones
      };
      await fs.writeFile('data/phones.json', JSON.stringify(phonesData, null, 2));
      console.log(`💾 data/phones.json 저장 완료 (${phones.length}개)`);
    } else {
      console.log('ℹ️  전화번호 데이터 없음 (스크래핑 실패 또는 페이지 변경)');
    }

    // ==========================================
    // 크기 비교 출력
    // ==========================================
    const totalNewSize = vehiclesSize + subsidiesSize;
    const reduction = ((1 - totalNewSize / legacySize) * 100).toFixed(1);
    console.log('');
    console.log('📊 데이터 크기 비교:');
    console.log(`   레거시: ${(legacySize / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   정규화: ${(totalNewSize / 1024 / 1024).toFixed(2)}MB (vehicles + subsidies)`);
    console.log(`   감소율: ${reduction}%`);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️ 총 소요 시간: ${elapsed}초`);
    console.log('🎉 완료!');
    
  } catch (error) {
    console.error('');
    console.error('💥 치명적 오류:', error);
    
    if (browser) await browser.close();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('💥 예상치 못한 오류:', error);
  process.exit(1);
});
