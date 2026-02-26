interface RunResult {
    changes: number;
}
interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
}
interface CompatDb {
    exec(sql: string): void;
    prepare(sql: string): Statement;
}
export declare const DB_PATH: string;
export declare function getDb(): CompatDb;
export {};
