"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function rarityPath(dataDir) {
  return path.join(dataDir, "rarity.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function ensureRarityFile(dataDir, seedPath) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dest = rarityPath(dataDir);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(seedPath, dest);
  }
  return dest;
}

function loadRarity(dataDir, seedPath) {
  ensureRarityFile(dataDir, seedPath);
  return visibleRarity(readJson(rarityPath(dataDir)));
}

function saveRarity(dataDir, data) {
  writeJsonAtomic(rarityPath(dataDir), data);
}

function resetRarity(dataDir, seedPath) {
  fs.copyFileSync(seedPath, rarityPath(dataDir));
  return visibleRarity(readJson(rarityPath(dataDir)));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’"“”]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeToy(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function matchCar(car, items) {
  const toy = normalizeToy(car.toyNumber);
  const names = new Set(
    [car.name, car.casting].map(normalizeText).filter(Boolean)
  );
  const year = car.year == null || car.year === "" ? null : Number(car.year);
  const matches = [];

  for (const item of items) {
    const itemToy = normalizeToy(item.toyNumber);
    if (toy && itemToy && toy === itemToy) {
      matches.push({ ...item, matchReason: "toyNumber" });
      continue;
    }
    const itemName = normalizeText(item.name);
    if (!itemName || !names.has(itemName)) continue;
    const itemYear = item.year == null ? null : Number(item.year);
    if (year && itemYear && year !== itemYear) continue;
    matches.push({ ...item, matchReason: "nameYear" });
  }

  const seen = new Set();
  return matches.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function attachMatches(cars, rarity) {
  const items = rarity.items || [];
  return cars.map((car) => {
    const matches = matchCar(car, items);
    return {
      ...car,
      rarityMatches: matches,
      isRare: matches.length > 0,
      rarityBadges: [...new Set(matches.map((m) => m.category))],
    };
  });
}



function isUserProvidedImage(item) {
  const url = String(item?.imageUrl || "");
  if (!url) return false;
  const source = String(item?.imageSource || "").trim().toLowerCase();
  if (source && source !== "user") return false;
  if (url.startsWith("/uploads/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function visibleRarityItem(item) {
  if (!item || isUserProvidedImage(item)) return item;
  if (!item.imageUrl && !item.imageSource) return item;
  return { ...item, imageUrl: "", imageSource: "", imageAttribution: "", imagePageUrl: "" };
}

function visibleRarity(rarity) {
  if (!rarity) return rarity;
  return {
    ...rarity,
    items: (rarity.items || []).map(visibleRarityItem),
  };
}

function sanitizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("/uploads/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {
    /* ignore */
  }
  const err = new Error("Image URL must be http(s) or a local /uploads/ path.");
  err.status = 400;
  throw err;
}

function validateRarityItem(body, existingId) {
  const name = String(body.name || "").trim();
  if (!name) {
    const err = new Error("Rarity item name is required.");
    err.status = 400;
    throw err;
  }
  const category = String(body.category || "").trim().toUpperCase();
  const allowed = ["STH", "TH", "CHASE", "RLC", "ERROR", "HIGH"];
  if (!allowed.includes(category)) {
    const err = new Error(`Category must be one of: ${allowed.join(", ")}.`);
    err.status = 400;
    throw err;
  }
  let year = body.year;
  if (year === "" || year == null) year = null;
  else {
    year = Number(year);
    if (!Number.isInteger(year) || year < 1968 || year > 2035) {
      const err = new Error("Year must be an integer between 1968 and 2035.");
      err.status = 400;
      throw err;
    }
  }
  const id = existingId || String(body.id || "").trim() ||
    `${category.toLowerCase()}-${year || "x"}-${crypto.randomBytes(3).toString("hex")}`;
  const imageUrl = sanitizeImageUrl(body.imageUrl || body.image_url);
  const explicitSource = String(body.imageSource || body.image_source || "").trim();
  const imageSource = imageUrl ? (explicitSource || "user") : "";
  return {
    id,
    name,
    series: String(body.series || "").trim(),
    year,
    color: String(body.color || "").trim(),
    toyNumber: String(body.toyNumber || body.toy_number || "").trim().toUpperCase(),
    collectorNumber: String(body.collectorNumber || body.collector_number || "").trim(),
    category,
    valueEstimate: String(body.valueEstimate || body.value_estimate || "").trim(),
    valueIsEstimate: body.valueIsEstimate !== false,
    huntEligible: Boolean(body.huntEligible ?? (category === "STH" || category === "TH" || category === "CHASE")),
    notes: String(body.notes || "").trim(),
    imageUrl,
    imageSource: imageSource || (imageUrl ? "user" : ""),
    imageAttribution: String(body.imageAttribution || body.image_attribution || "").trim(),
    imagePageUrl: String(body.imagePageUrl || body.image_page_url || "").trim(),
  };
}

function upsertItem(rarity, item, isNew) {
  const items = rarity.items || [];
  if (isNew) {
    if (items.some((i) => i.id === item.id)) {
      const err = new Error("A rarity item with that id already exists.");
      err.status = 409;
      throw err;
    }
    rarity.items = [...items, item];
  } else {
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx === -1) return null;
    items[idx] = item;
  }
  return item;
}

function removeItem(rarity, id) {
  const items = rarity.items || [];
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const [removed] = items.splice(idx, 1);
  const omitted = new Set(rarity.omittedIds || []);
  omitted.add(id);
  rarity.omittedIds = [...omitted];
  return removed;
}

module.exports = {
  visibleRarityItem,
  visibleRarity,

  loadRarity,
  saveRarity,
  resetRarity,
  matchCar,
  attachMatches,
  validateRarityItem,
  upsertItem,
  removeItem,
  normalizeToy,
  normalizeText,
  sanitizeImageUrl,
};
