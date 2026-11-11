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

-- 标点类型（对应 data/types.json 的数组元素）
CREATE TABLE IF NOT EXISTS marker_types (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT,
  sort    INTEGER DEFAULT 0,
  created INTEGER
);

-- 标点（对应 data/{typeId}.geojson 的 Feature，props 存 properties JSON）
CREATE TABLE IF NOT EXISTS marker_points (
  id      TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  lng     REAL NOT NULL,
  lat     REAL NOT NULL,
  props   TEXT,
  created INTEGER,
  updated INTEGER
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

-- 密文笔记整包（对应 data/secrets.json，单行 blob，客户端加密）
CREATE TABLE IF NOT EXISTS vault (
  id      TEXT PRIMARY KEY,
  blob    TEXT NOT NULL,
  updated INTEGER
);
