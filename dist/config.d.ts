export declare const AGENTD_DIR: string;
export declare const PID_FILE: string;
export declare const CONFIG_FILE: string;
export declare const DEFAULT_PORT = 4700;
export declare const DEFAULT_HOST = "localhost";
export interface AgentdConfig {
    port: number;
    host: string;
}
export declare function ensureAgentdDir(): void;
export declare function loadApiKey(): string | null;
export declare function loadConfig(): AgentdConfig;
