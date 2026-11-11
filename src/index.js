const BASE_URL_DEFAULT = "https://eu1-developer.deyecloud.com";
const CACHE_KEY = "latest";
const CACHE_MAX_AGE_MS = 4 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }
});

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

async function tuyaHmac(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function tuyaApiRequest(env, path) {
  const accessId = env.TUYA_ACCESS_ID;
  const accessSecret = env.TUYA_ACCESS_SECRET;
  if (!accessId || !accessSecret || !env.TUYA_DEVICE_ID) {
    throw new Error("Tuya secrets are incomplete. Check TUYA_ACCESS_ID, TUYA_ACCESS_SECRET and TUYA_DEVICE_ID.");
  }

  const baseUrl = env.TUYA_API_BASE_URL || "https://openapi.tuyaeu.com";
  const tokenTime = Date.now().toString();
  const tokenSign = await tuyaHmac(accessId + tokenTime, accessSecret);
  const tokenResponse = await fetch(`${baseUrl}/v1.0/token?grant_type=1`, {
    method: "GET",
    headers: {
      client_id: accessId,
      sign: tokenSign,
      sign_method: "HMAC-SHA256",
      t: tokenTime
    }
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || tokenData.success !== true || !tokenData.result?.access_token) {
    throw new Error(`Tuya authorization failed: ${tokenData.msg || "token was not returned"} (code ${tokenData.code ?? tokenResponse.status})`);
  }

  const accessToken = tokenData.result.access_token;
  const requestTime = Date.now().toString();
  const requestSign = await tuyaHmac(accessId + accessToken + requestTime, accessSecret);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      client_id: accessId,
      access_token: accessToken,
      sign: requestSign,
      sign_method: "HMAC-SHA256",
      t: requestTime,
      Accept: "application/json"
    }
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) {
    throw new Error(`Tuya API request failed: ${data.msg || "unknown error"} (code ${data.code ?? response.status})`);
  }
  return data;
}

async function fetchTuyaDeviceStatus(env) {
  const deviceId = env.TUYA_DEVICE_ID;
  const data = await tuyaApiRequest(env, `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/status`);
  const statusList = Array.isArray(data.result) ? data.result : [];
  const switchPoint = statusList.find(point => point.code === "switch_1");
  return {
    ok: true,
    configured: true,
    deviceId,
    switchCode: "switch_1",
    switchState: typeof switchPoint?.value === "boolean" ? switchPoint.value : null,
    statusAvailable: Boolean(switchPoint),
    checkedAt: new Date().toISOString(),
    source: "Tuya Cloud device status"
  };
}

async function fetchDtekSchedule() {
  const response = await fetch(
    "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages",
    { headers: { "Accept": "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!response.ok) throw new Error(`YASNO schedule request failed: HTTP ${response.status}`);
  const data = await response.json();
  const group = data["29.1"];
  if (!group) throw new Error("Schedule for group 29.1 was not found.");
  return {
    ok: true,
    group: "29.1",
    address: "м. Київ, вул. Академіка Заболотного, 58 (ввід 1)",
    today: group.today || null,
    tomorrow: group.tomorrow || null,
    updatedOn: group.updatedOn || null,
    source: "YASNO public outage schedule"
  };
}


async function fetchDtekAddressStatus(env) {
  const cookie = env.DTEK_SESSION_COOKIE;
  const csrfToken = env.DTEK_CSRF_TOKEN;
  if (!cookie || !csrfToken) {
    return {
      ok: true,
      configured: false,
      address: "м. Київ, вул. Академіка Заболотного, 58 (ввід 1)",
      message: "Адресний запит ДТЕК ще не налаштовано. Потрібні DTEK_SESSION_COOKIE та DTEK_CSRF_TOKEN у Cloudflare Worker Secrets."
    };
  }

  const form = new URLSearchParams();
  form.set("method", "getHomeNum");
  form.set("data[0][name]", "street");
  form.set("data[0][value]", "вул. Заболотного Академіка");
  const kyivNow = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  form.set("data[1][name]", "updateFact");
  form.set("data[1][value]", kyivNow);

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
    throw new Error("ДТЕК повернув не JSON. Можливо, сесія застаріла або сайт показав захист від автоматичних запитів.");
  }

  const hasHouseMap = Boolean(payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data));
  const resultAccepted = payload && (payload.result === true || payload.result === "true" || payload.result === 1);
  if (!payload || !hasHouseMap || (payload.result === false && !hasHouseMap)) {
    const diagnostic = {
      httpStatus: response.status,
      result: payload?.result ?? null,
      resultType: typeof payload?.result,
      hasData: Boolean(payload?.data),
      dataType: Array.isArray(payload?.data) ? "array" : typeof payload?.data,
      topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
      rawLength: rawText.length,
      dtekMessage: String(payload?.text || "").replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim().slice(0, 300)
    };
    throw new Error("Відповідь AJAX ДТЕК не містить списку будинків: " + JSON.stringify(diagnostic));
  }

  const house = payload.data["58"];
  if (!house) {
    throw new Error("У списку ДТЕК немає будинку 58. Перевірте вибрану вулицю.");
  }

  const reason = String(house.sub_type || "").trim();
  const startAt = String(house.start_date || "").trim();
  const expectedEndAt = String(house.end_date || "").trim();
  const outageType = String(house.type || "").trim();
  const groups = Array.isArray(house.sub_type_reason) ? house.sub_type_reason.map(String) : [];
  const active = Boolean(reason || startAt || expectedEndAt || outageType);
  const normalized = reason.toLocaleLowerCase("uk-UA");
  let kind = "none";
  if (active && /(аварійн|екстрен|невідклад)/i.test(normalized)) kind = "emergency";
  else if (active && (outageType === "1" || /планов/i.test(normalized))) kind = "planned";
  else if (active) kind = "other";

  return {
    ok: true,
    configured: true,
    address: "м. Київ, вул. Академіка Заболотного, 58 (ввід 1)",
    houseNumber: "58",
    entrance: "1",
    groups,
    active,
    addressSpecific: active,
    fallbackGroup: !active && groups.includes("GPV29.1") ? "29.1" : null,
    kind,
    reason: reason || (active ? "ДТЕК повідомляє про роботи/відключення без уточненої причини" : ""),
    startAt: startAt || null,
    expectedEndAt: expectedEndAt || null,
    outageType: outageType || null,
    updatedAt: payload.updateTimestamp || null,
    source: "DTEK Kyiv Electric Networks address AJAX"
  };
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
    if (url.pathname === "/api/tuya-status") {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        return json(await fetchTuyaDeviceStatus(env));
      } catch (error) {
        console.error("Tuya device status error:", error);
        return json({ ok: false, error: error.message || "Could not load Tuya device status" }, 502);
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
        return json({ ok: false, error: error.message || "Could not load DTEK address status" }, 502);
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
    ctx.waitUntil(fetchSnapshot(env).then(snapshot => {
      console.log("Deye snapshot refreshed", {
        batteryPercent: snapshot.batteryPercent,
        cacheFetchedAt: snapshot.cacheFetchedAt
      });
    }).catch(error => {
      console.error("Scheduled Deye refresh failed:", error);
    }));
  }
};
