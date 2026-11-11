# scripts/ 目录说明

这里的脚本**不参与站点运行**——没有任何页面引用它们，只在本地手动执行。
两个都是工具：一个负责「代码怎么推上去」，一个负责「推上去之前先验一遍」。

> 注意：仓库根目录就是 GitHub Pages 的发布根，所以这个目录连同下面的脚本对公网可读
> （`https://ulnae.github.io/tools/scripts/xxx.js` 返回 200）。好在两个脚本都不含任何凭据，
> token 一律走环境变量。**别在里面写死密钥。**

---

## 一、`push-via-api.js` —— 推送兜底通道

**解决的问题**：本机代理到 `github.com:443` 不通，`git push` 一直报
`CONNECT tunnel failed, response 502`，但 `api.github.com` 能正常访问。

**做法**：绕过 git 协议，改用 GitHub 的 **Git Data API** 手工重建提交：

```
1. 读远端 master 的 head，确认它是本地 HEAD 的祖先（否则说明有分叉，直接退出）
2. rev-list 出 remoteHead..HEAD 的提交列表，从旧到新逐个重放
3. 每个提交：上传改动文件的 blob → 以父提交的树为 base_tree 建树
             → 用原始的 author / committer / message 建提交
4. 每一步都校验 GitHub 算出的 tree sha 与 commit sha 是否和本地完全一致
5. 全部命中后 PATCH 分支引用
```

**为什么不是强推、也不会分叉**：commit sha 是对「树 + 父提交 + 作者 + 时间 + 消息」的哈希，
只要这些逐字节重建成功，GitHub 算出来的 sha 必然与本地相同。所以最后那一步是**快进**，
历史与本地完全同构。

```bash
GH_TOKEN=github_pat_xxx node scripts/push-via-api.js
```

**权限**：细粒度 PAT 需要 `Contents: Read and write`（Git Data API 属于写操作）。

**能力边界**：

| 情况 | 是否支持 |
|---|---|
| 一次推多个提交 | ✅ 逐个重放 |
| 删除文件 | ✅ 树里对应路径传 `sha: null` |
| 改名的文件 | ✅ 按删除 + 新增处理 |
| 远端有本地没有的提交（分叉） | ❌ 直接报错退出，需先合并 |
| 二进制大文件 | ✅ base64 上传，但受 API 体积限制 |

**失败时看哪句**：报 `远端 xxx 不是本地 HEAD 的祖先` → 本地落后或分叉，先同步；
报 `tree sha 不匹配` → 某个文件的工作区内容与 git 对象不一致（常见是换行符），先 `git add` 再跑。

---

## 二、`verify-store.js` —— 存储层冒烟测试

**验证对象**：`utils/api.js` + `utils/store.js` 这一对，跑的是**真实链路**
（`ulnae.localhost.cc` 反代 → Worker → D1），不是 mock。

**做法**：Node 里给 `window` / `sessionStorage` / `document` 打桩，把两个文件 `vm.runInContext`
进去，然后按页面真实用法调 `Store.getFile / updateFile / appendFeedback`。
所以它验的是「页面会怎么用」，而不只是「接口能不能通」。

```bash
node scripts/verify-store.js
```

**8 项检查**：

| 检查 | 说明 |
|---|---|
| 读取类型列表 | 类型数量与名称 |
| 无修改回写不产生写入 | 内容没变时不应产生任何 POST/PATCH，这是幂等性的底线 |
| 新增标点并拿到服务端 id | 页面不传 id，id 必须由服务端生成并在回读结果里返回 |
| 删除标点后条数复原 | 删除路径生效且不误伤 |
| 反馈写入并可读回 | `appendFeedback` 走公开端点 |
| 反馈删除生效 | 清理 |
| 读取 vault 数组 | 行级存储拼回数组 |
| vault 回写后仍可解析 | 原样回写不破坏数据 |

**副作用**：会往线上写数据，但会自己清干净——造的标点和反馈会被删掉，vault 只做原样回写
（内容不变 → 不产生写入）。

**什么时候该跑**：改完 `utils/store.js`、`utils/api.js`、`cloudflare/src/worker.js`，
或动过 D1 表结构之后。**部署页面之前跑一次**，比在浏览器里点半天快得多。

**前提**：Node 18+（内置 `fetch`）；能访问 `ulnae.localhost.cc`。

---

## 三、怎么选

| 我遇到的情况 | 用哪个 |
|---|---|
| `git push` 报 502 / 连接超时 | `push-via-api.js` |
| 改完存储层，想确认没把页面搞坏 | `verify-store.js` |
| 怀疑接口挂了、想区分是 Worker 还是反代的问题 | 都不是，用 `ping_test.html` |
| 想查/改数据库里的数据 | 都不是，用 `wrangler d1 execute`（见 `cloudflare/README.md`） |

---

## 四、另有两组临时测试脚本

`cloudflare/.wrangler/` 下还有两个同类脚本，验证的是更细的点：

- `test-v2.js` —— 接口结构层：类型无 `sort`、标点无 `props`、客户端 id 被忽略、PATCH 扁平入参
- `test-server-id.js` —— store 层：新增类型/标点/vault 时服务端发号的完整链路

它们**没有纳入版本管理**（`.wrangler/` 在 `.gitignore` 里），属于一次性验证留档，
重装环境就没了。如果想长期保留，可以搬进本目录并按 `verify-*.js` 的方式改成相对路径。
