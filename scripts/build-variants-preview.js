// public/variants-preview.html を生成する。
// file:// で単体で開けることが要件のため、スプライトと地図を HTML に埋め込む。
// JSON を直したら、このスクリプトを再実行してプレビューを作り直すこと。
const fs = require("fs");
const path = require("path");

const KEYS = ["a", "b", "c"];
const variants = KEYS.map((k) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "sprites", "variant-" + k + ".json"), "utf8")));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "village", "map.json"), "utf8"));

const evaluation = {
  a: { village: "最も村らしい。藁屋根と柵・畑・案山子が生活感を出す", tool: "暖色が強く、長時間の業務画面としてはやや主張が強い" },
  b: { village: "町並みとしては整うが、素朴な村の感じは弱い", tool: "最も違和感がない。彩度が低く、既存の業務画面と並べても浮かない" },
  c: { village: "統一感があり密度も出る。集落として成立している", tool: "落ち着いているが、和の意匠が強く好みが分かれる" },
};

const head = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>tenko 村のバリアント比較</title>
<style>
  body { font-family: sans-serif; background: #f2f0ea; color: #2b2823; margin: 24px; max-width: 1500px; }
  h1 { margin-bottom: 4px; }
  h2 { margin-top: 40px; padding: 6px 10px; background: #e2ded2; border-radius: 4px; }
  h3 { margin-top: 24px; font-size: 15px; color: #4a4437; }
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
  table { border-collapse: collapse; margin: 12px 0 24px; font-size: 13px; }
  th, td { border: 1px solid #c9c3b4; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #e2ded2; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .cell { text-align: center; font-size: 11px; }
  .cell canvas { border: 1px solid #c9c3b4; background: #fff; }
  .cell span { display: block; margin-top: 3px; }
  .scroll { overflow-x: auto; border: 1px solid #c9c3b4; background: #000; }
  .whole { border: 1px solid #c9c3b4; background: #000; display: inline-block; }
  .warn { font-size: 12px; color: #8a4a2f; }
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .sw { width: 84px; font-size: 11px; }
  .sw .chip { height: 32px; border: 1px solid #c9c3b4; }
  .note { font-size: 13px; color: #5a544a; }
</style>
</head>
<body>
<h1>tenko 村のバリアント比較</h1>
<p class="note">元データ: src/sprites/variant-{a,b,c}.json と src/village/map.json。数値を書き換えたら <code>node scripts\\build-variants-preview.js</code> を再実行してください。</p>

<h2>判断材料</h2>
<table>
  <tr><th>案</th><th>世界観</th><th>色数</th><th>装飾</th><th>村らしさ（CC評価）</th><th>業務ツールとしての違和感（CC評価）</th></tr>
  ${variants.map((v) => `<tr>
    <td><strong>${v.meta.variant.toUpperCase()}</strong><br>${v.meta.name}</td>
    <td>${v.meta.description}</td>
    <td>${v.palette.length}色</td>
    <td>${Object.keys(v.labels).length}種<br><span class="note">${Object.values(v.labels).join("・")}</span></td>
    <td>${evaluation[v.meta.variant].village}</td>
    <td>${evaluation[v.meta.variant].tool}</td>
  </tr>`).join("\n")}
</table>
<p class="note"><strong>CCの推し: B（石造りの町）。</strong>tenko は業務中に開いたままにする画面であり、最も長く目に入る。村らしさでは A が勝るが、暖色の面積が大きく疲れやすい。B は彩度が低く、建物と人物のコントラストが最も安定していた。村らしさを優先するなら A、和の意匠が好みなら C。</p>

<h2>スプライトの寸法</h2>
<p class="note">人物 16×16 / 建物 32×32 / 地面 16×16 / 装飾 16×16 / 噴水 32×32。3案とも鍵は同一で、切り替えは定数1つ（src/sprites/index.ts の ACTIVE_VARIANT）。</p>
`;

const script = `
<script>
const MAP = ${JSON.stringify(map)};
const VARIANTS = ${JSON.stringify(variants)};

function mkCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return [cv, ctx];
}
function paint(ctx, V, name, ox, oy, s, flip) {
  const g = V.sprites[name];
  if (!g) return;
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) {
    const c = V.palette[g[y][x]];
    if (!c || c === "transparent") continue;
    const xx = flip ? (g[y].length - 1 - x) : x;
    ctx.fillStyle = c;
    ctx.fillRect(ox + xx * s, oy + y * s, s, s);
  }
}
function spriteCell(V, name, s, label) {
  const g = V.sprites[name];
  const [cv, ctx] = mkCanvas(g[0].length * s, g.length * s);
  paint(ctx, V, name, 0, 0, s, false);
  const d = document.createElement("div");
  d.className = "cell";
  d.appendChild(cv);
  const sp = document.createElement("span");
  sp.textContent = label || name;
  d.appendChild(sp);
  return d;
}
// 村を1枚の絵として描く
function village(V, s) {
  const W = MAP.width * 16 * s, H = MAP.height * 16 * s;
  const [cv, ctx] = mkCanvas(W, H);
  const put = (n, tx, ty, flip) => paint(ctx, V, n, tx * 16 * s, ty * 16 * s, s, flip);
  const putPx = (n, x, y) => paint(ctx, V, n, x * s, y * s, s, false);
  for (let y = 0; y < MAP.height; y++) for (let x = 0; x < MAP.width; x++)
    put(((x * 7 + y * 13) % 5 === 0) ? "grass_alt" : "grass", x, y);
  for (const ry of MAP.roads.h) for (let x = 0; x < MAP.width; x++) { put("path", x, ry); put("path_edge_n", x, ry - 1); put("path_edge_s", x, ry + 1); }
  for (const rx of MAP.roads.v) for (let y = 0; y < MAP.height; y++) { put("path", rx, y); put("path_edge_e", rx - 1, y); put("path_edge_e", rx + 1, y, true); }
  for (const d of MAP.deco) put(d.sprite, d.x, d.y);
  MAP.buildingSlots.forEach((b, i) => {
    const lit = (i === 1 || i === 7 || i === 12);
    const hall = (i % 5 === 4);
    put(hall ? (lit ? "hall_lit" : "hall") : (lit ? "house_lit" : "house"), b.x, b.y);
  });
  put("fountain", MAP.fountain.x, MAP.fountain.y);
  const states = ["idle", "talking", "away", "resting", "idle", "talking", "resting", "away", "idle", "away"];
  states.forEach((st, i) => { const p = MAP.plazaSpots[i]; putPx("person_" + st + "_" + ((i % 4) + 1), p.x, p.y); });
  // 建物の直下にも人を置く（部屋の中にいる人の見え方）
  [[1, "talking", 1], [1, "talking", 2], [7, "talking", 3], [12, "talking", 4], [0, "idle", 2], [4, "away", 1]].forEach(function (t, k) {
    const b = MAP.buildingSlots[t[0]];
    putPx("person_" + t[1] + "_" + t[2], b.x * 16 + (k % 2) * 14 + 2, b.y * 16 + 30);
  });
  return cv;
}

const root = document.getElementById("root");
VARIANTS.forEach((V) => {
  const h2 = document.createElement("h2");
  h2.textContent = "バリアント " + V.meta.variant.toUpperCase() + " : " + V.meta.name;
  root.appendChild(h2);

  const p = document.createElement("p");
  p.className = "note";
  p.textContent = V.meta.description;
  root.appendChild(p);

  const h3z = document.createElement("h3"); h3z.textContent = "村の全体像（2倍。切れずに全体が入る。まずこれを見てください）"; root.appendChild(h3z);
  const w2 = document.createElement("div"); w2.className = "whole"; w2.appendChild(village(V, 2)); root.appendChild(w2);

  const h3a = document.createElement("h3"); h3a.textContent = "村の全体像（実寸の4倍。細部の確認用）"; root.appendChild(h3a);
  const warn = document.createElement("p"); warn.className = "warn";
  warn.textContent = "4倍は " + (MAP.width * 16 * 4) + "px 幅あり、この枠に収まりません。枠の中を横にスクロールして見てください。左端だけを見ると、噴水が右端にあり建物が左に偏っているように見えます（実際は中央と4区画に分散しています）。";
  root.appendChild(warn);
  const w4 = document.createElement("div"); w4.className = "scroll"; w4.appendChild(village(V, 4)); root.appendChild(w4);

  const h3b = document.createElement("h3"); h3b.textContent = "村の全体像（実寸 1倍。実際の画面ではこの大きさで見える）"; root.appendChild(h3b);
  const w1 = document.createElement("div"); w1.className = "whole"; w1.appendChild(village(V, 1)); root.appendChild(w1);

  const h3c = document.createElement("h3"); h3c.textContent = "人物 4状態（8倍）"; root.appendChild(h3c);
  const g1 = document.createElement("div"); g1.className = "grid";
  const stateLabel = { idle: "在席 idle", away: "離席 away", talking: "会話中 talking", resting: "休憩中 resting" };
  [1, 2, 3, 4].forEach((n) => ["idle", "away", "talking", "resting"].forEach((st) =>
    g1.appendChild(spriteCell(V, "person_" + st + "_" + n, 8, stateLabel[st] + " / 色" + n))));
  root.appendChild(g1);

  const h3d = document.createElement("h3"); h3d.textContent = "建物: 通常版と明るい版（8倍）"; root.appendChild(h3d);
  const g2 = document.createElement("div"); g2.className = "grid";
  [["house", "house 通常"], ["house_lit", "house 会話中"], ["hall", "hall 通常"], ["hall_lit", "hall 会話中"]]
    .forEach((t) => g2.appendChild(spriteCell(V, t[0], 8, t[1])));
  root.appendChild(g2);

  const h3e = document.createElement("h3"); h3e.textContent = "地面と装飾物（8倍）"; root.appendChild(h3e);
  const g3 = document.createElement("div"); g3.className = "grid";
  ["grass", "grass_alt", "path", "path_edge_n", "path_edge_s", "path_edge_e", "fountain"].forEach((k) => g3.appendChild(spriteCell(V, k, 8, k)));
  Object.keys(V.labels).forEach((k) => g3.appendChild(spriteCell(V, k, 8, V.labels[k] + " (" + k + ")")));
  root.appendChild(g3);

  const h3f = document.createElement("h3"); h3f.textContent = "パレット（全 " + V.palette.length + " 色）"; root.appendChild(h3f);
  const sw = document.createElement("div"); sw.className = "swatches";
  const use = ["透明", "地面(明)", "地面(暗)・影", "道(明)", "道(暗)", "輪郭・髪・靴", "屋根", "屋根の陰・hallの屋根", "壁", "壁の陰・木部・窓枠", "明かり", "肌", "服D", "服A", "服B・水", "服C"];
  V.palette.forEach((c, i) => {
    const d = document.createElement("div"); d.className = "sw";
    const chip = document.createElement("div"); chip.className = "chip";
    if (c !== "transparent") chip.style.background = c;
    d.appendChild(chip);
    const t1 = document.createElement("div"); t1.textContent = i + " : " + c;
    const t2 = document.createElement("div"); t2.textContent = use[i] || ""; t2.style.color = "#5a544a";
    d.appendChild(t1); d.appendChild(t2);
    sw.appendChild(d);
  });
  root.appendChild(sw);
});
</script>
</body>
</html>
`;

const html = head + '<div id="root"></div>' + script;
const out = path.join(__dirname, "..", "public", "variants-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log("生成: " + out + " / " + Buffer.byteLength(html, "utf8") + " バイト");
