/* 検証用: テーブルの列を表示する。実行: node scripts\show-schema.js read_states */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const table = process.argv[2];

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  if (!table) {
    const r = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    console.log(r.rows.map((x) => x.table_name).join(", "));
  } else {
    const r = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
      [table],
    );
    console.log(table + ": " + r.rows.map((x) => x.column_name + " " + x.data_type).join(" / "));
  }
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
