const fs=require("fs"); const {Client}=require("pg");
const line=fs.readFileSync(".env.local","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
const url=line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g,"");
const APPLY = process.argv.includes("--apply");
(async()=>{const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const rows=(await c.query("SELECT user_id, body FROM daily_notes ORDER BY user_id")).rows;
 const bad=rows.filter(r=>/なりすまし|偽装|DROP TABLE|テスト$|alert\(1\)/.test(r.body));
 console.log("今日やること: "+rows.length+" 件。うち検証の痕跡: "+bad.length+" 件");
 bad.forEach(r=>console.log("  user="+r.user_id+" 「"+r.body+"」"));
 if(!APPLY){console.log("--apply を付けると消す。今回は消していない");await c.end();return;}
 for(const r of bad) await c.query("DELETE FROM daily_notes WHERE user_id=$1",[r.user_id]);
 console.log("消した件数: "+bad.length);
 console.log("残り: "+(await c.query("SELECT count(*)::int n FROM daily_notes")).rows[0].n+" 件");
 await c.end();})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});