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
async function scrapeLocalPhones(browser) {
  console.log('📞 지역별 부처 전화번호 스크래핑...');
  const MAIN_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
  const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';
  let page = null;

  try {
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);

    // ev.or.kr 세션 수립 (직접 접근 시 빈 페이지 반환 방지)
    await page.goto(MAIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // 세션 확보 후 전화번호 페이지로 이동
    await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // 테이블 데이터 로드 대기 (최대 15초)
    try {
      await page.waitForSelector('table tbody tr td', { timeout: 15000 });
    } catch {
      console.warn('   ⚠️ 테이블 셀 대기 타임아웃 - 현재 HTML로 파싱 시도');
    }

    const html = await page.content();

    // 디버그용 HTML 저장 (구조 파악용)
    try {
      await fs.mkdir('data', { recursive: true });
      await fs.writeFile('data/debug-phones.html', html);
      console.log('   💾 data/debug-phones.html 저장됨');
    } catch { /* 무시 */ }

    await page.close();

    const $ = cheerio.load(html);
    const phones = [];

    // 가장 많은 행을 가진 테이블에서 추출
    let maxRows = 0;
    let targetTableIndex = 0;
    $('table').each((i, t) => {
      const rows = $(t).find('tr').length;
      if (rows > maxRows) { maxRows = rows; targetTableIndex = i; }
    });

    console.log(`   ℹ️ 테이블 수: ${$('table').length}, 최대 행: ${maxRows} (index ${targetTableIndex})`);

    $('table').eq(targetTableIndex).find('tr').each((i, row) => {
      const cells = [];
      $(row).find('td').each((j, cell) => {
        cells.push($(cell).text().trim().replace(/\s+/g, ' '));
      });
      if (cells.length >= 2 && cells[0]) {
        phones.push({
          region: cells[0],
          department: cells[1] || '',
          phone: cells[2] || '',
          note: cells[3] || ''
        });
      }
    });

    console.log(`   ✅ ${phones.length}개 지역 전화번호 수집`);
    return phones;

  } catch (error) {
    if (page) await page.close();
    console.error(`   ❌ 전화번호 스크래핑 실패: ${error.message}`);
    return [];
  }
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
