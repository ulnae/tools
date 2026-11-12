-- tools-api D1 建表脚本
-- 执行：wrangler d1 execute tools-data --remote --file=schema.sql
-- 时间戳统一为毫秒整数

-- 标点类型（列表按 created 顺序返回，无需排序字段）
CREATE TABLE IF NOT EXISTS marker_types (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT,
  created INTEGER
);

-- 标点（一行一个点，读取时按 type_id 拼成 GeoJSON FeatureCollection）
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

-- 意见反馈（公开提交，created_at 由服务端填写）
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  type       TEXT,
  content    TEXT,
  contact    TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL
);

-- 密文笔记：一行一条，内容在客户端加密
-- 同一条并发编辑用 updated_at 做条件更新，不同条目互不干扰。
CREATE TABLE IF NOT EXISTS vault (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_updated ON vault(updated_at DESC);
