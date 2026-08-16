/**
 * The three kanban model-facing tools, registered SCOPED into the sessions
 * that need them (only refinement/phase/merge agents see them):
 *  - kanban_write_plan      → refinement session writes the plan back to the card
 *  - kanban_phase_complete  → a phase implementation session declares its phase done
 *  - kanban_merge_resolved  → a conflict merge session declares conflicts resolved
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { validatePlan } from '../shared/plan.js'
import type { Plan } from '../shared/card.js'

export interface KanbanToolResolver {
  /** Resolve the card id attached to a calling session id. */
  cardOfSession(sessionId?: string): string | undefined
  writePlan(cardId: string, plan: Plan): Promise<void>
  /** Mark the phase done; returns the phase id for the tool output. */
  phaseComplete(sessionId: string, summary: string): Promise<string>
  mergeResolved(sessionId: string): Promise<void>
}

export function registerKanbanTools(agentCtx: Context, resolver: KanbanToolResolver): void {
  agentCtx.tools.register(defineTool({
    name: 'kanban_write_plan',
    description: '把当前需求的完整分阶段实现计划写回任务卡片。调用一次，参数为完整计划（title、summary、按执行顺序排列的 phases）。成功写回后本细化会话即结束。',
    parameters: {
      title: { type: 'string', required: true, description: '计划标题' },
      summary: { type: 'string', required: true, description: '计划摘要' },
      phases: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '阶段 id，如 p1' },
            title: { type: 'string', required: true, description: '阶段标题' },
            goal: { type: 'string', required: true, description: '阶段目标：本阶段要交付什么' },
          },
        },
        description: '按顺序串行执行的实现阶段；必须非空',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `实现计划已写回任务卡片 ${value.taskId}。` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const cardId = resolver.cardOfSession(sessionId)
      if (cardId === undefined) {
        throw new Error('当前会话没有关联的任务卡片，无法写回计划')
      }
      const result = validatePlan(args)
      if (!result.ok) {
        throw new Error(result.message)
      }
      const plan = result.plan
      await resolver.writePlan(cardId, plan)
      exec.concludeTurn()
      return { ok: true, taskId: cardId }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: 'kanban_phase_complete',
    description: '声明当前 phase 实现完成。在工作完成后必须显式调用本工具（附完成摘要），否则该 phase 会被视为未完成。',
    parameters: {
      summary: { type: 'string', required: true, description: '本 phase 完成了什么的简要说明' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `phase ${value.phase} 已标记完成。` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const cardId = resolver.cardOfSession(sessionId)
      if (cardId === undefined) {
        throw new Error('当前会话没有关联的任务卡片')
      }
      if (typeof args.summary !== 'string' || args.summary.trim() === '') {
        throw new Error('summary 不能为空')
      }
      const phase = await resolver.phaseComplete(sessionId!, args.summary)
      exec.concludeTurn()
      return { ok: true, phase }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: 'kanban_merge_resolved',
    description: '声明当前目录中的合并冲突已全部解决。只用于合并冲突解决会话；声明后本会话即将结束。',
    parameters: {
      summary: { type: 'string', description: '可选的解决方案说明' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: '冲突已标记为解决。' }],
    },
    async execute(_args, exec) {
      const sessionId = exec.agent?.id
      const cardId = resolver.cardOfSession(sessionId)
      if (cardId === undefined) {
        throw new Error('当前会话没有关联的任务卡片')
      }
      await resolver.mergeResolved(sessionId!)
      exec.concludeTurn()
      return { ok: true }
    },
  }))
}