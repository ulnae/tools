/* ============================================================================
 * 访问统计 · 集中配置（根目录所有页面共用这一份）
 * ----------------------------------------------------------------------------
 * 每个页面统一按以下顺序引入，缺一不可（使用绝对地址，任意目录层级都适用）：
 *
 *   <script src="https://ulnae.github.io/tools/utils/tracker-config.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fp.min.js"></script>
 *   <script src="https://ulnae.github.io/tools/utils/fingerprint.js"></script>
 *
 * 数据写入仓库 stats 分支的 data/visits.json：不产生 master 提交、
 * 不触发 Pages 构建，访客无需注册或登录。
 * ========================================================================== */
window.VISIT_TRACKER_CONFIG = {
    /* GitHub 共享存储：设 false 则只写访客本机的 localStorage */
    github: true,
    ghBranch: 'stats',                // 数据所在分支
    ghPath: 'data/visits.json',       // 数据文件路径

    /* 控制台调试日志（输出 [VisitTracker] 前缀信息）。
       确认上报正常后可改为 false 减少噪音。 */
    debug: true
};
