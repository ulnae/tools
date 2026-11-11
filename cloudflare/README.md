# cloudflare/ 目录说明

这里是整个工具站的**后端**：一个 Cloudflare Worker + 一个 D1（SQLite）数据库。
前端页面（`https://ulnae.github.io/tools/*`）不直连数据库，而是通过 `utils/api.js` 调
`https://ulnae.localhost.cc`（Netlify 反代 → `tools-api.yyh3531.workers.dev` → Worker → D1）。

本文只讲 `cloudflare/` 下的文件分别是干什么的、什么时候该用、怎么用。
页面侧怎么调用接口见根目录 `README.md`；中间那层反代的来龙去脉见 `../netlify-proxy/README.md`。

---

## 一、目录一览

| 文件 | 类型 | 一句话用途 |
|---|---|---|
| `wrangler.toml` | 配置 | Worker 名、D1 绑定、CORS 白名单、反代开关、限流 |
| `src/worker.js` | 源码 | 全部 HTTP 接口（访客统计 / 标点 / 反馈 / 密文 / 管理） |
| `schema.sql` | 建表脚本 | 从零建出 6 张表 + 5 个索引（即当前线上结构） |
| `backup-20261111.sql` | 数据快照 | 某一时刻的整库导出，回滚/查证用，只读存档 |
| `.wrangler/` | 本地临时目录 | 测试脚本、导出的 JSON 备份、wrangler 本地状态 |

---

## 二、`schema.sql` —— 建表脚本

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

**关键限制**：它**只能补建缺失的表，不能修改已有表的结构**。
线上要调结构时，先改 `schema.sql`（它是唯一的结构事实来源），再在线上单独执行 `ALTER TABLE ...`。
SQLite 不支持随意改列，通常是「建新表 → 搬数据 → `DROP` 旧表 → `RENAME`」；
注意 D1 不允许在 SQL 文件里写 `BEGIN/COMMIT`。

**什么时候会用到**：
- 换 Cloudflare 账号 / 换 D1 库，需要重新初始化
- 本地起 `wrangler dev` 想造一套空表
- 想在别人的环境里复现这套后端

---

## 三、`backup-20261111.sql` —— 数据快照（只读存档）

**来源**：`wrangler d1 export tools-data --remote --output=backup-20261111.sql` 的产物，
开头那句 `PRAGMA defer_foreign_keys=TRUE;` 是导出器的签名。

**内容**：2026-11-11 某一时刻的整库导出，含当时的建表语句与全部行。

**用途**：回滚参照。想知道「某条数据原来是什么值」时查它，不要去猜。
它**不是**常规执行脚本，直接在已有库上跑会因表已存在而失败。真要恢复：

```bash
# A. 恢复到空库（新建一个 D1，改名后导入）
wrangler d1 execute tools-recover --remote --file=backup-20261111.sql

# B. 只取某张表的数据做补录：手工摘出 INSERT 语句后执行
```

日常更该用的是 D1 的**时间旅行**（见下文命令速查），比翻旧 dump 方便得多。

---

## 四、当前线上状态（2026-11-11 17:26 核对）

```
表                    行数   说明
users                   0    访客档案
visits                  0    访问明细
marker_types            5    美食 / 风景 / 钓点 / 避雷 / 游玩
marker_points          36    标点
feedback                1    反馈
vault                   4    密文条目（VPN / 454645645 / Token / 电影网址）
```

6 张表与 `schema.sql` 完全一致，无多余的历史表。

**注意**：`users` / `visits` 现在是 0，而当天早些时候是 3 / 28。
全站唯一能把这两张表清空的代码路径是 `POST /api/admin/clear`，
而它自「去掉管理端鉴权」起对公网完全开放（`manage/stats.html` 的「清空全部」按钮走的就是它）。
如果不是手动点的，那就是这条无鉴权的接口被扫到了——建议后续给它加个来源校验，
或者干脆把按钮改成需要输入确认文本。

---

## 五、常用命令速查

> 全部在 `cloudflare/` 目录下执行。**`--remote` / `--local` 只差一个参数，后果完全不同**：
> 漏写 `--remote` 时改的是本地 sqlite，线上毫无变化，很容易误判「改了没生效」。

```bash
# 查数据（--json 便于管道给 node/jq）
wrangler d1 execute tools-data --remote --json --command="SELECT COUNT(*) FROM marker_points"

# 执行 SQL 文件（建表 / 回填）
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

## 六、维护建议

1. **定期导出备份**：结构稳定后一个月一次 `d1 export` 足够；改动结构前必须导一次
2. **改结构的两处同步**：`schema.sql`（事实来源）+ 线上 `ALTER`，缺一个就会出现
   「新库能建、老库对不上」
3. **保持库表与 schema.sql 一致**：库里出现 `schema.sql` 之外的表时，多半是历史遗留，
   确认无用就 `DROP`，别让它一直躺在 `sqlite_master` 里误导后来的人
4. **给管理写接口加护栏**：`/api/admin/clear`、`POST /api/admin/feedback/delete`、
   `DELETE /api/admin/users/:id` 目前无任何校验。最小成本的收口是校验 `Origin`
   是否为 `https://ulnae.github.io`，能挡掉跨站调用和爬虫，不影响自己的页面
5. **写 `wrangler.toml` 的坑**：`TRUST_PROXY = "true"` 只在走 Netlify 反代时正确；
   哪天改回直连 `workers.dev` 或绑自定义域，必须改回 `false`，否则访客 IP 会被 `X-Forwarded-For` 伪造
