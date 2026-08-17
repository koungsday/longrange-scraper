const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { parseQuotaXlsx } = require('./parse-quota-xlsx');

const TEST_MODE = false;
const MAX_RETRIES = 3;
/** Excel 다운로드 대기 상한. 파일이 1.9MB 라 보통 몇 초면 끝난다. */
const EXCEL_TIMEOUT_MS = 60000;

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


/**
 * 「Excel 다운로드」를 눌러 xlsx 를 받고 파싱한다.
 *
 * ★POST 를 직접 흉내내지 않는 이유: 요청에 난독화 스크립트(pnp4web)가 만드는
 *   pnph 토큰이 붙는다. 브라우저 밖에서 재현하면 토큰 규칙이 바뀔 때마다 깨진다.
 *   버튼을 누르면 그 토큰은 사이트가 알아서 만든다.
 */
async function downloadAndParseExcel(page) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evquota-'));
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

    // 버튼 문구가 'Excel 다운로드' 다. 아이콘만 바뀌어도 견디도록 부분일치로 찾는다.
    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, input[type=button]')];
      const t = els.find((e) => ((e.innerText || e.value || '').replace(/\s/g, '')).includes('Excel'));
      if (!t) return false;
      t.click();
      return true;
    });
    if (!clicked) throw new Error("'Excel 다운로드' 버튼을 찾지 못했습니다 (페이지가 또 바뀌었을 수 있음)");

    // .crdownload 가 사라지고 .xlsx 가 안정될 때까지 기다린다.
    const deadline = Date.now() + EXCEL_TIMEOUT_MS;
    let file = null;
    while (Date.now() < deadline) {
      const names = await fs.readdir(dir);
      const done = names.filter((n) => n.toLowerCase().endsWith('.xlsx'));
      const pending = names.some((n) => n.endsWith('.crdownload'));
      if (done.length && !pending) { file = path.join(dir, done[0]); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!file) throw new Error(`Excel 다운로드가 ${EXCEL_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다`);

    const buf = await fs.readFile(file);
    console.log(`   📥 Excel ${(buf.length / 1024 / 1024).toFixed(1)}MB 수신`);
    return parseQuotaXlsx(buf);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function scrapeRegionWithRetry(browser, region) {
  const targetUrl = `https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do?local_cd=${region.code}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page = null;

    try {
      page = await browser.newPage();
      await page.setDefaultNavigationTimeout(30000);
      await page.setDefaultTimeout(30000);

      // ★2026-08-16 개편 — 이 페이지에서 <table> 이 사라졌다(AG Grid 가상 스크롤).
      //   161건 중 화면에 보이는 10건 남짓만 DOM 에 있어 HTML 파싱이 성립하지 않는다.
      //   사이트가 제공하는 「Excel 다운로드」로 받는다 — 161건이 한 번에 온다.
      await page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      const quotaData = await downloadAndParseExcel(page);
      await page.close();

      if (!quotaData.length) throw new Error('Excel 을 받았으나 행이 0건입니다');

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
      // 성공 경로에서 이미 닫은 뒤 실패할 수도 있다(행 0건 검사). 두 번 닫아도 죽지 않게.
      if (page) await page.close().catch(() => {});

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

// ==========================================
// 일일 스냅샷 히스토리 누적
// ==========================================
async function saveQuotaHistory(quotaData, regions) {
  const HISTORY_PATH = 'data/quota-history.json';

  // 지역명 → 코드 매핑 (프론트엔드에서 코드로 조회 가능)
  const nameToCode = {};
  const regionMeta = {};
  for (const r of regions) {
    nameToCode[r.localName] = String(r.code);
    regionMeta[String(r.code)] = { name: r.localName, sido: r.parentName };
  }

  // 오늘 날짜 (KST)
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const currentYear = parseInt(today.substring(0, 4));

  // 기존 히스토리 읽기
  let history;
  try {
    const existing = await fs.readFile(HISTORY_PATH, 'utf8');
    history = JSON.parse(existing);
  } catch {
    history = { year: currentYear, lastUpdated: '', regions: {}, snapshots: {} };
  }

  // 연도 변경 시 아카이브
  if (history.year && history.year !== currentYear) {
    console.log(`📅 연도 변경 감지: ${history.year} → ${currentYear}`);
    const archivePath = `data/quota-history-${history.year}.json`;
    await fs.writeFile(archivePath, JSON.stringify(history, null, 2));
    console.log(`💾 ${archivePath} 아카이브 완료`);
    history = { year: currentYear, lastUpdated: '', regions: {}, snapshots: {} };
  }

  // 지역 메타데이터 갱신
  history.regions = regionMeta;

  // 오늘 스냅샷 생성 (지역코드 → 차종 → 수치)
  const todaySnapshot = {};
  for (const row of quotaData) {
    const regionName = row.region;
    if (!regionName) continue;

    const code = nameToCode[regionName] || regionName;
    if (!todaySnapshot[code]) {
      todaySnapshot[code] = {};
    }

    const vehicleType = row.vehicleType || '기타';
    todaySnapshot[code][vehicleType] = {
      total: { total: row.quota_total, priority: row.quota_priority, corporate: row.quota_corporate, taxi: row.quota_taxi, general: row.quota_general },
      remaining: { total: row.remaining_total, priority: row.remaining_priority, corporate: row.remaining_corporate, taxi: row.remaining_taxi, general: row.remaining_general },
      registered: { total: row.registered_total, priority: row.registered_priority, corporate: row.registered_corporate, taxi: row.registered_taxi, general: row.registered_general },
      delivered: { total: row.delivered_total, priority: row.delivered_priority, corporate: row.delivered_corporate, taxi: row.delivered_taxi, general: row.delivered_general }
    };
  }

  // 오늘 날짜 엔트리 덮어쓰기 (같은 날 여러번 실행 시 최신값 유지)
  history.snapshots[today] = todaySnapshot;
  history.year = currentYear;
  history.lastUpdated = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST';

  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));

  const totalDays = Object.keys(history.snapshots).length;
  const totalRegions = Object.keys(todaySnapshot).length;
  console.log(`💾 ${HISTORY_PATH} 저장 완료 (${totalDays}일 × ${totalRegions}개 지역)`);

  // [지역별 슬라이스] data/quota-history/<code>.json — 전체 파일(~17MB)과 동일 스키마의
  // 1지역 슬라이스(minified ~50KB). vw-k 클라이언트가 지역 하나의 추이만 받도록(방문자 대역폭).
  // 실데이터(스냅샷·메타·연도) 동일하면 미기록 — lastUpdated 만 바뀐 파일을 매 실행 커밋하지 않기 위함.
  const SPLIT_DIR = 'data/quota-history';
  await fs.mkdir(SPLIT_DIR, { recursive: true });
  let written = 0;
  const dates = Object.keys(history.snapshots);
  for (const code of Object.keys(history.regions)) {
    const snapshots = {};
    for (const date of dates) {
      const day = history.snapshots[date];
      if (day && day[code]) snapshots[date] = { [code]: day[code] };
    }
    const slice = {
      year: history.year,
      lastUpdated: history.lastUpdated,
      regions: { [code]: history.regions[code] },
      snapshots
    };
    const path = `${SPLIT_DIR}/${code}.json`;
    try {
      const prev = JSON.parse(await fs.readFile(path, 'utf8'));
      prev.lastUpdated = slice.lastUpdated; // 비교에서 제외
      if (JSON.stringify(prev) === JSON.stringify(slice)) continue;
    } catch { /* 최초 생성 */ }
    await fs.writeFile(path, JSON.stringify(slice));
    written++;
  }
  console.log(`💾 지역별 슬라이스 ${written}/${Object.keys(history.regions).length}개 갱신 (${SPLIT_DIR}/)`);
}

/**
 * quota.json → 지역별 시그니처 Map<지역명, string>.
 * 한 지역의 모든 행(차종별)을 사용자가 보는 전체 필드(할당·등록·출고·잔여·비고)로 서명.
 * 행 순서 무관하게 정렬 후 결합 → 순서만 바뀐 건 '변경'으로 오탐하지 않음.
 */
function regionSignatures(quotaJson) {
  const sigs = new Map();
  const rows = (quotaJson && quotaJson.data && quotaJson.data[0] && quotaJson.data[0].quotaData) || [];
  const byRegion = new Map();
  for (const r of rows) {
    const name = r.region;
    if (!name) continue;
    if (!byRegion.has(name)) byRegion.set(name, []);
    byRegion.get(name).push(JSON.stringify([
      r.vehicleType,
      r.quota_total, r.quota_priority, r.quota_corporate, r.quota_taxi, r.quota_general,
      r.registered_total, r.registered_priority, r.registered_corporate, r.registered_taxi, r.registered_general,
      r.delivered_total, r.delivered_priority, r.delivered_corporate, r.delivered_taxi, r.delivered_general,
      r.remaining_total, r.remaining_priority, r.remaining_corporate, r.remaining_taxi, r.remaining_general,
      r.note
    ]));
  }
  for (const [name, arr] of byRegion) {
    arr.sort();
    sigs.set(name, arr.join('|'));
  }
  return sigs;
}

/**
 * 이전 quota.json 대비 변경된 지역만 산출 → vw-k 온디맨드 재검증 대상 코드.
 * - 이전에 없던 지역(신규)·시그니처가 달라진 지역만 changed.
 * - nameToCode(donut)로 지역명→코드. 매핑 실패(코드 0/공백)는 제외(fallback revalidate가 커버).
 * - 이전값 없음(최초 실행)이면 전 지역 changed(1회성, 정상).
 */
function computeChangedCodes(oldQuota, newQuota, nameToCode) {
  const oldSigs = regionSignatures(oldQuota);
  const newSigs = regionSignatures(newQuota);
  const changedNames = [];
  for (const [name, sig] of newSigs) {
    if (oldSigs.get(name) !== sig) changedNames.push(name);
  }
  const codes = [];
  const seen = new Set();
  for (const name of changedNames) {
    const code = String(nameToCode[name] || '').replace(/[^0-9]/g, '');
    if (!code) continue;
    if (!seen.has(code)) { seen.add(code); codes.push(code); }
  }
  return { codes, changedNames };
}

/**
 * quota.json → Map<"sido\t지역명", note>. 한 지역의 첫 비어있지 않은 note 사용(note는 지역 단위).
 * 키에 sido 포함: 동명 지역(예: 강원 고성군 / 경남 고성군)을 분리 — 안 하면 한 코드에 다른 note가 섞임.
 */
function regionNotes(quotaJson) {
  const m = new Map();
  const rows = (quotaJson && quotaJson.data && quotaJson.data[0] && quotaJson.data[0].quotaData) || [];
  for (const r of rows) {
    if (!r.region) continue;
    const key = `${r.sido || ''}\t${r.region}`;
    const note = (r.note || '').trim();
    if (!m.has(key)) m.set(key, note);
    else if (!m.get(key) && note) m.set(key, note); // 첫 행이 비었으면 채움
  }
  return m;
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
    console.log('⚠️ 모든 지역 페이지가 동일 → 첫 지역만 스크래핑');

    const firstRegion = regions[0];
    console.log(`[1/1] ${firstRegion.parentName} ${firstRegion.localName}`);

    const result = await scrapeRegionWithRetry(browser, firstRegion);

    if (result.success && result.quotaData.length > 0) {
      console.log(`   ✅ ${result.quotaData.length}개 항목 (전체 161개 지역)`);
    } else if (!result.success) {
      console.log(`   ❌ 실패`);
    } else {
      console.log(`   ⚠️ 데이터 없음`);
    }

    const results = [result];

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
      total_regions: 1,
      success_count: success,
      failed_count: failed,
      data: results
    };

    // [변경감지] 덮어쓰기 전 이전 quota.json 읽기 (git HEAD = 직전 커밋본)
    let previousQuota = null;
    try {
      previousQuota = JSON.parse(await fs.readFile('data/quota.json', 'utf8'));
    } catch { /* 최초 실행 등 → null (전 지역 changed 처리) */ }

    await fs.writeFile(
      'data/quota.json',
      JSON.stringify(outputData, null, 2)
    );

    console.log('💾 data/quota.json 저장 완료');

    // [변경감지] 변경 지역 코드 산출 → data 밖(root)에 기록. 워크플로 웹훅이 읽어 vw-k 재검증.
    // 스크랩 성공+데이터 있을 때만 실제 산출. 실패/빈데이터 → 빈 배열(전지역 오탐/재검증 폭주 방지).
    // 실패해도 스크래핑 결과엔 영향 없음(try/catch 격리).
    try {
      let changedCodes = [];
      let changedNames = [];
      if (result.success && result.quotaData.length > 0) {
        const nameToCode = {};
        for (const r of regions) nameToCode[r.localName] = r.code;
        const diff = computeChangedCodes(previousQuota, outputData, nameToCode);
        changedCodes = diff.codes;
        changedNames = diff.changedNames;
      }
      await fs.writeFile('changed-codes.json', JSON.stringify({
        ts: new Date().toISOString(),
        quotaTs: outputData.timestamp,   // vw-k가 자기 vantage에서 전파 재확인용(신선도 증명)
        count: changedCodes.length,
        codes: changedCodes,
        names: changedNames
      }, null, 2));
      console.log(`🔔 변경 지역 ${changedCodes.length}개${changedNames.length ? ': ' + changedNames.slice(0, 10).join(', ') + (changedNames.length > 10 ? ' …' : '') : ''}`);
    } catch (e) {
      console.error('⚠️ 변경감지 실패(무시):', e.message);
    }

    // [접수안내 이력] 지역별 note 변경 이력 → data/note-history/<code>.json (Pages 배포, 클라 fetch).
    // 지역당 파일: {code, lastUpdated, history:[{date,note}, ...최신순]}. 최근 15건 유지, note 1500자 캡.
    // 불변식: history[0].note(마지막 기록)와 현재 note가 다르고 비어있지 않을 때만 새 엔트리(중복 방지).
    // 해당 년도분만 보관 — 연말/연초에 이전 년도 엔트리는 정리(현재 년도 필터). 과거 복구 불가.
    // 앞으로만 쌓임. 성공+데이터 있을 때만. 실패해도 스크래핑 무영향(격리).
    try {
      if (result.success && result.quotaData.length > 0) {
        // 키 = "parentName(sido)\tlocalName" — regionNotes 키와 동일하게 맞춰 동명 지역 분리
        const pairToCode = {};
        for (const r of regions) pairToCode[`${r.parentName || ''}\t${r.localName}`] = r.code;
        const curYear = new Date(outputData.timestamp).getFullYear();
        const notes = regionNotes(outputData);
        await fs.mkdir('data/note-history', { recursive: true });
        let changed = 0;
        for (const [key, rawNote] of notes) {
          if (!rawNote) continue;
          const code = String(pairToCode[key] || '').replace(/[^0-9]/g, '');
          if (!code) continue;
          const note = rawNote.slice(0, 1500);
          const path = `data/note-history/${code}.json`;
          let history = [];
          try {
            const prev = JSON.parse(await fs.readFile(path, 'utf8'));
            if (Array.isArray(prev.history)) history = prev.history;
          } catch { /* 최초 → 시드 */ }
          // 해당 년도분만 보관 (이전 년도 정리)
          const prevLen = history.length;
          history = history.filter(h => new Date(h.date).getFullYear() === curYear);
          const last = history.length ? history[0].note : null;
          let write = false;
          if (note !== last) {
            history.unshift({ date: outputData.timestamp, note });
            history = history.slice(0, 15);
            write = true;
          } else if (history.length !== prevLen) {
            write = true; // note 동일하지만 이전 년도분 정리됨 → 갱신 저장
          }
          if (write) {
            await fs.writeFile(path, JSON.stringify({
              code,
              lastUpdated: outputData.timestamp,
              history
            }, null, 2));
            changed++;
          }
        }
        console.log(`📝 접수안내 이력: ${changed}개 지역 파일 갱신`);
      }
    } catch (e) {
      console.error('⚠️ 접수안내 이력 실패(무시):', e.message);
    }

    // 일일 스냅샷 히스토리 누적
    if (result.success && result.quotaData.length > 0) {
      console.log('');
      console.log('📊 ===== 히스토리 스냅샷 저장 =====');
      await saveQuotaHistory(result.quotaData, regions);
    }

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
