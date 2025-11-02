const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '1gph0IVQqaykAvYyo4QX875xaT6NjSVuZaRHsldCt0DM';
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
      const key = `${row['지역명(앞)']||''}_${row['지역명(뒤)']||''}`;
      prevData[key] = row;
    });
    
    return prevData;
  } catch (error) {
    console.log('   ⚠️ 이전 데이터 없음 (첫 실행)');
    return {};
  }
}

function getColumnLetter(colIndex) {
  let letter = '';
  let temp = colIndex + 1;
  
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
  
  const vehicleKeys = Array.from(allVehicles);
  console.log(`✅ ${vehicleKeys.length}개 차종 발견`);
  
  // 국고보조금 & 제조사/모델명 수집
  const nationalSubsidies = {};
  const manufacturers = {};
  const models = {};
  
  allData.data.forEach(region => {
    if (region.success) {
      Object.keys(region.vehicles).forEach(key => {
        const vehicle = region.vehicles[key];
        if (!nationalSubsidies[key]) {
          nationalSubsidies[key] = vehicle.national;
          manufacturers[key] = vehicle.manufacturer;
          models[key] = vehicle.model;
        }
      });
    }
  });
  
  // 정렬: 폭스바겐 우선 → 나머지 제조사 가나다순
  console.log('📊 차량 정렬 중 (폭스바겐 우선)...');
  vehicleKeys.sort((a, b) => {
    const manuA = manufacturers[a];
    const manuB = manufacturers[b];
    
    const isVWA = manuA.includes('폭스바겐');
    const isVWB = manuB.includes('폭스바겐');
    
    // 폭스바겐 우선
    if (isVWA && !isVWB) return -1;
    if (!isVWA && isVWB) return 1;
    
    // 나머지는 제조사 가나다순
    return manuA.localeCompare(manuB, 'ko');
  });
  
  console.log('✅ 정렬 완료');
  
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
      '지역명(앞)': prefix,
      '지역명(뒤)': suffix
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
          const colName = models[vKey]; // 모델명을 헤더로 사용
          rowData[colName] = prevData[key][colName] || 0;
        });
      } else {
        vehicleKeys.forEach(vKey => {
          const colName = models[vKey];
          rowData[colName] = 0;
        });
      }
    } else {
      vehicleKeys.forEach(vKey => {
        const colName = models[vKey];
        if (region.vehicles[vKey]) {
          rowData[colName] = region.vehicles[vKey].local / 10000;
        } else {
          rowData[colName] = 0;
        }
      });
    }
    
    rows.push(rowData);
  });
  
  console.log(`✅ ${rows.length}개 행 준비 (실패 ${failedRegions.length}개는 이전 값 사용)`);
  
  // 시트 초기화
  console.log('🗑️ 시트 초기화 중...');
  await sheet.clear();
  
  // 1행: 제조사
  console.log('🏭 1행: 제조사 작성 중...');
  const row1 = ['제조사', ''];
  vehicleKeys.forEach(key => {
    row1.push(manufacturers[key]);
  });
  
  // 2행: 모델명
  console.log('🚗 2행: 모델명 작성 중...');
  const row2 = ['모델명', ''];
  vehicleKeys.forEach(key => {
    row2.push(models[key]);
  });
  
  // 3행: 국비
  console.log('💰 3행: 국비 작성 중...');
  const row3 = ['국비', ''];
  vehicleKeys.forEach(key => {
    row3.push(nationalSubsidies[key] ? nationalSubsidies[key] / 10000 : 0);
  });
  
  // 4행: 헤더 (지역명)
  console.log('📝 4행: 헤더 작성 중...');
  const row4 = ['지역명(앞)', '지역명(뒤)'];
  vehicleKeys.forEach(key => {
    row4.push(models[key]); // 모델명을 헤더로
  });
  
  // 1-4행 입력
  const lastColIndex = Math.min(row1.length - 1, 701);
  const lastColLetter = getColumnLetter(lastColIndex);
  
  await sheet.loadCells(`A1:${lastColLetter}4`);
  
  for (let col = 0; col < row1.length && col < 702; col++) { 
    sheet.getCell(0, col).value = row1[col];
    sheet.getCell(1, col).value = row2[col];
    sheet.getCell(2, col).value = row3[col];
    sheet.getCell(3, col).value = row4[col];
  }
  await sheet.saveUpdatedCells();
  
  console.log('✅ 1-4행 저장 완료');
  
  // 헤더 설정 (4행)
  await sheet.setHeaderRow(row4, 3);
  
  // 데이터 입력
  console.log('💾 데이터 저장 중...');
  await sheet.addRows(rows);
  console.log('✅ ALL 시트 업데이트 완료!');
  
  return { failedRegions };
}

// ==========================================
// 3. Fail Data 시트 업데이트
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
  await sheet.clearRows();
  
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
// 4. 메인 업로드 함수
// ==========================================
async function uploadToSheets() {
  console.log('');
  console.log('📊 Google Sheets 업로드 시작');
  
  try {
    const jsonData = await fs.readFile('data/subsidies.json', 'utf8');
    const scrapedData = JSON.parse(jsonData);
    
    console.log(`✅ ${scrapedData.data.length}개 지역 데이터 로드`);
    
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`✅ 시트 연결: ${doc.title}`);
    
    const { failedRegions } = await updateALLSheet(doc, scrapedData);
    await updateFailSheet(doc, failedRegions);
    
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
