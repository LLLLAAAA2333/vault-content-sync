# Vault Content Sync

单包 Obsidian 桌面插件，当前版本 0.4.1。入口 `src/main.ts`；同步 `src/sync/`、原生界面 `src/ui/`、纯计算合并 `src/merge/`。

- Node 24、pnpm 10。`pnpm check` 检查格式、类型、构建和模块边界，`pnpm test` 包括单元及模拟服务故障测试；`pnpm e2e` 仅启动隔离 Obsidian 配置与合成库。
- 合并契约见 `docs/MERGE_CONTRACT.md`。冲突/超限结果不含待写入正文；整个任务共用预算，不统一转换换行或把 updated 策略放入合并模块。
- 原始 SHA-256 用于执行前提与恢复；Markdown 顶层 updated 本机保留，共享内容另行核验。状态格式 2、目录 `.plain-sync/` 不随品牌更名改变。
- 未知不是缺失。预览零写入；新建、覆盖和删除必须核验前提。原始版本和持久化目标不可自动清理。
- 外部 WebDAV 写入禁用，仅显式配置的本机模拟服务可写。日常笔记库只读，测试写入只用 `runtime/` 合成库。
- 凭据、真实笔记、配置、私有路径报告和原始运行记录不进入 Git；`artifacts/` 与 `runtime/` 不发布。
- 保留适用的许可证和 `THIRD_PARTY_NOTICES.md`，不宣称未经核实的零派生来源或市场资格。
- 只有用户明确授权时才创建 Release；发布前运行 `pnpm check:release`。不自动启用部署、提交市场或安装到真实库。
