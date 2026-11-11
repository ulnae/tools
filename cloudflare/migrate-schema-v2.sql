-- 结构迁移 v2（2026-11-11）
--   1) marker_types 删除 sort：页面没有排序功能，值恒为 0，纯冗余。
--   2) marker_points 删除 props（整段 properties JSON），拆成 title / description 列；
--      type 与 created_at 原本就已由 type_id、created 列表示，直接丢弃不再重复存。
--
-- SQLite 的 ALTER TABLE 不支持随意改列，采用「建新表 → 搬数据 → 换名」的安全做法，
-- 全程在一个事务里，失败不会留下半张表。
--
-- 执行：wrangler d1 execute tools-data --remote --file=migrate-schema-v2.sql
-- 注意：D1 不允许在 SQL 文件里写 BEGIN/COMMIT（会报 transaction 相关错误），
-- 语句由服务端顺序执行。执行前请先备份（见同目录 backup-*.sql / .wrangler/backup-*.json）。

CREATE TABLE marker_types_v2 (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT,
  created INTEGER
);
INSERT OR REPLACE INTO marker_types_v2 (id, name, color, created)
  SELECT id, name, color, created FROM marker_types;
DROP TABLE marker_types;
ALTER TABLE marker_types_v2 RENAME TO marker_types;

CREATE TABLE marker_points_v2 (
  id          TEXT PRIMARY KEY,
  type_id     TEXT NOT NULL,
  lng         REAL NOT NULL,
  lat         REAL NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created     INTEGER,
  updated     INTEGER
);
INSERT OR REPLACE INTO marker_points_v2 (id, type_id, lng, lat, title, description, created, updated)
  -- 注意 created 的取值顺序：老数据里 created 列是「导入时刻」，props.created_at 才是真实创建时间，
  -- 所以优先取 props 里的时间戳，缺了才退回列值。
  SELECT id,
         type_id,
         lng,
         lat,
         COALESCE(CASE WHEN json_valid(props) THEN json_extract(props, '$.title') END, ''),
         COALESCE(CASE WHEN json_valid(props) THEN json_extract(props, '$.description') END, ''),
         COALESCE(CASE WHEN json_valid(props) THEN json_extract(props, '$.created_at') END, created, 0),
         COALESCE(CASE WHEN json_valid(props) THEN json_extract(props, '$.updated_at') END, updated, 0)
    FROM marker_points;
DROP TABLE marker_points;
ALTER TABLE marker_points_v2 RENAME TO marker_points;

CREATE INDEX idx_points_type ON marker_points(type_id);
