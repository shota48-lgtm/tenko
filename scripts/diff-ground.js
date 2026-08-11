/* 道をずらした影響が、道の帯の外に及んでいないかを画素で確かめる。
   直す前と後の地面のPNGを比べ、違う画素がどこにあるかを数える。
   実行: node scripts\diff-ground.js <前のdir> <後のdir> */
const fs = require("fs");
const zlib = require("zlib");
const A = process.argv[2], B = process.argv[3];

// PNG を読む（この検証用に自分で書き出したものだけを対象にする。フィルタは0固定）
function readPng(f) {
  const b = fs.readFileSync(f);
  let i = 8, w = 0, h = 0;
  const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("ascii", i + 4, i + 8);
    if (type === "IHDR") { w = b.readUInt32BE(i + 8); h = b.readUInt32BE(i + 12); }
    if (type === "IDAT") idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  return { w, h, px };
}

const a = readPng(A + "/center-ground.png");
const b = readPng(B + "/center-ground.png");
if (a.w !== b.w || a.h !== b.h) throw new Error("大きさが違う");

const m = require("../src/village/map.json");
const T = m.tile;
// 道の帯（縁を含む）。ここが変わるのは意図どおり
const vx0 = Math.min(...m.roads.v) * T - T - 8, vx1 = (Math.max(...m.roads.v) + 1) * T + T;
const hy0 = Math.min(...m.roads.h) * T - T - 8, hy1 = (Math.max(...m.roads.h) + 1) * T + T;

let diff = 0, outside = 0;
const outsideSample = [];
for (let y = 0; y < a.h; y++) {
  for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * 3;
    if (a.px[i] === b.px[i] && a.px[i + 1] === b.px[i + 1] && a.px[i + 2] === b.px[i + 2]) continue;
    diff++;
    const inRoad = (x >= vx0 && x < vx1) || (y >= hy0 && y < hy1);
    if (!inRoad) { outside++; if (outsideSample.length < 10) outsideSample.push([x, y]); }
  }
}
console.log(`大きさ: ${a.w}x${a.h}（${a.w * a.h} 画素）`);
console.log(`道の帯（縁を含む）: x ${vx0}..${vx1} / y ${hy0}..${hy1}`);
console.log(`違う画素: ${diff}`);
console.log(`そのうち道の帯の外: ${outside}` + (outside ? " 件 例: " + JSON.stringify(outsideSample) : "（＝道の外は1画素も変わっていない）"));
