// 読み取りのみ。接続文字列は出力しない
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const t of ["users", "rooms", "room_members", "messages", "read_states"]) {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
    console.log(t + ": " + r.rows[0].n + " 件");
  }
  const idx = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname");
  console.log("索引: " + idx.rows.map((r) => r.indexname).join(", "));
  await c.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });