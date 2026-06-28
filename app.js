/* SmartDispatch v3 — autonomous logistics agent
   Single delegated click/change dispatcher → every [data-act] button is wired by construction.
   Pipeline: Perceive(Groq) → Plan(geocode+optimize+OSRM) → Assess(windows+client memory)
            → Cost/Savings/Profit → Risks+Confidence → Monitor/Act(delay,replan,notify) → Learn → Daily report. */
"use strict";

/* ============================ storage + i18n ============================ */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const K = { drivers: "sd.drivers", active: "sd.active", settings: "sd.settings", clients: "sd.clients", memory: "sd.memory", routes: "sd.routes", lang: "sd.lang" };

let LANG = store.get(K.lang, "bg");
const L = (bg, en) => (LANG === "bg" ? bg : en);

/* ============================ constants ============================ */
const HANDLING_FALLBACK = 7, RISK_WINDOW_MIN = 15, TIGHT_WINDOW_MIN = 20, CITY_SPEED_KMH = 30;
const DEF_SETTINGS = { currency: "EUR", fuelPrice: 1.50, handling: 7, workingDays: 22, deliveryFee: 5, routeType: "mixed", optimize: "balanced", company: "StaGove Logistics" };
const SAMPLE = `Иван Петров, ул. Граф Игнатиев 15, София, до 10:30, 0888123456
Пекарна Слънце, бул. Витоша 89, София, между 13:00 и 15:00, 0899765432
Мария Георгиева, ж.к. Младост 1 бл. 22, София, след 14:00, 0877111222
Аптека Здраве, ул. Иван Вазов 5, София, затваря в 18:00, 029876543
Ресторант Балкан, бул. Цариградско шосе 115, София, 0888000111`;

/* ============================ data accessors ============================ */
const drivers = () => store.get(K.drivers, []);
const routes = () => store.get(K.routes, []);
const settings = () => Object.assign({}, DEF_SETTINGS, store.get(K.settings, {}));
function activeDriver() { const id = store.get(K.active, null); const ds = drivers(); return ds.find((d) => d.id === id) || ds[0] || null; }

/* ---- the agent fetches live fuel prices itself; the user never types a price ---- */
const FUEL_FALLBACK = { currency: "EUR", prices: { petrol: 1.49, diesel: 1.50, lpg: 0.64 }, source: "нац. средна (юни 2026)", date: "", live: false };
let fuelCache = store.get("sd.fuel", null);
async function loadFuel(force) {
  if (fuelCache && !force && fuelCache.fetchedAt && Date.now() - fuelCache.fetchedAt < 6 * 3600e3) return fuelCache;
  try {
    const r = await fetch("/api/fuel");
    if (r.ok) { const d = await r.json(); if (d && d.prices) { fuelCache = Object.assign({ fetchedAt: Date.now() }, d); store.set("sd.fuel", fuelCache); logEvent(L("гориво", "fuel"), `${d.live ? L("живи цени", "live") : L("резервни цени", "fallback")} · ${L("дизел", "diesel")} ${(+d.prices.diesel).toFixed(2)} ${d.currency || "EUR"} · ${d.source || ""}`); return fuelCache; } }
  } catch (e) {}
  if (!fuelCache) fuelCache = Object.assign({ fetchedAt: Date.now() }, FUEL_FALLBACK);
  return fuelCache;
}
function priceFor(fuelType) {
  const f = fuelCache || FUEL_FALLBACK, p = f.prices || FUEL_FALLBACK.prices;
  let price = p.diesel;
  if (fuelType === "petrol") price = p.petrol; else if (fuelType === "lpg") price = p.lpg; else if (fuelType === "electric") price = 0.30; else if (fuelType === "hybrid") price = (p.petrol || 1.5) * 0.6;
  return { price: price || 1.5, source: f.source || FUEL_FALLBACK.source, date: f.date || "", live: !!f.live, currency: f.currency || "EUR" };
}
/* the agent derives vehicle consumption from the model — stable knowledge, not the user's job */
async function deriveVehicle(model, vtype) {
  const sys = "You are a vehicle fuel-economy expert. Given a vehicle, reply ONLY with JSON {\"fuelType\":\"diesel|petrol|lpg|electric|hybrid\",\"cityCons\":<number L/100km>,\"highwayCons\":<number L/100km>,\"note\":\"<=6 words\"}. Use realistic manufacturer-typical figures for that exact model. For electric use kWh/100km in the same fields.";
  const out = await callGroq([{ role: "system", content: sys }, { role: "user", content: ((model || "") + " " + (vtype || "")).trim() }], true);
  try { return JSON.parse(out); } catch (e) { const m = out.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; }
}
async function deriveVehicleNow() {
  const inp = $("df-vehicleName"); const model = inp.value.trim();
  if (!model) { inp.focus(); inp.classList.add("flash"); setTimeout(() => inp.classList.remove("flash"), 700); return; }
  const btn = document.querySelector('[data-act="derive-vehicle"]'); const old = btn && btn.textContent;
  if (btn) { btn.textContent = L("Агентът мисли…", "Agent thinking…"); btn.disabled = true; }
  try {
    const v = await deriveVehicle(model, $("df-vehicleType").value);
    if (v.fuelType && $("df-fuelType")) $("df-fuelType").value = v.fuelType;
    if (v.cityCons && $("df-cityCons")) $("df-cityCons").value = v.cityCons;
    if (v.highwayCons && $("df-highwayCons")) $("df-highwayCons").value = v.highwayCons;
    logEvent(L("кола", "vehicle"), `${model}: ${v.cityCons || "?"}/${v.highwayCons || "?"} L/100${v.note ? " · " + v.note : ""}`);
  } catch (e) { logEvent(L("кола", "vehicle"), L("неуспех — попълни ръчно", "failed — fill manually")); }
  finally { if (btn) { btn.textContent = old; btn.disabled = false; } }
}

/* ============================ state ============================ */
const state = { stops: [], plan: null, routeStarted: false, log: [], activeTab: "route", routeType: settings().routeType, notified: 0 };

/* ============================ utils ============================ */
const $ = (id) => document.getElementById(id);
const uid = () => "x" + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minToHHMM = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const normKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function haversineKm(a, b) { const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180, la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function totalHaversine(arr) { let d = 0; for (let i = 1; i < arr.length; i++) d += haversineKm(arr[i - 1], arr[i]); return d; }
function normalizePhone(raw) { if (!raw) return ""; let d = String(raw).replace(/[^\d+]/g, "").replace(/^\+/, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("0")) d = "359" + d.slice(1); else if (!d.startsWith("359") && d.length === 9) d = "359" + d; return d; }
function setStatus(s) { const p = $("statusPill"); p.dataset.state = s; p.textContent = { idle: L("готов", "ready"), working: L("обработва", "working"), done: L("готово", "done"), error: L("грешка", "error") }[s]; }
function logEvent(cat, msg) { const d = new Date(); state.log.push({ t: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`, cat, msg }); renderLog(); }

/* time / constraint parsing */
function parseTime(frag) { if (!frag) return null; let s = frag.toLowerCase().trim(); const pm = /\bpm\b|\bp\.m\.?/.test(s), am = /\bam\b|\ba\.m\.?/.test(s); s = s.replace(/часа|час|ч\.?|pm|am|p\.m\.?|a\.m\.?|h/g, "").trim(); let m = s.match(/(\d{1,2})[:.](\d{2})/), hh, mm; if (m) { hh = +m[1]; mm = +m[2]; } else { m = s.match(/(\d{1,2})/); if (!m) return null; hh = +m[1]; mm = 0; } if (pm && hh < 12) hh += 12; if (am && hh === 12) hh = 0; if (hh > 23 || mm > 59) return null; return hh * 60 + mm; }
function parseConstraint(text) { if (!text) return { kind: "none" }; const s = text.toLowerCase().trim(); let m = s.match(/(?:between|между)\s*(.+?)\s*(?:and|и|–|—|-)\s*(.+)/) || s.match(/(\d{1,2}[:.]?\d{0,2})\s*[-–—]\s*(\d{1,2}[:.]?\d{0,2})/); if (m) { const o = parseTime(m[1]), c = parseTime(m[2]); if (o != null && c != null) return { kind: "window", open: o, close: c }; } if (/^\s*(after|след)\b/.test(s)) { const o = parseTime(s); if (o != null) return { kind: "after", open: o }; } if (/(before|by|until|до|close|closes|затваря|край)/.test(s)) { const c = parseTime(s); if (c != null) return { kind: "deadline", close: c }; } const b = parseTime(s); if (b != null) return { kind: "deadline", close: b }; return { kind: "none" }; }
function evaluateLabel(arr, c) { if (!c || c.kind === "none") return "on_time"; if (c.kind === "after") return arr < c.open ? "early" : "on_time"; if (c.kind === "window") { if (arr < c.open) return "early"; if (arr > c.close) return "late"; if (c.close - arr <= RISK_WINDOW_MIN) return "at_risk"; return "on_time"; } if (arr > c.close) return "late"; if (c.close - arr <= RISK_WINDOW_MIN) return "at_risk"; return "on_time"; }

/* ============================ NAVIGATION ============================ */
const TABS = [
  { id: "route", bg: "Маршрут", en: "Route" }, { id: "driver", bg: "Шофьор", en: "Driver" },
  { id: "report", bg: "Отчет", en: "Report" },
  { id: "settings", bg: "Настройки", en: "Settings" },
];
function renderTabs() {
  $("tabs").innerHTML = TABS.map((tb) => {
    return `<button class="tab ${tb.id === state.activeTab ? "active" : ""}" data-act="tab" data-tab="${tb.id}">${L(tb.bg, tb.en)}</button>`;
  }).join("");
}
function switchTab(id) {
  state.activeTab = id;
  TABS.forEach((tb) => { const v = $("view-" + tb.id); if (v) v.hidden = tb.id !== id; });
  renderTabs();
  if (id === "driver") { if (!$("driverForm").innerHTML) renderDriverForm(null); renderDriverList(); }
  if (id === "report") renderReport();
  if (id === "settings") { renderSettings(); renderAutonomy(); }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ============================ DRIVER PROFILE ============================ */
const VEHICLES = [["car", "Кола", "Car"], ["van", "Бус", "Van"], ["motorcycle", "Мотор", "Motorcycle"], ["bicycle", "Велосипед", "Bicycle"], ["ev", "Електрическа", "Electric"], ["other", "Друго", "Other"]];
const FUELS = [["petrol", "Бензин", "Petrol"], ["diesel", "Дизел", "Diesel"], ["lpg", "Газ/LPG", "LPG"], ["electric", "Ток", "Electric"], ["hybrid", "Хибрид", "Hybrid"], ["custom", "Друго", "Custom"]];
const STYLES = [["balanced", "Балансиран", "Balanced"], ["fastest", "Най-бърз", "Fastest"], ["cheapest", "Най-евтин", "Cheapest"], ["windows", "Пази часовете", "Protect windows"]];
const optList = (arr, sel) => arr.map(([v, bg, en]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${L(bg, en)}</option>`).join("");

function renderDriverBar() {
  const ds = drivers(), act = activeDriver();
  if (!ds.length) { $("driverBar").innerHTML = `<div class="driver-empty"><span>${L("Няма профил на шофьор — цената няма да се смята точно.", "No driver profile — cost won't be exact.")}</span><button class="mini-btn" data-act="tab" data-tab="driver">${L("Създай профил", "Create profile")}</button></div>`; return; }
  $("driverBar").innerHTML = `<label class="field"><span>${L("Активен шофьор / кола", "Active driver / vehicle")}</span>
    <select id="driverSel" data-act="select-driver">${ds.map((d) => `<option value="${d.id}" ${act && act.id === d.id ? "selected" : ""}>${esc(d.name)} · ${esc(d.vehicleName || d.vehicleType)}</option>`).join("")}</select></label>`;
}
function renderDriverForm(d) {
  const hasSaved = drivers().length > 0;
  const wrap = $("driverFormWrap");
  const btn  = $("btnEditDriver");
  /* If we have a saved driver and no explicit edit target → hide form, show button */
  if (hasSaved && d === null) {
    if (wrap) wrap.hidden = true;
    if (btn)  btn.hidden  = false;
    return;
  }
  /* Otherwise show the form (new profile or editing existing) */
  if (wrap) wrap.hidden = false;
  if (btn)  btn.hidden  = true;
  d = d || {};
  const fp = priceFor(d.fuelType || "diesel"), cur = settings().currency;
  $("driverForm").innerHTML = `
    <p class="hint">${L("Въведи само модела на колата — агентът сам познава разхода и тегли текущата цена на горивото. Пипай нещо само ако знаеш по-точно.", "Enter just the car model — the agent figures out consumption and pulls the live fuel price. Override only if you know better.")}</p>
    <input type="hidden" id="df-id" value="${esc(d.id || "")}">
    <div class="grid2">
      <label class="field"><span>${L("Име на шофьора", "Driver name")}</span><input id="df-name" value="${esc(d.name || "")}"></label>
      <label class="field"><span>${L("Фирма (подпис на SMS)", "Company (SMS sign-off)")}</span><input id="df-company" value="${esc(d.company || settings().company)}"></label>
    </div>
    <div class="grid2">
      <label class="field"><span>${L("Модел на колата", "Vehicle model")}</span><input id="df-vehicleName" value="${esc(d.vehicleName || "")}" placeholder="Peugeot Partner 1.6 HDi"></label>
      <label class="field"><span>${L("Тип", "Type")}</span><select id="df-vehicleType">${optList(VEHICLES, d.vehicleType || "van")}</select></label>
    </div>
    <div class="actions" style="margin:2px 0 10px"><button class="btn btn--ghost btn--sm" data-act="derive-vehicle">🔎 ${L("Агентът да попълни разхода", "Let the agent fill consumption")}</button></div>
    <div class="grid3">
      <label class="field"><span>${L("Гориво", "Fuel")} <em class="est">${L("агент", "agent")}</em></span><select id="df-fuelType">${optList(FUELS, d.fuelType || "diesel")}</select></label>
      <label class="field"><span>${L("Град", "City")} L/100 <em class="est">${L("агент", "agent")}</em></span><input id="df-cityCons" type="number" step="0.1" value="${d.cityCons != null ? d.cityCons : ""}" placeholder="8.5"></label>
      <label class="field"><span>${L("Извън града", "Outside")} L/100 <em class="est">${L("агент", "agent")}</em></span><input id="df-highwayCons" type="number" step="0.1" value="${d.highwayCons != null ? d.highwayCons : ""}" placeholder="6.2"></label>
    </div>
    <div class="live-price">⛽ ${L("Текуща цена", "Current price")}: <b>${fp.price.toFixed(2)} ${cur}/${L("л", "L")}</b> <span class="src">${fp.live ? "● " : ""}${esc(fp.source)}${fp.date ? " · " + esc(fp.date) : ""} — ${L("агентът я тегли сам", "fetched by the agent")}</span></div>
    <div class="grid2" style="margin-top:12px">
      <label class="field"><span>${L("Време на спирка", "Handling")} (${L("мин", "min")})</span><input id="df-handling" type="number" value="${d.handling != null ? d.handling : 7}"></label>
      <label class="field"><span>${L("Стил на маршрута", "Route style")}</span><select id="df-routeStyle">${optList(STYLES, d.routeStyle || "balanced")}</select></label>
    </div>
    <label class="field"><span>${L("Телефон (по желание)", "Phone (optional)")}</span><input id="df-phone" value="${esc(d.phone || "")}"></label>
    <div class="actions"><button class="btn btn--primary" data-act="save-driver">${L("Запази профила", "Save profile")}</button>
      ${d.id ? `<button class="btn btn--ghost" data-act="new-driver">${L("Нов профил", "New profile")}</button>` : ""}</div>`;
}
function saveDriver() {
  const id = $("df-id").value || uid();
  const d = { id, name: $("df-name").value.trim() || L("Шофьор", "Driver"), company: $("df-company").value.trim(), vehicleName: $("df-vehicleName").value.trim(), vehicleType: $("df-vehicleType").value, fuelType: $("df-fuelType").value, cityCons: +$("df-cityCons").value || 8.5, highwayCons: +$("df-highwayCons").value || 6.2, handling: +$("df-handling").value || 7, routeStyle: $("df-routeStyle").value, phone: $("df-phone").value.trim() };
  const all = drivers(); const i = all.findIndex((x) => x.id === id);
  if (i >= 0) all[i] = d; else all.push(d);
  store.set(K.drivers, all); store.set(K.active, id);
  logEvent(L("профил", "profile"), `${d.name} · ${d.vehicleName || d.vehicleType}`);
  if (state.plan) renderCost(state.plan);
}
function delDriver(id) { if (!confirm(L("Изтрий профила?", "Delete profile?"))) return; store.set(K.drivers, drivers().filter((x) => x.id !== id)); if (store.get(K.active) === id) store.set(K.active, (drivers()[0] || {}).id || null); renderDriverList(); renderDriverBar(); renderTabs(); }
function renderDriverList() {
  const ds = drivers(), act = activeDriver();
  $("driverList").innerHTML = ds.length ? ds.map((d) => `<div class="row-card ${act && act.id === d.id ? "active" : ""}">
    <div class="rc-top"><div><div class="rc-name">${esc(d.name)}${act && act.id === d.id ? ` · ${L("активен", "active")}` : ""}</div>
      <div class="rc-sub">${esc(d.vehicleName || "")} · ${esc(d.cityCons)}/${esc(d.highwayCons)} L/100 · ${(FUELS.find((f) => f[0] === d.fuelType) || [, d.fuelType])[LANG === "bg" ? 1 : 2]} ${priceFor(d.fuelType).price.toFixed(2)} ${settings().currency}/L</div></div>
      <div class="rc-actions"><button class="mini-btn" data-act="edit-driver" data-id="${d.id}">${L("Промени", "Edit")}</button><button class="mini-btn btn--danger" data-act="del-driver" data-id="${d.id}">✕</button></div></div></div>`).join("") : `<div class="empty">${L("Още няма профили.", "No profiles yet.")}</div>`;
}
/* ============================ PHASE 1 — perceive (Groq) ============================ */
async function callGroq(messages, json) {
  const r = await fetch("/api/groq", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.1, messages, response_format: json ? { type: "json_object" } : undefined }) });
  if (!r.ok) throw new Error("Groq HTTP " + r.status + " " + (await r.text().catch(() => "")));
  const d = await r.json(); return d.choices?.[0]?.message?.content || "";
}
async function extractStops(raw) {
  const sys = "You are a logistics data-extraction engine. Extract every delivery stop and return ONLY a JSON object {\"stops\":[{\"name\":\"\",\"address\":\"\",\"city\":\"\",\"constraint\":\"\",\"phone\":\"\"}]}. Keep names and addresses in their original language. 'address'=street and number only. 'city'=town. 'constraint'=any time requirement exactly as written, else empty. 'phone'=digits as written, else empty. Never invent data.";
  const out = await callGroq([{ role: "system", content: sys }, { role: "user", content: raw }], true);
  let p; try { p = JSON.parse(out); } catch (e) { const m = out.match(/\{[\s\S]*\}/); p = m ? JSON.parse(m[0]) : { stops: [] }; }
  return (Array.isArray(p.stops) ? p.stops : []).map((s) => ({ id: uid(), name: (s.name || "").trim() || "—", rawAddress: (s.address || "").trim(), city: (s.city || "").trim(), constraintText: (s.constraint || "").trim(), phone: (s.phone || "").trim() })).filter((s) => s.rawAddress || s.city || s.name !== "—");
}

/* ============================ PHASE 2 — plan ============================ */
const BG_PREFIX = /^(ул\.?|улица|бул\.?|булевард|пл\.?|площад|ж\.?к\.?|жк|кв\.?|квартал|бл\.?|блок)\s*/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function geocodeOne(q) { try { const r = await fetch("/api/geocode?q=" + encodeURIComponent(q)); const d = await r.json(); if (Array.isArray(d) && d.length) return { lat: +d[0].lat, lon: +d[0].lon }; } catch (e) {} return null; }
async function geocodeStops(stops) {
  for (const s of stops) {
    const clean = (s.rawAddress || "").replace(BG_PREFIX, "").trim();
    let c = await geocodeOne([clean, s.city, "Bulgaria"].filter(Boolean).join(", ")); await sleep(1100);
    if (!c && s.city) { c = await geocodeOne([s.city, "Bulgaria"].join(", ")); await sleep(1100); if (c) { s.geocodeWarning = L("ползвам центъра на града", "using city center"); } }
    if (c) { s.lat = c.lat; s.lon = c.lon; logEvent(L("геокод", "geocode"), `${s.name}${s.geocodeWarning ? " · " + s.geocodeWarning : ""}`); }
    else { logEvent(L("геокод", "geocode"), `${s.name}: ${L("не е намерен", "not found")}`); }
  }
  return stops.filter((s) => s.lat != null && s.lon != null);
}
function nearestNeighbor(stops, anchor) { if (stops.length <= 2) return stops.slice(); const rem = stops.slice(), order = []; let cur = anchor || rem.shift(); if (!anchor) order.push(cur); while (rem.length) { let bi = 0, bd = Infinity; for (let i = 0; i < rem.length; i++) { const d = haversineKm(cur, rem[i]); if (d < bd) { bd = d; bi = i; } } cur = rem.splice(bi, 1)[0]; order.push(cur); } return order; }
async function osrmRoute(ordered) {
  const out = { legMin: [], totalKm: 0, estimated: false };
  if (ordered.length < 2) return out;
  try { const r = await fetch("/api/route?coords=" + encodeURIComponent(ordered.map((s) => `${s.lon},${s.lat}`).join(";"))); const d = await r.json(); const legs = d?.routes?.[0]?.legs; if (Array.isArray(legs)) { let km = 0; legs.forEach((l) => { out.legMin.push((l.duration || 0) / 60); km += (l.distance || 0) / 1000; }); out.totalKm = km; return out; } } catch (e) {}
  let km = 0; for (let i = 1; i < ordered.length; i++) { const d = haversineKm(ordered[i - 1], ordered[i]); out.legMin.push((d / CITY_SPEED_KMH) * 60); km += d; } out.totalKm = km; out.estimated = true; return out;
}
/* set handling time from driver profile before ETA */
function applyDriverHandling(stops) {
  const drv = activeDriver();
  for (const s of stops) { s.handlingTime = (drv && drv.handling) || settings().handling; s.learnNotes = []; }
}

function computeETAs(ordered, legMin, startMin) { let clock = startMin; ordered.forEach((s, i) => { if (i > 0) clock += (ordered[i - 1].handlingTime || HANDLING_FALLBACK) + (legMin[i - 1] || 0); s.etaMinutes = clock; s.plannedEta = clock; s.arrival = minToHHMM(clock); }); }
function assess(stops) { for (const s of stops) { s.constraint = parseConstraint(s.constraintText); s.label = evaluateLabel(s.etaMinutes, s.constraint); } }

/* cost + savings + profit */
function effConsumption(drv, rt) { const c = +drv.cityCons || 9, h = +drv.highwayCons || 7; if (rt === "city") return c; if (rt === "outside") return h; return c * 0.7 + h * 0.3; }
function computeCost(plan) {
  const drv = activeDriver(), st = settings();
  plan.hasDriver = !!drv;
  const eff = drv ? effConsumption(drv, state.routeType) : 8;
  const fp = priceFor(drv ? drv.fuelType : "diesel"); const price = fp.price; plan.fuelMeta = fp;
  plan.eff = eff; plan.fuelUsed = plan.distanceKm * eff / 100; plan.fuelCost = plan.fuelUsed * price;
  plan.costPerStop = plan.stops.length ? plan.fuelCost / plan.stops.length : 0;
  plan.savedKm = Math.max(0, plan.originalKm - plan.distanceKm);
  plan.fuelSaved = plan.savedKm * eff / 100; plan.moneySaved = plan.fuelSaved * price; plan.monthlySaved = plan.moneySaved * st.workingDays;
  plan.revenue = st.deliveryFee * plan.stops.length; plan.margin = plan.revenue - plan.fuelCost; plan.profitPerStop = plan.stops.length ? plan.margin / plan.stops.length : 0;
  return plan;
}
function confidence(plan) {
  let s = 100;
  s -= plan.stops.filter((x) => x.label === "late").length * 18;
  s -= plan.stops.filter((x) => x.label === "at_risk").length * 8;
  s -= plan.stops.filter((x) => x.geocodeWarning).length * 7;
  s -= plan.tightWindows * 5;
  s -= Math.max(0, plan.distanceKm - 40) * 0.3;
  return Math.max(5, Math.min(100, Math.round(s)));
}
function profitScore(plan) { if (!plan.revenue) return null; const ratio = plan.fuelCost / plan.revenue; let s = 100 - ratio * 120 - Math.max(0, plan.distanceKm / Math.max(1, plan.stops.length) - 3) * 5; return Math.max(5, Math.min(100, Math.round(s))); }

/* ============================ ORCHESTRATOR ============================ */
function renderProgress(steps, done) { $("progress").hidden = false; $("progress").innerHTML = steps.map((s, i) => `<div class="row ${done === -1 ? "" : i < done ? "done" : i === done ? "active" : ""}"><span class="dot"></span>${s}</div>`).join(""); }
async function planRoute() {
  $("errorBox").hidden = true; state.log = []; state.routeStarted = false; state.plan = null;
  $("replanPanel").hidden = true; $("btnFinish").hidden = true;
  const raw = $("rawList").value.trim();
  if (!raw) { showError(L("Постави поне една спирка.", "Paste at least one stop.")); return; }
  $("btnPlan").disabled = true; setStatus("working");
  const steps = [L("Извличане (Groq)", "Extract (Groq)"), L("Геокодиране", "Geocode"), L("Маршрут + ETA", "Route + ETA"), L("Оценка + цена", "Assess + cost")];
  renderProgress(steps, 0);
  const startMin = nowMin();
  try {
    await loadFuel();
    let stops = await extractStops(raw);
    logEvent(L("извличане", "extract"), `${stops.length} ${L("спирки", "stops")}`);
    if (!stops.length) throw new Error(L("Не разпознах спирки в текста.", "No stops recognized."));
    renderProgress(steps, 1);
    stops = await geocodeStops(stops);
    if (!stops.length) throw new Error(L("Нито един адрес не е намерен.", "No address located."));
    renderProgress(steps, 2);
    const original = stops.slice();
    applyDriverHandling(stops);
    const optimized = nearestNeighbor(stops);
    const reordered = optimized.some((s, i) => s !== original[i]);
    const route = await osrmRoute(optimized);
    computeETAs(optimized, route.legMin, startMin);
    assess(optimized);
    renderProgress(steps, 3);
    const tightWindows = optimized.filter((s) => (s.constraint.kind === "deadline" || s.constraint.kind === "window") && s.constraint.close - s.etaMinutes <= TIGHT_WINDOW_MIN && s.label !== "late").length;
    const plan = { stops: optimized, reordered, distanceKm: route.totalKm, originalKm: totalHaversine(original), estimated: route.estimated, tightWindows, startMin };
    computeCost(plan); plan.confidence = confidence(plan); plan.profit = profitScore(plan);
    plan.risks = optimized.filter((s) => ["late", "at_risk", "early"].includes(s.label)).map((s) => ({ name: s.name, label: s.label, rec: s.label === "late" ? L("Премести по-рано или се обади — изпускаш часа.", "Move earlier or call — you miss the deadline.") : s.label === "early" ? L("Подранил си за прозореца — изчакай/пренареди.", "Early for the window — wait/reorder.") : L("Тесен буфер — тръгни навреме.", "Tight buffer — leave on time.") }));
    state.stops = optimized; state.plan = plan;
    logEvent(L("план", "plan"), `${optimized.length} ${L("спирки", "stops")}, ${plan.distanceKm.toFixed(1)}km, ${L("край", "end")} ~${optimized[optimized.length - 1].arrival}`);
    renderExec(plan); renderCost(plan); renderRisks(plan.risks); renderRail();
    setStatus("done"); $("progress").hidden = true;
  } catch (err) {
    console.error(err); renderProgress(steps, -1);
    showError((err.message || String(err)) + " — " + L("провери GROQ_API_KEY в Netlify.", "check GROQ_API_KEY in Netlify."));
  } finally { $("btnPlan").disabled = false; }
}
function showError(m) { $("errorBox").textContent = m; $("errorBox").hidden = false; setStatus("error"); }

/* ============================ RENDER: exec / cost / risk ============================ */
function renderExec(plan) {
  $("execPanel").hidden = false; const st = settings(); const end = plan.stops[plan.stops.length - 1]?.arrival || "—";
  const risky = plan.stops.filter((s) => s.label === "late" || s.label === "at_risk").length;
  const reco = risky ? L(`Тръгни сега — ${risky} ${risky === 1 ? "доставка е" : "доставки са"} на ръба, всяко забавяне ги изпуска.`, `Start now — ${risky} ${risky === 1 ? "delivery is" : "deliveries are"} on the edge; any delay loses them.`) : L("Спокоен ден — тръгни в удобен момент.", "Easy day — start when convenient.");
  $("execBody").innerHTML = `<div class="kpis">
    <div class="kpi"><b>${plan.stops.length}</b><span>${L("спирки", "stops")}</span></div>
    <div class="kpi"><b>${plan.distanceKm.toFixed(1)}</b><span>${L("км", "km")}</span></div>
    <div class="kpi accent"><b>${plan.hasDriver ? plan.fuelCost.toFixed(2) : "—"}</b><span>${L("разход", "cost")} ${st.currency}</span></div>
    <div class="kpi"><b>${plan.hasDriver ? plan.costPerStop.toFixed(2) : "—"}</b><span>${L("на спирка", "per stop")}</span></div>
    <div class="kpi ${plan.confidence >= 75 ? "good" : plan.confidence >= 50 ? "warn" : "bad"}"><b>${plan.confidence}%</b><span>${L("увереност", "confidence")}</span></div>
    <div class="kpi ${risky ? "warn" : "good"}"><b>${risky}</b><span>${L("рискови", "risky")}</span></div>
    <div class="kpi"><b>${end}</b><span>${L("край", "end")}</span></div>
    <div class="kpi accent"><b>${plan.hasDriver ? plan.moneySaved.toFixed(2) : "—"}</b><span>${L("спестено", "saved")} ${st.currency}</span></div></div>
    <div class="reco"><b>${L("Препоръка", "Recommended")}:</b> ${reco}</div>`;
}
function renderCost(plan) {
  plan = plan || state.plan; if (!plan) return;
  $("costPanel").hidden = false; const st = settings();
  if (!plan.hasDriver) { $("costBody").innerHTML = `<div class="driver-empty"><span>${L("Създай профил на шофьора, за да смятам реален разход и печалба.", "Create a driver profile to compute real cost and profit.")}</span><button class="mini-btn" data-act="tab" data-tab="driver">${L("Профил", "Profile")}</button></div>`; return; }
  computeCost(plan); plan.profit = profitScore(plan);
  $("costBody").innerHTML = `<div class="kpis">
    <div class="kpi"><b>${plan.fuelUsed.toFixed(2)}</b><span>${L("гориво L", "fuel L")}</span></div>
    <div class="kpi accent"><b>${plan.fuelCost.toFixed(2)}</b><span>${L("разход", "cost")} ${st.currency}</span></div>
    <div class="kpi"><b>${plan.costPerStop.toFixed(2)}</b><span>${L("цена/доставка", "cost/stop")}</span></div>
    <div class="kpi good"><b>${plan.savedKm.toFixed(1)}</b><span>${L("спестени км", "km saved")}</span></div>
    <div class="kpi good"><b>${plan.moneySaved.toFixed(2)}</b><span>${L("спестени", "saved")} ${st.currency}</span></div>
    <div class="kpi accent"><b>${plan.monthlySaved.toFixed(0)}</b><span>${L("месечно при", "monthly @")} ${st.workingDays}${L("дни", "d")}</span></div>
    <div class="kpi"><b>${plan.revenue.toFixed(0)}</b><span>${L("приход", "revenue")} ${st.currency}</span></div>
    <div class="kpi ${plan.margin > 0 ? "good" : "bad"}"><b>${plan.margin.toFixed(2)}</b><span>${L("марж", "margin")}</span></div>
    <div class="kpi ${plan.margin > 0 ? "good" : "bad"}"><b>${plan.profitPerStop.toFixed(2)}</b><span>${L("печалба/дост.", "profit/stop")}</span></div>
    ${plan.profit != null ? `<div class="kpi ${plan.profit >= 70 ? "good" : plan.profit >= 45 ? "warn" : "bad"}"><b>${plan.profit}%</b><span>${L("рентабилност", "profitability")}</span></div>` : ""}</div>
    <div class="disclaimer">${L("Оценките за гориво и печалба са приблизителни, на база профила на колата.", "Fuel and profit estimates are approximate, based on the saved vehicle profile.")}${plan.fuelMeta ? " · " + L("гориво", "fuel") + " " + plan.fuelMeta.price.toFixed(2) + " " + st.currency + "/" + L("л", "L") + " (" + (plan.fuelMeta.live ? "● " : "") + esc(plan.fuelMeta.source) + (plan.fuelMeta.date ? " · " + esc(plan.fuelMeta.date) : "") + ")" : ""}${plan.estimated ? " · " + L("(маршрутът е оценен без OSRM)", "(route estimated without OSRM)") : ""}</div>`;
}
function renderRisks(risks) {
  $("riskPanel").hidden = false;
  $("riskBody").innerHTML = risks.length ? risks.map((r) => `<div class="risk-card ${r.label}"><div><div class="risk-name">${esc(r.name)} · <span class="badge ${r.label}">${r.label}</span></div><div class="risk-rec">${esc(r.rec)}</div></div></div>`).join("") : `<div class="risk-none">✓ ${L("Няма рискови спирки — всичко е в срок.", "No risky stops — all on time.")}</div>`;
}

/* ============================ RENDER: rail + monitor/act ============================ */
function startRoute() { if (!state.stops.length) { showError(L("Първо планирай маршрут.", "Plan a route first.")); return; } state.routeStarted = true; renderRail(); logEvent(L("маршрут", "route"), L("стартиран", "started")); }
function renderRail() {
  if (!state.stops.length) return;
  $("routePanel").hidden = false; $("btnStart").style.display = state.routeStarted ? "none" : ""; $("btnFinish").hidden = !state.routeStarted;
  $("rail").innerHTML = state.stops.map((s, i) => {
    const warn = s.geocodeWarning ? `<span class="chip warn">⚠ ${esc(s.geocodeWarning)}</span>` : "";
    const learn = (s.learnNotes || []).map((n) => `<span class="chip learn">◉ ${n}</span>`).join("");
    const cons = s.constraintText ? `<span class="chip">⧗ ${esc(s.constraintText)}</span>` : "";
    const phone = s.phone ? `<span class="chip">☎ ${esc(s.phone)}</span>` : "";
    const ctrls = state.routeStarted && !s.done ? `<div class="stop-controls">
        <button class="mini-btn done-btn" data-act="stop-done" data-id="${s.id}">✓ ${L("Доставено", "Done")}</button>
        <button class="mini-btn" data-act="stop-detail" data-id="${s.id}">${L("Детайли", "Details")}</button>
        <input class="delay-input" type="number" min="1" value="15" aria-label="${L("мин", "min")}" id="din-${s.id}">
        <button class="mini-btn delay-btn" data-act="stop-delay" data-id="${s.id}">+ ${L("Закъснение", "Delay")}</button>
        <span class="delay-quick">
          <button class="mini-btn qd" data-act="stop-qd" data-id="${s.id}" data-min="10">+10</button>
          <button class="mini-btn qd" data-act="stop-qd" data-id="${s.id}" data-min="15">+15</button>
          <button class="mini-btn qd" data-act="stop-qd" data-id="${s.id}" data-min="30">+30</button>
        </span></div><div id="detail-${s.id}"></div>` : "";
    return `<li class="stop ${s.label}${s.done ? " is-done" : ""}"><span class="node"></span>
      <div class="stop-card"><div class="stop-top"><span class="stop-name">${i + 1}. ${esc(s.name)}</span><span class="stop-eta">${s.arrival || "—"}</span></div>
      <div class="stop-addr">${esc([s.rawAddress, s.city].filter(Boolean).join(", "))}</div>
      <div class="stop-meta"><span class="badge ${s.label}">${s.label}</span>${cons}${phone}${warn}${learn}</div>${ctrls}</div></li>`;
  }).join("");
}
function delayFromInput(id) { const inp = $("din-" + id); let v = parseInt(inp && inp.value, 10); if (!(v > 0)) { v = 15; if (inp) { inp.value = "15"; inp.classList.add("flash"); setTimeout(() => inp.classList.remove("flash"), 700); } } reportDelay(id, v); }
function toggleDetail(id) {
  const box = $("detail-" + id); if (!box) return; if (box.innerHTML) { box.innerHTML = ""; return; }
  const s = state.stops.find((x) => x.id === id);
  box.innerHTML = `<div class="detail-form"><div class="grid2">
    <label class="field"><span>${L("Реално време (мин)", "Actual handling (min)")}</span><input id="ah-${id}" type="number" value="${s.handlingTime}"></label>
    <label class="field"><span>${L("Паркиране", "Parking")}</span><select id="pk-${id}">${optList(PARK, "low")}</select></label></div>
    <div class="grid2"><label class="field"><span>${L("Клиентът наличен?", "Customer available?")}</span><select id="av-${id}"><option value="yes">${L("Да", "Yes")}</option><option value="no">${L("Не", "No")}</option></select></label>
    <label class="field"><span>${L("Причина за забавяне", "Delay reason")}</span><select id="dr-${id}"><option value="none">${L("няма", "none")}</option><option value="traffic">${L("трафик", "traffic")}</option><option value="customer">${L("клиент липсва", "customer away")}</option><option value="parking">${L("паркиране", "parking")}</option><option value="address">${L("грешен адрес", "wrong address")}</option><option value="other">${L("друго", "other")}</option></select></label></div>
    <label class="field"><span>${L("Бележка", "Notes")}</span><input id="nt-${id}"></label>
    <button class="btn btn--primary" data-act="save-detail" data-id="${id}">${L("Запази + Доставено", "Save + Done")}</button></div>`;
}
function saveDetail(id) { const s = state.stops.find((x) => x.id === id); if (!s) return; completeStop(id, { actualHandling: +$("ah-" + id).value || s.handlingTime, parking: $("pk-" + id).value, available: $("av-" + id).value, delayReason: $("dr-" + id).value, notes: $("nt-" + id).value.trim() }); }
function completeStop(id, details) {
  const s = state.stops.find((x) => x.id === id); if (!s || s.done) return;
  s.done = true; s.completedAt = nowMin(); s.completion = details || { actualHandling: s.handlingTime, parking: "low", available: "yes", delayReason: "none", notes: "" }; s.finalLabel = s.label;
  logEvent(L("доставка", "delivery"), `${s.name}: ${L("доставено", "done")}`); renderRail();
}
function etaAlong(anchor, order, startMin) { let clock = startMin, late = 0; const arr = []; let prev = anchor; order.forEach((s) => { clock += (prev.handlingTime || HANDLING_FALLBACK) + (haversineKm(prev, s) / CITY_SPEED_KMH) * 60; const lbl = evaluateLabel(clock, s.constraint); if (lbl === "late") late++; arr.push({ eta: clock }); prev = s; }); return { arr, late }; }
function reportDelay(id, minutes) {
  const idx = state.stops.findIndex((x) => x.id === id); if (idx < 0 || !minutes) return;
  logEvent(L("закъснение", "delay"), `${state.stops[idx].name}: +${minutes} ${L("мин", "min")}`);
  const anchor = state.stops[idx];
  for (let i = idx + 1; i < state.stops.length; i++) { const s = state.stops[i]; if (s.done) continue; const prev = s.label; s.etaMinutes += minutes; s.arrival = minToHHMM(s.etaMinutes); s.label = evaluateLabel(s.etaMinutes, s.constraint); s.flippedLate = (prev === "on_time" || prev === "early") && s.label === "late"; }
  const remaining = state.stops.slice(idx + 1).filter((s) => !s.done && s.lat != null);
  const startMin = anchor.etaMinutes + (anchor.handlingTime || HANDLING_FALLBACK) + minutes;
  const A = remaining.slice(), B = nearestNeighbor(remaining, anchor);
  const C = remaining.slice().sort((a, b) => { const da = (a.constraint.kind === "deadline" || a.constraint.kind === "window") ? a.constraint.close : 1e9; const db = (b.constraint.kind === "deadline" || b.constraint.kind === "window") ? b.constraint.close : 1e9; return da - db; });
  const opts = [{ key: "A", name: L("Запази реда", "Keep order"), order: A }, { key: "B", name: L("Най-късо", "Shortest"), order: B }, { key: "C", name: L("Пази часовете", "Protect windows"), order: C }]
    .map((o) => { const dist = totalHaversine([anchor, ...o.order]); const ev = etaAlong(anchor, o.order, startMin); return Object.assign(o, { dist, late: ev.late, conf: Math.max(0, 100 - ev.late * 22 - dist * 0.6) | 0 }); });
  opts.sort((a, b) => (a.late - b.late) || (a.dist - b.dist));
  const sel = opts[0];
  logEvent(L("преплан", "replan"), `${sel.name} — ${L("късни", "late")}:${sel.late}`);
  if (sel.key !== "A") { const head = state.stops.slice(0, idx + 1); const doneTail = state.stops.slice(idx + 1).filter((s) => s.done); state.stops = [...head, ...doneTail, ...sel.order]; const ev = etaAlong(anchor, sel.order, startMin); sel.order.forEach((s, i) => { s.etaMinutes = ev.arr[i].eta; s.arrival = minToHHMM(s.etaMinutes); s.label = evaluateLabel(s.etaMinutes, s.constraint); }); }
  const company = (activeDriver() && activeDriver().company) || settings().company;
  const affected = state.stops.slice(idx + 1).filter((s) => !s.done);
  const notifs = affected.map((s) => { let body = L(`Здравейте, ${s.name}! Доставката ви ще пристигне около ${s.arrival} вместо предвиденото. Извиняваме се за забавянето.\n— ${company}`, `Hello, ${s.name}! Your delivery will now arrive around ${s.arrival} instead of planned. Apologies for the delay.\n— ${company}`); if (s.flippedLate) body += "\n" + L("Съжаляваме, че няма да успеем в обявения час.", "Sorry we will miss the stated window."); logEvent(L("известие", "notify"), s.name); return { stop: s, body }; });
  state.notified += notifs.length;
  renderReplan(opts, sel, notifs); renderRail(); $("replanPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderReplan(opts, sel, notifs) {
  $("replanPanel").hidden = false;
  const rows = opts.map((o) => `<div class="opt-row ${o.key === sel.key ? "sel" : ""}"><span>${o.key === sel.key ? "▶ " : ""}${esc(o.name)}</span><span>${o.dist.toFixed(1)}km · ${L("късни", "late")} ${o.late} · ${o.conf}%</span></div>`).join("");
  const seq = sel.key !== "A" ? `<div class="seq">${L("Нов ред", "New order")}: ${sel.order.map((s) => esc(s.name)).join(" → ")}</div>` : "";
  const reason = sel.late === 0 ? L("Избягва закъснения при най-късо разстояние.", "Avoids late deliveries at shortest distance.") : L(`Минимум закъснения (${sel.late}).`, `Minimum late deliveries (${sel.late}).`);
  const dec = `<div class="decision ${sel.key === "A" ? "keep" : "reorder"}"><span class="tag">${sel.key === "A" ? L("ЗАПАЗИ", "KEEP") : L("ПРЕНАРЕДИ", "REORDER")}</span><span class="reason">${reason} · ${L("увереност", "confidence")} ${sel.conf}%</span>${seq}<div style="margin-top:8px">${rows}</div></div>`;
  const cards = notifs.length ? notifs.map((n) => { const wa = normalizePhone(n.stop.phone) ? `https://wa.me/${normalizePhone(n.stop.phone)}?text=${encodeURIComponent(n.body)}` : ""; const sms = n.stop.phone ? `sms:${n.stop.phone.replace(/[^\d+]/g, "")}?body=${encodeURIComponent(n.body)}` : ""; return `<div class="notif-card"><div class="notif-to">${esc(n.stop.name)} · ${n.stop.arrival}</div><div class="notif-msg">${esc(n.body)}</div><div class="notif-actions"><a class="wa ${wa ? "" : "disabled"}" href="${wa || "#"}" target="_blank" rel="noopener">WhatsApp${wa ? "" : " · " + L("няма тел.", "no phone")}</a><a class="sms ${sms ? "" : "disabled"}" href="${sms || "#"}">SMS</a></div></div>`; }).join("") : `<div class="empty">${L("Няма следващи спирки за уведомяване.", "No downstream stops to notify.")}</div>`;
  $("replanBody").innerHTML = dec + cards;
}

/* ============================ DAILY REPORT ============================ */
function finishRoute() {
  if (!state.stops.length) return;
  const drv = activeDriver(), st = settings(), plan = state.plan || {};
  const done = state.stops.filter((s) => s.done), late = state.stops.filter((s) => s.finalLabel === "late" || s.label === "late");
  const onTime = done.filter((s) => s.finalLabel !== "late").length;
  const lessons = [];
  const rec = {
    id: uid(), driverId: drv ? drv.id : null, date: new Date().toISOString().slice(0, 10),
    stops: state.stops.length, completedStops: done.length, lateStops: late.length, onTimeStops: onTime,
    distanceKm: plan.distanceKm || 0, originalKm: plan.originalKm || 0, fuelUsed: plan.fuelUsed || 0, fuelCost: plan.fuelCost || 0,
    costPerDelivery: plan.costPerStop || 0, moneySaved: plan.moneySaved || 0, notified: state.notified, lessons,
  };
  const all = routes(); all.unshift(rec); store.set(K.routes, all);
  logEvent(L("отчет", "report"), `${rec.completedStops}/${rec.stops} ${L("доставени", "delivered")}`);
  state.lastReport = rec; switchTab("report");
}
function renderReport() {
  const r = state.lastReport || routes()[0];
  if (!r) { $("reportBody").innerHTML = `<div class="empty">${L("Завърши маршрут, за да се появи отчет.", "Finish a route to get a report.")}</div>`; return; }
  const drv = drivers().find((d) => d.id === r.driverId), st = settings();
  $("reportBody").innerHTML = `<div class="kpis">
    <div class="kpi"><b>${r.completedStops}/${r.stops}</b><span>${L("доставени", "delivered")}</span></div>
    <div class="kpi good"><b>${r.onTimeStops}</b><span>${L("навреме", "on-time")}</span></div>
    <div class="kpi ${r.lateStops ? "bad" : "good"}"><b>${r.lateStops}</b><span>${L("закъснели", "late")}</span></div>
    <div class="kpi"><b>${r.distanceKm.toFixed(1)}</b><span>${L("км", "km")}</span></div>
    <div class="kpi accent"><b>${r.fuelCost.toFixed(2)}</b><span>${L("разход", "cost")} ${st.currency}</span></div>
    <div class="kpi"><b>${r.costPerDelivery.toFixed(2)}</b><span>${L("цена/доставка", "cost/stop")}</span></div>
    <div class="kpi accent"><b>${r.moneySaved.toFixed(2)}</b><span>${L("спестено", "saved")} ${st.currency}</span></div>
    <div class="kpi"><b>${r.notified}</b><span>${L("уведомени", "notified")}</span></div></div>
    <div class="report-block"><h3>${L("Шофьор", "Driver")}</h3>${esc(drv ? drv.name + " · " + (drv.vehicleName || "") : "—")} · ${esc(r.date)}
    <h3>${L("Научени уроци", "Lessons learned")}</h3>${r.lessons.length ? `<ul class="lessons">${r.lessons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="empty">${L("Няма нови уроци днес.", "No new lessons today.")}</div>`}</div>
    <div class="actions" style="margin-top:14px"><button class="btn btn--ghost" data-act="copy-report">${L("Копирай отчета", "Copy report")}</button></div>`;
}
function copyReport() {
  const r = state.lastReport || routes()[0]; if (!r) return; const st = settings(); const drv = drivers().find((d) => d.id === r.driverId);
  const txt = `SmartDispatch — ${L("дневен отчет", "daily report")} ${r.date}
${L("Шофьор", "Driver")}: ${drv ? drv.name : "—"}
${L("Доставени", "Delivered")}: ${r.completedStops}/${r.stops} · ${L("навреме", "on-time")}: ${r.onTimeStops} · ${L("късни", "late")}: ${r.lateStops}
${L("Разстояние", "Distance")}: ${r.distanceKm.toFixed(1)} km · ${L("гориво", "fuel")}: ${r.fuelUsed.toFixed(2)} L · ${L("разход", "cost")}: ${r.fuelCost.toFixed(2)} ${st.currency}
${L("Цена/доставка", "Cost/delivery")}: ${r.costPerDelivery.toFixed(2)} · ${L("спестено", "saved")}: ${r.moneySaved.toFixed(2)} ${st.currency}
${r.lessons.length ? L("Уроци", "Lessons") + ":\n- " + r.lessons.join("\n- ") : ""}`;
  navigator.clipboard?.writeText(txt).then(() => logEvent(L("отчет", "report"), L("копиран", "copied"))).catch(() => {});
}

/* ============================ SETTINGS + AUTONOMY ============================ */
function renderSettings() {
  const s = settings();
  $("settingsForm").innerHTML = `<div class="grid3">
    <label class="field"><span>${L("Валута", "Currency")}</span><select id="sf-currency"><option ${s.currency === "BGN" ? "selected" : ""}>BGN</option><option ${s.currency === "EUR" ? "selected" : ""}>EUR</option></select></label>
    <label class="field"><span>${L("Цена гориво", "Fuel price")}</span><input id="sf-fuelPrice" type="number" step="0.01" value="${s.fuelPrice}"></label>
    <label class="field"><span>${L("Работни дни/мес", "Working days/mo")}</span><input id="sf-workingDays" type="number" value="${s.workingDays}"></label></div>
    <div class="grid3">
    <label class="field"><span>${L("Време/спирка", "Handling/stop")}</span><input id="sf-handling" type="number" value="${s.handling}"></label>
    <label class="field"><span>${L("Такса доставка", "Delivery fee")}</span><input id="sf-deliveryFee" type="number" step="0.1" value="${s.deliveryFee}"></label>
    <label class="field"><span>${L("Тип маршрут", "Route type")}</span><select id="sf-routeType"><option value="city" ${s.routeType === "city" ? "selected" : ""}>${L("Градски", "City")}</option><option value="mixed" ${s.routeType === "mixed" ? "selected" : ""}>${L("Смесен", "Mixed")}</option><option value="outside" ${s.routeType === "outside" ? "selected" : ""}>${L("Извънградски", "Outside")}</option></select></label></div>
    <label class="field"><span>${L("Подпис на фирмата (за SMS)", "Company sign-off (SMS)")}</span><input id="sf-company" value="${esc(s.company)}"></label>
    <div class="actions"><button class="btn btn--primary" data-act="save-settings">${L("Запази настройките", "Save settings")}</button></div>`;
}
function saveSettings() {
  const s = { currency: $("sf-currency").value, fuelPrice: +$("sf-fuelPrice").value || DEF_SETTINGS.fuelPrice, workingDays: +$("sf-workingDays").value || 22, handling: +$("sf-handling").value || 7, deliveryFee: +$("sf-deliveryFee").value || 0, routeType: $("sf-routeType").value, company: $("sf-company").value.trim() || DEF_SETTINGS.company, optimize: settings().optimize };
  store.set(K.settings, s); state.routeType = s.routeType; logEvent(L("настройки", "settings"), L("запазени", "saved"));
  renderRouteType(); if (state.plan) { renderExec(state.plan); renderCost(state.plan); }
}
function renderAutonomy() {
  const items = [["Чете разхвърлян текст и го превръща в чисти данни", "Reads messy text into clean data"], ["Геокодира адресите и оптимизира реда", "Geocodes addresses and optimizes order"], ["Смята ETA, разход, спестявания и печалба от профила на колата", "Computes ETA, cost, savings & profit from the vehicle profile"], ["Ползва профила на всеки клиент и наученото от минали доставки", "Uses each client's profile and what it learned from past stops"], ["Открива рискове и дава увереност преди тръгване", "Detects risks and a confidence score before departure"], ["При закъснение сравнява 3 стратегии и избира най-добрата", "On delay, compares 3 strategies and picks the best"], ["Пише готови известия до засегнатите клиенти", "Drafts ready notifications to affected clients"], ["Учи се след всяка доставка и подобрява следващите", "Learns after each delivery and improves the next"]];
  $("autonomyBody").innerHTML = items.map(([bg, en]) => `<div class="auto-line"><b>›</b> ${L(bg, en)}</div>`).join("");
}

/* ============================ route-type bar + lang ============================ */
const RT = [["city", "Градски", "City"], ["mixed", "Смесен", "Mixed"], ["outside", "Извънградски", "Outside"]];
function renderRouteType() { $("routeTypeBar").innerHTML = RT.map(([v, bg, en]) => `<button data-act="rt" data-rt="${v}" class="${state.routeType === v ? "on" : ""}">${L(bg, en)}</button>`).join(""); }
function setRouteType(v) { state.routeType = v; renderRouteType(); if (state.plan) { computeCost(state.plan); renderExec(state.plan); renderCost(state.plan); } }
function toggleLang() { LANG = LANG === "bg" ? "en" : "bg"; store.set(K.lang, LANG); applyLang(); }
function renderLog() { $("logCount").textContent = state.log.length; $("logBody").innerHTML = state.log.map((e) => `<div class="log-line"><span class="lt">${e.t}</span><span class="lc">${esc(e.cat)}</span><span class="lm">${esc(e.msg)}</span></div>`).join(""); }

function applyStaticLabels() {
  $("brandSub").textContent = L("by StaGove · автономен диспечер", "by StaGove · autonomous dispatcher");
  $("langToggle").textContent = LANG === "bg" ? "EN" : "BG";
  const set = (id, bg, en) => { const e = $(id); if (e) e.textContent = L(bg, en); };
  set("t-input", "Нов маршрут", "New route"); set("t-list", "Постави списъка със спирки — какъвто формат е (WhatsApp, гласово, ръкописно)", "Paste the stop list — any format");
  set("t-exec", "Днешен диспечерски обзор", "Today's dispatch summary"); set("t-cost", "Разход, спестявания и печалба", "Cost, savings & profit");
  set("t-risk", "Рискове преди тръгване", "Risks before departure"); set("t-route", "Спирки по ред", "Stops in order"); set("t-replan", "Преизчисление", "Re-plan");
  $("btnSample").textContent = L("Зареди пример", "Load sample"); $("btnPlan").textContent = L("Планирай маршрута", "Plan route"); $("btnStart").textContent = L("Започни", "Start"); $("btnFinish").textContent = L("Завърши деня и направи отчет", "Finish day & make report");
  $("rawList").placeholder = L("Иван Петров, ул. Граф Игнатиев 15, София, до 10:30, 0888123456", "John Smith, 15 Baker St, Sofia, before 10:30, 0888123456");
}
function applyLang() {
  document.documentElement.lang = LANG; applyStaticLabels(); renderTabs(); renderDriverBar(); renderRouteType(); setStatus($("statusPill").dataset.state || "idle");
  if (state.plan) { renderExec(state.plan); renderCost(state.plan); renderRisks(state.plan.risks); renderRail(); }
  renderLog();
  // refresh whichever secondary tab is open
  if (state.activeTab === "report") renderReport();
  if (state.activeTab === "settings") { renderSettings(); renderAutonomy(); }
}

/* ============================ INIT — single delegated dispatcher ============================ */
function dispatch(act, el) {
  const id = el.dataset.id;
  switch (act) {
    case "lang": toggleLang(); break;
    case "tab": switchTab(el.dataset.tab); break;
    case "sample": $("rawList").value = SAMPLE; break;
    case "plan": planRoute(); break;
    case "start": startRoute(); break;
    case "finish": finishRoute(); break;
    case "rt": setRouteType(el.dataset.rt); break;
    case "new-driver": renderDriverForm({}); window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "toggle-driver-form": { const wrap = $("driverFormWrap"); const showing = wrap && !wrap.hidden; if (showing) { renderDriverForm(null); } else { renderDriverForm({}); window.scrollTo({ top: 0, behavior: "smooth" }); } break; }
    case "save-driver": saveDriver(); break;
    case "derive-vehicle": deriveVehicleNow(); break;
    case "edit-driver": renderDriverForm(drivers().find((d) => d.id === id)); window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "del-driver": delDriver(id); break;
    case "stop-done": completeStop(id, null); break;
    case "stop-detail": toggleDetail(id); break;
    case "save-detail": saveDetail(id); break;
    case "stop-delay": delayFromInput(id); break;
    case "stop-qd": reportDelay(id, +el.dataset.min); break;
    case "save-settings": saveSettings(); break;
    case "copy-report": copyReport(); break;
  }
}
function init() {
  setStatus("idle"); applyStaticLabels(); renderTabs(); renderDriverBar(); renderRouteType(); renderLog();
  loadFuel().then(() => { if (state.activeTab === "driver") renderDriverForm(null); if (state.plan) renderCost(state.plan); });
  document.addEventListener("click", (e) => { const el = e.target.closest("[data-act]"); if (el) dispatch(el.dataset.act, el); });
  document.addEventListener("change", (e) => { const el = e.target.closest("[data-act]"); if (el && el.dataset.act === "select-driver") { store.set(K.active, el.value); renderDriverBar(); renderDriverList(); if (state.plan) renderCost(state.plan); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id && e.target.id.startsWith("din-")) { const v = parseInt(e.target.value, 10); if (v > 0) reportDelay(e.target.id.slice(4), v); } });
}
document.addEventListener("DOMContentLoaded", init);
