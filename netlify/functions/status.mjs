const BASE_URL = process.env.DEYE_BASE_URL || "https://eu1-developer.deyecloud.com";

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
    throw new Error(`station_latest: ${data.msg || `Deye API error (${response.status})`}; HTTP ${response.status}; code ${data.code ?? "n/a"}`);
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

export default async () => {
  try {
    const stationId = process.env.DEYE_STATION_ID;
    if (!stationId) {
      return json({
        configured: false,
        message: "Add DEYE_STATION_ID in Netlify environment variables after we identify your station."
      });
    }

    const token = await getToken();
    const raw = await deyeRequest("station/latest", token, {
      stationId: Number(stationId)
    });

    const soc = Number(raw.batterySOC ?? 0);
    const batteryPower = Number(raw.batteryPower ?? 0);
    const dischargeW = Math.max(0, Number(raw.dischargePower ?? 0));
    const capacityKwh = Number(process.env.BATTERY_CAPACITY_KWH || 5.12);
    const reservePercent = Number(process.env.BATTERY_RESERVE_PERCENT || 10);
    const usableKwh = Math.max(0, capacityKwh * (soc - reservePercent) / 100);
    const remainingHours = dischargeW > 30 ? usableKwh * 1000 / dischargeW : null;

    return json({
      configured: true,
      updatedAt: raw.lastUpdateTime
        ? new Date(Number(raw.lastUpdateTime) * 1000).toISOString()
        : new Date().toISOString(),
      batteryPercent: soc,
      generationW: Number(raw.generationPower ?? 0),
      consumptionW: Number(raw.consumptionPower ?? 0),
      gridW: raw.gridPower == null ? null : Number(raw.gridPower),
      batteryW: batteryPower,
      dischargeW,
      remainingHours,
      capacityKwh,
      reservePercent
    });
  } catch (error) {
    return json({ error: error.message || "Unknown server error" }, 500);
  }
};
