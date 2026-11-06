import { getStore } from "@netlify/blobs";
const BASE_URL = process.env.DEYE_BASE_URL || "https://eu1-developer.deyecloud.com";
const CACHE_STORE = getStore("deye-widget-cache", { region: "eu-central-1" });
const CACHE_KEY = "latest";
const CACHE_MAX_AGE_MS = 4 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  }
});

async function deyeRequest(path, token, body) {
  const response = await fetch(`${BASE_URL}/v1.0/${path}`, {
    method: "POST",
    headers: {
      "Authorization": token.startsWith("Bearer ") ? token : `Bearer ${token}`,
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

async function getToken() {
  const appId = process.env.DEYE_APP_ID;
  const appSecret = process.env.DEYE_APP_SECRET;
  const email = process.env.DEYE_EMAIL;
  const password = process.env.DEYE_PASSWORD;
  if (!appId || !appSecret || !email || !password) {
    throw new Error("Add DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL and DEYE_PASSWORD in Netlify environment variables.");
  }

  const passwordHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password)
  );
  const hash = [...new Uint8Array(passwordHash)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  const url = new URL(`${BASE_URL}/v1.0/account/token`);
  url.searchParams.set("appId", appId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appSecret, email, password: hash })
  });
  const data = await response.json();
  if (!response.ok || data.success === false || !data.accessToken) {
    throw new Error(`account_token: ${data.msg || "DeyeCloud authorization failed."}; HTTP ${response.status}; code ${data.code ?? "n/a"}`);
  }
  return data.accessToken;
}

async function getStationLatest(token, stationId) {
  return deyeRequest("station/latest", token, { stationId: Number(stationId) });
}

async function getStationHistoryPower(token, stationId) {
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - 24 * 60 * 60;
  return deyeRequest("station/history/power", token, {
    stationId: Number(stationId),
    startTimestamp,
    endTimestamp
  });
}

async function runPermissionDiagnostic(stationId) {
  // First token: verify authentication and station-list access.
  const firstToken = await getToken();
  const list = await deyeRequest("station/list", firstToken, { page: 1, size: 50 });
  const stations = list.stationList || [];
  const station = stations.find(item => String(item.id) === String(stationId)) || null;
  const stationFound = Boolean(station);

  try {
    const latest = await getStationLatest(firstToken, stationId);
    const now = Math.floor(Date.now() / 1000);
    let stationAlerts;
    try {
      const alerts = await deyeRequest("station/alert", firstToken, {
        stationId: Number(stationId),
        startTimestamp: now - 7 * 24 * 60 * 60,
        endTimestamp: now,
        page: 1,
        size: 50
      });
      stationAlerts = {
        accessible: true,
        total: alerts.total ?? (alerts.stationAlertItems || []).length,
        items: (alerts.stationAlertItems || []).slice(0, 10)
      };
    } catch (alertError) {
      stationAlerts = { accessible: false, error: alertError.message };
    }
    let stationDevices;
    try {
      const devices = await deyeRequest("station/device", firstToken, {
        stationIds: [Number(stationId)],
        page: 1,
        size: 20
      });
      stationDevices = {
        accessible: true,
        total: devices.total ?? (devices.deviceListItems || []).length,
        items: (devices.deviceListItems || []).map(device => ({
          deviceSn: device.deviceSn,
          deviceType: device.deviceType,
          connectStatus: device.connectStatus
        }))
      };
    } catch (deviceError) {
      stationDevices = { accessible: false, error: deviceError.message };
    }
    let historyPower;
    try {
      const history = await getStationHistoryPower(firstToken, stationId);
      historyPower = {
        accessible: true,
        total: history.total ?? (history.stationDataItems || []).length,
        samples: (history.stationDataItems || []).slice(-5)
      };
    } catch (historyError) {
      historyPower = { accessible: false, error: historyError.message };
    }
    return {
      diagnostic: true,
      token: "valid",
      stationList: "accessible",
      stationFound,
      stationStatus: station ? {
        connectionStatus: station.connectionStatus,
        lastUpdateTime: station.lastUpdateTime
      } : null,
      stationLatest: "accessible",
      latestData: latest,
      stationAlerts,
      stationDevices,
      historyPower
    };
  } catch (firstError) {
    // Explicitly obtain a second, newly issued token and retry the same API call.
    const secondToken = await getToken();
    try {
      const latest = await getStationLatest(secondToken, stationId);
      let historyPower;
      try {
        const history = await getStationHistoryPower(secondToken, stationId);
        historyPower = {
          accessible: true,
          total: history.total ?? (history.stationDataItems || []).length,
          samples: (history.stationDataItems || []).slice(-5)
        };
      } catch (historyError) {
        historyPower = { accessible: false, error: historyError.message };
      }
      return {
        diagnostic: true,
        token: "fresh token issued",
        stationList: "accessible",
        stationFound,
        firstAttempt: firstError.message,
        stationLatest: "accessible after fresh-token retry",
        latestData: latest,
        historyPower
      };
    } catch (secondError) {
      return {
        diagnostic: true,
        token: "two fresh tokens issued successfully",
        stationList: "accessible",
        stationFound,
        firstAttempt: firstError.message,
        secondAttempt: secondError.message,
        stationLatest: "denied",
        conclusion: "Authentication and station-list access work, but station/latest is denied even with a newly issued token. This points to an endpoint/account/application permission restriction on the Deye side."
      };
    }
  }
}

export default async (request) => {
  try {
    const requestUrl = new URL(request.url);
    const stationId = process.env.DEYE_STATION_ID;
    const isScheduledRefresh =
      request.headers.get("x-internal-refresh") === process.env.DEYE_APP_SECRET &&
      Boolean(process.env.DEYE_APP_SECRET);
    const forceRefresh = requestUrl.searchParams.get("refresh") === "1" && isScheduledRefresh;

    // Serve the latest scheduled snapshot to the widget; do not call Deye on every iPhone refresh.
    const previousSnapshot = await CACHE_STORE.get(CACHE_KEY, { type: "json", consistency: "strong" });

    if (!forceRefresh && requestUrl.searchParams.get("discover") !== "1" &&
        requestUrl.searchParams.get("diagnose") !== "1") {
      if (previousSnapshot && previousSnapshot.cacheFetchedAt &&
          Date.now() - Number(previousSnapshot.cacheFetchedAt) < CACHE_MAX_AGE_MS) {
        return json({ ...previousSnapshot, cacheAgeSeconds: Math.floor((Date.now() - Number(previousSnapshot.cacheFetchedAt)) / 1000) });
      }
    }

    if (requestUrl.searchParams.get("discover") === "1") {
      const token = await getToken();
      const result = await deyeRequest("station/list", token, { page: 1, size: 50 });
      const stations = (result.stationList || []).map(station => ({
        id: station.id,
        name: station.name,
        installedCapacity: station.installedCapacity,
        connectionStatus: station.connectionStatus
      }));
      return json({ discovered: true, total: result.total ?? stations.length, stations });
    }

    if (!stationId) {
      return json({
        configured: false,
        message: "Add DEYE_STATION_ID in Netlify environment variables after we identify your station."
      });
    }

    if (requestUrl.searchParams.get("diagnose") === "1") {
      return json(await runPermissionDiagnostic(stationId));
    }

    // Fetch from Deye only when the cache is empty/stale or an authenticated scheduled refresh is requested.
    const token = await getToken();
    const raw = await getStationLatest(token, stationId);

    const soc = Number(raw.batterySOC ?? 0);
    const batteryPower = Number(raw.batteryPower ?? 0);
    const dischargeW = Math.max(0, Number(raw.dischargePower ?? 0));
    const capacityKwh = Number(process.env.BATTERY_CAPACITY_KWH || 5.12);
    const reservePercent = Number(process.env.BATTERY_RESERVE_PERCENT || 10);
    const usableKwh = Math.max(0, capacityKwh * (soc - reservePercent) / 100);
    const remainingHours = dischargeW > 30 ? usableKwh * 1000 / dischargeW : null;
    const fetchedAt = Date.now();
    const gridPowerValue = raw.gridPower == null ? null : Number(raw.gridPower);
    // Record the latest moment when measurable grid power was present.
    // If DeyeCloud omits gridPower (null), keep the last known timestamp.
    const lastGridPowerAt = gridPowerValue != null && Number.isFinite(gridPowerValue) &&
      Math.abs(gridPowerValue) > 20
        ? fetchedAt
        : (previousSnapshot?.lastGridPowerAt ?? null);

    const snapshot = {
      configured: true,
      updatedAt: raw.lastUpdateTime
        ? new Date(Number(raw.lastUpdateTime) * 1000).toISOString()
        : new Date().toISOString(),
      batteryPercent: soc,
      generationW: Number(raw.generationPower ?? 0),
      consumptionW: Number(raw.consumptionPower ?? 0),
      gridW: gridPowerValue,
      lastGridPowerAt,
      batteryW: batteryPower,
      dischargeW,
      remainingHours,
      capacityKwh,
      reservePercent,
      cacheFetchedAt: fetchedAt
    };
    await CACHE_STORE.setJSON(CACHE_KEY, snapshot);
    return json({ ...snapshot, cacheAgeSeconds: 0 });
  } catch (error) {
    return json({ error: error.message || "Unknown server error" }, 500);
  }
};
