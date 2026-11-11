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

-- 标点类型（对应 data/types.json 的数组元素；按 created 顺序展示）
-- 原 sort 字段已删除：页面从未提供排序功能，值恒为 0，纯冗余。
CREATE TABLE IF NOT EXISTS marker_types (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT,
  created INTEGER
);

-- 标点（对应 data/{typeId}.geojson 的 Feature）
-- 原 props 字段存整段 properties JSON，实际只有 title / description 两个业务字段，
-- 而 type 与 created_at 早已由 type_id、created 列表示，故改为独立列存放，
-- 不再有 JSON 解析成本，也能直接 WHERE / ORDER BY。
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
-- 旧版是「整包 blob 单行」，已由 migrate-vault-rows.sql 拆分为行级存储。
-- 一条一条存的好处：新增/编辑/删除互不干扰，不再需要「整包读-整包写」，
-- 多设备同时操作不同条目不会互相覆盖；同一条并发编辑用 updated_at 做条件更新。
CREATE TABLE IF NOT EXISTS vault (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_updated ON vault(updated_at DESC);
