// 作業3: A案のスプライトのうち、地図データと描画コードで一度も使われていないものを探す
const fs = require("fs");
const map = JSON.parse(fs.readFileSync("src/village/map.json", "utf8"));
const va = JSON.parse(fs.readFileSync("src/sprites/variant-a.json", "utf8"));
const render = fs.readFileSync("src/village/render.ts", "utf8");

const used = new Set();
// 地図データで使われているもの
for (const d of map.deco) used.add(d.sprite);
// 描画コードが名前で指定しているもの
for (const m of render.matchAll(/"(grass|grass_alt|path|path_edge_[nse]|fountain|house|hall)"/g)) used.add(m[1]);
if (/\(isHall \? "hall" : "house"\) \+ \(lit \? "_lit" : ""\)/.test(render)) { used.add("house_lit"); used.add("hall_lit"); }
// 人物は状態と色番号から組み立てている
if (/"person_" \+ spot\.p\.state \+ "_" \+ n/.test(render)) {
  for (const st of ["idle", "away", "talking", "resting"]) for (let n = 1; n <= 4; n++) used.add("person_" + st + "_" + n);
}

const all = Object.keys(va.sprites);
const unused = all.filter((k) => !used.has(k));
console.log("A案のスプライト " + all.length + " 枚 / 使用 " + (all.length - unused.length) + " 枚 / 未使用 " + unused.length + " 枚");
if (unused.length) console.log("未使用: " + unused.map((k) => k + (va.labels[k] ? "（" + va.labels[k] + "）" : "")).join(", "));
console.log("--- 装飾の内訳（地図上の出現数）---");
const count = {};
for (const d of map.deco) count[d.sprite] = (count[d.sprite] || 0) + 1;
for (let i = 1; i <= 8; i++) {
  const k = "deco_" + i;
  console.log("  " + k + "（" + va.labels[k] + "）: " + (count[k] || 0) + " 個");
}