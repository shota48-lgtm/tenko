const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const before=(await c.query("SELECT count(*)::int n FROM rooms WHERE deleted_at IS NULL")).rows[0].n;
 await c.query("INSERT INTO rooms (name) VALUES ($1) ON CONFLICT DO NOTHING",["会議室"]);
 const after=(await c.query("SELECT id,name FROM rooms WHERE deleted_at IS NULL ORDER BY id")).rows;
 console.log("rooms: "+before+" 件 -> "+after.length+" 件 / "+JSON.stringify(after));
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});