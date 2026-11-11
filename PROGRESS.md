# Vault Weave 0.4.0

当前代码和文档从独立快照开始，插件 ID 为 `vault-weave`。文本合并、updated 本机保留、原始版本留存、执行前核验及恢复已实现；同步状态保持 format 2 与 `.plain-sync/`。

冻结安装、构建/类型/模块边界检查、118 项单元测试、2 项故障测试、双设备演示和隔离 Obsidian 验证均通过，结果见 `docs/VERIFICATION.md`。只在 `runtime/` 合成库和本机模拟 WebDAV 服务中执行写入测试，未向真实笔记库安装，未开放外部写入，未创建 Release 或提交社区市场。

下一阶段需另行决定：真实服务写入能力验证、正式库安装、社区目录资格与发布准备。当前不做 YAML 字段合并、字符级合并、移动识别或网络性能优化。

本地安装构建 `dist/vault-weave-0.4.0.zip`，校验清单 `dist/SHA256SUMS-0.4.0.txt`；这些产物不纳入 Git。
