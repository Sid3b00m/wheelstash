"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const scan = require("../lib/scan");
const rarityLib = require("../lib/rarity");

const fs = require("node:fs");
const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hw-scan-"));
const seed = rarityLib.loadRarity(tmp, path.join(__dirname, "..", "seed", "rarity-seed.json"));
const items = seed.items || [];

function lookup(opts) {
  return scan.lookupScan({ rarityItems: items, ownedCars: [], upcMaps: [], ...opts });
}

// parsing
assert.deepEqual(scan.extractToyNumbers("HW JJM15 Drift-Ender 13/250"), ["JJM15"]);
assert.deepEqual(scan.extractToyNumbers("toy: hkh21 and jjm-16"), ["HKH21", "JJM16"]);
assert.deepEqual(scan.extractCollectorNumbers("Look for 13/250 on the card"), ["13/250"]);
assert.deepEqual(scan.extractCollectorNumbers("123 / 250"), ["123/250"]);
assert.deepEqual(scan.extractYears("series 2026 TH"), [2026]);
assert.ok(scan.extractUpcs("UPC 887961234567").includes("887961234567"));
assert.equal(scan.normalizeUpc("88796-12345-67"), "887961234567");
assert.equal(scan.nameSimilarity("Drift-Ender", "DRIFT ENDER"), 1);

// toy number exact
const byToy = lookup({ query: "JJM15" });
assert.equal(byToy.prefill.name, "Drift-Ender");
assert.equal(byToy.prefill.year, 2026);
assert.equal(byToy.prefill.toyNumber, "JJM15");
assert.deepEqual(byToy.prefill.rarityBadges, ["STH"]);
assert.equal(byToy.candidates[0].matchReason, "toyNumber");

// collector number + year
const byCol = lookup({ query: "13/250 2026" });
assert.equal(byCol.prefill.name, "Drift-Ender");
assert.ok(["collectorYear", "collectorNumber"].includes(byCol.candidates[0].matchReason));

// fuzzy name
const byName = lookup({ query: "DRIFT ENDER" });
assert.equal(byName.prefill.name, "Drift-Ender");
assert.ok(["name", "nameFuzzy"].includes(byName.candidates[0].matchReason));

// OCR-ish blob
const ocr = lookup({ text: "HOT WHEELS 2026\nJJM15\n13/250\nDrift-Ender\nSuper Treasure Hunt" });
assert.equal(ocr.prefill.toyNumber, "JJM15");
assert.equal(ocr.prefill.name, "Drift-Ender");

// typo-ish OCR variant on the leading letters isn't required; exact path covers JJM15

// already owned by toy number
const owned = lookup({
  query: "JJM15",
  ownedCars: [{ id: 9, name: "Drift-Ender", toyNumber: "JJM15", quantity: 2, userId: 1, isRare: true, rarityBadges: ["STH"] }],
});
assert.equal(owned.alreadyOwned.length, 1);
assert.equal(owned.alreadyOwned[0].suggestedQuantity, 3);

// already owned by UPC
const ownedUpc = lookup({
  upc: "012345678905",
  ownedCars: [{ id: 4, name: "Civic", upc: "012345678905", toyNumber: "JJM20", quantity: 1, userId: 1 }],
});
assert.equal(ownedUpc.alreadyOwned[0].id, 4);
assert.equal(ownedUpc.alreadyOwned[0].suggestedQuantity, 2);

// learned UPC map prefills
const mapped = lookup({
  upc: "012345678905",
  upcMaps: [{ upc: "012345678905", name: "Honda Civic Custom", series: "HW J-Imports", year: 2026, color: "Turquoise", toy_number: "JJM20", casting: "", image_url: "" }],
});
assert.equal(mapped.prefill.name, "Honda Civic Custom");
assert.equal(mapped.prefill.toyNumber, "JJM20");
assert.ok(mapped.prefill.rarityBadges.includes("STH") || mapped.candidates[0].isRare);

// unknown number still returns the typed toy number for the form
const unknown = lookup({ query: "ZZZ99" });
assert.equal(unknown.prefill.toyNumber, "ZZZ99");
assert.equal(unknown.candidates.length, 0);

console.log("scan-parse tests passed");
