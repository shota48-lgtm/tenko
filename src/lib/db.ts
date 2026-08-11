// DB 接続。チャットの投稿・勤怠は必ずここを通す（HTTP + DB を正とする方針）
import { Pool } from "pg";

const globalForPool = globalThis as unknown as { tenkoPool?: Pool };

export const pool =
  globalForPool.tenkoPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

// dev の HMR で接続が増え続けないよう使い回す
if (process.env.NODE_ENV !== "production") globalForPool.tenkoPool = pool;
