import { splitIntoSegments } from '../segmenter.js';

/**
 * 阿里百炼（DashScope）云端 TTS 提供方。
 *
 * 走「非实时语音合成（Qwen-TTS）」HTTP 接口：
 *   POST {baseUrl}/api/v1/services/aigc/multimodal-generation/generation
 *   body: { model, input: { text, voice, language_type } }
 *   resp: { output: { audio: { url, data, expires_at } }, usage: { characters } }
 *
 * 约束（官方文档）：
 * - 单次 input.text ≤ 600 字符 → 本模块按 SEGMENT_LIMIT 自动切段
 * - 非流式返回的音频 URL 有效期 24h → 立刻下载成本地文件，不把签名 URL 交给前端
 * - audio.data 为 Base64（非流式也可能返回），优先用 data，其次 url
 */

/** 百炼 qwen3-tts 系统音色（中文名 + voice 参数）。列表来自官方音色页。 */
export const DASHSCOPE_VOICES = [
    { id: 'Cherry', name: '芊悦（Cherry）', gender: 'female', locale: 'zh-CN' },
    { id: 'Serena', name: '苏瑶（Serena）', gender: 'female', locale: 'zh-CN' },
    { id: 'Ethan', name: '晨煦（Ethan）', gender: 'male', locale: 'zh-CN' },
    { id: 'Chelsie', name: '千雪（Chelsie）', gender: 'female', locale: 'zh-CN' },
    { id: 'Momo', name: '茉兔（Momo）', gender: 'female', locale: 'zh-CN' },
    { id: 'Vivian', name: '十三（Vivian）', gender: 'female', locale: 'zh-CN' },
    { id: 'Moon', name: '月白（Moon）', gender: 'male', locale: 'zh-CN' },
    { id: 'Maia', name: '四月（Maia）', gender: 'female', locale: 'zh-CN' },
    { id: 'Kai', name: '凯（Kai）', gender: 'male', locale: 'zh-CN' },
    { id: 'Nofish', name: '不吃鱼（Nofish）', gender: 'male', locale: 'zh-CN' },
    { id: 'Bella', name: '萌宝（Bella）', gender: 'female', locale: 'zh-CN' },
];

/** 单次请求字符上限（官方 600，留标点/切分余量）。 */
const SEGMENT_LIMIT = 540;
const FALLBACK_VOICE = 'Cherry';
const HEALTH_TEXT = '你好';
const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_OK_BACKOFF_MS = 30000;
const HEALTH_FAIL_BACKOFF_MS = 60000;

export class DashScopeProvider {
    kind = 'dashscope';
    label = '百炼';
    /** 分段合成时每段的最大字符数（TTSService.synthesizeSegments 会取 min）。 */
    segmentLimit = SEGMENT_LIMIT;
    /** 未配置 defaultVoice 时的兜底音色。 */
    fallbackVoice = FALLBACK_VOICE;
    audioMime = 'audio/wav';
    healthCache = { at: Number.NEGATIVE_INFINITY, backoff: HEALTH_OK_BACKOFF_MS, ok: true, message: '' };

    constructor(getConfig) {
        this.getConfig = getConfig;
    }

    async listVoices() {
        return DASHSCOPE_VOICES.map((v) => ({ ...v }));
    }

    /**
     * 合成整段文本：超长时自动切段、逐段合成、按 RIFF 拼成一个 WAV。
     * 产出单个 chunk（非流式接口没有增量音频可推）。
     */
    async *stream(text, voice, signal) {
        const parts = splitIntoSegments(text, SEGMENT_LIMIT);
        const buffers = [];
        for (const part of parts) {
            if (signal?.aborted)
                throw abortError();
            buffers.push(await this.synthesizeOne(part, voice, signal));
        }
        if (buffers.length === 0)
            throw new Error('百炼未收到任何音频数据');
        const merged = buffers.length === 1 ? buffers[0] : concatWav(buffers);
        // duration 让聊天里的语音条能显示真实时长（播放器也会用它算总进度）
        yield { mime: this.audioMime, data: merged, sampleRate: 24000, duration: wavSeconds(merged) };
    }

    /** 单段合成：调接口 → 拿 Base64 或 URL → 下载成 Buffer。 */
    async synthesizeOne(text, voice, signal) {
        const cfg = this.getConfig();
        const apiKey = this.apiKey(cfg);
        if (!apiKey) {
            throw new Error('未配置百炼 API Key：请在 设置 → 声音设置 → 云端后端（百炼）里填写，或设置环境变量 DASHSCOPE_API_KEY');
        }
        const base = normalizeBaseUrl(cfg.dashscopeBaseUrl);
        const model = cfg.dashscopeModel || DEFAULT_MODEL;
        const voiceId = voice || cfg.defaultVoice || FALLBACK_VOICE;
        const plan = requestPlan(base, model, text, voiceId, cfg.dashscopeLanguage);
        const timeoutMs = Number.isFinite(cfg.timeout) && cfg.timeout > 0 ? cfg.timeout : 30000;
        const fetchSignal = combineSignal(signal, timeoutMs);
        let resp;
        try {
            resp = await fetch(plan.url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(plan.body),
                signal: fetchSignal,
            });
        }
        catch (e) {
            throw networkError(e);
        }
        const textBody = await resp.text();
        if (!resp.ok) {
            throw httpError(resp.status, textBody, plan.url);
        }
        let json;
        try {
            json = JSON.parse(textBody);
        }
        catch {
            throw new Error(`百炼返回了非 JSON 响应（HTTP ${resp.status}）`);
        }
        const audio = json?.output?.audio ?? {};
        if (typeof audio.data === 'string' && audio.data.length > 0) {
            return Buffer.from(audio.data, 'base64');
        }
        if (typeof audio.url === 'string' && audio.url.length > 0) {
            let audioResp;
            try {
                audioResp = await fetch(audio.url, { signal: combineSignal(signal, timeoutMs) });
            }
            catch (e) {
                throw networkError(e);
            }
            if (!audioResp.ok)
                throw new Error(`下载百炼音频失败（HTTP ${audioResp.status}）`);
            return Buffer.from(await audioResp.arrayBuffer());
        }
        const code = json?.code ? `${json.code} ` : '';
        throw new Error(`百炼未返回音频：${code}${json?.message ?? ''}`.trim());
    }

    /** API Key：配置优先，其次环境变量。 */
    apiKey(cfg) {
        const fromConfig = String(cfg?.dashscopeApiKey ?? '').trim();
        if (fromConfig)
            return fromConfig;
        return String(process.env.DASHSCOPE_API_KEY ?? '').trim();
    }

    /** 试合成 2 字判断可用性；失败按 30s/60s 退避，避免设置页每次打开都打接口。 */
    async health() {
        const now = Date.now();
        if (now - this.healthCache.at < this.healthCache.backoff) {
            return { available: this.healthCache.ok, ...(this.healthCache.message ? { message: this.healthCache.message } : {}) };
        }
        this.healthCache.at = now;
        const cfg = this.getConfig();
        if (!this.apiKey(cfg)) {
            this.healthCache.ok = false;
            this.healthCache.message = '未配置 API Key';
            this.healthCache.backoff = HEALTH_OK_BACKOFF_MS;
            return { available: false, message: this.healthCache.message };
        }
        let timer;
        try {
            const work = (async () => {
                for await (const chunk of this.stream(HEALTH_TEXT, cfg.defaultVoice || FALLBACK_VOICE, undefined)) {
                    if (chunk.data && chunk.data.length > 0)
                        return 'ok';
                }
                throw new Error('试合成未产出音频');
            })();
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('试合成超时')), HEALTH_TIMEOUT_MS);
            });
            await Promise.race([work, timeout]);
            work.catch(() => { });
            this.healthCache.ok = true;
            this.healthCache.message = '';
            this.healthCache.backoff = HEALTH_OK_BACKOFF_MS;
            return { available: true };
        }
        catch (e) {
            this.healthCache.ok = false;
            this.healthCache.message = String(e?.message ?? e).slice(0, 200);
            this.healthCache.backoff = HEALTH_FAIL_BACKOFF_MS;
            return { available: false, message: this.healthCache.message };
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
}

/** 合并上游取消与超时（Node 20+ 的 AbortSignal.any）。 */
function combineSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (signal === undefined)
        return timeout;
    try {
        return AbortSignal.any([signal, timeout]);
    }
    catch {
        return timeout;
    }
}

function abortError() {
    const error = new Error('语音合成已取消');
    error.code = 'TTS_ABORTED';
    return error;
}

/**
 * 规范化接入域名。用户很容易把控制台给的 WebSocket 地址整段粘进来，例如
 * `wss://llm-xxx.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference `，这里统一收成 https 源站。
 */
export function normalizeBaseUrl(raw) {
    let value = String(raw ?? '').trim();
    if (!value)
        return DEFAULT_BASE_URL;
    value = value.replace(/^ws:/iu, 'http:').replace(/^wss:/iu, 'https:');
    if (!/^https?:\/\//iu.test(value))
        value = `https://${value}`;
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}`;
    }
    catch {
        return DEFAULT_BASE_URL;
    }
}

/**
 * 按模型挑接口与请求体：
 * - qwen-audio-* / cosyvoice-* / sambert-* → /services/audio/tts/SpeechSynthesizer（input 带 format/sample_rate）
 * - 其余（qwen3-tts-flash）→ /services/aigc/multimodal-generation/generation（input 带 language_type）
 * 两者响应结构一致：output.audio.url / output.audio.data。
 */
export function requestPlan(base, model, text, voice, language) {
    if (/^(qwen-audio|cosyvoice|sambert)/iu.test(model)) {
        return {
            url: `${base}/api/v1/services/audio/tts/SpeechSynthesizer`,
            body: { model, input: { text, voice, format: 'wav', sample_rate: 24000 } },
        };
    }
    return {
        url: `${base}/api/v1/services/aigc/multimodal-generation/generation`,
        body: { model, input: { text, voice, language_type: language || 'Chinese' } },
    };
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';
const DEFAULT_MODEL = 'qwen3-tts-flash';

function networkError(e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        const error = new Error('百炼请求超时或被取消（检查网络能否直连 dashscope.aliyuncs.com）');
        error.code = 'TTS_TIMEOUT';
        return error;
    }
    const error = new Error(`连接百炼失败：${String(e?.message ?? e)}`);
    error.code = 'TTS_NETWORK';
    return error;
}

/** 从 WAV 头推算时长（秒）；不是 WAV 或字段异常时返回 0。 */
export function wavSeconds(buf) {
    const parsed = parseWav(buf);
    if (parsed === null || parsed.fmt.length < 16)
        return 0;
    const channels = parsed.fmt.readUInt16LE(2) || 1;
    const sampleRate = parsed.fmt.readUInt32LE(4) || 0;
    const bits = parsed.fmt.readUInt16LE(14) || 16;
    const bytesPerFrame = channels * (bits / 8);
    if (sampleRate <= 0 || bytesPerFrame <= 0)
        return 0;
    return Number((parsed.data.length / (sampleRate * bytesPerFrame)).toFixed(2));
}

/** 把 HTTP 失败映射成看得懂的中文原因，并带上服务端原始 message。 */
function httpError(status, rawBody, url) {
    let detail = '';
    let code = '';
    try {
        const parsed = JSON.parse(rawBody);
        code = String(parsed.code ?? '');
        detail = [parsed.code, parsed.message].filter(Boolean).join(': ');
    }
    catch {
        detail = String(rawBody ?? '').slice(0, 200);
    }
    let hint = '';
    if (code === 'Endpoint.AccessDenied') {
        hint = '。这个 API Key 与接入域名不属于同一个业务空间：去控制台「业务空间」确认该 Key 所属空间的专属域名（形如 https://llm-xxxx.cn-beijing.maas.aliyuncs.com），或改用普通 API Key + https://dashscope.aliyuncs.com';
    }
    else if (code === 'Model.AccessDenied') {
        hint = '。该 Key 无权调用这个模型：确认模型已在对应业务空间开通，或换成该空间支持的模型';
    }
    else if (code === 'InvalidApiKey') {
        hint = '。Key 无效或与地域不匹配（北京与新加坡的 Key 不能混用）';
    }
    const label = status === 401
        ? '百炼 API Key 无效或未授权'
        : status === 429
            ? '百炼限流（RPM 180），稍后再试'
            : status === 400
                ? '百炼拒绝了请求参数'
                : `百炼返回 HTTP ${status}${url ? `（${url}）` : ''}`;
    const error = new Error(detail ? `${label}：${detail}${hint}` : `${label}${hint}`);
    error.code = code || `DASHSCOPE_HTTP_${status}`;
    return error;
}

/**
 * 解析 RIFF/WAVE，取出 fmt 与 data 两个块。
 * @returns {{fmt: Buffer, data: Buffer}|null} 非 WAV 返回 null
 */
export function parseWav(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12)
        return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
        return null;
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = Math.min(start + size, buf.length);
        if (id === 'fmt ')
            fmt = buf.subarray(start, end);
        else if (id === 'data')
            data = buf.subarray(start, end);
        offset = start + size + (size % 2); // 块按偶数字节对齐
    }
    if (fmt === null || data === null)
        return null;
    return { fmt, data };
}

function riffChunk(id, payload) {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(payload.length, 4);
    return payload.length % 2 === 1 ? Buffer.concat([head, payload, Buffer.from([0])]) : Buffer.concat([head, payload]);
}

/**
 * 把多段 WAV 拼成一个：沿用首段的 fmt，顺序拼接 data。
 * 任何一段不是 WAV 时退化为字节拼接（例如接口换成 MP3 的情况）。
 */
export function concatWav(buffers) {
    const parsed = buffers.map(parseWav);
    if (parsed.some((p) => p === null))
        return Buffer.concat(buffers);
    const [first] = parsed;
    if (parsed.some((p) => !p.fmt.equals(first.fmt)))
        throw new Error('百炼返回的音频格式不一致，无法拼接长文本');
    const body = Buffer.concat(parsed.map((p) => p.data));
    const payload = Buffer.concat([riffChunk('fmt ', first.fmt), riffChunk('data', body)]);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(payload.length + 4, 4);
    header.write('WAVE', 8, 'ascii');
    return Buffer.concat([header, payload]);
}
