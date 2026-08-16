/** Thin typed wrapper over the git CLI (all merge/web-tree flow runs here). */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 128 * 1024 * 1024, timeout: 600000 })
    return { code: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (error: unknown) {
    const e = error as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout !== undefined ? String(e.stdout) : '',
      stderr: e.stderr !== undefined ? String(e.stderr) : String(error),
    }
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

export async function hasBranch(dir: string, name: string): Promise<boolean> {
  const r = await runGit(dir, ['rev-parse', '--verify', `refs/heads/${name}`])
  return r.code === 0
}

export async function detectBaseRef(dir: string): Promise<string | undefined> {
  if (await hasBranch(dir, 'main')) return 'main'
  if (await hasBranch(dir, 'master')) return 'master'
  return undefined
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

export async function revParse(dir: string, ref: string): Promise<string | undefined> {
  const r = await runGit(dir, ['rev-parse', ref])
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** True when the working tree has tracked changes (staged or unstaged). */
export async function isTreeDirty(dir: string): Promise<boolean> {
  const r = await runGit(dir, ['status', '--porcelain', '--untracked-files=no'])
  return r.code === 0 && r.stdout.trim() !== ''
}

export async function hasStashMessage(dir: string, message: string): Promise<boolean> {
  const r = await runGit(dir, ['stash', 'list'])
  return r.code === 0 && r.stdout.includes(message)
}

/** Unmerged path list after a conflicted merge (empty when clean). */
export async function unmergedPaths(dir: string): Promise<string> {
  const r = await runGit(dir, ['diff', '--name-only', '--diff-filter=U'])
  return r.code === 0 ? r.stdout.trim() : ''
}
