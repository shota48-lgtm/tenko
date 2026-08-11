// public/sprites-preview.html を生成する。
//
// file:// で直接開けることが要件のため、fetch でJSONを読む形にはできない
// （ブラウザがローカルファイルへの fetch を拒否する）。
// sprites.json の中身をHTMLに埋め込んで出力する。
// JSON を書き換えたら、このスクリプトを再実行してプレビューを作り直すこと。
const fs = require("fs");
const path = require("path");

const jsonPath = path.join(__dirname, "..", "src", "sprites", "sprites.json");
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const names = Object.keys(data.sprites);

const scene = `
  <p class="note">草地の上に建物2種・噴水・人物を並べた配置例（実寸の4倍）。実装時の見え方の目安です。</p>
  <div id="scene"></div>
`;

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>tenko スプライト確認</title>
<style>
  body { font-family: sans-serif; background: #f4f2ec; color: #2b2823; margin: 24px; }
  h2 { margin-top: 32px; border-bottom: 1px solid #ccc7ba; padding-bottom: 4px; }
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; }
  .grid { display: flex; flex-wrap: wrap; gap: 20px; }
  .cell { text-align: center; }
  .cell canvas { background: #ffffff; border: 1px solid #ccc7ba; display: block; }
  .cell span { display: block; font-size: 12px; margin-top: 4px; }
  .row3 { display: flex; gap: 32px; align-items: flex-end; margin-bottom: 20px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 12px; }
  .sw { width: 96px; font-size: 12px; }
  .sw .chip { height: 40px; border: 1px solid #ccc7ba;
    background-image: linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%),
                      linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%);
    background-size: 12px 12px; background-position: 0 0, 6px 6px; }
  .note { font-size: 13px; color: #5a544a; }
  #scene canvas { border: 1px solid #ccc7ba; }
</style>
</head>
<body>
<h1>tenko スプライト確認</h1>
<p class="note">元データ: src/sprites/sprites.json。数値を書き換えたら scripts/build-sprites-preview.js を再実行してください。</p>

<h2>1. 人物の3状態（状態ごとの見分け）</h2>
<div id="states"></div>

<h2>2. 全スプライト（8倍）</h2>
<div class="grid" id="all"></div>

<h2>3. 配置例</h2>
${scene}

<h2>4. パレット（全 ${Object.keys(data.palette).length} 色）</h2>
<div class="swatches" id="palette"></div>

<script>
const DATA = ${JSON.stringify(data)};

function draw(name, scale) {
  const g = DATA.sprites[name];
  const cv = document.createElement("canvas");
  cv.width = g[0].length * scale;
  cv.height = g.length * scale;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[y].length; x++) {
      const c = DATA.palette[String(g[y][x])];
      if (!c || c === "transparent") continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return cv;
}

function cell(name, scale) {
  const d = document.createElement("div");
  d.className = "cell";
  d.appendChild(draw(name, scale));
  const s = document.createElement("span");
  s.textContent = name;
  d.appendChild(s);
  return d;
}

// 1. 3状態を色ごとに横並び
const states = document.getElementById("states");
for (const n of ["1", "2", "3", "4"]) {
  const row = document.createElement("div");
  row.className = "row3";
  for (const st of ["idle", "away", "talking"]) row.appendChild(cell("person_" + st + "_" + n, 8));
  states.appendChild(row);
}

// 2. 全スプライト
const all = document.getElementById("all");
for (const n of ${JSON.stringify(names)}) all.appendChild(cell(n, 8));

// 3. 配置例
(function () {
  const S = 4, W = 24, H = 16;   // 24x16 タイル
  const cv = document.createElement("canvas");
  cv.width = W * 16 * S; cv.height = H * 16 * S;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const put = (name, tx, ty) => {
    const g = DATA.sprites[name];
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) {
      const c = DATA.palette[String(g[y][x])];
      if (!c || c === "transparent") continue;
      ctx.fillStyle = c;
      ctx.fillRect((tx * 16 + x) * S, (ty * 16 + y) * S, S, S);
    }
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put("grass", x, y);
  // 広場を横切る道
  for (let x = 0; x < W; x++) put("path", x, 8);
  for (let y = 0; y < H; y++) put("path", 11, y);
  // 噴水（32x32 = 2x2 タイル）を道の交点に置く
  put("fountain", 11, 8);
  // 建物
  put("house", 3, 3); put("house", 6, 3); put("house", 17, 3);
  put("hall", 3, 12); put("hall", 18, 12);
  // 人物（建物の中＝会話中 / 広場＝在席 / 端＝離席）
  put("person_talking_1", 3, 5); put("person_talking_2", 6, 5);
  put("person_idle_3", 9, 9); put("person_idle_4", 14, 7);
  put("person_away_1", 21, 9); put("person_idle_2", 17, 5);
  document.getElementById("scene").appendChild(cv);
})();

// 4. パレット
const pal = document.getElementById("palette");
const uses = ${JSON.stringify({
  "0": "透明",
  "1": "草地（明）",
  "2": "草地（暗）・草の模様",
  "3": "道",
  "4": "水面・噴水の水",
  "5": "輪郭・屋根の縁・ズボン・入口",
  "6": "house の屋根",
  "7": "hall の屋根",
  "8": "壁・石（噴水の縁と柱）",
  "9": "肌",
  "10": "髪・靴",
  "11": "服A",
  "12": "服B",
  "13": "服C",
  "14": "服D",
  "15": "ハイライト・吹き出し・水しぶき",
})};
for (const [k, v] of Object.entries(DATA.palette)) {
  const d = document.createElement("div");
  d.className = "sw";
  const chip = document.createElement("div");
  chip.className = "chip";
  if (v !== "transparent") chip.style.background = v;
  d.appendChild(chip);
  const t = document.createElement("div");
  t.textContent = k + " : " + v;
  const u = document.createElement("div");
  u.textContent = uses[k] || "";
  u.style.color = "#5a544a";
  d.appendChild(t); d.appendChild(u);
  pal.appendChild(d);
}
</script>
</body>
</html>
`;

const out = path.join(__dirname, "..", "public", "sprites-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log("生成しました: " + out);
console.log("スプライト " + names.length + " 枚 / パレット " + Object.keys(data.palette).length + " 色 / " + Buffer.byteLength(html, "utf8") + " バイト");