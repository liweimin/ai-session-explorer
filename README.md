# AI Session Explorer

AI Session Explorer 是一个本地优先的 AI coding 会话同步、检索、总结和回放工具。

它支持：

- Codex 会话
- Claude Code 会话
- 跨电脑同步历史会话
- 本地 Web 检索台
- Kimi / OpenAI-compatible 会话总结
- claude-replay editor 跳转

## 先理解一个关键点

这个项目采用双仓库模式：

| 仓库 | 可见性 | 放什么 |
| --- | --- | --- |
| `ai-session-explorer` | 公开 | 工具代码、页面、脚本、说明文档 |
| `ai-session-data` | 私有 | 你的真实聊天记录、归档记录、Claude Code 记录、Kimi 总结 |

这样以后可以开源工具，但不会把个人聊天记录放到公开仓库。

本仓库不支持旧的单仓库 `data/` 模式。必须配置 `SESSION_DATA_ROOT` 指向私有数据仓库里的 `data` 目录。

## 第一次使用

### 1. 准备两个仓库

工具仓库：

```powershell
git clone https://github.com/liweimin/ai-session-explorer.git
```

私有数据仓库：

```powershell
git clone https://github.com/<your-account>/ai-session-data.git
```

如果你是新用户，可以在 GitHub 新建一个 private repository，例如 `ai-session-data`，然后 clone 到本机。

推荐目录结构：

```text
D:\00容器\ai_sys\
  ai-session-explorer\
  ai-session-data\
    data\
```

### 2. 配置工具仓库

在 `ai-session-explorer` 目录复制一份配置：

```powershell
copy .env.local.example .env.local
```

编辑 `.env.local`，至少填这一项：

```env
SESSION_DATA_ROOT=D:\00容器\ai_sys\ai-session-data\data
```

如果要使用 Kimi 总结，再填：

```env
SUMMARY_BASE_URL=https://你的-kimi-compatible-api
SUMMARY_API_KEY=你的-key
SUMMARY_MODEL=kimi-for-coding
SUMMARY_API_FORMAT=openai
SUMMARY_INPUT_MAX_CHARS=120000
```

`.env.local` 只保存在本机，不会提交到 Git。

### 3. 开始工作前点击 Start

双击：

```text
Start-AISessionWork.bat
```

它会做三件事：

- 更新工具仓库
- 更新私有数据仓库
- 把私有数据仓库里的会话导入到本机 Codex / Claude Code

换电脑工作时，先点这个。

### 4. 查看和搜索历史

双击：

```text
Open-SessionExplorer.bat
```

它会打开：

```text
http://127.0.0.1:8788/
```

新仓库默认使用 `8788`，旧项目可以继续使用 `8787`，方便你同时打开做对比测试。

页面里点击“刷新最新记录”时，会把本机最新 Codex / Claude Code 会话导出到私有数据仓库的 `data` 目录，并重建本地索引。

### 5. 结束工作后点击 Finish

双击：

```text
Finish-AISessionWork.bat
```

它会做三件事：

- 从本机 Codex / Claude Code 导出最新会话
- 写入私有数据仓库
- commit 并 push 私有数据仓库

这样另一台电脑下次点 Start 就能拿到最新上下文。

## 每天怎么用

开始工作：

```text
Start-AISessionWork.bat
```

需要回看历史：

```text
Open-SessionExplorer.bat
```

结束工作：

```text
Finish-AISessionWork.bat
```

只记这三个入口即可。

## 数据会保存在哪里

私有数据仓库的 `data` 目录会包含：

```text
data\
  sessions\              Codex 当前历史
  archived_sessions\     Codex 归档历史
  claude\                Claude Code 历史
  session_summaries\     Kimi 总结缓存
  session_index.jsonl    Codex 会话索引
```

工具仓库的 `.cache` 只是本机缓存，可以删除，不需要提交。

## 可选：安装 claude-replay

只有点击“打开 Replay Editor”时才需要安装：

```powershell
npm install -g claude-replay
claude-replay --help
```

不安装也不影响搜索、查看详情、Kimi 总结。

## 常见问题

### 打开时报 Missing SESSION_DATA_ROOT

说明还没有配置 `.env.local`，或者配置没有生效。

检查：

```env
SESSION_DATA_ROOT=D:\00容器\ai_sys\ai-session-data\data
```

这个路径必须在私有数据仓库里，不能指向工具仓库自己的 `data` 目录。

### Start / Finish 拉取失败

先确认两个仓库都有 GitHub 权限：

```powershell
git -C D:\00容器\ai_sys\ai-session-explorer pull
git -C D:\00容器\ai_sys\ai-session-data pull
```

如果使用 GitHub CLI，可以检查：

```powershell
gh auth status
```

### Kimi 总结失败

检查 `.env.local` 里的：

```env
SUMMARY_BASE_URL=
SUMMARY_API_KEY=
SUMMARY_MODEL=
```

总结是手动触发的，不会自动把所有会话发给模型。

## 面向开源的定位

这个项目的价值不是“又一个聊天记录查看器”，而是：

- 把 AI coding 的历史上下文变成可检索、可回放、可总结的个人知识库
- 支持多台电脑工作时同步 Codex / Claude Code 会话
- 让工具开源、数据私有，适合个人长期使用
- 给非技术用户一个可点击的本地工作流，而不是要求手动找 JSONL 文件
