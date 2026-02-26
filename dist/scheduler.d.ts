export declare function parseCronTriggers(triggers: string[]): string[];
export declare function computeNextRun(triggers: string[]): string | null;
export declare function updateNextRun(agentName: string, triggers: string[]): void;
export declare function scheduleAgent(agentName: string, triggers: string[]): void;
export declare function unscheduleAgent(agentName: string): void;
export declare function initScheduler(): void;
export declare function stopScheduler(): void;
