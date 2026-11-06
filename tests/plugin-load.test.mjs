import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 用最小假宿主跑一遍 apply()，确保：
 * - Config schema 能接受新字段
 * - 工具与 HTTP 路由都注册成功
 * - 迁移守卫不需要真实 loader 也不报错
 */
function fakeHost() {
    const tools = [];
    const routes = [];
    const listeners = [];
    const updates = [];
    const disposers = [];
    const ctx = {
        fiber: { entry: { options: { id: 'dsh-gsv-tts' } } },
        root: { loader: { await: async () => { } } },
        effect(fn) {
            const dispose = fn();
            if (typeof dispose === 'function')
                disposers.push(dispose);
            return () => { };
        },
        on(event, handler) {
            listeners.push({ event, handler });
            return () => { };
        },
        webServer: {
            register(route) { routes.push(route); return () => { }; },
            getOrigin: () => 'http://127.0.0.1:3080',
        },
        tools: { register(tool) { tools.push(tool); } },
        settings: { update: async (id, patch) => { updates.push([id, patch]); return true; } },
        logger: { info() { }, warn() { }, debug() { } },
    };
    return { ctx, tools, routes, listeners, updates };
}

// 这个文件需要宿主侧的 peer 依赖（@deepseek-ai/dsh-tools、@deepseek-ai/schemastery）。
// 在独立仓库里它们通常不可解析，此时整体跳过而不是报失败。
const hostDeps = await import('../lib/index.js').then(
    (mod) => ({ ok: true, mod }),
    (error) => ({ ok: false, error }),
);
const skip = hostDeps.ok ? false : `缺少宿主依赖：${hostDeps.error.message}`;

test('apply(): 注册全部工具与路由，且 Config 接受云端后端字段', { skip }, async () => {
    const plugin = hostDeps.mod;
    const host = fakeHost();
    const config = plugin.Config({
        provider: 'edge',
        cloudBackend: 'dashscope',
        dashscopeApiKey: 'sk-test',
        dashscopeModel: 'qwen3-tts-flash',
        dashscopeLanguage: 'Chinese',
        timeout: 30000,
    });
    await plugin.apply(host.ctx, config);

    const names = host.tools.map((t) => t.name).sort();
    for (const expected of ['tts_speak', 'tts_list_voices', 'tts_health_check', 'tts_setup_engine'])
        assert.ok(names.includes(expected), `缺少工具 ${expected}（实际：${names.join(',')}）`);

    const paths = host.routes.map((r) => r.path);
    for (const expected of ['/dsh-gsv-tts/provider/voices', '/dsh-gsv-tts/provider/health', '/dsh-gsv-tts/provider/preview', '/dsh-gsv-tts/speak'])
        assert.ok(paths.includes(expected), `缺少路由 ${expected}`);

    // 迁移守卫不应把已合法的 provider 再写一遍
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(host.updates.length, 0, `不应写回设置：${JSON.stringify(host.updates)}`);
});

test('apply(): 旧配置（没有 provider）会补写一次 provider', { skip }, async () => {
    const plugin = hostDeps.mod;
    const host = fakeHost();
    const config = plugin.Config({});
    await plugin.apply(host.ctx, config);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(host.updates.length >= 1, '应当写回 provider');
    assert.ok(host.updates[0][1].provider === 'edge' || host.updates[0][1].provider === 'gsv');
});

test('Config: cloudBackend 只接受 edge / dashscope', { skip }, async () => {
    const plugin = hostDeps.mod;
    // volatile 字段返回引用对象（带 get），这里只验证枚举校验本身
    assert.doesNotThrow(() => plugin.Config({ cloudBackend: 'dashscope' }));
    assert.doesNotThrow(() => plugin.Config({ cloudBackend: 'edge' }));
    assert.throws(() => plugin.Config({ cloudBackend: 'nope' }));
});
