"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const seriesLib = require("../lib/series");
const dbLib = require("../lib/db");
const photos = require("../lib/photos");
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

// 2. User photos are kept on the car and on disk
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-cleanup-"));
const db = dbLib.openDatabase(tmp);
const uploads = photos.uploadDir(tmp);
fs.writeFileSync(path.join(uploads, "car-photo.jpg"), Buffer.alloc(2400, 2));

const c1 = dbLib.createCar(db, {
  name: "Mini Cooper S",
  userId: 1,
  upc: "887961234567",
  ownImageUrl: "/uploads/car-photo.jpg",
});
assert.equal(dbLib.getCar(db, c1.id).imageUrl, "/uploads/car-photo.jpg");
assert.equal(dbLib.getCar(db, c1.id).ownImageUrl, "/uploads/car-photo.jpg");
assert.equal(fs.existsSync(path.join(uploads, "car-photo.jpg")), true);
assert.equal(dbLib.listUpcMaps(db)[0].image_url, "/uploads/car-photo.jpg");

// 3. Hunt list shows only user-provided rarity images, including from a cached list
const rarity = rarityLib.loadRarity(tmp, path.join(__dirname, "..", "seed", "rarity-seed.json"));
const hunt1 = huntLib.getHuntList(tmp, rarity, [], { force: true, userId: 1 });
assert.ok(hunt1.items.length > 0);
assert.ok(!hunt1.items[0].imageUrl);
const targetId = hunt1.items[0].id;
const rItem = rarity.items.find((i) => i.id === targetId);
rItem.imageUrl = "/uploads/car-photo.jpg";
rItem.imageSource = "user";
rarityLib.saveRarity(tmp, rarity);
const hunt2 = huntLib.getHuntList(tmp, rarity, [], { force: false, userId: 1 });
assert.equal(hunt2.cached, true);
assert.equal(hunt2.items[0].imageUrl, "/uploads/car-photo.jpg");

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("series-and-cleanup tests passed");
