"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const { sanitizeImageUrl } = require("./rarity");

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "collection.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      series TEXT,
      year INTEGER,
      color TEXT,
      condition TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      storage_location TEXT,
      notes TEXT,
      toy_number TEXT,
      casting TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cars_name ON cars(name);
    CREATE INDEX IF NOT EXISTS idx_cars_year ON cars(year);
    CREATE INDEX IF NOT EXISTS idx_cars_toy ON cars(toy_number);
  `);
  const cols = db.prepare("PRAGMA table_info(cars)").all();
  if (!cols.some((col) => col.name === "image_url")) {
    db.exec("ALTER TABLE cars ADD COLUMN image_url TEXT;");
  }
  if (!cols.some((col) => col.name === "collector_number")) {
    db.exec("ALTER TABLE cars ADD COLUMN collector_number TEXT;");
  }
  migrateUsers(db);
  migrateUpc(db);
  migratePhotos(db);
  return db;
}


function migratePhotos(db) {
  const cols = db.prepare("PRAGMA table_info(cars)").all();
  if (!cols.some((col) => col.name === "own_image_url")) {
    db.exec("ALTER TABLE cars ADD COLUMN own_image_url TEXT;");
  }
  // Keep a user upload or a pasted http(s) URL as the car's photo.
  db.prepare(`
    UPDATE cars
    SET own_image_url = image_url
    WHERE (own_image_url IS NULL OR own_image_url = '')
      AND image_url IS NOT NULL
      AND image_url != ''
      AND (image_url LIKE '/uploads/%' OR image_url LIKE 'http://%' OR image_url LIKE 'https://%')
  `).run();
  db.prepare(`
    UPDATE cars
    SET image_url = own_image_url
    WHERE own_image_url IS NOT NULL AND own_image_url != ''
      AND (image_url IS NULL OR image_url = ''
        OR (image_url NOT LIKE '/uploads/%' AND image_url NOT LIKE 'http://%' AND image_url NOT LIKE 'https://%'))
  `).run();
  db.prepare(`
    UPDATE cars
    SET image_url = ''
    WHERE image_url != ''
      AND image_url NOT LIKE '/uploads/%'
      AND image_url NOT LIKE 'http://%'
      AND image_url NOT LIKE 'https://%'
  `).run();
}

function migrateUpc(db) {
  const cols = db.prepare("PRAGMA table_info(cars)").all();
  if (!cols.some((col) => col.name === "upc")) {
    db.exec("ALTER TABLE cars ADD COLUMN upc TEXT;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_cars_upc ON cars(upc);");
  db.exec(`
    CREATE TABLE IF NOT EXISTS upc_map (
      upc TEXT PRIMARY KEY,
      name TEXT,
      series TEXT,
      year INTEGER,
      color TEXT,
      toy_number TEXT,
      casting TEXT,
      image_url TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateUsers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const cols = db.prepare("PRAGMA table_info(cars)").all();
  if (!cols.some((col) => col.name === "user_id")) {
    db.exec("ALTER TABLE cars ADD COLUMN user_id INTEGER;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_cars_user ON cars(user_id);");

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (userCount === 0) {
    const now = new Date().toISOString();
    const defaultName = String(process.env.DEFAULT_USER_NAME || "Collector").trim() || "Collector";
    const info = db.prepare("INSERT INTO users (name, created_at, updated_at) VALUES (?, ?, ?)").run(defaultName, now, now);
    db.prepare("UPDATE cars SET user_id = ? WHERE user_id IS NULL").run(info.lastInsertRowid);
  } else {
    const first = db.prepare("SELECT id FROM users ORDER BY id ASC").get();
    if (first) {
      db.prepare("UPDATE cars SET user_id = ? WHERE user_id IS NULL").run(first.id);
    }
  }
}

const CONDITIONS = ["Mint / MIB", "Near Mint", "Excellent", "Good", "Fair", "Poor", "Loose"];

function rowToCar(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    series: row.series || "",
    year: row.year,
    color: row.color || "",
    condition: row.condition || "",
    quantity: row.quantity,
    storageLocation: row.storage_location || "",
    notes: row.notes || "",
    toyNumber: row.toy_number || "",
    collectorNumber: row.collector_number || "",
    casting: row.casting || "",
    imageUrl: displayImageUrl({
      image_url: row.image_url || "",
      own_image_url: row.own_image_url || "",
    }),
    ownImageUrl: row.own_image_url || "",
    userId: row.user_id == null ? null : Number(row.user_id),
    upc: row.upc || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

function parseYear(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1968 || n > 2035) {
    const err = new Error("Year must be an integer between 1968 and 2035.");
    err.status = 400;
    throw err;
  }
  return n;
}

function parseQuantity(value) {
  if (value === "" || value == null) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    const err = new Error("Quantity must be an integer from 1 to 9999.");
    err.status = 400;
    throw err;
  }
  return n;
}

function parseCondition(value) {
  const c = clean(value);
  if (!c) return "";
  if (!CONDITIONS.includes(c)) {
    const err = new Error(`Condition must be one of: ${CONDITIONS.join(", ")}.`);
    err.status = 400;
    throw err;
  }
  return c;
}

function parseImageUrl(value) {
  return sanitizeImageUrl(value);
}


function parseOptionalImageUrl(value) {
  if (value == null || value === "") return "";
  return parseImageUrl(value);
}

function inferOwnImage(body, existing) {
  if (Object.prototype.hasOwnProperty.call(body, "ownImageUrl") || Object.prototype.hasOwnProperty.call(body, "own_image_url")) {
    return parseOptionalImageUrl(body.ownImageUrl ?? body.own_image_url);
  }
  const submitted = parseOptionalImageUrl(body.imageUrl ?? body.image_url);
  if (!submitted) return existing?.ownImageUrl || existing?.imageUrl || "";
  return submitted;
}

function isDisplayableImage(url) {
  const value = String(url || "");
  return value.startsWith("/uploads/") || value.startsWith("http://") || value.startsWith("https://");
}

function displayImageUrl(fields) {
  const own = fields.own_image_url || "";
  const url = fields.image_url || "";
  if (isDisplayableImage(own)) return own;
  if (isDisplayableImage(url)) return url;
  return "";
}

function normalizeInput(body) {
  const name = clean(body.name);
  if (!name) {
    const err = new Error("Car name is required.");
    err.status = 400;
    throw err;
  }
  return {
    name,
    series: clean(body.series),
    year: parseYear(body.year),
    color: clean(body.color),
    condition: parseCondition(body.condition),
    quantity: parseQuantity(body.quantity),
    storage_location: clean(body.storageLocation ?? body.storage_location),
    notes: clean(body.notes),
    toy_number: clean(body.toyNumber ?? body.toy_number).toUpperCase(),
    collector_number: clean(body.collectorNumber ?? body.collector_number),
    casting: clean(body.casting),
    image_url: parseImageUrl(body.imageUrl ?? body.image_url),
    upc: String(body.upc || "").replace(/\D/g, "").slice(0, 14),
  };
}

function photoFieldsFrom(body, existing) {
  const own = inferOwnImage(body || {}, existing);
  const fields = { own_image_url: own, image_url: own };
  fields.image_url = displayImageUrl(fields);
  return fields;
}



function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listUsers(db) {
  return db.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE ASC, id ASC").all().map(rowToUser);
}

function getUser(db, id) {
  return rowToUser(db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)));
}

function parseUserName(value) {
  const name = clean(value);
  if (!name) {
    const err = new Error("User name is required.");
    err.status = 400;
    throw err;
  }
  if (name.length > 80) {
    const err = new Error("User name must be 80 characters or fewer.");
    err.status = 400;
    throw err;
  }
  return name;
}

function requireUserId(db, value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    const err = new Error("A valid user is required.");
    err.status = 400;
    throw err;
  }
  const user = getUser(db, id);
  if (!user) {
    const err = new Error("User not found.");
    err.status = 400;
    throw err;
  }
  return user.id;
}

function createUser(db, body) {
  const name = parseUserName(body && body.name);
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO users (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, now, now);
  return getUser(db, info.lastInsertRowid);
}

function updateUser(db, id, body) {
  const existing = getUser(db, id);
  if (!existing) return null;
  const name = parseUserName(body && body.name);
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(name, now, Number(id));
  return getUser(db, id);
}

function deleteUser(db, id) {
  const existing = getUser(db, id);
  if (!existing) return null;
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count <= 1) {
    const err = new Error("You cannot delete the last user.");
    err.status = 400;
    throw err;
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cars WHERE user_id = ?").run(Number(id));
    db.prepare("DELETE FROM users WHERE id = ?").run(Number(id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return existing;
}

function listCars(db, userId) {
  if (userId == null || userId === "") {
    const rows = db.prepare("SELECT * FROM cars ORDER BY name COLLATE NOCASE ASC, year DESC, id ASC").all();
    return rows.map(rowToCar);
  }
  const rows = db.prepare("SELECT * FROM cars WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC, year DESC, id ASC").all(Number(userId));
  return rows.map(rowToCar);
}

function getCar(db, id) {
  return rowToCar(db.prepare("SELECT * FROM cars WHERE id = ?").get(Number(id)));
}

function createCar(db, body) {
  const data = normalizeInput(body);
  const photos = photoFieldsFrom(body, null);
  const user_id = requireUserId(db, body.userId ?? body.user_id);
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO cars (name, series, year, color, condition, quantity, storage_location, notes, toy_number, collector_number, casting, image_url, own_image_url, user_id, upc, created_at, updated_at)
    VALUES (@name, @series, @year, @color, @condition, @quantity, @storage_location, @notes, @toy_number, @collector_number, @casting, @image_url, @own_image_url, @user_id, @upc, @created_at, @updated_at)
  `).run({ ...data, ...photos, user_id, created_at: now, updated_at: now });
  const created = getCar(db, info.lastInsertRowid);
  learnUpc(db, created);
  return created;
}

function updateCar(db, id, body) {
  const existing = getCar(db, id);
  if (!existing) return null;
  const data = normalizeInput(body);
  const photos = photoFieldsFrom(body, existing);
  const user_id = body.userId != null || body.user_id != null
    ? requireUserId(db, body.userId ?? body.user_id)
    : existing.userId;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE cars SET
      name = @name,
      series = @series,
      year = @year,
      color = @color,
      condition = @condition,
      quantity = @quantity,
      storage_location = @storage_location,
      notes = @notes,
      toy_number = @toy_number,
      collector_number = @collector_number,
      casting = @casting,
      image_url = @image_url,
      own_image_url = @own_image_url,
      user_id = @user_id,
      upc = @upc,
      updated_at = @updated_at
    WHERE id = @id
  `).run({ ...data, ...photos, user_id, updated_at: now, id: Number(id) });
  const updated = getCar(db, id);
  learnUpc(db, updated);
  return updated;
}

function deleteCar(db, id) {
  const existing = getCar(db, id);
  if (!existing) return null;
  db.prepare("DELETE FROM cars WHERE id = ?").run(Number(id));
  return existing;
}


function learnUpc(db, car) {
  if (!car) return;
  const upc = String(car.upc || "").replace(/\D/g, "");
  if (upc.length < 8) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO upc_map (upc, name, series, year, color, toy_number, casting, image_url, updated_at)
    VALUES (@upc, @name, @series, @year, @color, @toy_number, @casting, @image_url, @updated_at)
    ON CONFLICT(upc) DO UPDATE SET
      name = excluded.name,
      series = excluded.series,
      year = excluded.year,
      color = excluded.color,
      toy_number = excluded.toy_number,
      casting = excluded.casting,
      image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url ELSE upc_map.image_url END,
      updated_at = excluded.updated_at
  `).run({
    upc,
    name: car.name || "",
    series: car.series || "",
    year: car.year ?? null,
    color: car.color || "",
    toy_number: car.toyNumber || "",
    casting: car.casting || "",
    image_url: car.imageUrl || "",
    updated_at: now,
  });
}

function listUpcMaps(db) {
  return db.prepare("SELECT * FROM upc_map ORDER BY updated_at DESC").all();
}

function pruneUpcUploadUrls(db, keptFilenames) {
  const rows = db.prepare("SELECT upc, image_url FROM upc_map WHERE image_url LIKE '/uploads/%'").all();
  let cleared = 0;
  for (const row of rows) {
    const match = String(row.image_url || "").match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
    if (!match || !keptFilenames.has(match[1])) {
      db.prepare("UPDATE upc_map SET image_url = '' WHERE upc = ?").run(row.upc);
      cleared += 1;
    }
  }
  return cleared;
}

module.exports = {
  CONDITIONS,
  openDatabase,
  listCars,
  getCar,
  createCar,
  updateCar,
  deleteCar,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  requireUserId,
  learnUpc,
  listUpcMaps,
  pruneUpcUploadUrls,
  displayImageUrl,
};
