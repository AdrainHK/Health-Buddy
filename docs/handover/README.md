# 交接文档

每个里程碑结束时写一份交接文档，放在这个目录，文件名用里程碑编号（如 `M4.md`）。
目的：额度用完、会话中断或换一个 Claude 会话接手时，新会话读完这里就能继续工作，不需要重新问 Adrain。

## 新会话接手时先读

1. 仓库根目录 `CLAUDE.md`（红线规则和工作约定）。
2. 这个目录里最新的一份交接文档（编号最大的那份），重点看“进行中的工作”和“等 Adrain 的事”。
3. `docs/roadmap.md` 找下一个里程碑，`docs/specs/` 找对应规格。

## Adrain 的长期工作约定（逐字记录）

- “以后全部由你合并，无需征求我的意见。” CI 的 `check` 通过、复审没有阻断项就直接合并（squash）。
- “修改好后直接进入下一阶段工作，我会去核对，核对完告诉你结果，你不用等我确认。”
- 规格里“待产品确认的问题”一律按推荐答案执行（M3 的 26 个、M4 的 29 个都是这样定的），新里程碑可以在规格 PR 里用一张选择卡问一次是否全部按推荐。
- “在每一期工作结束的时候，你记得写一份详细的交接文档和你的记忆文档。”
- Adrain 用中文沟通，喜欢简短的回复。
- 评测费用（2026-10-28，M5 交接文档第六节）：目前只跑 OpenAI（仓库变量 `EVAL_PROVIDER=openai`），修改尽量攒成一次推送；评测还在跑时不要推送（会取消正在跑的那一轮）。

## 每个里程碑的固定做法

1. 用 `spec` 技能在 `docs/specs/` 写规格，开 PR，合并后实现。
2. 按规格第九节拆成若干小 PR，每个都带测试。每个 PR 用独立 git worktree（`.claude/worktrees/<名字>`），基于最新 `origin/main`。
3. 每个 PR 合并前：
   - 本地跑 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（服务端测试要 `service postgresql start`，并设置 `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/<库名>`，库用 `createdb` 新建）。
   - 涉及数据库、接口、权限：调用 `tenant-isolation-reviewer` 子代理复审。
   - 涉及提示词、专家、面向客户或健管师的 AI 文案：调用 `compliance-reviewer` 子代理复审。
   - 阻断项必须修；非阻断项能顺手修的一起修。
4. 改了提示词、专家、技能后要跑 `pnpm eval`（GitHub Actions “AI 评测” 工作流，见下）。
5. 每次提交结尾加：

   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: <当前会话链接>
   ```

## 常用操作

- 手动触发评测（只跑 OpenAI，每个用例 3 次）：

  ```
  gh api -X POST repos/AdrainHK/Health-Buddy/actions/workflows/385735460/dispatches \
    -f ref=<分支> -f 'inputs[provider]=openai' -f 'inputs[runs]=3' -f 'inputs[show_failures]=true'
  ```

- 合并 PR：`gh api -X PUT repos/AdrainHK/Health-Buddy/pulls/<N>/merge -f merge_method=squash -f sha=<head sha>`。
- 在 worktree 里 `origin/main` 可能不是跟踪分支，用 `git fetch origin main` 后基于 `FETCH_HEAD`。
- 只在仓库根目录跑 `pnpm format`。在子包目录里跑 prettier 会绕过根目录的 `.prettierignore`，把专家的 `.md` 文件也改掉。
- 子代理（worker）不能再开子代理，所以两个复审子代理只能由主会话调用。
