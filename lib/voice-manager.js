/**
 * 音色预设查询。构造时传入配置读取函数而不是配置快照：
 * DSH 0.2+ 的设置保存是 volatile 就地更新，读函数能始终拿到最新音色列表。
 */
export class VoiceManager {
    getConfig;
    constructor(getConfig) {
        this.getConfig = getConfig;
    }
    voices() {
        const voices = this.getConfig().voices;
        return Array.isArray(voices) ? voices : [];
    }
    list() {
        return this.voices();
    }
    get(name) {
        const list = this.voices();
        if (name) {
            const named = list.find((v) => v.name === name);
            if (named)
                return named;
        }
        const defaultName = this.getConfig().defaultVoice;
        if (defaultName) {
            const fallback = list.find((v) => v.name === defaultName);
            if (fallback)
                return fallback;
        }
        return list[0];
    }
    get defaultName() {
        return this.getConfig().defaultVoice;
    }
}
//# sourceMappingURL=voice-manager.js.map