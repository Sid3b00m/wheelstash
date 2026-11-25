const themeKey = "hw-tracker-theme";
const userKey = "hw-tracker-user-id";

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(themeKey, next);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = next === "dark" ? "Light" : "Dark";
}

applyTheme(localStorage.getItem(themeKey) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badges(list) {
  return (list || []).map((c) => `<span class="badge ${escapeHtml(c)}">${escapeHtml(c)}</span>`).join("");
}

function carImage(car) {
  return car.imageUrl || (car.rarityMatches || []).find((m) => m.imageUrl)?.imageUrl || "";
}

function thumb(url, name, large = false) {
  const label = escapeHtml((name || "HW").slice(0, 3).toUpperCase());
  const cls = large ? "thumb lg" : "thumb";
  if (!url) return `<div class="${cls} thumb-placeholder" aria-hidden="true">${label}</div>`;
  return `<div class="${cls}"><img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-placeholder${large ? " lg" : ""}',textContent:'${label}'}))" /></div>`;
}

function formatRefresh(refresh) {
  const state = refresh?.state;
  const el = document.getElementById("lastRefresh");
  if (!el) return;
  if (!state?.lastRunAt) {
    el.textContent = "Last auto-refresh: never";
    return;
  }
  const when = new Date(state.lastRunAt);
  const formatted = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const trigger = state.lastRunTrigger ? ` · ${state.lastRunTrigger}` : "";
  const week = state.lastRunIsoWeek ? ` · ${state.lastRunIsoWeek}` : "";
  el.textContent = `Last auto-refresh: ${formatted}${week}${trigger}`;
  el.title = refresh?.priceNote || "";
}

const state = {
  view: "collection",
  cars: [],
  rarity: { items: [], categories: [], source: {} },
  hunt: null,
  conditions: [],
  refresh: null,
  users: [],
  currentUserId: null,
  stockPrefetch: null,
};


function currentUser() {
  return (state.users || []).find((u) => u.id === state.currentUserId) || null;
}

function userQuery(extra = "") {
  const params = new URLSearchParams(extra);
  if (state.currentUserId) params.set("userId", String(state.currentUserId));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function updateExportLinks() {
  const csv = document.getElementById("exportCsv");
  const json = document.getElementById("exportJson");
  const qs = userQuery();
  if (csv) csv.href = `/api/export.csv${qs}`;
  if (json) json.href = `/api/export.json${qs}`;
}

function setCurrentUser(id, { persist = true } = {}) {
  const num = Number(id);
  const exists = (state.users || []).some((u) => u.id === num);
  state.currentUserId = exists ? num : (state.users[0] ? state.users[0].id : null);
  if (persist && state.currentUserId) localStorage.setItem(userKey, String(state.currentUserId));
  renderUserTabs();
  updateExportLinks();
}

function renderUserTabs() {
  const root = document.getElementById("userTabs");
  if (!root) return;
  root.innerHTML = (state.users || []).map((user) =>
    `<button type="button" class="user-tab${user.id === state.currentUserId ? " is-active" : ""}" data-user-id="${user.id}" role="tab" aria-selected="${user.id === state.currentUserId ? "true" : "false"}">${escapeHtml(user.name)}</button>`
  ).join("");
  const del = document.getElementById("deleteUserBtn");
  if (del) del.disabled = (state.users || []).length <= 1;
}

async function loadUsers() {
  const data = await api("/api/users");
  state.users = data.items || [];
  const saved = Number(localStorage.getItem(userKey));
  const preferred = state.users.some((u) => u.id === saved) ? saved : (state.users[0] && state.users[0].id);
  setCurrentUser(preferred, { persist: true });
}

function setView(name) {
  state.view = name;
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.view === name;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
}

function renderStats(stats = {}) {
  const cells = [
    ["Cars logged", stats.entries ?? 0],
    ["Total pieces", stats.pieces ?? 0],
    ["Rare / flagged", stats.rare ?? 0],
    ["Rarity entries", stats.rarityItems ?? (state.rarity.items || []).length],
  ];
  document.getElementById("stats").innerHTML = cells
    .map(([label, value]) => `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`)
    .join("");
  formatRefresh(state.refresh);
}

function renderCarRow(car) {
  const image = carImage(car);
  const colNum = car.collectorNumber || car.effectiveCollectorNumber || "";
  return el(`<tr>
    <td>${thumb(image, car.name)}${car.stockAttribution && car.imagePref !== "own" && car.stockImageUrl && car.imageUrl === car.stockImageUrl ? `<div class="attr">Wiki · CC-BY-SA</div>` : ""}</td>
    <td><strong>${escapeHtml(car.name)}</strong>${car.casting && car.casting !== car.name ? `<div class="hint">${escapeHtml(car.casting)}</div>` : ""}</td>
    <td>${escapeHtml(car.series)}</td>
    <td>${escapeHtml(car.year ?? "")}</td>
    <td>${escapeHtml(car.color)}</td>
    <td>${escapeHtml(car.condition)}</td>
    <td>${escapeHtml(car.quantity)}</td>
    <td>${escapeHtml(car.storageLocation)}</td>
    <td>${escapeHtml(car.toyNumber)}${colNum ? `<div class="hint">${escapeHtml(colNum)}</div>` : ""}</td>
    <td>${badges(car.rarityBadges)}${(car.rarityMatches || []).map((m) => m.valueEstimate ? `<div class="hint">${escapeHtml(m.valueEstimate)} est.</div>` : "").join("")}</td>
    <td class="row-actions">
      <button type="button" class="btn small" data-edit-car="${car.id}">Edit</button>
      <button type="button" class="btn small danger-ghost" data-del-car="${car.id}">Delete</button>
    </td>
  </tr>`);
}

function renderCars() {
  const body = document.getElementById("carTable");
  const empty = document.getElementById("carEmpty");
  body.innerHTML = "";
  if (!state.cars.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  const sortMode = (document.getElementById("carSort")?.value || "series:asc").split(":")[0];
  if (sortMode === "series") {
    const groups = [];
    for (const car of state.cars) {
      const label = car.seriesGroup || "No series";
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(car);
      else groups.push({ label, items: [car] });
    }
    for (const group of groups) {
      const entries = group.items.length;
      const pieces = group.items.reduce((n, c) => n + (Number(c.quantity) || 1), 0);
      const countText = entries === pieces
        ? `${entries} ${entries === 1 ? "car" : "cars"}`
        : `${entries} ${entries === 1 ? "car" : "cars"} · ${pieces} pcs`;
      body.appendChild(el(`<tr class="series-header"><td colspan="11"><div class="series-header-bar"><strong>${escapeHtml(group.label)}</strong><span>${escapeHtml(countText)}</span></div></td></tr>`));
      for (const car of group.items) body.appendChild(renderCarRow(car));
    }
    return;
  }
  for (const car of state.cars) {
    body.appendChild(renderCarRow(car));
  }
}

function renderRarity() {
  const q = document.getElementById("raritySearch").value.trim().toLowerCase();
  const cat = document.getElementById("rarityFilter").value;
  const items = (state.rarity.items || []).filter((item) => {
    if (cat && item.category !== cat) return false;
    if (!q) return true;
    return [item.name, item.series, item.color, item.toyNumber, item.collectorNumber, item.notes, String(item.year || "")]
      .join(" ").toLowerCase().includes(q);
  });
  const body = document.getElementById("rarityTable");
  body.innerHTML = items.map((item) => `<tr>
    <td>${thumb(item.imageUrl, item.name)}</td>
    <td><strong>${escapeHtml(item.name)}</strong>${item.notes ? `<div class="hint">${escapeHtml(item.notes)}</div>` : ""}${item.imageAttribution ? `<div class="attr">${escapeHtml(item.imageAttribution)}</div>` : ""}</td>
    <td>${badges([item.category])}</td>
    <td>${escapeHtml(item.year ?? "")}</td>
    <td>${escapeHtml(item.color)}</td>
    <td>${escapeHtml(item.toyNumber)}</td>
    <td>${escapeHtml(item.series)}${item.collectorNumber ? ` · ${escapeHtml(item.collectorNumber)}` : ""}</td>
    <td>${escapeHtml(item.valueEstimate)}${item.valueIsEstimate !== false ? " *" : ""}</td>
    <td>${item.huntEligible ? "Yes" : "No"}</td>
    <td class="row-actions">
      <button type="button" class="btn small" data-edit-rarity="${escapeHtml(item.id)}">Edit</button>
      <button type="button" class="btn small danger-ghost" data-del-rarity="${escapeHtml(item.id)}">Delete</button>
    </td>
  </tr>`).join("");
  const src = state.rarity.source || {};
  const links = (src.sources || []).map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`).join(" · ");
  document.getElementById("raritySource").innerHTML =
    `${escapeHtml(src.notes || "Values marked with * are estimates, not live market prices.")}${links ? `<br>${links}` : ""}`;
}

function renderHunt() {
  const hunt = state.hunt;
  if (!hunt) return;
  document.getElementById("huntWeek").textContent = `Week ${hunt.isoWeek}${hunt.cached ? " (cached)" : " (fresh)"}`;
  const s = hunt.summary || {};
  document.getElementById("huntHint").textContent =
    `${s.total || 0} cars to watch in stores: ${s.sth || 0} Super Treasure Hunts, ${s.th || 0} Treasure Hunts, ${s.chase || 0} chases. Unowned current-year TH/STH first, then leftover prior-year STH. Identify STH by spectraflame paint, Real Riders, and a gold flame on the card; regular TH by the circle-flame logo.`;
  const root = document.getElementById("huntList");
  if (!hunt.items?.length) {
    root.innerHTML = `<p class="empty">Nothing to hunt — either the rarity list is empty or you already own the recent targets.</p>`;
    return;
  }
  root.innerHTML = hunt.items.map((item) => `<article class="card ${item.owned ? "owned" : ""}">
    ${thumb(item.imageUrl, item.name, true)}
    ${badges([item.category])}${item.owned ? `<span class="badge owned">Owned</span>` : ""}
    <h3>${escapeHtml(item.name)}</h3>
    <p>${escapeHtml([item.year, item.color, item.series].filter(Boolean).join(" · "))}</p>
    <p>${item.toyNumber ? `Toy # ${escapeHtml(item.toyNumber)}` : ""}${item.collectorNumber ? ` · ${escapeHtml(item.collectorNumber)}` : ""}</p>
    <p>${item.valueEstimate ? `${escapeHtml(item.valueEstimate)} estimate` : ""}</p>
    ${item.imageAttribution ? `<p class="attr">${escapeHtml(item.imageAttribution)}</p>` : ""}
  </article>`).join("");
}

async function loadCars() {
  const [sort, dir] = document.getElementById("carSort").value.split(":");
  const params = new URLSearchParams({
    q: document.getElementById("carSearch").value.trim(),
    rarity: document.getElementById("carRarity").value,
    sort,
    dir,
  });
  if (state.currentUserId) params.set("userId", String(state.currentUserId));
  const data = await api(`/api/cars?${params}`);
  state.cars = data.items;
  state.refresh = data.refresh || state.refresh;
  renderStats(data.stats);
  renderCars();
}

function renderPrefetchStatus(pf) {
  state.stockPrefetch = pf || state.stockPrefetch;
  const info = state.stockPrefetch;
  const text = info?.running
    ? `Loading stock thumbnails in background (${info.cached || 0}/${info.total || 0})…`
    : "";
  for (const id of ["huntPrefetchHint", "rarityPrefetchHint"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.textContent = text;
    node.classList.toggle("hidden", !text);
  }
}

let prefetchTimer = null;
function schedulePrefetchPoll(pf) {
  renderPrefetchStatus(pf);
  if (!pf?.running) {
    if (prefetchTimer) {
      clearTimeout(prefetchTimer);
      prefetchTimer = null;
    }
    return;
  }
  if (prefetchTimer) return;
  prefetchTimer = setTimeout(async () => {
    prefetchTimer = null;
    try {
      await Promise.all([loadRarity(), loadHunt()]);
    } catch (_) { /* ignore transient poll errors */ }
  }, 3500);
}

async function loadRarity() {
  const data = await api("/api/rarity");
  state.rarity = data;
  renderRarity();
  schedulePrefetchPoll(data.stockPrefetch);
}

async function loadHunt() {
  const data = await api(`/api/hunt${userQuery()}`);
  state.hunt = data;
  if (state.hunt.refresh) state.refresh = state.hunt.refresh;
  formatRefresh(state.refresh);
  renderHunt();
  schedulePrefetchPoll(data.stockPrefetch);
}

function fillConditions(select, current) {
  select.innerHTML = `<option value=""></option>` + state.conditions.map((c) =>
    `<option ${c === current ? "selected" : ""}>${escapeHtml(c)}</option>`
  ).join("");
}

function setPreview(id, url, name) {
  document.getElementById(id).innerHTML = thumb(url, name || "HW", true).replace("thumb lg", "thumb lg");
}

async function uploadFile(input, urlField, previewId, sourceField) {
  const file = input.files && input.files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
  const saved = await api("/api/uploads", { method: "POST", body: JSON.stringify({ dataUrl, filename: file.name }) });
  document.getElementById(urlField).value = saved.url;
  if (sourceField) document.getElementById(sourceField).value = "user";
  setPreview(previewId, saved.url, file.name);
}


function photoPref() {
  const checked = document.querySelector('input[name="fImagePref"]:checked');
  return checked ? checked.value : "stock";
}

function syncCarPhotoUI() {
  const stock = document.getElementById("fStockImage").value;
  const own = document.getElementById("fOwnImage").value;
  const pending = document.getElementById("fPendingPhoto")?.value || "";
  const pref = photoPref();
  const display = (pref === "own" && (own || pending))
    ? (own || pending)
    : (stock || own || pending || document.getElementById("fImage").value);
  document.getElementById("fImage").value = display.startsWith("data:") ? (stock || "") : display;
  setPreview("fImagePreview", display, document.getElementById("fName").value || "HW");
  const credit = document.getElementById("fImageCredit");
  const attr = document.getElementById("fStockAttr").value;
  const page = document.getElementById("fStockPage").value;
  if (stock && attr) {
    credit.innerHTML = page
      ? `<a href="${escapeHtml(page)}" target="_blank" rel="noopener">${escapeHtml(attr)}</a>`
      : escapeHtml(attr);
  } else if (own || pending) {
    credit.textContent = "Your photo will be kept only if no stock image is found.";
  } else {
    credit.textContent = "";
  }
  const sw = document.getElementById("fImageSwitch");
  sw.classList.toggle("hidden", !(stock && own));
  document.getElementById("fRepickStockBtn").classList.toggle("hidden", !stock);
}

function applyStockToForm(stock) {
  if (!stock) return;
  document.getElementById("fStockImage").value = stock.stockImageUrl || "";
  document.getElementById("fStockSource").value = stock.stockSourceUrl || "";
  document.getElementById("fStockPage").value = stock.stockPageUrl || "";
  document.getElementById("fStockAttr").value = stock.stockAttribution || "";
  document.getElementById("fOwnImage").value = "";
  document.getElementById("fPendingPhoto").value = "";
  const stockRadio = document.querySelector('input[name="fImagePref"][value="stock"]');
  if (stockRadio) stockRadio.checked = true;
  syncCarPhotoUI();
}

async function findStockForForm({ repick = false } = {}) {
  const btn = document.getElementById("fFindStockBtn");
  const err = document.getElementById("carFormError");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Looking up…";
  err.classList.add("hidden");
  try {
    const body = {
      name: document.getElementById("fName").value,
      series: document.getElementById("fSeries").value,
      year: document.getElementById("fYear").value,
      color: document.getElementById("fColor").value,
      toyNumber: document.getElementById("fToy").value,
    collectorNumber: document.getElementById("fCollector").value,
      casting: document.getElementById("fCasting").value,
    };
    if (repick) {
      const src = document.getElementById("fStockSource").value;
      if (src) body.excludeUrls = [src];
    }
    const data = await api("/api/stock/lookup", { method: "POST", body: JSON.stringify(body) });
    if (!data.found || !data.stock) throw new Error("No stock photo found on the Hot Wheels Wiki for this car.");
    applyStockToForm(data.stock);
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

function renderScanBanner(html) {
  const banner = document.getElementById("carScanBanner");
  if (!banner) return;
  if (!html) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  banner.innerHTML = html;
  banner.classList.remove("hidden");
}

function openCarModal(car, options = {}) {
  const dialog = document.getElementById("carModal");
  const editing = Boolean(car?.id);
  document.getElementById("carModalTitle").textContent = options.title || (editing ? "Edit car" : "Add car");
  document.getElementById("carId").value = car?.id || "";
  document.getElementById("fName").value = car?.name || "";
  document.getElementById("fSeries").value = car?.series || "";
  document.getElementById("fYear").value = car?.year || "";
  document.getElementById("fColor").value = car?.color || "";
  fillConditions(document.getElementById("fCondition"), car?.condition || "");
  document.getElementById("fQty").value = car?.quantity || 1;
  document.getElementById("fStorage").value = car?.storageLocation || "";
  document.getElementById("fToy").value = car?.toyNumber || "";
  document.getElementById("fCollector").value = car?.collectorNumber || "";
  document.getElementById("fUpc").value = car?.upc || "";
  document.getElementById("fCasting").value = car?.casting || "";
  document.getElementById("fNotes").value = car?.notes || "";
  document.getElementById("fImage").value = car?.imageUrl || "";
  document.getElementById("fOwnImage").value = car?.ownImageUrl || "";
  document.getElementById("fPendingPhoto").value = options.pendingPhoto || car?.pendingPhoto || "";
  document.getElementById("fStockImage").value = car?.stockImageUrl || "";
  document.getElementById("fStockSource").value = car?.stockSourceUrl || "";
  document.getElementById("fStockPage").value = car?.stockPageUrl || "";
  document.getElementById("fStockAttr").value = car?.stockAttribution || "";
  document.getElementById("fImageFile").value = "";
  const pref = car?.imagePref === "own" ? "own" : "stock";
  const stockRadio = document.querySelector('input[name="fImagePref"][value="stock"]');
  const ownRadio = document.querySelector('input[name="fImagePref"][value="own"]');
  if (stockRadio) stockRadio.checked = pref !== "own";
  if (ownRadio) ownRadio.checked = pref === "own";
  syncCarPhotoUI();
  document.getElementById("carFormError").classList.add("hidden");
  renderScanBanner(options.banner || "");
  dialog.showModal();
  if (!car?.id && !car?.stockImageUrl && (car?.name || car?.toyNumber)) {
    findStockForForm().catch(() => { /* form still works without a stock photo */ });
  }
}

function openRarityModal(item) {
  const dialog = document.getElementById("rarityModal");
  document.getElementById("rarityModalTitle").textContent = item ? "Edit rarity entry" : "Add rarity entry";
  document.getElementById("rId").value = item?.id || "";
  document.getElementById("rName").value = item?.name || "";
  document.getElementById("rCategory").value = item?.category || "STH";
  document.getElementById("rYear").value = item?.year || "";
  document.getElementById("rColor").value = item?.color || "";
  document.getElementById("rToy").value = item?.toyNumber || "";
  document.getElementById("rCol").value = item?.collectorNumber || "";
  document.getElementById("rSeries").value = item?.series || "";
  document.getElementById("rValue").value = item?.valueEstimate || "";
  document.getElementById("rHunt").checked = item ? Boolean(item.huntEligible) : true;
  document.getElementById("rNotes").value = item?.notes || "";
  document.getElementById("rImage").value = item?.imageUrl || "";
  document.getElementById("rImageSource").value = item?.imageSource || "";
  document.getElementById("rImageFile").value = "";
  setPreview("rImagePreview", item?.imageUrl || "", item?.name);
  document.getElementById("rarityFormError").classList.add("hidden");
  dialog.showModal();
}

document.getElementById("themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

["carSearch", "carRarity", "carSort"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => loadCars().catch(console.error));
  document.getElementById(id).addEventListener("change", () => loadCars().catch(console.error));
});
["raritySearch", "rarityFilter"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderRarity);
  document.getElementById(id).addEventListener("change", renderRarity);
});

document.getElementById("addCarBtn").addEventListener("click", () => openCarModal(null));
document.getElementById("fetchStockBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fetchStockBtn");
  if (!confirm("Look up a Hot Wheels Wiki stock photo for every car in this collection that doesn't have one yet? This may take a minute.")) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Fetching…";
  try {
    const result = await api("/api/stock/backfill", {
      method: "POST",
      body: JSON.stringify({ userId: state.currentUserId }),
    });
    await loadCars();
    alert(`Stock photos: ${result.filled} added, ${result.skipped} already had one, ${result.missing} not found.`);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});
document.getElementById("addRarityBtn").addEventListener("click", () => openRarityModal(null));
document.getElementById("carCancel").addEventListener("click", () => { renderScanBanner(""); document.getElementById("carModal").close(); });
document.getElementById("rarityCancel").addEventListener("click", () => document.getElementById("rarityModal").close());
document.getElementById("fImageSwitch").addEventListener("change", syncCarPhotoUI);
document.getElementById("fFindStockBtn").addEventListener("click", () => findStockForForm().catch(console.error));
document.getElementById("fRepickStockBtn").addEventListener("click", () => findStockForForm({ repick: true }).catch(console.error));
document.getElementById("rImage").addEventListener("input", (event) => {
  document.getElementById("rImageSource").value = event.target.value ? "user" : "";
  setPreview("rImagePreview", event.target.value, "HW");
});
document.getElementById("fImageFile").addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (document.getElementById("fStockImage").value) {
    document.getElementById("carFormError").textContent = "A stock photo is already set, so the phone photo was not kept.";
    document.getElementById("carFormError").classList.remove("hidden");
    return;
  }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read that file."));
      reader.readAsDataURL(file);
    });
    document.getElementById("fPendingPhoto").value = dataUrl;
    document.getElementById("fOwnImage").value = "";
    syncCarPhotoUI();
  } catch (err) {
    document.getElementById("carFormError").textContent = err.message;
    document.getElementById("carFormError").classList.remove("hidden");
  }
});
document.getElementById("rImageFile").addEventListener("change", () => {
  uploadFile(document.getElementById("rImageFile"), "rImage", "rImagePreview", "rImageSource").catch((err) => {
    document.getElementById("rarityFormError").textContent = err.message;
    document.getElementById("rarityFormError").classList.remove("hidden");
  });
});

document.getElementById("carForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.getElementById("carId").value;
  const errBox = document.getElementById("carFormError");
  const stockImageUrl = document.getElementById("fStockImage").value;
  const pending = document.getElementById("fPendingPhoto").value;
  let ownImageUrl = document.getElementById("fOwnImage").value;
  if (stockImageUrl) {
    ownImageUrl = "";
  } else if (pending && pending.startsWith("data:")) {
    try {
      ownImageUrl = await uploadScanPhoto(pending);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      return;
    }
  }
  const payload = {
    name: document.getElementById("fName").value,
    series: document.getElementById("fSeries").value,
    year: document.getElementById("fYear").value,
    color: document.getElementById("fColor").value,
    condition: document.getElementById("fCondition").value,
    quantity: document.getElementById("fQty").value,
    storageLocation: document.getElementById("fStorage").value,
    toyNumber: document.getElementById("fToy").value,
    casting: document.getElementById("fCasting").value,
    notes: document.getElementById("fNotes").value,
    imageUrl: stockImageUrl || ownImageUrl || document.getElementById("fImage").value,
    ownImageUrl,
    stockImageUrl,
    stockSourceUrl: document.getElementById("fStockSource").value,
    stockPageUrl: document.getElementById("fStockPage").value,
    stockAttribution: document.getElementById("fStockAttr").value,
    imagePref: stockImageUrl ? "stock" : photoPref(),
    fetchStock: !stockImageUrl,
    upc: document.getElementById("fUpc").value,
    userId: state.currentUserId,
  };
  try {
    if (id) await api(`/api/cars/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/api/cars", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("carModal").close();
    await loadCars();
    await loadHunt();
  } catch (err) {
    const box = document.getElementById("carFormError");
    box.textContent = err.message;
    box.classList.remove("hidden");
  }
});

document.getElementById("rarityForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.getElementById("rId").value;
  const payload = {
    name: document.getElementById("rName").value,
    category: document.getElementById("rCategory").value,
    year: document.getElementById("rYear").value,
    color: document.getElementById("rColor").value,
    toyNumber: document.getElementById("rToy").value,
    collectorNumber: document.getElementById("rCol").value,
    series: document.getElementById("rSeries").value,
    valueEstimate: document.getElementById("rValue").value,
    valueIsEstimate: true,
    huntEligible: document.getElementById("rHunt").checked,
    notes: document.getElementById("rNotes").value,
    imageUrl: document.getElementById("rImage").value,
    imageSource: document.getElementById("rImageSource").value,
  };
  try {
    if (id) await api(`/api/rarity/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/api/rarity", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("rarityModal").close();
    await loadRarity();
    await loadCars();
    await loadHunt();
  } catch (err) {
    const box = document.getElementById("rarityFormError");
    box.textContent = err.message;
    box.classList.remove("hidden");
  }
});

document.getElementById("carTable").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-car]");
  const del = event.target.closest("[data-del-car]");
  if (edit) {
    const car = await api(`/api/cars/${edit.dataset.editCar}`);
    openCarModal(car);
  } else if (del && confirm("Delete this car from the collection?")) {
    await api(`/api/cars/${del.dataset.delCar}`, { method: "DELETE" });
    await loadCars();
    await loadHunt();
  }
});

document.getElementById("rarityTable").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-rarity]");
  const del = event.target.closest("[data-del-rarity]");
  if (edit) {
    const item = (state.rarity.items || []).find((i) => i.id === edit.dataset.editRarity);
    if (item) openRarityModal(item);
  } else if (del && confirm("Delete this rarity entry?")) {
    await api(`/api/rarity/${encodeURIComponent(del.dataset.delRarity)}`, { method: "DELETE" });
    await loadRarity();
    await loadCars();
    await loadHunt();
  }
});

document.getElementById("refreshHunt").addEventListener("click", async () => {
  state.hunt = await api(`/api/hunt/refresh${userQuery()}`, { method: "POST", body: "{}" });
  if (state.hunt.refresh) state.refresh = state.hunt.refresh;
  formatRefresh(state.refresh);
  renderHunt();
});

document.getElementById("resetRarityBtn").addEventListener("click", async () => {
  if (!confirm("Replace your editable rarity list with the original seed list? Custom entries will be lost.")) return;
  state.rarity = await api("/api/rarity/reset", { method: "POST", body: "{}" });
  renderRarity();
  await loadCars();
  await loadHunt();
});


document.getElementById("userTabs").addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-user-id]");
  if (!tab) return;
  setCurrentUser(tab.dataset.userId);
  await Promise.all([loadCars(), loadHunt()]);
});

document.getElementById("addUserBtn").addEventListener("click", async () => {
  const name = prompt("Name for the new collector?");
  if (name == null) return;
  try {
    const user = await api("/api/users", { method: "POST", body: JSON.stringify({ name }) });
    state.users = (await api("/api/users")).items || [];
    setCurrentUser(user.id);
    await Promise.all([loadCars(), loadHunt()]);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("renameUserBtn").addEventListener("click", async () => {
  const user = currentUser();
  if (!user) return;
  const name = prompt("Rename this collector:", user.name);
  if (name == null) return;
  try {
    await api(`/api/users/${user.id}`, { method: "PUT", body: JSON.stringify({ name }) });
    state.users = (await api("/api/users")).items || [];
    setCurrentUser(user.id);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("deleteUserBtn").addEventListener("click", async () => {
  const user = currentUser();
  if (!user) return;
  if ((state.users || []).length <= 1) {
    alert("You cannot delete the last collector.");
    return;
  }
  if (!confirm(`Delete ${user.name} and their entire collection? This cannot be undone.`)) return;
  try {
    await api(`/api/users/${user.id}`, { method: "DELETE" });
    await loadUsers();
    await Promise.all([loadCars(), loadHunt()]);
  } catch (err) {
    alert(err.message);
  }
});


function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.getAttribute("src") === src)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureScanLibs() {
  await loadScript("/vendor/zxing/index.min.js");
  await loadScript("/vendor/tesseract/tesseract.min.js");
}

let tessWorkerPromise = null;
async function getTessWorker(onStatus) {
  if (!tessWorkerPromise) {
    tessWorkerPromise = (async () => {
      if (onStatus) onStatus("Loading text recognition…");
      return Tesseract.createWorker("eng", 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract/tesseract-core-lstm.wasm.js",
        langPath: "/vendor/tesseract",
        gzip: true,
        workerBlobURL: false,
        logger: (msg) => {
          if (!onStatus || !msg) return;
          if (msg.status === "recognizing text" && msg.progress != null) {
            onStatus(`Reading text… ${Math.round(msg.progress * 100)}%`);
          } else if (msg.status && msg.status !== "recognizing text") {
            onStatus(msg.status.replaceAll("-", " ") + "…");
          }
        },
      });
    })();
  }
  return tessWorkerPromise;
}

const scanState = {
  stream: null,
  timer: null,
  busy: false,
  photoUrl: "",
  ai: null,
};

function setScanBusy(on) {
  document.getElementById("scanSpinner")?.classList.toggle("hidden", !on);
  for (const id of ["scanAiBtn", "scanFrameBtn"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = Boolean(on);
  }
}

async function refreshAiStatus() {
  try {
    scanState.ai = await api("/api/scan/ai/status");
  } catch (_) {
    scanState.ai = { enabled: false, reachable: false };
  }
  const btn = document.getElementById("scanAiBtn");
  if (btn) btn.classList.toggle("hidden", !scanState.ai.enabled);
  return scanState.ai;
}

function setScanStatus(text) {
  const el = document.getElementById("scanStatus");
  if (el) el.textContent = text || "";
}

function stopScanCamera() {
  if (scanState.timer) {
    clearInterval(scanState.timer);
    scanState.timer = null;
  }
  if (scanState.stream) {
    scanState.stream.getTracks().forEach((track) => track.stop());
    scanState.stream = null;
  }
  const video = document.getElementById("scanVideo");
  if (video) video.srcObject = null;
}

function closeScanModal() {
  stopScanCamera();
  scanState.busy = false;
  document.getElementById("scanModal").close();
}

function drawToCanvas(source, max = 1600) {
  const canvas = document.getElementById("scanCanvas");
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToDataUrl(canvas) {
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function detectBarcodes(canvas) {
  const found = [];
  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39"] });
      const codes = await detector.detect(canvas);
      for (const code of codes || []) {
        if (code.rawValue) found.push(code.rawValue);
      }
    } catch (_) { /* fall through to ZXing */ }
  }
  if (!found.length && window.ZXing) {
    try {
      const hints = new Map();
      if (ZXing.DecodeHintType && ZXing.BarcodeFormat) {
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          ZXing.BarcodeFormat.UPC_A,
          ZXing.BarcodeFormat.UPC_E,
          ZXing.BarcodeFormat.EAN_13,
          ZXing.BarcodeFormat.EAN_8,
          ZXing.BarcodeFormat.CODE_128,
        ]);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      }
      const reader = new ZXing.BrowserMultiFormatReader(hints);
      const img = document.getElementById("scanSnap");
      img.src = canvasToDataUrl(canvas);
      await img.decode?.().catch(() => new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      }));
      const result = await reader.decodeFromImageElement(img);
      if (result?.getText) found.push(result.getText());
      else if (result?.text) found.push(result.text);
    } catch (_) { /* no barcode in this frame */ }
  }
  return [...new Set(found)];
}

async function recognizeText(canvas, onStatus) {
  const worker = await getTessWorker(onStatus);
  const { data } = await worker.recognize(canvas);
  return (data && data.text) || "";
}

function badgeLabel(code) {
  return ({ STH: "Super Treasure Hunt!", TH: "Treasure Hunt", CHASE: "Chase", RLC: "Red Line Club", ERROR: "Error / Variant", HIGH: "High value" })[code] || code;
}

function candidateBanner(result, picked) {
  const badges = (picked?.rarityBadges || result.prefill?.rarityBadges || []).map((c) =>
    `<span class="badge ${escapeHtml(c)}">${escapeHtml(badgeLabel(c))}</span>`
  ).join(" ");
  const owned = result.alreadyOwned && result.alreadyOwned[0];
  const parts = [];
  if (owned) {
    parts.push(`Already in this collection (qty ${owned.quantity}). Saving will set the quantity to ${owned.suggestedQuantity}.`);
  }
  if (badges) parts.push(badges);
  if (!owned && !badges && result.prefill?.toyNumber) parts.push("No rarity match yet — check the fields before saving.");
  return parts.join(" ");
}

function prefillFromLookup(result, options = {}) {
  const owned = result.alreadyOwned && result.alreadyOwned[0];
  const pick = options.candidate || null;
  const base = pick || result.prefill || {};
  const imageUrl = options.imageUrl || base.imageUrl || "";
  if (owned && !options.asNew) {
    openCarModal({
      ...owned,
      quantity: owned.suggestedQuantity,
      collectorNumber: base.collectorNumber || owned.collectorNumber || "",
      upc: base.upc || owned.upc || result.query?.upc || "",
      imageUrl: owned.imageUrl || (imageUrl && !String(imageUrl).startsWith("data:") ? imageUrl : ""),
    }, {
      title: "Add another?",
      banner: [options.extraBanner, candidateBanner(result, owned)].filter(Boolean).join(" "),
      pendingPhoto: !owned.stockImageUrl && imageUrl && String(imageUrl).startsWith("data:") ? imageUrl : "",
    });
    return;
  }
  openCarModal({
    name: base.name || "",
    series: base.series || "",
    year: base.year || "",
    color: base.color || "",
    toyNumber: base.toyNumber || "",
    collectorNumber: base.collectorNumber || "",
    upc: base.upc || result.query?.upc || "",
    casting: base.casting || "",
    imageUrl: imageUrl && !String(imageUrl).startsWith("data:") ? imageUrl : "",
    ownImageUrl: imageUrl && String(imageUrl).startsWith("/uploads/") ? imageUrl : "",
    imagePref: "stock",
    quantity: 1,
  }, {
    title: "Add car",
    banner: [options.extraBanner, candidateBanner({ ...result, alreadyOwned: [] }, base)].filter(Boolean).join(" "),
    pendingPhoto: imageUrl && String(imageUrl).startsWith("data:") ? imageUrl : "",
  });
}

async function uploadScanPhoto(dataUrl) {
  if (!dataUrl) return "";
  const saved = await api("/api/uploads", { method: "POST", body: JSON.stringify({ dataUrl }) });
  return saved.url || "";
}

async function lookupScanPayload(payload) {
  return api("/api/scan/lookup", {
    method: "POST",
    body: JSON.stringify({ ...payload, userId: state.currentUserId }),
  });
}

function renderScanResults(result, imageUrl) {
  const root = document.getElementById("scanResults");
  const owned = result.alreadyOwned || [];
  const candidates = result.candidates || [];
  let html = "";
  if (owned.length) {
    html += owned.map((car) => `
      <button type="button" class="scan-hit" data-owned-id="${car.id}">
        <strong>${escapeHtml(car.name)}</strong>
        <div class="hint">Already owned · qty ${escapeHtml(car.quantity)} → ${escapeHtml(car.suggestedQuantity)} ${badges(car.rarityBadges)}</div>
        <div class="hint">Review and confirm to add one more. Nothing is saved yet.</div>
      </button>`).join("");
  }
  if (candidates.length) {
    html += candidates.map((item, idx) => `
      <button type="button" class="scan-hit" data-candidate-idx="${idx}">
        <strong>${escapeHtml(item.name || "Match")}</strong>
        <div class="hint">${escapeHtml([item.year, item.color, item.series, item.toyNumber].filter(Boolean).join(" · "))} ${badges(item.rarityBadges)}</div>
        ${item.isRare ? `<div class="hint">${escapeHtml((item.rarityBadges || []).map(badgeLabel).join(", "))}</div>` : ""}
      </button>`).join("");
  }
  if (!html) {
    html = `<button type="button" class="scan-hit" data-use-prefill="1">
      <strong>Use what was read</strong>
      <div class="hint">${escapeHtml([result.prefill?.toyNumber, result.prefill?.upc, result.query?.raw].filter(Boolean).join(" · ") || "No match found — you can fill the form manually.")}</div>
    </button>`;
  }
  root.innerHTML = html;
  root.classList.remove("hidden");
  root.onclick = (event) => {
    const ownedBtn = event.target.closest("[data-owned-id]");
    const candBtn = event.target.closest("[data-candidate-idx]");
    const prefillBtn = event.target.closest("[data-use-prefill]");
    if (ownedBtn) {
      closeScanModal();
      prefillFromLookup(result, { imageUrl });
    } else if (candBtn) {
      closeScanModal();
      prefillFromLookup(result, { candidate: candidates[Number(candBtn.dataset.candidateIdx)], imageUrl, asNew: true });
    } else if (prefillBtn) {
      closeScanModal();
      prefillFromLookup(result, { imageUrl, asNew: true });
    }
  };
}

async function processScanSource(source, { fromLive = false } = {}) {
  if (scanState.busy) return;
  scanState.busy = true;
  setScanBusy(true);
  const results = document.getElementById("scanResults");
  results.classList.add("hidden");
  results.innerHTML = "";
  try {
    await ensureScanLibs();
    const canvas = drawToCanvas(source);
    if (!canvas) {
      setScanStatus("Could not read that image. Try another photo.");
      return;
    }
    const snap = document.getElementById("scanSnap");
    const dataUrl = canvasToDataUrl(canvas);
    snap.src = dataUrl;
    snap.classList.remove("hidden");
    document.getElementById("scanVideo").classList.add("hidden");
    if (fromLive) stopScanCamera();

    setScanStatus("Looking for a barcode…");
    const codes = await detectBarcodes(canvas);
    const upc = codes[0] || "";
    if (upc) setScanStatus(`Found barcode ${upc}. Reading text…`);
    else setScanStatus("Reading text…");

    let text = "";
    try {
      text = await recognizeText(canvas, setScanStatus);
    } catch (err) {
      setScanStatus(`Text recognition failed (${err.message}). Using barcode only.`);
    }

    setScanStatus("Matching…");
    const result = await lookupScanPayload({ upc, text, query: [upc, text].filter(Boolean).join("\n") });
    const imageUrl = dataUrl || "";
    const summary = [];
    if (upc) summary.push(`Barcode ${upc}`);
    if (result.prefill?.toyNumber) summary.push(`Toy # ${result.prefill.toyNumber}`);
    if (result.prefill?.isRare) summary.push((result.prefill.rarityBadges || []).map(badgeLabel).join(", "));
    if (!result.candidates.length && !result.alreadyOwned.length) summary.push("No automatic match — review the form before saving.");
    setScanStatus(summary.join(" · ") || "Done. Pick a match or open the form.");
    renderScanResults(result, imageUrl);
  } catch (err) {
    setScanStatus(err.message);
  } finally {
    scanState.busy = false;
    setScanBusy(false);
  }
}

function aiBannerHtml(ai) {
  if (!ai) return "";
  const pct = Math.round((ai.confidence || 0) * 100);
  const read = [ai.name, ai.year, ai.color, ai.series, ai.toyNumber, ai.collectorNumber].filter(Boolean).join(" · ");
  return `<div><strong>AI suggestion</strong> (${pct}% sure, ${(ai.latencyMs / 1000).toFixed(1)}s): ${escapeHtml(read || "nothing readable")}. Check every field before saving.</div>`;
}

async function identifyWithAi(source, { fromLive = false } = {}) {
  if (scanState.busy) return;
  scanState.busy = true;
  setScanBusy(true);
  const results = document.getElementById("scanResults");
  results.classList.add("hidden");
  results.innerHTML = "";
  try {
    const canvas = drawToCanvas(source, 1024);
    if (!canvas) {
      setScanStatus("Could not read that image. Try another photo.");
      return;
    }
    const dataUrl = canvasToDataUrl(canvas);
    const snap = document.getElementById("scanSnap");
    snap.src = dataUrl;
    snap.classList.remove("hidden");
    document.getElementById("scanVideo").classList.add("hidden");
    if (fromLive) stopScanCamera();
    setScanStatus("Asking the AI box what car this is… (first run can take up to a minute)");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 100000);
    let result;
    try {
      result = await api("/api/scan/ai", {
        method: "POST",
        body: JSON.stringify({ image: dataUrl, userId: state.currentUserId }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = err.name === "AbortError" ? "The AI box took too long." : err.message;
      setScanStatus(`AI identify failed: ${msg} Tap “Scan barcode / text” to use the on-phone scanner, or type the car number.`);
      return;
    } finally {
      clearTimeout(timer);
    }
    const ai = result.ai || {};
    setScanStatus(`AI: ${ai.name || "unknown car"} (${Math.round((ai.confidence || 0) * 100)}% sure). Opening the form…`);
    renderScanResults(result, dataUrl);
    closeScanModal();
    prefillFromLookup(result, { imageUrl: dataUrl, extraBanner: aiBannerHtml(ai) });
  } catch (err) {
    setScanStatus(err.message);
  } finally {
    scanState.busy = false;
    setScanBusy(false);
  }
}

function currentScanSource() {
  const video = document.getElementById("scanVideo");
  const snap = document.getElementById("scanSnap");
  const live = Boolean(scanState.stream) && !video.classList.contains("hidden");
  return { source: !live && snap.src && !snap.classList.contains("hidden") ? snap : video, live };
}

async function startScanCamera() {
  const video = document.getElementById("scanVideo");
  const snap = document.getElementById("scanSnap");
  snap.classList.add("hidden");
  video.classList.remove("hidden");
  document.getElementById("scanResults").classList.add("hidden");
  const secure = window.isSecureContext;
  if (!secure) {
    setScanStatus("Camera access needs HTTPS (or localhost). Use the Tailscale link, or take a photo instead.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setScanStatus("This browser cannot open the camera. Use Take a photo instead.");
    return;
  }
  const attempts = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: "environment" }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      scanState.stream = await navigator.mediaDevices.getUserMedia(constraints);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!scanState.stream) {
    setScanStatus(lastErr?.message || "Could not open the camera. Use Take a photo instead.");
    return;
  }
  video.srcObject = scanState.stream;
  try { await video.play(); } catch (_) { /* autoplay may need a tap */ }
  setScanStatus("Point at the card back, then tap Scan this frame — or wait if a barcode is visible.");
  scanState.timer = setInterval(async () => {
    if (scanState.busy || !scanState.stream) return;
    const canvas = drawToCanvas(video);
    if (!canvas) return;
    try {
      const codes = await detectBarcodes(canvas);
      if (codes.length) await processScanSource(video, { fromLive: true });
    } catch (_) { /* keep previewing */ }
  }, 700);
}

async function openScanModal() {
  document.getElementById("scanModal").showModal();
  setScanStatus("Starting camera…");
  refreshAiStatus();
  ensureScanLibs().catch(() => { /* loaded again on demand */ });
  await startScanCamera();
}

async function lookupCarNumber(query) {
  const text = String(query || "").trim();
  if (!text) return;
  const result = await lookupScanPayload({ query: text, text });
  prefillFromLookup(result);
}

document.getElementById("scanCarBtn").addEventListener("click", () => {
  openScanModal().catch((err) => setScanStatus(err.message));
});
document.getElementById("scanCloseBtn").addEventListener("click", closeScanModal);
document.getElementById("scanModal").addEventListener("close", stopScanCamera);
document.getElementById("scanFrameBtn").addEventListener("click", () => {
  const { source, live } = currentScanSource();
  processScanSource(source, { fromLive: live }).catch((err) => setScanStatus(err.message));
});
document.getElementById("scanAiBtn").addEventListener("click", () => {
  const { source, live } = currentScanSource();
  identifyWithAi(source, { fromLive: live }).catch((err) => setScanStatus(err.message));
});
document.getElementById("scanFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const url = URL.createObjectURL(file);
    const img = document.getElementById("scanSnap");
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Could not open that photo."));
    });
    img.classList.remove("hidden");
    document.getElementById("scanVideo").classList.add("hidden");
    stopScanCamera();
    const modal = document.getElementById("scanModal");
    if (!modal.open) modal.showModal();
    const ai = scanState.ai || await refreshAiStatus();
    if (ai.enabled && ai.reachable) await identifyWithAi(img);
    else await processScanSource(img);
    URL.revokeObjectURL(url);
  } catch (err) {
    setScanStatus(err.message);
  }
});
document.getElementById("addByNumberForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("carNumberInput");
  try {
    await lookupCarNumber(input.value);
  } catch (err) {
    alert(err.message);
  }
});


async function init() {
  const meta = await api("/api/meta");
  state.conditions = meta.conditions || [];
  state.refresh = meta.refresh || null;
  fillConditions(document.getElementById("fCondition"), "");
  formatRefresh(state.refresh);
  if (meta.users) state.users = meta.users;
  await loadUsers();
  await Promise.all([loadCars(), loadRarity(), loadHunt()]);
}

init().catch((err) => {
  renderStats();
  document.getElementById("carEmpty").classList.remove("hidden");
  document.getElementById("carEmpty").textContent = `Could not load the app: ${err.message}`;
});
