"use strict";

// AI photo recognition via a local Ollama vision model (no paid services).

const DEFAULT_URL = ""; // set OLLAMA_URL, e.g. http://ollama:11434 or http://127.0.0.1:11434
const DEFAULT_MODEL = "qwen2.5vl:7b";

function aiConfig() {
  const enabledRaw = String(process.env.AI_SCAN_ENABLED ?? "true").trim().toLowerCase();
  const enabled = !["0", "false", "no", "off"].includes(enabledRaw);
  const url = String(process.env.OLLAMA_URL || DEFAULT_URL).trim().replace(/\/+$/, "");
  const model = String(process.env.OLLAMA_VISION_MODEL || DEFAULT_MODEL).trim();
  const timeoutMs = Math.max(5000, Number(process.env.AI_SCAN_TIMEOUT_MS) || 90000);
  return { enabled: enabled && Boolean(url) && Boolean(model), url, model, timeoutMs };
}

const PROMPT = `You are identifying a Hot Wheels die-cast car from a photo (card front, card back, or loose car).
Read only what is actually printed or visible in THIS image. Return ONLY a JSON object with these keys:
- "name": the car/casting name (if only the card back is shown and no car name is printed, use "")
- "series": the series or sub-line printed on the card (e.g. "Then and Now", "HW J-Imports", "Tooned"), or ""
- "year": the 4-digit model/copyright year if clearly printed, or null
- "color": the car's body color if the car is visible, or ""
- "toyNumber": the Mattel toy code (3-4 letters + 2-3 digits; if printed as CODE-SUFFIX like FKB19-D5C6, return only the first part before the hyphen), or ""
- "collectorNumber": the collector fraction like N/250 or N/365 if printed on the card, or ""
- "treasureHunt": "STH" for Super Treasure Hunt (Spectraflame paint, Real Riders rubber tires, TH logo), "TH" if you see the flame-in-circle logo or text "treasure-hunt vehicle", else ""
- "confidence": number 0 to 1 for how sure you are of the car's identity
- "notes": one short sentence about what you actually saw
Never invent values or copy placeholder words like "Not specified". Use "" or null when unseen.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    series: { type: "string" },
    year: { type: ["integer", "null"] },
    color: { type: "string" },
    toyNumber: { type: "string" },
    collectorNumber: { type: "string" },
    treasureHunt: { type: "string" },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
  required: ["name", "series", "year", "color", "toyNumber", "collectorNumber", "confidence"],
};

function stripDataUrl(image) {
  const raw = String(image || "").trim();
  const match = raw.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/s);
  const b64 = (match ? match[2] : raw).replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    const err = new Error("Send a JPEG/PNG/WebP image as a data URL or base64 string.");
    err.status = 400;
    throw err;
  }
  if (b64.length > 8 * 1024 * 1024) {
    const err = new Error("Image is too large; resize it to about 1024px first.");
    err.status = 413;
    throw err;
  }
  return b64;
}

function parseJsonLoose(text) {
  const src = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(src); } catch (_) { /* fall through */ }
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(src.slice(start, end + 1)); } catch (_) { /* ignore */ }
  }
  return null;
}

function cleanStr(v, maxLen) {
  const s = v == null ? "" : String(v).trim();
  if (/^(not specified|unknown|none|n\/a|na|null|unseen)$/i.test(s)) return "";
  return s.slice(0, maxLen);
}

function cleanResult(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  let year = Number(String(o.year ?? "").match(/\b(19[6-9]\d|20[0-3]\d)\b/)?.[1]);
  if (!(year >= 1968 && year <= 2035)) year = null;
  const rawToy = String(o.toyNumber || "").toUpperCase().trim();
  const toyMatch = rawToy.match(/\b([A-Z]{3,4})[-\s]?(\d{2,3})\b/);
  const toy = toyMatch ? `${toyMatch[1]}${toyMatch[2]}` : "";
  let collector = String(o.collectorNumber || "").replace(/\s+/g, "");
  if (!/^\d{1,3}\/\d{1,4}$/.test(collector)) collector = "";
  let th = String(o.treasureHunt || "").trim().toUpperCase();
  if (!["STH", "TH"].includes(th)) th = "";
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    name: cleanStr(o.name, 120),
    series: cleanStr(o.series, 120),
    year,
    color: cleanStr(o.color, 60),
    toyNumber: toy,
    collectorNumber: collector,
    treasureHunt: th,
    confidence,
    notes: cleanStr(o.notes, 300),
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(cfg, cause) {
  const msg = cause?.name === "AbortError"
    ? `Ollama did not answer within ${Math.round(cfg.timeoutMs / 1000)}s.`
    : `Could not reach Ollama (${cause?.cause?.code || cause?.message || "network error"}).`;
  const err = new Error(`${msg} Use the barcode / text scan or type the car number instead.`);
  err.status = 503;
  err.code = "AI_UNREACHABLE";
  return err;
}

async function aiStatus() {
  const cfg = aiConfig();
  if (!cfg.enabled) return { enabled: false, reachable: false, model: cfg.model, modelInstalled: false };
  try {
    const res = await fetchWithTimeout(`${cfg.url}/api/tags`, {}, 4000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name || m.model);
    const want = cfg.model.includes(":") ? cfg.model : `${cfg.model}:latest`;
    return { enabled: true, reachable: true, model: cfg.model, modelInstalled: names.includes(want) };
  } catch (err) {
    return { enabled: true, reachable: false, model: cfg.model, modelInstalled: false, error: err.message };
  }
}

async function identifyCar(image) {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    const err = new Error("AI scan is turned off (AI_SCAN_ENABLED=false).");
    err.status = 503;
    err.code = "AI_DISABLED";
    throw err;
  }
  const b64 = stripDataUrl(image);
  const started = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(`${cfg.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        think: false,
        format: SCHEMA,
        keep_alive: "15m",
        options: { temperature: 0.1, num_ctx: 4096 },
        messages: [{ role: "user", content: PROMPT, images: [b64] }],
      }),
    }, cfg.timeoutMs);
  } catch (err) {
    throw unreachable(cfg, err);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try { detail = JSON.parse(bodyText).error || bodyText; } catch (_) { /* raw */ }
    const err = new Error(`Ollama error: ${String(detail).slice(0, 200)}`);
    err.status = 502;
    err.code = "AI_ERROR";
    throw err;
  }
  let content = "";
  try { content = JSON.parse(bodyText)?.message?.content || ""; } catch (_) { content = ""; }
  const parsed = parseJsonLoose(content);
  if (!parsed) {
    const err = new Error("The AI answered but not in the expected format. Try another photo.");
    err.status = 502;
    err.code = "AI_BAD_OUTPUT";
    throw err;
  }
  return { model: cfg.model, latencyMs: Date.now() - started, result: cleanResult(parsed), raw: content };
}

module.exports = { aiConfig, aiStatus, identifyCar, cleanResult, parseJsonLoose };
