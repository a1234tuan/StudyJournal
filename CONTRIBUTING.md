# Contributing to StudyJournal

感谢你愿意改进 StudyJournal。项目优先保证本地数据安全、可恢复性和跨设备同步的确定性，其次才是新增功能。

## 开始之前

1. 对缺陷或较大改动先创建 Issue，说明用户场景、预期行为和影响范围。
2. 不要在 Issue、提交、测试夹具或截图中包含 API Key、OAuth Secret、备份文件或真实学习数据。
3. 使用 Node.js 24，在 Windows 上执行完整验证；其他平台可进行 Web 开发，但原生构建仍需对应工具链。

```powershell
npm ci
npm run dev
```

## 提交要求

- 保持改动聚焦，避免把无关格式化或重构混入同一提交。
- 修改编辑器节点时，检查搜索、AI 上下文、Markdown、备份和恢复。
- 修改正式数据或同步行为时，检查 Dexie 迁移、墓碑、冲突、增量配额、导入导出和隐私边界。
- 新增行为应提供确定性测试；自动化测试不得调用真实 AI Provider。
- 用户界面错误必须经过统一错误映射，不能直接展示原始异常或敏感上下文。

提交 Pull Request 前运行：

```powershell
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

涉及 Android 或 Windows 壳层时，还应完成对应构建和真实设备人工检查，并在 PR 中列出未验证项。

## Pull Request

PR 描述应包含问题、解决方式、数据/同步影响、测试结果、截图或录屏，以及仍需人工验证的内容。提交即表示你同意所贡献代码按本仓库的 MIT License 发布。
