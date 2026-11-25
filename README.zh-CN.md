# Vault Content Sync

[English](README.md)

WebDAV 内容核验与保守文本合并，面向 Obsidian 桌面端。

Vault Content Sync 把本地笔记库与指定 WebDAV 目录进行完整内容比较，按共同版本识别修改与冲突。Markdown 顶层 `updated` 仅保留本机，正文、其他属性和附件参与比较。

**0.6.4** 支持直接提交 WebDAV 变更。冲突页可逐段选择本地或远端、实时查看合并结果，也可手动编辑 Markdown。插件在你提交后才写入，保留两端原稿，并检查目标文件的写入条件。

## 能做什么

- 按内容核验笔记和附件，不依靠修改时间推断覆盖方向。
- 用共同版本进行行级三方合并，保留原始换行、BOM 和未修改内容。
- 相邻独立替换可以合并；重叠编辑、边界插入或定位不可靠时停止。
- 写入路径具备前提核验、条件请求、原始版本留存和中断恢复。
- 读取失败视为未知；没有共同版本时不自动合并不同内容或推断删除。

## 安装与使用

需要 Obsidian 桌面端 **1.14.4 或更新版本**。已在 macOS 使用，移动端不支持。

1. 在 [社区插件](https://community.obsidian.md/plugins/vault-content-sync) 中安装或更新。手动安装时，从同一 [GitHub Release](https://github.com/LLLLAAAA2333/vault-content-sync/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放入当前库的 `<配置目录>/plugins/vault-content-sync/`。
2. 启用 Vault Content Sync，在插件设置中填写 WebDAV **HTTPS 文件夹地址**、服务用户名和密码。
3. 点击左侧功能区图标，或运行「查看文件变化」，在侧栏点击「刷新变更」。
4. 点开冲突文件，逐段选择、采用整份版本或编辑 Markdown 合并结果，然后点「提交结果」。没有冲突的文件可用「提交变更」同步。

插件加载后的首轮刷新读取同步范围内的文件。后续刷新可复用本地未变更文件的摘要，并通过条件请求跳过未变化的远端正文。写入和恢复规则见 [WebDAV 同步](docs/WEBDAV_SYNC.md)。

内容规则见下文。没有共同版本时明确显示两端内容预览，不推断具体冲突行。写入前需要通过服务器能力验证，再确认本次操作。

当前开发版刷新默认增量核验：插件加载后首轮完整读取；后续仍列出两端目录，本地文件标识/大小/高精度时间不变则复用哈希，远端通过条件 GET 确认不变后不再传输正文。每个远端文件仍有一次条件请求；缺失或弱版本标识、服务器忽略条件而返回正文时会完整读取。点击“更多操作 → 完整核验所有文件”，或运行同名命令，可强制重读所有文件。悬停结果摘要可查看复用项数和实际读取量。缓存仅驻留本次插件运行，不写入笔记库；重启后重新建立。仅测试连接不会读取笔记。已发布 0.5.0 仍采用完整读取。地址必须直接指向目标文件夹：插件不会跟随重定向，也不接受 URL 中的凭据、查询参数或片段。已发布 0.5.0 的密码在停用插件或重启后需重新输入。开发版填写密码后可开启“记住密码”，重启后继续使用；关闭时仅本次有效。密码框隐藏内容、禁止复制和剪切；修改已记住的密码后，离开输入框时保存。设置已接入宿主搜索，可用 WebDAV、username、password 等英文词查找。

内容规则：仅忽略 Markdown 顶层 `updated`；不重新格式化正文或其他属性。排除实际 Obsidian 配置目录、`.obsidian`、`.claudian`、`.git`、`.sync_state.json`、`.sync_trash`、`.DS_Store`、`.plain-sync`、`.trash` 及符号链接。历史版本与恢复内容保存在 `.plain-sync`，不自动清理。

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

插件只向配置的 WebDAV 地址发送请求，不收集遥测。地址和用户名保存在当前库的插件配置中。密码默认只保留在会话内；开启「记住密码」后，由 Obsidian SecretStorage 在本机加密存储，配置文件只保留与地址和用户名绑定的密钥引用。更换地址或用户名会清除连接绑定。插件使用 Node.js 文件系统 API 流式读取、保存恢复版本和写入当前库的同步文件。服务器响应只作为数据解析。

开发工具可操作显式指定的测试路径；测试写入限于 `runtime/` 合成数据。同步状态目录仍为 `.plain-sync/`、格式为 2，未因品牌更名改变；其中的原始版本和检查点不自动清理。格式 1 不自动迁移。

改写远端已有文件要求服务器提供强 ETag 并正确处理条件请求。尚不支持 YAML 字段级合并、字符级合并、移动识别、目录重命名识别和历史自动清理。

- [设计与数据保护边界](docs/DESIGN.md)
- [文本合并行为契约](docs/MERGE_CONTRACT.md)
- [验证结果](docs/VERIFICATION.md)
- [当前开发进度](PROGRESS.md)

- [发布前检查与审核范围](docs/RELEASE_REVIEW.md)

## 许可

采用 [MIT License](LICENSE)。依赖库及开发来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
