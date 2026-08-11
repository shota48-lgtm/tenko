const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 console.log("更新前: "+JSON.stringify((await c.query("SELECT id,name,kind FROM rooms ORDER BY id")).rows));
 await c.query("UPDATE rooms SET kind='hall' WHERE id=2");
 console.log("更新後: "+JSON.stringify((await c.query("SELECT id,name,kind FROM rooms ORDER BY id")).rows));
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});