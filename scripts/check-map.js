const m = require("../src/village/map.json");
const cx=m.roads.v[0], cy=m.roads.h[0];
const name=["左上","右上","左下","右下"];
const qi=(s)=>(s.x<cx?0:1)+(s.y<cy?0:2);
console.log("枠の並び順(先頭12): " + m.buildingSlots.slice(0,12).map(s=>name[qi(s)]).join(" "));
for (const n of [4,8,12,20,26]) {
  const q=[0,0,0,0];
  m.buildingSlots.slice(0,n).forEach(s=>q[qi(s)]++);
  console.log("部屋 "+String(n).padStart(2)+" 件 -> 左上"+q[0]+" 右上"+q[1]+" 左下"+q[2]+" 右下"+q[3]);
}
console.log("装飾 " + m.deco.length + " 個 / 枠 " + m.buildingSlots.length);