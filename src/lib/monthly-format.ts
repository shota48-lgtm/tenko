// 月次の整形。DB に触れないため、単体で確認できる。
// これは給与計算の根拠になりうる出力である。丸めない。推測しない。無い値は空欄のままにする。

export type MonthlyRow = {
  work_date: string;
  arrive_at: string | null;
  leave_at: string | null;
  break_count: number;
  late_count: number;
  approved_count: number;
  unapproved_count: number;
  has_unapproved: boolean;
};

export type MonthlyResult = {
  user: { id: number; display_name: string };
  year: number;
  month: number;
  rows: MonthlyRow[];
  total: {
    work_days: number;
    late_days: number;
    break_total: number;
    approved: number;
    unapproved: number;
  };
};

const csvCell = (v: string | number | null) => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toCsv(m: MonthlyResult): string {
  const lines: string[] = [];
  lines.push(`# tenko 勤怠記録,${m.user.display_name}(id=${m.user.id}),${m.year}年${String(m.month).padStart(2, "0")}月`);
  if (m.total.unapproved > 0) {
    lines.push(`# 注意,未承認の記録が ${m.total.unapproved} 件含まれます。締めの判断に使う前に承認状況を確認してください`);
  } else {
    lines.push(`# 注意,未承認の記録はありません`);
  }
  lines.push("日付,出社,退勤,休憩回数,遅刻,承認済み,未承認,未承認あり");
  for (const r of m.rows) {
    lines.push([
      r.work_date, r.arrive_at, r.leave_at, r.break_count, r.late_count,
      r.approved_count, r.unapproved_count, r.has_unapproved ? "あり" : "",
    ].map(csvCell).join(","));
  }
  lines.push("");
  lines.push(`合計,出社日数 ${m.total.work_days},遅刻日数 ${m.total.late_days},休憩回数 ${m.total.break_total},承認済み ${m.total.approved},未承認 ${m.total.unapproved}`);
  return lines.join("\n") + "\n";
}
