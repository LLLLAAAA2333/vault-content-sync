# Vault Content Sync

[English](README.md)

WebDAV 内容核验与保守文本合并，面向 Obsidian 桌面端。

Vault Content Sync 把本地笔记库与指定 WebDAV 目录进行完整内容比较，按共同版本识别修改与冲突。Markdown 顶层 `updated` 仅保留本机，正文、其他属性和附件参与比较。

**0.5.0 是实验版本：外部 WebDAV 仅开放只读预览。** 写入、冲突应用和中断恢复只在随附的本机隔离模拟服务中开放。默认不自动连接、不自动同步。现已有[公开社区页面](https://community.obsidian.md/plugins/vault-content-sync)，自动扫描处理见[逐项核对](docs/SCORECARD_REVIEW.md)。

0.5.0 新增设置页“测试连接”、精简的源代码管理侧栏和主编辑区只读比较标签页；侧栏冲突片段按需展开。

## 能做什么

- 按内容核验笔记和附件，不依靠修改时间推断覆盖方向。
- 用共同版本进行行级三方合并，保留原始换行、BOM 和未修改内容。
- 相邻独立替换可以合并；重叠编辑、边界插入或定位不可靠时停止。
- 写入路径具备前提核验、条件请求、原始版本留存和中断恢复；目前用于隔离验证。
- 读取失败视为未知；没有共同版本时不自动合并不同内容或推断删除。

## 安装与使用

需要 Obsidian 桌面端 **1.14.4 或更新版本**。当前仅在 macOS 实机验证；不支持移动端。

1. 在隔离测试库中通过社区页面安装；也可从 [GitHub Releases](https://github.com/LLLLAAAA2333/vault-content-sync/releases) 下载同一版本的 `main.js`、`manifest.json`、`styles.css`，放入**隔离测试库**的 `<配置目录>/plugins/vault-content-sync/`。默认配置目录是 `.obsidian`，自定义时以该库的实际配置目录为准。
2. 在 Obsidian 的社区插件设置中启用 Vault Content Sync，打开插件设置。
3. 填写已确认的 WebDAV **HTTPS 文件夹地址**，用户名和密码分别填写。服务要求账号时，使用您自己的服务账号；不需要 Vault Content Sync 账号，也没有付费功能。
4. 可先在插件设置中点击“测试连接”：只检查指定目录，15 秒超时、响应最多 64 KiB，不读取笔记或创建同步状态。点击侧栏 Vault Content Sync 图标，或运行“完整核验并预览”，再点击刷新图标“核验内容”。首次运行只比较两端内容，不创建共同同步基线，也不修改笔记或远端文件。
5. 预览在左侧栏打开。“冲突 / 本地变更 / 远端变更”按组折叠，筛选图标展开文件名、路径和状态筛选。点击文件名，在主编辑区打开本地/远端只读比较；眼睛图标按需展开侧栏冲突片段，默认收起。文件操作在悬停、键盘聚焦或右键菜单中显示，连接测试和内容规则集中在插件设置中。没有共同版本时明确显示两端内容预览，不推断具体冲突行。外部连接不会执行上传、下载、合并应用或恢复；“隔离模拟服务写入”开关也不会开放外部写入，只用于本机测试服务。

文件较多时会完整读取两端内容，请等待核验完成。地址必须直接指向目标文件夹：插件不会跟随重定向，也不接受 URL 中的凭据、查询参数或片段。密码在停用插件或重启后需重新输入。设置已接入宿主搜索，可用 WebDAV、username、password 等英文词查找。

## 开发与验证

Node.js 24、pnpm 10：

```sh
pnpm install --frozen-lockfile
pnpm check:release
pnpm test
pnpm demo
pnpm e2e
```

`pnpm build` 输出 `dist/vault-content-sync/`，包含 `main.js`、`manifest.json`、`styles.css` 及许可证。GitHub Release 仅附安装所需的三个文件，完整许可证内嵌 main.js，校验值列在发布说明中。插件 ID 为 `vault-content-sync`。`pnpm check:release` 同时检查发布字段、兼容版本、安装附件和内嵌许可证。`pnpm e2e` 仅在 macOS 的独立 Obsidian 配置和 `runtime/` 合成库内验证，不访问日常笔记库。

```text
src/       插件入口、同步引擎、原生界面和纯计算合并模块
tests/     行为契约、同步与恢复回归测试
tools/     构建、模拟服务、隔离演示和故障测试
docs/      当前设计、合并规则与验证结果
```

## 使用边界与数据

仅向用户配置的 WebDAV 地址发送请求，用于列举文件并核验内容；不收集遥测，不连接项目自有服务。地址、用户名和模拟开关保存在当前库的插件配置中；密码仅保留在插件会话中，不写入配置。使用 Node.js 文件系统 API 完成流式核验、排他创建、硬链接留存与落盘保证；该 API 技术上具备访问系统其他文件的能力。正常插件操作使用当前笔记库，不扫描其他笔记库；实际配置目录（包括自定义名称）及默认排除目录不会作为笔记扫描或传输。服务器响应仅用于解析路径及文件内容，不执行其中的代码。

开发工具可操作显式指定的测试路径；测试写入限于 `runtime/` 合成数据。同步状态目录仍为 `.plain-sync/`、格式为 2，未因品牌更名改变；其中的原始版本和检查点不自动清理。格式 1 不自动迁移。

真实服务的条件写入与并发保证尚未验证，因此当前禁止外部写入。尚不支持移动端、YAML 字段级合并、字符级合并、移动识别、目录重命名识别和历史自动清理。

- [设计与数据保护边界](docs/DESIGN.md)
- [文本合并行为契约](docs/MERGE_CONTRACT.md)
- [验证结果](docs/VERIFICATION.md)
- [当前开发进度](PROGRESS.md)

- [发布前检查与审核范围](docs/RELEASE_REVIEW.md)

## 许可

采用 [MIT License](LICENSE)。依赖库及开发来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
