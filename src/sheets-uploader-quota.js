const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs').promises;

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '1gph0IVQqaykAvYyo4QX875xaT6NjSVuZaRHsldCt0DM';
const SHEET_NAME_QUOTA = '접수현황';
const SHEET_NAME_FAIL = 'Fail Data_Quota';

async function getPreviousData(sheet) {
  try {
    const rows = await sheet.getRows();
    const prevData = {};
    
    rows.forEach(row => {
      const key = `${row['지역(앞)']||''}_${row['지역(뒤)']||''}_${row['차량구분']||''}`;
      prevData[key] = row;
    });
    
    return prevData;
  } catch (error) {
    console.log('   ⚠️ 이전 데이터 없음');
    return {};
  }
}

async function updateQuotaSheet(doc, quotaData) {
  console.log('');
  console.log('🟢 ===== 접수현황 시트 업데이트 =====');
  
  let sheet = doc.sheetsByTitle[SHEET_NAME_QUOTA];
  
  if (!sheet) {
    console.log('📄 접수현황 시트 생성 중...');
    sheet = await doc.addSheet({ title: SHEET_NAME_QUOTA });
  }
  
  console.log('✅ 접수현황 시트 확인');
  
  const prevData = await getPreviousData(sheet);
  console.log(`✅ ${Object.keys(prevData).length}개 이전 행`);
  
  console.log('🔄 데이터 변환 중...');
  const rows = [];
  const failedRegions = [];
  
  quotaData.data.forEach(region => {
    let prefix, suffix;
    
    const parentName = region.parentName || '';
    const localName = region.localName || '';
    
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
    
    if (!region.success) {
      failedRegions.push({
        region: `${prefix} ${suffix}`,
        error: region.error || 'Unknown',
        attempts: region.attempts || 0,
        timestamp: region.timestamp
      });
      
      const existingRows = Object.values(prevData).filter(
        row => row['지역(앞)'] === prefix && row['지역(뒤)'] === suffix
      );
      
      if (existingRows.length > 0) {
        existingRows.forEach(prevRow => rows.push(prevRow));
      }
    } else {
      if (region.quotaData && region.quotaData.length > 0) {
        region.quotaData.forEach(quota => {
          rows.push({
            '차량구분': quota.vehicleType || '',
            '공고': quota.announcement || '',
            '접수방법': quota.registrationMethod || '',
            
            '전체_전체': quota.quota_total || 0,
            '전체_우선': quota.quota_priority || 0,
            '전체_법인': quota.quota_corporate || 0,
            '전체_택시': quota.quota_taxi || 0,
            '전체_일반': quota.quota_general || 0,
            
            '접수_전체': quota.registered_total || 0,
            '접수_우선': quota.registered_priority || 0,
            '접수_법인': quota.registered_corporate || 0,
            '접수_택시': quota.registered_taxi || 0,
            '접수_일반': quota.registered_general || 0,
            
            '출고_전체': quota.delivered_total || 0,
            '출고_우선': quota.delivered_priority || 0,
            '출고_법인': quota.delivered_corporate || 0,
            '출고_택시': quota.delivered_taxi || 0,
            '출고_일반': quota.delivered_general || 0,
            
            '잔여_전체': quota.remaining_total || 0,
            '잔여_우선': quota.remaining_priority || 0,
            '잔여_법인': quota.remaining_corporate || 0,
            '잔여_택시': quota.remaining_taxi || 0,
            '잔여_일반': quota.remaining_general || 0,
            
            '비고': quota.note || ''
          });
        });
      }
    }
  });
  
  console.log(`✅ ${rows.length}개 행 준비`);
  
  console.log('🗑️ 시트 초기화 중...');
  await sheet.clear();
  
  console.log('📝 헤더 설정 중...');
  const headers = [
    '차량구분', '공고', '접수방법',
    '전체_전체', '전체_우선', '전체_법인', '전체_택시', '전체_일반',
    '접수_전체', '접수_우선', '접수_법인', '접수_택시', '접수_일반',
    '출고_전체', '출고_우선', '출고_법인', '출고_택시', '출고_일반',
    '잔여_전체', '잔여_우선', '잔여_법인', '잔여_택시', '잔여_일반',
    '비고'
  ];
  
  await sheet.setHeaderRow(headers);
  
  console.log('💾 데이터 저장 중...');
  await sheet.addRows(rows);
  console.log('✅ 접수현황 시트 업데이트 완료!');
  
  return { failedRegions };
}

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
    sheet = await doc.addSheet({ title: SHEET_NAME_FAIL });
  }
  
  await sheet.setHeaderRow(['지역명', '에러메시지', '시도횟수', '타임스탬프']);
  await sheet.clearRows();
  
  const failRows = failedRegions.map(f => ({
    '지역명': f.region,
    '에러메시지': f.error,
    '시도횟수': f.attempts,
    '타임스탬프': new Date(f.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  }));
  
  await sheet.addRows(failRows);
  console.log('✅ Fail Data 업데이트 완료!');
}

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
    console.error('❌ 업로드 실패:', error.message);
    console.error(error.stack);
    throw error;
  }
}

if (require.main === module) {
  uploadToSheets().catch(error => {
    console.error('💥 오류:', error);
    process.exit(1);
  });
}

module.exports = { uploadToSheets };
