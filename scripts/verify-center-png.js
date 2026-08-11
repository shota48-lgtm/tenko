/* 村の中心の検証。
   本番の描画コード（コンパイルした render.js）で地面だけを描き、
   画素を数えて「道の中心」「噴水の中心」が村の中心と一致するかを確かめる。
   実行: node scripts\verify-center-png.js <compiled dir の親> */
const fs = require("fs");
const zlib = require("zlib");
const out = process.argv[2] || require("os").tmpdir() + "/tenko-center";
const R = require(out + "/compiled/render.js");
const sheet = JSON.parse(fs.readFileSync("src/sprites/variant-a.json", "utf8"));

function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, b) { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); const ty = Buffer.from(t, "ascii"); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([ty, b]))); return Buffer.concat([l, ty, b, c]); }
function writePng(f, w, h, rgb) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); } const i = Buffer.alloc(13); i.writeUInt32BE(w, 0); i.writeUInt32BE(h, 4); i[8] = 8; i[9] = 2; fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", i), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])); }

const W = R.VILLAGE_W, H = R.VILLAGE_H;
const buf = Buffer.alloc(W * H * 3);
let cur = [0, 0, 0];
const ctx = {
  imageSmoothingEnabled: true,
  set fillStyle(v) { cur = v === "transparent" ? null : [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)]; },
  get fillStyle() { return ""; },
  fillRect(x, y, w, h) { if (!cur) return; for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) { const px = Math.round(x) + dx, py = Math.round(y) + dy; if (px < 0 || py < 0 || px >= W || py >= H) continue; const i = (py * W + px) * 3; buf[i] = cur[0]; buf[i + 1] = cur[1]; buf[i + 2] = cur[2]; } },
  clearRect() {}, save() {}, restore() {}, beginPath() {}, ellipse() {}, stroke() {}, strokeRect() {}, setLineDash() {},
  set strokeStyle(v) {}, get strokeStyle() { return ""; },
  set lineWidth(v) {}, get lineWidth() { return 0; },
  set globalAlpha(v) {}, get globalAlpha() { return 1; },
};

// 地面だけ（装飾を馴染ませる処理は入れない。色で道を数えるため）
R.drawGround(ctx, sheet, false);
writePng(out + "/center-ground.png", W, H, buf);

const px = (x, y) => { const i = (y * W + x) * 3; return "#" + [buf[i], buf[i + 1], buf[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""); };
const PATH = sheet.palette[3];       // 道の色
const PATH_D = sheet.palette[4];     // 道の濃い色
const isPath = (c) => c === PATH || c === PATH_D;

const cx = W / 2, cy = H / 2;
console.log(`村: ${W}x${H} / 中心 (${cx},${cy})`);
console.log(`PNG: ${out}/center-ground.png`);
console.log("");

// 村の上端の行を横に走査して、縦の道の範囲を出す（建物や広場の影響を受けない位置）
// 道と同じ色は柵や木箱などの装飾にも使われている。
// 色だけで拾うと装飾まで混ざるため、**連続している一番長い帯**を道とみなす
function longestRun(get, n) {
  let best = { from: -1, to: -1, len: 0 };
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const hit = i < n && get(i);
    if (hit && from < 0) from = i;
    if (!hit && from >= 0) {
      if (i - from > best.len) best = { from, to: i, len: i - from };
      from = -1;
    }
  }
  return best;
}

// 縦の道は村の上から下まで続く。1行だけを見ると同じ色の装飾と区別できないため、
// 「その列が縦にどれだけ道の色で埋まっているか」を数え、半分を超える列の連なりを道とする
const colFill = [];
for (let x = 0; x < W; x++) {
  let n = 0;
  for (let y = 0; y < H; y++) if (isPath(px(x, y))) n++;
  colFill.push(n);
}
const rowRun = longestRun((x) => colFill[x] > H * 0.5, W);
const left = rowRun.from, right = rowRun.to;
console.log(`縦の道（y=8 の行を走査）: x = ${left}..${right} / 幅 ${right - left} / 中心 ${(left + right) / 2}`);
console.log(`  左の草地 ${left} / 右の草地 ${W - right} / 差 ${left - (W - right)}`);
console.log(`  村の中心とのずれ: ${(left + right) / 2 - cx}`);

// 横の道も同じ考え方。行が横にどれだけ道の色で埋まっているかを数える
const rowFill = [];
for (let y = 0; y < H; y++) {
  let n = 0;
  for (let x = 0; x < W; x++) if (isPath(px(x, y))) n++;
  rowFill.push(n);
}
const colRun = longestRun((y) => rowFill[y] > W * 0.5, H);
const top = colRun.from, bottom = colRun.to;
console.log(`横の道（x=8 の列を走査）: y = ${top}..${bottom} / 幅 ${bottom - top} / 中心 ${(top + bottom) / 2}`);
console.log(`  上の草地 ${top} / 下の草地 ${H - bottom} / 差 ${top - (H - bottom)}`);
console.log(`  村の中心とのずれ: ${(top + bottom) / 2 - cy}`);

// 噴水は drawVillage 側で描く。座標だけを確かめる
const m = require("../src/village/map.json");
const fx = m.fountain.x * m.tile, fy = m.fountain.y * m.tile;
console.log("");
console.log(`噴水: 左上 (${fx},${fy}) / 中心 (${fx + 16},${fy + 16}) / 村の中心とのずれ (${fx + 16 - cx},${fy + 16 - cy})`);

const ok = (left + right) / 2 === cx && (top + bottom) / 2 === cy && fx + 16 === cx && fy + 16 === cy;
console.log("");
console.log(ok ? "判定: 道の中心・噴水の中心・村の中心がすべて一致" : "判定: ずれが残っている");
