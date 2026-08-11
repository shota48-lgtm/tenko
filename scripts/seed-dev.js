const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("INSERT INTO users (display_name, role) VALUES ('テスト太郎', 'member')");
  await c.query("INSERT INTO rooms (name) VALUES ('オフィス')");
  await c.query("INSERT INTO room_members (room_id, user_id) VALUES (1, 1)");
  console.log("users:", (await c.query("SELECT id, display_name, role FROM users")).rows);
  console.log("rooms:", (await c.query("SELECT id, name FROM rooms")).rows);
  await c.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });