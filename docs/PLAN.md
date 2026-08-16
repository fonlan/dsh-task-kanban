# @fonlan/dsh-task-kanban 实现方案

> 经三轮设计拷问后定稿。所有"已确认"条目均来自与需求方的逐条拍板，实现时不得自行更改语义。

## 1. 目标

在 DSH web 主界面新增"任务看板"：把需求拆解（LLM 规划）→ 排队 → 串行实现（多 phase 会话）→ 自动合并（worktree）全流程自动化，全部状态可视化在五个泳道上。

**泳道**：需求 → 队列 → 运行中 → 已完成 → 已合并

## 2. 总体架构

一个 npm 插件包 `@fonlan/dsh-task-kanban`，双半区结构（与 dsh-better-sidebar 同模式）：

- **服务端**（Cordis 插件，挂载于 web profile）：
  - `TaskStore`：任务卡片持久化与并发安全读写
  - `KanbanService`：RPC 面（api-gateway），处理 UI 操作
  - `RefinementRunner`：细化会话
  - `WorkerPool`：每工作区单 worker + 全局并行上限
  - `PhaseRunner` / `MergeRunner`：phase 会话与合并流程
- **客户端**（`dsh.client.inject` 注入 web bundle）：
  - 侧边栏底部入口按钮（`sidebar.footer.action` 插槽）
  - 看板主视图（动态注册进 `conversation` 插槽）
  - 新建任务弹窗、卡片详情、插件设置页

### 2.1 挂载方式

`package.json`：

```json
{
  "name": "@fonlan/dsh-task-kanban",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-web-react"
      ],
      "platform": "web"
    }
  }
}
```

`cordis.patch.yml`（与 better-sidebar 相同机制，`dsh plugin add` 自动挂载）：

```yaml
- insert:
    - id: task-kanban
      name: '@fonlan/dsh-task-kanban'
```

peerDependencies 对齐 better-sidebar：`@deepseek-ai/cordis`、`dsh-agent`、`dsh-session`、`dsh-tools`、`dsh-settings`、`dsh-llm`、`schemastery`、`react`、`react-dom` 及各 `dsh-client-*` 包。

## 3. 客户端 UI

### 3.1 入口按钮（已确认 Q1=b）

注册进 `sidebar.footer.action`（list 插槽，增量追加，与 Settings 同排于侧边栏底部）。点击切换看板模式。

### 3.2 主视图切换

- 进入看板：以 priority **-1** 动态 `ctx.slots.register` KanbanRoot 进 `conversation` 插槽（single 槽 shadow 语义：数值低者渲染；原 ui-conversation 注册为 0）。
- 退出看板（看板内"返回对话"按钮 / 点击打开某会话时）：调用注册返回的 disposer，原对话界面恢复。
- **看板打开时点击左侧工作区列表的任意会话**：插件 apply 时包装 `ctx.sessions.open` / `openSubagent`（见 §15-13），任何会话选择先 `exitBoard()` 再打开——包括点击当前已选中的会话（此时 `list.current` 不变，仅订阅列表快照无法捕获该点击）。
- KanbanRoot 自带 mode 状态，看板与对话互斥。

### 3.3 看板界面

- 顶部栏：左侧**工作区切换下拉**（列出 `ctx.workspaces` 已注册工作区；看板只显示当前选中工作区的任务，已确认 Q12），右侧**新建任务**按钮。
- 五泳道：需求 / 队列 / 运行中 / 已完成 / 已合并。
- 卡片展示：标题、需求摘要、模型、plan 状态徽标（未规划/已规划/实现中 i/N/错误/已中断）、所属阶段、时间。
- 卡片操作：
  - 点击 → 详情面板（plan markdown 渲染、各 phase 会话链接、错误信息、按钮区）
  - 错误态/已中断卡片 → **重试**按钮
  - 运行中卡片 → **停止**按钮
  - 非运行中卡片 → **删除**按钮（二次确认；连带清理 worktree，已确认 Q17）
  - phase 会话链接 → 点击退出看板并 `ctx.sessions.open(sessionId)` 打开该会话
- 拖拽规则（已确认 Q16）：需求→队列仅限已有计划（无计划拒绝并提示）；队列→需求可拖回；**运行中→队列可拖，等价于点击停止**；已完成/已合并不可拖。

### 3.4 新建任务弹窗

- 字段：需求文本（textarea）、所属项目（下拉 = 工作区列表）、模型（下拉，默认值取插件设置里的默认模型）。
- 已确认 Q6=a：**本期不做"思考强度"下拉**，待 preset 体系丰富后再接。
- 底部：取消 / **添加并细化**。点击后创建卡片并立即启动细化会话。

### 3.5 插件设置页（已确认 Q17）

注册进 `settings.section`（list 插槽，id/label，参照 better-sidebar）。内容：
- 全局并行 worker 数（默认 1，≥1 整数）
- 默认模型

用户设置经 `settingsNamespace("task-kanban")` 走 settings 服务持久化（better-sidebar prefs 同款通路；settings/locale 等 DSH 平面命名空间用 kebab 插件 id `task-kanban`，不能用含 `@`/`/` 的 scoped 包名）。

### 3.6 i18n

locale 命名空间 `task-kanban`（= kebab 插件 id），zh/en 双语字典（界面文案全量接入）。npm 包绑定标识（`export const name`、`/plugins/@fonlan/dsh-task-kanban/api` 路由等）用 scoped 全名。

## 4. 数据模型

### 4.1 存储位置（已确认 Q4/Q12）

- 任务卡片：`<工作区>/.dsh/task-kanban/tasks/<task-id>.json`，一卡一文件，原子写（tmp + rename）。
- worktree（git 项目）：`<工作区>/.dsh/worktrees/<task-id>/`（已确认 Q3）。
- 插件在首次为某 git 工作区创建任务时，确保 `.gitignore` 含 `.dsh/`（不存在则追加，已确认 Q12）。

### 4.2 卡片 JSON（schemaVersion: 1）

```jsonc
{
  "schemaVersion": 1,
  "id": "uuid",
  "workspacePath": "/abs/path",
  "requirement": "原始需求文本",
  "model": "deepseek-v4",
  "status": "draft | refining | planned | queued | running | completed | merging | merged | error",
  "error": { "kind": "refine_failed|phase_failed|interrupted|merge_failed|no_base_branch", "message": "..." },
  "gitMode": true,
  "baseRef": "main",
  "baseSha": "abc123",
  "branch": "kanban/<task-id>",
  "worktreePath": "/abs/.dsh/worktrees/<task-id>",
  "plan": {
    "schemaVersion": 1,
    "title": "...",
    "summary": "...",
    "phases": [ { "id": "p1", "title": "...", "goal": "..." } ]
  },
  "progress": { "currentPhase": 0, "phaseCount": 0 },
  "sessions": {
    "refinement": ["session-id 历史"],
    "phases": [{ "phaseId": "p1", "attempts": ["session-id"], "summary": "..." }],
    "merge": ["session-id"]
  },
  "merge": { "commit": "sha", "mergedAt": 0 },
  "queuedAt": 0,
  "createdAt": 0,
  "stoppedAt": 0
}
```

plan schema 由 `kanban_write_plan` 工具的 schemastery schema 强制：`title/summary` 非空字符串，`phases` 非空数组且 `id` 唯一、`title/goal` 非空。**无 per-phase 完成判据字段**（已确认 Q7）。phase 严格串行。

### 4.3 队列顺序

FIFO：按 `queuedAt` 升序（同刻按 `createdAt` 决胜）。仅对当前工作区生效。

## 5. 状态机

```
draft ──添加并细化──▶ refining ──写回成功──▶ planned（需求泳道）
refining/planned ──失败──▶ error（卡片错误态，可重试/删除）
planned ──拖入队列──▶ queued
queued ──拖回──▶ planned
queued ──worker 领取──▶ running（运行中泳道）
running ──停止(按钮或拖回队列)──▶ queued（保留 progress，续跑当前 phase）
running ──phase 完成──▶ running（下一 phase，新会话同 worktree）
running ──全部 phase 完成──▶ completed（git）｜merged（非 git 直接跳过 merge）
running ──异常──▶ error（可重试；不自动重试）
completed ──merge 自动执行──▶ merging ──成功──▶ merged（已合并泳道）
merging ──失败/冲突解决失败──▶ error（重试=从当前 merge 步骤继续）
error ──重试──▶ running / refining / merging（按 error.kind 回到对应流程）
```

- **重启恢复**（已确认 Q11）：插件启动扫描工作区任务，`running/refining/merging` 且无活 agent → 标记 `error{kind:'interrupted'}`，显示重试按钮，**不做自动恢复**。队列中卡片正常自动续跑。

## 6. 细化流程（RefinementRunner）

1. `ctx.agents.create({ sessionId: 新id, meta: { cwd: 项目目录, agentPreset: 'standard' }, agentOptions: { model: 卡片模型 }, setup(agentCtx) {...} })`。
2. `setup` 内作用域注册工具（仅本会话可见）：`read`、`glob`、`grep`、`kanban_write_plan`。
3. 提示词：需求文本 + 项目路径 + 任务说明（可先读仓库代码与文档；把需求拆成**串行执行**的实现计划；复杂需求拆多 phase，每个 phase 对应一个实现会话；完成后必须调用 `kanban_write_plan` 写回完整计划）。
4. `agent.followup(prompt)` 驱动；`kanban_write_plan` 工具体：schema 校验（失败 → 错误回给模型，同会话内重写，已确认 Q7）→ 原子写卡 → `concludeTurn()` 结束本 turn。
5. 会话自然结束但未成功写回 → 卡片 error{refine_failed}，重试 = 新建细化会话（提示词相同）。
6. 计划**不可变**；想改 = 删卡重建（已确认 Q7）。细化会话在侧边栏项目下可见（cwd=项目目录）。

## 7. 实现流程（PhaseRunner / WorkerPool）

- **并发模型**（已确认 Q9）：同一工作区严格单 worker；不同工作区并行，全局并行数 = 插件设置（默认 1）。
- 领取条件：`queued` 卡片 + 该工作区无在跑任务 + 全局有空闲 slot。

### 7.1 启动（首次进入实现）

- git 项目：`git -C <ws> rev-parse` 判定；确定 base = 存在的 main 或 master（都没有 → error{no_base_branch}）；`git -C <ws> worktree add -b kanban/<task-id> <ws>/.dsh/worktrees/<task-id> <base>`；记录 baseRef/baseSha/worktreePath。失败 → error。
- 非 git 项目：工作目录 = 项目目录，跳过 worktree 与 merge（已确认 Q3）。

### 7.2 每个 phase（串行，同一 worktree）

1. 新建会话+agent：`meta.cwd = worktreePath`（git）或项目目录（非 git）；`agentPreset: 'standard'`；`agentOptions.model = 卡片模型`。
2. `setup` 作用域注册**全部工具**（已确认 Q13）：`bash`、`read/write/edit`、`glob/grep`、`todo`、`subagent`、`subagent_fork`、`workflow`、`goal`、`web`、`skill` + `kanban_phase_complete`；并 `agentCtx.tools.presentAs('code')`（code mode，`run_code` 形态，已确认 Q5=b）。
3. 提示词（重试/停止后续跑时**完全相同**，让模型自己看 git status/diff 判断现场，已确认 Q9）：
   - 完整 plan JSON + 当前 phase（id/title/goal，第 i/N 个）
   - 工作目录路径（= worktree）
   - 规则：只在本工作目录内工作；**禁止 git commit / push / merge**（提交与合并由插件完成，已确认 Q5=c）；完成后调用 `kanban_phase_complete(summary)` 声明本 phase 完成。
4. `agent.followup(prompt)` → 等待 `agent.whenIdle()` + 完成工具落卡。完成工具体：记录 phase 摘要、`concludeTurn()`。
5. turn 结束但未声明完成 → error{phase_failed}，等待人工重试（**不自动重试**，已确认 Q4）。
6. phase 会话 cwd 是 worktree，故不出现在侧边栏项目列表下，通过卡片详情链接打开（已确认 Q14，接受）。

### 7.3 停止（已确认 Q9/Q16）

停止按钮或拖回队列：`agent.cancel(cause, {keepInbox:false})` → 等 `whenIdle()` → 卡片回 `queued`，`progress.currentPhase` 不变（**从被停止的 phase 继续**），worktree 保留。

### 7.4 重试（已确认 Q4）

新建实现会话，同一 worktree、同一提示词（模型自行判断已完成部分）。不新建 worktree。

### 7.5 全部 phase 完成

- git：卡片 → `completed`（已完成泳道），worker 立即转入 merge。
- 非 git：卡片直接 → `merged`（跳过已完成，已确认 Q10）。

## 8. 合并流程（MergeRunner，git 项目）

顺序（全自动，插件 CLI 主导，已确认 Q3/Q10/Q15）：

1. **项目目录预处理**：不在 base 分支 → error{merge_failed}；脏（已跟踪改动）→ `git stash push -m kanban-merge-<id>`（只 stash 已跟踪，不带 -u）。未跟踪文件会阻挡 merge 时 → error。
2. **worktree 内合入漂移**：`git -C <wt> merge <base>`（把主分支新提交拉进 plan 分支）。
   - 冲突 → 在 worktree 创建 **AI 合并会话**：cwd=worktree，作用域工具 = bash/fs/read/glob/grep + `kanban_merge_resolved`（含 concludeTurn）；提示词给 `git status` 冲突清单，规则：只解决冲突、**禁止 commit**；结束后插件校验 `git diff --check` 干净 → 插件 `git add -A && git commit`。
   - AI 解决后仍冲突 / AI 会话失败 → error{merge_failed}（重试从本步骤继续）。
3. **项目目录合入**：`git -C <ws> merge <branch>`（此时应自动成功/快进）。
   - 又冲突（主分支再次漂移）→ 项目目录 AI 合并会话，同 2 的模式；最终 commit 由插件执行。
4. **还原 stash**：`git stash pop`。
   - pop 冲突 → 项目目录 AI 合并会话只解冲突不 commit；插件校验 `git diff --check` 后 `git stash drop`，用户改动保持未提交状态（已确认 Q15）。
5. **清理**：`git worktree remove <wt>` → `git branch -d kanban/<task-id>`。
6. 卡片 → `merged`，记录 merge commit sha 与时间。

## 9. 工具定义（服务端注册，作用域内）

| 工具 | 会话 | 参数/行为 |
|---|---|---|
| `kanban_write_plan` | 细化 | `{title, summary, phases[]}`；schema 校验失败回错误给模型重写；成功 → 落卡 + concludeTurn。多次调用 = last-write-wins。 |
| `kanban_phase_complete` | phase | `{summary}`；记录进度 + concludeTurn。 |
| `kanban_merge_resolved` | 合并 | `{summary?}`；标记已解决 + concludeTurn。 |

作用域注册（`agentCtx.tools.register`）保证普通聊天会话完全不受影响。

## 10. RPC 面（api-gateway，客户端 `ctx.api` 调用）

```
taskKanban.listTasks(workspacePath) -> Card[]
taskKanban.listModels() -> {provider, model}[]
taskKanban.createTask({workspacePath, requirement, model}) -> cardId   // 落卡 + 异步启动细化
taskKanban.moveTask({cardId, toLane})                                  // 校验拖拽规则
taskKanban.stopTask({cardId})
taskKanban.retryTask({cardId})
taskKanban.deleteTask({cardId})
taskKanban.getSettings() / taskKanban.setSettings({maxParallelWorkers, defaultModel})
```

工作区列表直接读客户端 `ctx.workspaces`，不建 RPC。

## 11. 构建与安装

- 构建：`tsdown`（server）打包 `lib/index.js`、`lib/client.js` + d.ts；`pnpm build`。
- 安装：`dsh plugin --profile web add .`（本地链接），发布后 `dsh plugin --profile web add @fonlan/dsh-task-kanban@<ver>`（或本地 tarball：`dsh plugin --profile web add ./@fonlan-dsh-task-kanban-<ver>.tgz`）。
- 开发：改服务端需重启 web profile；客户端走 web 端 HMR 链路（`pnpm run dev:web` 同启时生效）。
- 目录结构：

```
src/
  server/index.ts        # Cordis 插件 apply
  server/task-store.ts   # 卡片持久化（缓存 + 原子写 + per-card 互斥）
  server/workers.ts      # WorkerPool（每工作区单 worker + 全局 semaphore）
  server/refine.ts       # RefinementRunner
  server/phases.ts       # PhaseRunner
  server/merge.ts        # MergeRunner（git CLI 封装）
  server/tools.ts        # kanban_write_plan / kanban_phase_complete / kanban_merge_resolved
  server/rpc.ts          # api-gateway 路由
  shared/card.ts         # 卡片/plan schema（schemastery）、共享类型
  client/index.ts        # apply(ctx)：footer 按钮、看板切换、设置页注册
  client/board.tsx       # KanbanRoot：工作区切换 + 五泳道 + 拖拽
  client/card.tsx        # 卡片 + 详情面板
  client/new-task.tsx    # 新建任务弹窗
  client/settings.tsx    # 设置区
  client/locales.ts      # zh/en
```

## 12. 测试

- 单测（vitest）：plan/card schema 校验；状态机迁移合法性；FIFO 排序；拖拽规则判定。
- 集成（真实 git CLI + 临时仓库）：worktree 创建/基线漂移合并/冲突→AI 会话→插件 commit/脏树 stash-pop/非 git 直通/停止与重试后 worktree 状态。
- 手工 E2E：安装进 web profile 全流程走查（细化→排队→多 phase→合并→已合并；错误态与重启恢复）。

## 13. 风险与假设（实现期验证清单）

1. **插槽 shadow priority=-1**：`conversation` 槽同 priority 注册会抛错，-1 应可压过默认 0。实现首日验证，失败则改"注册即替换 + 显式 restore"方案。
2. **审批绕过**：插件作用域注册的 `tools/pre-execute` 监听（allow）应只覆盖 phase 会话，普通会话审批不受影响；部署在 workspace-write 模式下的行为需实测（当前机器 danger-full-access 无此问题）。
3. **沙箱根**：`sandbox-policy.workspaceRoot = web 进程 cwd`；workspace-write 部署下 worktree 在 cwd 之外可能被 bash 沙箱拒绝。当前部署 danger-full-access 不受影响；文档标注部署前提。
4. **会话 dispose 语义**：phase 结束后 dispose agent 是否影响会话在 UI 中重新打开（resume 路径），构建期验证；必要时保留句柄至卡片终态。
5. **模型列表来源**：从 ui-model-selection 同源（settings/models 或 llm registry）读取，构建期确认；不可用则退化为内置 provider 列表。
6. **worktree 内 `.git` 共享主仓库对象**：LLM 理论上可 push/篡改主仓库（已接受风险，prompt 约束 + 后续可加 bash 命令拦截）。
7. **成本**：每个 phase 一个新会话全量重放 plan，多 phase 任务 token 消耗大；后续可做上下文精简优化。
8. **看板数据一致性**：客户端轮询（2s）与文件落盘之间有窗口；关键操作（拖拽/停止）以 RPC 返回为准。

## 14. 实施顺序

1. 脚手架 + 挂载 + footer 按钮 + 看板切换 + 空五泳道
2. 新建任务弹窗 + TaskStore + 需求泳道卡片 + 删卡 + .gitignore
3. 细化流程（会话创建 + kanban_write_plan + 详情面板）
4. 拖拽/队列 + WorkerPool + phase 执行（git/非 git 双路径）
5. 停止/重试/错误态/重启恢复
6. MergeRunner（stash/漂移/冲突 AI 会话/worktree 清理）+ 已合并
7. 设置页（worker 数/默认模型）+ i18n + 打磨
8. 测试补齐 + README（安装、部署前提、使用说明）
---

## 15. 实现记录与实测调整（E2E 验证后）

以下偏差在真实运行中发现并已修复，取代对应章节的原始设计：

1. **agent 必须有 provider + model 双字段**：`ctx.agents.create` 只传 `model` 时，agent-default-model 配置不会兜底（报 "no provider/model"）。卡片新增 `provider` 字段，弹窗随模型一并提交；缺省时从 `agent-default-model` settings 命名空间解析 provider。
2. **preset 挂载**：`agentCtx.agentPresets` 属性访问会抛 "without inject"，须用 `agentCtx.get('agentPresets').mount(agentCtx, 'standard')`（与 dsh-subagent 同款用法）。
3. **工具 schema 用 value DSL**：`output.schema` 里不能写 `required: [...]` 数组（JsonSchemaError），一律 per-property `required: true`。
4. **merge 前先提交 worktree 成果**：phase 会话按设计从不 commit，合并时 worktree 必脏，`git merge` 会拒绝；插件先 `git add -A && git commit`（"kanban: phase 实现成果"）再合入 base。
5. **冲突解决会话只改文件，插件负责 add + 校验 + commit**：AI 会话结束后插件先 `git add -A`（清除 unmerged 索引项），再校验 `unmergedPaths` 为空、且原冲突文件无 `<<<<<<< ======= >>>>>>>` 残留，然后 commit 完成合并。stash pop 冲突路径同理，但解决后 `git restore --staged .` 保持用户改动未暂存、`git stash drop`。
6. **重试恢复 merge**：mergeState.step 记录进度；worktree 中已有半成品 merge（MERGE_HEAD + UU）时，重试先走"在途冲突解决"分支，避免把冲突标记当成果提交（实测 bug：曾把带标记的文件提交进 main）。
7. **合并会话需要模型路由**：merge session 必须带 provider+model（否则 `{{model}}` persona 变量无法解析，prompt 装配失败）。
8. **停止语义实测**：`stop` 是异步的（cancel 后 agent 排空才回队列）；停止后卡片保留 currentPhase，重新入队从该 phase 继续（同一 worktree）。
9. **验证过的全流程**（kanban-test profile 实测）：非 git 项目 细化→排队→phase→直通已合并 ✓；git 项目 worktree 创建→多 phase 串行→main 漂移冲突→AI 合并会话解决→插件 commit→合入 main→清理 worktree/分支 ✓；停止→回队列→续跑→合并 ✓；删卡清理 ✓；重启后运行中卡片标记"已中断"+重试 ✓。
10. **看板 i18n**：动态注册的看板根组件必须带 `locale: 'task-kanban'` 席位（kebab 插件 id，DSH 平面命名空间不能用 scoped 全名），否则收不到框架注入的 `t`（此前回退为原样输出 key）。插槽 `label` 用 `ctx.locale.bind(ns)` 的活翻译函数（每次读取按当前语言解析），不能用静态字典引用。
12. **移动端脚部挤压**：mobile-nav 的抽屉（<1024px）宽度 ~280px，且 mobile-nav 的"文件/会话日志"按钮也注册在 sidebar.footer.action 插槽里，footerActions 总宽 ~314px > 脚部 256px → row-reverse 下 settingsArea 被挤到 0 宽、内容向左溢出裁切（设置按钮消失、看板按钮左侧被裁）。修复：@media (max-width: 1023px) 下 kb-foot-row 改为 column-reverse 堆叠（设置行在上、操作行在下），footerActions 变 flex-wrap: wrap 让按钮换行。已用 390px 视口无头验证：设置按钮 264px 完整可见、看板按钮 94px 完整可见；1440px 桌面不受影响（仍同行右侧）。

11. **按钮位置（最终方案）**：侧边栏 foot 是纵向 flex（footerActions 行在上、settingsArea 行在下）。**不移动任何 DOM**：只给 footArea 加 `kb-foot-row` 类，纯 CSS 用 `flex-direction: row-reverse` 让设置区（末子）在左、看板按钮区（首子）在右同行；`kb-foot-rail`（折叠）用 column-reverse 纵向堆叠居中。footArea 定位：从按钮向上找「最后一个子元素含 `button[aria-haspopup=dialog]` 且自身是父元素末子的祖先」；找不到时挂 MutationObserver 重试（设置入口可能晚挂载）。**踩过的坑**：a) slot 机制给 entry 包匿名 div，`parentElement` 层级比预期多一层；b) 曾用 appendChild 重挂按钮，真实 GUI 中因加载时序（设置入口未挂载时向上查找越过 foot 找到更高容器）把按钮移出侧边栏导致消失——所以最终方案坚持零移动，最坏情况只是按钮留在原行。已用 puppeteer 无头（含 better-sidebar/mobile-nav/gitmemo/dshmarket 全插件集）验证：宽/rail/窄屏三模式，设置面板与看板均可正常打开。
13. **看板打开时点击侧边栏会话自动退出看板**：ui-workspace 的会话行（`div[role=treeitem]`）点击最终都走 `ctx.sessions.open(id)`（搜索、fork 结果、新会话同理，子代理行走 `openSubagent`）。列表快照订阅方案不行：**重点当前已选中会话时 `list.current` 不变**，快照无变化无法区分用户点击与后台流刷新。最终方案：apply 时包装 `sessions.open`/`openSubagent`，先 `exitBoard()` 再调原方法（`kbBound` 标记防重复包装/插件重挂叠层）。看板内会话链接的 `exitBoard()` 保留作防御（幂等）。已用 puppeteer 无头在 kanban-test profile 实测：点其他会话退出看板并显示该会话对话 ✓；点当前会话同样退出 ✓；无控制台报错 ✓。客户端 bundle 变更由 client-hmr 500ms 轮询 + `/plugins/events` SSE 推送热更，无需重启 web 进程。14. **细化会话 attach 到工作区会话列表**：DSH 的 workspace 归属是严格等值匹配（`realpath(header.cwd) === workspace.path`，`attachSession` 校验 + `sessionIds` getter 过滤），子目录（含 worktree）不算工作区成员；归属只经 web API `sessions.create`/fork 路径的 `attachSession` 建立，`ctx.agents.create` 直建会话永不归属（实证：dsh-task-kanban 工作区 15 个持久化会话仅 4 个挂载，9 个 preset=None 的看板会话全部未挂载，落在侧边栏"未分组"）。修复：细化会话（cwd=项目根，校验天然通过）创建后调 `workspaceRegistry.resolveByPath(wsPath)?.attachSession(sessionId)`（best-effort，失败仅告警不影响卡片）；phase/合并会话保持 worktree cwd（隔离优先，留在"未分组"）。另确认工具默认工作目录 ≡ `session.header.cwd`（bash/fs/search 均直接取），无 per-agent 覆盖，故"身份归属+worktree 干活"不可分离，phase 会话不强行归属。测试：test/attach.test.ts 4 例。
15. **看板会话无标题的根因与修复**：侧边栏看板会话标题固定为工作区名（cwd basename），因为 `dsh-session-title` 的 `onUserMessage`/`collectSessionTitleMessages` 只认 `source.kind === 'user'` 的 `user/message`（`dsh-session-title/lib/index.js` 97/318 行），看板注入消息原用 `{kind:'plugin', plugin:'@fonlan/dsh-task-kanban'}` 被整体跳过 → 永不触发标题生成（web profile 经 dsh-base 已加载 first-prompt LLM provider）。修复：`asUserMessage` 的 source.kind 改为 'user'（DSH 的 MessageSource.kind 是 merge-extensible 联合，'user' 合法）。副作用评估：对话 UI 里看板注入消息从"context 类"变为普通用户消息气泡、会话 updatedAt 随消息更新（均更合理）；compaction 只认 plugin==='compact'，不受影响。细化/phase/合并会话首条消息即触发 LLM 标题生成（"first-prompt" 模式，web 会话同款路径）。
