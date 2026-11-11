-- vault 表结构变更：整包 blob（单行）→ 行级存储（一条密文一行）
-- 执行：wrangler d1 execute tools-data --remote --file=migrate-vault-rows.sql
--
-- 幂等说明：重复执行会在第一步因 vault_blob_backup 已存在而报错，属预期；
-- 确认无误后可手动 DROP TABLE vault_blob_backup 清理备份。

-- 1. 旧表改名保留（不直接 DROP，便于回滚核对）
ALTER TABLE vault RENAME TO vault_blob_backup;

-- 2. 建新表
CREATE TABLE IF NOT EXISTS vault (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_updated ON vault(updated_at DESC);

-- 3. 把旧 blob 里的 JSON 数组拆成行
--    旧格式：[{id,title,ciphertext,createdAt,updatedAt}, ...]
INSERT OR IGNORE INTO vault (id, title, ciphertext, created_at, updated_at)
SELECT
  json_extract(j.value, '$.id'),
  COALESCE(json_extract(j.value, '$.title'), ''),
  json_extract(j.value, '$.ciphertext'),
  COALESCE(json_extract(j.value, '$.createdAt'), CAST(strftime('%s','now') AS INTEGER) * 1000),
  COALESCE(json_extract(j.value, '$.updatedAt'), json_extract(j.value, '$.createdAt'), CAST(strftime('%s','now') AS INTEGER) * 1000)
FROM vault_blob_backup AS b, json_each(b.blob) AS j
WHERE b.id = 'main'
  AND json_extract(j.value, '$.id') IS NOT NULL
  AND json_extract(j.value, '$.ciphertext') IS NOT NULL;

-- 4. 核对（应为旧 blob 里的条数）
SELECT COUNT(*) AS rows_imported FROM vault;
