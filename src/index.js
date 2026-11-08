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
      gridPresent: Number.isFinite(voltage) && voltage >= 180 &&
        Number.isFinite(frequency) && frequency >= 45 && frequency <= 55
    };
  }).filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
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
  const chargeW = Math.max(0, Number(raw.chargePower ?? 0));
  const capacityKwh = Number(env.BATTERY_CAPACITY_KWH || 5.12);
  const reservePercent = Number(env.BATTERY_RESERVE_PERCENT || 10);
  const usableKwh = Math.max(0, capacityKwh * (soc - reservePercent) / 100);
  const remainingHours = dischargeW > 30 ? usableKwh * 1000 / dischargeW : null;
  const chargeHours = chargeW > 30 && soc < 100
    ? capacityKwh * (100 - soc) / 100 * 1000 / chargeW
    : null;
  const fetchedAt = Date.now();

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
    remainingHours,
    capacityKwh,
    reservePercent,
    cacheFetchedAt: fetchedAt
  };

  await saveSnapshot(env, snapshot);
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
          DEYE_DEVICE_SN: Boolean(env.DEYE_DEVICE_SN)
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
