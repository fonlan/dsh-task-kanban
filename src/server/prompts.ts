import type { KanbanCard } from '../shared/card.js'

/** Refinement session prompt: analyze the repo read-only and write back a plan. */
export function refinementPrompt(requirement: string, workspacePath: string): string {
  return `你是一个需求分析师。请分析下面的需求，并为它在指定项目中的实现制定一个可执行的分阶段实现计划。

【需求】
${requirement}

【项目目录】
${workspacePath}

【要求】
1. 先浏览项目目录了解现状（阅读 README、关键源码与文档；本会话只做只读探索，不要修改任何文件）。
2. 把需求拆解为按顺序串行执行的实现阶段（phase）。简单需求 1 个 phase 即可；复杂需求拆多个 phase，每个 phase 必须是独立的、可串行执行的实现单元，后面的 phase 依赖前面 phase 的产出。
3. 每个 phase 必须包含：id（如 p1/p2/p3）、标题、目标（goal，说明该 phase 要交付什么）。
4. 完成后调用 kanban_write_plan 工具把完整计划写回（title、summary、phases）。这是唯一写回方式，不要把计划 JSON 直接输出到对话里。
5. 不要向用户提问，自主决策。`
}

/** Phase implementation session prompt; identical on retries (the model reads git status/diff itself). */
export function phasePrompt(card: KanbanCard, phaseIndex: number, workdir: string): string {
  const plan = card.plan!
  const phase = plan.phases[phaseIndex]
  return `你是一个软件实现工程师。请实现下面计划中的第 ${phaseIndex + 1}/${plan.phases.length} 个 phase。你的工作目录是 ${workdir}，只允许在这个目录内工作。

【完整实现计划】
${JSON.stringify(plan, null, 2)}

【当前 phase】
id: ${phase.id}
标题: ${phase.title}
目标: ${phase.goal}

【要求】
1. 先查看工作目录现状（git status、目录与文件结构、已有代码），判断此前已完成的工作，然后实现当前 phase 的目标。如果这是一次重试/续跑，请先搞清楚现场再继续。
2. 只做当前 phase 范围内的实现；后续 phase 由其他会话完成。不要进入 plan mode。
3. 禁止执行 git commit / git push / git merge / git rebase / git stash / git reset（提交与合并由外部系统负责）；允许 git status / git diff 等只读命令。
4. 不要向用户提问，自主决策；不要调用 kanban_write_plan。
5. 完成后必须调用 kanban_phase_complete 工具，并在 summary 中简要说明本 phase 完成了什么。只有显式调用该工具才算完成。`
}

/** Merge-conflict resolution session prompt: resolve conflicts only, never commit. */
export function mergePrompt(workdir: string, conflicts: string): string {
  return `你是一个 git 合并冲突解决专家。目录 ${workdir} 中存在合并冲突，请逐个解决。

【冲突文件】
${conflicts}

【要求】
1. 逐个查看冲突文件（阅读文件内容、git diff），手动解决所有冲突标记（<<<<<<<、=======、>>>>>>>）。
2. 只修改冲突文件以解决冲突，不要做任何无关改动；不要执行 git commit / git add / git merge / git stash。
3. 解决完成后调用 kanban_merge_resolved 工具声明完成（可附简短说明）。`
}
