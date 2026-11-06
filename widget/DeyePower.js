// Scriptable widget for iPhone. DeyeCloud data via Netlify.
const API_URL = "https://gentle-maamoul-1fc77c.netlify.app/.netlify/functions/status";

const w = new ListWidget();
w.backgroundColor = new Color("#101722");
w.setPadding(16, 16, 16, 16);

try {
  const req = new Request(API_URL + "?_=" + Date.now());
  req.method = "GET";
  req.timeoutInterval = 10;
  req.headers = { "Cache-Control": "no-cache", "Pragma": "no-cache" };
  const data = await req.loadJSON();

  const title = w.addText("DEYE POWER");
  title.font = Font.boldSystemFont(12);
  title.textColor = new Color("#9BAABD");

  if (!data.configured || data.error) {
    w.addSpacer(10);
    const err = w.addText(data.error || data.message || "Сервер не настроен");
    err.textColor = Color.white();
    err.font = Font.systemFont(12);
  } else {
    w.addSpacer(5);

    const percent = Math.max(0, Math.min(100, Number(data.batteryPercent) || 0));
    const soc = w.addText(Math.round(percent) + "%");
    soc.font = Font.boldSystemFont(38);
    soc.textColor = Color.white();

    const bar = w.addStack();
    bar.size = new Size(200, 8);
    bar.backgroundColor = new Color("#334255");
    bar.cornerRadius = 4;

    const fill = bar.addStack();
    fill.size = new Size(200 * percent / 100, 8);
    fill.backgroundColor = new Color("#57D69A");
    fill.cornerRadius = 4;

    w.addSpacer(12);

    const hours = Number(data.remainingHours);
    const runtimeText = data.remainingHours == null || !Number.isFinite(hours)
      ? "Остаток: —"
      : "Остаток: " + Math.floor(hours) + " ч " +
        Math.round((hours % 1) * 60) + " мин";

    const runtime = w.addText(runtimeText);
    runtime.font = Font.semiboldSystemFont(14);
    runtime.textColor = new Color("#57D69A");

    w.addSpacer(10);

    function row(label, value) {
      const line = w.addStack();
      const l = line.addText(label);
      l.font = Font.systemFont(12);
      l.textColor = new Color("#9BAABD");
      line.addSpacer();
      const v = line.addText(value);
      v.font = Font.semiboldSystemFont(12);
      v.textColor = Color.white();
    }

    row("Нагрузка", Math.round(Number(data.consumptionW) || 0) + " Вт");
    w.addSpacer(5);

    const lastLightText = data.lastGridPowerAt
      ? new Date(Number(data.lastGridPowerAt)).toLocaleString("ru-UA", {
          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
        })
      : "Пока нет данных";
    row("Последний раз был свет", lastLightText);

    w.addSpacer(7);
    const updatedAt = data.cacheFetchedAt
      ? new Date(Number(data.cacheFetchedAt)).toLocaleTimeString("ru-UA", {
          hour: "2-digit", minute: "2-digit"
        })
      : "—";
    const updated = w.addText("Обновлено: " + updatedAt);
    updated.font = Font.systemFont(10);
    updated.textColor = new Color("#9BAABD");
  }
} catch (e) {
  const error = w.addText("ОШИБКА ПОДКЛЮЧЕНИЯ");
  error.textColor = Color.white();
  w.addSpacer(8);
  const details = w.addText(String(e));
  details.textColor = new Color("#FF7777");
  details.font = Font.systemFont(11);
}

// iOS may delay widget refreshes; this requests the earliest practical refresh.
w.refreshAfterDate = new Date(Date.now() + 60 * 1000);

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentMedium();
}
Script.complete();
