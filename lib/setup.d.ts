import type { HealthCheckResult, SetupResult } from './types.js';
export declare class EngineSetup {
    private getConfig;
    private apiUrl;
    private installDir;
    /** @param getConfig 读取当前生效的 apiUrl / installDir（设置为 volatile 就地更新）。 */
    constructor(getConfig: () => {
        apiUrl: string;
        installDir: string;
    });
    private refresh;
    healthCheck(): Promise<HealthCheckResult>;
    setup(): Promise<SetupResult>;
    private detectPythonCmd;
    /** 探测 gsv_tts 是否可用：先试系统裸路径，再试仓库源码 / --target 安装路径。 */
    private probeGsvTts;
    private detectPythonPaths;
    private generateWrapper;
    private parsePort;
    private waitForReady;
}
//# sourceMappingURL=setup.d.ts.map