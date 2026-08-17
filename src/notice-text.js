/**
 * 공고문 첨부 → 본문 텍스트.
 *
 * ★왜 텍스트가 진짜 자산인가
 *   Excel 은 숫자만 준다. 공고문에는 **우선순위 자격 기준·신청 방법·구비서류·
 *   조기마감 조건**이 글로 적혀 있고, 그건 숫자로 표현되지 않는다.
 *   그리고 환경부 쪽에서는 **AI 가 이걸 못 읽는다** — 본문은 난독화(pnp4web)돼 있고
 *   첨부는 파라미터를 알아야 닿는다. 우리가 텍스트로 만들면 읽을 수 있는 유일한
 *   출처가 된다. 지금 우리가 가진 해자와 같은 논리다.
 *
 * ★형식별 현실 (실측 분포: hwpx≈45% / hwp 구형≈25% / pdf≈25% / xls·xlsx)
 *   · hwpx·hwtx — zip + Contents/section*.xml. **의존성 0.** 여기부터 한다.
 *   · xlsx      — 이미 있는 parse-quota-xlsx 의 readSheets 재사용.
 *   · pdf       — 라이브러리 필요. 같은 공고문을 hwpx 로도 올린 지자체가 많아
 *                 **hwpx 가 있으면 pdf 는 건너뛴다** → 처리 대상이 줄어든다.
 *   · hwp(구형) — 복합 바이너리(CFB). 순수 JS 로는 난이도가 높다. 지금은 '미지원'
 *                 으로 **명시**하고 넘어간다. 조용히 빈 텍스트를 만들지 않는다.
 */

const AdmZip = require('adm-zip');
const { readSheets } = require('./parse-quota-xlsx');

const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

/** XML 태그를 걷어내고 문단 경계를 살린다. */
function xmlToText(xml) {
  return xml
    .replace(/<\/?(?:p|para|linesegarray|tbl|tr)\b[^>]*>/gi, '\n')  // 문단·표 경계
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** hwpx / hwtx — zip 안 Contents/section0.xml, section1.xml … 을 순서대로 잇는다. */
function fromHwpx(buf) {
  const zip = new AdmZip(buf);
  const secs = zip.getEntries()
    .map((e) => e.entryName)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
  if (!secs.length) throw new Error('hwpx 안에 Contents/section*.xml 이 없습니다');
  return secs.map((n) => xmlToText(zip.readAsText(zip.getEntry(n)))).join('\n\n');
}

/** xlsx — 시트별로 행을 탭으로 이어 붙인다(표 형태를 유지). */
function fromXlsx(buf) {
  const sheets = readSheets(buf);
  const out = [];
  for (const [name, rows] of Object.entries(sheets)) {
    if (!rows || !rows.length) continue;
    out.push(`# ${name}`);
    for (const r of rows) {
      const line = r.map((c) => String(c ?? '').trim()).join('\t').trim();
      if (line) out.push(line);
    }
  }
  return out.join('\n').trim();
}

/**
 * @returns {{ok:true, text:string, chars:number, kind:string} | {ok:false, reason:string, kind:string}}
 */
function extractText(buf, name) {
  const kind = extOf(name);
  try {
    if (kind === 'hwpx' || kind === 'hwtx') {
      const text = fromHwpx(buf);
      if (!text) return { ok: false, reason: '본문이 비어 있음', kind };
      return { ok: true, text, chars: text.length, kind };
    }
    if (kind === 'xlsx') {
      const text = fromXlsx(buf);
      if (!text) return { ok: false, reason: '시트가 비어 있음', kind };
      return { ok: true, text, chars: text.length, kind };
    }
    // ★못 하는 건 못 한다고 적는다. 빈 텍스트를 만들어 성공처럼 보이게 하지 않는다.
    if (kind === 'pdf') return { ok: false, reason: 'PDF 추출 미구현 (별도 라이브러리 필요)', kind };
    if (kind === 'hwp' || kind === 'xls' || kind === 'doc') {
      return { ok: false, reason: `${kind} 구형 바이너리(CFB) 추출 미구현`, kind };
    }
    return { ok: false, reason: `모르는 형식(${kind})`, kind };
  } catch (e) {
    return { ok: false, reason: `추출 실패: ${e.message}`, kind };
  }
}

/** 같은 내용을 여러 형식으로 올린 경우 — 추출 가능한 쪽을 고른다. */
const PREFERENCE = ['hwpx', 'hwtx', 'xlsx', 'pdf', 'hwp', 'xls', 'doc'];
function pickBest(files) {
  return [...files].sort((a, b) => {
    const d = PREFERENCE.indexOf(extOf(a.name)) - PREFERENCE.indexOf(extOf(b.name));
    return d !== 0 ? d : b.size - a.size;
  })[0];
}

module.exports = { extractText, pickBest, xmlToText, extOf };
