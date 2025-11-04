const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

const TEST_MODE = false;
const MAX_RETRIES = 3;

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

  // 가장 많은 행을 가진 테이블 찾기
  let maxRows = 0;
  let targetTableIndex = 0;

  $('table').each((tableIdx, table) => {
    const rows = $(table).find('tbody tr').length;
    if (rows > maxRows) {
      maxRows = rows;
      targetTableIndex = tableIdx;
    }
  });

  $('table').eq(targetTableIndex).find('tbody tr').each((i, row) => {
    const cells = [];
    
    $(row).find('td').each((j, cell) => {
      // HTML 가져와서 br 기준으로 split
      const html = $(cell).html() || '';
      const parts = html.split(/<br\s*\/?>/i)
        .map(p => $('<div>').html(p).text().trim())
        .filter(p => p);
      
      cells.push(parts);
    });
    
    // 총 10개 셀
    if (cells.length >= 10) {
      try {
        const parseNum = (text) => {
          if (!text) return 0;
          const cleaned = text.replace(/[()]/g, '').trim();
          return parseInt(cleaned) || 0;
        };
        
        const quota = cells[5] || [];
        const registered = cells[6] || [];
        const delivered = cells[7] || [];
        const remaining = cells[8] || [];
        
        const rowData = {
          sido: (cells[0] && cells[0][0]) || '',
          region: (cells[1] && cells[1][0]) || '',
          vehicleType: (cells[2] && cells[2][0]) || '',
          
          quota_total: parseNum(quota[0]),
          quota_priority: parseNum(quota[1]),
          quota_corporate: parseNum(quota[2]),
          quota_taxi: parseNum(quota[3]),
          quota_general: parseNum(quota[4]),
          
          registered_total: parseNum(registered[0]),
          registered_priority: parseNum(registered[1]),
          registered_corporate: parseNum(registered[2]),
          registered_taxi: parseNum(registered[3]),
          registered_general: parseNum(registered[4]),
          
          delivered_total: parseNum(delivered[0]),
          delivered_priority: parseNum(delivered[1]),
          delivered_corporate: parseNum(delivered[2]),
          delivered_taxi: parseNum(delivered[3]),
          delivered_general: parseNum(delivered[4]),
          
          remaining_total: parseNum(remaining[0]),
          remaining_priority: parseNum(remaining[1]),
          remaining_corporate: parseNum(remaining[2]),
          remaining_taxi: parseNum(remaining[3]),
          remaining_general: parseNum(remaining[4]),
          
          note: (cells[9] && cells[9].join(' ')) || ''
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

      // 테이블 정보 확인
      const tableInfo = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        return Array.from(tables).map((table, idx) => {
          const rows = table.querySelectorAll('tbody tr').length;
          return { index: idx, rows: rows };
        });
      });

      // 가장 많은 행을 가진 테이블 찾기
      const maxTable = tableInfo.reduce((max, t) => t.rows > max.rows ? t : max, tableInfo[0]);

      const html = await page.content();

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
    console.log('⚡ 병렬 처리: 3개씩 동시 스크래핑');
    const results = [];
    const CONCURRENT = 5;
    
    // 첫 지역만 스크래핑 (모든 페이지 동일)
    console.log('⚠️ 모든 지역 페이지가 동일한 데이터 → 첫 지역만 스크래핑');
    const firstRegion = regions[0];
    console.log(`[1/1] ${firstRegion.parentName} ${firstRegion.localName}`);
    
    const result = await scrapeRegionWithRetry(browser, firstRegion);
    
    if (result.success && result.quotaData.length > 0) {
      console.log(`   ✅ ${result.quotaData.length}개 항목 (전체 지역)`);
    }
    
    const results = [result];
    
    // 기존 for 루프 삭제!
      const batch = regions.slice(i, i + CONCURRENT);
      const batchStart = i + 1;
      const batchEnd = Math.min(i + CONCURRENT, regions.length);
      
      console.log(`\n📦 배치 [${batchStart}-${batchEnd}/${regions.length}]`);
      
      // 3개 동시 실행
      const batchResults = await Promise.all(
        batch.map(async (region, idx) => {
          const regionNum = i + idx + 1;
          console.log(`[${regionNum}/${regions.length}] ${region.parentName} ${region.localName}`);
          
          const result = await scrapeRegionWithRetry(browser, region);
          
          if (result.success && result.quotaData.length > 0) {
            console.log(`   ✅ [${regionNum}] ${result.quotaData.length}개 항목`);
          } else if (!result.success) {
            console.log(`   ❌ [${regionNum}] 실패`);
          } else {
            console.log(`   ⚠️ [${regionNum}] 데이터 없음`);
          }
          
          return result;
        })
      );
      
      results.push(...batchResults);
      
      // 배치 사이 대기 (서버 부하 방지)
      if (i + CONCURRENT < regions.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
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
