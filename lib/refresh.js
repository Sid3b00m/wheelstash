"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isoWeekKey } = require("./hunt");
const rarityLib = require("./rarity");
const huntLib = require("./hunt");

const PRICE_NOTE = "No live free price API is available. Weekly refresh re-merges the shipped seed into your rarity list (your edits are kept) and regenerates the hunt list. Dollar figures stay estimates unless you change them or the seed file itself is updated.";

const MERGE_FIELDS = [
  "name", "series", "year", "color", "toyNumber", "collectorNumber",
  "category", "valueEstimate", "valueIsEstimate", "huntEligible", "notes",
];

function statePath(dataDir) {
  return path.join(dataDir, "refresh-state.json");
}

function snapshotPath(dataDir) {
  return path.join(dataDir, "seed-snapshot.json");
}

function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function loadRefreshState(dataDir) {
  return readJsonSafe(statePath(dataDir), null);
}

function saveRefreshState(dataDir, state) {
  writeJsonAtomic(statePath(dataDir), state);
}

function loadSeedSnapshot(dataDir) {
  return readJsonSafe(snapshotPath(dataDir), { items: [] });
}

function itemKey(item) {
  const toy = rarityLib.normalizeToy(item.toyNumber);
  if (toy && item.year) return `toy:${toy}:${item.year}`;
  if (toy) return `toy:${toy}`;
  return `name:${rarityLib.normalizeText(item.name)}:${item.year || ""}:${item.category || ""}`;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  return String(a ?? "") === String(b ?? "");
}

function mergeSeedIntoRarity(userRarity, seed, previousSeedItems) {
  const omitted = new Set(userRarity.omittedIds || []);
  const prevById = new Map((previousSeedItems || []).map((item) => [item.id, item]));
  const userItems = [...(userRarity.items || [])];
  const byId = new Map(userItems.map((item) => [item.id, item]));
  const byKey = new Map(userItems.map((item) => [itemKey(item), item]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let preservedEdits = 0;

  for (const seedItem of seed.items || []) {
    if (omitted.has(seedItem.id)) continue;
    let current = byId.get(seedItem.id) || byKey.get(itemKey(seedItem));
    if (!current) {
      userItems.push({ ...seedItem });
      byId.set(seedItem.id, userItems[userItems.length - 1]);
      byKey.set(itemKey(seedItem), userItems[userItems.length - 1]);
      added += 1;
      continue;
    }
    const prev = prevById.get(seedItem.id) || seedItem;
    let changed = false;
    let preserved = false;
    for (const field of MERGE_FIELDS) {
      const userVal = current[field];
      const seedVal = seedItem[field];
      const prevVal = prev[field];
      const userEmpty = userVal == null || userVal === "";
      if (userEmpty) {
        if (!valuesEqual(userVal, seedVal)) {
          current[field] = seedVal;
          changed = true;
        }
      } else if (valuesEqual(userVal, prevVal)) {
        if (!valuesEqual(userVal, seedVal)) {
          current[field] = seedVal;
          changed = true;
        }
      } else if (!valuesEqual(userVal, seedVal)) {
        preserved = true;
      }
    }
    if (changed) updated += 1;
    else unchanged += 1;
    if (preserved) preservedEdits += 1;
  }

  const seedCategories = new Map((seed.categories || []).map((c) => [c.id, c]));
  const userCategories = userRarity.categories || [];
  const mergedCategories = [...userCategories];
  for (const cat of seed.categories || []) {
    if (!mergedCategories.some((c) => c.id === cat.id)) mergedCategories.push(cat);
  }
  // Refresh descriptions for seed categories the user has not renamed
  for (const cat of mergedCategories) {
    const fromSeed = seedCategories.get(cat.id);
    if (fromSeed && (!cat.label || cat.label === fromSeed.label)) Object.assign(cat, fromSeed);
  }

  const merged = {
    ...userRarity,
    source: seed.source || userRarity.source,
    categories: mergedCategories,
    items: userItems,
    omittedIds: [...omitted],
  };

  return {
    rarity: merged,
    stats: { added, updated, unchanged, preservedEdits, omitted: omitted.size },
  };
}

function isWeekStale(state, now = new Date()) {
  if (!state || !state.lastRunIsoWeek) return true;
  return state.lastRunIsoWeek !== isoWeekKey(now);
}

async function runRefresh({ dataDir, seedPath, db, trigger, listCars }) {
  const startedAt = new Date();
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const userRarity = rarityLib.loadRarity(dataDir, seedPath);
  const previous = loadSeedSnapshot(dataDir);
  const previousItems = previous.items || (previous === userRarity ? [] : previous.items) || [];

  const merged = mergeSeedIntoRarity(userRarity, seed, previousItems);
  const rarity = merged.rarity;

  rarityLib.saveRarity(dataDir, rarity);
  writeJsonAtomic(snapshotPath(dataDir), { mergedAt: startedAt.toISOString(), items: seed.items || [] });

  const cars = listCars();
  const hunt = huntLib.getHuntList(dataDir, rarity, cars, { force: true });

  const state = {
    lastRunAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    lastRunIsoWeek: isoWeekKey(startedAt),
    lastRunTrigger: trigger,
    ok: true,
    priceNote: PRICE_NOTE,
    steps: {
      seedMerge: merged.stats,
      hunt: { isoWeek: hunt.isoWeek, total: hunt.summary?.total ?? hunt.items.length },
    },
  };
  saveRefreshState(dataDir, state);
  return { ...state, hunt, rarity };
}

function scheduleConfig() {
  const enabledRaw = process.env.REFRESH_ENABLED;
  const enabled = enabledRaw == null || enabledRaw === ""
    ? true
    : !["0", "false", "off", "no"].includes(String(enabledRaw).toLowerCase());
  const cronExpr = process.env.REFRESH_CRON || "0 6 * * 1";
  const tz = process.env.TZ || null;
  return { enabled, cronExpr, tz };
}

module.exports = {
  PRICE_NOTE,
  loadRefreshState,
  saveRefreshState,
  isWeekStale,
  mergeSeedIntoRarity,
  runRefresh,
  scheduleConfig,
};
