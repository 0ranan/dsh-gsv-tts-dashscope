import test from 'node:test';
import assert from 'node:assert/strict';
import { TTSService, withDeadline } from '../lib/tts.service.js';
import { concatWav, parseWav, DASHSCOPE_VOICES, DashScopeProvider } from '../lib/providers/dashscope.js';
import { activeKind, snapshotConfig } from '../lib/config.js';

/** 最小 WAV：44 字节头 + PCM。 */
function makeWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
    header.writeUInt16LE(channels * (bits / 8), 32);
    header.writeUInt16LE(bits, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

const silentPcm = (bytes) => Buffer.alloc(bytes, 0);
const store = {
    save: (name) => ({ url: `/a/${name}`, name }),
    saveRaw: (name) => ({ url: `/a/${name}`, name }),
};

const baseCfg = {
    provider: 'edge',
    cloudBackend: 'edge',
    defaultVoice: '',
    timeout: 300,
    dashscopeApiKey: '',
};

test('withDeadline: 永不 settle 的工作会按时抛超时', async () => {
    const started = Date.now();
    await assert.rejects(
        withDeadline(new Promise(() => { }), 200, '语音合成', undefined),
        /语音合成超时（200ms）/,
    );
    assert.ok(Date.now() - started < 2000, '应当在时限附近返回');
});

test('withDeadline: 上游 abort 立即取消', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
        withDeadline(new Promise(() => { }), 5000, '语音合成', controller.signal),
        /已取消/,
    );
});

test('synthesize: 云端 provider 挂住时不会拖死会话', async () => {
    const hanging = {
        kind: 'edge',
        label: 'Edge',
        fallbackVoice: 'x',
        stream: async function* () { await new Promise(() => { }); },
    };
    const service = new TTSService(() => ({ ...baseCfg }), store, { edge: hanging, dashscope: hanging });
    await assert.rejects(service.synthesize('你好', undefined), /超时/);
});

test('synthesize: provider 报错时原样抛出，不被超时掩盖', async () => {
    const failing = {
        kind: 'edge',
        label: 'Edge',
        fallbackVoice: 'x',
        stream: async function* () { throw new Error('云端通道 500'); },
    };
    const service = new TTSService(() => ({ ...baseCfg }), store, { edge: failing, dashscope: failing });
    await assert.rejects(service.synthesize('你好', undefined), /云端通道 500/);
});

test('concatWav: 拼接后数据长度等于各段之和且头合法', () => {
    const a = makeWav(silentPcm(100));
    const b = makeWav(silentPcm(60));
    const merged = concatWav([a, b]);
    const parsed = parseWav(merged);
    assert.ok(parsed, '拼接结果应当是合法 WAV');
    assert.equal(parsed.data.length, 160);
    assert.equal(merged.readUInt32LE(4), merged.length - 8, 'RIFF 长度字段应等于总长 - 8');
    assert.equal(parsed.fmt.length, 16);
});

test('concatWav: 遇到非 RIFF 输入退化为字节拼接', () => {
    const merged = concatWav([Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
    assert.deepEqual([...merged], [1, 2, 3, 4, 5]);
});

test('synthesizeSegments: 分片不超过后端上限（百炼 540）', async () => {
    const seen = [];
    const provider = {
        kind: 'dashscope',
        label: '百炼',
        fallbackVoice: 'Cherry',
        segmentLimit: 540,
        stream: async function* (text) {
            seen.push(text.length);
            yield { mime: 'audio/wav', data: makeWav(silentPcm(20)) };
        },
    };
    const cfg = { ...baseCfg, provider: 'edge', cloudBackend: 'dashscope', timeout: 5000 };
    const service = new TTSService(() => cfg, store, { dashscope: provider, edge: provider });
    const text = '这是一句话。'.repeat(200); // 1200 字符
    const result = await service.synthesizeSegments(text, undefined);
    assert.ok(result.segments.length > 1, '长文本应当被分片');
    assert.equal(result.error, undefined, `不应有分片失败：${result.error}`);
    assert.ok(seen.every((n) => n <= 540), `每片都应 ≤540，实际 ${seen.join(',')}`);
    assert.equal(seen.reduce((a, b) => a + b, 0), text.length, '分片不丢字符');
});

test('dashscope: 缺 API Key 时给出可操作提示', async () => {
    const provider = new DashScopeProvider(() => ({ ...baseCfg, dashscopeApiKey: '' }));
    const previous = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
        await assert.rejects(async () => {
            for await (const _chunk of provider.stream('你好', 'Cherry')) { /* 不应产出 */ }
        }, /未配置百炼 API Key/);
    }
    finally {
        if (previous !== undefined)
            process.env.DASHSCOPE_API_KEY = previous;
    }
});

test('config: activeKind 由 provider + cloudBackend 决定', () => {
    assert.equal(activeKind({ provider: 'gsv' }), 'gsv');
    assert.equal(activeKind({ provider: 'edge', cloudBackend: 'edge' }), 'edge');
    assert.equal(activeKind({ provider: 'edge', cloudBackend: 'dashscope' }), 'dashscope');
    assert.equal(activeKind({ provider: 'edge', cloudBackend: 'bogus' }), 'edge', '非法值回落 edge');
});

test('config: snapshotConfig 为旧配置补齐云端后端字段', () => {
    const snap = snapshotConfig({ provider: 'edge' });
    assert.equal(snap.cloudBackend, 'edge');
    assert.equal(snap.dashscopeModel, 'qwen3-tts-flash');
    assert.equal(snap.dashscopeBaseUrl, 'https://dashscope.aliyuncs.com');
    assert.equal(snap.dashscopeLanguage, 'Chinese');
});

test('dashscope: 音色表包含官方音色 id', () => {
    const ids = DASHSCOPE_VOICES.map((v) => v.id);
    for (const id of ['Cherry', 'Ethan', 'Serena', 'Moon'])
        assert.ok(ids.includes(id), `缺少音色 ${id}`);
});

test('normalizeBaseUrl: 容忍 wss:// 粘贴、路径与空格', async () => {
    const { normalizeBaseUrl } = await import('../lib/providers/dashscope.js');
    assert.equal(normalizeBaseUrl('wss://llm-sampleworkspaceid.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference '),
        'https://llm-sampleworkspaceid.cn-beijing.maas.aliyuncs.com');
    assert.equal(normalizeBaseUrl('  https://dashscope.aliyuncs.com/api/v1/  '), 'https://dashscope.aliyuncs.com');
    assert.equal(normalizeBaseUrl('llm-x.cn-beijing.maas.aliyuncs.com'), 'https://llm-x.cn-beijing.maas.aliyuncs.com');
    assert.equal(normalizeBaseUrl(''), 'https://dashscope.aliyuncs.com');
});

test('requestPlan: qwen-audio 走 SpeechSynthesizer，qwen3 走 multimodal', async () => {
    const { requestPlan } = await import('../lib/providers/dashscope.js');
    const a = requestPlan('https://x.example', 'qwen-audio-3.0-tts-flash', '你好', 'longanfengyue', 'Chinese');
    assert.match(a.url, /\/api\/v1\/services\/audio\/tts\/SpeechSynthesizer$/);
    assert.deepEqual(a.body.input, { text: '你好', voice: 'longanfengyue', format: 'wav', sample_rate: 24000 });
    const b = requestPlan('https://x.example', 'qwen3-tts-flash', '你好', 'Cherry', 'Chinese');
    assert.match(b.url, /multimodal-generation\/generation$/);
    assert.deepEqual(b.body.input, { text: '你好', voice: 'Cherry', language_type: 'Chinese' });
});
