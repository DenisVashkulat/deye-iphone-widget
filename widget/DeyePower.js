// Scriptable widget for iPhone. DeyeCloud data via Netlify.
const API_URL = "https://gentle-maamoul-1fc77c.netlify.app/.netlify/functions/status";
const req = new Request(API_URL);
req.timeoutInterval = 20;
const data = await req.loadJSON();

const w = new ListWidget();
w.backgroundColor = new Color("#101722");
w.setPadding(14, 16, 14, 16);

const title = w.addText("DEYE POWER");
title.font = Font.boldSystemFont(11);
title.textColor = new Color("#9BAABD");

if (data.error || !data.configured) {
  w.addSpacer(8);
  const msg = w.addText(data.error || data.message || "Нет данных");
  msg.textColor = Color.white();
  msg.font = Font.systemFont(13);
} else {
  w.addSpacer(5);
  const soc = w.addText(Math.round(data.batteryPercent) + "%");
  soc.font = Font.boldSystemFont(36);
  soc.textColor = Color.white();

  const bar = w.addProgressBar();
  bar.progress = Math.max(0, Math.min(1, data.batteryPercent / 100));
  bar.backgroundColor = new Color("#334255");
  bar.tintColor = new Color("#57D69A");
  w.addSpacer(8);

  const runtime = data.remainingHours == null
    ? "Остаток: —"
    : "Остаток: " + Math.floor(data.remainingHours) + " ч " +
      Math.round((data.remainingHours % 1) * 60) + " мин";
  const rt = w.addText(runtime);
  rt.font = Font.semiboldSystemFont(13);
  rt.textColor = new Color("#57D69A");
  w.addSpacer(8);

  const row = (label, value) => {
    const line = w.addStack();
    const l = line.addText(label);
    l.font = Font.systemFont(11);
    l.textColor = new Color("#9BAABD");
    line.addSpacer();
    const v = line.addText(value);
    v.font = Font.semiboldSystemFont(12);
    v.textColor = Color.white();
  };
  row("Нагрузка", Math.round(data.consumptionW) + " Вт");
  w.addSpacer(4);
  row("Солнце", Math.round(data.generationW) + " Вт");
  w.addSpacer(4);
  row("Сеть", data.gridW == null ? "нет данных" : Math.round(data.gridW) + " Вт");
}
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
Script.setWidget(w);
Script.complete();
