# 健管AI助手（项目说明，供 Claude Code 读取）

健康管理师的 AI 智能体工作平台，SaaS 多租户。功能清单见 docs/feature-list.md，里程碑路线图见 docs/roadmap.md，需求规格在 docs/specs/。
大模型使用 Claude API，所有调用经 packages/ai-engine 的大模型网关。
产品理念：AI 负责收集、分析和起草，健管师负责判断和决策。

## 目录结构（M0 完成后生效，当前仓库只有文档和配置）
- apps/workbench   健管师工作台（React + Vite），WorkBuddy 式三栏布局
- apps/admin       平台总后台 + 运营商（协会）后台
- apps/client      客户端（先做 H5，后做微信小程序），含 AI 健康伴侣
- apps/server      后端 API（NestJS）
- packages/shared  共享类型和接口契约（zod），前后端都从这里引用
- packages/ai-engine  大模型网关、主智能体、技能框架、专家智能体引擎
- packages/experts    专家智能体定义（每个专家一个目录：expert.md、sources.md、evals/）
- packages/skills     工作台技能定义
- docs/specs  需求规格；docs/adr  架构决策记录

## 常用命令
- pnpm install / pnpm dev
- pnpm test          单元测试（Vitest）
- pnpm typecheck     类型检查
- pnpm lint
- pnpm e2e           端到端测试（Playwright）
- pnpm eval          AI 评测集（改提示词、专家、模型版本后必须跑）
- pnpm db:migrate    数据库迁移

## 红线规则（任何改动都必须遵守）
1. **租户隔离**：五级账号（平台、运营商、机构、健管师、客户）。所有业务查询必须通过带租户上下文的仓储层，禁止直接写绕过行级安全的 SQL。新增接口必须附“跨租户访问被拒绝”的测试。
2. **健康数据**：日志、错误信息、埋点中不得出现客户姓名、手机号、身份证号和健康指标原值；开发和测试只用 scripts/seed 生成的合成数据。
3. **AI 产物须审核**：涉及健康判断的 AI 产物（解读、方案、转介摘要等）一律以草稿保存，只有健管师审核通过后后端才允许发送给客户；状态校验必须在后端。
4. **伴侣边界**：AI 健康伴侣不对客户输出任何疾病风险判断；用药、症状、诊断类问题转健管师；风险信号只推送给健管师；不使用摄像头。
5. **产品边界用词**：面向客户和宣传的文案禁止“诊断”“筛查”“治愈”“根治”等表述；分析结果标注“仅供参考，非医疗诊断”。禁用词表在 packages/shared/compliance。
6. **密钥**：不读取、不打印、不提交 .env 和任何密钥。

## 工作约定
- 先读 docs/specs 里对应的规格；规格不清楚时先提问，不要猜。
- 改动较大或涉及数据库、租户、安全时，先用计划模式给出方案。
- 接口先改 packages/shared 里的契约，再改前后端。
- 每次改动都要带测试；完成前运行 pnpm typecheck、pnpm test。
- 涉及租户或权限的改动，提交前调用 tenant-isolation-reviewer 子代理；涉及面向客户的文案或提示词，调用 compliance-reviewer 子代理。
- 代码注释和提交信息用中文或英文均可，但同一文件保持一致。
