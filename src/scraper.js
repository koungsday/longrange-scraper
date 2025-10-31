const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const TEST_MODE = true; // 테스트: 10개 지역만
const TEST_LIMIT = 10;

// 테스트용 키워드 (나중에 Google Sheets에서 읽어올 예정)
const KEYWORDS = [
  'ID.4',
  'ID.5', 
  'ID.7',
  'ID.버즈'
];

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
    
    // 테스트 모드: 처음 10개만
    if (TEST_MODE) {
      console.log(`🧪 테스트 모드: ${TEST_LIMIT}개만 처리`);
      return allRegions.slice(0, TEST_LIMIT);
    }
    
    return allRegions;
    
  } catch (error) {
    console.error('❌ 지역 목록 로딩 실패:', error.message);
    throw error;
  }
}

// ==========================================
// 2. HTML 파싱 (Apps Script와 동일한 로직)
// ==========================================
function parseEVTable(html, keywords) {
  const vehicles = {};
  
  if (!html || typeof html !== 'string') {
    return vehicles;
  }
  
  const $ = cheerio.load(html);
  
  // 테이블의 모든 행 찾기
  $('tr').each((i, row) => {
    const cells = [];
    
    $(row).find('td').each((j, cell) => {
      let text = $(cell).text().trim();
      text = text.replace(/\s+/g, ' ');
      cells.push(text);
    });
    
    // 폭스바겐 필터링
    if (cells.length >= 6 && cells[1] && cells[1].includes('폭스바겐')) {
      const model = cells[2];
      const isDanjong = model.includes('(단종)');
      
      keywords.forEach(keyword => {
        if (model.includes(keyword)) {
          try {
            const vehicleData = {
              type: cells[0],
              manufacturer: cells[1],
              model: model,
              national: parseInt(cells[3]) * 10000,
              local: parseInt(cells[4]) * 10000,
              total: parseInt(cells[5]) * 10000,
              isDanjong: isDanjong
            };
            
            // 중복 방지: 비단종 우선
            if (!vehicles[keyword]) {
              vehicles[keyword] = vehicleData;
            } else {
              if (vehicles[keyword].isDanjong && !isDanjong) {
                vehicles[keyword] = vehicleData;
              }
            }
            
          } catch (e) {
            console.warn(`   ⚠️ 파싱 오류: ${keyword}`, e.message);
          }
        }
      });
    }
  });
  
  return vehicles;
}

// ==========================================
// 3. 단일 지역 스크래핑
// ==========================================
async function scrapeRegion(browser, region, keywords) {
  const targetUrl = `https://ev.or.kr/nportal/buySupprt/psPopupLocalCarModelPrice.do?year=2025&local_cd=${region.code}&local_nm=${encodeURIComponent(region.localName)}&car_type=11&pnph=`;
  
  let page = null;
  
  try {
    console.log(`🔍 [${region.parentName}] ${region.localName}`);
    
    page = await browser.newPage();
    
    // 타임아웃 설정
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);
    
    // 페이지 이동
    await page.goto(targetUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // 테이블 로딩 대기
    await page.waitForSelector('table', { timeout: 10000 });
    
    // HTML 가져오기
    const html = await page.content();
    
    // 파싱
    const vehicles = parseEVTable(html, keywords);
    
    if (Object.keys(vehicles).length > 0) {
      console.log(`   ✅ ${Object.keys(vehicles).length}개 차량 발견`);
    } else {
      console.log(`   ⚠️ 매칭된 차량 없음`);
    }
    
    await page.close();
    
    return {
      parentName: region.parentName,
      localName: region.localName,
      code: region.code,
      vehicles: vehicles,
      success: true,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`   ❌ 오류: ${error.message}`);
    
    if (page) {
      await page.close();
    }
    
    return {
      parentName: region.parentName,
      localName: region.localName,
      code: region.code,
      vehicles: {},
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ==========================================
// 4. 메인 실행 함수
// ==========================================
async function main() {
  console.log('🚀 전기차 보조금 스크래핑 시작');
  console.log('⏰ ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
  console.log('');
  
  const startTime = Date.now();
  
  let browser = null;
  
  try {
    // 1. 지역 목록
    const regions = await getAllRegions();
    console.log('');
    
    // 2. Puppeteer 브라우저 시작
    console.log('🌐 브라우저 시작...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ 브라우저 준비 완료');
    console.log('');
    
    // 3. 순차 스크래핑 (안정성 우선)
    const results = [];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      console.log(`[${i + 1}/${regions.length}]`);
      
      const result = await scrapeRegion(browser, region, KEYWORDS);
      results.push(result);
      
      // 요청 간 대기 (서버 부하 방지)
      if (i < regions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await browser.close();
    console.log('');
    
    // 4. 통계
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log('📊 결과 요약');
    console.log(`✅ 성공: ${success}개`);
    console.log(`❌ 실패: ${failed}개`);
    console.log('');
    
    // 5. JSON 저장
    const outputData = {
      timestamp: new Date().toISOString(),
      test_mode: TEST_MODE,
      total_regions: results.length,
      success_count: success,
      failed_count: failed,
      keywords: KEYWORDS,
      data: results
    };
    
    // data 폴더 생성
    await fs.mkdir('data', { recursive: true });
    
    // 저장
    await fs.writeFile(
      'data/subsidies.json',
      JSON.stringify(outputData, null, 2)
    );
    
    console.log('💾 data/subsidies.json 저장 완료');
    
    // 6. 소요 시간
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️ 총 소요 시간: ${elapsed}초`);
    console.log('');
    console.log('🎉 완료!');
    
  } catch (error) {
    console.error('');
    console.error('💥 치명적 오류:', error);
    
    if (browser) {
      await browser.close();
    }
    
    process.exit(1);
  }
}

// 실행
main().catch(error => {
  console.error('💥 예상치 못한 오류:', error);
  process.exit(1);
});
