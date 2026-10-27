# Health Buddy 预览环境镜像：一个容器同时提供后端接口、工作台页面（/）和后台页面（/admin/），
# 同源，Cookie 不跨站。pnpm build 会一起构建工作台和后台。
FROM node:22.20.0-bookworm-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable

# 导出图片和 PDF 用的中文字体
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只复制依赖清单，依赖不变时可以复用这一层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/workbench/package.json apps/workbench/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/skills/package.json packages/skills/
COPY packages/experts/package.json packages/experts/
COPY packages/plan-library/package.json packages/plan-library/
COPY scripts/seed/package.json scripts/seed/
COPY scripts/eval/package.json scripts/eval/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production \
    WORKBENCH_DIST=/app/apps/workbench/dist \
    ADMIN_DIST=/app/apps/admin/dist \
    PORT=3000
EXPOSE 3000

USER node
CMD ["sh", "scripts/deploy/start.sh"]
