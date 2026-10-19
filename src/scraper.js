const puppeteer = require('puppeteer');
const { downloadExcel, PAGE_URL } = require('./ev-excel-download');
const { parseSubsidyXlsx } = require('./parse-subsidy-xlsx');
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
    const response = await fetch('https://api.donut.im/api/v1/regions/list');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const allRegions = [];

    data.regions.forEach(region => {
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


// ==========================================
// 4. 메인 실행
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
    
    // ★2026-08-16 개편 — 지역별 팝업(psPopupLocalCarModelPrice.do)이 HTTP 500 으로
    //   삭제됐다. 개편이 아니라 페이지 자체가 없어져 고쳐 쓸 대상이 없다.
    //   같은 데이터가 현황 페이지의 「Excel 다운로드」 안에 전부 들어 있으므로
    //   161개 팝업을 도는 대신 **파일 한 장**을 받는다(요청 161 → 1).
    console.log('🟢 ===== Excel 한 장으로 전 지역 수집 =====');
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);
    await page.goto(PAGE_URL(1100), { waitUntil: 'networkidle2', timeout: 30000 });
    const xlsx = await downloadExcel(page);
    await page.close();
    console.log(`   📥 Excel ${(xlsx.length / 1024 / 1024).toFixed(1)}MB 수신`);

    const parsed = parseSubsidyXlsx(xlsx, { year: CURRENT_YEAR });
    console.log(`   📊 금액 단위 ${parsed.meta.unitName}(×${parsed.meta.unit}) 자동 감지 · 지역 ${parsed.legacy.data.length}개`);
    if (parsed.meta.nationalConflicts.length) {
      console.warn(`   ⚠️ 국비가 지역마다 다릅니다: ${parsed.meta.nationalConflicts.join(', ')}`);
    }

    // 지역 목록 기준으로 채운다 — Excel 에 없는 지역은 실패로 남겨 개수를 정직하게 센다.
    const byCode = new Map(parsed.legacy.data.map((d) => [String(d.code), d]));
    const results = regions.map((r) => byCode.get(String(r.code)) || {
      parentName: r.parentName, localName: r.localName, code: r.code,
      vehicles: {}, success: false, error: 'Excel 에 이 지역이 없습니다',
      attempts: 1, timestamp: new Date().toISOString(),
    });
    const missing = results.filter((r) => !r.success);
    if (missing.length) console.warn(`   ⚠️ Excel 에 없는 지역 ${missing.length}개: ${missing.slice(0, 5).map((m) => m.localName).join(', ')}`);

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
      regions: normalizedRegions
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
