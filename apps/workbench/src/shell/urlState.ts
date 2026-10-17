/**
 * 把当前任务和打开的产物记在地址栏（?task=…&artifact=…），刷新页面后能恢复（验收反馈：
 * 刷新后产物和记录都空了）。只记 id，不记客户姓名等内容；id 能否访问仍由后端按行级安全判断。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UrlStateKey = 'task' | 'artifact';

/** 读出地址栏里的 id；格式不对时当作没有 */
export function readUrlId(key: UrlStateKey): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get(key);
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** 写入或删除地址栏里的 id（replaceState，不新增浏览记录） */
export function writeUrlId(key: UrlStateKey, value: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  } catch {
    // 地址栏写不进去（如沙箱环境）时不影响使用，只是刷新后不能恢复
  }
}
