# 스냅샷 시스템 통합 가이드 (Phase 4)

> 최종 수정: 2026-02-18
> 상태: Phase 4 — Redis/sync API 제거, GitHub Pages 일원화

---

## 개요

스크래퍼가 `quota-history.json`에 일일 스냅샷을 직접 누적하고,
프론트엔드가 이를 fetch하여 추이를 클라이언트에서 계산합니다.

### 이전 구조 (제거됨)
```
스크래퍼 → quota.json → GitHub Pages
                ↓
GitHub Actions → /api/quota/sync → Redis (quota:daily:*)
                                       ↓
                               /api/quota/trend/[code] → QuotaTrendChart
```

### 현재 구조
```
스크래퍼 → quota.json + quota-history.json → GitHub Pages
                                                    ↓
                                         프론트엔드 fetch → 클라이언트 계산 → 차트 표시
```

---

## GitHub Pages 엔드포인트

| 경로 | 설명 | 갱신 주기 |
|------|------|-----------|
| `quota.json` | 현재 할당량 스냅샷 | 10분마다 |
| `quota-history.json` | 올해 일일 스냅샷 누적 | 10분마다 (당일 엔트리 갱신) |
| `quota-history-{year}.json` | 지난 연도 아카이브 | 연초 1회 |
| `years.json` | 연도 목록 | 1일 1회 |
| `{year}/subsidies.json` | 보조금 데이터 | 1일 1회 |
| `{year}/vehicles.json` | 차량 데이터 | 1일 1회 |

Base URL: `https://koungsday.github.io/longrange-scraper/`

---

## quota-history.json 구조

```json
{
  "year": 2026,
  "lastUpdated": "2026-02-18T09:50:39.190Z",
  "regions": {
    "1100": { "name": "서울특별시", "sido": "서울" },
    "2600": { "name": "부산광역시", "sido": "부산" },
    "2700": { "name": "대구광역시", "sido": "대구" }
  },
  "snapshots": {
    "2026-02-17": {
      "1100": {
        "전기승용": { "total": 10500, "remaining": 9100, "registered": 2200, "delivered": 1400 }
      },
      "2600": {
        "전기승용": { "total": 4126, "remaining": 3600, "registered": 800, "delivered": 526 }
      }
    },
    "2026-02-18": {
      "1100": {
        "전기승용": { "total": 10500, "remaining": 9000, "registered": 2326, "delivered": 1500 }
      },
      "2600": {
        "전기승용": { "total": 4126, "remaining": 3584, "registered": 857, "delivered": 542 }
      }
    }
  }
}
```

### 필드 설명

| 필드 | 설명 |
|------|------|
| `year` | 데이터 연도 (연초에 자동 아카이브 트리거) |
| `regions` | 지역코드 → 이름/시도 매핑 |
| `snapshots[날짜][지역코드][차종].total` | 총 배정량 |
| `snapshots[날짜][지역코드][차종].remaining` | 잔여량 |
| `snapshots[날짜][지역코드][차종].registered` | 접수량 |
| `snapshots[날짜][지역코드][차종].delivered` | 출고량 |

### 데이터 크기

- 1일: ~25KB (160개 지역)
- 90일: ~2.2MB
- 365일: ~4.2MB

---

## 프론트엔드 통합

### 1. 데이터 fetch

```javascript
const SCRAPER_BASE = 'https://koungsday.github.io/longrange-scraper';

async function fetchQuotaHistory() {
  const res = await fetch(`${SCRAPER_BASE}/quota-history.json`);
  return res.json();
}
```

### 2. 지역별 차종 합산

한 지역에 여러 차종이 있을 수 있으므로 합산합니다.

```javascript
function aggregateRegion(regionSnapshot) {
  if (!regionSnapshot) return null;
  return Object.values(regionSnapshot).reduce((acc, v) => ({
    total: acc.total + v.total,
    remaining: acc.remaining + v.remaining,
    registered: acc.registered + v.registered,
    delivered: acc.delivered + v.delivered
  }), { total: 0, remaining: 0, registered: 0, delivered: 0 });
}
```

### 3. 추이 계산

```javascript
function calculateTrend(history, regionCode, days = 7) {
  const dates = Object.keys(history.snapshots).sort().slice(-days);

  const snapshots = dates.map(date => ({
    date,
    ...aggregateRegion(history.snapshots[date][regionCode])
  })).filter(s => s.total > 0);

  if (snapshots.length < 2) return null;

  // 일일 변화량
  const dailyChanges = [];
  for (let i = 1; i < snapshots.length; i++) {
    dailyChanges.push({
      date: snapshots[i].date,
      consumed: snapshots[i - 1].remaining - snapshots[i].remaining,
      newRegistered: snapshots[i].registered - snapshots[i - 1].registered,
      newDelivered: snapshots[i].delivered - snapshots[i - 1].delivered
    });
  }

  // 평균 일일 소진율
  const avgDailyConsumed = dailyChanges.reduce((s, d) => s + d.consumed, 0) / dailyChanges.length;

  // 소진 예측일 (잔여량 / 평균 일일 소진량)
  const latest = snapshots[snapshots.length - 1];
  const predictedDays = avgDailyConsumed > 0
    ? Math.ceil(latest.remaining / avgDailyConsumed)
    : null;

  // 소진율 (%)
  const burnRate = latest.total > 0
    ? ((latest.total - latest.remaining) / latest.total * 100).toFixed(1)
    : 0;

  return {
    regionCode,
    regionName: history.regions[regionCode]?.name,
    snapshots,
    dailyChanges,
    avgDailyConsumed: Math.round(avgDailyConsumed),
    predictedDays,
    burnRate,
    latest
  };
}
```

### 4. 사용 예시

```javascript
const history = await fetchQuotaHistory();

// 서울 (1100) 7일 추이
const seoulTrend = calculateTrend(history, '1100', 7);
console.log(`일일 소진량: ${seoulTrend.avgDailyConsumed}대`);
console.log(`소진율: ${seoulTrend.burnRate}%`);
console.log(`예상 소진일: ${seoulTrend.predictedDays}일 후`);

// 전체 지역 요약
for (const [code, meta] of Object.entries(history.regions)) {
  const trend = calculateTrend(history, code, 7);
  if (trend) {
    console.log(`${meta.name}: 잔여 ${trend.latest.remaining} / ${trend.latest.total}`);
  }
}
```

---

## web repo 제거 대상

Phase 4 적용 시 다음 파일/리소스를 제거합니다.

### API Routes (삭제)
| 파일 | 설명 |
|------|------|
| `/api/quota/sync` | Redis 스냅샷 저장 |
| `/api/quota/trend/[code]` | 추이 분석 API |

### Redis Keys (삭제)
| 키 패턴 | 설명 |
|---------|------|
| `quota:daily:{code}:{date}` | 일일 스냅샷 |
| `quota:trend:v2:{code}` | 추이 캐시 |

### GitHub Actions (삭제)
| 워크플로우 | 설명 |
|-----------|------|
| `update-all-data.yml` | 데이터 동기화 + sync API 호출 |

### 유틸리티 함수 (삭제)
| 함수 | 설명 |
|------|------|
| `syncAllRegionSnapshots()` | 전체 지역 스냅샷 동기화 |
| `saveBulkDailySnapshots()` | Redis 일괄 저장 |
| `getQuotaTrend()` | 서버사이드 추이 계산 |

### 대체 구현 (추가)
| 항목 | 설명 |
|------|------|
| `fetchQuotaHistory()` | GitHub Pages에서 quota-history.json fetch |
| `calculateTrend()` | 클라이언트사이드 추이 계산 |
| QuotaTrendChart 수정 | 새 데이터 소스로 전환 |

---

## 연도 관리

### 자동 아카이브
- 연도가 바뀌면 스크래퍼가 자동으로 현재 `quota-history.json`을 `quota-history-{year}.json`으로 아카이브
- 새 `quota-history.json`은 빈 상태로 시작

### 지난 연도 조회
```javascript
// 2026년 아카이브 데이터
const history2026 = await fetch(`${SCRAPER_BASE}/quota-history-2026.json`).then(r => r.json());
```

---

## 체크리스트

### 스크래퍼 (longrange-scraper) ✅
- [x] `saveQuotaHistory()` 함수 추가
- [x] 지역코드 매핑 (regions 메타데이터)
- [x] 연도 변경 시 자동 아카이브
- [x] 워크플로우에 quota-history*.json 포함
- [x] data/index.html 엔드포인트 추가

### 프론트엔드 (koungs-day-web) 🔲
- [ ] `fetchQuotaHistory()` 유틸리티 추가
- [ ] `calculateTrend()` 클라이언트 계산 로직 추가
- [ ] QuotaTrendChart 컴포넌트를 새 데이터 소스로 전환
- [ ] `/api/quota/sync` 삭제
- [ ] `/api/quota/trend/[code]` 삭제
- [ ] Redis quota 관련 키/코드 정리
- [ ] `update-all-data.yml` 워크플로우 삭제
