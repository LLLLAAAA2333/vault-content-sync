# Vault Content Sync 0.4.2

当前入口仍为本目录，插件 ID/仓库名 `vault-content-sync`，最低 Obsidian 1.14.4。0.4.1 已有公开社区页面：https://community.obsidian.md/plugins/vault-content-sync 。原来“尚未提交/发布目录”的当前状态说明已过时，历史 0.4.1 审查记录保留。

本轮按社区 35 项扫描逐项核对并修复：设置/JSON/错误/字节流边界校验、明确 Node 请求计时器、可搜索声明式设置、英文 README 和中文说明、贡献指南。保留直接文件系统能力和额外 `.obsidian` 排除并解释依据，没有通过隐藏规则或移除保护来追求零提示。完整清单：`docs/SCORECARD_REVIEW.md`。

冻结安装、构建、类型、模块边界、发布检查、150 项单元测试、2 项工具故障测试、双设备演示、隔离 Obsidian 1.14.4 均通过。官方推荐 lint 只剩额外 `.obsidian` 排除警告；Biome 原有 27 项风格警告/2 项提示不阻塞。生产依赖无已知漏洞报告。实际验证见 `docs/VERIFICATION.md` 与 `docs/evidence/verification.json`。

发布版本 0.4.2；使用仅手动触发的 GitHub Actions 构建/来源证明流程，不自动发布或部署。发布前核对云端产物与隔离实测构建逐字一致、验证 attestations，再只上传三个安装文件；校验值列入发布说明，许可证仍完整内嵌 main.js。记录见 `docs/releases/0.4.2.md`；社区新版本扫描结果需发布后观察。

状态 format 2、`.plain-sync/`、合并行为和外部只读限制不变。未访问/安装真实 Note 库、未连接真实 WebDAV。旧 plain-sync 仓库与历史、0.4.1 Release 均保留。正式人工来源政策判断、其他桌面平台实机与真实服务写入能力尚未验证。
