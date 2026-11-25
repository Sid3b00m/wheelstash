"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  lookupStockImage,
  fetchYearSeriesFiles,
  fetchYearCarCultureFiles,
  imageInfo,
  canonFile,
  attributionFor,
  sleep: fandomSleep,
} = require("./fandom");

const UA = "HotWheelsTracker/1.1 (self-hosted local collection app; caches Hot Wheels Wiki images with attribution)";
const MAX_BYTES = 6 * 1024 * 1024;
const ALLOWED = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function stockDir(dataDir) {
  const dir = path.join(dataDir, "stock");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isLocalUpload(url) {
  return String(url || "").startsWith("/uploads/");
}

function isStockPath(url) {
  return String(url || "").startsWith("/stock/");
}

function stockFilePath(url, dataDir) {
  const match = String(url || "").match(/^\/stock\/([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const dir = path.resolve(stockDir(dataDir));
  const full = path.resolve(dir, match[1]);
  if (path.dirname(full) !== dir) return null;
  return full;
}

function stockFileExists(url, dataDir) {
  const full = stockFilePath(url, dataDir);
  if (!full) return false;
  try {
    const st = fs.statSync(full);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function findCachedByHash(sourceUrl, dataDir) {
  const hash = crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16);
  const dir = stockDir(dataDir);
  for (const ext of ["webp", "jpg", "png", "gif"]) {
    const name = `stock-${hash}.${ext}`;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.size > 0) return `/stock/${name}`;
    } catch { /* ignore */ }
  }
  return null;
}

function displayImage(car) {
  if (!car) return "";
  const pref = car.imagePref === "own" ? "own" : "stock";
  if (pref === "own" && car.ownImageUrl) return car.ownImageUrl;
  if (car.stockImageUrl) return car.stockImageUrl;
  if (car.ownImageUrl) return car.ownImageUrl;
  return car.imageUrl || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => sleep(200), () => sleep(200));
  return run;
}

function extFrom(contentType, sourceUrl) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ALLOWED[mime]) return ALLOWED[mime];
  const m = String(sourceUrl || "").match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i);
  if (!m) return "";
  return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
}

async function downloadImage(sourceUrl, dataDir) {
  const existing = findCachedByHash(sourceUrl, dataDir);
  if (existing) return existing;
  const res = await fetch(sourceUrl, {
    headers: { "User-Agent": UA, Accept: "image/*" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Image download HTTP ${res.status}`);
  const ext = extFrom(res.headers.get("content-type"), sourceUrl);
  if (!ext) throw new Error("That wiki file is not a supported image type.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("The wiki image was empty.");
  if (buf.length > MAX_BYTES) throw new Error("The wiki image is too large to cache.");
  const hash = crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16);
  const name = `stock-${hash}.${ext}`;
  fs.writeFileSync(path.join(stockDir(dataDir), name), buf);
  return `/stock/${name}`;
}

async function fetchAndCache(car, dataDir, { excludeUrls = [] } = {}) {
  const found = await lookupStockImage(car, { excludeUrls });
  if (!found?.sourceUrl) return null;
  const localUrl = await downloadImage(found.sourceUrl, dataDir);
  return {
    stockImageUrl: localUrl,
    stockSourceUrl: found.sourceUrl,
    stockPageUrl: found.pageUrl || "",
    stockAttribution: found.attribution || "",
    stockTitle: found.title || "",
  };
}

async function lookupQueued(car, dataDir, options) {
  return enqueue(() => fetchAndCache(car, dataDir, options));
}

function uploadDir(dataDir) {
  const dir = path.join(dataDir, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localUploadPath(url, dataDir) {
  const match = String(url || "").match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const dir = path.resolve(uploadDir(dataDir));
  const full = path.resolve(dir, match[1]);
  if (path.dirname(full) !== dir) return null;
  return full;
}

function deleteLocalUpload(url, dataDir) {
  const full = localUploadPath(url, dataDir);
  if (!full) return 0;
  try {
    const size = fs.statSync(full).size;
    fs.unlinkSync(full);
    return size;
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
}

function referencedUploads(cars) {
  const used = new Set();
  for (const car of cars || []) {
    for (const url of [car.ownImageUrl, car.imageUrl]) {
      const match = String(url || "").match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
      if (match) used.add(match[1]);
    }
  }
  return used;
}

function discardOwnPhotoIfStock(dbLib, db, car, dataDir) {
  if (!car?.stockImageUrl) return { car, freed: 0, discarded: false };
  const own = car.ownImageUrl
    || (isLocalUpload(car.imageUrl) && car.imageUrl !== car.stockImageUrl ? car.imageUrl : "");
  if (!own && car.imagePref !== "own") return { car, freed: 0, discarded: false };
  const freed = own ? deleteLocalUpload(own, dataDir) : 0;
  const updated = dbLib.setCarStock(db, car.id, {
    stockImageUrl: car.stockImageUrl,
    stockSourceUrl: car.stockSourceUrl,
    stockPageUrl: car.stockPageUrl,
    stockAttribution: car.stockAttribution,
  }, { imagePref: "stock", clearOwn: true }) || car;
  return { car: updated, freed, discarded: Boolean(own), name: updated.name, url: own, id: updated.id };
}

function cleanupOwnPhotos(dbLib, db, dataDir) {
  const cars = dbLib.listCars(db);
  const result = {
    freed: 0,
    carsCleared: [],
    orphansDeleted: [],
    orphanBytes: 0,
    upcCleared: 0,
  };
  for (const car of cars) {
    const discarded = discardOwnPhotoIfStock(dbLib, db, car, dataDir);
    result.freed += discarded.freed;
    if (discarded.discarded) {
      result.carsCleared.push({ id: discarded.id, name: discarded.name, url: discarded.url, bytes: discarded.freed });
    }
  }
  const kept = referencedUploads(dbLib.listCars(db));
  if (typeof dbLib.pruneUpcUploadUrls === "function") {
    result.upcCleared = dbLib.pruneUpcUploadUrls(db, kept);
  }
  const dir = uploadDir(dataDir);
  for (const name of fs.readdirSync(dir)) {
    if (name === ".gitkeep" || name.startsWith(".")) continue;
    if (kept.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      fs.unlinkSync(full);
      result.freed += st.size;
      result.orphanBytes += st.size;
      result.orphansDeleted.push({ name, bytes: st.size });
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }
  return result;
}

let prefetchInFlight = null;
let prefetchState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  cached: 0,
  found: 0,
  missing: 0,
  skippedUser: 0,
  errors: [],
};

function getPrefetchStatus() {
  return {
    ...prefetchState,
    errors: prefetchState.errors.slice(-10),
  };
}

function applyPrefetchUpdates(dataDir, seedPath, rarityLib, updatesById) {
  if (!updatesById.size) return;
  const latest = rarityLib.loadRarity(dataDir, seedPath);
  let changed = false;
  for (const item of latest.items || []) {
    const patch = updatesById.get(item.id);
    if (!patch) continue;
    if (item.imageSource === "user" || isLocalUpload(item.imageUrl)) continue;
    item.imageUrl = patch.imageUrl;
    item.imageSource = patch.imageSource;
    item.imagePageUrl = patch.imagePageUrl;
    item.imageAttribution = patch.imageAttribution;
    changed = true;
  }
  if (changed) rarityLib.saveRarity(dataDir, latest);
  updatesById.clear();
}

async function prefetchRarityImages({ dataDir, seedPath, rarityLib, force = false } = {}) {
  if (prefetchInFlight) return prefetchInFlight;
  prefetchInFlight = (async () => {
    const rarity = rarityLib.loadRarity(dataDir, seedPath);
    const items = rarity.items || [];
    prefetchState = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: items.length,
      cached: 0,
      found: 0,
      missing: 0,
      skippedUser: 0,
      errors: [],
    };

    const needRemoteCache = [];
    const needLookup = [];
    for (const item of items) {
      if (item.imageSource === "user" || isLocalUpload(item.imageUrl)) {
        prefetchState.skippedUser += 1;
        continue;
      }
      if (!force && isStockPath(item.imageUrl) && stockFileExists(item.imageUrl, dataDir)) {
        prefetchState.cached += 1;
        continue;
      }
      if (!force && /^https?:\/\//i.test(String(item.imageUrl || ""))) {
        needRemoteCache.push(item);
        continue;
      }
      needLookup.push(item);
    }

    const pendingUpdates = new Map();
    const recordFound = (item, patch) => {
      pendingUpdates.set(item.id, patch);
      prefetchState.found += 1;
      prefetchState.cached += 1;
      if (pendingUpdates.size >= 10) {
        applyPrefetchUpdates(dataDir, seedPath, rarityLib, pendingUpdates);
      }
    };

    // 1) Cache any existing external URLs locally into /stock/
    for (const item of needRemoteCache) {
      try {
        const localUrl = await enqueue(() => downloadImage(item.imageUrl, dataDir));
        recordFound(item, {
          imageUrl: localUrl,
          imageSource: item.imageSource || "fandom",
          imagePageUrl: item.imagePageUrl || "",
          imageAttribution: item.imageAttribution || "",
        });
      } catch (err) {
        prefetchState.errors.push(`${item.name}: ${err.message}`);
        needLookup.push(item);
      }
    }

    if (needLookup.length) {
      // 2) Batch-resolve TH/STH from Treasure Hunts Series pages and CHASE from Car Culture pages.
      const thYears = new Set();
      const ccYears = new Set();
      for (const item of needLookup) {
        if (!item.year) continue;
        if (item.category === "TH" || item.category === "STH") thYears.add(Number(item.year));
        if (item.category === "CHASE") ccYears.add(Number(item.year));
      }

      const tableMatches = new Map(); // item.id -> { file, pageTitle }
      const thPages = new Map();
      for (const year of [...thYears].sort()) {
        try {
          const page = await enqueue(() => fetchYearSeriesFiles(year));
          if (page.ok) thPages.set(year, page);
        } catch (err) {
          prefetchState.errors.push(`TH series ${year}: ${err.message}`);
        }
      }
      const ccPages = new Map();
      for (const year of [...ccYears].sort()) {
        try {
          const page = await enqueue(() => fetchYearCarCultureFiles(year));
          if (page.ok) ccPages.set(year, page);
        } catch (err) {
          prefetchState.errors.push(`Car Culture ${year}: ${err.message}`);
        }
      }

      const filesNeeded = [];
      for (const item of needLookup) {
        const toy = String(item.toyNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!toy || !item.year) continue;
        const page = (item.category === "TH" || item.category === "STH")
          ? thPages.get(Number(item.year))
          : (item.category === "CHASE" ? ccPages.get(Number(item.year)) : null);
        const file = page?.files?.get(toy);
        if (file) {
          filesNeeded.push(file);
          tableMatches.set(item.id, { file, pageTitle: page.title });
        }
      }

      let fileUrls = new Map();
      if (filesNeeded.length) {
        try {
          fileUrls = await enqueue(() => imageInfo(filesNeeded));
        } catch (err) {
          prefetchState.errors.push(`imageinfo: ${err.message}`);
        }
      }

      // 3) Download table matches and fall back to lookupQueued for any remaining items.
      for (const item of needLookup) {
        const tm = tableMatches.get(item.id);
        const sourceUrl = tm ? (fileUrls.get(canonFile(tm.file)) || fileUrls.get(tm.file)) : null;
        if (sourceUrl) {
          try {
            const localUrl = await enqueue(() => downloadImage(sourceUrl, dataDir));
            const pageUrl = `https://hotwheels.fandom.com/wiki/${encodeURIComponent(tm.pageTitle.replace(/ /g, "_"))}`;
            recordFound(item, {
              imageUrl: localUrl,
              imageSource: "fandom",
              imagePageUrl: pageUrl,
              imageAttribution: attributionFor(tm.pageTitle),
            });
            continue;
          } catch (err) {
            prefetchState.errors.push(`${item.name}: ${err.message}`);
          }
        }

        try {
          const stock = await lookupQueued(item, dataDir);
          if (stock?.stockImageUrl) {
            recordFound(item, {
              imageUrl: stock.stockImageUrl,
              imageSource: "fandom",
              imagePageUrl: stock.stockPageUrl || "",
              imageAttribution: stock.stockAttribution || "",
            });
            continue;
          }
        } catch (err) {
          prefetchState.errors.push(`${item.name}: ${err.message}`);
        }
        prefetchState.missing += 1;
      }
    }

    applyPrefetchUpdates(dataDir, seedPath, rarityLib, pendingUpdates);
    prefetchState.running = false;
    prefetchState.finishedAt = new Date().toISOString();
    await fandomSleep(0);
    return getPrefetchStatus();
  })().catch((err) => {
    prefetchState.running = false;
    prefetchState.finishedAt = new Date().toISOString();
    prefetchState.errors.push(err.message);
    throw err;
  }).finally(() => {
    prefetchInFlight = null;
  });
  return prefetchInFlight;
}

module.exports = {
  stockDir,
  uploadDir,
  isLocalUpload,
  isStockPath,
  stockFileExists,
  displayImage,
  lookupQueued,
  fetchAndCache,
  downloadImage,
  deleteLocalUpload,
  discardOwnPhotoIfStock,
  cleanupOwnPhotos,
  prefetchRarityImages,
  getPrefetchStatus,
};
