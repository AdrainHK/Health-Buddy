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

| 变量                      | 填什么                                                       |
| ------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`            | `${{Postgres.DATABASE_URL}}`（引用 Postgres 服务，照抄即可） |
| `APP_DATABASE_PASSWORD`   | 一串至少 16 位的随机字符，只给数据库用，不需要记住           |
| `PLATFORM_ADMIN_EMAIL`    | 平台管理员登录邮箱                                           |
| `PLATFORM_ADMIN_PASSWORD` | 平台管理员密码，至少 12 位                                   |
| `SEED_ALLOW`              | `yes`（只有预览环境设置；正式环境不要设）                    |
| `SEED_PASSWORD`           | 所有演示账号共用的密码，至少 12 位                           |
| `OPENAI_API_KEY`          | ChatGPT 的 API 密钥                                          |
| `ANTHROPIC_API_KEY`       | Claude API 开通后再加                                        |

可选：`OPENAI_MODEL`（默认 `gpt-6.1-sol`）、`LLM_DEFAULT_PROVIDER`（默认 `openai`）、`LLM_ROUTES`。说明见 `apps/server/.env.example`。

### 报告上传和识别（M2）

报告原件存在 S3 兼容的对象存储里，识别任务走 Redis 队列。这两样没配置时服务照常启动，只是上传报告和重新识别会提示“报告识别服务尚未配置”。

1. 在项目里点 **+ New → Database → Add Redis**，加一个 Redis 服务。
2. 准备一个对象存储桶（Railway 的 Bucket、Cloudflare R2、AWS S3 或 MinIO 都可以），**不要开公开访问**；地区和数据库放在同一地区（Q5）。
3. 在应用服务的 **Variables** 里加：

| 变量                   | 填什么                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `REDIS_URL`            | `${{Redis.REDIS_URL}}`（引用 Redis 服务，照抄即可）                                         |
| `S3_BUCKET`            | 桶名                                                                                        |
| `S3_ACCESS_KEY_ID`     | 访问密钥 ID                                                                                 |
| `S3_SECRET_ACCESS_KEY` | 访问密钥                                                                                    |
| `S3_ENDPOINT`          | 不是 AWS 时填服务商给的地址（如 R2 的 `https://<账号>.r2.cloudflarestorage.com`）；AWS 留空 |
| `S3_REGION`            | 地区，默认 `us-east-1`；R2 填 `auto`                                                        |
| `S3_FORCE_PATH_STYLE`  | MinIO 等需要路径风格时填 `true`，其他留空                                                   |

`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 三个要一起填，只填一部分时启动日志会提示缺了哪几个（只写变量名）。原件只能通过后端接口查看，存储里的文件名是随机 id，不含客户姓名。

密钥只填在 Railway 里，不要发在聊天里，也不要写进仓库。

### 随访素材加密（M5）

| 变量                 | 填什么                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `VISIT_MATERIAL_KEY` | 32 字节的随机密钥，base64 编码（在自己电脑上运行 `openssl rand -base64 32` 生成） |

健管师上传的聊天记录、通话笔记用这个密钥加密后存进数据库，30 天后自动删除原文。没设置时“上传随访素材”会提示服务尚未配置，其他功能照常。密钥一旦设置就不要再改，改了以后已上传但还没整理的素材就读不出来了。

### 伴侣设备密钥加密（M6）

| 变量 | 填什么 |
| --- | --- |
| `COMPANION_DEVICE_KEY` | 32 字节的随机密钥，base64 编码（同样用 `openssl rand -base64 32` 生成，**不要和 `VISIT_MATERIAL_KEY` 用同一个**） |

平台导入福宝设备批次时，每台设备的 HMAC 密钥用它加密后存进数据库，设备开机认证时解密验证。没设置时不能导入设备批次，设备也连不上。密钥一旦设置就不要再改，改了以后已导入的设备全部无法认证，只能重新导入。

`COMPANION_VOICE_ENABLED`：福宝语音通道开关，默认关闭。危机和急症推送给健管师的预警（M6 第 6 步）上线前，正式环境不要打开；预览环境和真设备联调时填 `true`。

福宝设备固件里的 OTA 地址配成 `https://<域名>/api/device/ota/`；对话通道 `wss://<域名>/ws/device` 由配置接口自动下发。

### 预览开关（M3、M5）

| 变量                   | 填什么                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `EXPERTS_PREVIEW`      | `true`（只有预览环境设置）：待审定的专家可用                               |
| `PLAN_LIBRARY_PREVIEW` | `true`（只有预览环境设置）：方案库里“待审定”的种子食谱、运动和目标模板可用 |

正式环境不要设这两个变量。方案库的种子内容在每次迁移后自动导入（只补数据库里还没有的条目，平台管理员改过的不覆盖），状态是“待审定”；营养、运动顾问审定后，由平台管理员在后台“方案库”里逐条发布，正式环境才能用。

## 每次部署做什么

`railway.json` 指定用 `Dockerfile` 构建，容器启动入口是 `scripts/deploy/start.sh`：

1. 用 `Dockerfile` 构建镜像（安装依赖、构建全部包）。
2. 容器启动时先运行 `scripts/deploy/predeploy.sh`（不依赖 Railway 的 Pre-deploy 设置）：
   - 执行数据库迁移，第一次部署时创建平台管理员，补齐方案库种子（待审定）；
   - `SEED_ALLOW=yes` 时，如果还没有演示数据就生成一套，已有就跳过。
3. 启动服务，用 `/api/health` 做健康检查。

如果 Railway 把仓库识别成多个服务（server、workbench、seed），只保留一个服务，在 Settings 里清空 Custom Build Command、Custom Start Command 和 Watch Paths，Builder 选 Dockerfile。

## 演示账号

邮箱见下表，密码都是 `SEED_PASSWORD`。

| 角色       | 协会A                                             | 协会B                                             |
| ---------- | ------------------------------------------------- | ------------------------------------------------- |
| 健管师     | `manager-a1@demo.healthbuddy.test`（a2、a3 同理） | `manager-b1@demo.healthbuddy.test`（b2、b3 同理） |
| 机构管理员 | `org-a@demo.healthbuddy.test`                     | `org-b@demo.healthbuddy.test`                     |
| 协会管理员 | `admin-a@demo.healthbuddy.test`                   | `admin-b@demo.healthbuddy.test`                   |

## 检查大模型是否连通

用平台管理员登录后，在浏览器开发者工具的控制台里运行：

```js
await (await fetch('/api/ai/smoke', { method: 'POST' })).text();
```

能看到一句流式返回的回答，说明网关和 API 密钥都正常。
