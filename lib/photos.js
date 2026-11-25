"use strict";

const fs = require("node:fs");
const path = require("node:path");

function uploadDir(dataDir) {
  const dir = path.join(dataDir, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deleteLocalUpload(url, dataDir) {
  const match = String(url || "").match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
  if (!match) return false;
  const file = path.join(uploadDir(dataDir), match[1]);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

module.exports = { uploadDir, deleteLocalUpload };
