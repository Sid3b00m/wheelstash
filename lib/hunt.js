"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeToy, normalizeText, visibleRarityItem } = require("./rarity");

function cachePath(dataDir) {
  return path.join(dataDir, "hunt-cache.json");
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function ownedKeys(cars) {
  const toys = new Set();
  const names = new Set();
  for (const car of cars) {
    const toy = normalizeToy(car.toyNumber);
    if (toy) toys.add(toy);
    const name = normalizeText(car.name);
    const casting = normalizeText(car.casting);
    const year = car.year == null ? "" : String(car.year);
    if (name) names.add(`${name}|${year}`);
    if (casting) names.add(`${casting}|${year}`);
    if (name) names.add(`${name}|`);
  }
  return { toys, names };
}

function isOwned(item, owned) {
  const toy = normalizeToy(item.toyNumber);
  if (toy && owned.toys.has(toy)) return true;
  const name = normalizeText(item.name);
  const year = item.year == null ? "" : String(item.year);
  if (name && owned.names.has(`${name}|${year}`)) return true;
  return false;
}

function priority(item, currentYear) {
  const catBoost = item.category === "STH" ? 30 : item.category === "TH" ? 20 : item.category === "CHASE" ? 10 : 0;
  const year = Number(item.year) || 0;
  let recency = 0;
  if (year === currentYear) recency = 100;
  else if (year === currentYear - 1) recency = 50;
  else if (year === currentYear - 2) recency = 15;
  return recency + catBoost;
}

function generateHuntList(rarity, cars, now = new Date()) {
  const currentYear = now.getFullYear();
  const owned = ownedKeys(cars);
  const candidates = (rarity.items || [])
    .filter((item) => item.huntEligible !== false)
    .filter((item) => ["STH", "TH", "CHASE"].includes(item.category))
    .filter((item) => !item.year || Number(item.year) >= currentYear - 2)
    .map((item) => {
      const ownedFlag = isOwned(item, owned);
      return {
        ...item,
        owned: ownedFlag,
        priority: priority(item, currentYear) - (ownedFlag ? 1000 : 0),
      };
    })
    .sort((a, b) => b.priority - a.priority || String(b.year).localeCompare(String(a.year)) || a.name.localeCompare(b.name));

  const unowned = candidates.filter((c) => !c.owned);
  const ownedRecent = candidates.filter((c) => c.owned);
  const focus = unowned.length ? unowned : candidates;
  // Keep the weekly list focused but complete for current-year STH/TH plus leftover recent STH.
  const list = focus.filter((item) => {
    if (item.owned) return false;
    if (Number(item.year) === currentYear) return true;
    if (Number(item.year) === currentYear - 1 && item.category === "STH") return true;
    return false;
  });

  const items = (list.length ? list : unowned.slice(0, 20)).map(({ priority: _p, ...rest }) => rest);
  return {
    isoWeek: isoWeekKey(now),
    generatedAt: now.toISOString(),
    currentYear,
    summary: {
      total: items.length,
      sth: items.filter((i) => i.category === "STH").length,
      th: items.filter((i) => i.category === "TH").length,
      chase: items.filter((i) => i.category === "CHASE").length,
      alreadyOwnedInCatalog: ownedRecent.length,
    },
    items,
  };
}

function readCache(dataDir) {
  const file = cachePath(dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(dataDir, payload) {
  const file = cachePath(dataDir);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function hydrateHuntImages(hunt, rarity) {
  if (!hunt || !Array.isArray(hunt.items)) return hunt;
  const byId = new Map();
  const byToy = new Map();
  for (const raw of rarity?.items || []) {
    const r = visibleRarityItem(raw);
    if (r.id) byId.set(r.id, r);
    const toy = normalizeToy(r.toyNumber);
    if (toy && !byToy.has(toy)) byToy.set(toy, r);
  }
  return {
    ...hunt,
    items: hunt.items.map((item) => {
      const r = byId.get(item.id) || byToy.get(normalizeToy(item.toyNumber));
      if (r && r.imageUrl) {
        return {
          ...item,
          imageUrl: r.imageUrl,
          imageSource: r.imageSource || "",
          imageAttribution: r.imageAttribution || "",
          imagePageUrl: r.imagePageUrl || "",
        };
      }
      return { ...item, imageUrl: "", imageSource: "", imageAttribution: "", imagePageUrl: "" };
    }),
  };
}

function getHuntList(dataDir, rarity, cars, { force = false, userId = null } = {}) {
  const week = isoWeekKey();
  const key = userId == null ? "all" : String(userId);
  const cached = readCache(dataDir);
  const store = (cached && cached.isoWeek === week)
    ? { isoWeek: week, users: { ...(cached.users || {}) } }
    : { isoWeek: week, users: {} };
  if (!force) {
    const entry = store.users[key];
    if (entry && Array.isArray(entry.items)) {
      return hydrateHuntImages({ ...entry, isoWeek: week, userId: userId == null ? null : Number(userId), cached: true }, rarity);
    }
    // Older single-list cache format, only used when no user is selected.
    if (userId == null && cached && cached.isoWeek === week && Array.isArray(cached.items)) {
      return hydrateHuntImages({ ...cached, cached: true }, rarity);
    }
  }
  const fresh = generateHuntList(rarity, cars);
  store.users[key] = fresh;
  writeCache(dataDir, store);
  return hydrateHuntImages({ ...fresh, userId: userId == null ? null : Number(userId), cached: false }, rarity);
}

module.exports = {
  isoWeekKey,
  generateHuntList,
  getHuntList,
};
