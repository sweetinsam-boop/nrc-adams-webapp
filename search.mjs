const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const namedMonth = months.map(name => name.length === 3 ? name : name.slice(0, 3) + '(?:' + name.slice(3) + ')?').join('|');
const monthFirst = new RegExp('\\b(' + namedMonth + ')\\.?\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+)?((?:19|20)\\d{2})\\b', 'gi');
const dayFirst = new RegExp('\\b(\\d{1,2})\\s+(' + namedMonth + ')\\.?\\s+((?:19|20)\\d{2})\\b', 'gi');
const dayMs = 86400000;
const isoDay = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);

function normalizeDateExpressions(query) {
  const numeric = (year, month, day) => [year, month, day].filter(Boolean).join('-');
  const monthNumber = name => 1 + months.findIndex(month => month.startsWith(name.toLowerCase()));
  return query.replace(/((?:19|20)\d{2})\s*년(?:\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?)?/g,
    (_, year, month, day) => numeric(year, month, day))
    .replace(dayFirst, (_, day, month, year) => numeric(year, monthNumber(month), day))
    .replace(monthFirst, (_, month, day, year) => numeric(year, monthNumber(month), day));
}

function datePeriod(match) {
  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  const start = Date.UTC(year, month - 1, day);
  const date = new Date(start);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const end = match[3] ? start : match[2] ? Date.UTC(year, month, 0) : Date.UTC(year, 11, 31);
  return { start, end };
}

export function contextualDates(query, explicitFrom = '', explicitTo = '') {
  const explicit = { from: explicitFrom, to: explicitTo };
  if (!query || (explicitFrom && explicitTo)) return explicit;
  const text = normalizeDateExpressions(query);
  const dates = [...text.matchAll(/(?<![a-z\d])((?:19|20)\d{2})(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?(?!\d)/gi)];
  let from = '';
  let to = '';
  for (const [index, match] of dates.entries()) {
    const period = datePeriod(match);
    if (!period) continue;
    const before = text.slice(0, match.index).trimEnd();
    const after = text.slice(match.index + match[0].length).trimStart();
    const next = dates[index + 1];
    if (next) {
      const between = text.slice(match.index + match[0].length, next.index).trim();
      if (/^(?:[~～–—-]|부터|to|through)$/i.test(between) || (/^and$/i.test(between) && /\bbetween$/i.test(before))) {
        const last = datePeriod(next);
        if (last) { from = isoDay(period.start); to = isoDay(last.end); break; }
      }
    }

    // Require the date to modify the search period or the publication, not merely an event mentioned in the request.
    if (/^(?:이후|이전|부터|까지)?\s*(?:에\s*)?(?:발생|일어난|일어났|사고|사건|지진)/.test(after) ||
        /\b(?:accidents?|incidents?|earthquakes?|occurred|happened)\s+(?:in|on|since|before|after)$/i.test(before)) continue;
    if (/^(?:이후|부터)/.test(after) || /\b(?:since|from)$/i.test(before)) from = isoDay(period.start);
    else if (/^(?:이전|까지)/.test(after) || /\b(?:through|until)$/i.test(before)) to = isoDay(period.end);
    else if (/\bafter$/i.test(before)) from = isoDay(period.end + dayMs);
    else if (/\bbefore$/i.test(before)) to = isoDay(period.start - dayMs);
    else if ((!before && !after) ||
        /^(?:에|의|도)?\s*(?:발행|작성|발급|공개|제출|접수|문서|보고서)/.test(after) ||
        /\b(?:documents?|reports?|issued|published|written|filed|submitted|dated|released)(?:\s+(?:in|on))?$/i.test(before)) {
      from = isoDay(period.start);
      to = isoDay(period.end);
    }
  }
  const result = { from: explicitFrom || from, to: explicitTo || to };
  return result.from && result.to && result.from > result.to ? explicit : result;
}

export async function searchBranches(client, branches) {
  const pages = await Promise.allSettled(branches.map(branch => client.search(branch.criteria)));
  const matches = new Map();
  const next = [];
  let failures = 0;
  for (const [index, page] of pages.entries()) {
    const branch = branches[index];
    if (page.status === 'rejected') {
      failures++;
      continue;
    }
    for (const [position, doc] of page.value.documents.entries()) {
      const result = matches.get(doc.id) ?? { doc, score: 0 };
      result.score += (branch.order === 0 ? 1.15 : 1) / (25 + position + 1);
      matches.set(doc.id, result);
    }
    if (page.value.next != null && page.value.next > branch.criteria.skip) {
      next.push({ ...branch, criteria: { ...branch.criteria, skip: page.value.next } });
    }
  }
  return { documents: [...matches.values()].sort((first, second) => second.score - first.score).map(match => match.doc),
    next, failures };
}
