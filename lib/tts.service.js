import { TextCleaner, MAX_TEXT_LENGTH, MAX_SEGMENTED_TEXT_LENGTH, SEGMENT_MAX_CHARS } from './text-cleaner.js';
import { splitIntoSegments } from './segmenter.js';
import { GsvProvider } from './providers/gsv.js';
import { EdgeProvider } from './providers/edge.js';
import { DashScopeProvider } from './providers/dashscope.js';
import { activeKind } from './config.js';
let fileCounter = 0;
const EDGE_FALLBACK_VOICE = 'zh-CN-XiaoxiaoNeural';
/**
 * 为一段异步工作加硬性截止时间。
 *
 * DSH 的工具超时是协作式的（只给 exec.signal 装 deadline，然后 await 工具本身），
 * 而 edge-tts-universal 的 stream() 不响应 abort，一旦它挂住，工具 promise 永不 settle，
 * 整个 step 会被 agent-loop 的 `await Promise.race(inFlight)` 拖死。
 * 因此这里必须自己 race：让调用方拿到可捕获的错误，而不是把会话一起陪葬。
 *
 * @param work 被保护的工作
 * @param ms 截止时间（毫秒；非正数表示不设限）
 * @param label 出现在错误文案里的动作名
 * @param signal 上游取消信号
 */
export function withDeadline(work, ms, label, signal) {
    if (work === null || work === undefined || typeof work.then !== 'function')
        return work;
    if (!Number.isFinite(ms) || ms <= 0)
        return work;
    let timer;
    let onAbort;
    const racers = [
        work,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError(label, ms)), ms);
        }),
    ];
    if (signal !== undefined) {
        racers.push(new Promise((_resolve, reject) => {
            onAbort = () => reject(abortError(label));
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }));
    }
    // 败者（尤其是永不 settle 的 work）不能被当成未处理拒绝抛出
    work.catch(() => { });
    return Promise.race(racers).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
        if (signal !== undefined && onAbort !== undefined)
            signal.removeEventListener('abort', onAbort);
    });
}
/** 超时错误：带上可操作的提示，而不是一句 "timeout"。 */
function timeoutError(label, ms) {
    const error = new Error(`${label}超时（${ms}ms）：云端通道没有返回结果。可在 设置 → 声音设置 → 请求超时 调大，或切换后端。`);
    error.code = 'TTS_TIMEOUT';
    return error;
}
function abortError(label) {
    const error = new Error(`${label}已取消`);
    error.code = 'TTS_ABORTED';
    return error;
}
export class TTSService {
    getConfig;
    audioStore;
    voiceManager;
    gsv;
    edge;
    dashscope;
    /**
     * @param getConfig 读取当前生效配置（DSH 0.2+ 设置为 volatile 就地更新，
     *   因此每次调用都要重新读取，不能缓存配置快照）。
     */
    constructor(getConfig, audioStore, opts) {
        this.getConfig = getConfig;
        this.audioStore = audioStore;
        this.voiceManager = opts?.voiceManager;
        this.gsv = opts?.gsv ?? new GsvProvider({ getConfig: () => this.getConfig(), voiceManager: opts?.voiceManager });
        this.edge = opts?.edge ?? new EdgeProvider();
        this.dashscope = opts?.dashscope ?? new DashScopeProvider(getConfig);
    }
    /** 当前生效的提供方 kind：gsv / edge / dashscope。 */
    resolveKind(kind) {
        return kind ?? activeKind(this.getConfig());
    }
    provider(kind) {
        const resolved = this.resolveKind(kind);
        if (resolved === 'dashscope')
            return this.dashscope;
        return resolved === 'edge' ? this.edge : this.gsv;
    }
    /** 当前提供方音色列表（gsv = 本地预设；edge = 精选微软声音；dashscope = 百炼音色）。 */
    listVoices(kind) {
        return this.provider(kind).listVoices();
    }
    /** 当前提供方健康（edge = 试合成退避；gsv = 引擎状态；dashscope = 试合成退避）。 */
    health(kind) {
        return this.provider(kind).health();
    }
    /** 单次合成整段（tts_speak / 试听路径）。voice 可为预设对象（gsv）或音色 id（edge / dashscope）。 */
    async synthesize(text, voice, signal, kind) {
        const cleanText = TextCleaner.clean(text);
        if (!cleanText)
            throw new Error('文本清洗后为空，无法合成');
        if (cleanText.length > MAX_TEXT_LENGTH) {
            throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_TEXT_LENGTH}），请分段朗读`);
        }
        const cfg = this.getConfig();
        const p = this.provider(kind);
        if (p.kind === 'gsv') {
            const preset = typeof voice === 'string' ? this.voiceManager?.get(voice) : voice;
            if (!preset)
                throw new Error('未指定音色预设');
            // gsv 自带 AbortSignal.timeout，但本地 fetch 也可能卡住，同样兜一层
            return withDeadline(this.synthesizeGsv(cleanText, preset, signal), cfg.timeout, '语音合成', signal);
        }
        if (typeof voice === 'object' && voice !== null) {
            throw new Error('云端模式不支持本地音色预设，请在音色下拉选择云端声音');
        }
        return withDeadline(this.synthesizeCloud(cleanText, typeof voice === 'string' ? voice : undefined, signal, p), cfg.timeout, '语音合成', signal);
    }
    /** 渐进分段合成（朗读按钮 / 自动朗读路径）：按 provider 逐段合成，段间 0 静音。 */
    async synthesizeSegments(text, voice, signal) {
        const cleanText = TextCleaner.clean(text);
        if (!cleanText)
            throw new Error('文本清洗后为空，无法合成');
        if (cleanText.length > MAX_SEGMENTED_TEXT_LENGTH) {
            throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_SEGMENTED_TEXT_LENGTH}），请分段朗读`);
        }
        // 段长按提供方上限取小值：百炼单次只收 600 字符
        const limit = Math.min(this.provider().segmentLimit ?? SEGMENT_MAX_CHARS, SEGMENT_MAX_CHARS);
        const parts = splitIntoSegments(cleanText, limit);
        const segments = [];
        let totalLen = 0;
        let error;
        for (let i = 0; i < parts.length; i++) {
            try {
                const r = await this.synthesize(parts[i], voice, signal);
                segments.push({ url: r.audioUrl, duration: r.audioLen });
                totalLen += r.audioLen;
            }
            catch (e) {
                if (signal?.aborted)
                    throw e; // 取消/超时：整次失败，丢弃半成品
                error = `第 ${i + 1}/${parts.length} 段合成失败：${String(e?.message ?? e)}`;
                break;
            }
        }
        return { segments, totalLen, error };
    }
    async synthesizeGsv(cleanText, preset, signal) {
        const chunks = [];
        let totalDuration = 0;
        for await (const chunk of this.gsv.streamWithPreset(cleanText, preset, signal)) {
            if (chunk.mime.startsWith('audio/pcm') && chunk.sampleRate) {
                chunks.push({ base64: Buffer.from(chunk.data).toString('base64'), sampleRate: chunk.sampleRate });
            }
            if (chunk.totalDuration)
                totalDuration = chunk.totalDuration;
        }
        if (chunks.length === 0)
            throw new Error('未收到任何音频数据');
        const saved = this.audioStore.save(`tts_${Date.now()}_${(fileCounter++).toString(36)}.wav`, chunks);
        return { audioUrl: saved.url, audioLen: totalDuration, filename: saved.name };
    }
    /**
     * 云端通用落地：provider.stream 产出原始音频字节 → 本地落盘。
     * edge = MP3 透传，dashscope = WAV 透传（长文本已在 provider 内拼好）。
     */
    async synthesizeCloud(cleanText, voiceId, signal, provider) {
        const id = voiceId || this.getConfig().defaultVoice || provider.fallbackVoice;
        const parts = [];
        let mime = provider.audioMime ?? 'audio/mpeg';
        let audioLen = 0;
        for await (const chunk of provider.stream(cleanText, id, signal)) {
            if (chunk.data && chunk.data.length > 0) {
                parts.push(Buffer.from(chunk.data));
                if (typeof chunk.mime === 'string')
                    mime = chunk.mime;
            }
            if (typeof chunk.duration === 'number' && Number.isFinite(chunk.duration))
                audioLen = chunk.duration;
        }
        if (parts.length === 0)
            throw new Error(`${provider.label ?? '云端'} 未返回音频数据（云端通道可能不可用）`);
        const ext = mime.includes('wav') ? 'wav' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'bin';
        const saved = this.audioStore.saveRaw(`tts_${Date.now()}_${(fileCounter++).toString(36)}.${ext}`, Buffer.concat(parts));
        return { audioUrl: saved.url, audioLen, filename: saved.name };
    }
}
//# sourceMappingURL=tts.service.js.map
