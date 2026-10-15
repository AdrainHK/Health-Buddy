import { Injectable } from '@nestjs/common';

interface Running {
  managerId: string;
  abort: AbortController;
}

/**
 * 正在进行的生成，按任务登记，用于“停止”（规格 3.2）。
 * 一个任务同一时间只有一个生成；登记时记下健管师，停止前再核对一次归属。
 */
@Injectable()
export class GenerationRegistry {
  private readonly running = new Map<string, Running>();

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** 已有生成时返回 undefined */
  start(taskId: string, managerId: string): AbortController | undefined {
    if (this.running.has(taskId)) return undefined;
    const abort = new AbortController();
    this.running.set(taskId, { managerId, abort });
    return abort;
  }

  finish(taskId: string, abort: AbortController): void {
    if (this.running.get(taskId)?.abort === abort) this.running.delete(taskId);
  }

  /** 只停当前健管师自己的生成；返回是否真的停了一个 */
  stop(taskId: string, managerId: string): boolean {
    const entry = this.running.get(taskId);
    if (!entry || entry.managerId !== managerId) return false;
    entry.abort.abort();
    return true;
  }
}
