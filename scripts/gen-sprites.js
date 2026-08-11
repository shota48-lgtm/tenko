// src/sprites/sprites.json を生成する。
//
// 絵は「1文字 = 色番号(16進)」の行文字列で書き、ここで2次元配列に展開する。
// 生成後は sprites.json が正であり、修正は JSON の数値を直接書き換えて行う。
// このスクリプトは初回作成のための道具であり、JSON を編集した後に再実行してはならない。
const fs = require("fs");
const path = require("path");

// ---- パレット（0 は透明。全16色）----
const palette = {
  "0": "transparent",
  "1": "#7d9a63", // 草地（明）
  "2": "#6b8753", // 草地（暗）。草の模様
  "3": "#c3b18d", // 道
  "4": "#5f83a6", // 水面
  "5": "#3f382c", // 輪郭・屋根の縁・ズボン・入口
  "6": "#a8563f", // house の屋根
  "7": "#4a6b8a", // hall の屋根
  "8": "#d8cbb0", // 壁・石
  "9": "#e8c9a0", // 肌
  "10": "#2b2823", // 髪・靴
  "11": "#b2503a", // 服A
  "12": "#41668f", // 服B
  "13": "#5f7f45", // 服C
  "14": "#7c6396", // 服D
  "15": "#eae3d3", // ハイライト・吹き出し・水しぶき
};

// ---- 人物 16x16。S は服の色に置き換える ----
const personIdle = [
  "0000000000000000",
  "0000000000000000",
  "00000aaaaaa00000",
  "0000aaaaaaaa0000",
  "0000a9a99a9a0000",
  "0000a999999a0000",
  "0000099999900000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "00009SSSSSS90000",
  "00000SSSSSS00000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055555500000",
  "0000055005500000",
  "00000aa00aa00000",
];

// 離席は背を向けた姿にする。顔が無いことで一目で分かる
const personAway = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "00000aaaaaa00000",
  "0000aaaaaaaa0000",
  "0000aaaaaaaa0000",
  "0000aaaaaaaa0000",
  "00000aaaaaa00000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "00009SSSSSS90000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055555500000",
  "0000055005500000",
  "00000aa00aa00000",
];

// 会話中は頭の右上に吹き出しを付ける
const personTalking = [
  "0000000000055550",
  "000000000005ff50",
  "00000aaaaaa5ff50",
  "0000aaaaaaaa5550",
  "0000a9a99a9a0000",
  "0000a999999a0000",
  "0000099999900000",
  "0000SSSSSSSS0000",
  "0000SSSSSSSS0000",
  "00009SSSSSS90000",
  "00000SSSSSS00000",
  "00000SSSSSS00000",
  "0000055555500000",
  "0000055555500000",
  "0000055005500000",
  "00000aa00aa00000",
];

// 真上から見た屋根。棟(むね)を横に1本通し、下辺に入口を切り欠く。
// 入口の外には土間(道の色)を1段出して、どちらが正面かを分かるようにする。
const house = [
  "0000000000000000",
  "0055555555555500",
  "0056666666666500",
  "0056666666666500",
  "0056666666666500",
  "0056666666666500",
  "0055555555555500",
  "0056666666666500",
  "0056666666666500",
  "0056666666666500",
  "0056666666666500",
  "0056666556666500",
  "0055555335555500",
  "0000003333000000",
  "0000003333000000",
  "0000000000000000",
];

// 共有の建物。屋根の色を変え、footprint を一回り大きくし、入口を広く取る
const hall = [
  "0555555555555550",
  "0577777777777750",
  "0577777777777750",
  "0577777777777750",
  "05ffffffffffff50",
  "0577777777777750",
  "0577777777777750",
  "0577777777777750",
  "05ffffffffffff50",
  "0577777777777750",
  "0577777777777750",
  "0577777777777750",
  "0577777777777750",
  "0577733337777750",
  "0555533335555550",
  "0000033330000000",
];

const grass = [
  "1111111111111111",
  "1111211111111211",
  "1111111111111111",
  "1211111112111111",
  "1111111111111111",
  "1111111121111111",
  "1111211111111111",
  "1111111111112111",
  "1111111111111111",
  "1121111111111211",
  "1111111111111111",
  "1111111211111111",
  "1211111111111111",
  "1111111111121111",
  "1111111111111111",
  "1111211111111111",
];

const pathTile = [
  "3333333333333333",
  "3333833333333833",
  "3333333333333333",
  "3833333338333333",
  "3333333333333333",
  "3333333383333333",
  "3333833333333333",
  "3333333333338333",
  "3333333333333333",
  "3383333333333833",
  "3333333333333333",
  "3333333833333333",
  "3833333333333333",
  "3333333333383333",
  "3333333333333333",
  "3333833333333333",
];

const water = [
  "4444444444444444",
  "4ff44444444ff444",
  "4444444444444444",
  "4444444444444444",
  "444444ff44444444",
  "4444444444444444",
  "44444444444ff444",
  "4444444444444444",
  "4ff44444444444ff",
  "4444444444444444",
  "4444444444444444",
  "44444ff444444444",
  "4444444444444444",
  "444444444444ff44",
  "4444444444444444",
  "44ff444444444444",
];

// ---- 噴水 32x32。中心からの距離だけで色を決めるので、どの向きから見ても同じ形になる ----
function fountain() {
  const N = 32;
  const c = (N - 1) / 2;
  const rows = [];
  for (let y = 0; y < N; y++) {
    let row = "";
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c);
      let v = "0";
      if (d <= 15.2) v = "5";        // 外側の石の縁
      if (d <= 13.4) v = "8";        // 縁の内側の石
      if (d <= 11.6) v = "4";        // 水面
      if (d <= 5.0) v = "f";         // 水しぶき
      if (d <= 3.2) v = "8";         // 中央の石柱
      if (d <= 1.5) v = "f";         // 柱の頂点
      row += v;
    }
    rows.push(row);
  }
  return rows;
}

// ---- 展開 ----
const shirts = { "1": "b", "2": "c", "3": "d", "4": "e" };
const expand = (rows, shirt) =>
  rows.map((r) => (shirt ? r.replace(/S/g, shirt) : r).split("").map((ch) => parseInt(ch, 16)));

const sprites = {};
for (const [n, shirt] of Object.entries(shirts)) {
  sprites[`person_idle_${n}`] = expand(personIdle, shirt);
  sprites[`person_away_${n}`] = expand(personAway, shirt);
  sprites[`person_talking_${n}`] = expand(personTalking, shirt);
}
sprites.house = expand(house);
sprites.hall = expand(hall);
sprites.grass = expand(grass);
sprites.path = expand(pathTile);
sprites.water = expand(water);
sprites.fountain = expand(fountain());

// ---- 1行1ドット行で書き出す（git で1ドット単位の差分が見えるように）----
const parts = [];
parts.push("{");
parts.push('  "palette": {');
const pal = Object.entries(palette);
pal.forEach(([k, v], i) => parts.push(`    "${k}": "${v}"${i < pal.length - 1 ? "," : ""}`));
parts.push("  },");
parts.push('  "sprites": {');
const names = Object.keys(sprites);
names.forEach((name, i) => {
  parts.push(`    "${name}": [`);
  const g = sprites[name];
  g.forEach((row, j) => parts.push(`      [${row.join(",")}]${j < g.length - 1 ? "," : ""}`));
  parts.push(`    ]${i < names.length - 1 ? "," : ""}`);
});
parts.push("  }");
parts.push("}");

const out = path.join(__dirname, "..", "src", "sprites", "sprites.json");
fs.writeFileSync(out, parts.join("\n") + "\n", "utf8");

// 検査: 大きさと色番号が想定どおりか
let bad = 0;
for (const [name, g] of Object.entries(sprites)) {
  const size = name === "fountain" ? 32 : 16;
  if (g.length !== size) { console.log(`NG ${name}: 行数 ${g.length}`); bad++; }
  g.forEach((row, y) => {
    if (row.length !== size) { console.log(`NG ${name}: ${y}行目の長さ ${row.length}`); bad++; }
    row.forEach((v) => { if (!(String(v) in palette)) { console.log(`NG ${name}: 未定義の色番号 ${v}`); bad++; } });
  });
}
console.log(`スプライト ${names.length} 枚 / パレット ${pal.length} 色 / 検査 ${bad === 0 ? "すべて通過" : bad + " 件の異常"}`);