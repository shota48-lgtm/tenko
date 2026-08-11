// 村の座標に関する計算。ws-server（素の Node.js）から使う。
//
// なぜサーバー側にもあるのか:
//   移動の可否・建物の定員は、画面側の判定だけでは守れない。
//   WebSocket を直接叩けば通ってしまうため、同じ計算をサーバー側でも行う。
//
// 地図そのもの（src/village/map.json）は1つしかない。ここでは読むだけで、値を持たない。
// src/village/render.ts の buildingRects と同じ規則で建物の位置を出すこと。

const map = require("../src/village/map.json");

const TILE = map.tile;
const VILLAGE_W = map.width * TILE;
const VILLAGE_H = map.height * TILE;
// 人物の大きさ。render.ts の PERSON_SIZE（16 * PERSON_SCALE）と揃えること
const PERSON_SIZE = 32;
const BUILDING = 32;

// 部屋の並び（id 昇順）と地図の建物枠を、上から順に対応させる。
// render.ts の buildingRects と同じ規則。片方だけ変えると村と判定がずれる
function buildingRects(rooms) {
  return rooms.slice(0, map.buildingSlots.length).map((room, i) => {
    const slot = map.buildingSlots[i];
    return { room, x: slot.x * TILE, y: slot.y * TILE, w: BUILDING, h: BUILDING };
  });
}

// 座標として受け付けられる値か。数値でない・無限・NaN は受け付けない
function isCoord(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// 人物の下に出るもの（足元のリングと名前のラベル）の高さ。
// これを見込んで下端を止めないと、村の一番下へ動いたときに名前が切れる（Phase 4.8 作業7）
const BOTTOM_MARGIN = 18;

// 村の中に収める。人物の絵の大きさ分だけ内側に寄せる（端で切れないように）
function clamp(x, y) {
  return {
    x: Math.round(Math.min(Math.max(x, 0), VILLAGE_W - PERSON_SIZE)),
    y: Math.round(Math.min(Math.max(y, 0), VILLAGE_H - PERSON_SIZE - BOTTOM_MARGIN)),
  };
}

// その座標がどの建物の中か。人物の足元（絵の中央下）で判定する。
// 頭で判定すると、建物の下に立っただけで中に入ってしまう
function buildingAt(rooms, x, y) {
  const fx = x + PERSON_SIZE / 2;
  const fy = y + PERSON_SIZE - 4;
  for (const r of buildingRects(rooms)) {
    if (fx >= r.x && fx < r.x + r.w && fy >= r.y && fy < r.y + r.h) return r;
  }
  return null;
}

// 既定の立ち位置の候補。
//
// 村全体に格子を敷き、広場の中央に近い順に並べる。
// 広場だけに並べていたところ、27人で置き場所が尽きて重なった（50人の職場を想定して実測）。
// 移動できるようになったので、これはあくまで初期値であり、以後はその人の座標が正になる。
const SPOTS = (() => {
  const gapX = PERSON_SIZE + 12;
  const gapY = PERSON_SIZE + 18;
  const cx = (map.plaza.x + map.plaza.w / 2) * TILE;
  const cy = (map.plaza.y + map.plaza.h / 2) * TILE;
  const out = [];
  for (let y = 0; y <= VILLAGE_H - PERSON_SIZE - BOTTOM_MARGIN; y += gapY) {
    for (let x = 0; x <= VILLAGE_W - PERSON_SIZE; x += gapX) {
      out.push({ x, y, d: (x - cx) ** 2 + (y - cy) ** 2 });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map((s) => ({ x: s.x, y: s.y }));
})();

function defaultSpot(index) {
  const s = SPOTS[index % SPOTS.length];
  return clamp(s.x, s.y);
}

module.exports = {
  map, TILE, VILLAGE_W, VILLAGE_H, PERSON_SIZE, BOTTOM_MARGIN,
  buildingRects, buildingAt, clamp, isCoord, defaultSpot, SPOTS,
};
