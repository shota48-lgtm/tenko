// 本番の描画コード（コンパイルした render.ts）をそのまま使って PNG を描く。
// プレビューHTMLとは別実装なので、両者が一致するかを比べられる。
const fs=require("fs"), zlib=require("zlib");
const R=require(process.argv[2]+"/compiled/render.js");
const sheet=JSON.parse(fs.readFileSync("src/sprites/variant-a.json","utf8"));
function crc32(b){let c,crc=0xffffffff;for(let n=0;n<b.length;n++){c=(crc^b[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=c^(crc>>>8);}return (crc^0xffffffff)>>>0;}
function chunk(t,b){const l=Buffer.alloc(4);l.writeUInt32BE(b.length);const ty=Buffer.from(t,"ascii");const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([ty,b])));return Buffer.concat([l,ty,b,c]);}
function writePng(f,w,h,rgb){const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;rgb.copy(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);}const i=Buffer.alloc(13);i.writeUInt32BE(w,0);i.writeUInt32BE(h,4);i[8]=8;i[9]=2;fs.writeFileSync(f,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",i),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]));}
const W=R.VILLAGE_W,H=R.VILLAGE_H;
function makeCtx(scale){
  const buf=Buffer.alloc(W*scale*H*scale*3);
  let cur=[0,0,0];
  const ctx={
    imageSmoothingEnabled:true,
    set fillStyle(v){ cur = v==="transparent"?null:[parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16)]; },
    get fillStyle(){return "";},
    fillRect(x,y,w,h){ if(!cur)return; for(let dy=0;dy<h*scale;dy++)for(let dx=0;dx<w*scale;dx++){const px=Math.round(x*scale)+dx,py=Math.round(y*scale)+dy;if(px<0||py<0||px>=W*scale||py>=H*scale)continue;const i=(py*W*scale+px)*3;buf[i]=cur[0];buf[i+1]=cur[1];buf[i+2]=cur[2];} },
    clearRect(){},
  };
  return {ctx,buf};
}
const rooms=[];
for(let i=1;i<=8;i++) rooms.push({id:i,name:"部屋"+i});
const people=[
  {id:1,name:"a",colorIndex:1,state:"talking",roomId:1},
  {id:2,name:"b",colorIndex:2,state:"talking",roomId:1},
  {id:3,name:"c",colorIndex:3,state:"idle",roomId:3},
  {id:4,name:"d",colorIndex:4,state:"away",roomId:null},
  {id:5,name:"e",colorIndex:1,state:"resting",roomId:null},
  {id:6,name:"f",colorIndex:2,state:"idle",roomId:null},
  {id:7,name:"g",colorIndex:3,state:"talking",roomId:5},
  {id:8,name:"h",colorIndex:4,state:"idle",roomId:null},
];
for(const s of [1,2]){
  const {ctx,buf}=makeCtx(s);
  R.drawVillage(ctx,sheet,rooms,people);
  writePng(process.argv[2]+"/prod-village-"+s+"x.png",W*s,H*s,buf);
}
// 地面だけを描いた層を出して、プレビュー側の実装と1ドット単位で比べられるようにする
const {ctx,buf}=makeCtx(1);
R.drawVillage(ctx,sheet,[],[]);
writePng(process.argv[2]+"/prod-ground.png",W,H,buf);
fs.writeFileSync(process.argv[2]+"/prod-ground.raw",buf);
console.log("本番コードで描画: "+W+"x"+H+" / 部屋 "+rooms.length+" / 人 "+people.length);