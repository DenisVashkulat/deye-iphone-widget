// Scheduled DeyeCloud poller: fetch one fresh snapshot every two minutes.
export const config = {
  schedule: "*/2 * * * *"
};

export default async () => {
  const siteUrl = process.env.URL;
  const appSecret = process.env.DEYE_APP_SECRET;

  if (!siteUrl || !appSecret) {
    throw new Error("Missing Netlify URL or DEYE_APP_SECRET environment variable.");
  }

  const response = await fetch(
    `${siteUrl}/.netlify/functions/status?refresh=1`,
    {
      method: "GET",
      headers: { "x-internal-refresh": appSecret },
      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await response.json();
  if (!response.ok || data.error || !data.configured) {
    throw new Error(data.error || `Deye refresh failed with HTTP ${response.status}`);
  }

  console.log("Deye snapshot refreshed", {
    batteryPercent: data.batteryPercent,
    updatedAt: data.updatedAt,
    cacheFetchedAt: data.cacheFetchedAt
  });
};
