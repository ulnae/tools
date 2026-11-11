-- tools-api D1 建表脚本
-- 执行：wrangler d1 execute tools-data --remote --file=schema.sql
-- 时间戳统一为毫秒整数（与现有 GitHub 数据中的 created/updated/created_at 一致）

-- 访客（fp 为业务主键，id 为 randomUUID）
CREATE TABLE IF NOT EXISTS users (
  id      TEXT PRIMARY KEY,
  fp      TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL DEFAULT 0,
  conf    REAL,
  ua      TEXT,
  screen  TEXT,
  dpr     REAL,
  lang    TEXT,
  tz      TEXT,
  ip      TEXT,            -- 已脱敏：IPv4 保留前三段，IPv6 保留前三组
  country TEXT,
  city    TEXT,
  asn     TEXT,
  asorg   TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_updated ON users(updated DESC);

-- 访问明细
CREATE TABLE IF NOT EXISTS visits (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  day     TEXT NOT NULL,
  page    TEXT,
  path    TEXT,
  title   TEXT,
  ref     TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_visits_day  ON visits(day);

-- 标点类型（对应 data/types.json 的数组元素；按 created 顺序展示，无需排序字段）
CREATE TABLE IF NOT EXISTS marker_types (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT,
  created INTEGER
);

-- 标点（对应 data/{typeId}.geojson 的 Feature）
-- title / description 独立成列，可直接 WHERE / ORDER BY；
-- 类型与创建时间分别由 type_id、created 表示，不重复存。
CREATE TABLE IF NOT EXISTS marker_points (
  id          TEXT PRIMARY KEY,
  type_id     TEXT NOT NULL,
  lng         REAL NOT NULL,
  lat         REAL NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created     INTEGER,
  updated     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_points_type ON marker_points(type_id);

-- 意见反馈（对应 data/feedback.json 数组元素）
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  type       TEXT,
  content    TEXT,
  contact    TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL
);

-- 密文笔记：一行一条（对应 data/secrets.json 的数组元素，客户端加密）
-- 同一条并发编辑用 updated_at 做条件更新，不同条目互不干扰。
CREATE TABLE IF NOT EXISTS vault (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_updated ON vault(updated_at DESC);
