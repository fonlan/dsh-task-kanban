export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}
export declare function runGit(cwd: string, args: string[]): Promise<GitResult>;
export declare function isGitRepo(dir: string): Promise<boolean>;
export declare function hasBranch(dir: string, name: string): Promise<boolean>;
export declare function detectBaseRef(dir: string): Promise<string | undefined>;
export declare function currentBranch(dir: string): Promise<string | undefined>;
export declare function revParse(dir: string, ref: string): Promise<string | undefined>;
/** True when the working tree has tracked changes (staged or unstaged). */
export declare function isTreeDirty(dir: string): Promise<boolean>;
export declare function hasStashMessage(dir: string, message: string): Promise<boolean>;
/** Unmerged path list after a conflicted merge (empty when clean). */
export declare function unmergedPaths(dir: string): Promise<string>;
