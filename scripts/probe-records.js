const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const r=(await c.query("SELECT id,status,return_reason,returned_by FROM attendance_records WHERE status<>'approved' ORDER BY id")).rows;
 console.log("承認済み以外の記録: "+JSON.stringify(r));
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});