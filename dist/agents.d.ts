export interface Agent {
    name: string;
    description: string | null;
    model: string;
    prompt: string;
    tools: string[];
    triggers: string[];
    next_run: string | null;
    created_at: string;
    updated_at: string;
}
export declare function createAgent(yamlPath: string): Agent;
export declare function getAgent(name: string): Agent | null;
export declare function listAgents(): Agent[];
export declare function removeAgent(name: string): boolean;
