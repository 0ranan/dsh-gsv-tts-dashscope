import type { VoicePreset, Config } from './types.js';
/**
 * 音色预设查询。构造时传入配置读取函数而不是配置快照：
 * DSH 0.2+ 的设置保存是 volatile 就地更新，读函数能始终拿到最新音色列表。
 */
export declare class VoiceManager {
    private getConfig;
    constructor(getConfig: () => Config);
    private voices;
    list(): VoicePreset[];
    get(name?: string): VoicePreset | undefined;
    get defaultName(): string;
}
//# sourceMappingURL=voice-manager.d.ts.map