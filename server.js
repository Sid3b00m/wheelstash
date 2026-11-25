"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const cron = require("node-cron");
const dbLib = require("./lib/db");
const rarityLib = require("./lib/rarity");
const huntLib = require("./lib/hunt");
const refreshLib = require("./lib/refresh");
const scanLib = require("./lib/scan");
const aiLib = require("./lib/ai");
const photos = require("./lib/photos");
const seriesLib = require("./lib/series");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "storage");
const SEED_PATH = path.join(__dirname, "seed", "rarity-seed.json");
const UPLOAD_DIR = photos.uploadDir(DATA_DIR);
const SCHEDULE = refreshLib.scheduleConfig();

const db = dbLib.openDatabase(DATA_DIR);
rarityLib.loadRarity(DATA_DIR, SEED_PATH);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR, { fallthrough: false, index: false }));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}


function withMatches(cars) {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  return { rarity, cars: rarityLib.attachMatches(cars, rarity) };
}


function parseQueryUserId(req, required = false) {
  const raw = req.query.userId ?? req.query.user_id;
  if (raw == null || raw === "") {
    if (required) {
      const err = new Error("userId is required.");
      err.status = 400;
      throw err;
    }
    return null;
  }
  return dbLib.requireUserId(db, raw);
}

function refreshStatus() {
  return {
    schedule: SCHEDULE,
    state: refreshLib.loadRefreshState(DATA_DIR),
    priceNote: refreshLib.PRICE_NOTE,
  };
}

let refreshInFlight = null;
async function triggerRefresh(trigger) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshLib.runRefresh({
    dataDir: DATA_DIR,
    seedPath: SEED_PATH,
    db,
    trigger,
    listCars: () => dbLib.listCars(db),
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "wheelstash",
    port: PORT,
  });
});

app.get("/api/meta", (_req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  res.json({
    conditions: dbLib.CONDITIONS,
    categories: rarity.categories || [],
    source: rarity.source || {},
    refresh: refreshStatus(),
    users: dbLib.listUsers(db),
  });
});


app.get("/api/users", (_req, res) => {
  res.json({ items: dbLib.listUsers(db) });
});

app.post("/api/users", asyncHandler((req, res) => {
  const user = dbLib.createUser(db, req.body || {});
  res.status(201).json(user);
}));

app.put("/api/users/:id", asyncHandler((req, res) => {
  const user = dbLib.updateUser(db, req.params.id, req.body || {});
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(user);
}));

app.delete("/api/users/:id", asyncHandler((req, res) => {
  const userCars = dbLib.listCars(db, req.params.id);
  const user = dbLib.deleteUser(db, req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  for (const car of userCars) {
    if (car.ownImageUrl || car.imageUrl) photos.deleteLocalUpload(car.ownImageUrl || car.imageUrl, DATA_DIR);
  }
  res.json({ ok: true, deleted: user });
}));

app.get("/api/cars", asyncHandler((req, res) => {
  const userId = parseQueryUserId(req, false);
  const { rarity, cars } = withMatches(dbLib.listCars(db, userId));
  let list = cars;
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    list = list.filter((car) => {
      const hay = [
        car.name, car.series, car.color, car.condition, car.storageLocation,
        car.notes, car.toyNumber, car.casting, String(car.year || ""),
        ...(car.rarityBadges || []),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  const rarityFilter = String(req.query.rarity || "").trim().toUpperCase();
  if (rarityFilter === "RARE") list = list.filter((c) => c.isRare);
  else if (rarityFilter) list = list.filter((c) => c.rarityBadges.includes(rarityFilter));

  const sort = String(req.query.sort || "series");
  const dir = String(req.query.dir || "asc") === "desc" ? -1 : 1;
  if (sort === "series") {
    list = seriesLib.groupAndSortBySeries(list, dir);
  } else {
    const keyMap = {
      name: (c) => c.name.toLowerCase(),
      year: (c) => c.year || 0,
      color: (c) => (c.color || "").toLowerCase(),
      condition: (c) => (c.condition || "").toLowerCase(),
      quantity: (c) => c.quantity || 0,
      storage: (c) => (c.storageLocation || "").toLowerCase(),
      toyNumber: (c) => (c.toyNumber || "").toLowerCase(),
    };
    const keyFn = keyMap[sort] || keyMap.name;
    list = [...list].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.id - b.id;
    });
  }

  const totalCars = cars.reduce((n, c) => n + (c.quantity || 0), 0);
  res.json({
    items: list,
    total: list.length,
    stats: {
      entries: cars.length,
      pieces: totalCars,
      rare: cars.filter((c) => c.isRare).length,
      rarityItems: (rarity.items || []).length,
    },
    refresh: refreshStatus(),
  });
}));

app.get("/api/cars/:id", asyncHandler((req, res) => {
  const car = dbLib.getCar(db, req.params.id);
  if (!car) return res.status(404).json({ error: "Car not found." });
  const { cars } = withMatches([car]);
  res.json(cars[0]);
}));

app.post("/api/cars", asyncHandler((req, res) => {
  const car = dbLib.createCar(db, req.body || {});
  const { cars } = withMatches([car]);
  res.status(201).json(cars[0]);
}));

app.put("/api/cars/:id", asyncHandler((req, res) => {
  const existing = dbLib.getCar(db, req.params.id);
  const car = dbLib.updateCar(db, req.params.id, req.body || {});
  if (!car) return res.status(404).json({ error: "Car not found." });
  const previous = existing?.ownImageUrl || existing?.imageUrl || "";
  const current = car.ownImageUrl || car.imageUrl || "";
  if (previous && previous !== current) {
    photos.deleteLocalUpload(previous, DATA_DIR);
  }
  const { cars } = withMatches([car]);
  res.json(cars[0]);
}));

app.delete("/api/cars/:id", asyncHandler((req, res) => {
  const car = dbLib.deleteCar(db, req.params.id);
  if (!car) return res.status(404).json({ error: "Car not found." });
  if (car.ownImageUrl || car.imageUrl) photos.deleteLocalUpload(car.ownImageUrl || car.imageUrl, DATA_DIR);
  res.json({ ok: true, deleted: car });
}));

app.get("/api/rarity", asyncHandler((_req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  res.json(rarity);
}));

app.post("/api/rarity", asyncHandler((req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const item = rarityLib.validateRarityItem(req.body || {}, null);
  rarityLib.upsertItem(rarity, item, true);
  rarityLib.saveRarity(DATA_DIR, rarity);
  res.status(201).json(item);
}));

app.put("/api/rarity/:id", asyncHandler((req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const existing = (rarity.items || []).find((i) => i.id === req.params.id);
  const body = { ...(existing || {}), ...(req.body || {}), id: req.params.id };
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "imageUrl") && req.body.imageUrl !== existing?.imageUrl) {
    body.imageSource = req.body.imageSource || "user";
  }
  const item = rarityLib.validateRarityItem(body, req.params.id);
  const updated = rarityLib.upsertItem(rarity, item, false);
  if (!updated) return res.status(404).json({ error: "Rarity item not found." });
  rarityLib.saveRarity(DATA_DIR, rarity);
  res.json(updated);
}));

app.delete("/api/rarity/:id", asyncHandler((req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const removed = rarityLib.removeItem(rarity, req.params.id);
  if (!removed) return res.status(404).json({ error: "Rarity item not found." });
  rarityLib.saveRarity(DATA_DIR, rarity);
  res.json({ ok: true, deleted: removed });
}));

app.post("/api/rarity/reset", asyncHandler((_req, res) => {
  const rarity = rarityLib.resetRarity(DATA_DIR, SEED_PATH);
  res.json(rarity);
}));

app.get("/api/hunt", asyncHandler((req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const userId = parseQueryUserId(req, false);
  const cars = dbLib.listCars(db, userId);
  const force = String(req.query.refresh || "") === "1";
  const hunt = huntLib.getHuntList(DATA_DIR, rarity, cars, { force, userId });
  res.json({ ...hunt, refresh: refreshStatus() });
}));

app.post("/api/hunt/refresh", asyncHandler((req, res) => {
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const userId = parseQueryUserId(req, false);
  const cars = dbLib.listCars(db, userId);
  const hunt = huntLib.getHuntList(DATA_DIR, rarity, cars, { force: true, userId });
  res.json({ ...hunt, refresh: refreshStatus() });
}));

app.get("/api/refresh", (_req, res) => {
  res.json(refreshStatus());
});

app.post("/api/refresh", asyncHandler(async (_req, res) => {
  const result = await triggerRefresh("manual");
  res.json({
    ok: result.ok,
    lastRunAt: result.lastRunAt,
    lastRunIsoWeek: result.lastRunIsoWeek,
    lastRunTrigger: result.lastRunTrigger,
    priceNote: result.priceNote,
    steps: result.steps,
    hunt: result.hunt,
    refresh: refreshStatus(),
  });
}));


app.post("/api/scan/lookup", asyncHandler((req, res) => {
  const body = req.body || {};
  const userId = body.userId ?? body.user_id ?? req.query.userId ?? req.query.user_id;
  const resolvedUserId = userId == null || userId === "" ? null : dbLib.requireUserId(db, userId);
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const owned = resolvedUserId ? rarityLib.attachMatches(dbLib.listCars(db, resolvedUserId), rarity) : [];
  const result = scanLib.lookupScan({
    query: body.query ?? body.q ?? req.query.q ?? "",
    upc: body.upc ?? req.query.upc ?? "",
    text: body.text ?? "",
    rarityItems: rarity.items || [],
    ownedCars: owned,
    upcMaps: dbLib.listUpcMaps(db),
  });
  res.json(result);
}));

app.get("/api/scan/ai/status", asyncHandler(async (_req, res) => {
  res.json(await aiLib.aiStatus());
}));

app.post("/api/scan/ai", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const userId = body.userId ?? body.user_id ?? req.query.userId ?? req.query.user_id;
  const resolvedUserId = userId == null || userId === "" ? null : dbLib.requireUserId(db, userId);
  const ai = await aiLib.identifyCar(body.image ?? body.dataUrl ?? "");
  const r = ai.result;
  const rarity = rarityLib.loadRarity(DATA_DIR, SEED_PATH);
  const owned = resolvedUserId ? rarityLib.attachMatches(dbLib.listCars(db, resolvedUserId), rarity) : [];
  const queryParts = [r.toyNumber, r.collectorNumber, r.year].filter(Boolean).map(String);
  const textLines = [r.name, r.toyNumber, r.collectorNumber && r.year ? `${r.collectorNumber} ${r.year}` : r.collectorNumber, r.year]
    .filter(Boolean).map(String);
  const lookup = scanLib.lookupScan({
    query: queryParts.join(" "),
    upc: body.upc || "",
    text: textLines.join("\n"),
    rarityItems: rarity.items || [],
    ownedCars: owned,
    upcMaps: dbLib.listUpcMaps(db),
    ownedNameHint: r.name,
    ownedNameYear: r.year,
  });
  // Keep rarity matches only when they agree with what the AI read; otherwise prefill straight from the AI.
  const best = lookup.candidates[0];
  const strong = best && best.score >= 0.86;
  const aiBadges = r.treasureHunt ? [r.treasureHunt] : [];
  const prefill = strong
    ? {
        ...lookup.prefill,
        color: lookup.prefill.color || r.color,
        series: lookup.prefill.series || r.series,
      }
    : {
        ...lookup.prefill,
        name: r.name,
        series: r.series,
        year: r.year ?? "",
        color: r.color,
        toyNumber: r.toyNumber,
        collectorNumber: r.collectorNumber,
        rarityBadges: [...new Set([...(lookup.prefill.rarityBadges || []), ...aiBadges])],
        isRare: Boolean(lookup.prefill.isRare || aiBadges.length),
      };
  res.json({
    ...lookup,
    prefill,
    ai: { model: ai.model, latencyMs: ai.latencyMs, ...r },
  });
}));


app.post("/api/uploads", asyncHandler((req, res) => {
  const dataUrl = String(req.body?.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/(jpeg|jpg|png|gif|webp));base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) {
    const err = new Error("Upload a JPEG, PNG, GIF, or WebP image.");
    err.status = 400;
    throw err;
  }
  const ext = match[2] === "jpg" ? "jpeg" : match[2];
  const buffer = Buffer.from(match[3].replace(/\s+/g, ""), "base64");
  if (!buffer.length) {
    const err = new Error("The image file was empty.");
    err.status = 400;
    throw err;
  }
  if (buffer.length > 4 * 1024 * 1024) {
    const err = new Error("Images must be 4 MB or smaller.");
    err.status = 400;
    throw err;
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext === "jpeg" ? "jpg" : ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  res.status(201).json({ url: `/uploads/${name}` });
}));

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get("/api/export.json", asyncHandler((req, res) => {
  const userId = parseQueryUserId(req, false);
  const user = userId ? dbLib.getUser(db, userId) : null;
  const { rarity, cars } = withMatches(dbLib.listCars(db, userId));
  const suffix = user ? `-${user.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}` : "";
  res.setHeader("Content-Disposition", `attachment; filename="wheelstash-collection${suffix}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    user: user || null,
    collection: cars,
    rarity,
  });
}));

app.get("/api/export.csv", asyncHandler((req, res) => {
  const userId = parseQueryUserId(req, false);
  const user = userId ? dbLib.getUser(db, userId) : null;
  const { cars } = withMatches(dbLib.listCars(db, userId));
  const suffix = user ? `-${user.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}` : "";
  const headers = [
    "id", "userId", "userName", "name", "series", "year", "color", "condition", "quantity",
    "storageLocation", "toyNumber", "casting", "upc", "notes", "imageUrl", "rarityBadges",
    "valueEstimates", "matchedToyNumbers",
  ];
  const lines = [headers.join(",")];
  for (const car of cars) {
    const matches = car.rarityMatches || [];
    const image = car.imageUrl || matches.find((m) => m.imageUrl)?.imageUrl || "";
    lines.push([
      car.id,
      car.userId,
      user ? user.name : "",
      car.name,
      car.series,
      car.year,
      car.color,
      car.condition,
      car.quantity,
      car.storageLocation,
      car.toyNumber,
      car.casting,
      car.upc,
      car.notes,
      image,
      car.rarityBadges.join("; "),
      matches.map((m) => m.valueEstimate).filter(Boolean).join("; "),
      matches.map((m) => m.toyNumber).filter(Boolean).join("; "),
    ].map(csvEscape).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wheelstash-collection${suffix}.csv"`);
  res.send(lines.join("\n") + "\n");
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Server error.", ...(err.code ? { code: err.code } : {}) });
});

function startScheduler() {
  if (!SCHEDULE.enabled) {
    console.log("Weekly auto-refresh is disabled (REFRESH_ENABLED=false).");
    return;
  }
  if (!cron.validate(SCHEDULE.cronExpr)) {
    console.error(`Invalid REFRESH_CRON expression: ${SCHEDULE.cronExpr}`);
    return;
  }
  const opts = SCHEDULE.tz ? { timezone: SCHEDULE.tz } : {};
  cron.schedule(SCHEDULE.cronExpr, () => {
    triggerRefresh("cron").then((state) => {
      console.log(`Auto-refresh (${state.lastRunTrigger}) finished for ${state.lastRunIsoWeek}`);
    }).catch((err) => {
      console.error("Auto-refresh failed:", err);
    });
  }, opts);
  console.log(`Weekly auto-refresh scheduled: "${SCHEDULE.cronExpr}"${SCHEDULE.tz ? ` TZ=${SCHEDULE.tz}` : " (process local time)"}`);

  const existing = refreshLib.loadRefreshState(DATA_DIR);
  if (refreshLib.isWeekStale(existing)) {
    triggerRefresh("startup").then((state) => {
      console.log(`Startup refresh finished for ${state.lastRunIsoWeek} (stale or missing weekly run).`);
    }).catch((err) => {
      console.error("Startup refresh failed:", err);
    });
  } else {
    console.log(`Hunt/rarity list already refreshed for ${existing.lastRunIsoWeek}; skipping startup run.`);
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Wheelstash listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  startScheduler();
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
