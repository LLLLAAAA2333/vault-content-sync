# 0.4.1 发布前检查（2026-11-11）

范围：本地代码与公开材料检查，以及 GitHub Release。没有登录社区目录提交，没有访问真实笔记库或真实 WebDAV。以下是本地核对结果，不是 Obsidian 官方审核结论。

## 已核对的要求

| 项目 | 结果及依据 |
| --- | --- |
| 名称与 ID | 显示名 `Vault Content Sync`，ID `vault-content-sync`；格式、保留字、英文名称符合当前规则。官方公开插件清单没有精确同名/同 ID；提交时仍需验证实时占用 |
| Manifest | 必需字段齐全，描述以动作开头、少于 250 字符并以句号结尾。描述限定为当前可用的内容比较，不声称外部同步已开放 |
| 版本与平台 | `0.4.1`；最低版本收窄到实测的 `1.14.4`。使用 Node.js，因此 `isDesktopOnly: true`；`versions.json` 与 manifest 一致 |
| README | 包含用途、隔离安装、设置和操作步骤；披露用户配置的网络服务、可能需要的服务账号、无付费/遥测、密码会话保存、外部写入禁用和测试范围 |
| 配置目录 | 从 `Vault.configDir` 获取当前配置目录，在本地和远端同时排除；直接读写以及旧基线中已不存在的配置文件也被阻止 |
| 凭据 | 接收 URL 时先验证，不持久化含 userinfo、查询参数或片段的地址；错误不回显输入。单独密码字段不调用 saveData，停用时清空 |
| 宿主 API 与界面 | 实例 app、Plugin.loadData/saveData、FileSystemAdapter instanceof 检查；命令 ID 为 preview 且名称不再重复插件名；移除单节设置页的手写 h2 |
| 内容安全 | 文件名和正文通过 text/value 展示，没有将远端内容写入 innerHTML 或执行为代码；无遥测、广告、自更新和运行时安装依赖；启动不自动联网 |
| 依赖与许可 | 冻结锁文件；仅打包 yaml 和 diff-sequences，保留适用 MIT/ISC 及来源记录；完整许可证内嵌 main.js，使 Obsidian 只安装三个文件时也能保留许可文本 |
| 安装附件 | main.js、manifest.json、styles.css 单独作为 Release 附件；tag 与 manifest 都为 0.4.1；附带 ZIP、许可文件及 SHA-256 清单 |
| 自动检查 | `pnpm check:release` 核对 manifest、版本映射、实际构建依赖图、附件与内嵌许可证；生产依赖审计未报告已知漏洞 |

## 设计选择与仍待官方确认的事项

使用 Node.js 流式读写核验完整原始字节；隔离写入实现需要排他创建、原 inode 留存及持久化恢复，因此没有直接改为 Vault.modify 或重新序列化 frontmatter。updated 的共享投影只去除指定源范围，避免格式化其他内容。当前外部连接不开放写入，这一实现仍可能在目录审核中被要求解释或调整。

新仓库与重写模块不等同官方已确认独立项目资格。保留简短真实来源和版权说明，不伪造作者授权。派生项目分类、公开名称最终占用、账号绑定和官方扫描结果均需提交时确认；本轮不联系原作者或代替用户作出授权声明。

测试仅在 macOS / Obsidian 1.14.4 与合成库执行，Windows/Linux、移动端、真实服务写入能力尚未验证。0.4.1 仍是实验性只读 WebDAV 预览版本，不能作为已开放真实同步的正式版本宣传。

## 官方依据

- [提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
- [Manifest 字段与命名](https://docs.obsidian.md/Reference/Manifest)
- [提交与 Release 流程](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [官方开发者自检清单](https://docs.obsidian.md/oo/plugin)
- [公开插件清单](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json)
