declare module 'markdown-it-task-lists';
/** Short git commit of this build, set by vite.config.ts. */
declare const __BUILD__: string;
/** Tests read the stylesheet from disk; the app itself never uses Node APIs (no @types/node in this project). */
declare module 'node:fs' { export function readFileSync(path: URL | string, encoding: 'utf8'): string; }
