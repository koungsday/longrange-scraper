# EV Scraper 파이프라인 개선 설계

> 작성일: 2026-02-17
> 최종 수정: 2026-02-18
> 상태: Phase 4 진행 중

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|-----------|
| 02-17 | 초안 작성: 3단계→2단계 파이프라인, 검증 레이어, 적응형 스케줄 |
| 02-18 | Phase 3: GitHub Pages 도입으로 web repo 동기화 완전 제거, cron-job.org 외부 스케줄러 전환 |
| 02-18 | Phase 4: 스냅샷 시스템 통합 — Redis/sync API 제거, quota-history.json으로 추이 데이터 GitHub Pages 서빙 |

---

## 1. 아키텍처 변천사

### Phase 1 (AS-IS, ~02-16)
```
EV.OR.KR → scrape.yml → scraper repo 커밋
         → scrape-quota.yml → scraper repo 커밋
         → sync-data-optimized.yml → web repo 복사 → Vercel 배포 (3분)
```
- 문제: 3단계 파이프라인, 검증 부재, 30분 간격

### Phase 2 (02-17)
```
EV.OR.KR → scrape.yml → 검증 → scraper repo 커밋 → web repo 동기화 → Vercel 배포 (3분)
         → scrape-quota.yml → 검증 → scraper repo 커밋 → web repo 동기화 → Vercel 배포 (3분)
```
- 개선: sync workflow 제거, 검증 레이어 추가, 10분/30분 적응형 스케줄
- 남은 문제: **매 스크래핑마다 Vercel 재배포 (3분 지연)**

### Phase 3 (02-18)
```
EV.OR.KR → scrape.yml → 검증 → scraper repo 커밋 → GitHub Pages (즉시 반영)
         → scrape-quota.yml → 검증 → scraper repo 커밋 → GitHub Pages (즉시 반영)
```
- 개선: **web repo 동기화 완전 제거**, Vercel 재배포 없이 데이터 즉시 서빙
- 스케줄: cron-job.org 외부 트리거 (GitHub Actions cron 불안정 해소)

### Phase 4 (02-18, 현재)
```
EV.OR.KR → scrape-quota.yml → 검증 → quota.json + quota-history.json 커밋 → GitHub Pages
프론트엔드 → quota-history.json fetch → 클라이언트에서 추이 계산 → 차트 표시
```
- 개선: **Redis 스냅샷 + sync API + trend API 완전 제거**
- quota-history.json: 일일 스냅샷 누적 (지역코드별, 1년 단위 관리)
- 프론트엔드에서 직접 소진량/소진예측일 계산 (서버사이드 불필요)
- 연도 변경 시 자동 아카이브 (quota-history-{year}.json)

---

## 2. 현재 아키텍처 (Phase 3)

### 파이프라인 흐름

```
EV.OR.KR (정부 사이트)
  │
  ├─ [cron-job.org: 10분마다 workflow_dispatch 트리거]
  │     └─ scrape-quota.yml
  │           └─ scraper-quota.js → 검증 → scraper repo 커밋 → GitHub Pages 배포
  │
  └─ [GitHub Actions cron: 1일 1회 KST 10:00]
        └─ scrape.yml
              └─ scraper.js → 검증 → scraper repo 커밋 → GitHub Pages 배포

GitHub Pages (데이터 CDN)
  │
  └─ https://koungsday.github.io/longrange-scraper/
        ├─ quota.json
        ├─ years.json
        ├─ 2025/subsidies.json
        ├─ 2025/vehicles.json
        ├─ 2026/subsidies.json
        └─ 2026/vehicles.json

koungs-day-web (Vercel)
  │
  └─ 프론트엔드에서 GitHub Pages URL로 fetch (배포 불필요)
```

### 핵심 변경 사항 (Phase 2 → Phase 3)

| 항목 | Phase 2 | Phase 3 |
|------|---------|---------|
| 데이터 서빙 | web repo `public/data/` (Vercel) | **GitHub Pages** (scraper repo) |
| 스크래핑 후 동작 | web repo에 push → Vercel 재배포 | **GitHub Pages에 직접 배포** |
| 데이터 반영 지연 | ~3분 (Vercel 빌드) | **~30초** (Pages 배포) |
| web repo 커밋 | 매 스크래핑마다 | **없음** |
| Vercel 배포 | 매 스크래핑마다 | **코드 변경 시에만** |
| Quota 스케줄 트리거 | GitHub Actions cron (불안정) | **cron-job.org** (외부, 안정적) |
| 업무시간 로직 | 워크플로우 내 적응형 | **제거** (24시간 균일 10분) |

### 스케줄

| Workflow | 트리거 | 빈도 | 비고 |
|----------|--------|------|------|
| scrape-quota.yml | cron-job.org → workflow_dispatch | 10분마다 (24시간) | 외부 스케줄러 |
| scrape.yml | GitHub Actions cron | 1일 1회 (KST 10:00) | 하루 1회라 안정적 |

### GitHub Pages 설정

- **소스**: GitHub Actions (`actions/deploy-pages@v4`)
- **서빙 경로**: `data/` 폴더 전체
- **URL**: `https://koungsday.github.io/longrange-scraper/`
- **CORS**: GitHub Pages는 기본적으로 CORS 허용 (public repo)

---

## 3. 데이터 검증 레이어

> Phase 2에서 도입, Phase 3에서도 동일하게 유지

### 검증 스크립트: `src/validate-data.js`

```
입력: 스크래핑 결과 JSON
출력: { valid: boolean, reason: string, warnings: [...] }
```

### 할당량 데이터 (quota.json) 검증 규칙

| 규칙 | 조건 | 대응 |
|------|------|------|
| 빈 데이터 차단 | quotaData 배열이 비어있음 | 커밋만, Pages 배포 안 함 |
| 지역 수 검증 | 지역 수가 0 | 커밋만, Pages 배포 안 함 |
| 숫자 무결성 | 잔여 = 배정 - 접수 - 출고 관계 | 경고 로그 (배포는 함) |
| 직전 데이터 비교 | 이전 데이터와 동일 | 커밋 스킵 |

### 보조금 데이터 (subsidies.json) 검증 규칙

| 규칙 | 조건 | 대응 |
|------|------|------|
| 빈 데이터 차단 | regions 객체가 비어있음 | 커밋만, Pages 배포 안 함 |
| 성공률 검증 | success_count < 50% | 커밋만, Pages 배포 안 함 |
| 차량 수 검증 | 차량 0대 | 커밋만, Pages 배포 안 함 |
| 보조금 범위 | 국고보조금이 0 또는 음수 | 경고 로그 |

### 검증 실패 시 동작

```
검증 실패 → scraper repo에는 커밋 (디버깅용 원본 보존)
          → GitHub Pages 배포하지 않음 (프로덕션 보호)
          → GitHub Actions 로그에 경고 출력
```

---

## 4. 롤백 전략

scraper repo가 **데이터 원본(source of truth)**:

```
scraper repo (원본 + 이력)     GitHub Pages (서빙)
  data/quota.json          →   /quota.json
  data/2026/               →   /2026/
```

### 롤백 시나리오

```
문제 발견 시:
  1. scraper repo 이력에서 정상 데이터 확인
  2. workflow_dispatch로 수동 재실행 → Pages에 정상 데이터 재배포
  3. 또는 이전 커밋으로 revert 후 push → 자동으로 Pages 반영
```

---

## 5. 변경 파일 목록

### scraper repo (longrange-scraper)

| 파일 | 작업 | 설명 |
|------|------|------|
| `.github/workflows/scrape-quota.yml` | **수정** | web repo 동기화 제거, GitHub Pages 배포 추가, cron 제거 |
| `.github/workflows/scrape.yml` | **수정** | web repo 동기화 제거, GitHub Pages 배포 추가 |
| `.github/workflows/sync-data-optimized.yml` | **삭제 완료** (Phase 2) | - |
| `src/validate-data.js` | 기존 유지 | - |
| `PIPELINE-REDESIGN.md` | **수정** | Phase 3 반영 |

### web repo (koungs-day-web) — 별도 작업 필요

| 파일 | 작업 | 설명 |
|------|------|------|
| 데이터 fetch URL | **수정** | `/data/` → `https://koungsday.github.io/longrange-scraper/` |
| `public/data/` | **삭제 가능** | 더 이상 이 경로로 데이터 제공하지 않음 |
| `update-all-data.yml` | **검토** | Redis 스냅샷 등 데이터 fetch URL 변경 필요할 수 있음 |

---

## 6. 필요한 GitHub 설정

### scraper repo 설정
1. **Settings → Pages → Source**: "GitHub Actions" 선택
2. cron-job.org에서 10분마다 workflow_dispatch 트리거 설정 완료

---

## 7. 기대 효과

| 항목 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|---------|---------|---------|---------|
| 데이터 반영 지연 | 30분 + 3분 빌드 | 10분 + 3분 빌드 | 10분 + 즉시 | **10분 + 즉시** |
| Vercel 배포 횟수/일 | ~48회 | ~104회 | 코드 변경 시만 | **코드 변경 시만** |
| web repo 커밋/일 | ~48회 | ~104회 | 0회 | **0회** |
| Redis 의존성 | 없음 | 없음 | quota 스냅샷용 | **완전 제거** |
| 추이 계산 위치 | N/A | 서버 (sync API) | 서버 (sync API) | **클라이언트** |
| 워크플로우 파일 | 3개 | 2개 | 2개 | **2개** |
| 검증 | 없음 | 있음 | 있음 | **있음** |
| 외부 의존성 | 없음 | 없음 | cron-job.org | **cron-job.org** |

---

## 8. Phase 4: 스냅샷 시스템 통합

### 개요

기존 3중 파이프라인 (스크래퍼 → sync API → Redis → trend API)을 제거하고,
스크래퍼가 quota-history.json에 직접 누적하여 GitHub Pages로 서빙합니다.

### 기존 구조 (제거 대상)
```
스크래퍼 → quota.json → GitHub Pages
                ↓
GitHub Actions → POST /api/quota/sync → Redis 저장 (quota:daily:{code}:{date})
                                              ↓
                                    GET /api/quota/trend/[code]
                                    → Redis 조회 → 캐시 (quota:trend:v2:{code})
                                              ↓
                                    QuotaTrendChart 표시
```

### 새 구조
```
스크래퍼 → quota.json + quota-history.json → GitHub Pages
                                                    ↓
                                        프론트엔드에서 직접 fetch
                                        → 클라이언트 계산 → 차트 표시
```

### quota-history.json 구조

```json
{
  "year": 2026,
  "lastUpdated": "2026-02-18T09:50:39.190Z",
  "regions": {
    "1100": { "name": "서울특별시", "sido": "서울" },
    "2600": { "name": "부산광역시", "sido": "부산" }
  },
  "snapshots": {
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

| 필드 | 설명 |
|------|------|
| `year` | 현재 연도 (연도 변경 시 아카이브 트리거) |
| `regions` | 지역코드 → 이름/시도 매핑 (프론트엔드 표시용) |
| `snapshots.{날짜}.{지역코드}.{차종}` | 해당 일자의 스냅샷 데이터 |
| `total` | 총 배정량 |
| `remaining` | 잔여량 |
| `registered` | 접수량 |
| `delivered` | 출고량 |

### 데이터 크기

| 기간 | 크기 |
|------|------|
| 1일 (160개 지역) | ~25KB |
| 90일 | ~2.2MB |
| 365일 | ~4.2MB |

### 연도 관리

- **현재 연도**: `quota-history.json` (매 스크래핑 시 오늘 날짜 엔트리 갱신)
- **지난 연도**: `quota-history-{year}.json` (연도 변경 감지 시 자동 아카이브)
- 같은 날 여러 번 실행 시 최신값으로 덮어쓰기 (10분 cron 안전)

### web repo 제거 대상

| 파일/키 | 유형 | 설명 |
|---------|------|------|
| `/api/quota/sync` | API Route | Redis 스냅샷 저장 — **삭제** |
| `/api/quota/trend/[code]` | API Route | 추이 분석 — **삭제** |
| `quota:daily:{code}:{date}` | Redis Key | 일일 스냅샷 — **삭제** |
| `quota:trend:v2:{code}` | Redis Key | 추이 캐시 — **삭제** |
| `update-all-data.yml` | GitHub Actions | sync 워크플로우 — **삭제** |
| `syncAllRegionSnapshots()` | 유틸리티 함수 | — **삭제** |
| `saveBulkDailySnapshots()` | 유틸리티 함수 | — **삭제** |
| `getQuotaTrend()` | 유틸리티 함수 | — **삭제** |

### 프론트엔드 계산 로직

```javascript
// quota-history.json에서 추이 계산
function calculateTrend(history, regionCode, days = 7) {
  const dates = Object.keys(history.snapshots).sort().slice(-days);
  const snapshots = dates.map(d => ({
    date: d,
    ...aggregateRegion(history.snapshots[d][regionCode])
  }));

  // 일일 소진량 계산
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

  // 소진 예측일
  const latest = snapshots[snapshots.length - 1];
  const predictedDays = avgDailyConsumed > 0
    ? Math.ceil(latest.remaining / avgDailyConsumed)
    : null;

  return { snapshots, dailyChanges, avgDailyConsumed, predictedDays };
}

// 지역의 차종별 데이터를 합산
function aggregateRegion(regionData) {
  if (!regionData) return { total: 0, remaining: 0, registered: 0, delivered: 0 };
  return Object.values(regionData).reduce((acc, v) => ({
    total: acc.total + v.total,
    remaining: acc.remaining + v.remaining,
    registered: acc.registered + v.registered,
    delivered: acc.delivered + v.delivered
  }), { total: 0, remaining: 0, registered: 0, delivered: 0 });
}
