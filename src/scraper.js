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
// 진단 결과: Puppeteer에서 tbody가 채워지지 않음
// → 모든 네트워크 요청/응답을 캡처하여 실제 데이터 API 엔드포인트를 찾고 직접 호출
// ==========================================
// 4. 지역별 부처 전화번호 스크래핑
// ==========================================
// 진단 결과: DOM 파싱 실패 (tbody 0행) -> HTML 원본 텍스트에서 정규식으로 직접 추출
// ==========================================
// 4. 지역별 부처 전화번호 스크래핑
// ==========================================
// 변경: DOM 렌더링(page.content)에 의존하지 않고, 네트워크 응답 본문을 직접 가로채서 파싱
// 이유: DOM이 업데이트되지 않아도 서버 응답(585KB)에는 데이터가 포함되어 있으므로 이를 직접 사용
async function scrapeLocalPhones(browser) {
  console.log('📞 지역별 부처 전화번호 스크래핑...');
  const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;
    let targetResponseText = ''; // 가로챈 응답 본문을 저장할 변수

    try {
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(30000);
      await page.setDefaultTimeout(30000);

      // 네트워크 응답 가로채기 설정
      page.on('response', async (response) => {
        const url = response.url();
        // psLocalPhone.do 요청에 대한 응답만 타겟팅 (500KB 이상 데이터 포함)
        if (url.includes('psLocalPhone.do') && response.status() === 200) {
          try {
            const text = await response.text();
            if (text && text.length > 1000) {
              console.log(`   📡 데이터 응답 감지: ${text.length} bytes`);
              targetResponseText = text;
            }
          } catch (e) {
            console.log(`   ⚠️ 응답 텍스트 읽기 실패: ${e.message}`);
          }
        }
      });

      // 1단계: 전화번호 페이지로 이동
      console.log('   Navigating to phone page...');
      await page.goto(PHONE_URL, { waitUntil: 'networkidle0', timeout: 30000 });

      // 2단계: 응답 가로채기 대기 (이미 goto에서 캡처되었을 수 있음)
      if (!targetResponseText) {
        console.log('   ⏳ 응답 데이터 대기 중...');
        await new Promise(r => setTimeout(r, 3000));
      }

      // 3단계: 사용할 HTML 소스 결정 (가로챈 응답 우선, 없으면 page.content)
      const htmlToParse = targetResponseText || await page.content();
      console.log(`   🔍 파싱 대상 데이터 크기: ${htmlToParse.length} bytes`);

      // --- 디버깅 섹션 ---
      // 데이터가 실제로 포함되어 있는지 확인
      const hasSeoul = htmlToParse.includes('서울');
      const hasPhone = /\d{2,3}-\d{3,4}-\d{4}/.test(htmlToParse);
      const hasTable = htmlToParse.includes('<table');
      const hasTbody = htmlToParse.includes('<tbody');

      console.log(`   🩺 데이터 진단: 서울=${hasSeoul}, 전화번호패턴=${hasPhone}, Table태그=${hasTable}, Tbody태그=${hasTbody}`);

      if (hasPhone) {
        const phoneMatches = htmlToParse.match(/\d{2,3}-\d{3,4}-\d{4}/g);
        console.log(`   🩺 발견된 전화번호 패턴 수: ${phoneMatches ? phoneMatches.length : 0}개`);
        if (phoneMatches && phoneMatches.length > 0) {
          console.log(`   🩺 예시: ${phoneMatches[0]}`);
          // 주변 텍스트 확인 (50자)
          const idx = htmlToParse.indexOf(phoneMatches[0]);
          const context = htmlToParse.substring(Math.max(0, idx - 100), Math.min(htmlToParse.length, idx + 100));
          console.log(`   🩺 문맥: ...${context.replace(/\n/g, ' ')}...`);
        }
      } else {
        console.log(`   ⚠️ 주의: 응답 데이터에 전화번호 형식이 발견되지 않음. (암호화되었거나 다른 포맷일 수 있음)`);
        // 응답의 앞부분 출력해보기 (혹시 리다이렉트나 에러 페이지인지)
        console.log(`   🩺 헤드: ${htmlToParse.substring(0, 300).replace(/\n/g, ' ')}`);
      }
      // ------------------

      // 4단계: 정규식으로 데이터 추출
      const phones = [];

      // 전략 A: HTML Table 파싱 (기존 로직)
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

      // 전략 B: JSON 파싱 (전략 A 실패 시)
      if (phones.length === 0) {
        console.log('   🔄 HTML 파싱 실패, JSON 패턴 검색 시도...');
        // JS 변수 할당 패턴 찾기: var data = [...]; or list = [...];
        // 느슨한 JSON 배열 매칭: [{ ... }]
        const jsonArrays = htmlToParse.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
        if (jsonArrays) {
          for (const jsonStr of jsonArrays) {
            if (jsonStr.length < 100) continue; // 너무 짧으면 무시
            try {
              // JS 객체 리터럴일 수 있으므로 JSON.parse가 안될 수 있음. 
              // 1차적으로 valid JSON인지 시도
              const data = JSON.parse(jsonStr);
              const extracted = extractPhonesFromJson(data);
              if (extracted.length > 0) {
                console.log(`   ✅ JSON 패턴에서 ${extracted.length}개 발견`);
                phones.push(...extracted);
                break;
              }
            } catch (e) {
              // JSON 파싱 실패 시 (JS Object Literal일 경우 등) 무시
            }
          }
        }
      }

      if (phones.length > 0) {
        console.log(`   ✅ 정규식/파싱으로 ${phones.length}개 지역 전화번호 수집 성공`);
        await page.close();
        return phones;
      }

      // 데이터가 없을 경우
      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ 0건 수집 - 재시도 ${attempt}/${MAX_RETRIES}`);
        await page.close();
        await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        continue;
      }

      await page.close();
      return [];

    } catch (error) {
      if (page) await page.close().catch(() => { });

      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ 재시도 ${attempt}/${MAX_RETRIES}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        continue;
      } else {
        console.error(`   ❌ 전화번호 스크래핑 최종 실패: ${error.message}`);
        return [];
      }
    }
  }

  return [];
}

/**
 * JSON 객체에서 전화번호 데이터 추출
 */
function extractPhonesFromJson(json) {
  // 배열이거나 흔한 래퍼 키에서 배열 추출
  const list = Array.isArray(json) ? json
    : (json.list || json.data || json.items || json.result || json.rows
      || json.body || json.content || json.resultList || json.dataList);

  if (!Array.isArray(list) || list.length === 0) return [];

  const first = list[0];
  if (typeof first !== 'object') return [];

  // 전화번호 필드 자동 감지
  const allKeys = Object.keys(first);
  const regionKey = allKeys.find(k => /local|region|sido|area|시도|지역/i.test(k));
  const deptKey = allKeys.find(k => /dept|organ|instt|부서|기관|담당/i.test(k));
  const phoneKey = allKeys.find(k => /tel|phone|cttpc|연락|전화/i.test(k));

  if (!phoneKey) return [];

  console.log(`   ℹ️ JSON 키: [${allKeys.join(', ')}] → region=${regionKey}, dept=${deptKey}, phone=${phoneKey}`);

  return list.map(item => ({
    region: item[regionKey] || '',
    department: item[deptKey] || '',
    phone: item[phoneKey] || '',
    note: item.rmk || item.note || item.etcCttpc || item.etc || ''
  })).filter(p => p.phone);
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
