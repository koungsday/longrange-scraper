/**
 * 변경 감지 — "이번 런에서 어느 지역이 바뀌었나" 를 계산한다.
 *
 * ★scraper-quota.js 에서 떼어낸 이유: 회귀 테스트가 **실제 배포 코드**를 부르게 하려고.
 *   본체는 puppeteer 등 무거운 의존성을 물어 테스트 프로세스에서 require 할 수 없다.
 *   사본을 테스트에 복사해 두면 코드가 갈라져도 테스트는 계속 통과한다 — 그게 최악이다.
 * ★이 파일은 **의존성이 없어야 한다.** 순수 함수만 둔다.
 */

/**
 * quota.json → 지역별 시그니처 Map<지역명, string>.
 * 한 지역의 모든 행(차종별)을 사용자가 보는 전체 필드(할당·등록·출고·잔여·선정·비고)로 서명.
 * 행 순서 무관하게 정렬 후 결합 → 순서만 바뀐 건 '변경'으로 오탐하지 않음.
 */
function regionSignatures(quotaJson) {
  const sigs = new Map();
  const rows = (quotaJson && quotaJson.data && quotaJson.data[0] && quotaJson.data[0].quotaData) || [];
  const byRegion = new Map();
  for (const r of rows) {
    const name = r.region;
    if (!name) continue;
    /* ★키에 sido 를 넣는다. 이름만 쓰면 **동명 지역이 하나로 뭉개진다** —
       실측: quota.json 지역명 160개 vs 코드 161개, 고성군(강원 4282 / 경남 4882)이 겹친다.
       그러면 nameToCode 도 last-wins 라 한 코드가 changed-codes 에 **영영 안 들어가고**,
       그 지역은 웹훅 사각지대가 되어 24h TTL 로만 갱신된다.
       바로 아래 regionNotes() 는 이미 같은 처방을 쓰고 그 이유까지 주석에 적어 뒀는데
       (동명 지역 분리) 여기에만 안 왔다. */
    const key = `${r.sido || ''}\t${name}`;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(JSON.stringify([
      r.vehicleType,
      r.quota_total, r.quota_priority, r.quota_corporate, r.quota_taxi, r.quota_general,
      r.registered_total, r.registered_priority, r.registered_corporate, r.registered_taxi, r.registered_general,
      r.delivered_total, r.delivered_priority, r.delivered_corporate, r.delivered_taxi, r.delivered_general,
      r.remaining_total, r.remaining_priority, r.remaining_corporate, r.remaining_taxi, r.remaining_general,
      // 선정대수·선정잔여 — 화면 판정(예산 소진 / 접수중)이 이 둘로 갈린다.
      // 빠져 있으면 판정이 뒤집혀도 재검증이 돌지 않아 옛 상태가 그대로 남는다.
      r.selected_total, r.selectedRemaining_total,
      r.note
    ]));
  }
  for (const [key, arr] of byRegion) {
    arr.sort();
    sigs.set(key, arr.join('|'));
  }
  return sigs;
}

/**
 * 이전 quota.json 대비 변경된 지역만 산출 → vw-k 온디맨드 재검증 대상 코드.
 * - 이전에 없던 지역(신규)·시그니처가 달라진 지역만 changed.
 * - nameToCode(donut)로 지역명→코드. 매핑 실패(코드 0/공백)는 제외(fallback revalidate가 커버).
 * - 이전값 없음(최초 실행)이면 전 지역 changed(1회성, 정상).
 */
function computeChangedCodes(oldQuota, newQuota, keyToCode) {
  const oldSigs = regionSignatures(oldQuota);
  const newSigs = regionSignatures(newQuota);
  const changedKeys = [];
  for (const [key, sig] of newSigs) {
    if (oldSigs.get(key) !== sig) changedKeys.push(key);
  }
  const codes = [];
  const seen = new Set();
  for (const key of changedKeys) {
    const code = String(keyToCode[key] || '').replace(/[^0-9]/g, '');
    if (!code) continue;
    if (!seen.has(code)) { seen.add(code); codes.push(code); }
  }
  /* 로그·알림은 사람이 읽으므로 시도 접두를 떼고 지역명만 남긴다 */
  return { codes, changedNames: changedKeys.map((k) => k.split('\t').pop()) };
}

/**
 * 부가 파일(공고 계열) 4종에서 **지역별로 내용이 달라진 코드**를 뽑는다.
 * ★왜 필요한가 — computeChangedCodes 는 quota.json 의 숫자 행만 서명한다.
 *   status·deadline·note 는 다른 엑셀 시트(「요약」)에서 오고, 공고문 첨부는 아예
 *   **별도 워크플로**가 만든다. 그래서 공고가 바뀌어도 codes 에 안 들어간다.
 *   실측(160쌍): 지역 콘텐츠가 바뀐 133건 중 48건(36%)을 놓쳤고, 공고 계열만 보면
 *   49건 중 48건(98%)을 놓쳤다. 지금 그게 안 터지는 건 웹훅이 notice-data 를 통째로
 *   지워 161개를 다 새로 그리기 때문이다 — 그 폭탄을 걷어내려면 여기가 먼저 맞아야 한다.
 * ★수집 실패본은 무시한다. available:false 나 빈 regions 를 비교에 넣으면
 *   전 지역이 '변경' 으로 잡혀 161개 재검증 폭탄이 된다.
 */
/**
 * 부가 파일(공고 계열) 4종에서 **지역별 지문**을 만든다.
 *
 * ★왜 "지문 + 저장된 기준선" 인가 (전/후 디스크 비교가 아니라)
 *   첫 구현은 덮어쓰기 전/후의 디스크를 비교했다. 그런데 `notice-links.json` 은
 *   **별도 워크플로**(notice-links.yml, 30분 주기)가 만든다. quota 런이 체크아웃할 땐
 *   그 변경이 **이미 prev 에 들어와 있어** prev ≡ now 가 되고, 영원히 안 잡힌다.
 *   실측(프로덕션 의미론으로 quota 런 60개 재생): notice-links 기여 **0건**.
 *   → "마지막으로 통보한 상태"를 파일로 남기고 그것과 비교한다. 누가 썼든 잡힌다.
 *
 * ★왜 화이트리스트인가 (객체 통째 JSON 비교가 아니라)
 *   통째로 비교하면 파서가 필드를 하나 더 내보내거나 **키 순서만 바뀌어도** 161지역이
 *   전부 '변경' 으로 잡힌다(실측 확인: 필드 1개 추가 → 161, 키 순서만 뒤집기 → 161).
 *   parse-quota-detail.js 는 지금도 활발히 손대는 파일이라 현실적인 위험이다.
 *   regionSignatures 가 명시적 필드 목록인 것과 같은 이유로 여기도 목록을 못 박는다.
 *
 * ★제외한 것
 *   · 숫자(selected/selectedRemaining/budgetUsedPct) — quota.json 시그니처가 이미 덮는다
 *   · notice-links 의 `stale` 플래그 — 확인 실패 시 붙었다 떨어졌다 한다
 *     (실측: 신안군 4691 이 27시간에 19회 진동). 내용이 아니라 잡음이다
 */
const DETAIL_FIELDS = ['status', 'deadline', 'note', 'applyMethod', 'dept', 'tel', 'noticeKinds', 'noticeCount'];

/**
 * → { code: { d?, s?, l?, c? } }   (d=quota-detail, s=notice-schedule, l=notice-links, c=change-history)
 *
 * ★조각을 **출처별로 나눠서** 담는 것이 핵심이다. 처음엔 조각을 이어 붙여 한 문자열로 만들었는데,
 *   그러면 파일 하나가 수집 실패해 조각이 빠지는 순간 **161지역 전부의 지문이 달라져** 통째로
 *   통보된다(회귀 테스트가 실제로 161곳을 잡아냈다 — 우리가 없애려던 폭탄 그 자체다).
 *   나눠 두면 살아 있는 출처끼리만 비교하고 죽은 출처는 건너뛸 수 있다.
 * ★수집 실패본(available:false)·빈 regions 는 애초에 담지 않는다.
 */
function auxFingerprint(aux) {
  const out = {};
  const put = (code, src, val) => {
    const c = String(code).replace(/[^0-9]/g, '');
    if (c) ((out[c] ||= {})[src] = val);
  };

  const d = aux && aux['quota-detail'];
  if (d && d.available !== false && d.regions && Object.keys(d.regions).length) {
    for (const [code, r] of Object.entries(d.regions)) put(code, 'd', DETAIL_FIELDS.map((f) => r?.[f] ?? '').join('\u0001'));
  }

  const sch = aux && aux['notice-schedule'];
  if (sch && sch.available !== false && sch.items && Object.keys(sch.items).length) {
    const by = {};
    for (const [k, v] of Object.entries(sch.items)) {
      const code = String(k).split('|')[0];   /* items 키는 `${code}|${kind}` (실측: 331키 전부) */
      if (!code) continue;
      (by[code] ||= []).push([v?.kind, v?.name, v?.posted, v?.start, v?.end].join('\u0001'));
    }
    for (const [code, arr] of Object.entries(by)) { arr.sort(); put(code, 's', arr.join('\u0002')); }
  }

  const links = aux && aux['notice-links'];
  if (links && links.regions && Object.keys(links.regions).length) {
    for (const [code, r] of Object.entries(links.regions)) {
      /* ★stale 플래그는 뺀다 — 확인 실패 때 붙었다 떨어졌다 한다(신안군 4691, 27시간에 19회).
         내용이 아니라 잡음이고, 넣으면 그 진동이 그대로 재검증이 된다.
         ★gubun·url 도 같은 이유로 뺀다. 원본이 같은 첨부를 A↔B↔A02 슬롯 사이로
           옮겨 쓴다 — 파일 이름 집합은 그대로인데 슬롯만 흔들린다.
           url 은 독립 정보가 아니라 **gubun 의 중복**이다: 실측 393/393 이
           `local_cd=…&attach_gubun=…&model_gubun=…` 공식이고 파일명 흔적은 0/393.
           파일 고유 식별자가 아니므로 빼도 잃는 것이 없다.
         실측(7일치 notice-links 커밋 120개 재생):
           gubun+name+url  63건  ← 이 중 38건(60%)이 슬롯만 흔들린 것
           name             25건 · name+ext 25건 · name+ext+kind 25건
           → ext·kind 는 잡음을 안 늘린다. 정보를 더 남기는 쪽을 고른다.
         진동 지역: 4161 광주 13회 · 4315 제천 12회 · 4377 음성 11회 · 4476 부여 6회.
         이 네 곳은 detail-history 가 거의 매일 갱신돼 화면이 상시 "오늘 변동 있음" 이었다. */
      const files = (r?.files || []).map((f) => [f.name, f.ext, f.kind].join('\u0001')).sort();
      put(code, 'l', files.join('\u0002'));
    }
  }

  const chg = aux && aux['change-history'];
  if (chg && chg.available !== false && chg.regions && Object.keys(chg.regions).length) {
    for (const [code, r] of Object.entries(chg.regions)) put(code, 'c', JSON.stringify(r?.summary ?? r?.items?.length ?? ''));
  }
  return out;
}

/**
 * 저장된 기준선과 비교해 공고 계열이 바뀐 지역 코드를 반환한다.
 *
 * @returns {{codes: string[], fingerprint: object}} fingerprint 는 **기준선에 저장할 값**이다.
 *   이번 런에서 수집 실패한 출처는 기준선의 옛 조각을 그대로 물려받는다 — 안 그러면
 *   장애가 끝난 뒤 그 출처가 통째로 '변경' 으로 잡힌다.
 * ★기준선이 없으면(최초) 빈 배열. 전 지역 통보를 막는다.
 */
function auxChangedCodes(baseline, nowAux) {
  const now = auxFingerprint(nowAux);
  const merged = {};
  for (const code of new Set([...Object.keys(now), ...Object.keys(baseline || {})])) {
    merged[code] = { ...(baseline?.[code] || {}), ...(now[code] || {}) };
  }
  if (!baseline || !Object.keys(baseline).length) return { codes: [], fingerprint: merged };

  const codes = [];
  for (const [code, cur] of Object.entries(now)) {
    const old = baseline[code];
    if (!old) continue;                    /* 신규 지역 — 기준선이 없으니 판단 보류 */
    /* ★**양쪽에 다 있는 출처만** 비교한다. 이번 런에 빠진 출처(수집 실패)를 '변경' 으로
       읽으면 161곳이 통째로 나간다. */
    for (const src of Object.keys(cur)) {
      if (old[src] !== undefined && old[src] !== cur[src]) { codes.push(code); break; }
    }
  }
  return { codes, fingerprint: merged };
}

/**
 * donut 지역목록 → `${sido}\t${지역명}` → 코드 맵.
 * ★본체에 인라인으로 있던 것을 옮겼다. 적대적 검증 지적:
 *   이 한 줄을 예전(localName 만)으로 되돌리면 **테스트 17/17 초록불 그대로
 *   프로덕션은 영구히 0곳**이 된다. 배선이 테스트 밖에 있으면 테스트가 장식이 된다.
 * ★parentName 은 quota.json 의 sido 와 값이 같다(실측 161/161 일치).
 */
function buildKeyToCode(regions) {
  const map = {};
  for (const r of regions || []) map[`${r.parentName || ''}\t${r.localName}`] = String(r.code);
  return map;
}

/**
 * ★배선을 순수 함수로 뺀다 — 여기부터가 오늘 적대적 검증이 "테스트 밖" 이라고 지적한 부분이다.
 *   기준선 파일 왕복 · 상한 두 개 · 이월 합침 · 이름 매핑 · 매칭 실패 계수가 전부
 *   scraper-quota.js 안에 인라인으로 있었고, 그건 puppeteer 의존 때문에 테스트가
 *   require 할 수 없다. 즉 `.regions` 를 `.data` 로 오타 내도 **25/25 초록**이었다.
 *   파일 읽기·쓰기만 호출부에 남기고 판단은 전부 여기로 옮긴다.
 */

/** quota.json 행 키와 코드 맵을 대조해 **매칭 실패 수**를 센다.
 *  0 이 아니면 donut 과 환경부의 시도 표기가 갈라진 것이고, 그러면 통보가 통째로 죽는다. */
function countUnmatched(quotaJson, keyToCode) {
  const keys = new Set((quotaJson?.data?.[0]?.quotaData || [])
    .filter((r) => r.region).map((r) => `${r.sido || ''}\t${r.region}`));
  return { unmatched: [...keys].filter((k) => !keyToCode[k]).length, total: keys.size };
}

/** 코드 → "시도 지역명". names 가 codes 와 어긋나면 사람이 읽는 유일한 로그가 거짓말한다. */
function buildCodeToName(regions) {
  const m = {};
  for (const r of regions || []) m[String(r.code)] = `${r.parentName || ''} ${r.localName}`.trim();
  return m;
}

/** 지난 런에서 통보 못 한 코드를 합친다. 24시간 넘은 이월은 버린다(TTL 이 이미 덮었다). */
function mergePending(changedCodes, pending, nowMs = Date.now(), maxAgeH = 24) {
  if (!pending || !Array.isArray(pending.codes) || !pending.codes.length) return { codes: changedCodes, added: 0, expired: 0 };
  const ageH = (nowMs - new Date(pending.ts).getTime()) / 3600000;
  if (!(ageH <= maxAgeH)) return { codes: changedCodes, added: 0, expired: pending.codes.length };
  const add = pending.codes.filter((c) => !changedCodes.includes(c));
  return { codes: changedCodes.concat(add), added: add.length, expired: 0 };
}

/**
 * 최종 통보 목록을 확정한다 — 상한 둘을 여기서 한 번에 적용한다.
 * @returns {{codes, names, capped}} capped>0 이면 **통보를 포기했다**는 뜻이고,
 *   그 사실이 어디에도 안 남으면 조용한 데이터 손실이 된다(워크플로가 reason 에 싣는다).
 */
function finalizeCodes(quotaCodes, quotaNames, extraCodes, codeToName, opts = {}) {
  const EXTRA_CAP = opts.extraCap ?? 30;
  const TOTAL_CAP = opts.totalCap ?? 60;
  let codes = quotaCodes.slice();
  let names = quotaNames.slice();
  let capped = 0;

  const extra = extraCodes.filter((c) => !codes.includes(c));
  if (extra.length > EXTRA_CAP) {
    capped = extra.length;                       /* 공고 계열만 초과 — quota 분은 살린다 */
  } else if (extra.length) {
    codes = codes.concat(extra);
    names = names.concat(extra.map((c) => codeToName[c] || c));
  }

  if (codes.length > TOTAL_CAP) {
    capped = Math.max(capped, codes.length);     /* 전체 초과 — 통째로 포기한다 */
    codes = [];
    names = [];
  }

  /* ★names 를 codes 길이에 맞춘다. mergePending 이 이월 코드를 붙일 때 이름은 안 붙이므로
     그대로 두면 `count=2 names=0` 이 되고, 사람이 읽는 유일한 로그가 거짓말한다
     (시뮬레이션에서 실제로 나왔다 — 앞서 공고 계열에서 고친 것과 같은 종류다). */
  if (names.length !== codes.length) {
    names = codes.map((c, i) => names[i] ?? codeToName[c] ?? c);
  }
  return { codes, names, capped };
}

/**
 * 지역별로 **어느 출처가** 바뀌었는지 돌려준다 — 신선도 문구가 쓸 재료.
 *
 * ★auxChangedCodes 는 "바뀌었나"(불리언)만 답한다. 화면은 "언제 바뀌었나"가 필요하고,
 *   그 날짜를 남기려면 **어느 조각이** 달라졌는지 알아야 한다.
 *   조각은 이미 auxFingerprint 가 계산한다 — d(상세)·s(공고차수)·l(공고문첨부)·c(일정변경이력).
 * ★d 는 제외한다. quota-detail 변경은 detailDiff 가 필드 단위로 이미 기록하므로 중복이다.
 * ★대량 배치는 파서 아티팩트다 — 한 출처가 artifactLimit 개 지역을 넘게 바꾸면 그 출처를 버린다.
 *   실측(2026-08-17): deadline 이 같은 초에 161개 지역 전부 바뀌었고 72건은 포맷만 추가였다.
 */
const AUX_SOURCE_NAME = { s: 'notice-schedule', l: 'notice-links', c: 'change-history' };

function auxChangedSources(baseline, fingerprint, opts = {}) {
  const limit = opts.artifactLimit ?? 30;
  if (!baseline || !Object.keys(baseline).length) return { bySource: {}, dropped: [] };

  const hits = {};                      /* src → [code, ...] */
  for (const [code, cur] of Object.entries(fingerprint || {})) {
    const old = baseline[code];
    if (!old) continue;                 /* 신규 지역 — 기준선이 없으니 판단 보류 */
    for (const src of ['s', 'l', 'c']) {
      if (cur[src] === undefined || old[src] === undefined) continue;   /* 한쪽이 없으면 보류 */
      if (cur[src] !== old[src]) (hits[src] ||= []).push(code);
    }
  }

  const bySource = {}, dropped = [];
  for (const [src, codes] of Object.entries(hits)) {
    if (codes.length > limit) { dropped.push({ src: AUX_SOURCE_NAME[src], count: codes.length }); continue; }
    for (const code of codes) (bySource[code] ||= []).push(AUX_SOURCE_NAME[src]);
  }
  return { bySource, dropped };
}

module.exports = { regionSignatures, computeChangedCodes, auxChangedCodes, auxFingerprint, buildKeyToCode,
  countUnmatched, buildCodeToName, mergePending, finalizeCodes, auxChangedSources };
