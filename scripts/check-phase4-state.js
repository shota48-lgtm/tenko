const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 console.log("利用者: "+JSON.stringify((await c.query("SELECT id,display_name,role,manager_id FROM users ORDER BY id")).rows));
 console.log("勤怠記録: "+JSON.stringify((await c.query("SELECT id,user_id,kind,work_date::text d,status,approved_by FROM attendance_records ORDER BY id")).rows));
 console.log("下書き: "+JSON.stringify((await c.query("SELECT id,user_id,kind,status FROM attendance_drafts ORDER BY id")).rows));
 console.log("発言数: "+(await c.query("SELECT count(*)::int n FROM messages")).rows[0].n);
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});