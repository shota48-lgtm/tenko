const API = "http://localhost:3000";
(async () => {
  for (const u of [2, 3]) {
    const r = await fetch(API + "/api/notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "なりすまし試行 " + u, user: u }),
    });
    const j = await r.json().catch(() => ({}));
    console.log("user=" + u + " を指定 -> status=" + r.status + " 実際に書かれた先=" + (j.note ? j.note.user_id : JSON.stringify(j)));
  }
})();