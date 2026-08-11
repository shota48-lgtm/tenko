// tenko Phase 2-B: 3つのバリアントのスプライトを生成する。
//
// 出力: src/sprites/variant-a.json / variant-b.json / variant-c.json
// 3案でスプライトの鍵と寸法を完全に一致させるため、鍵の一覧はここで一元管理する。
// 生成後は JSON が正。JSON を手で直した場合、このスクリプトを再実行してはならない。
//
// 色スロット（全バリアント共通の意味。実際の色はバリアントごとに違う）
//   0 透明 / 1 地面(明) / 2 地面(暗)・影 / 3 道(明) / 4 道(暗)
//   5 輪郭・髪・靴・ズボン / 6 屋根 / 7 屋根の陰 / 8 壁 / 9 壁の陰・木部・窓枠
//   10 明かり / 11 肌 / 12 服D / 13 服A / 14 服B・水 / 15 服C
const fs = require("fs");
const path = require("path");

// ---------- 道具 ----------
function G(w, h) { return Array.from({ length: h }, function () { return Array(w).fill(0); }); }
function px(g, x, y, c) { if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = c; }
function rect(g, x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) px(g, x, y, c); }
function disc(g, cx, cy, r, c) {
  for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if (Math.hypot(x - cx, y - cy) <= r) px(g, x, y, c);
}
function fromRows(src, map) {
  return src.map(function (r) {
    return r.split("").map(function (ch) {
      return (map && map[ch] !== undefined) ? map[ch] : parseInt(ch, 16);
    });
  });
}
function lcg(seed) { var s = seed; return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

// ---------- 人物 16x16 ----------
// 形は Phase 2-A で合格したものを踏襲する。S は服の色スロットに置き換える。
// 足元に地面の暗い色(2)で影を1行入れ、草の上に浮いて見える問題を解消する。
var IDLE = [
  "0000000000000000",
  "0000000000000000",
  "0000055555500000",
  "0000555555550000",
  "00005b5bb5b50000",
  "00005bbbbbb50000",
  "00000bbbbbb00000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "0000bSSSSSSb0000",
  "00000SSSSSS00000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055005500000",
  "0000055005500000",
  "0000222222220000",
];
// 離席は背を向ける（顔が無いことで一目で分かる）
var AWAY = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000055555500000",
  "0000555555550000",
  "0000555555550000",
  "0000555555550000",
  "0000055555500000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "0000bSSSSSSb0000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055005500000",
  "0000055005500000",
  "0000222222220000",
];
// 会話中は頭上に小さな点を3つ。旗に見えないよう、面を持たせない
var TALKING = [
  "0000000000000000",
  "00000000000a0a0a",
  "0000055555500000",
  "0000555555550000",
  "00005b5bb5b50000",
  "00005bbbbbb50000",
  "00000bbbbbb00000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "0000bSSSSSSb0000",
  "00000SSSSSS00000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055005500000",
  "0000055005500000",
  "0000222222220000",
];
// 休憩は座り姿。全体を下げ、脚を前に投げ出して離席と区別する
var RESTING = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000055555500000",
  "0000555555550000",
  "00005b5bb5b50000",
  "00005bbbbbb50000",
  "00000bbbbbb00000",
  "00000SSSSSS00000",
  "00000SSSSSSb0000",
  "00000SSSSSS50000",
  "0000005555555500",
  "0000000000005500",
  "0000222222222200",
];
var SHIRTS = { 1: 13, 2: 14, 3: 15, 4: 12 };

// ---------- 建物 32x32 ----------
// 斜め上から見た構図。上に屋根、下に壁・扉・窓。
// 引き出しに見えた原因は屋根の横線だったので、屋根は面で塗り、線は棟と軒だけにする。
function building(o) {
  var g = G(32, 32);
  var wide = !!o.wide;
  var wx0 = wide ? 3 : 6, wx1 = wide ? 28 : 25;
  var wy0 = 16, wy1 = 28;

  // 壁
  rect(g, wx0, wy0, wx1, wy1, o.wall);
  for (var y = wy0; y <= wy1; y++) { px(g, wx0, y, o.wallEdge); px(g, wx1, y, o.wallEdge); }
  rect(g, wx0, wy1, wx1, wy1, o.wallEdge);

  // 屋根
  var rTop = 2, rBot = 16;
  var hwTop = o.style === "gable" ? 2 : (o.style === "hip" ? 6 : 5);
  var hwBot = wide ? 15 : 13;
  for (var y = rTop; y <= rBot; y++) {
    var t = (y - rTop) / (rBot - rTop);
    var f = o.style === "kawara" ? Math.pow(t, 0.7) : t;   // 和風は軒に向けて反らせる
    var hw = Math.round(hwTop + (hwBot - hwTop) * f);
    rect(g, 16 - hw, y, 15 + hw, y, o.roof);
    px(g, 16 - hw, y, o.roofEdge); px(g, 15 + hw, y, o.roofEdge);
  }
  rect(g, 16 - hwTop, rTop, 15 + hwTop, rTop, o.roofEdge);      // 棟
  rect(g, 16 - hwBot, rBot, 15 + hwBot, rBot, o.roofEdge);      // 軒
  if (o.style === "kawara") rect(g, 16 - hwBot + 1, rBot - 1, 15 + hwBot - 1, rBot - 1, o.roofEdge);

  // 窓
  var wins = wide ? [[6, 9], [14, 17], [22, 25]] : [[9, 12], [19, 22]];
  var glass = o.lit ? o.litColor : o.glass;
  for (var i = 0; i < wins.length; i++) {
    var x0 = wins[i][0], x1 = wins[i][1], y0 = 19, y1 = 22;
    rect(g, x0 - 1, y0 - 1, x1 + 1, y1 + 1, o.wallEdge);
    rect(g, x0, y0, x1, y1, glass);
    if (o.lit) { px(g, x0, y0, o.litColor); px(g, x1, y1, o.litColor); }
  }

  // 扉
  var dx0 = wide ? 13 : 14, dx1 = wide ? 18 : 17;
  rect(g, dx0 - 1, 23, dx1 + 1, wy1, o.wallEdge);
  rect(g, dx0, 24, dx1, wy1 - 1, o.door);
  px(g, dx1 - 1, 26, o.litColor);

  // 影（地面の暗い色）
  rect(g, wx0 + 1, wy1 + 1, wx1 + 1, wy1 + 1, o.shadow);
  rect(g, wx0 + 3, wy1 + 2, wx1 - 1, wy1 + 2, o.shadow);
  return g;
}

// ---------- 地面 16x16 ----------
function groundTile(base, dot, seed, density) {
  var g = G(16, 16);
  rect(g, 0, 0, 15, 15, base);
  var r = lcg(seed);
  for (var i = 0; i < density; i++) px(g, Math.floor(r() * 16), Math.floor(r() * 16), dot);
  return g;
}
// 道の縁。境界を1ドット単位で崩し、定規で引いた直線に見えないようにする
function edgeTile(dir, groundBase, groundDot, pathBase, pathDot, seed) {
  var g = G(16, 16);
  rect(g, 0, 0, 15, 15, pathBase);
  var r = lcg(seed);
  var off = [];
  for (var i = 0; i < 16; i++) off.push(1 + Math.floor(r() * 4));   // 1..4 ドットの凹凸
  for (var i2 = 0; i2 < 16; i2++) {
    var k = off[i2];
    for (var j = 0; j < k; j++) {
      if (dir === "n") px(g, i2, j, groundBase);
      if (dir === "s") px(g, i2, 15 - j, groundBase);
      if (dir === "e") px(g, 15 - j, i2, groundBase);
    }
  }
  for (var d = 0; d < 10; d++) {
    var x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    px(g, x, y, g[y][x] === pathBase ? pathDot : groundDot);
  }
  return g;
}
// ---------- 噴水 32x32 ----------
// 中心からの距離だけで色を決めるので、どの向きから見ても成立する
function fountain(stone, stoneEdge, water, spray) {
  var g = G(32, 32);
  var c = 15.5;
  for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) {
    var d = Math.hypot(x - c, y - c);
    var v = 0;
    if (d <= 15.2) v = stoneEdge;
    if (d <= 13.4) v = stone;
    if (d <= 11.6) v = water;
    if (d <= 5.0) v = spray;
    if (d <= 3.2) v = stone;
    if (d <= 1.5) v = spray;
    g[y][x] = v;
  }
  return g;
}

// ---------- 装飾物 ----------
// 鍵は3案で一致させる必要があるため deco_1..deco_8 とし、
// 何を描いたかは JSON の labels に持たせる。
function decoA() {
  var d = {};
  var g;
  // 1 木
  g = G(16, 16); rect(g, 7, 9, 8, 14, 9); disc(g, 7.5, 6, 5, 1); disc(g, 6, 5, 3, 15); disc(g, 9.5, 7.5, 2, 2);
  rect(g, 5, 15, 11, 15, 2); d.deco_1 = g;
  // 2 低木
  g = G(16, 16); disc(g, 7.5, 10, 4, 1); disc(g, 6, 9, 2, 15); disc(g, 10, 11, 1.5, 2); rect(g, 4, 14, 11, 14, 2); d.deco_2 = g;
  // 3 柵
  g = G(16, 16); rect(g, 0, 7, 15, 8, 9); rect(g, 0, 11, 15, 11, 9);
  rect(g, 2, 5, 3, 14, 9); rect(g, 8, 5, 9, 14, 9); rect(g, 14, 5, 15, 14, 9); rect(g, 0, 15, 15, 15, 2); d.deco_3 = g;
  // 4 井戸
  g = G(16, 16); disc(g, 7.5, 10, 5, 8); disc(g, 7.5, 10, 3.2, 14); rect(g, 3, 3, 4, 9, 9); rect(g, 11, 3, 12, 9, 9);
  rect(g, 2, 2, 13, 3, 6); rect(g, 2, 15, 13, 15, 2); d.deco_4 = g;
  // 5 樽
  g = G(16, 16); rect(g, 4, 5, 11, 14, 9); rect(g, 4, 7, 11, 7, 5); rect(g, 4, 12, 11, 12, 5);
  rect(g, 5, 4, 10, 4, 6); rect(g, 3, 15, 12, 15, 2); d.deco_5 = g;
  // 6 畑
  g = G(16, 16); rect(g, 0, 2, 15, 14, 3);
  for (var i = 0; i < 16; i += 3) rect(g, 0, 2 + i % 13, 15, 2 + i % 13, 4);
  for (var x = 1; x < 15; x += 3) { px(g, x, 5, 15); px(g, x, 9, 15); px(g, x, 13, 15); }
  d.deco_6 = g;
  // 7 干し草
  g = G(16, 16); disc(g, 7.5, 10, 5.5, 6); disc(g, 6, 9, 3, 10); rect(g, 2, 15, 13, 15, 2); d.deco_7 = g;
  // 8 案山子
  g = G(16, 16); rect(g, 7, 6, 8, 15, 9); rect(g, 2, 8, 13, 8, 9); disc(g, 7.5, 4, 2.5, 6);
  rect(g, 4, 2, 11, 2, 13); rect(g, 5, 9, 10, 12, 13); rect(g, 4, 15, 11, 15, 2); d.deco_8 = g;
  return d;
}
function decoB() {
  var d = {}; var g;
  // 1 街灯
  g = G(16, 16); rect(g, 7, 5, 8, 15, 5); rect(g, 5, 2, 10, 4, 9); rect(g, 6, 3, 9, 4, 10);
  rect(g, 5, 15, 10, 15, 2); d.deco_1 = g;
  // 2 看板
  g = G(16, 16); rect(g, 7, 9, 8, 15, 9); rect(g, 2, 2, 13, 9, 8); rect(g, 2, 2, 13, 2, 9); rect(g, 2, 9, 13, 9, 9);
  rect(g, 4, 4, 11, 4, 5); rect(g, 4, 6, 9, 6, 5); rect(g, 4, 15, 11, 15, 2); d.deco_2 = g;
  // 3 ベンチ
  g = G(16, 16); rect(g, 1, 8, 14, 9, 9); rect(g, 1, 5, 14, 5, 9); rect(g, 2, 6, 2, 7, 9); rect(g, 13, 6, 13, 7, 9);
  rect(g, 2, 10, 3, 14, 5); rect(g, 12, 10, 13, 14, 5); rect(g, 1, 15, 14, 15, 2); d.deco_3 = g;
  // 4 花壇
  g = G(16, 16); rect(g, 1, 6, 14, 14, 8); rect(g, 2, 7, 13, 13, 4);
  for (var x2 = 3; x2 < 13; x2 += 3) { px(g, x2, 9, 13); px(g, x2 + 1, 11, 10); px(g, x2, 12, 15); }
  rect(g, 1, 15, 14, 15, 2); d.deco_4 = g;
  // 5 鉢植え
  g = G(16, 16); disc(g, 7.5, 7, 4, 15); disc(g, 6, 6, 2, 1); rect(g, 5, 10, 10, 14, 6); rect(g, 4, 10, 11, 10, 9);
  rect(g, 4, 15, 11, 15, 2); d.deco_5 = g;
  // 6 石畳の模様
  g = G(16, 16); rect(g, 0, 0, 15, 15, 3);
  for (var y2 = 0; y2 < 16; y2 += 4) rect(g, 0, y2, 15, y2, 4);
  for (var y3 = 0; y3 < 16; y3 += 4) for (var x3 = (y3 % 8 === 0 ? 0 : 3); x3 < 16; x3 += 6) rect(g, x3, y3, x3, y3 + 3, 4);
  d.deco_6 = g;
  // 7 低い石塀
  g = G(16, 16); rect(g, 0, 6, 15, 13, 8); rect(g, 0, 6, 15, 6, 9); rect(g, 0, 13, 15, 13, 9);
  for (var x4 = 2; x4 < 16; x4 += 4) rect(g, x4, 7, x4, 9, 9);
  for (var x5 = 4; x5 < 16; x5 += 4) rect(g, x5, 10, x5, 12, 9);
  rect(g, 0, 14, 15, 14, 2); d.deco_7 = g;
  // 8 刈り込んだ木
  g = G(16, 16); rect(g, 7, 10, 8, 14, 9); disc(g, 7.5, 6, 4.5, 15); disc(g, 6, 5, 2.5, 1);
  rect(g, 4, 15, 11, 15, 2); d.deco_8 = g;
  return d;
}
function decoC() {
  var d = {}; var g;
  // 1 石灯籠
  g = G(16, 16); rect(g, 5, 13, 10, 14, 8); rect(g, 6, 9, 9, 13, 8); rect(g, 5, 6, 10, 9, 8);
  rect(g, 6, 7, 9, 8, 10); rect(g, 3, 4, 12, 6, 6); rect(g, 6, 3, 9, 3, 6); rect(g, 4, 15, 11, 15, 2); d.deco_1 = g;
  // 2 生垣
  g = G(16, 16); rect(g, 0, 5, 15, 13, 1); disc(g, 3, 5, 3, 1); disc(g, 8, 4, 3, 1); disc(g, 13, 5, 3, 1);
  for (var i3 = 0; i3 < 16; i3 += 2) px(g, i3, 7 + (i3 % 4), 15);
  for (var i4 = 1; i4 < 16; i4 += 3) px(g, i4, 10, 2);
  rect(g, 0, 14, 15, 14, 2); d.deco_2 = g;
  // 3 竹
  g = G(16, 16); rect(g, 3, 0, 4, 15, 15); rect(g, 8, 0, 9, 15, 1); rect(g, 12, 2, 13, 15, 15);
  for (var y4 = 2; y4 < 16; y4 += 5) { rect(g, 3, y4, 4, y4, 2); rect(g, 8, y4 + 1, 9, y4 + 1, 2); rect(g, 12, y4, 13, y4, 2); }
  rect(g, 2, 15, 14, 15, 2); d.deco_3 = g;
  // 4 松
  g = G(16, 16); rect(g, 7, 8, 8, 14, 9); px(g, 6, 10, 9); px(g, 9, 9, 9);
  disc(g, 4, 7, 3, 2); disc(g, 11, 6, 3, 2); disc(g, 7.5, 3, 3.5, 1); disc(g, 4, 6, 1.5, 1); disc(g, 11, 5, 1.5, 1);
  rect(g, 4, 15, 11, 15, 2); d.deco_4 = g;
  // 5 井戸
  g = G(16, 16); disc(g, 7.5, 10, 5, 8); disc(g, 7.5, 10, 3.2, 14); rect(g, 3, 3, 4, 9, 9); rect(g, 11, 3, 12, 9, 9);
  rect(g, 2, 2, 13, 3, 6); rect(g, 2, 15, 13, 15, 2); d.deco_5 = g;
  // 6 暖簾
  g = G(16, 16); rect(g, 1, 4, 14, 4, 9); rect(g, 1, 5, 14, 11, 14);
  rect(g, 5, 5, 5, 11, 8); rect(g, 10, 5, 10, 11, 8); rect(g, 7, 7, 8, 8, 8);
  rect(g, 1, 4, 1, 15, 9); rect(g, 14, 4, 14, 15, 9); rect(g, 1, 15, 14, 15, 2); d.deco_6 = g;
  // 7 砂利だまり
  g = G(16, 16); rect(g, 0, 0, 15, 15, 3);
  var r7 = lcg(77); for (var i5 = 0; i5 < 40; i5++) px(g, Math.floor(r7() * 16), Math.floor(r7() * 16), 4);
  d.deco_7 = g;
  // 8 酒樽
  g = G(16, 16); rect(g, 4, 5, 11, 14, 8); rect(g, 4, 7, 11, 7, 5); rect(g, 4, 12, 11, 12, 5);
  rect(g, 5, 4, 10, 4, 9); rect(g, 6, 9, 9, 10, 13); rect(g, 3, 15, 12, 15, 2); d.deco_8 = g;
  return d;
}

// ---------- バリアント ----------
var VARIANTS = {
  a: {
    name: "素朴な農村",
    description: "木の壁と藁屋根。暖色寄り。いわゆる村の原型",
    palette: ["transparent", "#7f9c5e", "#6a8550", "#c0a878", "#a89165", "#33302a", "#c8a45c", "#9c7b3f",
      "#b98f63", "#8a6742", "#f2d489", "#e8c9a0", "#7c6396", "#b2503a", "#41668f", "#5f7f45"],
    houseStyle: "gable", hallStyle: "hip", deco: decoA,
    labels: { deco_1: "木", deco_2: "低木", deco_3: "柵", deco_4: "井戸", deco_5: "樽", deco_6: "畑", deco_7: "干し草", deco_8: "案山子" },
  },
  b: {
    name: "石造りの町",
    description: "しっくいの壁と瓦屋根、石畳。寒色寄り。業務ツールとして落ち着いた方向",
    palette: ["transparent", "#7f9370", "#6a7d5e", "#a9a79f", "#8f8d86", "#2f3138", "#7a6f6a", "#57504d",
      "#cfc9bd", "#9a9184", "#f3dea6", "#e8c9a0", "#6f6396", "#a84f47", "#46688f", "#5b7a52"],
    houseStyle: "hip", hallStyle: "gable", deco: decoB,
    labels: { deco_1: "街灯", deco_2: "看板", deco_3: "ベンチ", deco_4: "花壇", deco_5: "鉢植え", deco_6: "石畳の模様", deco_7: "低い石塀", deco_8: "刈り込んだ木" },
  },
  c: {
    name: "和の集落",
    description: "瓦屋根と土壁、障子。砂利の道と苔。日本的な集落",
    palette: ["transparent", "#79916a", "#63795a", "#b6ae9c", "#9a9384", "#2b2b28", "#5e6b73", "#414c54",
      "#d8cdb4", "#8a7250", "#f0dc9e", "#e8c9a0", "#6b5f8c", "#a04a3c", "#3f6382", "#55764a"],
    houseStyle: "kawara", hallStyle: "kawara", deco: decoC,
    labels: { deco_1: "石灯籠", deco_2: "生垣", deco_3: "竹", deco_4: "松", deco_5: "井戸", deco_6: "暖簾", deco_7: "砂利だまり", deco_8: "酒樽" },
  },
};

// ---------- 組み立て ----------
function buildVariant(key) {
  var v = VARIANTS[key];
  var s = {};
  for (var n = 1; n <= 4; n++) {
    var m = { S: SHIRTS[n] };
    s["person_idle_" + n] = fromRows(IDLE, m);
    s["person_away_" + n] = fromRows(AWAY, m);
    s["person_talking_" + n] = fromRows(TALKING, m);
    s["person_resting_" + n] = fromRows(RESTING, m);
  }
  var base = { roof: 6, roofEdge: 7, wall: 8, wallEdge: 9, door: 9, glass: 4, litColor: 10, shadow: 2 };
  function mix(extra) { var o = {}; for (var k in base) o[k] = base[k]; for (var k2 in extra) o[k2] = extra[k2]; return o; }
  s.house = building(mix({ style: v.houseStyle, lit: false }));
  s.house_lit = building(mix({ style: v.houseStyle, lit: true }));
  s.hall = building(mix({ style: v.hallStyle, wide: true, roof: 7, roofEdge: 5, lit: false }));
  s.hall_lit = building(mix({ style: v.hallStyle, wide: true, roof: 7, roofEdge: 5, lit: true }));

  s.grass = groundTile(1, 2, 12345, 26);
  s.grass_alt = groundTile(1, 2, 98765, 44);
  s.path = groundTile(3, 4, 24680, 30);
  s.path_edge_n = edgeTile("n", 1, 2, 3, 4, 1357);
  s.path_edge_s = edgeTile("s", 1, 2, 3, 4, 2468);
  s.path_edge_e = edgeTile("e", 1, 2, 3, 4, 3579);

  var d = v.deco();
  for (var dk in d) s[dk] = d[dk];

  s.fountain = fountain(8, 5, 14, 10);
  return { meta: { variant: key, name: v.name, description: v.description }, palette: v.palette, labels: v.labels, sprites: s };
}

// 3案が同じ鍵を持つことを保証するための一覧
var REQUIRED = [];
for (var n2 = 1; n2 <= 4; n2++) ["idle", "away", "talking", "resting"].forEach(function (st) { REQUIRED.push("person_" + st + "_" + n2); });
["house", "house_lit", "hall", "hall_lit", "grass", "grass_alt", "path", "path_edge_n", "path_edge_s", "path_edge_e"].forEach(function (k) { REQUIRED.push(k); });
for (var n3 = 1; n3 <= 8; n3++) REQUIRED.push("deco_" + n3);
REQUIRED.push("fountain");
var SIZE = function (k) { return (k === "fountain" || k.indexOf("house") === 0 || k.indexOf("hall") === 0) ? 32 : 16; };

function serialize(v) {
  var out = [];
  out.push("{");
  out.push('  "meta": ' + JSON.stringify(v.meta) + ",");
  out.push('  "palette": [');
  v.palette.forEach(function (c, i) { out.push('    "' + c + '"' + (i < v.palette.length - 1 ? "," : "")); });
  out.push("  ],");
  out.push('  "labels": {');
  var lk = Object.keys(v.labels);
  lk.forEach(function (k, i) { out.push('    "' + k + '": "' + v.labels[k] + '"' + (i < lk.length - 1 ? "," : "")); });
  out.push("  },");
  out.push('  "sprites": {');
  var names = Object.keys(v.sprites);
  names.forEach(function (name, i) {
    out.push('    "' + name + '": [');
    var g = v.sprites[name];
    g.forEach(function (row, j) { out.push("      [" + row.join(",") + "]" + (j < g.length - 1 ? "," : "")); });
    out.push("    ]" + (i < names.length - 1 ? "," : ""));
  });
  out.push("  }");
  out.push("}");
  return out.join("\n") + "\n";
}

var report = [];
var keySets = {};
["a", "b", "c"].forEach(function (k) {
  var v = buildVariant(k);
  var bad = [];
  REQUIRED.forEach(function (rk) { if (!v.sprites[rk]) bad.push("欠落: " + rk); });
  Object.keys(v.sprites).forEach(function (sk) {
    if (REQUIRED.indexOf(sk) < 0) bad.push("余分: " + sk);
    var size = SIZE(sk), g = v.sprites[sk];
    if (g.length !== size) bad.push(sk + " の行数 " + g.length + " (期待 " + size + ")");
    g.forEach(function (row, y) {
      if (row.length !== size) bad.push(sk + " の " + y + " 行目の長さ " + row.length);
      row.forEach(function (c) { if (c < 0 || c > 15 || !Number.isInteger(c)) bad.push(sk + " に範囲外の色番号 " + c); });
    });
  });
  if (v.palette.length > 16) bad.push("パレットが " + v.palette.length + " 色");
  keySets[k] = Object.keys(v.sprites).sort().join("|");
  fs.writeFileSync(path.join(__dirname, "..", "src", "sprites", "variant-" + k + ".json"), serialize(v), "utf8");
  report.push("variant-" + k + ".json: スプライト " + Object.keys(v.sprites).length + " 枚 / パレット " + v.palette.length + " 色 / " + (bad.length ? "異常 " + bad.length + " 件\n  " + bad.join("\n  ") : "検査すべて通過"));
});
report.push(keySets.a === keySets.b && keySets.b === keySets.c ? "3案の鍵の集合: 完全に一致" : "3案の鍵の集合: 不一致あり");
console.log(report.join("\n"));
