# 变更记录

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.2.12

**兼容性**：dsh `^0.1.5-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3 || ^0.2.1-rc.5` —— 已在 DSH Desktop `0.2.1-rc.5` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-rc.3` 升到 `0.2.1-rc.5`（`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5` 不变）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.5`。
- 源码零改动：`0.2.1-rc.3 → 0.2.1-rc.5` 的两处宿主变化都在宿主内部（rc.4 修 ACP 模式诊断输出混入 stdout；rc.5 优化对话思考内容展示），未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（75 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.5` 宿主）通过。

## 0.2.11

**兼容性**：dsh `^0.1.5-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3 || ^0.1.7-rc.1` —— 已在 DSH Desktop `0.2.1-rc.3` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-rc.2` 升到 `0.2.1-rc.3`（`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5` 不变）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.3`。
- 源码零改动：`0.2.1-rc.2 → 0.2.1-rc.3` 的宿主变化是新增 entry 自定义菜单/图标与两个新槽位（`sidebar.panellist.actions`、`conversation.session.header.views.actions`），未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（75 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.3` 宿主）通过。

## 0.2.10

**兼容性**：dsh `^0.1.5-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2` —— 已在 DSH Desktop `0.2.1-rc.2` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）；dsh web `0.2.1-alpha.2` 仍落在同一 peer 区间内（门禁离线求值 ADMITTED）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-alpha.1` 升到 `0.2.1-rc.2`（含 `@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.2`。
- 源码零改动：`0.2.1-alpha.1 → 0.2.1-rc.2` 的声明面变化未触及本插件消费的 API（typecheck 通过）。
- `@deepseek-ai/dsh-agent-preset-registry` 的 peer 下界仍为 `^0.1.7-rc.1`（其余 `@deepseek-ai/dsh*` 为 `^0.1.5-rc.2`）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（75 项）全部通过；隔离 profile 冷启动（真 `0.2.1-rc.2` 宿主）通过。

## 0.2.9

**兼容性**：dsh `^0.1.5-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。
- 把 `@deepseek-ai/dsh-agent-preset-registry` 固定为 devDependency。它此前只作为自动安装的 peer 进树，pnpm 一直解析到 `0.2.0-rc.1`，连带拖入 `dsh-invariants@0.2.0-rc.1` 与第二份 `schemastery@3.18.4`，导致声明生成报 `TS2742`。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（75 项）全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
