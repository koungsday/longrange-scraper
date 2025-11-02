const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '1gph0IVQqaykAvYyo4QX875xaT6NjSVuZaRHsldCt0DM';
const SHEET_NAME_VW = 'Subsidy Data_VW';
const SHEET_NAME_ALL = 'Subsidy Data_ALL';
const SHEET_NAME_FAIL = 'Fail Data';

// ==========================================
// 1. 이전 데이터 읽기 (실패 시 재활용)
// ==========================================
async function getPreviousData(sheet) {
  try {
    const rows = await sheet.getRows();
    const prevData = {};
    
    rows.forEach(row => {
      const key = `${row['시/도']||''}_${row['시/군/구']||''}`;
      prevData[key] = row;
    });
    
    return prevData;
  } catch (error) {
    console.log('   ⚠️ 이전 데이터 없음 (첫 실행)');
    return {};
  }
}
/**
 * 0부터 시작하는 열 인덱스를 Google Sheets의 문자열 열 주소(A, B, Z, AA, AB 등)로 변환합니다.
 * @param {number} colIndex 0부터 시작하는 열 인덱스 (0 = A, 1 = B)
 * @returns {string} 열 문자열 (예: 26 -> AA)
 */
function getColumnLetter(colIndex) {
    let letter = '';
    let temp = colIndex + 1; // 1부터 시작하는 인덱스로 변환 (1 = A)

    while (temp > 0) {
        const remainder = (temp - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        temp = Math.floor((temp - remainder) / 26);
    }
    return letter;
}
// ==========================================
// 2. ALL 시트 업데이트 (전체 차량)
// ==========================================
async function updateALLSheet(doc, allData) {
  console.log('');
  console.log('🟢 ===== ALL 시트 업데이트 =====');
  
  let sheet = doc.sheetsByTitle[SHEET_NAME_ALL];
  
  if (!sheet) {
    console.log('📄 ALL 시트 생성 중...');
    sheet = await doc.addSheet({ title: SHEET_NAME_ALL });
  }
  
  console.log('✅ ALL 시트 확인');
  
  // 이전 데이터 로드
  console.log('📁 이전 데이터 로딩...');
  const prevData = await getPreviousData(sheet);
  console.log(`✅ ${Object.keys(prevData).length}개 이전 행`);
  
  // 모든 차종 자동 발견
  console.log('🔍 차종 자동 발견 중...');
  const allVehicles = new Set();
  
  allData.data.forEach(region => {
    if (region.success) {
      Object.keys(region.vehicles).forEach(key => {
        allVehicles.add(key);
      });
    }
  });
  
  const vehicleKeys = Array.from(allVehicles).sort();
  console.log(`✅ ${vehicleKeys.length}개 차종 발견`);
  
  // 국고보조금 & 차종명 수집
  const nationalSubsidies = {};
  const vehicleNames = {};
  
  allData.data.forEach(region => {
    if (region.success) {
      Object.keys(region.vehicles).forEach(key => {
        const vehicle = region.vehicles[key];
        if (!nationalSubsidies[key]) {
          nationalSubsidies[key] = vehicle.national;
          vehicleNames[key] = `${vehicle.manufacturer} ${vehicle.model}`;
        }
      });
    }
  });
  
  // 데이터 준비
  console.log('🔄 데이터 변환 중...');
  const rows = [];
  const failedRegions = [];
  
  allData.data.forEach(region => {
    let prefix, suffix;
    
    const parentName = region.parentName || '';
    const localName = region.localName || '';
    
    // 지역명 분리
    if (localName.includes('특별시')) {
      prefix = localName.replace('특별시', '');
      suffix = '특별시';
    } else if (localName.includes('광역시')) {
      prefix = localName.replace('광역시', '');
      suffix = '광역시';
    } else if (localName.includes('특별자치시')) {
      prefix = localName.replace('특별자치시', '');
      suffix = '특별자치시';
    } else if (localName.includes('특별자치도')) {
      prefix = localName.replace('특별자치도', '');
      suffix = '특별자치도';
    } else {
      prefix = parentName;
      suffix = localName;
    }
    
    const rowData = {
      '시/도': prefix,
      '시/군/구': suffix
    };
    
    const key = `${prefix}_${suffix}`;
    
    // 실패 처리
    if (!region.success) {
      console.log(`   ⚠️ 실패 지역: ${prefix} ${suffix} - 이전 값 사용`);
      
      failedRegions.push({
        region: `${prefix} ${suffix}`,
        sheet: 'ALL',
        error: region.error || 'Unknown',
        attempts: region.attempts || 0,
        timestamp: region.timestamp
      });
      
      if (prevData[key]) {
        vehicleKeys.forEach(vKey => {
          rowData[vKey] = prevData[key][vKey] || 0;
        });
      } else {
        vehicleKeys.forEach(vKey => {
          rowData[vKey] = 0;
        });
      }
    } else {
      vehicleKeys.forEach(vKey => {
        if (region.vehicles[vKey]) {
          rowData[vKey] = region.vehicles[vKey].local / 10000;
        } else {
          rowData[vKey] = 0;
        }
      });
    }
    
    rows.push(rowData);
  });
  
  console.log(`✅ ${rows.length}개 행 준비 (실패 ${failedRegions.length}개는 이전 값 사용)`);
  
  // 시트 초기화
  await sheet.clear();
  
  // 1행: 국고보조금
  console.log('💰 1행: 국고보조금 작성 중...');
  const row1 = ['시/도', '시/군/구'];
  vehicleKeys.forEach(key => {
    row1.push(nationalSubsidies[key] ? nationalSubsidies[key] / 10000 : 0);
  });
  
  // 2행: 차종명
  console.log('🚗 2행: 차종명 작성 중...');
  const row2 = ['시/도', '시/군/구'];
  vehicleKeys.forEach(key => {
    row2.push(vehicleNames[key] || key);
  });
  
  // 헤더 설정 (3행)
  await sheet.setHeaderRow(row2, 1); // index 1 = 2행

  // 1행과 2행 수동 입력
  const lastColIndex = Math.min(row1.length - 1, 701);
  const lastColLetter = getColumnLetter(lastColIndex);
  
  await sheet.loadCells(`A1:${lastColLetter}2`);
  
  // 'for' 루프를 한 번만 사용해야 합니다.
  for (let col = 0; col < row1.length && col < 702; col++) { 
    sheet.getCell(0, col).value = row1[col];
    sheet.getCell(1, col).value = row2[col];
  }
  await sheet.saveUpdatedCells();
  
  // 데이터 입력
  console.log('💾 데이터 저장 중...');
  await sheet.addRows(rows);
  console.log('✅ ALL 시트 업데이트 완료!');
  
  return { failedRegions, allVehicles: vehicleKeys };
}

// ==========================================
// 3. VW 시트 업데이트 (폭스바겐만 필터링)
// ==========================================
async function updateVWSheet(doc, allData, allVehicles) {
  console.log('');
  console.log('🔵 ===== VW 시트 업데이트 =====');
  
  let sheet = doc.sheetsByTitle[SHEET_NAME_VW];
  
  if (!sheet) {
    console.log('📄 VW 시트 생성 중...');
    sheet = await doc.addSheet({ title: SHEET_NAME_VW });
  }
  
  console.log('✅ VW 시트 확인');
  
  // 3행에서 키워드 읽기
  console.log('📖 3행에서 키워드 읽는 중...');
  await sheet.loadCells('C3:Z3');
  const keywords = [];
  
  for (let col = 2; col < 26; col++) { // C~Z (index 2~25)
    const cell = sheet.getCell(2, col);
    if (cell.value && cell.value.toString().trim()) {
      keywords.push({
        col: col,
        keyword: cell.value.toString().trim()
      });
    } else {
      break;
    }
  }
  
  if (keywords.length === 0) {
    console.log('❌ 3행에 키워드가 없습니다!');
    console.log('⚠️ VW 시트 업데이트 건너뜀');
    return { failedRegions: [] };
  }
  
  console.log(`✅ ${keywords.length}개 키워드: ${keywords.map(k => k.keyword).join(', ')}`);
  
  // 이전 데이터 로드
  console.log('📁 이전 데이터 로딩...');
  const prevData = await getPreviousData(sheet);
  console.log(`✅ ${Object.keys(prevData).length}개 이전 행`);
  
  // ALL 데이터에서 폭스바겐 + 키워드 매칭
  console.log('🔍 폭스바겐 차량 필터링 중...');
  const vwVehicleKeys = [];
  const vwKeywordMap = {}; // vehicleKey → keyword 매핑
  
  allVehicles.forEach(vehicleKey => {
    // vehicleKey 형식: "폭스바겐___ID.4 GTX"
    const parts = vehicleKey.split('___');
    if (parts.length === 2) {
      const manufacturer = parts[0];
      const model = parts[1];
      
      // 폭스바겐 확인
      if (manufacturer.includes('폭스바겐')) {
        // 키워드 매칭
        keywords.forEach(keywordObj => {
          const keyword = keywordObj.keyword;
          if (model.includes(keyword)) {
            if (!vwKeywordMap[keyword]) {
              vwKeywordMap[keyword] = vehicleKey;
              vwVehicleKeys.push(vehicleKey);
            }
          }
        });
      }
    }
  });
  
  console.log(`✅ ${vwVehicleKeys.length}개 폭스바겐 차량 발견`);
  
  // 국고보조금 수집
  const nationalSubsidies = {};
  
  allData.data.forEach(region => {
    if (region.success) {
      vwVehicleKeys.forEach(vKey => {
        if (region.vehicles[vKey] && !nationalSubsidies[vKey]) {
          nationalSubsidies[vKey] = region.vehicles[vKey].national;
        }
      });
    }
  });
  
  // 1행에 국고보조금 입력
  console.log('💰 국고보조금 입력 중...');
  await sheet.loadCells('C1:Z1');
  
  keywords.forEach(keywordObj => {
    const keyword = keywordObj.keyword;
    const col = keywordObj.col;
    const vehicleKey = vwKeywordMap[keyword];
    
    if (vehicleKey && nationalSubsidies[vehicleKey]) {
      const cell = sheet.getCell(0, col);
      cell.value = nationalSubsidies[vehicleKey] / 10000;
    }
  });
  
  await sheet.saveUpdatedCells();
  console.log('✅ 국고보조금 저장 완료');
  
  // 데이터 준비
  console.log('🔄 데이터 변환 중...');
  const rows = [];
  const failedRegions = [];
  
  allData.data.forEach(region => {
    let prefix, suffix;
    
    const parentName = region.parentName || '';
    const localName = region.localName || '';
    
    // 지역명 분리
    if (localName.includes('특별시')) {
      prefix = localName.replace('특별시', '');
      suffix = '특별시';
    } else if (localName.includes('광역시')) {
      prefix = localName.replace('광역시', '');
      suffix = '광역시';
    } else if (localName.includes('특별자치시')) {
      prefix = localName.replace('특별자치시', '');
      suffix = '특별자치시';
    } else if (localName.includes('특별자치도')) {
      prefix = localName.replace('특별자치도', '');
      suffix = '특별자치도';
    } else {
      prefix = parentName;
      suffix = localName;
    }
    
    const rowData = {
      '시/도': prefix,
      '시/군/구': suffix
    };
    
    const key = `${prefix}_${suffix}`;
    
    // 실패 처리
    if (!region.success) {
      console.log(`   ⚠️ 실패 지역: ${prefix} ${suffix} - 이전 값 사용`);
      
      failedRegions.push({
        region: `${prefix} ${suffix}`,
        sheet: 'VW',
        error: region.error || 'Unknown',
        attempts: region.attempts || 0,
        timestamp: region.timestamp
      });
      
      if (prevData[key]) {
        keywords.forEach(keywordObj => {
          const keyword = keywordObj.keyword;
          rowData[keyword] = prevData[key][keyword] || 0;
        });
      } else {
        keywords.forEach(keywordObj => {
          rowData[keywordObj.keyword] = 0;
        });
      }
    } else {
      // 성공: 키워드별 데이터 매핑
      keywords.forEach(keywordObj => {
        const keyword = keywordObj.keyword;
        const vehicleKey = vwKeywordMap[keyword];
        
        if (vehicleKey && region.vehicles[vehicleKey]) {
          rowData[keyword] = region.vehicles[vehicleKey].local / 10000;
        } else {
          rowData[keyword] = 0;
        }
      });
    }
    
    rows.push(rowData);
  });
  
  console.log(`✅ ${rows.length}개 행 준비 (실패 ${failedRegions.length}개는 이전 값 사용)`);
  
  // 헤더 설정 (4행부터 데이터, 3행이 헤더)
  console.log('📝 헤더 확인 중...');
  const headers = ['시/도', '시/군/구', ...keywords.map(k => k.keyword)];
  await sheet.setHeaderRow(headers, 3); // index 3 = 4행부터 데이터
  
  // 기존 데이터 삭제
  console.log('🗑️ 기존 데이터 삭제 중...');
  const existingRows = await sheet.getRows();
  
  if (existingRows.length > 0) {
    for (const row of existingRows) {
      await row.delete();
    }
    console.log(`✅ ${existingRows.length}개 행 삭제`);
  }
  
  // 새 데이터 입력
  console.log('💾 데이터 저장 중...');
  await sheet.addRows(rows);
  console.log('✅ VW 시트 업데이트 완료!');
  
  return { failedRegions };
}

// ==========================================
// 4. Fail Data 시트 업데이트
// ==========================================
async function updateFailSheet(doc, failedRegions) {
  if (failedRegions.length === 0) {
    console.log('');
    console.log('🎉 실패 지역 없음!');
    return;
  }
  
  console.log('');
  console.log('❌ ===== Fail Data 업데이트 =====');
  
  let sheet = doc.sheetsByTitle[SHEET_NAME_FAIL];
  
  if (!sheet) {
    console.log('📄 Fail Data 시트 생성 중...');
    sheet = await doc.addSheet({ title: SHEET_NAME_FAIL });
  }
  
  console.log(`✅ ${failedRegions.length}개 실패 지역 기록`);
  
  // 헤더 설정
  await sheet.setHeaderRow(['지역명', '시트', '에러메시지', '시도횟수', '타임스탬프']);
  
  // 기존 데이터 삭제
  const existingRows = await sheet.getRows();
  if (existingRows.length > 0) {
    for (const row of existingRows) {
      await row.delete();
    }
  }
  
  // 실패 데이터 입력
  const failRows = failedRegions.map(f => ({
    '지역명': f.region,
    '시트': f.sheet,
    '에러메시지': f.error,
    '시도횟수': f.attempts,
    '타임스탬프': new Date(f.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  }));
  
  await sheet.addRows(failRows);
  console.log('✅ Fail Data 업데이트 완료!');
}

// ==========================================
// 5. 메인 업로드 함수
// ==========================================
async function uploadToSheets() {
  console.log('');
  console.log('📊 Google Sheets 업로드 시작');
  
  try {
    // JSON 로드
    console.log('📁 data/subsidies.json 읽는 중...');
    const jsonData = await fs.readFile('data/subsidies.json', 'utf8');
    const scrapedData = JSON.parse(jsonData);
    
    console.log(`✅ ${scrapedData.data.length}개 지역 데이터 로드`);
    
    // 인증
    console.log('🔐 Google 인증 중...');
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`✅ 시트 연결: ${doc.title}`);
    
    // ALL 시트 업데이트 (전체)
    const { failedRegions: allFailed, allVehicles } = await updateALLSheet(doc, scrapedData);
    
    // VW 시트 업데이트 (필터링)
    const { failedRegions: vwFailed } = await updateVWSheet(doc, scrapedData, allVehicles);
    
    // Fail Data 업데이트
    const allFailedRegions = [...allFailed, ...vwFailed];
    await updateFailSheet(doc, allFailedRegions);
    
    console.log('');
    console.log('🎉 전체 업로드 완료!');
    console.log('🔗 시트 URL:');
    console.log(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
    
  } catch (error) {
    console.error('');
    console.error('❌ Google Sheets 업로드 실패:', error.message);
    console.error(error.stack);
    throw error;
  }
}

if (require.main === module) {
  uploadToSheets().catch(error => {
    console.error('💥 예상치 못한 오류:', error);
    process.exit(1);
  });
}

module.exports = { uploadToSheets };
