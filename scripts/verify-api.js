/* api.js 真实环境验证：Node 里加载真实的 utils/api.js，直连线上 Worker + D1，
   跑一遍「读 → 增 → 改 → 删」的完整链路。造出来的数据跑完会自己删掉。

   用法：node scripts/verify-api.js
   需要 Node 18+（全局 fetch）。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'utils', f), 'utf8');

/* api.js 只依赖 window，Node 下把全局对象当作 window 即可 */
global.window = global;

const ctx = vm.createContext(global);
vm.runInContext(read('api.js'), ctx);

const Api = window.Api;
const assert = (name, ok, extra = '') => console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
const API = 'https://ulnae.localhost.cc';
/* 时间由服务端填写，客户端只能期望「接近当前时间」 */
const nearNow = ts => Math.abs(Date.now() - Number(ts)) < 60000;

(async () => {
    /* ---------- 类型 ---------- */
    const types = await Api.markerTypes.list();
    assert('读取类型列表', Array.isArray(types) && types.length > 0, types.map(t => t.name).join('/'));

    /* ---------- 标点：读 → 增 → 改 → 删 ---------- */
    const typeId = types[0].id;
    const before = await Api.markerPoints.list(typeId);
    assert('读取标点列表', Array.isArray(before.features), `${before.features.length} 个`);

    const title = 'API_TEST_' + Date.now();
    await Api.markerPoints.create(typeId, { lng: 116.4, lat: 39.9, title, description: '临时验证' });

    const afterAdd = await Api.markerPoints.list(typeId);
    const mine = afterAdd.features.find(f => f.properties.title === title);
    assert('新增标点并拿到服务端 id', !!mine && !!mine.id, mine && mine.id);
    assert('标点字段为 created / updated',
        !!mine && mine.properties.created > 0 && mine.properties.updated > 0,
        mine && mine.properties.created + '/' + mine.properties.updated);
    assert('标点 created 由服务端填写', !!mine && nearNow(mine.properties.created));

    await Api.markerPoints.update(mine.id, { lng: 116.41, lat: 39.91, title: title + '_改', description: '已改' });
    const afterEdit = await Api.markerPoints.list(typeId);
    const edited = afterEdit.features.find(f => f.id === mine.id);
    assert('更新标点生效',
        !!edited && edited.properties.title === title + '_改' && edited.geometry.coordinates[0] === 116.41,
        edited && edited.geometry.coordinates.join(','));

    await Api.markerPoints.remove(mine.id);
    const afterDel = await Api.markerPoints.list(typeId);
    assert('删除标点后条数复原', afterDel.features.length === before.features.length,
        `${afterDel.features.length} vs ${before.features.length}`);

    /* ---------- 伪造时间：直接打接口，客户端传的 created / updated 不应入库 ---------- */
    const forgedTitle = 'API_TEST_FORGE_' + Date.now();
    const forged = await fetch(API + '/api/marker/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ typeId, lng: 116.45, lat: 39.95, title: forgedTitle, created: 1 }])
    }).then(r => r.json());
    const forgedRow = (await Api.markerPoints.list(typeId)).features.find(f => f.id === forged.ids[0]);
    assert('伪造的 created 被忽略', !!forgedRow && forgedRow.properties.created > 1 && nearNow(forgedRow.properties.created),
        forgedRow && forgedRow.properties.created);

    const forgedUpdated = await fetch(API + '/api/marker/points/' + forged.ids[0], {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: forgedTitle + '_改', updated: 1, created: 1 })
    }).then(r => r.ok);
    const forgedAfter = (await Api.markerPoints.list(typeId)).features.find(f => f.id === forged.ids[0]);
    assert('伪造的 created / updated 改不动',
        forgedUpdated && forgedAfter.properties.created === forgedRow.properties.created && nearNow(forgedAfter.properties.updated));
    await Api.markerPoints.remove(forged.ids[0]);

    /* ---------- 换类型：PATCH typeId，created 不变、updated 刷新 ---------- */
    const ntA = await Api.markerTypes.create({ name: 'API_TEST_A_' + Date.now(), color: '#112233' });
    const ntB = await Api.markerTypes.create({ name: 'API_TEST_B_' + Date.now(), color: '#445566' });
    await Api.markerPoints.create(ntA.id, { lng: 121, lat: 31, title: 'MOVE_TEST' });
    const moved = (await Api.markerPoints.list(ntA.id)).features[0];
    const createdBefore = moved.properties.created;
    const updatedBefore = moved.properties.updated;

    await new Promise(r => setTimeout(r, 20));
    await Api.markerPoints.update(moved.id, { typeId: ntB.id, lng: 121, lat: 31, title: 'MOVE_TEST' });
    const inB = (await Api.markerPoints.list(ntB.id)).features.find(f => f.id === moved.id);
    assert('换类型后出现在新类型下', !!inB);
    assert('换类型不改 created', !!inB && inB.properties.created === createdBefore,
        inB && `${inB.properties.created} vs ${createdBefore}`);
    assert('换类型刷新 updated', !!inB && inB.properties.updated > updatedBefore);
    assert('原类型下已无该点', !(await Api.markerPoints.list(ntA.id)).features.some(f => f.id === moved.id));

    await Api.markerTypes.remove(ntA.id);
    await Api.markerTypes.remove(ntB.id);

    /* ---------- 类型：增 → 写入子标点 → 删（连带标点） ---------- */
    const nt = await Api.markerTypes.create({ name: 'API_TEST_TYPE_' + Date.now(), color: '#123456' });
    assert('新增类型拿到服务端 id', !!nt.id, nt.id);

    await Api.markerPoints.create(nt.id, { lng: 120.1, lat: 30.2, title: '子标点' });
    assert('新类型下标点可写入', (await Api.markerPoints.list(nt.id)).features.length === 1);

    await Api.markerTypes.remove(nt.id);
    assert('删除类型连带删除其下标点', (await Api.markerPoints.list(nt.id)).features.length === 0);
    assert('类型已从列表移除', !(await Api.markerTypes.list()).some(t => t.id === nt.id));

    /* ---------- 反馈：增 → 读 → 删 ---------- */
    const fb = await Api.feedback.create({ type: '测试', content: 'API_TEST 临时反馈 ' + Date.now(), source: 'node-test' });
    const fbList = await Api.feedback.list();
    const fbRow = fbList.find(x => x.id === fb.id);
    assert('反馈写入并可读回', !!fbRow, fb.id);
    assert('反馈 created 由服务端填写', !!fbRow && nearNow(fbRow.created), fbRow && fbRow.created);
    await Api.feedback.remove([fb.id]);
    assert('反馈删除生效', !(await Api.feedback.list()).some(x => x.id === fb.id));

    /* ---------- vault：增 → 改（乐观锁）→ 删 ---------- */
    const v0 = await Api.vault.list();
    assert('读取 vault 列表', Array.isArray(v0), `${v0.length} 条`);

    const created = await Api.vault.create({ title: 'API_TEST', ciphertext: 'xxx' });
    assert('vault 返回 created / updated', !!created.created && !!created.updated && nearNow(created.created),
        created.created + '/' + created.updated);

    let conflict = false;
    try {
        await Api.vault.update(created.id, { title: 'API_TEST', ciphertext: 'yyy' }, -1);
    } catch (e) {
        conflict = e.status === 409;
    }
    assert('过期版本号写入被拒绝（409）', conflict);

    const updated = await Api.vault.update(created.id, { title: 'API_TEST', ciphertext: 'yyy' }, created.updated);
    const row = (await Api.vault.list()).find(x => x.id === created.id);
    assert('vault 更新生效', row && row.ciphertext === 'yyy' && row.updated === updated.updated);

    await Api.vault.remove(created.id);
    assert('vault 删除生效', !(await Api.vault.list()).some(x => x.id === created.id));

    console.log('验证结束');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
