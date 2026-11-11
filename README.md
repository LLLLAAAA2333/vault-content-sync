# Vault Weave

WebDAV 内容核验与保守文本合并，面向 Obsidian 桌面端。

Vault Weave 把本地笔记库与指定 WebDAV 目录进行完整内容比较，按共同版本识别修改与冲突。Markdown 顶层 `updated` 仅保留本机，正文、其他属性和附件参与比较。

**0.4.0 是实验版本：外部 WebDAV 仅开放只读预览。** 写入、冲突应用和中断恢复只在随附的本机隔离模拟服务中开放。默认不自动连接、不自动同步，尚未发布到 Obsidian 社区目录。

## 能做什么

- 按内容核验笔记和附件，不依靠修改时间推断覆盖方向。
- 用共同版本进行行级三方合并，保留原始换行、BOM 和未修改内容。
- 相邻独立替换可以合并；重叠编辑、边界插入或定位不可靠时停止。
- 写入路径具备前提核验、条件请求、原始版本留存和中断恢复；目前用于隔离验证。
- 读取失败视为未知；没有共同版本时不自动合并不同内容或推断删除。

## 开发与验证

Node.js 24、pnpm 10：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm demo
pnpm e2e
```

`pnpm build` 输出 `dist/vault-weave/`，包含 `main.js`、`manifest.json`、`styles.css` 及许可证。插件 ID 为 `vault-weave`。`pnpm e2e` 仅在 macOS 的独立 Obsidian 配置和 `runtime/` 合成库内验证，不访问日常笔记库。

```text
src/       插件入口、同步引擎、原生界面和纯计算合并模块
tests/     行为契约、同步与恢复回归测试
tools/     构建、模拟服务、隔离演示和故障测试
docs/      当前设计、合并规则与验证结果
```

## 使用边界与数据

仅向用户配置的 WebDAV 地址发送请求，用于列举文件并核验内容；不收集遥测，不连接项目自有服务。密码仅保留在插件会话中，不写入配置。正常插件操作使用当前笔记库，不扫描其他笔记库。

开发工具可操作显式指定的测试路径；测试写入限于 `runtime/` 合成数据。同步状态目录仍为 `.plain-sync/`、格式为 2，未因品牌更名改变；其中的原始版本和检查点不自动清理。格式 1 不自动迁移。

真实服务的条件写入与并发保证尚未验证，因此当前禁止外部写入。尚不支持移动端、YAML 字段级合并、字符级合并、移动识别、目录重命名识别和历史自动清理。

- [设计与数据保护边界](docs/DESIGN.md)
- [文本合并行为契约](docs/MERGE_CONTRACT.md)
- [验证结果](docs/VERIFICATION.md)
- [当前开发进度](PROGRESS.md)

## 许可

采用 [MIT License](LICENSE)。依赖库及开发来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
