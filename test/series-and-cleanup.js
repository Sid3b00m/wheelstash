"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const seriesLib = require("../lib/series");
const dbLib = require("../lib/db");
const stockLib = require("../lib/stock");
const huntLib = require("../lib/hunt");
const rarityLib = require("../lib/rarity");

// 1. Series parsing and grouping
assert.deepEqual(seriesLib.parseSeries("HW J-Import 5/5"), {
  raw: "HW J-Import 5/5",
  base: "HW J-Import",
  num: 5,
  total: 5,
  text: "5/5",
});
assert.deepEqual(seriesLib.parseSeries("HW Modified 8/10"), {
  raw: "HW Modified 8/10",
  base: "HW Modified",
  num: 8,
  total: 10,
  text: "8/10",
});
assert.deepEqual(seriesLib.parseSeries("Factory Fresh"), {
  raw: "Factory Fresh",
  base: "Factory Fresh",
  num: null,
  total: null,
  text: "",
});

const sampleCars = [
  { id: 1, name: "Car Unnumbered Z", series: "HW J-Imports", year: 2024 },
  { id: 2, name: "Car Series 7", series: "HW J-Import 7/10", year: 2026 },
  { id: 3, name: "Car Series 3", series: "HW J-Import 3/10", year: 2025 },
  { id: 4, name: "Car Collector 95", series: "HW J-IMPORTS", collectorNumber: "95/250", year: 2025 },
  { id: 5, name: "Car Collector 13", series: "HW J-Imports", collectorNumber: "13/250", year: 2025 },
  { id: 6, name: "Car Unnumbered A", series: "HW J-Imports", year: 2024 },
  { id: 7, name: "Kei Swap", series: "COMPACT KINGS", year: 2006 },
  { id: 8, name: "Datsun Sunny", series: "Compact Kings", year: 1972 },
  { id: 9, name: "No Series Car", series: "", year: 2020 },
];

const grouped = seriesLib.groupAndSortBySeries(sampleCars);
// Compact Kings comes first (2 cars: Datsun Sunny, Kei Swap)
assert.equal(grouped[0].seriesGroup, "Compact Kings");
assert.equal(grouped[0].name, "Datsun Sunny");
assert.equal(grouped[1].seriesGroup, "Compact Kings");
assert.equal(grouped[1].name, "Kei Swap");
// HW J-Imports comes next: 3/10, 7/10, then collector 13/250, 95/250, then unnumbered A, Z
const jImports = grouped.filter((c) => c.seriesGroup === "HW J-Imports");
assert.deepEqual(jImports.map((c) => c.name), [
  "Car Series 3",
  "Car Series 7",
  "Car Collector 13",
  "Car Collector 95",
  "Car Unnumbered A",
  "Car Unnumbered Z",
]);
// No series comes last
assert.equal(grouped[grouped.length - 1].seriesGroup, "No series");
assert.equal(grouped[grouped.length - 1].name, "No Series Car");

// 2. Photo cleanup: keep own photo when no stock exists, purge when stock exists, purge orphans & stale upc_map
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-cleanup-"));
const db = dbLib.openDatabase(tmp);
const uploads = stockLib.uploadDir(tmp);
const stockDir = stockLib.stockDir(tmp);
fs.writeFileSync(path.join(uploads, "car-with-stock.jpg"), Buffer.alloc(1200, 1));
fs.writeFileSync(path.join(uploads, "car-no-stock.jpg"), Buffer.alloc(2400, 2));
fs.writeFileSync(path.join(uploads, "orphan-scan.jpg"), Buffer.alloc(3600, 3));
fs.writeFileSync(path.join(stockDir, "stock-abc123.webp"), Buffer.alloc(500, 4));

const c1 = dbLib.createCar(db, {
  name: "Mini Cooper S",
  userId: 1,
  upc: "887961234567",
  ownImageUrl: "/uploads/car-with-stock.jpg",
  stockImageUrl: "",
  imagePref: "own",
});
// Simulate later attaching stock image via setCarStock (legacy state before cleanup)
dbLib.setCarStock(db, c1.id, { stockImageUrl: "/stock/stock-abc123.webp" }, { imagePref: "stock", clearOwn: false });

const c2 = dbLib.createCar(db, {
  name: "Mystery Car",
  userId: 1,
  ownImageUrl: "/uploads/car-no-stock.jpg",
  imagePref: "own",
});

const cleanup = stockLib.cleanupOwnPhotos(dbLib, db, tmp);
assert.equal(cleanup.carsCleared.length, 1);
assert.equal(cleanup.carsCleared[0].name, "Mini Cooper S");
assert.equal(cleanup.orphansDeleted.length, 1);
assert.equal(cleanup.orphansDeleted[0].name, "orphan-scan.jpg");
assert.equal(cleanup.freed, 1200 + 3600);
assert.equal(fs.existsSync(path.join(uploads, "car-with-stock.jpg")), false);
assert.equal(fs.existsSync(path.join(uploads, "orphan-scan.jpg")), false);
assert.equal(fs.existsSync(path.join(uploads, "car-no-stock.jpg")), true);
assert.equal(dbLib.getCar(db, c1.id).ownImageUrl, "");
assert.equal(dbLib.getCar(db, c2.id).ownImageUrl, "/uploads/car-no-stock.jpg");
assert.equal(dbLib.listUpcMaps(db)[0].image_url, "");

// 3. Hunt hydration from rarity items (even when hunt-cache already exists without images)
const rarity = rarityLib.loadRarity(tmp, path.join(__dirname, "..", "seed", "rarity-seed.json"));
const hunt1 = huntLib.getHuntList(tmp, rarity, [], { force: true, userId: 1 });
assert.ok(hunt1.items.length > 0);
assert.ok(!hunt1.items[0].imageUrl);
const targetId = hunt1.items[0].id;
const rItem = rarity.items.find((i) => i.id === targetId);
rItem.imageUrl = "/stock/stock-abc123.webp";
rItem.imageSource = "fandom";
rarityLib.saveRarity(tmp, rarity);
const hunt2 = huntLib.getHuntList(tmp, rarity, [], { force: false, userId: 1 });
assert.equal(hunt2.cached, true);
assert.equal(hunt2.items[0].imageUrl, "/stock/stock-abc123.webp");

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("series-and-cleanup tests passed");
