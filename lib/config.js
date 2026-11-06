/** 默认值（与 Config Schema 保持一致；用于无值/精简宿主兜底）。 */
export const DEFAULT_API_URL = 'http://localhost:9880';
export const DEFAULT_INSTALL_DIR = './GSV-TTS-Lite';
export const DEFAULT_VOICE_REGISTRY_URL = 'https://taoruiliu19.github.io/gsv-market/voices.json';
export const SCHEMA_VERSION = 1;
/** 云端（快速体验）后端：edge = 微软 Edge TTS；dashscope = 阿里百炼 Qwen3-TTS。 */
export const DEFAULT_CLOUD_BACKEND = 'edge';
export const DEFAULT_DASHSCOPE_MODEL = 'qwen3-tts-flash';
export const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';
export const DEFAULT_DASHSCOPE_LANGUAGE = 'Chinese';
/** 判断一个配置值是否是宿主下发的 volatile 引用。 */
export function isConfigRef(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.get === 'function');
}
/** 解引用单个配置值；引用缺值时回退 fallback。 */
export function readConfigValue(value, fallback) {
    if (isConfigRef(value)) {
        const current = value.get();
        return current === undefined ? fallback : current;
    }
    return value === undefined ? fallback : value;
}
/**
 * 未显式选择 provider 时的判定：
 * - 已配置音色预设 → gsv（老用户沿用本地专业模式，声音不变）
 * - 全新安装（无音色）→ edge（云端快速体验，装上即听）
 */
export function resolveProviderKind(stored, voices) {
    if (stored === 'edge' || stored === 'gsv')
        return stored;
    return voices.length > 0 ? 'gsv' : 'edge';
}
/** 读取显式持久化的 provider（未设置时为 undefined），用于迁移守卫判断是否需要写回。 */
export function storedProvider(raw) {
    return readConfigValue(raw, undefined);
}
/** 把 `apply(ctx, config)` 收到的配置（含 volatile 引用）归一为当前生效的普通对象。 */
export function snapshotConfig(raw) {
    const source = (raw ?? {});
    const voices = readConfigValue(source.voices, []);
    const list = Array.isArray(voices) ? voices : [];
    const timeout = readConfigValue(source.timeout, 30000);
    return {
        apiUrl: readConfigValue(source.apiUrl, DEFAULT_API_URL),
        voices: list,
        defaultVoice: readConfigValue(source.defaultVoice, ''),
        autoPlay: readConfigValue(source.autoPlay, false),
        interruptOnNew: readConfigValue(source.interruptOnNew, true),
        // AbortSignal.timeout / 工具 timeoutMs 都要求正数：非法值回退默认，避免旧配置把插件弄挂
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
        installDir: readConfigValue(source.installDir, DEFAULT_INSTALL_DIR),
        voiceRegistryUrl: readConfigValue(source.voiceRegistryUrl, DEFAULT_VOICE_REGISTRY_URL),
        schemaVersion: readConfigValue(source.schemaVersion, SCHEMA_VERSION),
        provider: resolveProviderKind(readConfigValue(source.provider, undefined), list),
        quotaDaily: readConfigValue(source.quotaDaily, null),
        // ─── 云端后端（快速体验）二选一：edge / dashscope ───
        cloudBackend: cloudBackendOf(readConfigValue(source.cloudBackend, undefined)),
        dashscopeApiKey: String(readConfigValue(source.dashscopeApiKey, '') ?? ''),
        dashscopeModel: readConfigValue(source.dashscopeModel, DEFAULT_DASHSCOPE_MODEL) || DEFAULT_DASHSCOPE_MODEL,
        dashscopeBaseUrl: readConfigValue(source.dashscopeBaseUrl, DEFAULT_DASHSCOPE_BASE_URL) || DEFAULT_DASHSCOPE_BASE_URL,
        dashscopeLanguage: readConfigValue(source.dashscopeLanguage, DEFAULT_DASHSCOPE_LANGUAGE) || DEFAULT_DASHSCOPE_LANGUAGE,
    };
}
/** 云端后端归一：非法值一律回落到 edge（旧配置没有该字段时行为不变）。 */
export function cloudBackendOf(value) {
    return value === 'dashscope' ? 'dashscope' : DEFAULT_CLOUD_BACKEND;
}
/**
 * 当前真正生效的提供方 kind。
 * - provider=gsv → 'gsv'（本地专业）
 * - provider=edge → cloudBackend 决定 'edge' 还是 'dashscope'（云端快速体验）
 * 注意：不要拿 config.provider 当 kind 传给 provider()，云端下它恒为 'edge'。
 */
export function activeKind(cfg) {
    if ((cfg?.provider ?? 'gsv') === 'gsv')
        return 'gsv';
    return cloudBackendOf(cfg?.cloudBackend) === 'dashscope' ? 'dashscope' : 'edge';
}
//# sourceMappingURL=config.js.map