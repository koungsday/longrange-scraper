const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 설정
// ==========================================
const MAX_RETRIES = 3;
const YEAR = new Date().getFullYear();
const DATA_DIR = path.join(__dirname, '../data', String(YEAR));

// ==========================================
// 메인 실행 함수
// ==========================================
(async () => {
  console.log(`🚀 스크래퍼 시작 (연도: ${YEAR})`);

  // 데이터 디렉토리 생성
  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // 1. 차량 정보 수집
    const vehicles = await scrapeVehicles(browser);
    await saveJson('vehicles.json', vehicles);

    // 2. 국고 보조금 수집
    // const nationalSubsidies = await scrapeNationalSubsidies(browser); // (차량 정보에 포함됨)

    // 3. 지자체 보조금 수집
    const localSubsidies = await scrapeLocalSubsidies(browser);
    await saveJson('subsidies-legacy.json', localSubsidies);

    // 4. 지역별 부처 전화번호 수집
    const phones = await scrapeLocalPhones(browser);

    // 5. 데이터 정규화 및 병합
    const normalizedData = normalizeData(vehicles, localSubsidies, phones);
    await saveJson('subsidies.json', normalizedData);

    // 6. years.json 업데이트
    await updateYearsJson(YEAR);

    console.log('🎉 모든 작업 완료!');

    // 결과 요약 출력
    printSummary(vehicles, normalizedData, localSubsidies);

  } catch (error) {
    console.error('❌ 치명적 오류 발생:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();

// ==========================================
// 1. 차량 정보 스크래핑
// ==========================================
async function scrapeVehicles(browser) {
  console.log('🚗 차량 정보 스크래핑...');
  const page = await browser.newPage();
  const URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';

  await page.goto(URL, { waitUntil: 'networkidle2' });

  // 제조사 목록 가져오기
  const brands = await page.evaluate(() => {
    const options = document.querySelectorAll('#car_mnf_cd option');
    return Array.from(options)
      .filter(opt => opt.value)
      .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
  });

  const vehicles = [];

  // 각 제조사별 차량 조회
  for (const brand of brands) {
    console.log(`   🔍 제조사 검색: ${brand.name}`);

    // 제조사 선택
    await page.select('#car_mnf_cd', brand.id);

    // 검색 버튼 클릭 및 대기
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { }), // 네비게이션이 없을 수도 있음
      page.click('#btn_search')
    ]);

    // 테이블 데이터 추출
    const carData = await page.evaluate((brandName) => {
      const rows = document.querySelectorAll('.table_02 tbody tr');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return null;

        return {
          brand: brandName,
          model: cells[1]?.textContent.trim(),
          trim: cells[2]?.textContent.trim(),
          price: parseInt(cells[3]?.textContent.replace(/,/g, '') || '0', 10) * 10000, // 만원 -> 원
          subsidy: parseInt(cells[4]?.textContent.replace(/,/g, '') || '0', 10) * 10000
        };
      }).filter(item => item !== null);
    }, brand.name);

    vehicles.push(...carData);

    // 봇 탐지 방지용 딜레이
    await new Promise(r => setTimeout(r, 1000));
  }

  await page.close();
  console.log(`   ✅ 총 ${vehicles.length}개 차량 정보 수집 완료`);
  return vehicles;
}

// ==========================================
// 3. 지자체 보조금 스크래핑 (레거시 구조 유지)
// ==========================================
async function scrapeLocalSubsidies(browser) {
  console.log('🏙️ 지자체 보조금 스크래핑...');
  const page = await browser.newPage();

  // 지자체 공고 페이지 (가장 데이터가 많은 곳으로 추정)
  // 실제로는 API나 다른 페이지를 크롤링해야 할 수도 있음.
  // 여기서는 예시로 메인 페이지 구조를 활용한다고 가정.
  // ※ 실제 ev.or.kr 구조는 복잡하므로, 여기서는 '지자체 차종별 보조금' 페이지를 타겟으로 함.
  const URL = 'https://ev.or.kr/nportal/buySupprt/initLocalCarSubsidyAction.do';

  // 참고: 실제로는 지역별로 dropdown을 선택하고 조회해야 함.
  // 전체 데이터를 순회하는 로직 필요.

  await page.goto(URL, { waitUntil: 'networkidle2' });

  // 시/도 목록 가져오기
  const sidos = await page.evaluate(() => {
    const options = document.querySelectorAll('#sido_cd option');
    return Array.from(options)
      .filter(opt => opt.value)
      .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
  });

  const allSubsidies = [];

  for (const sido of sidos) {
    console.log(`   Searching Region: ${sido.name}`);

    // 시/도 선택
    await page.select('#sido_cd', sido.id);

    // 잠시 대기 (AJAX 로딩)
    await new Promise(r => setTimeout(r, 500));

    // 군/구 목록이 있다면 순회, 없다면 시/도 단위 조회
    const gungus = await page.evaluate(() => {
      const options = document.querySelectorAll('#sigun_cd option');
      return Array.from(options)
        .filter(opt => opt.value)
        .map(opt => ({ id: opt.value, name: opt.textContent.trim() }));
    });

    const targets = gungus.length > 0 ? gungus : [{ id: '', name: '전체' }];

    for (const target of targets) {
      if (target.id) {
        await page.select('#sigun_cd', target.id);
      }

      // 조회 버튼 클릭
      await page.click('#btn_search');

      try {
        // 테이블 로딩 대기
        await page.waitForSelector('.table_02 tbody tr', { timeout: 3000 });

        const data = await page.evaluate((sidoName, gunguName) => {
          const rows = document.querySelectorAll('.table_02 tbody tr');
          return Array.from(rows).map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return null;

            // 차종 | 국비 | 지방비 | 보조금 합계 | 비고
            return {
              sido: sidoName,
              gungu: gunguName === '전체' ? '' : gunguName,
              model: cells[0]?.textContent.trim(),
              national: parseInt(cells[1]?.textContent.replace(/,/g, '') || '0', 10) * 10000,
              local: parseInt(cells[2]?.textContent.replace(/,/g, '') || '0', 10) * 10000,
              total: parseInt(cells[3]?.textContent.replace(/,/g, '') || '0', 10) * 10000
            };
          }).filter(x => x);
        }, sido.name, target.name);

        if (data.length > 0) {
          // console.log(`      Found ${data.length} entries for ${target.name}`);
          allSubsidies.push(...data);
        } else {
          // console.log(`      No data for ${target.name}`);
          // 데이터가 없으면 '접수대기'나 '마감'일 수 있음 -> 빈 데이터라도 지역 정보는 남길지 고려
        }

      } catch (e) {
        // 타임아웃 등
        // console.log(`      Error/No Data for ${target.name}`);
      }

      // 딜레이
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await page.close();
  console.log(`   ✅ 지자체 보조금 데이터 ${allSubsidies.length}건 수집 완료`);
  return allSubsidies;
}

// ==========================================
// 4. 지역별 부처 전화번호 스크래핑
// ==========================================
// 변경: pnp4web 보안 모듈 우회 시도 및 "조회" 버튼 클릭 추가
// ==========================================
async function scrapeLocalPhones(browser) {
  console.log('📞 지역별 부처 전화번호 스크래핑...');
  const PHONE_URL = 'https://ev.or.kr/nportal/buySupprt/psLocalPhone.do';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;

    try {
      page = await browser.newPage();

      // ⭐ 핵심 1: 데스크탑 환경 흉내 (Viewport 설정)
      await page.setViewport({ width: 1920, height: 1080 });

      // ⭐ 핵심 2: 봇 탐지 우회를 위한 User-Agent 설정
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      await page.setDefaultNavigationTimeout(90000); // 1분 30초
      await page.setDefaultTimeout(90000);

      // 1단계: 전화번호 페이지로 이동
      console.log('   Navigating to phone page...');
      await page.goto(PHONE_URL, { waitUntil: 'networkidle2', timeout: 90000 });

      // 2단계: 보안 모듈 대기 (10초)
      console.log('   ⏳ 보안 모듈 실행 대기 (10초)...');
      await new Promise(r => setTimeout(r, 10000));

      // 3단계: 조회 버튼 클릭 시도 (데이터 로딩 트리거)
      console.log('   🖱️ 조회 버튼 클릭 시도...');
      try {
        // 일반적인 조회 버튼 셀렉터들 시도
        const searchBtnSelectors = ['#btn_search', '.btn_search', 'a.btn_search', '#searchBtn', 'button[type="submit"]'];
        let clicked = false;

        for (const selector of searchBtnSelectors) {
          const btn = await page.$(selector);
          if (btn) {
            console.log(`      Found search button: ${selector}`);
            await btn.click();
            clicked = true;
            await new Promise(r => setTimeout(r, 1000)); // 클릭 후 잠시 대기
            break;
          }
        }

        if (!clicked) {
          console.log('      ⚠️ 조회 버튼을 찾을 수 없음 (자동 로딩일 수 있음)');
          // 버튼을 못 찾았더라도 일단 대기 (혹시나 해서)
        } else {
          console.log('      ⏳ 데이터 로딩 대기 (부하 고려 5초)...');
          await new Promise(r => setTimeout(r, 5000));
        }

      } catch (e) {
        console.log(`      ⚠️ 버튼 클릭 중 오류: ${e.message}`);
      }

      // 4단계: 테이블 데이터 대기
      try {
        await page.waitForSelector('table tbody td', { timeout: 10000 });
        console.log('   ✅ 테이블 데이터 렌더링 감지됨');
      } catch (e) {
        console.log('   ⚠️ 테이블 데이터 셀렉터 타임아웃');
      }

      // 5단계: HTML 덤프 및 디버깅
      const htmlToParse = await page.content();
      console.log(`   🔍 DOM 데이터 크기: ${htmlToParse.length} bytes`);

      // 파일로 저장해서 나중에 확인 가능하게 함
      try {
        const fs = require('fs').promises;
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile('data/debug-phones-last.html', htmlToParse);
      } catch (e) { }

      // 6단계: 정규식으로 데이터 추출
      const phones = [];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;

      while ((rowMatch = rowRegex.exec(htmlToParse)) !== null) {
        const rowContent = rowMatch[1];
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
          const text = cellMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
          cells.push(text);
        }

        if (cells.length >= 4) {
          const region = cells[0];
          const subRegion = cells[1];
          const department = cells[2];
          const phone = cells[3];
          const note = cells.length > 4 ? cells[4] : '';

          if (phone && /[\d-]{7,}/.test(phone) && region && region !== '시도') {
            phones.push({ region, subRegion, department, phone, note });
          }
        }
      }

      if (phones.length > 0) {
        console.log(`   ✅ 수집 성공: ${phones.length}개 지역 전화번호`);
        await page.close();
        return phones;
      }

      // 데이터가 없을 경우
      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ 0건 수집 - 재시도 ${attempt}/${MAX_RETRIES}`);
        await page.close();
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      await page.close();
      return [];

    } catch (error) {
      if (page) await page.close().catch(() => { });

      if (attempt < MAX_RETRIES) {
        console.log(`   ⚠️ 재시도 ${attempt}/${MAX_RETRIES}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      } else {
        console.error(`   ❌ 전화번호 스크래핑 최종 실패: ${error.message}`);
        return [];
      }
    }
  }

  return [];
}

// ==========================================
// 5. 데이터 정규화 (프론트엔드용 최적화)
// ==========================================
function normalizeData(vehicles, localSubsidies, phones) {
  console.log('🧹 데이터 정규화 중...');

  // 전화번호 맵핑 (Region + SubRegion -> Phone Info)
  const phoneMap = new Map();
  phones.forEach(p => {
    const key = `${p.region} ${p.subRegion || ''}`.trim();
    phoneMap.set(key, p);
  });

  // 결과 데이터 구조
  // { "서울": { "전체": { subsidies: {...}, phone: {...} }, "지역구": ... } }
  const result = {};

  localSubsidies.forEach(item => {
    const sido = item.sido;
    const gungu = item.gungu || '전체';

    if (!result[sido]) result[sido] = {};
    if (!result[sido][gungu]) {
      result[sido][gungu] = {
        subsidies: {},
        phone: null
      };
    }

    // 보조금 정보 매핑 (차종별)
    // item.model (e.g. "아이오닉6 롱레인지 2WD 20인치") -> vehicles에서 매칭되는지 확인
    const matchedVehicle = vehicles.find(v => v.model === item.model);
    if (matchedVehicle) {
      // 차종 ID나 이름으로 매핑
      // 여기서는 단순하게 모델명 그대로 키로 사용 (나중에 프론트에서 매칭)
      result[sido][gungu].subsidies[item.model] = {
        national: item.national,
        local: item.local,
        total: item.total
      };
    }

    // 전화번호 매핑
    const phoneKey = `${sido} ${gungu}`.trim();
    const phoneKeySidoOnly = sido; // 군구가 없는 경우 시도 대표 번호

    if (phoneMap.has(phoneKey)) {
      result[sido][gungu].phone = phoneMap.get(phoneKey);
    } else if (phoneMap.has(phoneKeySidoOnly)) {
      // 구체적인 지역 번호가 없으면 시도 대표 번호 사용 (선택사항)
      result[sido][gungu].phone = phoneMap.get(phoneKeySidoOnly);
    }
  });

  return result;
}

// ==========================================
// 6. years.json 업데이트
// ==========================================
async function updateYearsJson(newYear) {
  const yearsFile = path.join(__dirname, '../data', 'years.json');
  let years = [];
  try {
    const data = await fs.readFile(yearsFile, 'utf8');
    years = JSON.parse(data);
  } catch (e) {
    years = [];
  }

  if (!years.includes(newYear)) {
    years.push(newYear);
    years.sort((a, b) => b - a); // 내림차순 정렬
    await fs.writeFile(yearsFile, JSON.stringify(years, null, 2));
    console.log(`📅 years.json 업데이트 완료: [${years.join(', ')}]`);
  }
}

// ==========================================
// 유틸리티
// ==========================================
async function saveJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  console.log(`💾 ${filename} 저장 완료 (${(await fs.stat(filePath)).size / 1024}KB)`);
}

function printSummary(vehicles, normalizedData, localSubsidies) {
  console.log('\n📊 데이터 크기 비교:');
  console.log(`   레거시: ${(JSON.stringify(localSubsidies).length / 1024 / 1024).toFixed(2)}MB`);
  console.log(`   정규화: ${(JSON.stringify(normalizedData).length / 1024 / 1024).toFixed(2)}MB (vehicles + subsidies)`);
  // console.log(`   감소율: ...%`);
}
