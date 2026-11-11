# cloudflare/ 目录说明

这里是整个工具站的**后端**：一个 Cloudflare Worker + 一个 D1（SQLite）数据库。
前端页面（`https://ulnae.github.io/tools/*`）不直连数据库，而是通过 `utils/api.js` 调
`https://ulnae.localhost.cc`（Netlify 反代 → `tools-api.yyh3531.workers.dev` → Worker → D1）。

本文只讲 `cloudflare/` 下的文件分别是干什么的、什么时候该用、怎么用。
页面侧怎么调用接口见根目录 `README.md`。

---

## 一、目录一览

| 文件 | 类型 | 当前状态 | 一句话用途 |
|---|---|---|---|
| `wrangler.toml` | 配置 | **使用中** | Worker 名、D1 绑定、CORS 白名单、反代开关、限流 |
| `src/worker.js` | 源码 | **使用中** | 全部 HTTP 接口（访客统计 / 标点 / 反馈 / 密文 / 管理） |
| `schema.sql` | 建表脚本 | **保留**，重建库时用 | 从零建出 6 张表 + 5 个索引（最新结构） |
| `migrate-schema-v2.sql` | 迁移脚本 | **已执行完**，勿再跑 | 删 `marker_types.sort`、把 `marker_points.props` 拆成列 |
| `migrate-vault-rows.sql` | 迁移脚本 | **已执行完**，勿再跑 | `vault` 由「整包 blob 单行」改为「一条密文一行」 |
| `backup-20261111.sql` | 数据备份 | 只读存档 | 迁移前的整库导出（旧结构 + 当时的数据） |
| `.wrangler/` | 本地临时目录 | 可随时重建 | 测试脚本、迁移前导出的 JSON 备份、wrangler 本地状态 |

> 一句话原则：`schema.sql` 描述「现在应该长什么样」，`migrate-*.sql` 是「从过去走到现在的那一步」，
> `backup-*.sql` 是「走之前拍的照片」。只有 `schema.sql` 是长期有效、可以反复执行的。

---

## 二、四个 SQL 文件逐个说明

### 1. `schema.sql` —— 从零建库（长期有效）

**用途**：在**空库**上建立全部表。共 6 张表 + 5 个索引：

| 表 | 存什么 | 主键 | 前端对应 |
|---|---|---|---|
| `users` | 访客档案（指纹、UA、屏幕、时区、脱敏 IP、地区） | `id`（UUID），`fp`（指纹）唯一 | `utils/fingerprint.js` |
| `visits` | 访问明细（谁、何时、哪个页面、来源） | `id` | 同上 |
| `marker_types` | 标点类型（名称、颜色） | `id` | `marker.html` / `manage/marker.html` |
| `marker_points` | 标点坐标 + 标题 + 描述 | `id` | 同上 |
| `feedback` | 意见反馈（类型、内容、联系方式、来源页） | `id` | `feedback.html` / `manage/feedback.html` |
| `vault` | 密文笔记（标题 + 客户端加密后的密文） | `id` | `vault.html` |

```bash
# 远端（真实库）
wrangler d1 execute tools-data --remote --file=schema.sql

# 本地（wrangler dev 用的本地 sqlite，改了不碰线上）
wrangler d1 execute tools-data --local --file=schema.sql
```

**幂等性**：是。所有语句都是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
重复执行不会报错、也不会改动已存在的表。

**关键限制**：它**只能补建缺失的表**，不能修改已有表的结构。
所以「线上表结构不对」时跑它是没用的——那要靠 `migrate-*.sql`，或者手写 `ALTER`。

**什么时候会用到**：
- 换 Cloudflare 账号 / 换 D1 库，需要重新初始化
- 本地起 `wrangler dev` 想造一套空表
- 想在别人的环境里复现这套后端

---

### 2. `migrate-schema-v2.sql` —— 删 `sort`、拆 `props`（一次性，已完成）

**解决的三个问题**：
1. `marker_types.sort` 全表恒为 0，页面从来没有排序 UI → 删列
2. `marker_points.props` 存整段 properties JSON，实际只有 `title` / `description` 两个业务字段 → 拆成独立列
3. `props` 里的 `type` 和 `created_at` 早就由 `type_id`、`created` 列表示了 → 直接丢弃，不再重复存

**做法**（SQLite 不支持随便改列，所以走「建新表 → 搬数据 → 换名」）：

```
CREATE TABLE marker_types_v2 (...)          -- 新结构
INSERT ... SELECT ... FROM marker_types     -- 搬数据
DROP TABLE marker_types                     -- 删旧表
ALTER TABLE marker_types_v2 RENAME TO marker_types
```

**⚠️ 不要重复执行**：`CREATE TABLE marker_types_v2` 没有 `IF NOT EXISTS`，第二次跑必然报
`table marker_types_v2 already exists` 然后中断。这不是 bug，是刻意的「只此一次」保护。

**坑（已踩过，记在这里）**：老数据的 `created` 列存的是**导入时刻**，真实创建时间在
`props.created_at` 里。所以搬数据时必须 `COALESCE(json_extract(props,'$.created_at'), created)`，
反过来会让所有标点的时间变成迁移当天。首次就是取反了，事后用备份 JSON 回填修正了 36 条。

**怎么确认它跑对了**：

```bash
# 结构：不应再有 sort / props
wrangler d1 execute tools-data --remote --json \
  --command="SELECT name, sql FROM sqlite_master WHERE name IN ('marker_types','marker_points')"

# 数据：行数应与迁移前一致，且 title/description 无明显丢失
wrangler d1 execute tools-data --remote --json \
  --command="SELECT type_id, COUNT(*) c, SUM(title='') empty_title FROM marker_points GROUP BY type_id"
```

---

### 3. `migrate-vault-rows.sql` —— 密文由整包改为行级（一次性，已完成）

**改造前**：`vault` 只有一行 `id='main'`，`blob` 字段存整个 JSON 数组。
问题很直接——改一条笔记要「整包读、整包写」，两个设备同时改不同条目会互相覆盖，
而且每次编辑都在重写全部密文。

**改造后**：一条密文一行，`id / title / ciphertext / created_at / updated_at`。
新增、编辑、删除互不干扰；同一条并发编辑靠 `updated_at` 做条件更新（不匹配返回 409）。

**做法**：
1. 旧表 `RENAME` 为 `vault_blob_backup`（不直接 DROP，留着核对）
2. 建新表
3. 用 `json_each(blob)` 把数组拆成行插进去
4. 末尾 `SELECT COUNT(*)` 打印导入条数，和旧数组长度比一下

**⚠️ 不要重复执行**：第一步 `RENAME` 会因 `vault_blob_backup` 已存在而失败——这是预期行为，
见到报错说明它已经跑过了。

**遗留物**：`vault_blob_backup` 现在还留在库里（1 行，即那份旧 blob）。核对无误后可以清掉：

```bash
wrangler d1 execute tools-data --remote --command="DROP TABLE vault_blob_backup"
```

> 清理前建议先 `wrangler d1 export` 导一份，毕竟它是密文的原始形态（客户端加密的，导出来也读不了明文）。

---

### 4. `backup-20261111.sql` —— 迁移前的整库照片（只读存档）

**来源**：`wrangler d1 export tools-data --remote --output=backup-20261111.sql` 的产物，
开头那句 `PRAGMA defer_foreign_keys=TRUE;` 就是导出器的签名。

**内容**：**迁移前**的旧结构（`marker_types.sort`、`marker_points.props`、`vault.blob` 都还在），
加上当时的数据（1 个访客、1 条访问、0 条标点——标点是后来才迁进来的）。

**用途**：回滚参照。想知道「某个字段原来长什么样」「某条数据原来是什么值」时查它，
不要去猜。它**不是**常规执行脚本，直接在已有库上跑会因表已存在而失败。

真要拿它恢复，只有两种姿势：

```bash
# A. 恢复到空库（新建一个 D1，改名后导入）
wrangler d1 execute tools-recover --remote --file=backup-20261111.sql

# B. 只取某张表的数据做补录：手工摘出 INSERT 语句，改表名后执行
```

日常更该用的是 D1 的**时间旅行**（见下文命令速查），比翻旧 dump 方便得多。

---

## 三、当前线上状态（2026-11-11 17:20 核对）

```
表                    行数   说明
users                   0    访客档案
visits                  0    访问明细
marker_types            5    美食 / 风景 / 钓点 / 避雷 / 游玩
marker_points          36    标点
feedback                1    反馈
vault                   4    密文条目（VPN / 454645645 / Token / 电影网址）
vault_blob_backup       1    旧 blob，待清理
```

**注意**：`users` / `visits` 现在是 0，而当天早些时候是 3 / 28。
全站唯一能把这两张表清空的代码路径是 `POST /api/admin/clear`，
而它自「去掉管理端鉴权」起对公网完全开放（`manage/stats.html` 的「清空全部」按钮走的就是它）。
如果不是你自己点的，那就是这条无鉴权的接口被扫到了——建议后续给它加个来源校验，
或者干脆把按钮改成需要输入确认文本。

---

## 四、常用命令速查

> 全部在 `cloudflare/` 目录下执行。**`--remote` / `--local` 只差一个参数，后果完全不同**：
> 漏写 `--remote` 时改的是本地 sqlite，线上毫无变化，很容易误判「改了没生效」。

```bash
# 查数据（--json 便于管道给 node/jq）
wrangler d1 execute tools-data --remote --json --command="SELECT COUNT(*) FROM marker_points"

# 执行 SQL 文件（建表 / 迁移 / 回填）
wrangler d1 execute tools-data --remote --file=schema.sql

# 查看表结构
wrangler d1 execute tools-data --remote --json \
  --command="SELECT name, sql FROM sqlite_master WHERE type='table'"

# 整库导出（备份）
wrangler d1 export tools-data --remote --output=backup-$(date +%Y%m%d).sql

# 时间旅行：查当前 bookmark / 恢复
wrangler d1 time-travel info tools-data --remote
wrangler d1 time-travel restore tools-data --remote --bookmark=<bookmark>

# 本地开发库（wrangler dev 用，与线上隔离）
wrangler d1 execute tools-data --local --file=schema.sql
```

**时间旅行**是 D1 自带的后悔药：默认保留 30 天内的任意时间点，`restore` 是**整库回滚**，
会把之后所有表的改动一起退掉——恢复前务必先 `export` 一份当前状态。

---

## 五、维护建议

1. **清理遗留表**：`DROP TABLE vault_blob_backup`（确认行级 vault 数据无误后再做）
2. **归档一次性脚本**：两个 `migrate-*.sql` 已完成使命，可以移到 `cloudflare/archive/`，
   避免以后误以为是「还没跑过的脚本」；它们留在根目录的唯一价值是记录「为什么这样改」
3. **定期导出备份**：数据结构稳定后，一个月一次 `d1 export` 足够；改动结构前必须导一次
4. **给管理写接口加护栏**：`/api/admin/clear`、`POST /api/admin/feedback/delete`、
   `DELETE /api/admin/users/:id` 目前无任何校验。最小成本的收口是校验 `Origin`
   是否为 `https://ulnae.github.io`，能挡掉跨站调用和爬虫，不影响自己的页面
5. **写 `wrangler.toml` 的坑**：`TRUST_PROXY = "true"` 只在走 Netlify 反代时正确；
   哪天改回直连 `workers.dev` 或绑自定义域，必须改回 `false`，否则访客 IP 会被 `X-Forwarded-For` 伪造
