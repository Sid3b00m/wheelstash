"use strict";

const API = "https://hotwheels.fandom.com/api.php";
const UA = "HotWheelsTracker/1.1 (self-hosted local collection app; optional MediaWiki image lookup)";
const PLACEHOLDER_FILES = new Set([
  "ina.jpg",
  "image not available.jpg",
  "imagenotavailable.jpg",
  "rth.png",
  "sth.png",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wikiGet(params) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ format: "json", formatversion: "2", ...params })) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Fandom API HTTP ${res.status}`);
  return res.json();
}

function canonFile(title) {
  return String(title || "")
    .replace(/^File:/i, "File:")
    .replace(/_/g, " ")
    .trim();
}

function isUsableFile(title) {
  const name = String(title || "").replace(/^File:/i, "").trim().toLowerCase();
  if (!name) return false;
  if (PLACEHOLDER_FILES.has(name)) return false;
  return true;
}

function isSketchOrPoster(title) {
  return /sketch|autograph|poster|sheet|diagram|logo|cardback/i.test(String(title || ""));
}

function parseSeriesWikitext(wikitext) {
  const map = new Map(); // toyNumber -> file title
  const rows = String(wikitext || "").split(/\n\|-/);
  for (const row of rows) {
    const toy = row.match(/\n\|([A-Z]{2,4}\d{2,5})\s*(?:\n|$)/i);
    const file = row.match(/\[\[File:([^\]|]+)/i);
    if (!toy || !file) continue;
    const toyNumber = toy[1].toUpperCase();
    const fileTitle = `File:${file[1].trim()}`;
    if (!isUsableFile(fileTitle)) continue;
    if (!map.has(toyNumber)) map.set(toyNumber, fileTitle);
  }
  return map;
}

async function fetchSeriesPageFiles(title) {
  const data = await wikiGet({ action: "parse", page: title, prop: "wikitext" });
  const wikitext = data?.parse?.wikitext;
  const text = typeof wikitext === "string" ? wikitext : wikitext?.["*"] || "";
  if (!text) return { title, files: new Map(), ok: false, reason: "empty wikitext" };
  return { title, files: parseSeriesWikitext(text), ok: true };
}

async function fetchYearSeriesFiles(year) {
  return fetchSeriesPageFiles(`${year} Treasure Hunts Series`);
}

async function fetchYearCarCultureFiles(year) {
  return fetchSeriesPageFiles(`${year} Car Culture`);
}

async function imageInfo(fileTitles) {
  const urls = new Map();
  const unique = [...new Set(fileTitles.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const data = await wikiGet({
      action: "query",
      titles: chunk.join("|"),
      prop: "imageinfo",
      iiprop: "url|mime|size",
      iiurlwidth: "320",
    });
    for (const page of data?.query?.pages || []) {
      const info = page.imageinfo && page.imageinfo[0];
      if (page.missing || !info) continue;
      const thumb = info.thumburl || info.url;
      if (thumb) {
        urls.set(canonFile(page.title), thumb);
        if (page.title) urls.set(page.title, thumb);
      }
    }
    if (i + 40 < unique.length) await sleep(150);
  }
  return urls;
}

async function pageImageForName(name) {
  if (!name) return null;
  const search = await wikiGet({ action: "query", list: "search", srsearch: name, srlimit: "5" });
  const hits = search?.query?.search || [];
  const titles = hits
    .map((hit) => hit.title)
    .filter((title) => title && !/Treasure Hunts Series|List of /i.test(title));
  if (!titles.length) return null;
  const data = await wikiGet({
    action: "query",
    titles: titles.slice(0, 5).join("|"),
    prop: "pageimages|info",
    inprop: "url",
    piprop: "thumbnail",
    pithumbsize: "320",
  });
  for (const page of data?.query?.pages || []) {
    const thumb = page.thumbnail?.source;
    if (thumb) {
      return {
        imageUrl: thumb,
        imagePageUrl: page.fullurl || page.canonicalurl || `https://hotwheels.fandom.com/wiki/${encodeURIComponent(page.title)}`,
        imageTitle: page.title,
      };
    }
  }
  return null;
}

async function fillFandomImages(items, { years } = {}) {
  const result = {
    enabled: true,
    ok: true,
    seriesPages: [],
    imagesFilled: 0,
    alreadyHad: 0,
    skippedUser: 0,
    missing: 0,
    errors: [],
  };
  const need = [];
  for (const item of items) {
    if (item.imageUrl && item.imageSource === "user") {
      result.skippedUser += 1;
      continue;
    }
    if (item.imageUrl && item.imageSource !== "fandom") {
      result.alreadyHad += 1;
      continue;
    }
    if (item.imageUrl && item.imageSource === "fandom") {
      result.alreadyHad += 1;
      continue; // keep existing auto-filled image unless missing
    }
    need.push(item);
  }

  const yearSet = new Set(years || []);
  for (const item of items) {
    if (item.year && (item.category === "TH" || item.category === "STH")) yearSet.add(Number(item.year));
  }

  const toyToFile = new Map();
  const pageByYear = new Map();
  for (const year of [...yearSet].sort()) {
    try {
      const page = await fetchYearSeriesFiles(year);
      result.seriesPages.push({ year, title: page.title, files: page.files.size, ok: page.ok });
      if (page.ok) {
        pageByYear.set(year, page.title);
        for (const [toy, file] of page.files) toyToFile.set(`${year}:${toy}`, file);
      }
      await sleep(150);
    } catch (err) {
      result.errors.push(`Series page ${year}: ${err.message}`);
    }
  }

  const filesNeeded = [];
  const assignment = [];
  for (const item of need) {
    const toy = String(item.toyNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const file = toy && item.year ? toyToFile.get(`${item.year}:${toy}`) : null;
    if (file) {
      filesNeeded.push(file);
      assignment.push({ item, file, year: item.year });
    } else {
      assignment.push({ item, file: null });
    }
  }

  let urls = new Map();
  try {
    urls = await imageInfo(filesNeeded);
  } catch (err) {
    result.errors.push(`imageinfo: ${err.message}`);
  }

  for (const row of assignment) {
    const { item, file, year } = row;
    const fileKey = file ? canonFile(file) : null;
    const imageUrl = (fileKey && (urls.get(fileKey) || urls.get(file))) || null;
    if (file && imageUrl) {
      const pageTitle = pageByYear.get(year) || `${year} Treasure Hunts Series`;
      item.imageUrl = imageUrl;
      item.imageSource = "fandom";
      item.imagePageUrl = `https://hotwheels.fandom.com/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
      item.imageAttribution = `Photo from Hot Wheels Wiki (Fandom), ${pageTitle}. Community content is CC-BY-SA; product appearance is a Mattel trademark.`;
      result.imagesFilled += 1;
      continue;
    }
    try {
      const fallback = await pageImageForName(item.toyNumber ? `${item.toyNumber} ${item.name}` : item.name);
      await sleep(120);
      if (fallback?.imageUrl) {
        item.imageUrl = fallback.imageUrl;
        item.imageSource = "fandom";
        item.imagePageUrl = fallback.imagePageUrl;
        item.imageAttribution = `Photo from Hot Wheels Wiki (Fandom) page “${fallback.imageTitle}”. Community content is CC-BY-SA; product appearance is a Mattel trademark. May show a different variant of the same casting.`;
        result.imagesFilled += 1;
        continue;
      }
    } catch (err) {
      result.errors.push(`${item.name}: ${err.message}`);
    }
    result.missing += 1;
  }

  if (result.errors.length && result.imagesFilled === 0) result.ok = false;
  return result;
}


function scorePage(page, car) {
  const title = String(page.title || "").toLowerCase();
  if (/treasure hunts series|list of |main page|category:/i.test(title)) return -100;
  let score = 0;
  const toy = String(car.toyNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(car.name || "").toLowerCase();
  const casting = String(car.casting || "").toLowerCase();
  const series = String(car.series || "").toLowerCase();
  const color = String(car.color || "").toLowerCase();
  const year = car.year ? String(car.year) : "";
  if (toy && title.replace(/[^a-z0-9]/g, "").includes(toy.toLowerCase())) score += 8;
  if (name && title.includes(name)) score += 6;
  if (casting && title.includes(casting)) score += 4;
  if (year && title.includes(year)) score += 3;
  if (series && title.includes(series)) score += 2;
  if (color && title.includes(color)) score += 2;
  if (page.thumbnail?.source || page.pageimage) score += 1;
  return score;
}

function attributionFor(title) {
  return `Photo from Hot Wheels Wiki (Fandom) page “${title}”. Community content is CC-BY-SA; product appearance is a Mattel trademark.`;
}

async function searchWiki(query, limit = 8) {
  const data = await wikiGet({ action: "query", list: "search", srsearch: query, srlimit: String(limit) });
  return (data?.query?.search || []).map((hit) => hit.title).filter(Boolean);
}

async function pagesWithImages(titles) {
  const unique = [...new Set(titles.filter(Boolean))].slice(0, 10);
  if (!unique.length) return [];
  const data = await wikiGet({
    action: "query",
    titles: unique.join("|"),
    prop: "pageimages|info|images",
    inprop: "url",
    piprop: "thumbnail|name",
    pithumbsize: "800",
    imlimit: "20",
  });
  return data?.query?.pages || [];
}

async function lookupStockImage(car, { excludeUrls = [] } = {}) {
  const skip = new Set((excludeUrls || []).filter(Boolean));
  const toy = String(car.toyNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(car.name || "").trim();
  const casting = String(car.casting || "").trim();
  const series = String(car.series || "").trim();
  const color = String(car.color || "").trim();
  const year = car.year ? String(car.year) : "";
  const queries = [];
  const add = (q) => { if (q && !queries.includes(q)) queries.push(q); };
  if (toy) add(toy);
  if (toy && name) add(`${toy} ${name}`);
  if (name && year) add(`${name} ${year}`);
  if (name && series) add(`"${name}" ${series}`);
  if (name && color) add(`${name} ${color}`);
  if (name) add(name);
  if (casting && casting.toLowerCase() !== name.toLowerCase()) add(casting);

  // Prefer a year-series table match when this looks like a Treasure Hunt or Car Culture Chase.
  if (toy && year && (/treasure|sth|\bth\b/i.test(`${series} ${name} ${car.category || ""}`) || car.category === "STH" || car.category === "TH")) {
    try {
      const page = await fetchYearSeriesFiles(Number(year));
      const file = page.files.get(toy);
      if (file) {
        const urls = await imageInfo([file]);
        const imageUrl = urls.get(canonFile(file)) || urls.get(file);
        if (imageUrl && !skip.has(imageUrl)) {
          return {
            sourceUrl: imageUrl,
            pageUrl: `https://hotwheels.fandom.com/wiki/${encodeURIComponent((page.title || "").replace(/ /g, "_"))}`,
            title: page.title,
            fileTitle: file,
            attribution: attributionFor(page.title),
          };
        }
      }
      await sleep(150);
    } catch (_) { /* fall through to search */ }
  }

  if (toy && year && (/chase|car culture|historics|modern classics|circuit|power trip|road trip|thrill|vintage|aerostyles/i.test(`${series} ${name} ${car.category || ""}`) || car.category === "CHASE")) {
    try {
      const page = await fetchYearCarCultureFiles(Number(year));
      const file = page.files.get(toy);
      if (file) {
        const urls = await imageInfo([file]);
        const imageUrl = urls.get(canonFile(file)) || urls.get(file);
        if (imageUrl && !skip.has(imageUrl)) {
          return {
            sourceUrl: imageUrl,
            pageUrl: `https://hotwheels.fandom.com/wiki/${encodeURIComponent((page.title || "").replace(/ /g, "_"))}`,
            title: page.title,
            fileTitle: file,
            attribution: attributionFor(page.title),
          };
        }
      }
      await sleep(150);
    } catch (_) { /* fall through to search */ }
  }

  const titles = [];
  for (const query of queries.slice(0, 4)) {
    try {
      const hits = await searchWiki(query, 8);
      for (const title of hits) {
        if (!titles.includes(title)) titles.push(title);
      }
      await sleep(150);
    } catch (_) { /* try the next query */ }
  }

  const pages = titles.length ? await pagesWithImages(titles) : [];
  const ranked = pages
    .map((page) => ({ page, score: scorePage(page, car) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { page } of ranked) {
    const thumb = page.thumbnail?.source;
    const files = (page.images || [])
      .map((img) => img.title)
      .filter((title) => isUsableFile(title) && /\.(jpe?g|png|webp|gif)$/i.test(title));
    const orderedFiles = [
      ...files.filter((t) => !isSketchOrPoster(t)),
      ...files.filter((t) => isSketchOrPoster(t)),
    ];
    if (thumb && isUsableFile(page.pageimage || "") && !isSketchOrPoster(page.pageimage || "") && !skip.has(thumb)) {
      return {
        sourceUrl: thumb,
        pageUrl: page.fullurl || page.canonicalurl || `https://hotwheels.fandom.com/wiki/${encodeURIComponent(page.title)}`,
        title: page.title,
        fileTitle: page.pageimage ? `File:${page.pageimage}` : "",
        attribution: attributionFor(page.title),
      };
    }
    if (orderedFiles.length) {
      try {
        const urls = await imageInfo(orderedFiles.slice(0, 8));
        await sleep(150);
        for (const file of orderedFiles) {
        const imageUrl = urls.get(canonFile(file)) || urls.get(file);
        if (imageUrl && !skip.has(imageUrl)) {
          return {
            sourceUrl: imageUrl,
            pageUrl: page.fullurl || page.canonicalurl || `https://hotwheels.fandom.com/wiki/${encodeURIComponent(page.title)}`,
            title: page.title,
            fileTitle: file,
            attribution: attributionFor(page.title),
          };
          }
        }
      } catch (_) { /* try thumbnail fallback */ }
    }
    if (thumb && isUsableFile(page.pageimage || "") && !skip.has(thumb)) {
      return {
        sourceUrl: thumb,
        pageUrl: page.fullurl || page.canonicalurl || `https://hotwheels.fandom.com/wiki/${encodeURIComponent(page.title)}`,
        title: page.title,
        fileTitle: page.pageimage ? `File:${page.pageimage}` : "",
        attribution: attributionFor(page.title),
      };
    }
  }
  return null;
}

module.exports = {
  fillFandomImages,
  parseSeriesWikitext,
  lookupStockImage,
  fetchYearSeriesFiles,
  fetchYearCarCultureFiles,
  imageInfo,
  canonFile,
  isUsableFile,
  attributionFor,
  sleep,
};
