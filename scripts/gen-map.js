// src/village/map.json を生成する。村の地図はデータとして持ち、コードにベタ書きしない。
// 装飾物は道・建物・広場・噴水を避けて決定的に配置する（乱数の種を固定）。
const fs = require("fs");
const path = require("path");

const W = 40, H = 26;
const ROAD_H = [13], ROAD_V = [20];
const FOUNTAIN = { x: 19, y: 12 };            // 32x32 なので 2x2 タイルを占める
const PLAZA = { x: 15, y: 15, w: 11, h: 8 };  // 噴水の周り。どの部屋にも入っていない人が立つ
const SLOTS = [
  { x: 2, y: 2 }, { x: 6, y: 2 }, { x: 10, y: 2 }, { x: 25, y: 2 }, { x: 29, y: 2 }, { x: 33, y: 2 },
  { x: 2, y: 7 }, { x: 6, y: 7 }, { x: 33, y: 7 }, { x: 37, y: 7 },
  { x: 2, y: 17 }, { x: 6, y: 17 }, { x: 10, y: 17 }, { x: 29, y: 17 }, { x: 33, y: 17 }, { x: 37, y: 17 },
  { x: 2, y: 22 }, { x: 6, y: 22 }, { x: 30, y: 22 }, { x: 34, y: 22 },
  // 交差点寄りの枠。村は密集しているから村に見えるため、中央付近にも建物を置く
  { x: 14, y: 5 }, { x: 24, y: 5 }, { x: 16, y: 9 }, { x: 23, y: 9 }, { x: 14, y: 23 }, { x: 24, y: 23 },
];

// 建物は部屋の並び順に枠を使うため、枠の並びが左上→右上の順だと
// 部屋が少ないうちは建物が左上に固まる（本番の描画で実測して気づいた）。
// 4つの区画を順ぐりに使うよう並べ替える。これで部屋が4件あれば各区画に1棟、8件で2棟ずつになる。
(function interleaveSlots() {
  const cx = ROAD_V[0], cy = ROAD_H[0];
  const q = [[], [], [], []];   // 左上 / 右上 / 左下 / 右下
  for (const s of SLOTS) q[(s.x < cx ? 0 : 1) + (s.y < cy ? 0 : 2)].push(s);
  const out = [];
  for (let i = 0; out.length < SLOTS.length; i++) {
    for (const arr of q) if (arr[i]) out.push(arr[i]);
  }
  SLOTS.length = 0;
  for (const s of out) SLOTS.push(s);
})();

const blocked = new Set();
const block = (x, y) => blocked.add(x + "," + y);
for (const ry of ROAD_H) for (let x = 0; x < W; x++) for (let d = -1; d <= 1; d++) block(x, ry + d);
for (const rx of ROAD_V) for (let y = 0; y < H; y++) for (let d = -1; d <= 1; d++) block(rx + d, y);
for (const s of SLOTS) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) block(s.x + dx, s.y + dy);
for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) block(FOUNTAIN.x + dx, FOUNTAIN.y + dy);
for (let y = PLAZA.y; y < PLAZA.y + PLAZA.h; y++) for (let x = PLAZA.x; x < PLAZA.x + PLAZA.w; x++) block(x, y);

let s = 20260811;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

// 装飾は道沿いと建物の周りに寄せると村らしくなる。完全な一様分布にはしない
const weightAt = (x, y) => {
  let w = 0.06;
  for (const ry of ROAD_H) if (Math.abs(y - ry) <= 3) w += 0.34;
  for (const rx of ROAD_V) if (Math.abs(x - rx) <= 3) w += 0.34;
  for (const sl of SLOTS) if (Math.abs(x - sl.x) <= 3 && Math.abs(y - sl.y) <= 3) w += 0.42;
  if (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2) w += 0.30;   // 村の外周は木を並べて縁取る
  return Math.min(w, 0.9);
};
const kinds = ["deco_1", "deco_2", "deco_3", "deco_4", "deco_5", "deco_6", "deco_7", "deco_8"];
const weightsByKind = [30, 24, 12, 3, 6, 7, 9, 6];   // 木と低木を多めに
const pick = () => {
  const total = weightsByKind.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < kinds.length; i++) { r -= weightsByKind[i]; if (r <= 0) return kinds[i]; }
  return kinds[0];
};

const deco = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (blocked.has(x + "," + y)) continue;
  if (rnd() < weightAt(x, y)) deco.push({ sprite: pick(), x, y });
}

// 広場に立つ人の位置（ピクセル単位）。重なったら横にずらすのは描画側で行う
const plazaSpots = [];
for (let i = 0; i < 24; i++) {
  const col = i % 8, row = Math.floor(i / 8);
  plazaSpots.push({ x: (PLAZA.x + 1) * 16 + col * 20, y: (PLAZA.y + 1) * 16 + row * 22 });
}

const map = {
  width: W, height: H, tile: 16,
  roads: { h: ROAD_H, v: ROAD_V },
  fountain: FOUNTAIN,
  plaza: PLAZA,
  buildingSlots: SLOTS,
  plazaSpots,
  deco,
};

const out = path.join(__dirname, "..", "src", "village", "map.json");
fs.writeFileSync(out, JSON.stringify(map, null, 1).replace(/\n\s+"x"/g, ' "x"').replace(/,\n\s+"y": (\d+)\n\s+\}/g, ', "y": $1 }'), "utf8");
console.log("地図を生成: " + W + "x" + H + " タイル / 建物の枠 " + SLOTS.length + " / 装飾 " + deco.length + " 個 / 広場の位置 " + plazaSpots.length);
