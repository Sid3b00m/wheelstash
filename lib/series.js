"use strict";

function parseFraction(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const frac = s.match(/(?:^|[\s(#])(\d{1,4})\s*\/\s*(\d{1,4})(?:\)|$|\s)/);
  if (frac) {
    return {
      num: Number(frac[1]),
      total: Number(frac[2]),
      text: `${Number(frac[1])}/${Number(frac[2])}`,
    };
  }
  const hashNum = s.match(/(?:^|\s)#(\d{1,4})(?:\s|$)/);
  if (hashNum) {
    return {
      num: Number(hashNum[1]),
      total: Infinity,
      text: `#${Number(hashNum[1])}`,
    };
  }
  if (/^\d{1,4}$/.test(s)) {
    return {
      num: Number(s),
      total: Infinity,
      text: s,
    };
  }
  return null;
}

function parseSeries(rawSeries) {
  const raw = String(rawSeries || "").trim();
  if (!raw) {
    return { raw: "", base: "", num: null, total: null, text: "" };
  }
  // Match trailing or parenthesized series fraction like "3/10", "5/5", "(1/5)", "#3/10"
  const fracRe = /(?:^|[\s(\-#·]+)(\d{1,3})\s*\/\s*(\d{1,3})\)?\s*$/;
  let m = raw.match(fracRe);
  if (m) {
    const base = raw
      .slice(0, m.index)
      .replace(/[\s(\-#·:]+$/, "")
      .trim();
    return {
      raw,
      base: base || raw,
      num: Number(m[1]),
      total: Number(m[2]),
      text: `${Number(m[1])}/${Number(m[2])}`,
    };
  }
  // Also match trailing "#3"
  const hashRe = /(?:^|[\s(\-·]+)#(\d{1,3})\)?\s*$/;
  m = raw.match(hashRe);
  if (m) {
    const base = raw
      .slice(0, m.index)
      .replace(/[\s(\-#·:]+$/, "")
      .trim();
    return {
      raw,
      base: base || raw,
      num: Number(m[1]),
      total: Infinity,
      text: `#${Number(m[1])}`,
    };
  }
  return { raw, base: raw, num: null, total: null, text: "" };
}

function normalizeSeriesKey(base) {
  return String(base || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pickBestTitle(variants) {
  // Prefer mixed case (not ALL CAPS and not all lowercase), plural if tied, most frequent.
  const counts = new Map();
  for (const v of variants) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const unique = [...counts.keys()];
  if (!unique.length) return "No series";
  unique.sort((a, b) => {
    const aMixed = /[a-z]/.test(a) && /[A-Z]/.test(a) ? 1 : 0;
    const bMixed = /[a-z]/.test(b) && /[A-Z]/.test(b) ? 1 : 0;
    if (aMixed !== bMixed) return bMixed - aMixed;
    const aPlural = a.toLowerCase().endsWith("s") ? 1 : 0;
    const bPlural = b.toLowerCase().endsWith("s") ? 1 : 0;
    if (aPlural !== bPlural) return bPlural - aPlural;
    const diff = counts.get(b) - counts.get(a);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  return unique[0];
}

function compareParsedNumbers(a, b) {
  const aHas = a && Number.isFinite(a.num);
  const bHas = b && Number.isFinite(b.num);
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (aHas && bHas) {
    if (a.num !== b.num) return a.num - b.num;
    if (a.total !== b.total) {
      if (a.total === Infinity) return 1;
      if (b.total === Infinity) return -1;
      return a.total - b.total;
    }
  }
  return 0;
}

function groupAndSortBySeries(cars, dir = 1) {
  const parsed = (cars || []).map((car) => {
    const sp = parseSeries(car.series);
    const key = normalizeSeriesKey(sp.base);
    const effectiveCollector = car.collectorNumber
      || (car.rarityMatches || []).find((m) => m.collectorNumber)?.collectorNumber
      || "";
    const cp = parseFraction(effectiveCollector);
    return { car, sp, rawKey: key, effectiveCollector, cp };
  });

  // Merge singular/plural keys when both "foo" and "foos" exist (e.g. "hw j-import" -> "hw j-imports").
  const rawKeys = new Set(parsed.map((p) => p.rawKey).filter(Boolean));
  const canonKey = (k) => {
    if (!k) return "";
    if (!k.endsWith("s") && rawKeys.has(`${k}s`)) return `${k}s`;
    return k;
  };

  const groups = new Map();
  for (const row of parsed) {
    const key = canonKey(row.rawKey);
    if (!groups.has(key)) groups.set(key, { key, variants: [], rows: [] });
    const g = groups.get(key);
    if (row.sp.base) g.variants.push(row.sp.base);
    g.rows.push(row);
  }

  const orderedGroups = [...groups.values()].map((g) => ({
    key: g.key,
    title: g.key ? pickBestTitle(g.variants) : "No series",
    rows: g.rows,
  }));

  orderedGroups.sort((a, b) => {
    if (!a.key && b.key) return 1;
    if (a.key && !b.key) return -1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) * dir;
  });

  const result = [];
  for (const group of orderedGroups) {
    group.rows.sort((a, b) => {
      const sCmp = compareParsedNumbers(
        a.sp.num != null ? { num: a.sp.num, total: a.sp.total ?? Infinity } : null,
        b.sp.num != null ? { num: b.sp.num, total: b.sp.total ?? Infinity } : null
      );
      if (sCmp !== 0) return sCmp;
      const cCmp = compareParsedNumbers(a.cp, b.cp);
      if (cCmp !== 0) return cCmp;
      const nameCmp = String(a.car.name || "").localeCompare(String(b.car.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
      if (nameCmp !== 0) return nameCmp;
      const yearCmp = (b.car.year || 0) - (a.car.year || 0);
      if (yearCmp !== 0) return yearCmp;
      return (a.car.id || 0) - (b.car.id || 0);
    });

    for (const row of group.rows) {
      result.push({
        ...row.car,
        seriesGroup: group.title,
        seriesNumberText: row.sp.text,
        effectiveCollectorNumber: row.effectiveCollector,
      });
    }
  }
  return result;
}

module.exports = {
  parseFraction,
  parseSeries,
  normalizeSeriesKey,
  groupAndSortBySeries,
};
