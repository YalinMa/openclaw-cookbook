# 参与贡献

[English](CONTRIBUTING.md) · **简体中文**

感谢你的帮助！欢迎提交新食谱、修复、翻译和更好的讲解。

## 新增一个食谱

1. 新建 `examples/NN-short-name/`，包含：
   - `workflow.json`：一个 Lobster 工作流，带 `name`、`description`，并把用户可能想修改的内容都声明为 `args`（附 `default` 和 `description`）
   - `README.md` 和 `README.zh-CN.md`，按现有食谱的结构编写（你会学到、运行方法、示例输出、工作原理、扩展思路、常见问题）
   - 如果需要输入文件，附上示例数据
2. 遵守以下约定：
   - **绝不把数据拼进 shell 命令。** 步骤输出用 `stdin` 或 `env` 传递，参数用 `$LOBSTER_ARG_NAME` 读取。
   - 尽量让食谱用默认参数、不需要账号就能运行（免费公共 API、示例文件）。
   - 任何会发送、发布、删除或花钱的操作，都要放在 `approval` 步骤之后。
   - 优先使用可撤销的操作（移动，而不是删除）。
   - 步骤中只使用 `node` 和 `curl`（凡是能运行 OpenClaw 的地方都有这两个工具）。
3. 在 `scripts/test-recipes.mjs` 中添加测试用例，检查结果的*内容*。
4. 运行：

   ```bash
   npm install
   npm run validate
   npm test
   ```

5. 把食谱添加到中英文两个 README 中。

## 报告问题

请附上 `openclaw --version`、插件版本（`openclaw plugins list`）、出问题的食谱，以及完整的报错信息（`openclaw logs --follow` 会有帮助）。

## 提交信息风格

简短的祈使句标题（例如 `Add recipe 11: RSS to Notion`），需要时在正文中补充细节。
