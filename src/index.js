import { buildPushPayload } from "@block65/webcrypto-web-push";

const BASE_URL_DEFAULT = "https://eu1-developer.deyecloud.com";
const CACHE_KEY = "latest";
const CACHE_MAX_AGE_MS = 4 * 60 * 1000;
let yasnoAddressGroupCache = null;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }
});



function pushVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("Web Push is not configured. Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT secrets.");
  }
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
}

async function ensurePushTables(env) {
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS push_subscriptions (" +
    "endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)"
  ).run();
  try {
    await env.DEYE_DB.prepare(
      "ALTER TABLE push_subscriptions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"
    ).run();
  } catch (_) {
    // Column already exists.
  }
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS push_state (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), last_grid_off_at INTEGER, last_grid_on_at INTEGER)"
  ).run();
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS push_grid_state (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), stable_grid_present INTEGER, " +
    "candidate_grid_present INTEGER, candidate_count INTEGER NOT NULL DEFAULT 0, " +
    "sending INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"
  ).run();
}

async function savePushSubscription(env, subscription) {
  await ensurePushTables(env);
  if (!subscription || typeof subscription.endpoint !== "string" ||
      !subscription.endpoint.startsWith("https://") ||
      typeof subscription.keys?.p256dh !== "string" ||
      typeof subscription.keys?.auth !== "string") {
    throw new Error("Invalid push subscription.");
  }
  await env.DEYE_DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth"
  ).bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()).run();

  // Anchor alert history to the latest known grid state when the first device subscribes.
  const state = await env.DEYE_DB.prepare("SELECT id FROM push_state WHERE id = 1").first();
  if (!state) {
    let snapshot = null;
    try { snapshot = await readSavedSnapshot(env); } catch (_) {}
    await env.DEYE_DB.prepare(
      "INSERT OR IGNORE INTO push_state (id, last_grid_off_at, last_grid_on_at) VALUES (1, ?1, ?2)"
    ).bind(snapshot?.lastGridOffAt || null, snapshot?.lastGridOnAt || null).run();
  }
}

async function sendPushToAll(env, message) {
  await ensurePushTables(env);
  const rows = await env.DEYE_DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE enabled = 1"
  ).all();
  const vapid = pushVapid(env);
  let failed = 0;
  for (const row of rows.results || []) {
    const subscription = {
      endpoint: row.endpoint,
      expirationTime: null,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    try {
      const payload = await buildPushPayload({
        data: message,
        options: { ttl: 3600, urgency: "high", topic: "grid-status" }
      }, subscription, vapid);
      const response = await fetch(subscription.endpoint, payload);
      if (response.status === 404 || response.status === 410) {
        await env.DEYE_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(row.endpoint).run();
      } else if (!response.ok) {
        let detail = "";
        try { detail = (await response.text()).slice(0, 500); } catch (_) {}
        if (response.status === 400 && detail.includes("VapidPkHashMismatch")) {
          // This endpoint was created with a different VAPID public key; remove it
          // so one stale device cannot block notifications to current subscriptions.
          await env.DEYE_DB.prepare(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1"
          ).bind(row.endpoint).run();
          console.warn("Removed stale Web Push subscription with VAPID key mismatch.");
        } else {
          failed++;
          console.warn("Web Push delivery failed:", response.status, detail);
        }
      }
    } catch (error) {
      failed++;
      console.warn("Web Push send error:", error.message);
    }
  }
  if (failed) throw new Error("Some Web Push deliveries failed; they will be retried on the next check.");
  return (rows.results || []).length;
}

async function notifyGridTransitions(env, snapshot) {
  await ensurePushTables(env);
  const current = snapshot.gridPresent === true ? 1 : snapshot.gridPresent === false ? 0 : null;
  if (current === null) return;

  let state = await env.DEYE_DB.prepare(
    "SELECT stable_grid_present, candidate_grid_present, candidate_count, sending, updated_at " +
    "FROM push_grid_state WHERE id = 1"
  ).first();

  // Establish a baseline on first run. Do not notify about an outage that began before setup.
  if (!state) {
    await env.DEYE_DB.prepare(
      "INSERT OR IGNORE INTO push_grid_state " +
      "(id, stable_grid_present, candidate_grid_present, candidate_count, sending, updated_at) " +
      "VALUES (1, ?1, NULL, 0, 0, ?2)"
    ).bind(current, Date.now()).run();
    return;
  }

  const stable = Number(state.stable_grid_present);
  if (current === stable) {
    // The previous state is back: discard any short-lived voltage/frequency fluctuation.
    await env.DEYE_DB.prepare(
      "UPDATE push_grid_state SET candidate_grid_present = NULL, candidate_count = 0 " +
      "WHERE id = 1 AND sending = 0"
    ).run();
    return;
  }

  if (Number(state.sending || 0) === 1) {
    // Recover a claim left behind if a Worker execution was terminated unexpectedly.
    if (Date.now() - Number(state.updated_at || 0) < 3 * 60 * 1000) return;
    await env.DEYE_DB.prepare(
      "UPDATE push_grid_state SET sending = 0 WHERE id = 1 AND sending = 1"
    ).run();
  }

  // Require two consecutive one-minute checks with the same new state.
  await env.DEYE_DB.prepare(
    "UPDATE push_grid_state SET " +
    "candidate_count = CASE WHEN candidate_grid_present = ?1 THEN candidate_count + 1 ELSE 1 END, " +
    "candidate_grid_present = ?1, updated_at = ?2 " +
    "WHERE id = 1 AND stable_grid_present = ?3 AND sending = 0"
  ).bind(current, Date.now(), stable).run();

  state = await env.DEYE_DB.prepare(
    "SELECT stable_grid_present, candidate_grid_present, candidate_count, sending " +
    "FROM push_grid_state WHERE id = 1"
  ).first();

  if (!state || Number(state.sending || 0) === 1 ||
      Number(state.stable_grid_present) === current ||
      Number(state.candidate_grid_present) !== current ||
      Number(state.candidate_count || 0) < 2) return;

  // Atomically claim this transition so overlapping Cron executions cannot send duplicates.
  const claim = await env.DEYE_DB.prepare(
    "UPDATE push_grid_state SET sending = 1, updated_at = ?3 WHERE id = 1 AND stable_grid_present = ?1 " +
    "AND candidate_grid_present = ?2 AND candidate_count >= 2 AND sending = 0"
  ).bind(stable, current, Date.now()).run();
  if (Number(claim.meta?.changes || 0) !== 1) return;

  const batteryText = Number.isFinite(Number(snapshot.batteryPercent))
    ? `🔋 Заряд акумулятора: ${Math.round(Number(snapshot.batteryPercent))}%`
    : "";
  const voltageText = Number.isFinite(Number(snapshot.gridVoltageV)) && Number(snapshot.gridVoltageV) > 0
    ? `⚡ Напруга мережі: ${Math.round(Number(snapshot.gridVoltageV))} В`
    : "";
  const details = [batteryText, voltageText].filter(Boolean).join(" · ");
  const message = current === 0
    ? {
        title: "⚡ Мережу відключено",
        body: ["Будинок перейшов на резервне живлення.", batteryText].filter(Boolean).join("\n"),
        tag: "grid-off",
        url: "/"
      }
    : {
        title: "✅ Електропостачання відновлено",
        body: ["Мережа знову доступна. Будинок підключений до електромережі.", details].filter(Boolean).join("\n"),
        tag: "grid-on",
        url: "/"
      };

  try {
    await sendPushToAll(env, message);
    await env.DEYE_DB.prepare(
      "UPDATE push_grid_state SET stable_grid_present = ?1, candidate_grid_present = NULL, " +
      "candidate_count = 0, sending = 0, updated_at = ?2 WHERE id = 1"
    ).bind(current, Date.now()).run();
  } catch (error) {
    await env.DEYE_DB.prepare(
      "UPDATE push_grid_state SET sending = 0 WHERE id = 1"
    ).run();
    throw error;
  }
}

async function deyeRequest(env, path, token, body) {
  const response = await fetch(`${env.DEYE_BASE_URL || BASE_URL_DEFAULT}/v1.0/${path}`, {
    method: "POST",
    headers: {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(`${path}: ${data.msg || `Deye API error (${response.status})`}; HTTP ${response.status}; code ${data.code ?? "n/a"}`);
  }
  return data;
}

async function getToken(env) {
  const { DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD } = env;
  if (!DEYE_APP_ID || !DEYE_APP_SECRET || !DEYE_EMAIL || !DEYE_PASSWORD || !env.DEYE_STATION_ID) {
    throw new Error("Cloudflare Worker is missing one or more DEYE_* secrets/settings.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DEYE_PASSWORD));
  const passwordHash = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");

  const url = new URL(`${env.DEYE_BASE_URL || BASE_URL_DEFAULT}/v1.0/account/token`);
  url.searchParams.set("appId", DEYE_APP_ID);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appSecret: DEYE_APP_SECRET, email: DEYE_EMAIL, password: passwordHash })
  });
  const data = await response.json();
  if (!response.ok || data.success === false || !data.accessToken) {
    throw new Error(`account_token: ${data.msg || "DeyeCloud authorization failed."}; HTTP ${response.status}; code ${data.code ?? "n/a"}`);
  }
  return data.accessToken;
}

async function readSavedSnapshot(env) {
  const row = await env.DEYE_DB.prepare(
    "SELECT payload FROM snapshots WHERE id = ?1"
  ).bind(CACHE_KEY).first();
  return row?.payload ? JSON.parse(row.payload) : null;
}

async function saveSnapshot(env, snapshot) {
  await env.DEYE_DB.prepare(
    "INSERT INTO snapshots (id, payload, updated_at) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
  ).bind(CACHE_KEY, JSON.stringify(snapshot), snapshot.cacheFetchedAt).run();
}

async function fetchGridHistory(env, token) {
  const deviceSn = env.DEYE_DEVICE_SN || "2608156594";
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const result = await deyeRequest(env, "device/history", token, {
    deviceSn,
    granularity: 1,
    startAt: date,
    endAt: date,
    measurePoints: ["GridVoltageL1L2", "GridFrequency"]
  });
  const rows = Array.isArray(result.dataList) ? result.dataList : [];
  return rows.map(row => {
    const values = Object.fromEntries((row.itemList || []).map(item => [item.key, Number(item.value)]));
    const voltage = values.GridVoltageL1L2;
    const frequency = values.GridFrequency;
    return {
      time: Number(row.time) * 1000,
      voltageValid: Number.isFinite(voltage),
      frequencyValid: Number.isFinite(frequency),
      gridPresent: Number.isFinite(voltage) && voltage >= 180 &&
        Number.isFinite(frequency) && frequency >= 45 && frequency <= 55
    };
  }).filter(point => Number.isFinite(point.time) && point.voltageValid && point.frequencyValid)
    .map(point => ({ time: point.time, gridPresent: point.gridPresent }))
    .sort((a, b) => a.time - b.time);
}

function getGridTransitions(points, previous) {
  let lastGridOffAt = previous?.lastGridOffAt ?? null;
  let lastGridOnAt = previous?.lastGridOnAt ?? previous?.lastGridPowerAt ?? null;
  let previousState = null;

  for (const point of points) {
    if (previousState !== null && point.gridPresent !== previousState) {
      if (point.gridPresent) lastGridOnAt = point.time;
      else lastGridOffAt = point.time;
    }
    previousState = point.gridPresent;
  }

  return { lastGridOffAt, lastGridOnAt };
}


async function ensureAnalyticsTables(env) {
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS battery_samples (" +
    "sampled_at INTEGER PRIMARY KEY, battery_percent REAL NOT NULL, " +
    "consumption_w REAL, generation_w REAL, grid_w REAL, battery_w REAL, " +
    "grid_present INTEGER NOT NULL, charge_w REAL, discharge_w REAL)"
  ).run();
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS grid_events (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, " +
    "occurred_at INTEGER NOT NULL, UNIQUE(event_type, occurred_at))"
  ).run();
  await env.DEYE_DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_grid_events_time ON grid_events(occurred_at)"
  ).run();
}

async function saveAnalyticsSample(env, snapshot, gridHistory) {
  await ensureAnalyticsTables(env);
  const sampledAt = Math.floor(Number(snapshot.cacheFetchedAt) / 60000) * 60000;
  await env.DEYE_DB.prepare(
    "INSERT OR REPLACE INTO battery_samples " +
    "(sampled_at, battery_percent, consumption_w, generation_w, grid_w, battery_w, grid_present, charge_w, discharge_w) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
  ).bind(
    sampledAt,
    Number(snapshot.batteryPercent) || 0,
    Number(snapshot.consumptionW) || 0,
    Number(snapshot.generationW) || 0,
    snapshot.gridW == null ? null : Number(snapshot.gridW),
    Number(snapshot.batteryW) || 0,
    snapshot.gridPresent === true ? 1 : 0,
    Number(snapshot.chargeW) || 0,
    Number(snapshot.dischargeW) || 0
  ).run();

  const ordered = [...(gridHistory || [])].sort((a, b) => a.time - b.time);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].gridPresent === ordered[i - 1].gridPresent) continue;
    const eventType = ordered[i].gridPresent ? "grid_on" : "grid_off";
    await env.DEYE_DB.prepare(
      "INSERT OR IGNORE INTO grid_events (event_type, occurred_at) VALUES (?1, ?2)"
    ).bind(eventType, Math.floor(Number(ordered[i].time))).run();
  }

  // Keep 30 days of chart history and outage events. Prune once per hour.
  if (new Date(Number(snapshot.cacheFetchedAt)).getMinutes() === 0) {
    const cutoff = Number(snapshot.cacheFetchedAt) - 30 * 24 * 60 * 60 * 1000;
    await env.DEYE_DB.prepare("DELETE FROM battery_samples WHERE sampled_at < ?1").bind(cutoff).run();
    await env.DEYE_DB.prepare("DELETE FROM grid_events WHERE occurred_at < ?1").bind(cutoff).run();
  }
}

async function fetchAnalytics(env, requestedRange) {
  await ensureAnalyticsTables(env);
  const ranges = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000 };
  const range = Object.prototype.hasOwnProperty.call(ranges, requestedRange) ? requestedRange : "24h";
  const now = Date.now();
  const from = now - ranges[range];
  const [sampleResult, eventResult] = await Promise.all([
    env.DEYE_DB.prepare(
      "SELECT sampled_at, battery_percent, consumption_w, generation_w, grid_w, battery_w, grid_present, charge_w, discharge_w " +
      "FROM battery_samples WHERE sampled_at >= ?1 AND sampled_at <= ?2 ORDER BY sampled_at ASC"
    ).bind(from, now).all(),
    env.DEYE_DB.prepare(
      "SELECT event_type, occurred_at FROM grid_events WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
      "ORDER BY occurred_at DESC LIMIT 300"
    ).bind(now - 30 * 24 * 60 * 60 * 1000, now).all()
  ]);
  return {
    ok: true,
    range,
    from,
    to: now,
    samples: sampleResult.results || [],
    events: eventResult.results || []
  };
}

async function fetchSnapshot(env) {
  const token = await getToken(env);
  const stationId = Number(env.DEYE_STATION_ID);
  const raw = await deyeRequest(env, "station/latest", token, { stationId });
  const deviceSn = env.DEYE_DEVICE_SN || "2608156594";
  const telemetry = await deyeRequest(env, "device/latest", token, { deviceList: [deviceSn] });
  let gridHistory = [];
  try {
    gridHistory = await fetchGridHistory(env, token);
  } catch (error) {
    console.warn("Could not read Deye grid history:", error.message);
  }
  const devices = telemetry.deviceDataList || telemetry.devices || [];
  const inverter = devices.find(device => device.deviceSn === deviceSn) || devices[0];
  const points = Object.fromEntries((inverter?.dataList || []).map(point => [point.key, Number(point.value)]));
  const gridVoltageV = Number.isFinite(points.GridVoltageL1L2) ? points.GridVoltageL1L2 : null;
  const gridFrequencyHz = Number.isFinite(points.GridFrequency) ? points.GridFrequency : null;
  const gridPresent = gridVoltageV != null && gridVoltageV >= 180 &&
    gridFrequencyHz != null && gridFrequencyHz >= 45 && gridFrequencyHz <= 55;

  const soc = Number(raw.batterySOC ?? 0);
  const batteryPower = Number(raw.batteryPower ?? 0);
  const dischargeW = Math.max(0, Number(raw.dischargePower ?? 0));
  // DeyeCloud may report chargePower as 0/null while batteryPower is negative during charging.
  // In this inverter's telemetry, a negative batteryPower indicates charging.
  const reportedChargeW = Number(raw.chargePower ?? 0);
  const chargeW = reportedChargeW > 30
    ? reportedChargeW
    : batteryPower < -30 ? Math.abs(batteryPower) : 0;
  const capacityKwh = Number(env.BATTERY_CAPACITY_KWH || 5.12);
  const reservePercent = Number(env.BATTERY_RESERVE_PERCENT || 10);
  const usableKwh = Math.max(0, capacityKwh * (soc - reservePercent) / 100);
  const fetchedAt = Date.now();

  // Keep one discharge-power sample per Worker refresh. The cron runs every minute.
  // Use a rolling 15-minute average once enough history has accumulated.
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS discharge_samples (sampled_at INTEGER PRIMARY KEY, discharge_w REAL NOT NULL)"
  ).run();
  if (gridPresent) {
    // Start a fresh averaging window after the next outage; don't mix grid-on time into runtime.
    await env.DEYE_DB.prepare("DELETE FROM discharge_samples").run();
  } else {
    await env.DEYE_DB.prepare(
      "INSERT OR REPLACE INTO discharge_samples (sampled_at, discharge_w) VALUES (?1, ?2)"
    ).bind(fetchedAt, dischargeW).run();
    await env.DEYE_DB.prepare(
      "DELETE FROM discharge_samples WHERE sampled_at < ?1"
    ).bind(fetchedAt - 60 * 60 * 1000).run();
  }

  const dischargeStats = await env.DEYE_DB.prepare(
    "SELECT AVG(discharge_w) AS average_w, COUNT(*) AS sample_count, " +
    "MIN(sampled_at) AS first_sample_at, MAX(sampled_at) AS last_sample_at " +
    "FROM discharge_samples WHERE sampled_at >= ?1 AND sampled_at <= ?2"
  ).bind(fetchedAt - 15 * 60 * 1000, fetchedAt).first();

  const averageDischargeW = Number(dischargeStats?.average_w ?? 0);
  const sampleCount = Number(dischargeStats?.sample_count ?? 0);
  const sampleSpanMs = Number(dischargeStats?.last_sample_at ?? 0) -
    Number(dischargeStats?.first_sample_at ?? 0);
  const hasReliableAverage = sampleCount >= 5 && sampleSpanMs >= 4 * 60 * 1000;
  const effectiveDischargeW = hasReliableAverage ? averageDischargeW : dischargeW;
  const remainingHours = dischargeW > 30 && effectiveDischargeW > 30
    ? usableKwh * 1000 / effectiveDischargeW
    : null;
  const chargeHours = chargeW > 30 && soc < 100
    ? capacityKwh * (100 - soc) / 100 * 1000 / chargeW
    : null;

  let previous = null;
  try {
    previous = await readSavedSnapshot(env);
  } catch (error) {
    console.warn("Could not read previous Deye snapshot:", error.message);
  }
  const transitions = getGridTransitions(gridHistory, previous);
  const lastGridPowerAt = transitions.lastGridOnAt ?? (gridPresent
    ? (inverter?.collectionTime ? Number(inverter.collectionTime) * 1000 : fetchedAt)
    : (previous?.lastGridPowerAt ?? null));

  const snapshot = {
    configured: true,
    updatedAt: raw.lastUpdateTime
      ? new Date(Number(raw.lastUpdateTime) * 1000).toISOString()
      : new Date().toISOString(),
    batteryPercent: soc,
    generationW: Number(raw.generationPower ?? 0),
    consumptionW: Number(raw.consumptionPower ?? 0),
    gridW: raw.gridPower == null ? null : Number(raw.gridPower),
    gridVoltageV,
    gridFrequencyHz,
    gridPresent,
    lastGridPowerAt,
    lastGridOffAt: transitions.lastGridOffAt,
    lastGridOnAt: transitions.lastGridOnAt,
    batteryW: batteryPower,
    chargeW,
    chargeHours,
    dischargeW,
    dischargeAverageW: hasReliableAverage ? averageDischargeW : null,
    dischargeSampleCount: sampleCount,
    remainingHours,
    remainingHoursInstant: dischargeW > 30 ? usableKwh * 1000 / dischargeW : null,
    capacityKwh,
    reservePercent,
    cacheFetchedAt: fetchedAt
  };

  await saveSnapshot(env, snapshot);
  try {
    await saveAnalyticsSample(env, snapshot, gridHistory);
  } catch (error) {
    console.warn("Could not save Deye analytics history:", error.message);
  }
  return snapshot;
}

async function getSnapshot(env) {
  let snapshot = null;
  try {
    snapshot = await readSavedSnapshot(env);
  } catch (error) {
    console.warn("Could not read Deye snapshot:", error.message);
  }
  if (snapshot?.cacheFetchedAt && Date.now() - Number(snapshot.cacheFetchedAt) < CACHE_MAX_AGE_MS) {
    return { ...snapshot, cacheAgeSeconds: Math.floor((Date.now() - Number(snapshot.cacheFetchedAt)) / 1000) };
  }
  return { ...(await fetchSnapshot(env)), cacheAgeSeconds: 0 };
}

async function fetchDeviceHistory(env) {
  const token = await getToken(env);
  const deviceSn = env.DEYE_DEVICE_SN || "2608156594";
  const date = new Date().toISOString().slice(0, 10);
  const result = await deyeRequest(env, "device/history", token, {
    deviceSn,
    granularity: 1,
    startAt: date,
    endAt: date,
    measurePoints: ["GridVoltageL1L2", "GridFrequency"]
  });
  return {
    ok: true,
    deviceSn,
    date,
    granularity: 1,
    requestedMeasurePoints: ["GridVoltageL1L2", "GridFrequency"],
    response: result
  };
}

async function fetchStationAlerts(env) {
  const token = await getToken(env);
  const now = Math.floor(Date.now() / 1000);
  const startTimestamp = now - 30 * 24 * 60 * 60;
  const stationId = Number(env.DEYE_STATION_ID);
  const result = await deyeRequest(env, "station/alertList", token, {
    stationId,
    startTimestamp,
    endTimestamp: now,
    page: 1,
    size: 200
  });
  const items = Array.isArray(result.stationAlertItems) ? result.stationAlertItems : [];
  return {
    ok: true,
    stationId,
    period: { startTimestamp, endTimestamp: now, days: 30 },
    total: Number(result.total ?? items.length),
    returned: items.length,
    alerts: items
  };
}

async function fetchDeviceAlerts(env) {
  const token = await getToken(env);
  const now = Math.floor(Date.now() / 1000);
  const startTimestamp = now - 30 * 24 * 60 * 60;
  const deviceSn = env.DEYE_DEVICE_SN || "2608156594";
  const result = await deyeRequest(env, "device/alertList", token, {
    deviceSn,
    startTimestamp,
    endTimestamp: now,
    page: 1,
    size: 100
  });

  const alertList = Array.isArray(result.alertList) ? result.alertList : [];
  return {
    ok: true,
    deviceSn,
    period: {
      startTimestamp,
      endTimestamp: now,
      days: 30
    },
    total: Number(result.total ?? alertList.length),
    returned: alertList.length,
    alerts: alertList.map(alert => ({
      alertCode: alert.alertCode ?? null,
      alertName: alert.alertName ?? null,
      protocolName: alert.protocolName ?? null,
      description: alert.description ?? null,
      alertStartTime: alert.alertStartTime ?? null,
      alertEndTime: alert.alertEndTime ?? null,
      status: alert.status ?? null
    }))
  };
}


async function fetchBatteryDiagnostics(env) {
  const token = await getToken(env);
  const deviceSn = env.DEYE_DEVICE_SN || "2608156594";
  const now = Math.floor(Date.now() / 1000);
  const startTimestamp = now - 30 * 24 * 60 * 60;

  const [latestResult, measurePointsResult, alertsResult] = await Promise.all([
    deyeRequest(env, "device/latest", token, { deviceList: [deviceSn] }),
    deyeRequest(env, "device/measurePoints", token, { deviceSn, deviceType: "INVERTER" }),
    deyeRequest(env, "device/alertList", token, {
      deviceSn,
      startTimestamp,
      endTimestamp: now,
      page: 1,
      size: 100
    })
  ]);

  const devices = latestResult.deviceDataList || latestResult.devices || [];
  const device = devices.find(item => item.deviceSn === deviceSn) || devices[0] || null;
  const dataList = Array.isArray(device?.dataList) ? device.dataList : [];
  const latestValues = Object.fromEntries(dataList.map(item => [
    item.key,
    { value: item.value, unit: item.unit ?? null }
  ]));

  const alertList = Array.isArray(alertsResult.alertList) ? alertsResult.alertList : [];
  return {
    ok: true,
    deviceSn,
    collectedAt: device?.collectionTime ? Number(device.collectionTime) * 1000 : Date.now(),
    deviceState: device?.deviceState ?? null,
    deviceType: device?.deviceType ?? null,
    availableMeasurePoints: measurePointsResult.measurePoints || [],
    latestDataPoints: dataList,
    latestValues,
    alerts: alertList.map(alert => ({
      alertCode: alert.alertCode ?? null,
      alertName: alert.alertName ?? null,
      protocolName: alert.protocolName ?? null,
      description: alert.description ?? null,
      alertStartTime: alert.alertStartTime ?? null,
      alertEndTime: alert.alertEndTime ?? null,
      status: alert.status ?? null
    })),
    alertCount: Number(alertsResult.total ?? alertList.length),
    periodDays: 30,
    note: "Only values actually returned by DeyeCloud are included. Cell-level BMS values may not be exposed by this inverter API."
  };
}

async function yasnoAddressGet(path, params) {
  const url = new URL("https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/" + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json", "Cache-Control": "no-cache, no-store" }
  });
  if (!response.ok) throw new Error(`YASNO address lookup ${path} failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`YASNO address lookup ${path}: unexpected response`);
  return payload;
}

async function fetchYasnoAddressGroup() {
  if (yasnoAddressGroupCache && Date.now() - yasnoAddressGroupCache.checkedAt < 60 * 60 * 1000) {
    return yasnoAddressGroupCache;
  }
  const base = { regionId: "25", dsoId: "902" };
  const streetTerms = ["Заболотного", "Академіка Заболотного", "Академіка"];
  let streetChoices = [];
  for (const query of streetTerms) {
    const result = await yasnoAddressGet("streets", { ...base, query });
    streetChoices = streetChoices.concat(result);
    const match = result.find(item => {
      const value = String(item?.value || "").toLocaleLowerCase("uk-UA").replace(/[’']/g, "");
      return value.includes("заболот") && item?.id !== undefined && item?.id !== null && String(item.id).trim() !== "";
    });
    if (!match) continue;

    const houseQueries = ["56-58", "56–58", "56", "58"];
    let houses = [];
    let house = null;
    for (const houseQuery of houseQueries) {
      const found = await yasnoAddressGet("houses", { ...base, streetId: match.id, query: houseQuery });
      houses = houses.concat(found);
      house = found.find(item => {
        const value = String(item?.value || "").trim().replace(/[–—]/g, "-").replace(/\s+/g, "");
        return /^56-58(?:$|[А-ЯA-Z])/i.test(value) && item?.id !== undefined && item?.id !== null && String(item.id).trim() !== "";
      });
      if (house) break;
    }
    if (!house) {
      const examples = houses.slice(0, 10).map(item => String(item?.value || "")).filter(Boolean).join("; ");
      throw new Error("YASNO address directory: house range 56-58 was not found for street " + String(match.value || match.id) + (examples ? ". Returned houses: " + examples : ""));
    }

    const groupUrl = new URL("https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/group");
    for (const [key, value] of Object.entries({ ...base, streetId: match.id, houseId: house.id })) {
      groupUrl.searchParams.set(key, String(value));
    }
    const response = await fetch(groupUrl.toString(), {
      headers: { "Accept": "application/json", "Cache-Control": "no-cache, no-store" }
    });
    if (!response.ok) throw new Error(`YASNO address group lookup failed: HTTP ${response.status}`);
    const resultGroup = await response.json();
    if (!Number.isInteger(resultGroup?.group) || !Number.isInteger(resultGroup?.subgroup)) {
      throw new Error("YASNO address directory returned no valid group for house range 56-58");
    }
    yasnoAddressGroupCache = {
      group: `${resultGroup.group}.${resultGroup.subgroup}`,
      street: match.value,
      house: house.value,
      checkedAt: Date.now(),
      source: "YASNO address directory"
    };
    return yasnoAddressGroupCache;
  }
  const examples = streetChoices.slice(0, 8).map(item => String(item?.value || "")).filter(Boolean).join("; ");
  throw new Error("YASNO address directory: street not found. Returned examples: " + (examples || "no matching street results"));
}
async function fetchDtekSchedule() {
  // Resolve the address group from YASNO itself; never assume a stale DTEK group.
  const addressGroup = await fetchYasnoAddressGroup();
  const url = new URL("https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages");
  url.searchParams.set("_refresh", String(Date.now()));
  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Pragma": "no-cache"
    }
  });
  if (!response.ok) throw new Error(`YASNO schedule request failed: HTTP ${response.status}`);
  const data = await response.json();
  const group = data[addressGroup.group];
  if (!group) throw new Error(`Schedule for YASNO address group ${addressGroup.group} was not found.`);
  return {
    ok: true,
    group: addressGroup.group,
    groupSource: addressGroup.source,
    groupCheckedAt: addressGroup.checkedAt,
    address: "м. Київ, вул. Академіка Заболотного, 56–58 (ввід 1)",
    today: group.today || null,
    tomorrow: group.tomorrow || null,
    updatedOn: group.updatedOn || null,
    checkedAt: Date.now(),
    source: "YASNO public outage schedule"
  };
}


async function ensureDtekAddressCache(env) {
  await env.DEYE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS dtek_address_cache (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT, fetched_at INTEGER, last_attempt_at INTEGER)"
  ).run();

  // This cache is intentionally a singleton: retain only the latest DTEK response.
  // The cleanup also removes extra rows if the table was created by an older schema.
  await env.DEYE_DB.prepare(
    "DELETE FROM dtek_address_cache WHERE id <> 1"
  ).run();
}

async function readDtekAddressCache(env) {
  await ensureDtekAddressCache(env);
  const row = await env.DEYE_DB.prepare(
    "SELECT payload, fetched_at, last_attempt_at FROM dtek_address_cache WHERE id = 1"
  ).first();
  if (!row?.payload) return null;
  try {
    return {
      data: JSON.parse(row.payload),
      fetchedAt: Number(row.fetched_at || 0),
      lastAttemptAt: Number(row.last_attempt_at || 0)
    };
  } catch (_) {
    return null;
  }
}

async function fetchDtekAddressStatus(env) {
  const cookie = env.DTEK_SESSION_COOKIE;
  const csrfToken = env.DTEK_CSRF_TOKEN;
  if (!cookie || !csrfToken) {
    return {
      ok: true,
      configured: false,
      address: "м. Київ, вул. Академіка Заболотного, 56–58 (ввід 1)",
      message: "Адресний запит ДТЕК ще не налаштовано. Потрібні DTEK_SESSION_COOKIE та DTEK_CSRF_TOKEN у Cloudflare Worker Secrets."
    };
  }

  await ensureDtekAddressCache(env);
  const now = Date.now();
  const cached = await readDtekAddressCache(env);

  // Avoid repeatedly hitting DTEK when its anti-bot layer is temporarily blocking requests.
  if (cached?.data && cached.lastAttemptAt && now - cached.lastAttemptAt < 5 * 60 * 1000) {
    const stale = now - cached.fetchedAt > 5 * 60 * 1000;
    return {
      ...cached.data,
      stale,
      lastSuccessfulAt: cached.fetchedAt,
      warning: stale
        ? "Показано останні успішно отримані дані ДТЕК. Наступна перевірка буде не раніше ніж через 5 хвилин."
        : null
    };
  }

  await env.DEYE_DB.prepare(
    "INSERT INTO dtek_address_cache (id, payload, fetched_at, last_attempt_at) " +
    "VALUES (1, NULL, NULL, ?1) " +
    "ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at"
  ).bind(now).run();

  const form = new URLSearchParams();
  form.set("method", "getHomeNum");
  form.set("data[0][name]", "city");
  form.set("data[0][value]", "м. Київ");
  form.set("data[1][name]", "street");
  form.set("data[1][value]", "вул. Заболотного Академіка");
  form.set("data[2][name]", "updateFact");
  form.set("data[2][value]", String(Math.floor(now / 1000)));

  const response = await fetch("https://www.dtek-kem.com.ua/ua/ajax", {
    method: "POST",
    headers: {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
      "Cookie": cookie,
      "Origin": "https://www.dtek-kem.com.ua",
      "Referer": "https://www.dtek-kem.com.ua/ua/shutdowns",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
    },
    body: form.toString()
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`DTEK address request failed: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const preview = rawText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(
      "ДТЕК повернув не JSON. HTTP " + response.status +
      "; Content-Type: " + contentType +
      "; URL: " + response.url +
      "; відповідь: " + preview
    );
  }

  const hasHouseMap = Boolean(payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data));
  if (!payload || !hasHouseMap) {
    const diagnostic = {
      httpStatus: response.status,
      result: payload?.result ?? null,
      hasData: Boolean(payload?.data),
      topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
      rawLength: rawText.length
    };
    throw new Error("Відповідь AJAX ДТЕК не містить списку будинків: " + JSON.stringify(diagnostic));
  }

  const house = payload.data["56-58"] || payload.data["56–58"] || payload.data["56—58"];
  if (!house) throw new Error("У списку ДТЕК немає окремого запису для будинків 56–58. Доступні записи: " + Object.keys(payload.data).slice(0, 30).join(", "));

  const reason = String(house.sub_type || "").trim();
  const startAt = String(house.start_date || "").trim();
  const expectedEndAt = String(house.end_date || "").trim();
  const outageType = String(house.type || "").trim();
  const groups = Array.isArray(house.sub_type_reason) ? house.sub_type_reason.map(String) : [];
  const active = Boolean(reason || startAt || expectedEndAt || outageType);
  const normalized = reason.toLocaleLowerCase("uk-UA");
  let kind = "none";
  if (active && /(аварійн|екстрен|невідклад)/i.test(normalized)) kind = "emergency";
  else if (active && (outageType === "1" || outageType === "2" || /планов|стабілізаційн/i.test(normalized))) kind = "planned";
  else if (active) kind = "other";

  const result = {
    ok: true,
    configured: true,
    address: "м. Київ, вул. Академіка Заболотного, 56–58 (ввід 1)",
    houseNumber: "56–58",
    entrance: "1",
    groups,
    active,
    addressSpecific: active,
    fallbackGroup: !active && groups.length ? String(groups[0]).replace(/^GPV/i, "") : null,
    kind,
    reason: reason || (active ? "ДТЕК повідомляє про роботи/відключення без уточненої причини" : ""),
    startAt: startAt || null,
    expectedEndAt: expectedEndAt || null,
    outageType: outageType || null,
    updatedAt: payload.updateTimestamp || null,
    source: "DTEK Kyiv Electric Networks address AJAX",
    stale: false,
    lastSuccessfulAt: now
  };

  // Replace the single cached payload in place; never append DTEK history.
  await env.DEYE_DB.prepare(
    "INSERT INTO dtek_address_cache (id, payload, fetched_at, last_attempt_at) " +
    "VALUES (1, ?1, ?2, ?2) " +
    "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, " +
    "fetched_at = excluded.fetched_at, last_attempt_at = excluded.last_attempt_at"
  ).bind(JSON.stringify(result), now).run();

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config-check") {
      return json({
        checks: {
          DEYE_APP_ID: Boolean(env.DEYE_APP_ID),
          DEYE_APP_SECRET: Boolean(env.DEYE_APP_SECRET),
          DEYE_EMAIL: Boolean(env.DEYE_EMAIL),
          DEYE_PASSWORD: Boolean(env.DEYE_PASSWORD),
          DEYE_STATION_ID: Boolean(env.DEYE_STATION_ID),
          DEYE_DEVICE_SN: Boolean(env.DEYE_DEVICE_SN),
          DTEK_SESSION_COOKIE: Boolean(env.DTEK_SESSION_COOKIE),
          DTEK_CSRF_TOKEN: Boolean(env.DTEK_CSRF_TOKEN)
        },
        note: "Only presence is reported; secret values are never returned."
      });
    }
    if (url.pathname === "/api/battery-diagnostics") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchBatteryDiagnostics(env));
      } catch (error) {
        console.error("Deye battery diagnostics error:", error);
        return json({ ok: false, error: error.message || "Could not load battery diagnostics" }, 502);
      }
    }
    if (url.pathname === "/api/device-history") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchDeviceHistory(env));
      } catch (error) {
        console.error("Deye device history error:", error);
        return json({ error: error.message || "Unknown server error" }, 500);
      }
    }
    if (url.pathname === "/api/station-alerts") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchStationAlerts(env));
      } catch (error) {
        console.error("Deye station alerts error:", error);
        return json({ error: error.message || "Unknown server error" }, 500);
      }
    }
    if (url.pathname === "/api/alerts") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchDeviceAlerts(env));
      } catch (error) {
        console.error("Deye alerts error:", error);
        return json({ error: error.message || "Unknown server error" }, 500);
      }
    }
    if (url.pathname === "/api/history") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchAnalytics(env, url.searchParams.get("range") || "24h"));
      } catch (error) {
        console.error("Deye analytics history error:", error);
        return json({ error: error.message || "Unknown server error" }, 500);
      }
    }
    if (url.pathname === "/api/dtek-schedule") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchDtekSchedule());
      } catch (error) {
        console.error("DTEK schedule error:", error);
        return json({ error: error.message || "Could not load DTEK schedule" }, 502);
      }
    }
    if (url.pathname === "/api/dtek-address") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchDtekAddressStatus(env));
      } catch (error) {
        console.error("DTEK address status error:", error);
        try {
          const cached = await readDtekAddressCache(env);
          if (cached?.data) {
            return json({
              ...cached.data,
              stale: true,
              lastSuccessfulAt: cached.fetchedAt,
              warning: "ДТЕК тимчасово недоступний. Показано останні успішно отримані дані; перевірте час останнього оновлення.",
              refreshError: error.message || "DTEK request failed"
            });
          }
        } catch (cacheError) {
          console.error("Could not read DTEK address cache:", cacheError.message);
        }
        return json({ ok: false, error: error.message || "Could not load DTEK address status" }, 502);
      }
    }

    if (url.pathname === "/api/push/public-key") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        pushVapid(env);
        return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
      } catch (error) {
        return json({ ok: false, error: error.message }, 503);
      }
    }
    if (url.pathname === "/api/push/subscribe") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden origin" }, 403);
      try {
        await ensurePushTables(env);
        const body = await request.json();
        if (request.method === "DELETE") {
          if (typeof body.endpoint !== "string") return json({ error: "Endpoint is required" }, 400);
          await env.DEYE_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(body.endpoint).run();
          return json({ ok: true, subscribed: false });
        }
        await savePushSubscription(env, body);
        return json({ ok: true, subscribed: true });
      } catch (error) {
        return json({ ok: false, error: error.message || "Could not save push subscription" }, 400);
      }
    }
    if (url.pathname === "/api/push/settings") {
      if (request.method === "OPTIONS") return json({ ok: true });
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden origin" }, 403);
      try {
        await ensurePushTables(env);
        if (request.method === "GET") {
          const endpoint = url.searchParams.get("endpoint");
          if (!endpoint) return json({ error: "Endpoint is required" }, 400);
          const row = await env.DEYE_DB.prepare(
            "SELECT enabled FROM push_subscriptions WHERE endpoint = ?1"
          ).bind(endpoint).first();
          return json({ ok: true, enabled: row ? Number(row.enabled) === 1 : false });
        }
        if (request.method === "POST") {
          const body = await request.json();
          if (typeof body.endpoint !== "string" || typeof body.enabled !== "boolean") {
            return json({ error: "Endpoint and enabled are required" }, 400);
          }
          const result = await env.DEYE_DB.prepare(
            "UPDATE push_subscriptions SET enabled = ?1 WHERE endpoint = ?2"
          ).bind(body.enabled ? 1 : 0, body.endpoint).run();
          if (Number(result.meta?.changes || 0) !== 1) {
            return json({ error: "Push subscription not found" }, 404);
          }
          return json({ ok: true, enabled: body.enabled });
        }
        return json({ error: "Method not allowed" }, 405);
      } catch (error) {
        return json({ ok: false, error: error.message || "Could not update push settings" }, 400);
      }
    }
    if (url.pathname === "/api/push/test") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden origin" }, 403);
      try {
        const count = await sendPushToAll(env, {
          title: "Deye Monitor",
          body: "Тестове сповіщення працює. Тепер повідомлятиму про стан електромережі.",
          tag: "push-test",
          url: "/"
        });
        return json({ ok: true, sent: count });
      } catch (error) {
        return json({ ok: false, error: error.message || "Could not send test notification" }, 502);
      }
    }

    if (url.pathname === "/api/status") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await getSnapshot(env));
      } catch (error) {
        console.error("Deye status error:", error);
        return json({ error: error.message || "Unknown server error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const snapshot = await fetchSnapshot(env);
        console.log("Deye snapshot refreshed", {
          batteryPercent: snapshot.batteryPercent,
          gridPresent: snapshot.gridPresent,
          cacheFetchedAt: snapshot.cacheFetchedAt
        });
        await notifyGridTransitions(env, snapshot);
      } catch (error) {
        console.error("Scheduled Deye refresh or push notification failed:", error);
      }
    })());
  }
};