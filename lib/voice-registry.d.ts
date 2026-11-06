import type { Config, VoicePreset, VoiceRegistry, VoiceRegistryPkg } from './types.js';
/** 单文件下载硬上限（独立于清单声明，防超限）。 */
export declare const MAX_FILE_BYTES: number;
/** 允许的音频后缀白名单。 */
export declare const ALLOWED_EXT: string[];
/** 音色 id 白名单。 */
export declare const ID_RE: RegExp;
export type RegistrySource = 'bundled' | 'remote';
export interface RegistryListEntry extends VoiceRegistryPkg {
    installed: boolean;
    /** A+：per-voice 信任标记（包内收录的音色即便经远端清单展示也保持 trusted） */
    trusted: boolean;
}
export interface RegistryListResult {
    source: RegistrySource;
    trusted: boolean;
    version: string;
    voices: RegistryListEntry[];
}
export interface RegistryInstallResult {
    ok: boolean;
    /** 阶段 1 需要确认时置 true（信任边界外不下载任何字节） */
    needsConfirm?: boolean;
    pkg?: VoiceRegistryPkg;
    voice?: VoicePreset;
    /** 安装后的完整音色列表（供客户端立即刷新下拉/列表，不依赖宿主同步） */
    voices?: VoicePreset[];
    message: string;
}
export interface RegistryRemoveResult {
    ok: boolean;
    /** 卸载后的完整音色列表 */
    voices?: VoicePreset[];
    message: string;
}
export interface RegistryFetchers {
    /** 拉取文本（清单）。 */
    fetchText(url: string): Promise<string>;
    /** 下载二进制（音频）。 */
    fetchBinary(url: string): Promise<Buffer>;
}
/** 包内离线清单路径（编译后 lib/ 同级的 docs/voices.json）。 */
export declare function bundledManifestPath(): string;
/** 包内随插件分发的音色素材目录（docs/voices/）。 */
export declare function bundledVoicesDir(): string;
/**
 * 清单 URL 若指向包内素材（文件名与 docs/voices/ 下文件一致），直接返回本地路径。
 * 包内音色离线安装：不依赖外部 CDN 网络（TLS/断网都不影响），sha256 照常校验。
 */
export declare function resolveBundledFile(url: string): string | null;
/**
 * 网络层重试：仅当 fetch 抛异常（连接/TLS/超时等抖动）时重试，最多 attempts 次；
 * HTTP 非 2xx 直接返回 Response（由调用方判定，404 等确定性错误不浪费重试）。
 */
export declare function fetchRetry(fetchImpl: (url: string) => Promise<Response>, url: string, attempts?: number): Promise<Response>;
/** 清单结构校验：schema、id/name 唯一、https 直链、sha256 格式。 */
export declare function validateManifest(raw: unknown): VoiceRegistry;
/**
 * 音色注册表核心（工具与 HTTP 路由共享）。
 *
 * 信任规则（A+ 混合模式）：
 * - 包内 docs/voices.json 中的音色，无论是否经远端清单展示，均视为 trusted（随包发布已审计）。
 * - 远端清单中新增的音色（包内未收录），一律两阶段确认，即便远端自报 trusted。
 * - 合并逻辑：以 id 为键，包内优先（保留 trusted 状态），远端只补充新 id。
 */
export declare class VoiceRegistryManager {
    private opts;
    constructor(opts: {
        getConfig: () => Config;
        /** 持久化配置补丁（settings.update(ns, patch)），volatile 配置就地热更新 */
        writeConfig: (patch: Partial<Config>) => Promise<void>;
        fetchers?: Partial<RegistryFetchers>;
    });
    private fetchers;
    /**
     * 解析清单（A+ 混合模式）：
     * - 始终加载包内清单（trusted 音色来源）
     * - 有 voiceRegistryUrl 时，额外拉取远端清单并合并：包内音色优先（保留 trusted），远端只补充新 id
     * - 无 voiceRegistryUrl 时，仅用包内清单
     */
    private resolveRegistry;
    /** 市场列表：拉取清单并标注已安装状态与 per-voice 信任标记。 */
    list(registryUrl?: string): Promise<RegistryListResult>;
    /**
     * 安装（两阶段幂等）：
     * - A+：包内收录的音色（bundledIds 含该 id）免确认；远端新音色需二次确认。
     * - 需确认时第一段返回 needsConfirm，不下载任何字节；
     * - confirm 后才下载 → sha256 校验 → 原子落盘 → 写 Config.voices。
     */
    install(id: string, confirm: boolean): Promise<RegistryInstallResult>;
    /** 卸载：仅限 source:'registry'，按 id 精确匹配；defaultVoice 悬空一并清空；deleteFiles 限定在 voices 目录内。 */
    remove(id: string, deleteFiles: boolean): Promise<RegistryRemoveResult>;
    /** 下载 → sha256 校验 → 原子落盘；返回可写回 Config 的 VoicePreset。 */
    private stage;
    /** 安装/删除目录：resolve 后必须仍位于 <installDir>/voices/ 之下。 */
    private voiceDir;
}
//# sourceMappingURL=voice-registry.d.ts.map