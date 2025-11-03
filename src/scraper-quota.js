const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

const TEST_MODE = false;
const MAX_RETRIES = 3;

// 괄호 파싱: 11351(3470)(404)(1194)(6283)
function parseWithParentheses(text) {
  if (!text || typeof text !== 'string') {
    return { total: 0, priority: 0, corporate: 0, taxi: 0, general: 0 };
  }
  
  const matches = text.match(/(\d+)\((\d+)\)\((\d+)\)\((\d+)\)\((\d+)\)/);
  
  if (matches) {
    return {
      total: parseInt(matches[1]) || 0,
      priority: parseInt(matches[2]) || 0,
      corporate: parseInt(matches[3]) || 0,
      taxi: parseInt(matches[4]) || 0,
      general: parseInt(matches[5]) || 0
    };
  }
  
  const num = parseInt(text.replace(/[^\d]/g, '')) || 0;
  return { total: num, priority: 0, corporate: 0, taxi: 0, general: 0 };
}

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

function parseQuotaTable(html) {
  const quotaData = [];
  
  if (!html || typeof html !== 'string') return quotaData;
  
  const $ = cheerio.load(html);
  
  $('table tbody tr').each((i, row) => {
  const cells = [];
  
  $(row).find('td').each((j, cell) => {
    let text = $(cell).text().trim().replace(/\s+/g, ' ');
    cells.push(text);
  });
    
    // 총 27개 셀
    if (cells.length >= 20) {
      try {
        // 괄호 제거 함수
        const parseNum = (text) => {
          if (!text) return 0;
          const cleaned = text.replace(/[()]/g, '').trim();
          return parseInt(cleaned) || 0;
        };
        
        const rowData = {
          sido: cells[0] || '',
          region: cells[1] || '',
          vehicleType: cells[2] || '',
          
          quota_total: parseNum(cells[6]),
          quota_priority: parseNum(cells[7]),
          quota_corporate: parseNum(cells[8]),
          quota_taxi: parseNum(cells[9]),
          quota_general: parseNum(cells[10]),
          
          registered_total: parseNum(cells[11]),
          registered_priority: parseNum(cells[12]),
          registered_corporate: parseNum(cells[13]),
          registered_taxi: parseNum(cells[14]),
          registered_general: parseNum(cells[15]),
          
          delivered_total: parseNum(cells[16]),
          delivered_priority: parseNum(cells[17]),
          delivered_corporate: parseNum(cells[18]),
          delivered_taxi: parseNum(cells[19]),
          delivered_general: parseNum(cells[20]),
          
          remaining_total: parseNum(cells[21]),
          remaining_priority: parseNum(cells[22]),
          remaining_corporate: parseNum(cells[23]),
          remaining_taxi: parseNum(cells[24]),
          remaining_general: parseNum(cells[25]),
          
          note: cells[26] || ''
        };
        
        quotaData.push(rowData);
      } catch (e) {
        console.warn(`   ⚠️ 행 파싱 오류: ${e.message}`);
      }
    }
  });
  
  return quotaData;
}
async function scrapeRegionWithRetry(browser, region) {
  const targetUrl = `https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do?local_cd=${region.code}`;
  
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

// 디버깅: 테이블 개수 확인
const tableCount = await page.evaluate(() => {
  return document.querySelectorAll('table').length;
});
console.log(`   📊 테이블 ${tableCount}개 발견`);

// 첫 테이블의 행 개수 확인
const rowCount = await page.evaluate(() => {
  const table = document.querySelector('table');
  return table ? table.querySelectorAll('tbody tr').length : 0;
});
console.log(`   📊 첫 테이블 행 ${rowCount}개`);

const html = await page.content();

// HTML 저장 (서울만)
if (region.code === 1100) {
  await fs.writeFile('debug-seoul.html', html);
  console.log('   💾 debug-seoul.html 저장됨');
}

await page.close();
      
      const quotaData = parseQuotaTable(html);
      
      if (attempt > 1) {
        console.log(`   ✅ 재시도 ${attempt}회 성공`);
      }
      
      return {
        parentName: region.parentName,
        localName: region.localName,
        code: region.code,
        quotaData: quotaData,
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
          quotaData: [],
          success: false,
          error: error.message,
          attempts: attempt,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
}

async function main() {
  console.log('🚀 전기차 보조금 접수현황 스크래핑 시작');
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
    
    console.log('🟢 ===== 접수현황 스크래핑 시작 =====');
    const results = [];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      console.log(`[${i + 1}/${regions.length}] ${region.parentName} ${region.localName}`);
      
      const result = await scrapeRegionWithRetry(browser, region);
      
      if (result.success && result.quotaData.length > 0) {
        console.log(`   ✅ ${result.quotaData.length}개 항목`);
      } else if (!result.success) {
        console.log(`   ❌ 실패`);
      } else {
        console.log(`   ⚠️ 데이터 없음`);
      }
      
      results.push(result);
      
      if (i < regions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    await browser.close();
    console.log('');
    console.log('🟢 ===== 스크래핑 완료 =====');
    
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ 성공: ${success}개`);
    console.log(`❌ 실패: ${failed}개`);
    console.log('');
    
    await fs.mkdir('data', { recursive: true });
    
    const outputData = {
      timestamp: new Date().toISOString(),
      total_regions: results.length,
      success_count: success,
      failed_count: failed,
      data: results
    };
    
    await fs.writeFile(
      'data/quota.json',
      JSON.stringify(outputData, null, 2)
    );
    
    console.log('💾 data/quota.json 저장 완료');
    
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
