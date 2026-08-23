const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs').promises;
const os = require('os');
const { parseQuotaXlsx, readSheets } = require('./parse-quota-xlsx');
const { parseQuotaDetail, diffDetail } = require('./parse-quota-detail');
const { parseNoticeSchedule, diffSchedule, formatAlert } = require('./parse-notice-schedule');
const { buildNoticeLinks } = require('./notice-links');
const { computeChangedCodes, auxChangedCodes, buildKeyToCode,
        countUnmatched, buildCodeToName, mergePending, finalizeCodes } = require('./changed-codes');
const { parseChangeHistory, summarize } = require('./parse-change-history');
const { parseSubsidyXlsx } = require('./parse-subsidy-xlsx');
const { downloadExcel } = require('./ev-excel-download');

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

      const buf = await downloadExcel(page, { timeoutMs: EXCEL_TIMEOUT_MS });
      const quotaData = parseQuotaXlsx(buf);
      // ★부가 필드는 **본체를 죽이면 안 된다.** 실패해도 여기서 삼키고 사유만 남긴다.
      //   (quota 파싱은 위에서 던지는 게 맞다 — 틀린 숫자를 배포하느니 멈추는 게 낫다.)
      let detail = null;
      let schedule = null;
      let changes = null;
      let subsidy = null;
      try {
        const sheets = readSheets(buf);
        detail = parseQuotaDetail(sheets);
        // ★공고별_일정 = 추경 개시 신호. 같은 Excel 이라 추가 요청 0.
        schedule = parseNoticeSchedule(sheets);
        // ★변경이력 = 마감을 앞당긴 적이 있는가. 실측 1,237건 중 앞당김 284 / 연장 136.
        //   신청기간 변경분만 제공된다(안내 시트 명시) — 대수·금액 변경은 여기 없다.
        changes = parseChangeHistory(sheets);
      } catch (e) {
        detail = { available: false, timestamp: new Date().toISOString(),
          missing: [`파서 예외: ${e.message}`], fields: [], regions: {} };
      }
      // ★모델별 보조금 — 예전엔 별도 워크플로가 **같은 Excel 을 또 받아** 하루 1회
      //   만들었다. 파싱만 하면 되므로 여기서 같이 한다(요청 0 추가, 10분마다 최신).
      try { subsidy = parseSubsidyXlsx(buf); } catch (e) {
        console.warn(`   ⚠️ 모델 보조금 파싱 실패(본체엔 영향 없음): ${e.message}`);
      }
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
        detail,
        schedule,
        // ★여기 빠져 있어서 380행의 results.find(r => r.changes) 가 늘 undefined 였다.
        //   섀도잉을 고쳐도 changes 가 null 이라 변경이력 블록은 조용히 건너뛴다.
        changes,
        subsidy,
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
  /* ★키에 시도를 넣는다 — 이름만 쓰면 **동명 지역이 하나로 뭉개진다.**
     실측 피해: 강원 고성군(4282)의 추이가 **171일 내내 0건**이었다. 매 런 last-wins 로
     경남 고성군(4882)이 이겨 강원 값이 4882 자리에 덮어써졌기 때문이다.
     그래서 4282 페이지는 추이 차트도 '예상 마감일' 도 영구 부재였다.
     2026-08-23 changed-codes.js 에서 같은 버그를 고쳤는데 이쪽에 쌍둥이가 남아 있었다.
     시뮬레이션: 구 로직 스냅샷 160코드(4282 없음) → 신 로직 161코드(4282 있음). */
  const nameToCode = {};
  const regionMeta = {};
  for (const r of regions) {
    nameToCode[`${r.parentName || ''}\t${r.localName}`] = String(r.code);
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

    const code = nameToCode[`${row.sido || ''}\t${regionName}`] || regionName;
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

    // ★부가 필드(quota-detail)는 quota.json 안에 넣지 않는다.
    //   quota.json 은 **방문자 브라우저가 직접 받는다**(vw-k RegionSubsidyStatus, 285KB).
    //   여기에 12필드 × 161행을 더하면 방문자 대역폭이 그만큼 늘어난다.
    //   리뉴얼 때 쓸 데이터이므로 옆에 조용히 쌓아 두고, 지금 화면은 아무것도 안 바뀐다.
    const detail = results.find((r) => r && r.detail)?.detail || null;
    const schedule = results.find((r) => r && r.schedule)?.schedule || null;
    const changes = results.find((r) => r && r.changes)?.changes || null;
    const subsidy = results.find((r) => r && r.subsidy)?.subsidy || null;
    for (const r of results) { delete r.detail; delete r.schedule; delete r.changes; delete r.subsidy; }  // quota.json 오염 방지

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

    /* 공고 계열 변경 감지용. ★'덮어쓰기 전 디스크' 를 읽던 방식은 폐기했다 —
       notice-links.json 은 별도 워크플로가 만들어서 우리 체크아웃엔 이미 반영돼 있고,
       그러면 prev ≡ now 라 영원히 안 잡힌다(실측: 60런 재생 기여 0건).
       대신 **마지막으로 통보한 지문**을 파일로 남겨 그것과 비교한다. */
    const AUX_FILES = ['quota-detail', 'notice-schedule', 'notice-links', 'change-history'];
    const AUX_BASELINE = 'data/aux-baseline.json';

    await fs.writeFile(
      'data/quota.json',
      JSON.stringify(outputData, null, 2)
    );

    console.log('💾 data/quota.json 저장 완료');

    // ── 부가 필드 + 변경 이력 (리뉴얼 대비 선수집) ──────────────────────────
    // ★여기서 예외가 나도 quota 수집은 이미 끝났다. 통째로 감싸 본체를 지킨다.
    try {
      if (detail && detail.available) {
        let prevDetail = null;
        try { prevDetail = JSON.parse(await fs.readFile('data/quota-detail.json', 'utf8')); } catch { /* 최초 */ }

        // ★내용이 같으면 쓰지 않는다 — timestamp 만 바뀐 216KB 를 10분마다(하루 144회)
        //   커밋하면 저장소만 부푼다. quota-history 슬라이스가 이미 쓰는 방식이다.
        const sameAsPrev = prevDetail
          && JSON.stringify({ ...prevDetail, timestamp: 0 }) === JSON.stringify({ ...detail, timestamp: 0 });
        const kb = (JSON.stringify(detail).length / 1024).toFixed(0);
        if (sameAsPrev) {
          console.log(`💾 data/quota-detail.json 변화 없음 → 미기록 (${kb}KB 커밋 절약)`);
        } else {
          await fs.writeFile('data/quota-detail.json', JSON.stringify(detail));
          console.log(`💾 data/quota-detail.json 저장 (${detail.regionCount}지역 × ${detail.fields.length}필드, ${kb}KB)`);
        }
        if (detail.missing.length) console.warn(`   ⚠️ 못 찾은 열 ${detail.missing.length}건: ${detail.missing.join(' / ')}`);

        // 변경 이력 — 바뀐 것만. {code, field, before, after} 라 필드가 늘어도 스키마 불변.
        const HP = 'data/quota-detail-history.json';
        const nowKst = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T');
        const year = Number(nowKst.slice(0, 4));
        let hist;
        try { hist = JSON.parse(await fs.readFile(HP, 'utf8')); } catch { hist = { year, lastUpdated: '', changes: [] }; }
        if (hist.year !== year) {                       // 연도 롤오버 — quota-history 와 같은 방식
          await fs.writeFile(`data/quota-detail-history-${hist.year}.json`, JSON.stringify(hist));
          hist = { year, lastUpdated: '', changes: [] };
        }
        // ★이름을 changes 로 두면 안 된다 — 바깥의 '변경이력(Excel)' changes 를 가리고,
        //   아래 변경이력 블록이 이 배열을 보게 된다. 실제로 그래서 20일 가까이
        //   change-history.json 이 한 번도 만들어지지 않았다(배열엔 .missing 이 없어
        //   TypeError → 상위 catch 가 조용히 삼킴 → 워크플로는 계속 초록).
        const detailDiff = diffDetail(prevDetail, detail, nowKst);
        if (detailDiff.length) {
          hist.changes.push(...detailDiff);
          hist.lastUpdated = nowKst;
          await fs.writeFile(HP, JSON.stringify(hist));
          const brief = detailDiff.slice(0, 5).map((c) => `${c.region} ${c.field} ${c.before}→${c.after}`).join(' · ');
          console.log(`📝 변경 ${detailDiff.length}건 기록: ${brief}${detailDiff.length > 5 ? ' …' : ''}`);

          /* ★같은 변경을 **지역별 파일**로도 남긴다 — data/detail-history/{code}.json
             왜: 화면의 "N일째 변동 없음" 이 quota-history(배정·잔여·등록·출고)만 보고 있어
                 접수 안내·마감일이 바뀌어도 몰랐다. 실측 152곳 중 **49곳(32퍼센트)** 이 그 상태였고,
                 성남시는 "52일째 변동 없음" 이라 말하면서 6일 전에 바뀌었다.
                 양주시는 접수 안내와 **마감일까지**(12-11 → 04-27) 8/17 에 바뀌었다.
             ★통짜 quota-detail-history.json(640KB, 3,983건)을 사이트가 읽으면 전국 파일이라
               태그가 전역이 되고 재생성마다 640KB 를 받는다 — 오늘 하루 종일 고친 그 병이다.
               per-region 관행을 따른다(note-history/{code}.json 과 같은 형태).
             ★숫자 필드(selected·selectedRemaining·budgetUsedPct·budgetLeftPct)는 뺀다 —
               3,983건 중 3,699건(93퍼센트)이 그것이고 잔여는 quota-history 가 이미 덮는다.
               넣으면 파일이 숫자 잡음으로 차고 신선도 판정도 그쪽에 지배된다.
             실패해도 스크래핑에 영향 없다(격리). */
          try {
            const KEEP = new Set(['status', 'deadline', 'note', 'applyMethod', 'dept', 'tel', 'noticeKinds', 'noticeCount']);

            /* ★대량 배치는 **파서 아티팩트**다 — 지역별 기록에서 통째로 뺀다.
               실측(2026-08-17T15:41:04): 같은 **초**에 535건, 그중 deadline 이 **161개 지역 전부**.
               72건은 `2026-08-07 → 2026-08-07 18:00` 처럼 **포맷만 추가**된 것이었다.
               161개 지자체가 같은 초에 마감일을 바꿀 수는 없다 — 원본 열이 바뀐 것이다.
               ★이걸 안 거르면 화면이 정반대로 거짓말한다: 아무것도 안 바뀐 지역 119곳이
                 "6일째 변동 없음"(=8/17 에 바뀜)이라고 말하게 된다. 고치려던 병의 반대 방향이다.
               ★통짜(quota-detail-history.json)에는 그대로 남긴다 — 포렌식 기록은 지워선 안 된다.
               ★임계 30: 실측 7일간 KEEP 변경이 있던 84런 중 83런이 **1~4지역**이고,
                 30을 넘은 건 그 아티팩트 런 하나뿐이다. 정상 운영을 막지 않는다. */
            const ARTIFACT_REGIONS = 30;
            const distinctCodes = new Set(detailDiff.filter((c) => KEEP.has(c.field)).map((c) => String(c.code)));
            if (distinctCodes.size > ARTIFACT_REGIONS) {
              console.warn(`   ⚠️ 한 번에 ${distinctCodes.size}개 지역이 바뀌었다 — 파서/원본 열 변경으로 보고 지역별 이력에 기록하지 않는다(통짜에는 남는다)`);
              throw new Error('artifact-batch');   /* 아래 catch 가 받아 조용히 건너뛴다 */
            }

            const byCode = {};
            for (const c of detailDiff) {
              if (!KEEP.has(c.field)) continue;
              const dcode = String(c.code || '').replace(/[^0-9]/g, '');
              if (!dcode) continue;
              (byCode[dcode] ||= []).push({ date: c.date, field: c.field, before: String(c.before ?? '').slice(0, 200), after: String(c.after ?? '').slice(0, 200) });
            }
            if (Object.keys(byCode).length) {
              await fs.mkdir('data/detail-history', { recursive: true });
              for (const [dcode, items] of Object.entries(byCode)) {
                const dpath = `data/detail-history/${dcode}.json`;
                let dhist = [];
                try {
                  const prev = JSON.parse(await fs.readFile(dpath, 'utf8'));
                  if (Array.isArray(prev.history)) dhist = prev.history;
                } catch { /* 최초 */ }
                dhist = dhist.filter((h) => Number(String(h.date).slice(0, 4)) === year);   /* 해당 연도분만 */
                dhist.unshift(...items);                                                    /* 최신이 위로 */
                dhist = dhist.slice(0, 30);
                await fs.writeFile(dpath, JSON.stringify({ code: dcode, lastUpdated: nowKst, history: dhist }));
              }
              console.log(`   \u21b3 지역별 상세 이력 ${Object.keys(byCode).length}곳 기록`);
            }
          } catch (e) {
            console.warn('   ⚠️ 지역별 상세 이력 기록 실패(무시):', e.message);
          }
        } else {
          // ★변경이 0건이어도 **파일은 있어야 한다.** 없으면 위생 다이제스트가
          //   "감시 대상 없음" 으로 조용히 지나가고, 이력 수집이 죽어도 아무도 모른다.
          //   (파일이 없어서 감시가 꺼져 있던 게 2026-08 웹훅 사고의 구조였다.)
          try { await fs.access(HP); } catch { await fs.writeFile(HP, JSON.stringify(hist)); }
          console.log('📝 부가 필드 변경 없음');
        }
      // ── 모델별 보조금 (예전 scrape.yml 이 하던 일) ─────────────────────
      // ★파일이 크다(subsidies 1.2MB · legacy 5MB). 10분마다 그대로 커밋하면
      //   저장소가 분다 → **내용이 같으면 안 쓴다.** 모델 보조금은 거의 안 바뀌므로
      //   평소 커밋은 0이고, 바뀐 날만 기록된다.
      if (subsidy) {
        const yearDir = `data/${subsidy.subsidies.year || new Date().getFullYear()}`;
        await fs.mkdir(yearDir, { recursive: true });
        const files = [
          [`${yearDir}/subsidies.json`, subsidy.subsidies],
          [`${yearDir}/vehicles.json`, subsidy.vehicles],
          [`${yearDir}/subsidies-legacy.json`, subsidy.legacy],
        ];
        let wrote = 0;
        for (const [path, data] of files) {
          let prev = null;
          try { prev = JSON.parse(await fs.readFile(path, 'utf8')); } catch { /* 최초 */ }
          const same = prev
            && JSON.stringify({ ...prev, timestamp: 0 }) === JSON.stringify({ ...data, timestamp: 0 });
          if (same) continue;
          await fs.writeFile(path, JSON.stringify(data, null, 2));
          wrote++;
        }
        console.log(wrote
          ? `💾 모델 보조금 ${wrote}개 파일 갱신 (${subsidy.subsidies.total_regions}지역 · ${subsidy.vehicles.total_vehicles}모델 · 단위 ${subsidy.meta.unitName})`
          : '💾 모델 보조금 변화 없음 → 미기록');
        if (subsidy.meta.nationalConflicts.length) {
          console.warn(`   ⚠️ 국비가 지역마다 다름: ${subsidy.meta.nationalConflicts.join(', ')}`);
        }
      }

      // ── 공고 일정(추경 트리거) ───────────────────────────────────────
      // ★여기서 감지만 하고, 알림 발송은 워크플로가 한다(시크릿을 코드로 안 내린다).
      //   변경이 있으면 data/notice-alert.json 을 남기고 워크플로가 그걸 보고 쏜다.
      if (schedule) {
        const SP = 'data/notice-schedule.json';
        let prevSch = null;
        try { prevSch = JSON.parse(await fs.readFile(SP, 'utf8')); } catch { /* 최초 */ }

      if (!schedule.available) {
        // ★실패해도 **실패 사실을 남긴다.**
        //   예전엔 실패 시 아무것도 안 썼다. 그러면 지난번 정상 파일이 그대로 남아
        //   위생 감시가 available:true / count:327 을 읽고 "정상" 으로 판정한다.
        //   감시를 붙여도 무력화되는 구조였다.
        // ★items 는 지운다 — 지워야 다음 diff 기준선이 유지되어, 복구했을 때
        //   깨져 있던 동안 놓친 변경을 그 시점에 한 번에 알려줄 수 있다.
        // ★단 **상태가 바뀔 때만** 쓴다. 매 런 failedAt 만 갱신해 커밋하면
        //   10분마다 59KB 헛 커밋이 된다(이 저장소가 부푼 것과 같은 함정).
        console.warn(`⚠️ 공고 일정 수집 실패 — ${schedule.missing.join(' / ')}`);
        if (!prevSch || prevSch.available !== false) {
          await fs.writeFile(SP, JSON.stringify({
            ...(prevSch || {}),
            available: false,
            missing: schedule.missing,
            failedAt: new Date().toISOString(),   // 언제부터 깨졌는지
          }));
        }
      } else {
        const d = diffSchedule(prevSch, schedule);

        // ★최초 실행은 알리지 않는다 — 327건 전부가 '신규' 로 잡혀 카톡이 폭발한다.
        if (!prevSch) {
          console.log(`🗓 공고 일정 최초 수집 ${schedule.count}건 (알림 생략)`);
        } else if (d.total) {
          console.log(`🗓 공고 일정 변경 ${d.total}건 (신규 ${d.added.length} / 변경 ${d.changed.length} / 삭제 ${d.removed.length})`);
          for (const a of d.added.slice(0, 5)) console.log(`   🆕 ${a.region} ${a.kind} — 접수 ${a.start || '?'}`);
          for (const c of d.changed.slice(0, 5)) console.log(`   🔄 ${c.region} ${c.kind} — ${c.fields.join(',')}`);
          await fs.writeFile('data/notice-alert.json', JSON.stringify({
            ts: new Date().toISOString(),
            added: d.added.length, changed: d.changed.length, removed: d.removed.length,
            text: formatAlert(d),
          }));

          /* ── 새 공고 지역만 첨부 즉시 재훑기 ───────────────────────────
             ★공고가 새로 뜨면 **첨부도 같이 올라온다.** 그런데 첨부 목록은
               별도 워크플로(notice-links.yml)가 타이머로 만들고 있었다 —
               평소엔 '이미 아는 칸' 만 두드리므로(388회 ≈ 3분) 지역이 **새 칸에**
               파일을 올리면 다음 전수 훑기(1,771회 ≈ 20분, 4시간마다) 전엔 안 보인다.
               2026-08-21 함평군 실측: 환경부엔 A(1차)·A02(추경1차) 두 건인데 우리는 A 하나.
               같은 날 추경1차 공고는 10분 만에 잡혔는데 첨부만 최대 4시간 뒤처졌다.

             ★타이머를 더 조이는 대신 **트리거를 쓴다.** 새 첨부가 생기는 순간은
               곧 새 공고가 뜨는 순간이고, 그건 바로 위 diffSchedule 이 10분마다
               이미 알고 있다. 모르는 것을 주기적으로 뒤지는 대신, 아는 순간에 본다.

             ★그 지역만 전수(11칸)다 — 새 칸을 찾아야 하므로 known 최적화를 쓰지 않는다.
               보통 1~3곳이라 11~33회, 몇 초. 161곳 전수(20분)와는 차원이 다르다.

             ★prev 를 넘긴다. HEAD 가 한 번 실패했다고 멀쩡한 첨부를 지우면 안 된다
               (notice-links.js 가 prev 에서 이전 값을 복구한다).

             ★여기서 쓰면 커밋·Pages 발행·웹훅이 **같은 런 안에서** 이어진다 —
               새 공고와 그 첨부가 한 묶음으로 화면에 뜬다. */
          try {
            const hot = [...new Set([...d.added, ...d.changed]
              .map((x) => String(x.code || '').replace(/[^0-9]/g, '')).filter(Boolean))];
            /* ★상한. hot 은 지역코드로 dedup 되므로 최대 161 이고, 161×11=1,771회 ≈ 20분이다 —
               별도 워크플로를 30분 주기로 뗀 바로 그 작업 전체다. 이 런은 cancel-in-progress 라
               20분을 쓰면 **다음 10분 런이 이번 런을 취소**하고, 커밋 스텝에 always() 가 없어
               quota.json 이 커밋도 Pages 발행도 안 된다. 기준선(notice-schedule)도 안 밀리니
               다음 런이 같은 diff 를 또 보고 같은 20분을 쓴다 — 자기 재생성 루프.
               연 1회 관리번호 체계가 갱신되면 전 항목이 added 로 잡혀 확정적으로 터진다.
               넘치면 앞의 12곳만 즉시 보고 나머지는 정기 전수(하루 6회)에 맡긴다. */
            const CAP = 12;
            if (hot.length > CAP) {
              console.warn(`📎 새 공고 ${hot.length}곳 — 상한 ${CAP}곳만 즉시 훑는다(나머지는 정기 전수가 맡는다)`);
              hot.length = CAP;
            }
            const LP = 'data/notice-links.json';
            let links = null;
            try { links = JSON.parse(await fs.readFile(LP, 'utf8')); } catch { /* 아직 없음 */ }
            if (hot.length && links?.regions) {
              const targets = regions.filter((r) => hot.includes(String(r.code)));
              /* ★90초 예산. peek() 의 fetch 에는 타임아웃이 없어(AbortSignal 없음) 환경부가
                 응답을 안 주면 워커가 OS TCP 타임아웃까지 매달린다. 격리된 25분 워크플로에선
                 감당됐지만 여기는 10분 취소 창의 크리티컬 패스다. 예산을 넘기면 버린다. */
              const fresh = await Promise.race([
                buildNoticeLinks(targets, { probe: true, prev: links.regions }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('재훑기 90초 초과')), 90000)),
              ]);
              let hit = 0, shrank = 0;
              for (const c of hot) {
                const got = fresh.regions[c];
                /* ★못 찾았다고 지우지 않는다. peek() 는 403·404·429 를 `{ok:true,name:null}`
                   = "확인했고 첨부 없음" 으로 돌려준다(!res.ok 분기). prev 복구는 **네트워크
                   예외에만** 걸리므로, 환경부가 차단하거나 점검 페이지를 200 으로 내보내면
                   멀쩡한 지역이 통째로 삭제되고 그대로 커밋된다(적대적 검증에서 오프라인 실증).
                   이 블록의 일은 '새 첨부를 빨리 찾는 것' 뿐이다 — 지우는 일은 정기 스캔에 맡긴다. */
                if (!got) continue;
                const before = links.regions[c]?.files || [];
                if (got.files.length < before.length) { shrank++; continue; }   /* 줄어드는 변화는 무시 */
                /* ★개수가 아니라 **내용**으로 비교한다. 개수만 보면 추경 교체(A 내려가고 A02 올라옴,
                   1→1)와 정정 공고(같은 칸 파일명 교체)를 놓친다 — 이 기능이 겨냥한 바로 그 경우다. */
                if (JSON.stringify(before) === JSON.stringify(got.files)) continue;
                links.regions[c] = got;
                hit++;
              }
              if (hit) {
                links.timestamp = new Date().toISOString();
                links.regionCount = Object.keys(links.regions).length;
                links.fileCount = Object.values(links.regions).reduce((n, v) => n + v.files.length, 0);
                /* byExt 합계 = fileCount 는 이 파일의 불변식이다. 병합하고 갱신을 빠뜨리면 깨진다. */
                links.byExt = {};
                for (const v of Object.values(links.regions)) for (const f of v.files) links.byExt[f.ext] = (links.byExt[f.ext] || 0) + 1;
                await fs.writeFile(LP, JSON.stringify(links));
                console.log(`📎 새 공고 ${hot.length}곳 첨부 재훑기 — ${hit}곳 갱신 → 총 ${links.fileCount}건${shrank ? ` (줄어든 ${shrank}곳은 보류)` : ''}`);
              } else {
                console.log(`📎 새 공고 ${hot.length}곳 첨부 재훑기 — 변화 없음${shrank ? ` (줄어든 ${shrank}곳은 보류)` : ''}`);
              }
            }
          } catch (e) {
            /* 첨부는 부가 정보다. 실패해도 잔여대수 수집을 죽이지 않는다 —
               4시간 전수 훑기가 안전망으로 남아 있다. */
            console.warn('⚠️ 첨부 재훑기 실패(무시):', e.message);
          }
        } else {
          console.log('🗓 공고 일정 변경 없음');
        }

        // ── 자체 변경이력 ─────────────────────────────────────────────
        //   왜 또 만드나 — 환경부 Excel 의 「변경이력」 시트는 언제든 빠질 수 있다.
        //   2026-08-16 개편 때 표가 통째로 사라진 전례가 있다. 그때가 오면 이 로그만 남는다.
        //   우리는 이미 10분마다 공고 일정을 받고 diff 까지 내고 있다 — 버리지 않고 쌓기만 한다.
        //   Excel 과 **같은 스키마**로 적어서 화면이 출처를 갈아끼워도 그대로 읽게 한다.
        if (d.changed.length && prevSch) {
          const LP = 'data/change-history-self.json';
          let log = null;
          try { log = JSON.parse(await fs.readFile(LP, 'utf8')); } catch { /* 최초 */ }
          // ★nowKst 는 위 detail 블록 안에서 선언된다 — 여기선 스코프 밖이라 직접 만든다.
          //   (같은 함정으로 변경이력 수집이 20일 죽어 있었다.)
          const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
          if (!log || !log.regions) log = { available: true, since: stamp, count: 0, regions: {} };
          const FN = { posted: '게시일', start: '접수시작', end: '접수마감', name: '공고명' };
          for (const c of d.changed) {
            if (!c.code) continue;
            const R = (log.regions[c.code] ||= { region: c.region || '', items: [] });
            for (const f of c.fields) {
              // 최신이 위로 — Excel 파서와 정렬 방향을 맞춘다
              R.items.unshift({
                when: stamp,
                item: `${c.kind || ''} ${FN[f] || f}`.trim(),
                before: String(c.before[f] ?? ''),
                after: String(c[f] ?? ''),
              });
            }
            // 한 지역이 무한히 자라지 않게. 300건이면 몇 년 치다.
            if (R.items.length > 300) R.items.length = 300;
          }
          for (const v of Object.values(log.regions)) v.summary = summarize(v.items);
          log.count = Object.values(log.regions).reduce((a, v) => a + v.items.length, 0);
          log.timestamp = new Date().toISOString();
          await fs.writeFile(LP, JSON.stringify(log));
          const early = Object.values(log.regions).reduce((a, v) => a + v.summary.earlier, 0);
          console.log(`🗒 자체 변경이력 +${d.changed.length}건 → 누적 ${log.count}건 (마감 앞당김 ${early}회)`);
        }
        // 내용이 같으면 안 쓴다(10분마다 35KB 헛 커밋 방지)
        const schSame = prevSch
          && JSON.stringify({ ...prevSch, timestamp: 0 }) === JSON.stringify({ ...schedule, timestamp: 0 });
        if (!schSame) await fs.writeFile(SP, JSON.stringify(schedule));
      }
      }

      // ── 변경이력(마감 앞당김 신호) ────────────────────────────────
      //   내용이 같으면 안 쓴다(129KB 를 10분마다 커밋하지 않는다).
      //   실패해도 실패 사실은 남긴다 — 공고 일정과 같은 처방.
      if (changes) {
        const CP = 'data/change-history.json';
        let prevCh = null;
        try { prevCh = JSON.parse(await fs.readFile(CP, 'utf8')); } catch { /* 최초 */ }
        if (!changes.available) {
          console.warn(`⚠️ 변경이력 수집 실패 — ${changes.missing.join(' / ')}`);
          if (!prevCh || prevCh.available !== false) {
            await fs.writeFile(CP, JSON.stringify({
              ...(prevCh || {}), available: false, missing: changes.missing,
              failedAt: new Date().toISOString(),
            }));
          }
        } else {
          const chSame = prevCh
            && JSON.stringify({ ...prevCh, timestamp: 0 }) === JSON.stringify({ ...changes, timestamp: 0 });
          if (chSame) {
            console.log('📜 변경이력 변화 없음 → 미기록');
          } else {
            const earlier = Object.values(changes.regions).reduce((a, v) => a + v.summary.earlier, 0);
            await fs.writeFile(CP, JSON.stringify(changes));
            console.log(`📜 변경이력 ${changes.count}건 · ${Object.keys(changes.regions).length}지역 (마감 앞당김 누적 ${earlier}회) 저장`);
          }
        }
      }

      } else {
        console.warn(`⚠️ 부가 필드 수집 실패 — ${detail ? detail.missing.join(' / ') : 'detail 없음'}`);
        // 실패해도 파일은 남긴다. 안 보이는 실패를 만들지 않기 위해서다(위생 다이제스트가 읽는다).
        await fs.writeFile('data/quota-detail.json', JSON.stringify(detail || {
          available: false, timestamp: new Date().toISOString(), missing: ['수집 결과 없음'], fields: [], regions: {},
        }));
      }
    } catch (e) {
      // 여기서 삼킨 TypeError 하나가 변경이력 수집을 20일 동안 죽여 놨다. 스택을 남긴다.
      console.error('⚠️ 부가 필드 단계 오류(본체엔 영향 없음):', e.message);
      console.error(e.stack);
    }

    // [변경감지] 변경 지역 코드 산출 → data 밖(root)에 기록. 워크플로 웹훅이 읽어 vw-k 재검증.
    // 스크랩 성공+데이터 있을 때만 실제 산출. 실패/빈데이터 → 빈 배열(전지역 오탐/재검증 폭주 방지).
    // 실패해도 스크래핑 결과엔 영향 없음(try/catch 격리).
    try {
      let changedCodes = [];
      let changedNames = [];
      let capped = 0;                    /* 상한 초과로 통보를 포기한 공고 계열 지역 수 */
      let unmatched = 0;                 /* 지역 키 매칭 실패 수 — 0 이 아니면 통보가 죽고 있다 */
      if (result.success && result.quotaData.length > 0) {
        /* ★키의 좌변(donut localType)과 우변(환경부 Excel '시도' 열)이 **서로 다른 출처**다.
           지금은 161/161 일치하지만, 실제 행정명은 이미 강원특별자치도·전북특별자치도라
           donut 이 표기를 바꾸는 날 매칭이 전멸하고 **codes 가 영구히 0곳**이 된다.
           그때 테스트도 워크플로도 webhook-status 도 전부 초록이다(조용한 실패).
           → 매칭 실패 수를 세서 로그와 changed-codes.json 에 남긴다. */
        const keyToCode = buildKeyToCode(regions);
        /* ★좌변(donut localType)과 우변(환경부 Excel '시도' 열)은 **서로 다른 출처**다.
           지금은 161/161 일치하지만 donut 이 표기를 바꾸는 날(실제 행정명은 이미
           강원특별자치도·전북특별자치도다) 매칭이 전멸하고 codes 가 영구 0 이 된다.
           그때 테스트도 워크플로도 전부 초록이므로, 매칭 실패 수를 세서 신호로 남긴다. */
        const um = countUnmatched(outputData, keyToCode);
        unmatched = um.unmatched;
        if (unmatched) console.warn(`⚠️ 지역 키 매칭 실패 ${unmatched}/${um.total} — donut 과 환경부 시도 표기가 갈라졌을 수 있다(변경 통보가 죽는다)`);
        const diff = computeChangedCodes(previousQuota, outputData, keyToCode);
        changedCodes = diff.codes;
        changedNames = diff.changedNames;
      }

      /* ★공고 계열 변경을 합친다 — **저장된 기준선**과 비교한다(디스크 전/후가 아니라).
         notice-links.json 은 별도 워크플로가 만들어서, quota 런이 체크아웃할 땐 이미
         prev 에 들어와 있다. 전/후 비교로는 영원히 안 잡힌다(실측: 60런 재생, 기여 0건). */
      try {
        const nowAux = {};
        for (const f of AUX_FILES) {
          try { nowAux[f] = JSON.parse(await fs.readFile(`data/${f}.json`, 'utf8')); } catch { nowAux[f] = null; }
        }
        let baseline = null;
        try { baseline = JSON.parse(await fs.readFile(AUX_BASELINE, 'utf8')).regions; } catch { /* 최초 */ }
        const { codes: rawExtra, fingerprint } = auxChangedCodes(baseline, nowAux);

        /* ★지난 런에서 통보 못 한 코드를 먼저 합친다(POST 실패분). 24시간 넘으면 버린다. */
        let pending = null;
        try { pending = JSON.parse(await fs.readFile('data/pending-codes.json', 'utf8')); } catch { /* 없음 */ }
        const mp = mergePending(changedCodes, pending);
        if (mp.added) console.log(`   ↳ 지난 런 미통보 ${mp.added}곳 이월 합침`);
        if (mp.expired) console.warn(`   ↳ 이월분 ${mp.expired}곳이 24시간을 넘겨 폐기 (TTL 이 이미 덮었다)`);

        /* ★상한 둘을 한 곳에서 적용한다 — 판단은 전부 changed-codes.js 의 순수 함수가 한다.
           여기(scraper-quota.js)에는 파일 읽기·쓰기만 남긴다. 그래야 테스트가 태울 수 있다. */
        const fin = finalizeCodes(mp.codes, changedNames, rawExtra, buildCodeToName(regions));
        if (fin.capped) {
          console.warn(`⚠️ 변경이 ${fin.capped}곳 — 상한 초과라 통보하지 않는다(스키마 변경·수집 이상 의심). 기준선만 갱신.`);
        } else if (fin.codes.length > changedCodes.length) {
          const added = fin.codes.filter((c) => !changedCodes.includes(c));
          console.log(`   ↳ 공고 계열·이월 ${added.length}곳 추가: ${added.slice(0, 10).join(', ')}${added.length > 10 ? ' …' : ''}`);
        }
        changedCodes = fin.codes;
        changedNames = fin.names;
        capped = fin.capped;

        /* 기준선은 통보 여부와 무관하게 갱신한다 — 안 하면 같은 변경을 매 런 다시 통보한다.
           ★내용이 같으면 쓰지 않는다(ts 만 바뀐 313KB 를 매 런 커밋하면 저장소가 분다 —
             이 저장소가 이미 다섯 번 대응한 함정이다). */
        if (Object.keys(fingerprint).length) {
          const next = JSON.stringify(fingerprint);
          let prevSig = null;
          try { prevSig = JSON.stringify(JSON.parse(await fs.readFile(AUX_BASELINE, 'utf8')).regions); } catch { /* 최초 */ }
          if (prevSig !== next) {
            await fs.writeFile(AUX_BASELINE, JSON.stringify({ ts: new Date().toISOString(), regions: fingerprint }));
          }
        }
      } catch (e) {
        console.warn('⚠️ 공고 계열 변경감지 실패(무시):', e.message);
      }

      await fs.writeFile('changed-codes.json', JSON.stringify({
        ts: new Date().toISOString(),
        capped,                          // >0 이면 상한 초과로 **통보를 포기한 지역 수** (조용한 손실 감시용)
        unmatched,                       // >0 이면 지역 키 매칭이 깨졌다 — 변경 통보가 죽는다
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

/* ★직접 실행일 때만 돈다. 이 가드가 없으면 테스트가 require 하는 순간 스크래핑이 시작된다.
   워크플로는 `node src/scraper-quota.js` 로 부르므로 동작은 그대로다. */
if (require.main === module) {
  main().catch(error => {
    console.error('💥 예상치 못한 오류:', error);
    process.exit(1);
  });
}

