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

// 建物の判定に足す余白。見た目の枠より広く取る。
//
// Phase 4.8 では人物の「足元の1点」が枠に入るかで判定していた。
// この形だと、人物を建物に重ねて置いたとき、下向きの許容が3ドットしかなく、
// POが4回試して0回しか入れなかった。
// 中心どうしで判定し、さらに余白を足すことで、狙いが多少ずれても入るようにする。
//
// 余白の上限: 建物の間隔は最短で32ドット（例: (2,2) と (6,2)）。
// 12 なら判定の幅は 32+24=56 となり、隣の建物の判定と重ならない
const ENTER_MARGIN = 12;

// その座標がどの建物か。人物の中心で見る。
// 中心にしたのは、利用者の操作が「建物の上に人を置く」であり、
// そのとき合っているのは足元ではなく中心だから
function buildingAt(rooms, x, y) {
  const cx = x + PERSON_SIZE / 2;
  const cy = y + PERSON_SIZE / 2;
  let best = null;
  let bestD = Infinity;
  for (const r of buildingRects(rooms)) {
    const m = ENTER_MARGIN;
    if (cx >= r.x - m && cx < r.x + r.w + m && cy >= r.y - m && cy < r.y + r.h + m) {
      // 余白どうしが触れる配置でも、近い方の建物に入れる
      const d = (cx - (r.x + r.w / 2)) ** 2 + (cy - (r.y + r.h / 2)) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best;
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
  buildingRects, buildingAt, clamp, isCoord, defaultSpot, SPOTS, ENTER_MARGIN,
};
