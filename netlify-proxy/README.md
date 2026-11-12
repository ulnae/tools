# netlify-proxy/ 目录说明

这个目录不是网站的一部分，它是一个**反向代理站**：把 `https://ulnae.localhost.cc/api/*`
原样转发给 Cloudflare Worker。整个目录只有两个文件，部署到 Netlify 后就成了全站的前端 API 入口。

---

## 一、为什么需要它

Cloudflare Worker 的默认域名 `tools-api.yyh3531.workers.dev` 在国内**基本不可用**：

| 尝试 | 结果 |
|---|---|
| 直连 `*.workers.dev` | DNS 被污染（解析到 `173.236.212.42` 等无关地址 + IPv6 黑洞），实测 **12 秒超时** |
| 给 `localhost.cc` 子域加 CNAME → `workers.dev`（灰云） | TLS 握手失败，证书签发不下来 |
| 同上但开橙云 | Cloudflare **错误 1014**（CNAME 跨账号指向 Worker 不被允许） |
| 用 Workers Custom Domain | 做不到：`localhost.cc` 平台只开放 A/AAAA/CNAME/TXT/MX，**不能 NS 委派**，域无法接管进 Cloudflare |

实测延迟对比：`localhost.cc` 直连 239ms、`netlify.app` 0.6s、`workers.dev` 12s 超时。
于是方案定为——**用 Netlify 做一层免费反代**，访客只碰 Netlify 的 IP，不碰被污染的 `workers.dev`。

最终链路：

```
浏览器
  └─ https://ulnae.localhost.cc        （CNAME → quiet-pasca-17521d.netlify.app）
       └─ Netlify Edge                 （按 _redirects 转发，不改请求）
            └─ https://tools-api.yyh3531.workers.dev
                 └─ Worker（读取 D1、CORS、限流）
                      └─ D1 (SQLite)
```

前端代码里只认 `https://ulnae.localhost.cc`（见 `utils/api.js` 的 `apiBase`），
Worker 的 `workers.dev` 地址只在这一层的 `_redirects` 里出现一次。

---

## 二、两个文件

### `_redirects` —— 唯一真正干活的文件

```
/api/*  https://tools-api.yyh3531.workers.dev/api/:splat  200!
```

逐段拆开：

| 片段 | 含义 |
|---|---|
| `/api/*` | 匹配 `/api/` 开头的任意路径 |
| `https://.../api/:splat` | `:splat` 是通配符捕获到的剩余部分，原样拼到目标后面。`/api/vault` → 目标 `/api/vault` |
| `200` | 用 200 状态码返回（而非 301/302 重定向），浏览器地址栏不变、也不产生额外往返 |
| `!` | **强制**代理：即使站点里存在同名静态文件，也优先走这条规则 |

>`200!` 这个组合是关键。少了 `!`，一旦以后有人在目录里放了 `api/xxx` 文件，规则会被静态文件顶掉；
>换成 `301`/`302`，POST 请求会丢 body，标点增删改全部失效。

**代理保留什么**：请求方法、请求体、自定义请求头、响应头（含 Worker 返回的 `Access-Control-Allow-*`）。
所以 CORS 仍然由 Worker 决定，Netlify 只是透明转发。

### `index.html` —— 链路自检页

访问 `https://ulnae.localhost.cc/` 就是这个页面。它跑在**反代域名自己的源**下，
所以 `fetch('/api/health')` 是**同源请求**，能单独验证「域名 → Netlify → Worker → D1」这一段，
不受 GitHub Pages 那边的 CORS 干扰。

按钮只有一个：**测试 `/api/health`**（GET，只读）。返回 `{ok:true, time, colo}` 且耗时 < 1.5s → 绿色，链路通。

> 建议在**手机 4G（关掉 WiFi）**下打开测——那才是访客的真实网络环境，家宽走代理可能看不出污染。
> 需要逐地址诊断时用站点根下的 `ping_test.html`，功能更全。

---

## 三、怎么部署（首次或重装）

Netlify 这里用的是**手动拖拽部署**，不接 git，所以本目录就是唯一事实来源。

1. Netlify → **Add new site → Deploy manually**，把**本目录里的内容**（不是外层 `netlify-proxy` 文件夹）拖进去
   - 站点名形如 `quiet-pasca-17521d`，即 `https://quiet-pasca-17521d.netlify.app`
2. **关掉站点保护**：Site configuration → Access & security，关闭 Password protection / Edge Access
   - 没关会一直 **401**，且外部看不到任何提示，很容易误判成 Worker 挂了
3. **加自定义域**：Domain management → Add a domain → `ulnae.localhost.cc`
   - 必须在这一步做完，Netlify 才会去申请 Let's Encrypt 证书；没加域就不会有证书，访问报 TLS 错误
4. **回 `localhost.cc` 控制台加 CNAME**：
   ```
   ulnae  CNAME  quiet-pasca-17521d.netlify.app
   ```
   - ⚠️ 这里踩过坑：填成 `yyh3531.workers.dev` 是错的，那是 Worker 的域名，不是 Netlify 的
5. 等证书签发（通常几分钟），然后打开 `https://ulnae.localhost.cc/` 点两个按钮验证

**改完要重新拖**：拖拽部署是快照。改了 `_redirects` 后必须在 Netlify 的 Deploys 页面把目录重新拖一次，
否则线上还是旧规则。

---

## 四、验证（命令行版）

```bash
# 链路 + 出口机房
curl -sD - https://ulnae.localhost.cc/api/health
# 期望：HTTP 200, Content-Type: application/json, {"ok":true,...}
# 响应头里 Cf-Ray 结尾是 Worker 落地的机房（实测 -SIN 新加坡），
# Cache-Status 会写 "Netlify Edge"，两者同时出现说明确实穿过了两层

# CORS 预检（前端写操作能不能过）
curl -sD - -o /dev/null -X OPTIONS https://ulnae.localhost.cc/api/feedback \
  -H "Origin: https://ulnae.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
# 期望：204 + Access-Control-Allow-Origin: https://ulnae.github.io

# 静态页与路径边界
curl -s -o /dev/null -w "%{http_code}\n" https://ulnae.localhost.cc/          # 200（自检页）
curl -s -o /dev/null -w "%{http_code}\n" https://ulnae.localhost.cc/whatever  # 404（Netlify 无此文件）
```

实测耗时（2026-11-11 连续 5 次 `/api/health`）：`0.52s / 0.93s / 1.05s / 1.17s / 1.37s`，中位约 1 秒。
比直连 Worker 多一跳，但比 `workers.dev` 的 12 秒超时好得多。

---

## 五、几个必须知道的取舍

1. **反代会「藏住」访客信息**。Worker 里 `request.cf` 的地理/网络字段描述的是
   Netlify 边缘节点那一跳，不是访客本人。目前业务里没有用得到这些信息的端点，
   但将来若要按地区做事，记得先想清楚这一层。
2. **不要把业务逻辑写进这里**。`_redirects` 只能做路径改写和少量头操作，写不了条件判断。
   需要改 CORS、加鉴权、做熔断，都得改 Worker，或者把这里升级成 Edge Function（代码量立刻上来了）。
4. **别在这层做缓存**。API 响应都是实时的；`Cache-Status: fwd=miss` 才是正常状态，
   如果哪天看到命中，说明有人给 `/api/*` 加了缓存规则，会导致读到旧数据。
5. **Netlify 免费额度**：带宽 100GB/月、构建 300 分钟/月（以官网为准）。反代流量算带宽，
   以这个站的量级远远用不完，但别拿它扛大流量。

---

## 六、换掉这一层时要改哪里

如果将来有了能 NS 委派的自有域名，可以直接上 Cloudflare（Workers 自定义域），把这个目录删掉：

1. Worker 绑自定义域
2. `utils/api.js` 的 `apiBase` 换成新域名
3. 删掉本目录、Netlify 站点、`localhost.cc` 的 CNAME
4. 用 `ping_test.html` 重新验证一遍连通性

反过来，如果只是**换 Worker 地址**，要同时改两处：本目录 `_redirects` 的目标，以及 `utils/api.js` 的 `apiBase`。
