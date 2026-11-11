/* store.js 真实环境验证（Node 侧打桩 DOM，直连线上 Worker 与 D1） */
const fs = require('fs');
const vm = require('vm');

global.window = global;
global.sessionStorage = {
    _d: {},
    getItem(k) { return this._d[k] == null ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
global.document = {
    currentScript: { src: 'https://ulnae.github.io/tools/utils/store.js' },
    createElement: () => ({}),
    head: { appendChild() { /* api.js 已手动注入，不需要真正插入 */ } }
};

const ctx = vm.createContext(global);
vm.runInContext(fs.readFileSync('F:/demo/tools/utils/api.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('F:/demo/tools/utils/store.js', 'utf8'), ctx);

const Store = window.Store;
const CFApi = window.CFApi;
const assert = (name, ok, extra = '') => console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));

(async () => {
    await Store.init();

    /* ---------- 类型 ---------- */
    const types = await Store.getFile('data/types.json');
    assert('读取类型列表', Array.isArray(types.content) && types.content.length === 5,
        JSON.stringify(types.content.map(t => t.name)));

    /* ---------- 标点：读 + 无修改回写 ---------- */
    const typeId = types.content[0].id;
    const fc0 = (await Store.getFile(`data/${typeId}.geojson`)).content;
    console.log(`类型「${types.content[0].name}」标点数: ${fc0.features.length}`);

    const t0 = Date.now();
    const same = await Store.updateFile(`data/${typeId}.geojson`, c => c, 'noop', 4, 'marker');
    assert('无修改回写不产生写入', same.content.features.length === fc0.features.length,
        `${Date.now() - t0}ms, 条数 ${same.content.features.length}`);

    /* ---------- 标点：新增（页面新建的 feature 没有 id） ---------- */
    const marker = 'STORE_TEST_' + Date.now();
    const added = await Store.updateFile(`data/${typeId}.geojson`, c => {
        c.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [116.4, 39.9] },
            properties: { title: marker, description: '临时验证', type: typeId, created_at: Date.now() }
        });
        return c;
    }, 'add', 4, 'marker');
    const newFeat = added.content.features.find(f => f.properties && f.properties.title === marker);
    assert('新增标点并拿到服务端 id', !!newFeat && !!newFeat.id, newFeat && newFeat.id);

    /* ---------- 标点：删除 ---------- */
    const del = await Store.updateFile(`data/${typeId}.geojson`, c => {
        c.features = c.features.filter(f => !(f.properties && f.properties.title === marker));
        return c;
    }, 'del', 4, 'marker');
    assert('删除标点后条数复原', del.content.features.length === fc0.features.length,
        `${del.content.features.length} vs ${fc0.features.length}`);

    /* ---------- 反馈：新增 + 删除 ---------- */
    const fb = await Store.appendFeedback({ type: '测试', content: 'STORE_TEST 临时反馈 ' + Date.now(), source: 'node-test' });
    const list = (await Store.getFile('data/feedback.json')).content;
    const mine = list.find(x => x.id === fb.id);
    assert('反馈写入并可读回', !!mine, fb.id);
    await CFApi.deleteFeedback([fb.id]);
    const list2 = (await Store.getFile('data/feedback.json')).content;
    assert('反馈删除生效', !list2.some(x => x.id === fb.id));

    /* ---------- vault：读 + 原样回写 ---------- */
    const v0 = (await Store.getFile('data/secrets.json')).content;
    assert('读取 vault 数组', Array.isArray(v0), `条数 ${v0.length}`);
    const v1 = await Store.updateFile('data/secrets.json', () => v0, 'noop', 4, 'vault');
    assert('vault 回写后仍可解析', Array.isArray(v1.content) && v1.content.length === v0.length);

    console.log('验证结束');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
