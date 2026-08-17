/**
 * 환경부「지자체별 보조금 현황」 Excel(xlsx) → 기존 quotaData 스키마.
 *
 * ★왜 Excel 인가 (2026-08-17)
 *   ev.or.kr 이 이 페이지를 AG Grid(가상 스크롤)로 개편하면서 <table> 이 사라졌다.
 *   화면에는 161건 중 10건 남짓만 DOM 에 존재하고 나머지는 JS 메모리에 있다.
 *   → HTML 파싱은 스크롤·페이징(5쪽)을 흉내내야 하고 개편마다 깨진다.
 *   → 데이터를 부르는 POST 를 직접 흉내내는 것도 답이 아니다. 요청에 난독화
 *     스크립트(pnp4web)가 만드는 pnph 토큰이 붙어 브라우저 밖에서는 취약하다.
 *   → 사이트가 사용자에게 제공하는 「Excel 다운로드」가 가장 안정적이다.
 *     161건이 한 번에 오고, 예전 표보다 데이터가 더 많다.
 *
 * ★출력 스키마는 예전 그대로 둔다. 하류(vw-k)를 한 줄도 안 건드리기 위해서다.
 *   새로 생긴 값(선정대수·선정잔여·신청마감·담당부서 등)은 여기서 버린다 —
 *   쓸 곳을 정한 뒤에 따로 싣는다.
 */

const AdmZip = require('adm-zip');

/** "AB12" → 0-based 열 번호. 빈 셀은 XML 에서 통째로 빠질 수 있어 위치를 좌표로 잡는다. */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xmlDecode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

/** 시트 XML → 2차원 배열. 공유문자열(sharedStrings)과 inline string 둘 다 받는다. */
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[2] || '';
      const inner = cm[3] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      let val = '';
      if (type === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
      } else {
        const v = (/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (v != null) val = type === 's' ? (shared[+v] ?? '') : v;
        else {
          const isEl = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
          val = isEl;
        }
      }
      const i = ref ? colIndex(ref) : cells.length;
      cells[i >= 0 ? i : cells.length] = xmlDecode(val);
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** 숫자 셀은 "15430.0" 처럼 오므로 정수로 되돌린다. 빈 칸은 0. */
function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** 시트 이름 → 시트 XML. workbook.xml 의 순서가 sheet1..N 파일 순서와 같다. */
function readSheets(buf) {
  const zip = new AdmZip(buf);
  const text = (p) => {
    const e = zip.getEntry(p);
    return e ? zip.readAsText(e) : null;
  };
  const wb = text('xl/workbook.xml') || '';
  const names = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => xmlDecode(m[1]));
  const ssXml = text('xl/sharedStrings.xml');
  const shared = ssXml
    ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        xmlDecode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')))
    : [];
  const out = {};
  names.forEach((nm, i) => {
    const xml = text(`xl/worksheets/sheet${i + 1}.xml`);
    if (xml) out[nm] = parseSheet(xml, shared);
  });
  return out;
}

/**
 * @param {Buffer} buf  다운로드한 xlsx
 * @returns {Array} 기존 quotaData 와 같은 모양의 행 배열
 */
function parseQuotaXlsx(buf) {
  const sheets = readSheets(buf);
  const summary = sheets['요약'];
  const detail = sheets['상세_대수정보'];
  if (!summary || !summary.length) throw new Error("Excel 에 '요약' 시트가 없습니다");
  if (!detail || !detail.length) throw new Error("Excel 에 '상세_대수정보' 시트가 없습니다");

  // 헤더에서 열 위치를 이름으로 찾는다 — 열 순서가 바뀌어도 견디게.
  const at = (hdr, name) => {
    const i = hdr.findIndex((h) => (h || '').replace(/\s/g, '') === name.replace(/\s/g, ''));
    if (i < 0) throw new Error(`Excel 열 '${name}' 을 찾지 못했습니다`);
    return i;
  };
  const sh = summary[0];
  const S = { id: at(sh, '관리번호'), sido: at(sh, '시도'), region: at(sh, '지역구분'),
    vtype: at(sh, '세부차종'), note: at(sh, '비고') };
  const dh = detail[0];
  const D = { id: at(dh, '관리번호'), kind: at(dh, '구분'), total: at(dh, '전체'),
    prio: at(dh, '우선순위'), corp: at(dh, '법인·기관'), taxi: at(dh, '택시'), gen: at(dh, '일반') };

  // 관리번호 → { 구분: [전체,우선,법인,택시,일반] }
  const byId = new Map();
  for (const r of detail.slice(1)) {
    const id = r[D.id];
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, {});
    byId.get(id)[r[D.kind]] = [r[D.total], r[D.prio], r[D.corp], r[D.taxi], r[D.gen]];
  }

  const pick = (m, kind) => m[kind] || [];
  const rows = [];
  for (const r of summary.slice(1)) {
    const id = r[S.id];
    if (!id) continue;
    const m = byId.get(id) || {};
    const q = pick(m, '공고대수'), g = pick(m, '접수대수');
    const d = pick(m, '출고대수'), rem = pick(m, '출고잔여');
    rows.push({
      sido: r[S.sido] || '',
      region: r[S.region] || '',
      vehicleType: r[S.vtype] || '',

      quota_total: num(q[0]), quota_priority: num(q[1]), quota_corporate: num(q[2]),
      quota_taxi: num(q[3]), quota_general: num(q[4]),

      registered_total: num(g[0]), registered_priority: num(g[1]), registered_corporate: num(g[2]),
      registered_taxi: num(g[3]), registered_general: num(g[4]),

      delivered_total: num(d[0]), delivered_priority: num(d[1]), delivered_corporate: num(d[2]),
      delivered_taxi: num(d[3]), delivered_general: num(d[4]),

      remaining_total: num(rem[0]), remaining_priority: num(rem[1]), remaining_corporate: num(rem[2]),
      remaining_taxi: num(rem[3]), remaining_general: num(rem[4]),

      note: (r[S.note] || '').trim(),
    });
  }
  return rows;
}

module.exports = { parseQuotaXlsx, readSheets };
