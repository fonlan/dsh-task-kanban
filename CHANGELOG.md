# 变更记录

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.2.9

**兼容性**：dsh `^0.1.5-rc.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。
- 把 `@deepseek-ai/dsh-agent-preset-registry` 固定为 devDependency。它此前只作为自动安装的 peer 进树，pnpm 一直解析到 `0.2.0-rc.1`，连带拖入 `dsh-invariants@0.2.0-rc.1` 与第二份 `schemastery@3.18.4`，导致声明生成报 `TS2742`。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（75 项）全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
