export declare function resolveTemplatePath(name: string): string;
export declare function renderTemplate(content: string, vars: Record<string, string>): string;
export declare function detectGitRepos(searchDirs?: string[]): string[];
export declare function detectGithubOwner(): string | null;
export declare function runInit(): Promise<void>;
