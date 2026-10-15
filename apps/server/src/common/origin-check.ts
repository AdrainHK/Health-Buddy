import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 修改类请求只接受同源发起。会话 Cookie 已经是 SameSite=Lax，这里再加一层：
 * 有 Origin 头就必须和本站同主机；没有 Origin 头时，浏览器标明跨站的请求一律拒绝。
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || isSameOrigin(req)) {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden_origin' });
}

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}
