/* 修正2の検証:
   - 部屋名を変えても屋根の印（deco）が変わらないこと
   - 種別（deco）を変えると印が変わること
   - 取りうる値が CHECK で固定されていること
   検証後は元の値に戻す。実行: node scripts\verify-room-deco.js */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const rooms = async () => (await (await fetch(API + "/api/rooms")).json()).rooms;

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const before = await rooms();
  log("いまの7棟:");
  for (const r of before) log(`  id=${r.id} ${r.name} deco=${r.deco}`);
  const uniq = new Set(before.map((r) => r.deco));
  log("  種別の重複なし: " + (uniq.size === before.length ? "はい（7種類すべて別）" : "いいえ（" + uniq.size + "種類）"));

  const target = before.find((r) => r.deco === "dev");
  const orig = { name: target.name, deco: target.deco };

  log("");
  log("=== 1. 部屋名を変えても印は変わらないか ===");
  await db.query("UPDATE rooms SET name = $2 WHERE id = $1", [target.id, orig.name + "チーム"]);
  const afterRename = (await rooms()).find((r) => Number(r.id) === Number(target.id));
  log(`  「${orig.name}」→「${afterRename.name}」に変更 / deco=${afterRename.deco}`);
  log("  印は変わったか: " + (afterRename.deco === orig.deco ? "変わらない" : "変わった（問題）"));

  log("");
  log("=== 2. 種別を変えると印は変わるか ===");
  await db.query("UPDATE rooms SET deco = 'rest' WHERE id = $1", [target.id]);
  const afterDeco = (await rooms()).find((r) => Number(r.id) === Number(target.id));
  log(`  deco を 'rest' に変更 -> ${afterDeco.deco}`);
  log("  印は変わったか: " + (afterDeco.deco === "rest" ? "変わった" : "変わらない（問題）"));

  log("");
  log("=== 3. 決めた値以外を入れられるか ===");
  for (const bad of ["kitchen", "", "DEV", "'; DROP TABLE rooms; --"]) {
    try {
      await db.query("UPDATE rooms SET deco = $2 WHERE id = $1", [target.id, bad]);
      log(`  ${JSON.stringify(bad)} -> 入った（問題）`);
    } catch (e) {
      log(`  ${JSON.stringify(bad)} -> 拒否: ${String(e.message).split("\n")[0]}`);
    }
  }
  const alive = await db.query("SELECT count(*)::int n FROM rooms");
  log("  rooms: 健在（" + alive.rows[0].n + " 行）");

  log("");
  log("=== 4. 元に戻す ===");
  await db.query("UPDATE rooms SET name = $2, deco = $3 WHERE id = $1", [target.id, orig.name, orig.deco]);
  const restored = (await rooms()).find((r) => Number(r.id) === Number(target.id));
  log(`  id=${restored.id} ${restored.name} deco=${restored.deco}`);

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
