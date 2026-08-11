// 開発用の精度測定。製品には組み込まない。
// src からは参照されない。このファイルと eval-cases.json を消しても本番の動作は変わらない。
//
// 実行: node scripts\eval-detect.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { detect, KIND_LABEL } = await import(pathToFileURL(join(here, "..", "src", "lib", "attendance.ts")).href);
const data = JSON.parse(readFileSync(join(here, "eval-cases.json"), "utf8"));

// 時刻を固定して測る（実行時刻で結果が変わらないようにする）
const NOW = new Date("2026-08-11T09:20:00+09:00");
process.env.TENKO_WORK_START = process.env.TENKO_WORK_START ?? "09:00";

const kinds = ["arrive", "leave", "break", "late"];
const stat = { shouldDetect: 0, detected: 0, shouldNot: 0, falsePositive: 0 };
const perKind = {};
for (const k of kinds) perKind[k] = { total: 0, ok: 0, wrongKind: 0, missed: 0 };
const misses = [];

for (const c of data.cases) {
  const got = detect(c.text, NOW);
  const gotKind = got ? got.kind : null;
  if (c.expect) {
    stat.shouldDetect++;
    perKind[c.expect].total++;
    if (gotKind === c.expect) { stat.detected++; perKind[c.expect].ok++; }
    else if (gotKind) { perKind[c.expect].wrongKind++; misses.push({ text: c.text, expect: c.expect, got: gotKind, rule: got.ruleId, why: "種別違い", boundary: c.boundary }); }
    else { perKind[c.expect].missed++; misses.push({ text: c.text, expect: c.expect, got: null, rule: null, why: "検出漏れ", boundary: c.boundary }); }
  } else {
    stat.shouldNot++;
    if (gotKind) { stat.falsePositive++; misses.push({ text: c.text, expect: null, got: gotKind, rule: got.ruleId, why: "誤検出", boundary: c.boundary }); }
  }
}

const pct = (a, b) => (b === 0 ? "-" : ((a / b) * 100).toFixed(1) + "%");
console.log("=== tenko 勤怠検出の精度（開発用。製品には組み込まない）===");
console.log("評価データ: " + data.cases.length + " 件（検出すべき " + stat.shouldDetect + " / すべきでない " + stat.shouldNot + "）");
console.log("基準時刻: " + NOW.toISOString() + " / 始業 " + process.env.TENKO_WORK_START);
console.log("");
console.log("検出できた件数 : " + stat.detected + " / " + stat.shouldDetect + "  (" + pct(stat.detected, stat.shouldDetect) + ")");
console.log("誤検出した件数 : " + stat.falsePositive + " / " + stat.shouldNot + "  (" + pct(stat.falsePositive, stat.shouldNot) + ")");
console.log("");
console.log("種別ごとの内訳:");
console.log("  種別      対象  正解  種別違い  検出漏れ");
for (const k of kinds) {
  const p = perKind[k];
  console.log("  " + (KIND_LABEL[k] + "      ").slice(0, 6) + String(p.total).padStart(4) + String(p.ok).padStart(6) + String(p.wrongKind).padStart(9) + String(p.missed).padStart(10));
}
console.log("");
if (misses.length === 0) {
  console.log("外れた事例: なし");
} else {
  console.log("外れた事例 " + misses.length + " 件:");
  for (const m of misses) {
    console.log("  [" + m.why + "] 「" + m.text + "」");
    console.log("      正解=" + (m.expect ? KIND_LABEL[m.expect] : "検出しない") + " / 実際=" + (m.got ? KIND_LABEL[m.got] + "(" + m.rule + ")" : "検出せず"));
    if (m.boundary) console.log("      境界例の意図: " + m.boundary);
  }
}
console.log("");
console.log("注: この数値は自分で作った評価データに対するものであり、実運用の精度を保証しない。");
