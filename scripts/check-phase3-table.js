const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const r=await c.query("SELECT to_regclass('public.attendance_drafts') AS t");
 console.log("attendance_drafts の存在: "+(r.rows[0].t?"あり":"なし（POのDDL実行待ち）"));
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});