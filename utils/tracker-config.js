/* ============================================================================
 * 访问统计 · 集中配置（根目录所有页面共用这一份）
 * ----------------------------------------------------------------------------
 * 每个页面统一按以下顺序引入，缺一不可（使用绝对地址，任意目录层级都适用）：
 *
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * 数据链路：浏览器 → Cloudflare Worker（ulnae.localhost.cc）→ D1
 *   users 表   一人一行：浏览器指纹 + 首访环境 + 最近访问时间
 *   visits 表  一次访问一行：页面 / 时间 / 标题 / 来源
 *
 * 不写 localStorage，失败不做补偿；访客无需注册或登录。
 * Worker 地址由 utils/api.js 内置（apiBase），这里不必重复配置。
 * ========================================================================== */
window.VISIT_TRACKER_CONFIG = {
    /* 单用户展示用的访问明细上限（服务端本身按 500 条返回） */
    maxVisits: 500,

    /* 控制台调试日志（输出 [VisitTracker] 前缀信息）。
       确认上报正常后可改为 false 减少噪音。 */
    debug: true
};
