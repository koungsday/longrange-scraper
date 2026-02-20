const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 설정
// ==========================================
const MAX_RETRIES = 3;
const YEAR = new Date().getFullYear();
const DATA_DIR = path.join(__dirname, '../data', String(YEAR));

// ==========================================
// 메인 실행 함수
// ==========================================
(async () => {
  console.log(`🚀 스크래퍼 시작 (연도: ${YEAR})`);

  // 데이터 디렉토리 생성
  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // 1. 차량 정보 수집
    const vehicles = await scrapeVehicles(browser);
    await saveJson('vehicles.json', vehicles);

    // 2. 국고 보조금 수집
    // const nationalSubsidies = await scrapeNationalSubsidies(browser); // (차량 정보에 포함됨)

    // 3. 지자체 보조금 수집
    const localSubsidies = await scrapeLocalSubsidies(browser);
    await saveJson('subsidies-legacy.json', localSubsidies);

    // 4. 지역별 부처 전화번호 수집
    const phones = await scrapeLocalPhones(browser);

    // 5. 데이터 정규화 및 병합
    const normalizedData = normalizeData(vehicles, localSubsidies, phones);
    await saveJson('subsidies.json', normalizedData);

    // 6. years.json 업데이트
    await updateYearsJson(YEAR);

    console.log('🎉 모든 작업 완료!');

    // 결과 요약 출력
    printSummary(vehicles, normalizedData, localSubsidies);

  } catch (error) {
    console.error('❌ 치명적 오류 발생:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

// ==========================================
// 1. 차량 정보 스크래핑
// ==========================================
async function scrapeVehicles(browser) {
  console.log('🚗 차량 정보 스크래핑...');
  const page = await browser.newPage();
  const URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';

  await page.goto(URL, { waitUntil: 'networkidle2' });

  // 제조사 목록 가져오기
  const brands = await page.evaluate(() => {
    const options = document.querySelectorAll('#car_mnf_cd option');
    return Array.from(options)
      .filter(opt => opt.value)
      .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
  });

  const vehicles = [];

  // 각 제조사별 차량 조회
  for (const brand of brands) {
    console.log(`   🔍 제조사 검색: ${brand.name}`);

    // 제조사 선택
    await page.select('#car_mnf_cd', brand.id);

    // 검색 버튼 클릭 및 대기
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { }), // 네비게이션이 없을 수도 있음
      page.click('#btn_search')
    ]);

    // 테이블 데이터 추출
    const carData = await page.evaluate((brandName) => {
      const rows = document.querySelectorAll('.table_02 tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return null;

        return {
          brand: brandName,
          model: cells[1]?.textContent.trim(),
          trim: cells[2]?.textContent.trim(),
          price: parseInt(cells[3]?.textContent.replace(/,/g, '') || '0', 10) * 10000, // 만원 -> 원
          subsidy: parseInt(cells[4]?.textContent.replace(/,/g, '') || '0', 10) * 10000
        };
      }).filter(item => item !== null);
    }, brand.name);

    vehicles.push(...carData);

    // 봇 탐지 방지용 딜레이
    await new Promise(r => setTimeout(r, 1000));
  }

  await page.close();
  console.log(`   ✅ 총 ${vehicles.length}개 차량 정보 수집 완료`);
  return vehicles;
}

// ==========================================
// 3. 지자체 보조금 스크래핑 (레거시 구조 유지)
// ==========================================
async function scrapeLocalSubsidies(browser) {
  console.log('🏙️ 지자체 보조금 스크래핑...');
  const page = await browser.newPage();

  // 지자체 공고 페이지 (가장 데이터가 많은 곳으로 추정)
  // 실제로는 API나 다른 페이지를 크롤링해야 할 수도 있음.
  // 여기서는 예시로 메인 페이지 구조를 활용한다고 가정.
  // ※ 실제 ev.or.kr 구조는 복잡하므로, 여기서는 '지자체 차종별 보조금' 페이지를 타겟으로 함.
  const URL = 'https://ev.or.kr/nportal/buySupprt/initLocalCarSubsidyAction.do';

  // 참고: 실제로는 지역별로 dropdown을 선택하고 조회해야 함.
  // 전체 데이터를 순회하는 로직 필요.

  await page.goto(URL, { waitUntil: 'networkidle2' });

  // 시/도 목록 가져오기
  const sidos = await page.evaluate(() => {
    const options = document.querySelectorAll('#sido_cd option');
    return Array.from(options)
      .filter(opt => opt.value)
      .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
  });

  const allSubsidies = [];

  for (const sido of sidos) {
    console.log(`   Searching Region: ${sido.name}`);

    // 시/도 선택
    await page.select('#sido_cd', sido.id);

    // 잠시 대기 (AJAX 로딩)
    await new Promise(r => setTimeout(r, 500));

    // 군/구 목록이 있다면 순회, 없다면 시/도 단위 조회
    const gungus = await page.evaluate(() => {
      const options = document.querySelectorAll('#sigun_cd option');
      return Array.from(options)
        .filter(opt => opt.value)
        .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
    });

    const targets = gungus.length > 0 ? gungus : [{ id: '', name: '전체' }];

    for (const target of targets) {
      if (target.id) {
        await page.select('#sigun_cd', target.id);
      }

      // 조회 버튼 클릭
      await page.click('#btn_search');

      try {
        // 테이블 로딩 대기
        await page.waitForSelector('.table_02 tbody tr', { timeout: 3000 });

        const data = await page.evaluate((sidoName, gunguName) => {
          const rows = document.querySelectorAll('.table_02 tbody tr');
          return Array.from(rows).map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return null;

            // 차종 | 국비 | 지방비 | 보조금 합계 | 비고
            return {
              sido: sidoName,
              gungu: gunguName === '전체' ? '' : gunguName,
              model: cells[0]?.textContent.trim(),
              national: parseInt(cells[1]?.textContent.replace(/,/g, '') || '0', 10) * 10000,
              local: parseInt(cells[2]?.textContent.replace(/,/g, '') || '0', 10) * 10000,
              total: parseInt(cells[3]?.textContent.replace(/,/g, '') || '0', 10) * 10000
            };
          }).filter(x => x);
        }, sido.name, target.name);

        if (data.length > 0) {
          // console.log(`      Found ${data.length} entries for ${target.name}`);
          allSubsidies.push(...data);
        } else {
          // console.log(`      No data for ${target.name}`);
          // 데이터가 없으면 '접수대기'나 '마감'일 수 있음 -> 빈 데이터라도 지역 정보는 남길지 고려
        }

      } catch (e) {
        // 타임아웃 등
        // console.log(`      Error/No Data for ${target.name}`);
      }

      // 딜레이
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await page.close();
  console.log(`   ✅ 지자체 보조금 데이터 ${allSubsidies.length}건 수집 완료`);
  return allSubsidies;
}

// ==========================================
// 4. 지역별 부처 전화번호 스크래핑
// ==========================================
// 진단 결과: HeadlessChrome UA 감지 → 서버가 빈 테이블 반환
// 전략: Real UA + navigator.webdriver 우회 + 버튼 클릭 + JS 함수 호출 + axios 폴백
async function scrapeLocalPhones(browser) {
  console.log('📞 지역별 부처 전화번호 스크래핑...');
  const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';
  const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  // ── Puppeteer 시도 (Real UA + anti-detection) ──
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

      // 세션 수립 → 전화번호 페이지
      await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      // (A) 자동 로드된 데이터 대기
      let found = false;
      try {
        await page.waitForSelector('table.table01 tbody tr', { timeout: 10000 });
        found = true;
      } catch {}

      // (B) 조회 버튼 클릭
      if (!found) {
        const clickResult = await page.evaluate(() => {
          const els = document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, .btn, [onclick]');
          for (const el of els) {
            const text = (el.textContent || el.value || '').trim();
            const onclick = el.getAttribute('onclick') || '';
            if (text.includes('조회') || text.includes('검색') || onclick.includes('search') || onclick.includes('Phone') || onclick.includes('list')) {
              el.click();
              return text || onclick.substring(0, 50);
            }
          }
          return null;
        });
        if (clickResult) {
          console.log(`   🖱️ "${clickResult}" 클릭`);
          try { await page.waitForSelector('table.table01 tbody tr', { timeout: 15000 }); found = true; } catch {}
        }
      }

      // (C) 스크롤로 lazy loading 트리거
      if (!found) {
        await page.evaluate(() => {
          const table = document.querySelector('table.table01');
          if (table) table.scrollIntoView();
        });
        await new Promise(r => setTimeout(r, 3000));
      }

      // (D) 흔한 JS 함수 직접 호출
      if (!found) {
        const called = await page.evaluate(() => {
          const fns = ['fnSearch', 'fn_search', 'doSearch', 'fnList', 'getList', 'selectList',
            'fnSelectList', 'searchList', 'fn_selectList', 'goList', 'fn_goList'];
          for (const fn of fns) {
            if (typeof window[fn] === 'function') {
              try { window[fn](); return fn; } catch { return `${fn}(err)`; }
            }
          }
          return null;
        });
        if (called) {
          console.log(`   📞 JS 함수 호출: ${called}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // 페이지 상태 분석 + 파싱
      const analysis = await page.evaluate(() => ({
        tbodyRows: document.querySelectorAll('table.table01 tbody tr').length,
        scripts: document.querySelectorAll('script').length,
        buttons: [...document.querySelectorAll('button, [onclick]')]
          .map(b => (b.textContent || '').trim().substring(0, 30)).filter(Boolean).slice(0, 5),
        forms: [...document.querySelectorAll('form')].map(f => f.action).slice(0, 3),
        iframes: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 3),
      }));
      console.log(`   ℹ️ tbody=${analysis.tbodyRows}행, script=${analysis.scripts}, btn=[${analysis.buttons.join('|')}], form=${analysis.forms.length}, iframe=${analysis.iframes.length}`);

      const html = await page.content();

      // Raw HTML 전화번호 패턴 탐색
      const phonePatterns = (html.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
      if (phonePatterns.length > 0) {
        console.log(`   ℹ️ HTML 내 전화번호 패턴 ${phonePatterns.length}개: ${phonePatterns.slice(0, 3).join(', ')}`);
      }

      // 4단계: 테이블 데이터 대기
      try {
        await page.waitForSelector('table tbody td', { timeout: 10000 });
        console.log('   ✅ 테이블 데이터 렌더링 감지됨');
      } catch (e) {
        console.log('   ⚠️ 테이블 데이터 셀렉터 타임아웃');
      }

      // 5단계: HTML 덤프 및 디버깅
      const htmlToParse = await page.content();
      console.log(`   🔍 DOM 데이터 크기: ${htmlToParse.length} bytes`);

      // 파일로 저장해서 나중에 확인 가능하게 함
      try {
        const fs = require('fs').promises;
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile('data/debug-phones-last.html', htmlToParse);
      } catch (e) { }

      // 6단계: 정규식으로 데이터 추출
      const phones = [];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;

      while ((rowMatch = rowRegex.exec(htmlToParse)) !== null) {
        const rowContent = rowMatch[1];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
          const text = cellMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
          cells.push(text);
        }

        if (cells.length >= 4) {
          const region = cells[0];
          const subRegion = cells[1];
          const department = cells[2];
          const phone = cells[3];
          const note = cells.length > 4 ? cells[4] : '';

          if (phone && /[\d-]{7,}/.test(phone) && region && region !== '시도') {
            phones.push({ region, subRegion, department, phone, note });
          }
        }
      }

      if (phones.length > 0) {
        console.log(`   ✅ 수집 성공: ${phones.length}개 지역 전화번호`);
        await page.close();
        return phones;
      }

      // 데이터가 없을 경우
      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ Puppeteer 0건 - 재시도 ${attempt}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    } catch (err) {
      if (page) await page.close().catch(() => {});
      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ 에러 ${attempt}/${MAX_RETRIES}: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }

  // ── 폴백: axios 직접 HTTP 요청 ──
  console.log('   📡 직접 HTTP 요청 시도...');
  try {
    const resp = await axios.get(PHONE_URL, {
      headers: {
        'User-Agent': REAL_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': MAIN_URL,
      },
      timeout: 30000,
    });

    const phones = parsePhonesFromHtml(resp.data);
    if (phones.length > 0) {
      console.log(`   ✅ HTTP 직접 요청으로 ${phones.length}개 수집`);
      return phones;
    }

    const matches = (resp.data.match(/\d{2,3}-\d{3,4}-\d{4}/g) || []);
    console.log(`   ℹ️ Raw HTTP 전화번호 패턴: ${matches.length}개${matches.length > 0 ? ' → ' + matches.slice(0, 3).join(', ') : ''}`);
  } catch (err) {
    console.log(`   ⚠️ HTTP 실패: ${err.message}`);
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

  // 결과 데이터 구조
  // { "서울": { "전체": { subsidies: {...}, phone: {...} }, "지역구": ... } }
  const result = {};

  localSubsidies.forEach(item => {
    const sido = item.sido;
    const gungu = item.gungu || '전체';

    if (!result[sido]) result[sido] = {};
    if (!result[sido][gungu]) {
      result[sido][gungu] = {
        subsidies: {},
        phone: null
      };
    }

    // 보조금 정보 매핑 (차종별)
    // item.model (e.g. "아이오닉6 롱레인지 2WD 20인치") -> vehicles에서 매칭되는지 확인
    const matchedVehicle = vehicles.find(v => v.model === item.model);
    if (matchedVehicle) {
      // 차종 ID나 이름으로 매핑
      // 여기서는 단순하게 모델명 그대로 키로 사용 (나중에 프론트에서 매칭)
      result[sido][gungu].subsidies[item.model] = {
        national: item.national,
        local: item.local,
        total: item.total
      };
    }

    // 전화번호 매핑
    const phoneKey = `${sido} ${gungu}`.trim();
    const phoneKeySidoOnly = sido; // 군구가 없는 경우 시도 대표 번호

    if (phoneMap.has(phoneKey)) {
      result[sido][gungu].phone = phoneMap.get(phoneKey);
    } else if (phoneMap.has(phoneKeySidoOnly)) {
      // 구체적인 지역 번호가 없으면 시도 대표 번호 사용 (선택사항)
      result[sido][gungu].phone = phoneMap.get(phoneKeySidoOnly);
    }
  });

  return result;
}

// ==========================================
// 6. years.json 업데이트
// ==========================================
async function updateYearsJson(newYear) {
  const yearsFile = path.join(__dirname, '../data', 'years.json');
  let years = [];
  try {
    const data = await fs.readFile(yearsFile, 'utf8');
    years = JSON.parse(data);
  } catch (e) {
    years = [];
  }

  if (!years.includes(newYear)) {
    years.push(newYear);
    years.sort((a, b) => b - a); // 내림차순 정렬
    await fs.writeFile(yearsFile, JSON.stringify(years, null, 2));
    console.log(`📅 years.json 업데이트 완료: [${years.join(', ')}]`);
  }
}

// ==========================================
// 유틸리티
// ==========================================
async function saveJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  console.log(`💾 ${filename} 저장 완료 (${(await fs.stat(filePath)).size / 1024}KB)`);
}

function printSummary(vehicles, normalizedData, localSubsidies) {
  console.log('\n📊 데이터 크기 비교:');
  console.log(`   레거시: ${(JSON.stringify(localSubsidies).length / 1024 / 1024).toFixed(2)}MB`);
  console.log(`   정규화: ${(JSON.stringify(normalizedData).length / 1024 / 1024).toFixed(2)}MB (vehicles + subsidies)`);
  // console.log(`   감소율: ...%`);
}
