# DSH-Plugins

DeepSeek Harness（DSH）个人插件集合 — Rio Zhao（SUEZ Asia）。

每个子目录是一个独立的 npm 包，自包含（各自的源码、manifest、测试），
从子目录直接发布，不需要 monorepo 工具。

| npm 包 | 版本 | 说明 |
|---|---|---|
| [dsh-kb-query](./dsh-kb-query) | 0.1.1 | 知识库 RAG 检索：`kb_search` 工具 + 输入框知识库选择器，pgvector（默认）/ OWUI 双后端，带 rerank |
| [dsh-office-docs-win](./dsh-office-docs-win) | 1.0.1 | Windows 上创建/读取/校验 Office 文件（.pptx/.docx/.xlsx/.pdf），免 Python，含 Office COM 渲染 |
| [dsh-plugin-prompt-shortcuts](./dsh-plugin-prompt-shortcuts) | 1.5.1 | 提示词快捷按钮：`{{变量}}` 占位、中英文双版本、设置页管理、一键生成英文版 |
| [dsh-plugin-outlook-owa](./dsh-plugin-outlook-owa) | 0.5.2 | 读写 Outlook Web（OWA）邮件与日历，复用本机浏览器会话，自带技能文档（SKILL.md） |

## 安装

发布到 npm 后：

```powershell
dsh plugin --profile web add dsh-kb-query
dsh plugin --profile web add dsh-office-docs-win
dsh plugin --profile web add dsh-plugin-prompt-shortcuts
dsh plugin --profile web add dsh-plugin-outlook-owa
```

装完重启 DSH 即可。各插件的详细用法与配置说明见其 README。

## 许可

各插件均为 MIT 许可，详见各子目录的 LICENSE 文件（含第三方代码归属声明）。
