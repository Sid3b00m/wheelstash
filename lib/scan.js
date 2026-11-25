"use strict";

const { normalizeToy, normalizeText, matchCar } = require("./rarity");

function normalizeUpc(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return "";
  return digits;
}

function extractToyNumbers(text) {
  const src = String(text || "").toUpperCase().replace(/[^A-Z0-9/\s-]/g, " ");
  const out = [];
  const seen = new Set();
  const re = /\b([A-Z]{3,4})[-\s]?(\d{2,3})\b/g;
  let match;
  while ((match = re.exec(src))) {
    const toy = `${match[1]}${match[2]}`;
    if (!seen.has(toy)) {
      seen.add(toy);
      out.push(toy);
    }
  }
  return out;
}

function extractCollectorNumbers(text) {
  const out = [];
  const seen = new Set();
  const re = /\b(\d{1,3})\s*\/\s*(\d{2,4})\b/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const value = `${Number(match[1])}/${match[2]}`;
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function extractYears(text) {
  const years = [];
  const re = /\b(19[6-9]\d|20[0-3]\d)\b/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const year = Number(match[1]);
    if (year >= 1968 && year <= 2035 && !years.includes(year)) years.push(year);
  }
  return years;
}

function extractUpcs(text) {
  const out = [];
  const seen = new Set();
  const re = /\b(\d{8}|\d{12,14})\b/g;
  let match;
  while ((match = re.exec(String(text || "").replace(/[^\d\s]/g, " ")))) {
    const upc = normalizeUpc(match[1]);
    if (upc && !seen.has(upc)) {
      seen.add(upc);
      out.push(upc);
    }
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function nameSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  return Math.max(0, 1 - levenshtein(left, right) / Math.max(left.length, right.length));
}

function ocrToyVariants(toy) {
  const base = normalizeToy(toy);
  const swaps = { I: "1", L: "1", O: "0", S: "5", B: "8", Z: "2", G: "6" };
  const variants = new Set([base]);
  let swapped = "";
  for (const ch of base) swapped += swaps[ch] || ch;
  variants.add(swapped);
  return [...variants].filter(Boolean);
}

function parseScanInput(input) {
  const raw = String(input || "").trim();
  const toyNumbers = extractToyNumbers(raw);
  const collectorNumbers = extractCollectorNumbers(raw);
  const years = extractYears(raw);
  const upcs = extractUpcs(raw);
  const compact = raw.replace(/\s+/g, "");
  if (/^\d{8,14}$/.test(compact)) {
    const upc = normalizeUpc(compact);
    if (upc && !upcs.includes(upc)) upcs.push(upc);
  }
  return { raw, toyNumbers, collectorNumbers, years, upcs };
}

function normalizeCollector(value) {
  const match = String(value || "").trim().match(/^(\d{1,3})\s*\/\s*(\d{2,4})$/);
  if (!match) return "";
  return `${Number(match[1])}/${match[2]}`;
}

function fromRarity(item, reason, score) {
  return {
    source: "rarity",
    matchReason: reason,
    score,
    id: item.id,
    name: item.name || "",
    series: item.series || "",
    year: item.year ?? null,
    color: item.color || "",
    toyNumber: item.toyNumber || "",
    collectorNumber: item.collectorNumber || "",
    casting: item.casting || "",
    imageUrl: item.imageUrl || "",
    upc: "",
    category: item.category || "",
    rarityBadges: item.category ? [item.category] : [],
    valueEstimate: item.valueEstimate || "",
    isRare: true,
  };
}

function fromUpcMap(row, rarityItems) {
  const car = {
    name: row.name || "",
    series: row.series || "",
    year: row.year ?? null,
    color: row.color || "",
    toyNumber: row.toy_number || row.toyNumber || "",
    casting: row.casting || "",
  };
  const matches = matchCar(car, rarityItems || []);
  return {
    source: "upcMap",
    matchReason: "upcMap",
    score: 0.98,
    id: `upc-${row.upc}`,
    name: car.name,
    series: car.series,
    year: car.year,
    color: car.color,
    toyNumber: car.toyNumber,
    collectorNumber: "",
    casting: car.casting,
    imageUrl: row.image_url || row.imageUrl || "",
    upc: row.upc,
    category: matches[0]?.category || "",
    rarityBadges: [...new Set(matches.map((m) => m.category).filter(Boolean))],
    valueEstimate: matches.map((m) => m.valueEstimate).filter(Boolean).join("; "),
    isRare: matches.length > 0,
  };
}

function fromOwned(car, reason) {
  return {
    id: car.id,
    name: car.name,
    series: car.series || "",
    year: car.year ?? null,
    color: car.color || "",
    toyNumber: car.toyNumber || "",
    collectorNumber: "",
    casting: car.casting || "",
    imageUrl: car.imageUrl || "",
    upc: car.upc || "",
    quantity: car.quantity || 1,
    suggestedQuantity: (car.quantity || 1) + 1,
    condition: car.condition || "",
    storageLocation: car.storageLocation || "",
    notes: car.notes || "",
    userId: car.userId,
    matchReason: reason,
    rarityBadges: car.rarityBadges || [],
    isRare: Boolean(car.isRare),
  };
}

function attachRarity(candidate, rarityItems) {
  if (!candidate || candidate.source === "rarity") return candidate;
  const matches = matchCar(candidate, rarityItems || []);
  if (!matches.length) return candidate;
  return {
    ...candidate,
    rarityBadges: [...new Set([...(candidate.rarityBadges || []), ...matches.map((m) => m.category)])],
    isRare: true,
    valueEstimate: candidate.valueEstimate || matches.map((m) => m.valueEstimate).filter(Boolean).join("; "),
    imageUrl: candidate.imageUrl || matches.find((m) => m.imageUrl)?.imageUrl || "",
    series: candidate.series || matches[0].series || "",
    year: candidate.year || matches[0].year || null,
    color: candidate.color || matches[0].color || "",
    toyNumber: candidate.toyNumber || matches[0].toyNumber || "",
  };
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  return list.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lookupScan({ query, upc, text, rarityItems, ownedCars, upcMaps, ownedNameHint = "", ownedNameYear = null }) {
  const items = rarityItems || [];
  const owned = ownedCars || [];
  const maps = upcMaps || [];
  const blob = [query, text].filter(Boolean).join("\n");
  const parsed = parseScanInput(blob);
  const upcCode = normalizeUpc(upc) || parsed.upcs[0] || "";
  if (upcCode && !parsed.upcs.includes(upcCode)) parsed.upcs.unshift(upcCode);

  const alreadyOwned = [];
  const candidates = [];

  const rememberOwned = (car, reason) => {
    if (!car || alreadyOwned.some((row) => row.id === car.id)) return;
    alreadyOwned.push(fromOwned(car, reason));
  };

  for (const code of parsed.upcs) {
    for (const car of owned) {
      if (normalizeUpc(car.upc) === code) rememberOwned(car, "upc");
    }
    const mapped = maps.find((row) => normalizeUpc(row.upc) === code);
    if (mapped) candidates.push(attachRarity(fromUpcMap(mapped, items), items));
  }

  const toySet = new Set();
  for (const toy of parsed.toyNumbers) {
    for (const variant of ocrToyVariants(toy)) toySet.add(variant);
  }

  for (const toy of toySet) {
    for (const item of items) {
      if (normalizeToy(item.toyNumber) === toy) {
        const yearBoost = parsed.years.length && item.year && parsed.years.includes(Number(item.year));
        candidates.push(fromRarity(item, "toyNumber", yearBoost ? 1 : 0.99));
      }
    }
    for (const car of owned) {
      if (normalizeToy(car.toyNumber) === toy) rememberOwned(car, "toyNumber");
    }
  }

  if (ownedNameHint) {
    for (const car of owned) {
      const score = nameSimilarity(ownedNameHint, car.name);
      if (score < 0.85) continue;
      if (ownedNameYear && car.year && Number(car.year) !== Number(ownedNameYear)) continue;
      rememberOwned(car, "name");
    }
  }

  for (const collector of parsed.collectorNumbers) {
    const want = normalizeCollector(collector);
    if (!want) continue;
    for (const item of items) {
      if (normalizeCollector(item.collectorNumber) !== want) continue;
      const yearMatch = parsed.years.length && item.year && parsed.years.includes(Number(item.year));
      if (parsed.years.length && item.year && !yearMatch) continue;
      candidates.push(fromRarity(item, yearMatch ? "collectorYear" : "collectorNumber", yearMatch ? 0.95 : 0.86));
    }
  }

  const nameHints = [];
  if (parsed.raw && !/^\d{8,14}$/.test(parsed.raw.replace(/\s+/g, ""))) {
    if (!toySet.has(normalizeToy(parsed.raw)) && !normalizeCollector(parsed.raw)) {
      nameHints.push(parsed.raw);
    }
  }
  for (const line of String(text || "").split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed.length >= 4) nameHints.push(trimmed);
  }

  for (const hint of nameHints) {
    let best = null;
    for (const item of items) {
      const score = Math.max(nameSimilarity(hint, item.name), nameSimilarity(hint, item.casting || ""));
      if (score < 0.78) continue;
      if (parsed.years.length && item.year && !parsed.years.includes(Number(item.year)) && score < 0.97) {
        continue;
      }
      if (!best || score > best.score) best = { item, score };
    }
    if (best) {
      const exact = best.score >= 0.999;
      candidates.push(fromRarity(best.item, exact ? "name" : "nameFuzzy", exact ? 0.9 : Math.min(0.89, 0.7 + best.score * 0.2)));
    }
  }

  const uniqueCandidates = dedupeBy(candidates, (row) => `${row.source}:${row.id}`).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name).localeCompare(String(b.name));
  });

  const best = uniqueCandidates[0] || alreadyOwned[0] || null;
  const prefill = best
    ? {
        name: best.name || "",
        series: best.series || "",
        year: best.year ?? "",
        color: best.color || "",
        toyNumber: best.toyNumber || parsed.toyNumbers[0] || "",
        casting: best.casting || "",
        upc: upcCode || best.upc || "",
        imageUrl: best.imageUrl || "",
        collectorNumber: best.collectorNumber || parsed.collectorNumbers[0] || "",
        rarityBadges: best.rarityBadges || [],
        isRare: Boolean(best.isRare),
        valueEstimate: best.valueEstimate || "",
      }
    : {
        name: "",
        series: "",
        year: parsed.years[0] || "",
        color: "",
        toyNumber: parsed.toyNumbers[0] || "",
        casting: "",
        upc: upcCode,
        imageUrl: "",
        collectorNumber: parsed.collectorNumbers[0] || "",
        rarityBadges: [],
        isRare: false,
        valueEstimate: "",
      };

  return {
    query: {
      raw: parsed.raw,
      upc: upcCode,
      toyNumbers: parsed.toyNumbers,
      collectorNumbers: parsed.collectorNumbers,
      years: parsed.years,
    },
    alreadyOwned,
    candidates: uniqueCandidates,
    prefill,
  };
}

module.exports = {
  normalizeUpc,
  extractToyNumbers,
  extractCollectorNumbers,
  extractYears,
  extractUpcs,
  nameSimilarity,
  parseScanInput,
  lookupScan,
};
