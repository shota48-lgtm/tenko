const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const p=(await c.query("SELECT id FROM attendance_drafts WHERE status='pending' LIMIT 1")).rows[0];
 const r=await c.query("DELETE FROM attendance_drafts WHERE id=$1",[p.id]);
 console.log("DELETE の rowCount: "+r.rowCount+"（0 なら行は消えていない）");
 console.log("消したはずの行: "+JSON.stringify((await c.query("SELECT id,status FROM attendance_drafts WHERE id=$1",[p.id])).rows));
 // トリガー関数の定義を確認
 const f=(await c.query("SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname='attendance_drafts_freeze_decided'")).rows[0].d;
 console.log("--- トリガー関数 ---"); console.log(f);
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});