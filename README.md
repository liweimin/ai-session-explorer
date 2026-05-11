# AI Coding Sessions 同步与检索说明

这个项目现在不只面向 Codex，也支持 Claude Code。更准确的定位是：

> 本地优先的 AI coding 会话同步、检索、总结和回放工具。

日常使用只记住三个入口：

- 开始工作：`Start-AISessionWork.bat`
- 结束工作：`Finish-AISessionWork.bat`
- 回看历史：`Open-SessionExplorer.bat`

旧入口 `Start-CodexWork.bat` / `Finish-CodexWork.bat` 仍然保留，会自动转到新的 AI Sessions 入口，避免你原来的点击习惯失效。

## 一、当前支持两种数据模式

### 1. 默认单仓库模式

如果 `.env.local` 没有配置 `SESSION_DATA_ROOT`，项目继续使用当前仓库里的：

```text
data/
```

这是兼容模式，和之前用法一致。

### 2. 工具仓库 + 私有数据仓库模式

如果你想为后续开源做准备，推荐把真实会话数据放到另一个私有仓库，例如：

```text
C:\Users\你的用户名\ai-session-data\data
```

然后在本项目 `.env.local` 里配置：

```env
SESSION_DATA_ROOT=C:\Users\你的用户名\ai-session-data\data
```

这样职责会变成：

- 本项目：保存工具代码、页面、脚本、说明文档
- 私有数据仓库：保存真实 Codex / Claude Code 会话、Kimi 总结、同步数据

这就是后续开源最关键的拆分：**开源工具，不开源你的数据**。

## 二、三个入口分别做什么

- `Start-AISessionWork.bat`
  - 更新工具仓库
  - 如果 `SESSION_DATA_ROOT` 所在目录属于另一个 Git 仓库，也会更新那个私有数据仓库
  - 再把数据导入本机 `~/.codex` 和 `~/.claude`

- `Finish-AISessionWork.bat`
  - 从本机导出最新 Codex / Claude Code 会话
  - 写入 `SESSION_DATA_ROOT`
  - 如果使用外部私有数据仓库，会在数据仓库里 commit + push
  - 如果仍使用默认 `data/`，会按旧逻辑在当前仓库提交数据

- `Open-SessionExplorer.bat`
  - 启动或复用本地 `http://127.0.0.1:8787/` 服务
  - 检索台读取 `SESSION_DATA_ROOT` 指向的数据
  - 页面里“刷新最新记录”会从本机导出最新会话到 `SESSION_DATA_ROOT`，然后重建索引

## 三、推荐的长期目录结构

工具仓库：

```text
C:\Users\你的用户名\codex-sessions-sync
```

私有数据仓库：

```text
C:\Users\你的用户名\ai-session-data
  data/
    sessions/
    archived_sessions/
    claude/
    session_summaries/
    session_index.jsonl
```

工具仓库的 `.env.local`：

```env
SESSION_DATA_ROOT=C:\Users\你的用户名\ai-session-data\data
```

## 四、常用流程

到另一台电脑开始工作：

```text
Start-AISessionWork.bat
```

不确定该恢复哪条会话：

```text
Open-SessionExplorer.bat
```

结束工作并同步：

```text
Finish-AISessionWork.bat
```

## 五、可选能力

### Kimi / OpenAI-compatible 总结

在 `.env.local` 配置：

```env
SUMMARY_BASE_URL=https://api.example.com
SUMMARY_API_KEY=replace-with-your-key
SUMMARY_MODEL=kimi-for-coding
SUMMARY_API_FORMAT=openai
SUMMARY_INPUT_MAX_CHARS=120000
```

总结结果会保存到：

```text
SESSION_DATA_ROOT\session_summaries
```

如果你使用私有数据仓库，这些总结也会跟随私有数据仓库同步。

### claude-replay

`claude-replay` 不是必需依赖。只有点击“打开 Replay Editor”时才需要：

```powershell
npm install -g claude-replay
claude-replay --help
```

## 六、GitHub 私有数据仓库

如果你要使用“双仓库模式”，需要准备一个私有数据仓库。

如果本机已经登录 GitHub CLI，可以创建：

```powershell
gh repo create ai-session-data --private
```

当前这台电脑 `gh` 已安装，但还没有登录。需要先执行：

```powershell
gh auth login
```

如果你不想用 `gh`，也可以手动在 GitHub 新建 private repository，然后 clone 到本机。

## 七、同步内容

Codex：

- `sessions`
- `archived_sessions`
- `session_index.jsonl`
- `session_summaries`

Claude Code：

- `~/.claude/projects`
- `~/.claude/history.jsonl`

注意：同步的不是整台电脑配置，只是 AI coding 会话相关数据。
