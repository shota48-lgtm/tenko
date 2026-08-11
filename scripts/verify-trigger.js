/* 修正後のトリガーの挙動を実測する。
   未確定は消せる / 確定・却下済みは例外になる、の2点を確かめる。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const log = (s) => console.log(s);

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  log("=== 現在の下書き ===");
  log("  " + JSON.stringify((await db.query("SELECT id,kind,status FROM attendance_drafts ORDER BY id")).rows));

  log("=== 未確定の下書きを1件作る（発言から自動で立てる）===");
  const r = await fetch("http://localhost:3000/api/rooms/1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMsgId: "bbbbbbbb-0000-4000-8000-000000000001", body: "そろそろ上がります" }),
  });
  const j = await r.json();
  log("  POST: status=" + r.status + " draft=" + JSON.stringify(j.draft));
  const pend = (await db.query("SELECT id,kind,status FROM attendance_drafts WHERE status='pending' ORDER BY id")).rows;
  log("  未確定: " + JSON.stringify(pend));

  log("=== 1. 未確定を消せるか ===");
  const del = await db.query("DELETE FROM attendance_drafts WHERE id=$1", [pend[0].id]);
  log("  rowCount=" + del.rowCount + "（1 なら消えた）");
  const left = (await db.query("SELECT id FROM attendance_drafts WHERE id=$1", [pend[0].id])).rows;
  log("  行の残り: " + JSON.stringify(left) + "（空なら消えている）");

  log("=== 2. 確定済み(id=1) への操作 ===");
  for (const sql of ["DELETE FROM attendance_drafts WHERE id=1", "UPDATE attendance_drafts SET status='pending' WHERE id=1"]) {
    try {
      const x = await db.query(sql);
      log("  " + sql.split(" ")[0] + ": 通ってしまった rowCount=" + x.rowCount);
    } catch (e) {
      log("  " + sql.split(" ")[0] + ": 例外 -> " + e.message);
    }
  }

  log("=== 3. 却下済み(id=2) への操作 ===");
  for (const sql of ["DELETE FROM attendance_drafts WHERE id=2", "UPDATE attendance_drafts SET status='pending' WHERE id=2"]) {
    try {
      const x = await db.query(sql);
      log("  " + sql.split(" ")[0] + ": 通ってしまった rowCount=" + x.rowCount);
    } catch (e) {
      log("  " + sql.split(" ")[0] + ": 例外 -> " + e.message);
    }
  }

  log("=== 4. 確定・却下済みが無事か ===");
  log("  " + JSON.stringify((await db.query("SELECT id,kind,status,decided_at IS NOT NULL AS decided FROM attendance_drafts ORDER BY id")).rows));

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
