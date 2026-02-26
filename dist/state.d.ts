import type DatabaseConstructor from "better-sqlite3";
export declare const DB_PATH: string;
export declare function getDb(): InstanceType<typeof DatabaseConstructor>;
