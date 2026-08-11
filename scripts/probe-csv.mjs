import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const { toCsv } = await import(pathToFileURL(join(here, "..", "src", "lib", "monthly-format.ts")).href);
const sample = {
  user: { id: 5, display_name: "検証 部下" },
  year: 2026, month: 8,
  rows: [
    { work_date: "2026-08-11", arrive_at: "09:05", leave_at: "18:20", break_count: 1, late_count: 0, approved_count: 3, unapproved_count: 0, has_unapproved: false },
    { work_date: "2026-08-12", arrive_at: "10:00", leave_at: null,   break_count: 0, late_count: 1, approved_count: 0, unapproved_count: 2, has_unapproved: true },
  ],
  total: { work_days: 2, late_days: 1, break_total: 1, approved: 3, unapproved: 2 },
};
process.stdout.write(toCsv(sample));