# Railway 预览环境

预览环境跟随 `main` 分支自动部署。一个 Railway 项目里有两个服务：

- **Health-Buddy**：用仓库根目录的 `Dockerfile` 构建，一个容器同时提供接口和工作台页面。
- **Postgres**：Railway 自带的 PostgreSQL。

Redis 在用到队列和定时任务的里程碑（M5 随访、M10 自动化）再加。

## 首次设置（只做一次）

1. 在 Railway 新建项目，选 **Deploy from GitHub repo**，选 `AdrainHK/Health-Buddy`，分支 `main`。第一次会要求授权 Railway 访问 GitHub。
2. 在同一个项目里 **New → Database → PostgreSQL**。
3. 打开 Health-Buddy 服务的 **Variables**，添加下表的变量。
4. 打开 **Settings → Networking → Generate Domain**，得到预览网址。
5. 等部署完成，打开 `https://<预览网址>/api/health`，看到 `{"status":"ok"}` 就成功了。

| 变量 | 填什么 |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`（引用 Postgres 服务，照抄即可） |
| `APP_DATABASE_PASSWORD` | 一串至少 16 位的随机字符，只给数据库用，不需要记住 |
| `PLATFORM_ADMIN_EMAIL` | 平台管理员登录邮箱 |
| `PLATFORM_ADMIN_PASSWORD` | 平台管理员密码，至少 12 位 |
| `SEED_ALLOW` | `yes`（只有预览环境设置；正式环境不要设） |
| `SEED_PASSWORD` | 所有演示账号共用的密码，至少 12 位 |
| `OPENAI_API_KEY` | ChatGPT 的 API 密钥 |
| `ANTHROPIC_API_KEY` | Claude API 开通后再加 |

可选：`OPENAI_MODEL`（默认 `gpt-6.1-sol`）、`LLM_DEFAULT_PROVIDER`（默认 `openai`）、`LLM_ROUTES`。说明见 `apps/server/.env.example`。

密钥只填在 Railway 里，不要发在聊天里，也不要写进仓库。

## 每次部署做什么

`railway.json` 指定用 `Dockerfile` 构建，容器启动入口是 `scripts/deploy/start.sh`：

1. 用 `Dockerfile` 构建镜像（安装依赖、构建全部包）。
2. 容器启动时先运行 `scripts/deploy/predeploy.sh`（不依赖 Railway 的 Pre-deploy 设置）：
   - 执行数据库迁移，第一次部署时创建平台管理员；
   - `SEED_ALLOW=yes` 时，如果还没有演示数据就生成一套，已有就跳过。
3. 启动服务，用 `/api/health` 做健康检查。

如果 Railway 把仓库识别成多个服务（server、workbench、seed），只保留一个服务，在 Settings 里清空 Custom Build Command、Custom Start Command 和 Watch Paths，Builder 选 Dockerfile。

## 演示账号

邮箱见下表，密码都是 `SEED_PASSWORD`。

| 角色 | 协会A | 协会B |
|---|---|---|
| 健管师 | `manager-a1@demo.healthbuddy.test`（a2、a3 同理） | `manager-b1@demo.healthbuddy.test`（b2、b3 同理） |
| 机构管理员 | `org-a@demo.healthbuddy.test` | `org-b@demo.healthbuddy.test` |
| 协会管理员 | `admin-a@demo.healthbuddy.test` | `admin-b@demo.healthbuddy.test` |

## 检查大模型是否连通

用平台管理员登录后，在浏览器开发者工具的控制台里运行：

```js
await (await fetch('/api/ai/smoke', { method: 'POST' })).text()
```

能看到一句流式返回的回答，说明网关和 API 密钥都正常。
