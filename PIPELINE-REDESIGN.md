# EV Scraper 파이프라인 개선 설계

> 작성일: 2026-02-17
> 상태: 구현 중 (2026-02-17 검토 완료)
>
> ### 검토 결과 반영사항
> - `/api/quota/sync` (Redis 스냅샷) 호출은 scraper에서 제거 → web repo의 `update-all-data.yml`이 담당 유지
> - 이유: Vercel 배포 완료 전 API 호출 시 구 데이터가 스냅샷에 저장되는 타이밍 문제
> - web repo의 `update-all-data.yml`은 변경 없음 (Bond sync, Kakao token, Redis snapshot 모두 유지)

---

## 1. 현재 상태 (AS-IS)

### 파이프라인 흐름

```
EV.OR.KR
  │
  ├─ scrape.yml (보조금, 1일 1회)
  │     └─ scraper.js → data/ 커밋 → scraper repo push
  │
  ├─ scrape-quota.yml (할당량, 30분 1회)
  │     └─ scraper-quota.js → data/ 커밋 → scraper repo push
  │
  └─ sync-data-optimized.yml (위 2개 완료 시 자동 트리거)
        └─ scraper repo → web repo 복사 → 변경 감지 → 조건부 커밋 → Vercel 배포
```

### 현재 스케줄

| Workflow | Cron | 빈도 | 비고 |
|----------|------|------|------|
| scrape.yml | `0 1 * * *` | 1일 1회 (KST 10:00) | 161개 지역, ~5분 소요 |
| scrape-quota.yml | `*/30 * * * *` | 30분 1회 | 1개 지역만, ~30초 소요 |
| sync-data-optimized.yml | workflow_run | ~25회/일 | 변경 시에만 커밋 |

### 현재 문제점

- **3단계 파이프라인**: 스크래핑 → scraper repo 커밋 → sync workflow → web repo 커밋 (불필요하게 긴 경로)
- **30분 간격**: 할당량 데이터 갱신이 느림
- **검증 부재**: 빈 데이터, 비정상 데이터가 그대로 커밋됨
- **롤백 전략 부재**: 문제 발생 시 수동 대응 필요

---

## 2. 목표 상태 (TO-BE)

### 파이프라인 흐름

```
EV.OR.KR
  │
  ├─ scrape.yml (보조금, 1일 1회)
  │     └─ scraper.js → 검증 → scraper repo 커밋 → web repo 동기화
  │
  └─ scrape-quota.yml (할당량, 10분/30분 적응형)
        └─ scraper-quota.js → 검증 → scraper repo 커밋 → web repo 동기화
```

### 핵심 변경 사항

| 항목 | AS-IS | TO-BE |
|------|-------|-------|
| Workflow 수 | 3개 | **2개** (sync 워크플로우 제거) |
| Quota 주기 (업무시간) | 30분 | **10분** |
| Quota 주기 (업무외) | 30분 | **30분** |
| 데이터 검증 | 없음 | **커밋 전 검증** |
| 롤백 전략 | 없음 | **scraper repo 원본 보존 + 검증 게이트** |

---

## 3. 상세 설계

### 3-1. 파이프라인 1단계 축소

**sync-data-optimized.yml 제거**, 동기화 로직을 각 스크래퍼 워크플로우에 통합.

#### 변경 전 (3단계)
```
스크래핑 → scraper repo 커밋 → [sync workflow 트리거 대기] → web repo 커밋
```

#### 변경 후 (2단계)
```
스크래핑 → 검증 → scraper repo 커밋 → web repo 직접 동기화
```

#### 각 스크래퍼 워크플로우에 추가되는 동기화 단계

현재 `sync-data-optimized.yml`이 수행하는 모든 역할을 각 스크래퍼가 직접 수행:

| 현재 sync workflow 역할 | 통합 후 담당 |
|------------------------|-------------|
| quota.json 복사 | `scrape-quota.yml` |
| years.json 복사 | `scrape.yml` |
| 연도별 vehicles.json 복사 | `scrape.yml` |
| 연도별 subsidies.json 복사 | `scrape.yml` |
| 변경 감지 (git diff) | 양쪽 모두 |
| 조건부 커밋 & push (web repo) | 양쪽 모두 |
| Redis 일별 스냅샷 (/api/quota/sync) | web repo `update-all-data.yml` (기존 유지) |

##### scrape-quota.yml에 추가되는 단계

```yaml
# 기존: 스크래핑 → scraper repo 커밋
# 추가:
- name: Checkout koungs-day-web
  uses: actions/checkout@v4
  with:
    repository: koungsday/koungs-day-web
    token: ${{ secrets.PAT_TOKEN }}
    path: web

- name: Sync quota data to web repo
  if: steps.validate.outputs.valid == 'true'
  run: |
    cp data/quota.json web/public/data/quota.json
    cd web
    if ! git diff --quiet public/data/quota.json; then
      git add public/data/quota.json
      git commit -m "chore: Auto-update quota data ..."
      git push
    fi

```

> **참고**: Redis 일별 스냅샷 저장(`/api/quota/sync`)은 web repo의 `update-all-data.yml`이 매시간 수행하므로,
> scraper에서는 호출하지 않음 (Vercel 배포 타이밍 문제 방지).

##### scrape.yml에 추가되는 단계

```yaml
# 기존: 스크래핑 → scraper repo 커밋
# 추가:
- name: Checkout koungs-day-web
  uses: actions/checkout@v4
  with:
    repository: koungsday/koungs-day-web
    token: ${{ secrets.PAT_TOKEN }}
    path: web

- name: Sync subsidy data to web repo
  if: steps.validate.outputs.valid == 'true'
  run: |
    cp data/years.json web/public/data/
    for year_dir in data/20*/; do
      year=$(basename "$year_dir")
      mkdir -p "web/public/data/$year"
      cp "$year_dir"vehicles.json "web/public/data/$year/"
      cp "$year_dir"subsidies.json "web/public/data/$year/"
    done
    cd web
    if ! git diff --quiet public/data/; then
      git add public/data/
      git commit -m "chore: Auto-update subsidy data ..."
      git push
    fi
```

> **핵심**: 각 스크래퍼가 자기 데이터만 web repo에 반영하므로, 현재 sync workflow의 "전체 복사" 방식보다 책임이 명확하고, 불필요한 파일 복사가 줄어듦.

#### 동시 push 충돌 방지

- 보조금 스크래퍼: 1일 1회 (KST 10:00) → 충돌 확률 극히 낮음
- 할당량 스크래퍼: 10분 간격 → 보조금 스크래퍼와 겹칠 경우 기존 retry + rebase 로직으로 해결
- concurrency group을 `sync-web-data`로 통일하여 동시 실행 자체를 방지

```yaml
concurrency:
  group: sync-web-data
  cancel-in-progress: false  # 대기 후 실행
```

### 3-2. 스케줄 변경 (10분 / 30분 적응형)

#### 방식: 단일 cron + 업무시간 판별

```yaml
# scrape-quota.yml
on:
  schedule:
    - cron: '*/10 * * * *'  # 10분마다 실행
  workflow_dispatch:
```

워크플로우 내부에서 KST 시간을 확인하여 업무외 시간이면 스킵:

```yaml
- name: Check business hours (KST)
  id: timecheck
  run: |
    KST_HOUR=$(TZ=Asia/Seoul date +%H)
    KST_HOUR_INT=$((10#$KST_HOUR))
    # 업무시간: KST 08:00 ~ 22:00
    if [ $KST_HOUR_INT -ge 8 ] && [ $KST_HOUR_INT -lt 22 ]; then
      echo "is_business_hours=true" >> $GITHUB_OUTPUT
    else
      # 업무외 시간: 매 30분(x:00, x:30)만 실행
      KST_MIN=$(TZ=Asia/Seoul date +%M)
      KST_MIN_INT=$((10#$KST_MIN))
      if [ $KST_MIN_INT -lt 10 ]; then
        echo "is_business_hours=true" >> $GITHUB_OUTPUT
      else
        echo "is_business_hours=false" >> $GITHUB_OUTPUT
        echo "⏭️ Off-hours: skipping (next run at x:00 or x:30)"
      fi
    fi
```

#### 결과 스케줄

| 시간대 (KST) | 간격 | 일 실행 횟수 | 비고 |
|--------------|------|-------------|------|
| 08:00 ~ 22:00 | 10분 | 84회 | 업무시간 (실질적 데이터 변동 구간) |
| 22:00 ~ 08:00 | 30분 | 20회 | 심야 (변동 적음) |
| **합계** | - | **~104회/일** | 현재 48회 대비 약 2배 |

#### GitHub Actions 사용량 영향

```
현재:   48회 × 0.5분 = 24분/일 = 720분/월
변경후: 104회 × 0.5분 = 52분/일 = 1,560분/월
무료 한도: 2,000분/월 (private repo) / 무제한 (public repo)
```

→ Private repo여도 한도 내. Public repo면 제한 없음.

### 3-3. 데이터 검증 레이어

스크래핑 결과를 커밋하기 전에 검증하는 단계 추가.

#### 검증 스크립트: `src/validate-data.js`

```
입력: 스크래핑 결과 JSON
출력: { valid: boolean, reason: string }
```

#### 할당량 데이터 (quota.json) 검증 규칙

| 규칙 | 조건 | 대응 |
|------|------|------|
| 빈 데이터 차단 | quotaData 배열이 비어있음 | 커밋 안 함 (사이트 점검 추정) |
| 지역 수 검증 | 지역 수가 갑자기 0이 됨 | 커밋 안 함 |
| 숫자 무결성 | 잔여 = 배정 - 접수 - 출고 관계 성립 여부 | 경고 로그 (커밋은 함) |
| 직전 데이터 비교 | 이전 quota.json과 완전 동일 | 커밋 스킵 (변경 없음) |

#### 보조금 데이터 (subsidies.json) 검증 규칙

| 규칙 | 조건 | 대응 |
|------|------|------|
| 빈 데이터 차단 | regions 객체가 비어있음 | 커밋 안 함 |
| 성공률 검증 | success_count가 전체의 50% 미만 | 커밋 안 함 (사이트 장애 추정) |
| 차량 수 검증 | 차량 0대 | 커밋 안 함 |
| 보조금 범위 | 국고보조금이 0 또는 음수 | 경고 로그 |

#### 검증 실패 시 동작

```
검증 실패 → scraper repo에는 커밋 (디버깅용, 별도 브랜치 또는 태그)
          → web repo에는 동기화하지 않음 (프로덕션 보호)
          → GitHub Actions 로그에 경고 출력
```

### 3-4. 롤백 전략

#### 데이터 원본 보존

scraper repo가 **데이터 원본(source of truth)** 역할을 유지:

```
scraper repo (원본)          web repo (배포본)
  data/quota.json      →      public/data/quota.json
  data/2026/            →      public/data/2026/
```

검증을 통과한 데이터만 web repo에 반영되므로, scraper repo에는 모든 이력이 남고 web repo에는 정상 데이터만 들어감.

#### 롤백 시나리오

```
문제 발견 시:
  1. web repo의 마지막 정상 커밋으로 revert
  2. scraper repo 이력에서 정상 데이터 확인
  3. 수동 sync 또는 workflow_dispatch로 재동기화
```

---

## 4. 변경 파일 목록

| 파일 | 작업 | 설명 |
|------|------|------|
| `.github/workflows/scrape-quota.yml` | **수정** | 10분 cron + 업무시간 판별 + 검증 + web repo 동기화 추가 |
| `.github/workflows/scrape.yml` | **수정** | 검증 + web repo 동기화 추가 |
| `.github/workflows/sync-data-optimized.yml` | **삭제** | 동기화 로직이 각 스크래퍼에 통합됨 |
| `src/validate-data.js` | **신규** | 데이터 검증 스크립트 |

---

## 5. 리스크 및 대응

| 리스크 | 확률 | 영향 | 대응 |
|--------|------|------|------|
| 정부 사이트 IP 차단 | 낮음 | 높음 | 10분 간격은 일반적 모니터링 수준. User-Agent 설정 유지 |
| Vercel 배포 과다 | 중간 | 중간 | 변경 감지(git diff)로 실제 변경 시에만 배포 |
| 동시 push 충돌 | 낮음 | 낮음 | concurrency group + retry/rebase 로직 |
| 검증 오탐 (정상을 비정상으로) | 낮음 | 중간 | 보수적 규칙 적용 (빈 데이터만 차단, 나머지는 경고) |
| GitHub Actions 한도 | 낮음 | 중간 | 월 1,560분 예상 (한도 2,000분) |

---

## 6. 구현 순서

```
Phase 1: 검증 레이어 추가
  └─ validate-data.js 작성
  └─ 기존 워크플로우에 검증 단계 삽입

Phase 2: 파이프라인 통합
  └─ scrape-quota.yml에 web repo 동기화 로직 추가
  └─ scrape.yml에 web repo 동기화 로직 추가
  └─ sync-data-optimized.yml 삭제

Phase 3: 스케줄 변경
  └─ quota cron을 10분으로 변경
  └─ 업무시간 판별 로직 추가
```

---

## 7. 기대 효과

| 항목 | AS-IS | TO-BE | 개선 |
|------|-------|-------|------|
| 데이터 갱신 지연 (업무시간) | 최대 30분 | **최대 10분** | 3배 빠름 |
| 데이터 갱신 지연 (심야) | 최대 30분 | 최대 30분 | 동일 |
| 파이프라인 단계 | 3단계 | **2단계** | 1단계 축소 |
| 워크플로우 파일 | 3개 | **2개** | 관리 포인트 감소 |
| 데이터 검증 | 없음 | **커밋 전 자동 검증** | 오염 방지 |
| 롤백 가능성 | 수동 | **원본 보존 + 검증 게이트** | 복구 용이 |
