/* ============================================================================
 * 访问统计 · 集中配置（根目录所有页面共用这一份）
 * ----------------------------------------------------------------------------
 * 每个页面统一按以下顺序引入，缺一不可（使用绝对地址，任意目录层级都适用）：
 *
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * 数据全部写入仓库 stats 分支（不产生 master 提交、不触发 Pages 构建）：
 *   data/users.json        用户索引：id + 浏览器指纹 + 首访环境
 *   data/visits/{id}.json  该用户的访问明细数组（页面 / 时间 / 标题 / 来源）
 *
 * 文件里只存明细，不存 total / pages / days 等汇总字段，
 * 各项统计由 manage/stats.html 从明细数组解析得出。
 * 不写 localStorage，失败不做补偿；访客无需注册或登录。
 * ========================================================================== */
window.VISIT_TRACKER_CONFIG = {
    ghBranch: 'stats',                  // 数据所在分支
    usersPath: 'data/users.json',       // 用户索引
    visitsDir: 'data/visits',           // 单用户数据目录（文件名 = 用户 id）

    maxVisits: 500,                     // 单用户保留的访问明细条数（超出丢弃最旧的）

    /* 控制台调试日志（输出 [VisitTracker] 前缀信息）。
       确认上报正常后可改为 false 减少噪音。 */
    debug: true
};
