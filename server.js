/* TCG Refurb Shop server — zero dependencies.
   Static files + authenticated JSON API. State lives in one file on disk.
   On Railway, mount a volume and set DATA_DIR to its mount path (for example /data). */
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { applyScannerOrdersBatch } from "./scanner-orders.js";
import { applyScopedOrderRevision, isFastener } from "./scanner-scope.js";
import { applyStarterBatch } from "./starter-records.js";
import { normalizeStockPart, applyInventoryBatch, SUPPORTED_GENS, partKey } from "./inventory-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PASSCODE = String(process.env.REFURB_PASSCODE || "566218").trim();
const AUTH_SECRET = String(process.env.AUTH_SECRET || `tcg-refurb-shop:${PASSCODE}:v2`);
const AUTH_COOKIE = "tcg_refurb_auth";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const VALID_STATUSES = new Set(["stDraft", "stReceived", "stAssessment", "stAwaiting", "stRefurb", "stQC", "stTesting", "stReady", "stShipped"]);
const VALID_UNIT_TYPES = new Set(["full", "scanner", "conveyor", "chassis"]);
const VALID_SOURCES = new Set(["print", "stock", "external"]);
const VALID_PRINT_STATUSES = new Set(["draft", "submitted", "confirmed", "printing", "ready", "cancelled"]);
const VALID_CATEGORIES = new Set(["3DP", "Hardware", "Assembly", "Other"]);

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const nonNegative = (value, fallback = 0) => Math.max(0, num(value, fallback));
const positiveInt = (value, fallback = 1) => Math.max(1, Math.round(num(value, fallback)));
const positiveQty = (value, fallback = 1) => num(value, fallback) > 0 ? num(value, fallback) : fallback;
const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);

function moduleTypesFor(unitType) {
  return unitType === "full" ? ["scanner", "conveyor", "chassis"] : [unitType];
}

function normalizePart(part = {}) { return normalizeStockPart({...part, category:part.category || "3DP"}); }

function normalizeMachine(machine = {}) {
  const unitType = VALID_UNIT_TYPES.has(machine.unitType) ? machine.unitType : "full";
  return {
    ...machine,
    id: text(machine.id) || crypto.randomUUID(),
    serial: text(machine.serial).trim(),
    gen: SUPPORTED_GENS.includes(Number(machine.gen)) ? Number(machine.gen) : null,
    grade: ["NM", "LP", "MP", "HP", "DMG"].includes(machine.grade) ? machine.grade : "",
    source: text(machine.source),
    notes: text(machine.notes),
    status: VALID_STATUSES.has(machine.status) ? machine.status : "stReceived",
    received: Object.hasOwn(machine, "received") ? text(machine.received) : new Date().toISOString().slice(0, 10),
    placeholderLabel: text(machine.placeholderLabel),
    needsReview: Boolean(machine.needsReview),
    unitType,
  };
}

function normalizeModules(modules, unitType) {
  const existing = Array.isArray(modules) ? modules : [];
  return moduleTypesFor(unitType).map((type) => {
    const found = existing.find((m) => m && m.type === type) || {};
    return {
      id: text(found.id) || `module-${type}`,
      type,
      serial: text(found.serial),
      inspected: Boolean(found.inspected),
      condition: ["pending", "good", "repair", "replace", "na"].includes(found.condition) ? found.condition : "pending",
      notes: text(found.notes),
    };
  });
}

function normalizeMo(mo = {}, machine, inventory=[]) {
  const unitType = VALID_UNIT_TYPES.has(mo.unitType) ? mo.unitType : (machine?.unitType || "full");
  const rawWorkflow = mo.workflow && typeof mo.workflow === "object" ? mo.workflow : {};
  const workflow = {
    refurbReceived: Boolean(rawWorkflow.refurbReceived),
    modulesSeparated: unitType !== "full" || Boolean(rawWorkflow.modulesSeparated),
    inspectionComplete: Boolean(rawWorkflow.inspectionComplete),
    scopeComplete: Boolean(rawWorkflow.scopeComplete),
    partsReady: Boolean(rawWorkflow.partsReady),
    teardownComplete: Boolean(rawWorkflow.teardownComplete),
    cleaningComplete: Boolean(rawWorkflow.cleaningComplete),
    upgradesComplete: Boolean(rawWorkflow.upgradesComplete),
    pretestPassed: Boolean(rawWorkflow.pretestPassed),
    testingHandoff: Boolean(rawWorkflow.testingHandoff),
  };

  const parts = Array.isArray(mo.parts) ? mo.parts.map((line) => ({
    ...line,
    pn: text(line?.pn).trim(),
    qty: positiveQty(line?.qty, 1),
    module: ["whole", "scanner", "conveyor", "chassis"].includes(line?.module) ? line.module : (unitType === "full" ? "whole" : unitType),
    source: (line?.source === "print" && (line.printable===false || isFastener(line.pn) || inventory.find(p=>p.pn===line.pn)?.category!=="3DP")) ? "external" : (VALID_SOURCES.has(line?.source) ? line.source : "external"),
    issuedQty: Math.min(positiveQty(line?.qty, 1), Math.max(0, num(line?.issuedQty, 0))),
    fulfilled: Boolean(line?.fulfilled),
  })).filter((line) => line.pn) : [];

  let printRequest = null;
  if (mo.printRequest && typeof mo.printRequest === "object") {
    printRequest = {
      number: text(mo.printRequest.number) || `RPR-${text(mo.number).replace(/^MO-/, "") || "0000"}`,
      revision: positiveInt(mo.printRequest.revision, 1),
      status: VALID_PRINT_STATUSES.has(mo.printRequest.status) ? mo.printRequest.status : "submitted",
      generatedAt: text(mo.printRequest.generatedAt) || new Date().toISOString(),
      confirmedAt: text(mo.printRequest.confirmedAt),
      startedAt: text(mo.printRequest.startedAt),
      readyAt: text(mo.printRequest.readyAt),
      notes: text(mo.printRequest.notes),
      lines: Array.isArray(mo.printRequest.lines) ? mo.printRequest.lines.map((line) => ({
        ...line,
        pn: text(line?.pn).trim(),
        qty: positiveQty(line?.qty, 1),
        module: ["whole", "scanner", "conveyor", "chassis"].includes(line?.module) ? line.module : "whole",
      })).filter((line) => line.pn) : [],
    };
  }

  return {
    ...mo,
    id: text(mo.id) || crypto.randomUUID(),
    number: text(mo.number) || "MO-0000",
    machineId: text(mo.machineId) || machine?.id || "",
    serial: text(mo.serial) || machine?.serial || "",
    gen: SUPPORTED_GENS.includes(Number(mo.gen)) ? Number(mo.gen) : (machine?.gen || null),
    unitType,
    created: text(mo.created) || new Date().toISOString().slice(0, 10),
    closed: Boolean(mo.closed),
    parts,
    housing: Array.isArray(mo.housing) ? mo.housing : [],
    bomTasks: Array.isArray(mo.bomTasks) ? mo.bomTasks : [],
    bomGaps: Array.isArray(mo.bomGaps) ? mo.bomGaps : [],
    notes: text(mo.notes),
    modules: normalizeModules(mo.modules, unitType),
    upgrades: Array.isArray(mo.upgrades) ? mo.upgrades.map((upgrade) => ({
      id: text(upgrade?.id) || crypto.randomUUID(),
      module: ["whole", "scanner", "conveyor", "chassis"].includes(upgrade?.module) ? upgrade.module : "whole",
      description: text(upgrade?.description),
      complete: Boolean(upgrade?.complete),
    })).filter((upgrade) => upgrade.description.trim()) : [],
    workflow,
    printRequest,
    pretest: {
      tester: text(mo.pretest?.tester),
      date: text(mo.pretest?.date),
      notes: text(mo.pretest?.notes),
    },
  };
}

function normalizeState(raw = {}) {
  const parts = Array.isArray(raw.parts) ? raw.parts.map(normalizePart).filter((p) => p.pn) : [];
  const machines = Array.isArray(raw.machines) ? raw.machines.map(normalizeMachine) : [];
  const machineMap = new Map(machines.map((machine) => [machine.id, machine]));
  const mos = Array.isArray(raw.mos) ? raw.mos.map((mo) => normalizeMo(mo, machineMap.get(mo?.machineId), parts)) : [];
  const inferredMoCounter = mos.reduce((maximum, mo) => {
    const match = String(mo.number || "").match(/^MO-(\d+)$/i);
    return match ? Math.max(maximum, Number(match[1]) || 0) : maximum;
  }, 0);
  return {
    version: 2,
    appliedRefurbBomSupplements: Array.isArray(raw.appliedRefurbBomSupplements) ? [...new Set(raw.appliedRefurbBomSupplements)] : [],
    appliedRefurbOrderBatches: Array.isArray(raw.appliedRefurbOrderBatches) ? [...new Set(raw.appliedRefurbOrderBatches)] : [],
    refurbOrderImportSummary: raw.refurbOrderImportSummary || null,
    refurbScopeUpdate: raw.refurbScopeUpdate || null,
    appliedStarterBatches: Array.isArray(raw.appliedStarterBatches) ? [...new Set(raw.appliedStarterBatches.filter(id => typeof id === "string"))] : [],
    appliedInventoryBatches: Array.isArray(raw.appliedInventoryBatches) ? [...new Set(raw.appliedInventoryBatches.filter(id => typeof id === "string"))] : [],
    inventoryImportSummary: raw.inventoryImportSummary && typeof raw.inventoryImportSummary === "object" ? raw.inventoryImportSummary : null,
    inventoryImports: Array.isArray(raw.inventoryImports) ? raw.inventoryImports : [],
    parts,
    machines,
    mos,
    moCounter: Math.max(inferredMoCounter, Math.max(0, Math.round(num(raw.moCounter, 0)))),
    inventoryLog: Array.isArray(raw.inventoryLog) ? raw.inventoryLog.slice(0, 2000).map((entry) => ({
      id: text(entry?.id) || crypto.randomUUID(),
      pn: text(entry?.pn),
      delta: num(entry?.delta, 0),
      reason: text(entry?.reason),
      mo: text(entry?.mo),
      at: text(entry?.at) || new Date().toISOString(),
    })) : [],
  };
}

function freshState() {
  return normalizeState({parts: [], machines: [], mos: [], moCounter: 0, inventoryLog: []});
}

function saveState(nextState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(nextState, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

function loadState() {
  let raw;
  let existing = false;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!raw || !Array.isArray(raw.parts) || !Array.isArray(raw.machines) || !Array.isArray(raw.mos)) {
      throw new Error("Stored data has an unexpected shape");
    }
    existing = true;
  } catch (error) {
    // Never replace an unreadable/corrupt live file with starter data.
    if (error.code !== "ENOENT") throw new Error(`Cannot load ${DATA_FILE}; original file left untouched: ${error.message}`);
    raw = freshState();
  }
  const batch = JSON.parse(fs.readFileSync(path.join(__dirname, "starter-units.json"), "utf8"));
  const starters = applyStarterBatch(normalizeState(raw), batch);
  const inventoryBatch = JSON.parse(fs.readFileSync(path.join(__dirname, "inventory-batch.json"), "utf8"));
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-parts.json"), "utf8"));
  const inventory = applyInventoryBatch(starters.state, inventoryBatch, legacy);
  const orderBatch = JSON.parse(fs.readFileSync(path.join(__dirname, "scanner-orders-batch.json"), "utf8"));
  const orders = applyScannerOrdersBatch(inventory.state, orderBatch);
  const supplement = applyScopedOrderRevision(orders.state, orderBatch);
  if (existing && (starters.changed || inventory.changed || orders.changed || supplement.changed)) {
    const backups = path.join(DATA_DIR, ".refurb-backups");
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(DATA_FILE, path.join(backups, `before-scope-update-${stamp}.json`));
  }
  const normalized = normalizeState(supplement.state);
  if (orders.changed) console.log(`Scanner orders: ${orders.report.created.length} created, ${orders.report.populated.length} empty jobs populated, ${orders.report.preserved.length} existing jobs preserved.`);
  if (supplement.changed) console.log(`Order correction: ${supplement.report.updated.length} open orders updated, ${supplement.report.preserved.length} orders retained.`);
  saveState(normalized);
  if (starters.changed) console.log(`Starter import: ${starters.added} added, ${starters.skipped} already present; existing records retained.`);
  if (inventory.changed) console.log(`Inventory import: ${inventory.report.added} added, ${inventory.report.replacedUntouchedSeed} untouched seed records refreshed, ${inventory.report.enriched} existing records retained/enriched.`);
  return normalized;
}

let state = loadState();

function json(res, code, body, extraHeaders = {}) {
  const buffer = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(buffer);
}

function parseCookies(req) {
  const out = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return out;
}

function signature(value) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

function makeToken(seconds) {
  const body = `${Date.now() + seconds * 1000}.${crypto.randomBytes(18).toString("base64url")}`;
  return `${body}.${signature(body)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const pieces = token.split(".");
  if (pieces.length !== 3) return false;
  const body = `${pieces[0]}.${pieces[1]}`;
  const expected = Buffer.from(signature(body));
  const supplied = Buffer.from(pieces[2]);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;
  const expires = Number(pieces[0]);
  return Number.isFinite(expires) && expires > Date.now();
}

function isAuthenticated(req) {
  return verifyToken(parseCookies(req)[AUTH_COOKIE]);
}

function secureRequest(req) {
  return Boolean(req.socket.encrypted) || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function authCookie(req, token, remember) {
  const pieces = [`${AUTH_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secureRequest(req)) pieces.push("Secure");
  if (remember) pieces.push(`Max-Age=${60 * 60 * 24 * 30}`);
  return pieces.join("; ");
}

function clearAuthCookie(req) {
  const pieces = [`${AUTH_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secureRequest(req)) pieces.push("Secure");
  return pieces.join("; ");
}

function readJsonBody(req, maxBytes = 8_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function passcodesMatch(supplied) {
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  /* ---- authentication ---- */
  if (url.pathname === "/api/auth") {
    if (req.method === "GET") return json(res, 200, { authenticated: isAuthenticated(req) });
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req, 50_000);
        if (!passcodesMatch(body.passcode)) return json(res, 401, { authenticated: false, error: "incorrect passcode" });
        const remember = Boolean(body.remember);
        const seconds = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 12;
        const token = makeToken(seconds);
        return json(res, 200, { authenticated: true }, { "Set-Cookie": authCookie(req, token, remember) });
      } catch {
        return json(res, 400, { authenticated: false, error: "bad request" });
      }
    }
    res.writeHead(405); return res.end();
  }

  if (url.pathname === "/api/logout") {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    return json(res, 200, { authenticated: false }, { "Set-Cookie": clearAuthCookie(req) });
  }

  /* ---- API ---- */
  if (url.pathname === "/api/data") {
    if (!isAuthenticated(req)) return json(res, 401, { error: "authentication required" });
    if (req.method === "GET") return json(res, 200, state);
    if (req.method === "PUT") {
      try {
        const next = await readJsonBody(req);
        if (!next || !Array.isArray(next.parts) || !Array.isArray(next.machines) || !Array.isArray(next.mos)) {
          return json(res, 400, { error: "bad shape" });
        }
        if (state.appliedInventoryBatches.some(id => !(next.appliedInventoryBatches || []).includes(id))) {
          return json(res, 409, {error: "Inventory was updated. Close old tabs and refresh before saving; no server data was changed."});
        }
        if (state.appliedRefurbOrderBatches.some(id => !(next.appliedRefurbOrderBatches || []).includes(id))) {
          return json(res, 409, {error: "Scanner orders were loaded. Close old tabs and refresh before saving. No server data was changed."});
        }
        if (state.appliedRefurbBomSupplements.some(id => !(next.appliedRefurbBomSupplements || []).includes(id))) {
          return json(res, 409, {error:"BOM data was updated. Refresh the page before saving."});
        }
        const partKeys = next.parts.map(part => partKey(part?.pn));
        if (partKeys.some(key => !key) || new Set(partKeys).size !== partKeys.length) {
          return json(res, 400, {error: "Part numbers must be nonblank and unique. No data was changed."});
        }
        // A stale browser or an undo snapshot must not remove the one-time marker.
        const normalized = normalizeState({ ...next, appliedRefurbBomSupplements: state.appliedRefurbBomSupplements, appliedRefurbOrderBatches: state.appliedRefurbOrderBatches, refurbOrderImportSummary: state.refurbOrderImportSummary, refurbScopeUpdate: state.refurbScopeUpdate, appliedInventoryBatches: state.appliedInventoryBatches, inventoryImportSummary: state.inventoryImportSummary, inventoryImports: state.inventoryImports, appliedStarterBatches: [...new Set([
          ...state.appliedStarterBatches,
          ...(Array.isArray(next.appliedStarterBatches) ? next.appliedStarterBatches.filter(id => typeof id === "string") : []),
        ])] });
        saveState(normalized);
        state = normalized;
        return json(res, 200, state);
      } catch {
        return json(res, 400, { error: "bad json" });
      }
    }
    res.writeHead(405); return res.end();
  }

  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }

  /* ---- static ---- */
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let file;
  try { file = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end("bad request"); }
  const abs = path.join(__dirname, file);
  // Serve browser assets only. Data, starter serials, backups and server source stay private.
  const publicAssets = new Set(["/index.html", "/app.js", "/styles.css", "/i18n.js", "/vendor-preact-htm.js", "/starter-records.js", "/inventory-utils.js", "/scanner-orders.js", "/scanner-orders-ui.js", "/scanner-scope.js", "/logo.png"]);
  if (!publicAssets.has(file) || !abs.startsWith(__dirname) || file.includes("..")) {
    res.writeHead(404); return res.end("not found");
  }
  fs.readFile(abs, (error, buffer) => {
    if (error) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs)] || "application/octet-stream",
      "Content-Length": buffer.length,
      "Cache-Control": [".html", ".js", ".css"].includes(path.extname(abs)) ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return res.end();
    res.end(buffer);
  });
});

server.listen(PORT, () => {
  console.log(`TCG Refurb Shop on :${server.address().port} | data file: ${DATA_FILE}`);
});
