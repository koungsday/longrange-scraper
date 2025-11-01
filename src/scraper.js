const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const TEST_MODE = false; // false = 전체 161개 지역
const MAX_RETRIES = 3;

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
// 2. HTML 파싱 - VW 전용
// ==========================================
function parseEVTableVW(html, keywords) {
  const vehicles = {};
  
  if (!html || typeof html !== 'string') return vehicles;
  
  const $ = cheerio.load(html);
  
  $('tr').each((i, row) => {
    const cells = [];
    
    $(row).find('td').each((j, cell) => {
      let text = $(cell).text().trim().replace(/\s+/g, ' ');
      cells.push(text);
    });
    
    // 폭스바겐만 필터링
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
            
            if (!vehicles[keyword]) {
              vehicles[keyword] = vehicleData;
            } else if (vehicles[keyword].isDanjong && !isDanjong) {
              vehicles[keyword] = vehicleData;
            }
            
          } catch (e) {
            console.warn(`   ⚠️ VW 파싱 오류: ${keyword}`);
          }
        }
      });
    }
  });
  
  return vehicles;
}

// ==========================================
// 3. HTML 파싱 - ALL (모든 제조사)
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
      const key = `${manufacturer}_${model}`; // 고유 키
      
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
// 4. 재시도 로직 포함 스크래핑
// ==========================================
async function scrapeRegionWithRetry(browser, region, keywords, mode) {
  const targetUrl = `https://ev.or.kr/nportal/buySupprt/psPopupLocalCarModelPrice.do?year=2025&local_cd=${region.code}&local_nm=${encodeURIComponent(region.localName)}&car_type=11&pnph=`;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;
    
    try {
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(30000);
      await page.setDefaultTimeout(30000);
      
      await page.goto(targetUrl, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      await page.waitForSelector('table', { timeout: 10000 });
      const html = await page.content();
      await page.close();
      
      // 모드에 따라 파싱
      const vehicles = mode === 'VW' 
        ? parseEVTableVW(html, keywords)
        : parseEVTableALL(html);
      
      if (attempt > 1) {
        console.log(`   ✅ 재시도 ${attempt}회 성공`);
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
        console.log(`   ⚠️ 재시도 ${attempt}/${MAX_RETRIES}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      } else {
        console.error(`   ❌ 최종 실패: ${error.message}`);
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
// 5. 메인 실행
// ==========================================
async function main() {
  console.log('🚀 전기차 보조금 스크래핑 시작');
  console.log('⏰ ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
  console.log('');
  
  const startTime = Date.now();
  let browser = null;
  
  try {
    const regions = await getAllRegions();
    console.log('');
    
    console.log('🌐 브라우저 시작...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ 브라우저 준비 완료');
    console.log('');
    
    // VW 키워드 로드 (환경변수 또는 기본값)
    const vwKeywords = process.env.VW_KEYWORDS 
      ? process.env.VW_KEYWORDS.split(',')
      : ['ID.4', 'ID.5', 'ID.7', 'ID.버즈'];
    
    console.log(`📋 VW 키워드: ${vwKeywords.join(', ')}`);
    console.log('');
    
    // ===== VW 모드 스크래핑 =====
    console.log('🔵 ===== VW 모드 시작 =====');
    const resultsVW = [];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      console.log(`[VW ${i + 1}/${regions.length}] ${region.parentName} ${region.localName}`);
      
      const result = await scrapeRegionWithRetry(browser, region, vwKeywords, 'VW');
      
      if (result.success && Object.keys(result.vehicles).length > 0) {
        console.log(`   ✅ ${Object.keys(result.vehicles).length}개 차량`);
      } else if (!result.success) {
        console.log(`   ❌ 실패 (재시도 ${result.attempts}회)`);
      }
      
      resultsVW.push(result);
      
      if (i < regions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    console.log('');
    console.log('🔵 ===== VW 모드 완료 =====');
    const vwSuccess = resultsVW.filter(r => r.success).length;
    const vwFailed = resultsVW.filter(r => !r.success).length;
    console.log(`✅ 성공: ${vwSuccess}개 | ❌ 실패: ${vwFailed}개`);
    console.log('');
    
    // ===== ALL 모드 스크래핑 =====
    console.log('🟢 ===== ALL 모드 시작 =====');
    const resultsALL = [];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      console.log(`[ALL ${i + 1}/${regions.length}] ${region.parentName} ${region.localName}`);
      
      const result = await scrapeRegionWithRetry(browser, region, [], 'ALL');
      
      if (result.success && Object.keys(result.vehicles).length > 0) {
        console.log(`   ✅ ${Object.keys(result.vehicles).length}개 차량`);
      } else if (!result.success) {
        console.log(`   ❌ 실패`);
      }
      
      resultsALL.push(result);
      
      if (i < regions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    await browser.close();
    console.log('');
    console.log('🟢 ===== ALL 모드 완료 =====');
    const allSuccess = resultsALL.filter(r => r.success).length;
    const allFailed = resultsALL.filter(r => !r.success).length;
    console.log(`✅ 성공: ${allSuccess}개 | ❌ 실패: ${allFailed}개`);
    console.log('');
    
    // 저장
    await fs.mkdir('data', { recursive: true });
    
    const outputData = {
      timestamp: new Date().toISOString(),
      vw: {
        keywords: vwKeywords,
        total: resultsVW.length,
        success: vwSuccess,
        failed: vwFailed,
        data: resultsVW
      },
      all: {
        total: resultsALL.length,
        success: allSuccess,
        failed: allFailed,
        data: resultsALL
      }
    };
    
    await fs.writeFile(
      'data/subsidies.json',
      JSON.stringify(outputData, null, 2)
    );
    
    console.log('💾 data/subsidies.json 저장 완료');
    
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
