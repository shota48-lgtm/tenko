/* 設計書の「要実測」項目の実測:
   pg は bigint を JavaScript の何で返すか。Auth.js のアダプタを通した場合も同じか。
   読み取りのみ。書き込みはしない。
   実行: node scripts/probe-id-type.mjs */
import fs from "node:fs";
import pg from "pg";
import PostgresAdapter from "@auth/pg-adapter";

const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });

const { rows } = await pool.query("SELECT id, is_demo FROM users ORDER BY id LIMIT 1");
console.log("素の pg  : id=" + JSON.stringify(rows[0].id) + " typeof=" + typeof rows[0].id +
            " / is_demo=" + JSON.stringify(rows[0].is_demo) + " typeof=" + typeof rows[0].is_demo);

// アダプタの getUser は select * from users where id = $1 を投げる（実装で確認済み）
const adapter = PostgresAdapter(pool);
const u = await adapter.getUser(String(rows[0].id));
console.log("アダプタ : id=" + JSON.stringify(u?.id) + " typeof=" + typeof u?.id);
console.log("アダプタが返した鍵: " + Object.keys(u ?? {}).join(", "));
console.log("  → アダプタは select * なので email も内部に入る。");
console.log("    画面へ出るのは auth.ts の session コールバックが組み立てたものだけである");

await pool.end();
