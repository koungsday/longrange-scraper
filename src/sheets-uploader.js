const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs').promises;

// ==========================================
// 설정
// ==========================================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '1gph0IVQqaykAvYyo4QX875xaT6NjSVuZaRHsldCt0DM';
const SHEET_NAME = '보조금 DATA';

// ==========================================
// Google Sheets 업로드
// ==========================================
async function uploadToSheets() {
  console.log('');
  console.log('📊 Google Sheets 업로드 시작');
  
  try {
    // 1. JSON 파일 읽기
    console.log('📁 data/subsidies.json 읽는 중...');
    const jsonData = await fs.readFile('data/subsidies.json', 'utf8');
    const scrapedData = JSON.parse(jsonData);
    
    console.log(`✅ ${scrapedData.data.length}개 지역 데이터 로드`);
    
    // 2. Service Account 인증
    console.log('🔐 Google 인증 중...');
    
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    // 3. 시트 연결
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    console.log(`✅ 시트 연결: ${doc.title}`);
    
    const sheet = doc.sheetsByTitle[SHEET_NAME];
    
    if (!sheet) {
      throw new Error(`시트를 찾을 수 없습니다: ${SHEET_NAME}`);
    }
    
    console.log(`✅ "${SHEET_NAME}" 시트 확인`);
    
    // 4. 데이터 변환
    console.log('🔄 데이터 변환 중...');
    
    const rows = [];
    const keywords = scrapedData.keywords;
    
    scrapedData.data.forEach(region => {
      let prefix, suffix;
      
      const parentName = region.parentName || '';
      const localName = region.localName || '';
      
      // 지역명 분리 로직 (Apps Script와 동일)
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
      
      // 각 키워드별 지방비
      keywords.forEach(keyword => {
        if (region.vehicles[keyword]) {
          rowData[keyword] = region.vehicles[keyword].local / 10000; // 만원 단위
        } else {
          rowData[keyword] = 0;
        }
      });
      
      rows.push(rowData);
    });
    
    console.log(`✅ ${rows.length}개 행 준비 완료`);
    
   console.log(`✅ ${rows.length}개 행 준비 완료`);
    
    // 5. 헤더 먼저 설정 (3행)
    console.log('📝 헤더 작성 중...');
    const headers = ['시/도', '시/군/구', ...keywords];
    
    await sheet.setHeaderRow(headers, 2); // 3행 (index 2)
    
    // 6. 기존 데이터 행 삭제
    console.log('🗑️ 기존 데이터 삭제 중...');
    const existingRows = await sheet.getRows();
    
    if (existingRows.length > 0) {
      for (const row of existingRows) {
        await row.delete();
      }
      console.log(`✅ ${existingRows.length}개 행 삭제 완료`);
    }
    
    // 7. 새 데이터 입력
    console.log('💾 데이터 저장 중...');
    await sheet.addRows(rows);
    
    // 8. 타임스탬프 기록
    await sheet.loadCells('Z2');
    const timestampCell = sheet.getCellByA1('Z2');
    timestampCell.value = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    await sheet.saveUpdatedCells();
    
    console.log('✅ Google Sheets 업데이트 완료!');
    console.log('');
    console.log('🔗 시트 URL:');
    console.log(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
    
  } catch (error) {
    console.error('');
    console.error('❌ Google Sheets 업로드 실패:', error.message);
    throw error;
  }
}

// 실행
if (require.main === module) {
  uploadToSheets().catch(error => {
    console.error('💥 예상치 못한 오류:', error);
    process.exit(1);
  });
}

module.exports = { uploadToSheets };
