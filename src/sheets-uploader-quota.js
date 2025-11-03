const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '1gph0IVQqaykAvYyo4QX875xaT6NjSVuZaRHsldCt0DM';
const SHEET_NAME_QUOTA = '접수현황';
const SHEET_NAME_FAIL = 'Fail Data_Quota';

// ==========================================
// 1. 이전 데이터 읽기 (실패 시 재활용)
// ==========================================
async function getPreviousData(sheet) {
  try {
    const rows = await sheet.getRows();
    const prevData = {};
    
    rows.forEach(row => {
      const key = `${row['지역명(앞)']||''}_${row['지역명(뒤)']||''}_${row['차량구분']||''}`;
      prevData[key] = row;
    });
    
    return prevData;
  } catch (error) {
    console.log('   ⚠️ 이전 데이터 없음 (첫 실행)');
    return {};
  }
}

// ==========================================
// 2. 접수현황 시트 업데이트
// ==========================================
async function updateQuotaSheet(doc, quotaData) {
  console.log('');
  console.log('🟢 ===== 접수현황 시트 업데이트 =====');
  
  let sheet = doc.sheetsByTitle[SHEET_NAME_QUOTA];
  
  if (!sheet) {
    console.log('📄 접수현황 시트 생성 중...');
    sheet = await doc.addSheet({ title: SHEET_NAME_QUOTA });
  }
  
  console.log('✅ 접수현황 시트 확인');
  
  // 이전 데이터 로드
  console.log('📁 이전 데이터 로딩...');
  const prevData = await getPreviousData(sheet);
  console.log(`✅ ${Object.keys(prevData).length}개 이전 행`);
  
  // 데이터 준비
  console.log('🔄 데이터 변환 중...');
  const rows = [];
  const failedRegions = [];
  
  quotaData.data.forEach(region => {
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
    
    // 실패 처리
    if (!region.success) {
      console.log(`   ⚠️ 실패 지역: ${prefix} ${suffix} - 이전 값 사용`);
      
      failedRegions.push({
        region: `${prefix} ${suffix}`,
        error: region.error || 'Unknown',
        attempts: region.attempts || 0,
        timestamp: region.timestamp
      });
      
      // 이전 데이터 있으면 재활용
      const existingRows = Object.values(prevData).filter(
        row => row['지역명(앞)'] === prefix && row['지역명(뒤)'] === suffix
      );
      
      if (existingRows.length > 0) {
        existingRows.forEach(prevRow => {
          rows.push({
            '지역명(앞)': prevRow['지역명(앞)'] || prefix,
            '지역명(뒤)': prevRow['지역명(뒤)'] || suffix,
            '차량구분': prevRow['차량구분'] || '',
            '공고': prevRow['공고'] || '',
            '접수방법': prevRow['접수방법'] || '',
            '전체': prevRow['전체'] || 0,
            '우선순위': prevRow['우선순위'] || 0,
            '법인/기관': prevRow['법인/기관'] || 0,
            '택시': prevRow['택시'] || 0,
            '일반': prevRow['일반'] || 0,
            '접수대수': prevRow['접수대수'] || 0,
            '출고대수': prevRow['출고대수'] || 0,
            '잔여대수': prevRow['잔여대수'] || 0,
            '비고': prevRow['비고'] || ''
          });
        });
      } else {
        // 이전 데이터 없으면 빈 행 추가
        rows.push({
          '지역명(앞)': prefix,
          '지역명(뒤)': suffix,
          '차량구분': '데이터 없음',
          '공고': '',
          '접수방법': '',
          '전체': 0,
          '우선순위': 0,
          '법인/기관': 0,
          '택시': 0,
          '일반': 0,
          '접수대수': 0,
          '출고대수': 0,
          '잔여대수': 0,
          '비고': '스크래핑 실패'
        });
      }
    } else {
      // 성공: 각 차량구분별로 행 추가
      if (region.quotaData && region.quotaData.length > 0) {
        region.quotaData.forEach(quota => {
          rows.push({
            '지역명(앞)': prefix,
            '지역명(뒤)': suffix,
            '차량구분': quota.vehicleType || '',
            '공고': quota.announcement || '',
            '접수방법': quota.registrationMethod || '',
            '전체': quota.quota_total || 0,
            '우선순위': quota.quota_priority || 0,
            '법인/기관': quota.quota_corporate || 0,
            '택시': quota.quota_taxi || 0,
            '일반': quota.quota_general || 0,
            '접수대수': quota.registered || 0,
            '출고대수': quota.delivered || 0,
            '잔여대수': quota.remaining || 0,
            '비고': quota.note || ''
          });
        });
      } else {
        // 성공했지만 데이터 없음
        rows.push({
          '지역명(앞)': prefix,
          '지역명(뒤)': suffix,
          '차량구분': '공고 없음',
          '공고': '',
          '접수방법': '',
          '전체': 0,
          '우선순위': 0,
          '법인/기관': 0,
          '택시': 0,
          '일반': 0,
          '접수대수': 0,
          '출고대수': 0,
          '잔여대수': 0,
          '비고': ''
        });
      }
    }
  });
  
  console.log(`✅ ${rows.length}개 행 준비 (실패 ${failedRegions.length}개는 이전 값 사용)`);
  
  // 시트 초기화
  console.log('🗑️ 시트 초기화 중...');
  await sheet.clear();
  
  // 헤더 설정
  console.log('📝 헤더 설정 중...');
  const headers = [
    '지역명(앞)', '지역명(뒤)', '차량구분', '공고', '접수방법',
    '전체', '우선순위', '법인/기관', '택시', '일반',
    '접수대수', '출고대수', '잔여대수', '비고'
  ];
  
  await sheet.setHeaderRow(headers);
  
  // 데이터 입력
  console.log('💾 데이터 저장 중...');
  await sheet.addRows(rows);
  console.log('✅ 접수현황 시트 업데이트 완료!');
  
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
  await sheet.setHeaderRow(['지역명', '에러메시지', '시도횟수', '타임스탬프']);
  
  // 기존 데이터 삭제
  await sheet.clearRows();
  
  // 실패 데이터 입력
  const failRows = failedRegions.map(f => ({
    '지역명': f.region,
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
    const jsonData = await fs.readFile('data/quota.json', 'utf8');
    const quotaData = JSON.parse(jsonData);
    
    console.log(`✅ ${quotaData.data.length}개 지역 데이터 로드`);
    
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`✅ 시트 연결: ${doc.title}`);
    
    const { failedRegions } = await updateQuotaSheet(doc, quotaData);
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
