import { Hono } from "hono";
declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export { app };
export declare function startServer(): Promise<void>;
