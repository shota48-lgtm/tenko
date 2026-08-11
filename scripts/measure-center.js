/* 村の中心・噴水・道の位置を実測する。直す前と後の両方で実行して比べる。
   実行: node scripts\measure-center.js */
const m = require("../src/village/map.json");
const T = m.tile;
const W = m.width * T;
const H = m.height * T;
const cx = W / 2;
const cy = H / 2;

const log = (s) => console.log(s);
const band = (list) => ({ min: Math.min(...list), max: Math.max(...list) });

log(`村: ${m.width}x${m.height} タイル = ${W}x${H} ドット / 中心 (${cx},${cy})`);
log("");

// 噴水。ドット指定（fountainPx）があればそちらを正とする
const fx = m.fountainPx ? m.fountainPx.x : m.fountain.x * T;
const fy = m.fountainPx ? m.fountainPx.y : m.fountain.y * T;
log(`噴水: 左上 (${fx},${fy}) 大きさ 32x32 / 中心 (${fx + 16},${fy + 16})`);
log(`  村の中心とのずれ: (${fx + 16 - cx}, ${fy + 16 - cy})`);
log("");

// 縦の道
const v = band(m.roads.v);
const shift = m.roadShift || 0;
const vx0 = v.min * T + shift;
const vx1 = (v.max + 1) * T + shift;
log(`縦の道: x = ${vx0}..${vx1}（幅 ${vx1 - vx0}） 中心 ${(vx0 + vx1) / 2}`);
log(`  村の中心とのずれ: ${(vx0 + vx1) / 2 - cx}`);
log(`  左の草地 ${vx0} ドット / 右の草地 ${W - vx1} ドット / 差 ${vx0 - (W - vx1)}`);
log(`  縁を含む: x = ${vx0 - T}..${vx1 + T} / 左 ${vx0 - T} / 右 ${W - (vx1 + T)}`);
log("");

// 横の道
const h = band(m.roads.h);
const hy0 = h.min * T + shift;
const hy1 = (h.max + 1) * T + shift;
log(`横の道: y = ${hy0}..${hy1}（幅 ${hy1 - hy0}） 中心 ${(hy0 + hy1) / 2}`);
log(`  村の中心とのずれ: ${(hy0 + hy1) / 2 - cy}`);
log(`  上の草地 ${hy0} ドット / 下の草地 ${H - hy1} ドット / 差 ${hy0 - (H - hy1)}`);
log(`  縁を含む: y = ${hy0 - T}..${hy1 + T} / 上 ${hy0 - T} / 下 ${H - (hy1 + T)}`);
log("");

// 道と重なる装飾・建物を数える（道の位置を変えたときの影響を見る）
const inV = (x, w) => x + w > vx0 && x < vx1;
const inH = (y, hh) => y + hh > hy0 && y < hy1;
const decoOnRoad = m.deco.filter((d) => {
  const x = d.x * T, y = d.y * T;
  return inV(x, T) || inH(y, T);
});
log(`道の帯と重なる装飾: ${decoOnRoad.length} 件 / 全 ${m.deco.length} 件`);
const slotOnRoad = m.buildingSlots.filter((s) => inV(s.x * T, 32) || inH(s.y * T, 32));
log(`道の帯と重なる建物枠: ${slotOnRoad.length} 件 / 全 ${m.buildingSlots.length} 件`);
