import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const { detect } = await import(pathToFileURL(join(here, "..", "src", "lib", "attendance.ts")).href);
const NOW = new Date("2026-08-11T09:20:00+09:00");
for (const t of ["おはようございます", "遅れませんでした", "10時に着きます", "30分ほど遅れます", "おはようございます、10時に着きます", "昼休憩入ります", "お疲れ様でした"]) {
  const d = detect(t, NOW);
  console.log("「" + t + "」-> " + (d ? d.kind + " / " + d.eventAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) + " / " + d.ruleId + " / 時刻の出所=" + d.timeSource : "検出せず"));
}