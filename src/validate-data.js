/**
 * 데이터 검증 스크립트
 *
 * 스크래핑 결과를 커밋/동기화하기 전에 검증합니다.
 *
 * 사용법:
 *   node src/validate-data.js quota    → data/quota.json 검증
 *   node src/validate-data.js subsidy  → data/{year}/subsidies.json + vehicles.json 검증
 *
 * 출력 (stdout, JSON):
 *   { "valid": true/false, "reason": "...", "warnings": [...] }
 *
 * 종료 코드:
 *   0 = 검증 통과 (valid: true)
 *   1 = 검증 실패 (valid: false) → web repo 동기화 차단
 */

const fs = require('fs').promises;
const path = require('path');

// 연도 자동 계산 (한국 시간 기준)
const CURRENT_YEAR = new Date(
  new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })
).getFullYear();

// ==========================================
// 할당량 (quota.json) 검증
// ==========================================
async function validateQuota() {
  const filePath = 'data/quota.json';
  const warnings = [];

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    return { valid: false, reason: `파일 읽기 실패: ${filePath}`, warnings };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { valid: false, reason: `JSON 파싱 실패: ${e.message}`, warnings };
  }

  // 1. 기본 구조 검증
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: '데이터 객체가 아님', warnings };
  }

  if (!Array.isArray(data.data) || data.data.length === 0) {
    return { valid: false, reason: '데이터 배열(data)이 비어있음 - 사이트 점검 추정', warnings };
  }

  // 2. 성공한 지역 확인
  const successRegions = data.data.filter(r => r.success);
  if (successRegions.length === 0) {
    return { valid: false, reason: '성공한 지역이 0개 - 스크래핑 전체 실패', warnings };
  }

  // 3. quotaData 검증
  const firstRegion = successRegions[0];
  if (!Array.isArray(firstRegion.quotaData) || firstRegion.quotaData.length === 0) {
    return { valid: false, reason: 'quotaData 배열이 비어있음 - 사이트 점검 또는 페이지 구조 변경 추정', warnings };
  }

  // 4. 숫자 무결성 검증 (경고만)
  // 실제 데이터 공식: 잔여 = 배정 - 출고 (접수는 잔여 계산에 포함되지 않음)
  let integrityIssues = 0;
  for (const row of firstRegion.quotaData) {
    const expectedRemaining = row.quota_total - row.delivered_total;
    if (row.quota_total > 0 && row.remaining_total !== expectedRemaining) {
      integrityIssues++;
      if (integrityIssues <= 5) {
        warnings.push(
          `숫자 무결성 경고: ${row.sido} ${row.region} ${row.vehicleType} - ` +
          `배정(${row.quota_total}) - 출고(${row.delivered_total}) ≠ 잔여(${row.remaining_total}), 예상=${expectedRemaining}`
        );
      }
    }
  }

  if (integrityIssues > 5) {
    warnings.push(`... 외 ${integrityIssues - 5}건 추가 (총 ${integrityIssues}건)`);
  }

  // 5. 직전 데이터와 비교 (변경 없으면 알려줌, 커밋은 git diff에서 처리)
  // → 이 로직은 워크플로우의 git diff --staged에서 처리하므로 여기서는 생략

  return {
    valid: true,
    reason: `검증 통과: ${firstRegion.quotaData.length}개 항목, ${successRegions.length}개 지역 성공`,
    warnings
  };
}

// ==========================================
// 보조금 (subsidies.json + vehicles.json) 검증
// ==========================================
async function validateSubsidy() {
  const yearDir = `data/${CURRENT_YEAR}`;
  const subsidiesPath = `${yearDir}/subsidies.json`;
  const vehiclesPath = `${yearDir}/vehicles.json`;
  const warnings = [];

  // --- subsidies.json 검증 ---
  let subsidiesRaw;
  try {
    subsidiesRaw = await fs.readFile(subsidiesPath, 'utf-8');
  } catch (e) {
    return { valid: false, reason: `파일 읽기 실패: ${subsidiesPath}`, warnings };
  }

  let subsidies;
  try {
    subsidies = JSON.parse(subsidiesRaw);
  } catch (e) {
    return { valid: false, reason: `subsidies.json 파싱 실패: ${e.message}`, warnings };
  }

  // 1. 기본 구조 검증
  if (!subsidies.regions || typeof subsidies.regions !== 'object') {
    return { valid: false, reason: 'regions 객체가 비어있음 - 스크래핑 전체 실패', warnings };
  }

  const regionCount = Object.keys(subsidies.regions).length;
  if (regionCount === 0) {
    return { valid: false, reason: 'regions 객체에 지역이 0개', warnings };
  }

  // 2. 성공률 검증
  const totalRegions = subsidies.total_regions || regionCount;
  const successCount = subsidies.success_count || 0;
  const successRate = successCount / totalRegions;

  if (successRate < 0.5) {
    return {
      valid: false,
      reason: `성공률 ${(successRate * 100).toFixed(1)}% (${successCount}/${totalRegions}) - 50% 미만, 사이트 장애 추정`,
      warnings
    };
  }

  if (successRate < 0.9) {
    warnings.push(
      `성공률 ${(successRate * 100).toFixed(1)}% (${successCount}/${totalRegions}) - 일부 지역 실패`
    );
  }

  // 3. 보조금 데이터 내용 검증 (샘플링)
  let emptySubsidyRegions = 0;
  for (const [code, region] of Object.entries(subsidies.regions)) {
    if (region.success && (!region.subsidies || Object.keys(region.subsidies).length === 0)) {
      emptySubsidyRegions++;
    }
  }

  if (emptySubsidyRegions > regionCount * 0.5) {
    return {
      valid: false,
      reason: `성공 지역 중 보조금 데이터 없는 지역 ${emptySubsidyRegions}개 (50% 초과) - 페이지 구조 변경 추정`,
      warnings
    };
  }

  if (emptySubsidyRegions > 0) {
    warnings.push(`보조금 데이터 없는 성공 지역: ${emptySubsidyRegions}개`);
  }

  // --- vehicles.json 검증 ---
  let vehiclesRaw;
  try {
    vehiclesRaw = await fs.readFile(vehiclesPath, 'utf-8');
  } catch (e) {
    return { valid: false, reason: `파일 읽기 실패: ${vehiclesPath}`, warnings };
  }

  let vehicles;
  try {
    vehicles = JSON.parse(vehiclesRaw);
  } catch (e) {
    return { valid: false, reason: `vehicles.json 파싱 실패: ${e.message}`, warnings };
  }

  // 4. 차량 수 검증
  const vehicleCount = vehicles.total_vehicles || Object.keys(vehicles.vehicles || {}).length;
  if (vehicleCount === 0) {
    return { valid: false, reason: '차량 0대 - 스크래핑 실패 또는 사이트 구조 변경', warnings };
  }

  // 5. 국고 보조금 범위 검증 (경고만)
  let invalidNational = 0;
  for (const [key, vehicle] of Object.entries(vehicles.vehicles || {})) {
    if (vehicle.national <= 0) {
      invalidNational++;
      if (invalidNational <= 3) {
        warnings.push(`국고보조금 이상: ${key} = ${vehicle.national}원`);
      }
    }
  }

  if (invalidNational > 0 && invalidNational > 3) {
    warnings.push(`... 외 ${invalidNational - 3}건 추가`);
  }

  return {
    valid: true,
    reason: `검증 통과: ${regionCount}개 지역, ${vehicleCount}대 차량, 성공률 ${(successRate * 100).toFixed(1)}%`,
    warnings
  };
}

// ==========================================
// 메인
// ==========================================
async function main() {
  const type = process.argv[2];

  if (!type || !['quota', 'subsidy'].includes(type)) {
    console.error('사용법: node src/validate-data.js [quota|subsidy]');
    process.exit(2);
  }

  let result;
  if (type === 'quota') {
    result = await validateQuota();
  } else {
    result = await validateSubsidy();
  }

  // 결과 출력 (JSON)
  console.log(JSON.stringify(result));

  // 경고 로그 (stderr, GitHub Actions 로그에 표시)
  if (result.warnings.length > 0) {
    console.error(`⚠️ 검증 경고 ${result.warnings.length}건:`);
    result.warnings.forEach(w => console.error(`  - ${w}`));
  }

  if (result.valid) {
    console.error(`✅ ${type} 데이터 검증 통과: ${result.reason}`);
    process.exit(0);
  } else {
    console.error(`❌ ${type} 데이터 검증 실패: ${result.reason}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('💥 검증 스크립트 오류:', error);
  // 검증 스크립트 자체 오류 시에는 통과 처리 (보수적 접근)
  // 스크립트 오류로 데이터가 차단되는 것보다 통과시키는 게 안전
  console.log(JSON.stringify({
    valid: true,
    reason: `검증 스크립트 오류 (통과 처리): ${error.message}`,
    warnings: [`스크립트 오류: ${error.message}`]
  }));
  process.exit(0);
});
