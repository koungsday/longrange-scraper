/**
 * 초기 quota-history.json 시딩 스크립트
 * 기존 quota.json에서 첫 스냅샷을 생성합니다.
 * 지역 API에서 코드 매핑을 가져와 지역코드를 키로 사용합니다.
 *
 * 사용법: node scripts/seed-history.js
 */
const fs = require('fs').promises;
const axios = require('axios');

async function seedHistory() {
  // 지역 코드 매핑 가져오기
  console.log('지역 목록 로딩...');
  const response = await axios.get('https://api.donut.im/api/v1/regions/list');
  const nameToCode = {};
  const regionMeta = {};

  response.data.regions.forEach(region => {
    if (region.local && Array.isArray(region.local)) {
      region.local.forEach(local => {
        nameToCode[local.name] = String(local.code);
        regionMeta[String(local.code)] = { name: local.name, sido: region.localType };
      });
    }
  });
  console.log(`${Object.keys(nameToCode).length}개 지역 코드 매핑 완료`);

  // 기존 quota.json 읽기
  const raw = await fs.readFile('data/quota.json', 'utf8');
  const data = JSON.parse(raw);
  const quotaData = data.data[0].quotaData;

  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const currentYear = parseInt(today.substring(0, 4));

  // 스냅샷 생성 (지역코드를 키로 사용)
  const todaySnapshot = {};
  let unmapped = 0;
  for (const row of quotaData) {
    const regionName = row.region;
    if (!regionName) continue;

    const code = nameToCode[regionName];
    if (!code) {
      unmapped++;
      continue;
    }

    if (!todaySnapshot[code]) todaySnapshot[code] = {};
    const vehicleType = row.vehicleType || '기타';
    todaySnapshot[code][vehicleType] = {
      total: row.quota_total,
      remaining: row.remaining_total,
      registered: row.registered_total,
      delivered: row.delivered_total
    };
  }

  const history = {
    year: currentYear,
    lastUpdated: now.toISOString(),
    regions: regionMeta,
    snapshots: {
      [today]: todaySnapshot
    }
  };

  await fs.writeFile('data/quota-history.json', JSON.stringify(history, null, 2));

  const size = JSON.stringify(history).length;
  const regionCount = Object.keys(todaySnapshot).length;
  console.log('');
  console.log('quota-history.json 생성 완료');
  console.log('날짜:', today);
  console.log('지역 수:', regionCount);
  if (unmapped > 0) console.log('매핑 실패:', unmapped + '개');
  console.log('파일 크기:', (size / 1024).toFixed(1), 'KB');
}

seedHistory().catch(err => {
  console.error('오류:', err);
  process.exit(1);
});
