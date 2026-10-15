# Claude Code 配置模板

把本目录的内容复制到代码仓库根目录即可：
- CLAUDE.md                     项目说明和红线规则（Claude Code 每次启动自动读取）
- .claude/settings.json         权限和钩子（免确认的常用命令、禁止读密钥、编辑后自动格式化）
- .claude/agents/               子代理：租户隔离审查、合规审查、补测试
- .claude/commands/             命令：/spec、/new-expert、/new-skill

技术选型确定后，请架构师按实际命令和目录调整 CLAUDE.md。
