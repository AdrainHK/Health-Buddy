import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { CompanionHandoffCategory, CompanionScriptKind } from '@health-buddy/shared';
import {
  acceptCompanionMemory,
  buildCompanionMemoryRequest,
  buildCompanionRequest,
  checkCompanionReply,
  COMPANION_MEMORY_FORMAT,
  COMPANION_REPLY_FORMAT,
  companionMemoryOutputSchema,
  companionReplySchema,
  confirmsForgetAll,
  matchMemoriesToForget,
  preCheckCompanionInput,
  redactCompanionText,
  type CompanionReply,
} from '@health-buddy/skills';
import type { CompanionMessageSignal } from '../../db/types.js';
import { DialogueRepository, type NewMessage } from './dialogue.repository.js';
import { CompanionSpeech } from './speech.service.js';

/** 速率（规格 5.4 第 6 条，Q30） */
export const COMPANION_TURNS_PER_MINUTE = 6;
export const COMPANION_TURNS_PER_DAY = 200;
/** 模型回答的输出上限：念出来的话很短，留余量给结构化字段 */
const MAX_OUTPUT_TOKENS = 600;

/** 一段要念的话：平台固定话术，或通过了输出检查的模型回答 */
export type Utterance = { script: CompanionScriptKind } | { text: string };

export interface DialogueTurn {
  utterances: Utterance[];
  /** 客户表示要结束（再见），念完后结束会话 */
  end: boolean;
}

interface SessionState {
  clientId: string;
  /** 福宝问过“全都忘掉吗”，等客户确认（N11） */
  awaitingForgetAll: boolean;
}

/**
 * 福宝的一轮对话（M6 规格 2.2、5.3、5.4）。顺序：
 * 1. 速率超限 → rate_limited；
 * 2. 今天还没说过“不是医生” → 先念 daily_intro（N9）；
 * 3. 危机、急症关键词 → 先念求助话术、写预警，再让模型简短陪伴（同样经输出检查）；
 * 4. “忘掉……” → 删除记忆（N11）；用药、症状、诊断类问题 → 念转交话术、写转交，不调用模型；
 * 5. 其余调用模型 → 输出检查；不通过或出错 → 念兜底话术、写转交（不重试，避免老人干等）；
 *    模型判断要转交 → 念转交话术、写转交；模型判断有危机、急症 → 同第 3 条。
 * 客户说的和福宝说的都写进聊天记录；文字不进日志，日志只记类别和结果。
 */
@Injectable()
export class CompanionDialogue implements OnApplicationShutdown {
  private readonly logger = new Logger('CompanionDialogue');
  private readonly sessions = new Map<string, SessionState>();
  /** 进行中的会话结束整理；关闭服务时等它们写完 */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly repo: DialogueRepository,
    private readonly speech: CompanionSpeech,
  ) {}

  async start(deviceId: string, clientId: string): Promise<string> {
    const sessionId = await this.repo.startSession(deviceId, clientId);
    this.sessions.set(sessionId, { clientId, awaitingForgetAll: false });
    return sessionId;
  }

  /** 会话开始时福宝主动说的固定话术（开场白），记进聊天记录 */
  async noteScript(deviceId: string, sessionId: string, kind: CompanionScriptKind): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await this.record(deviceId, state.clientId, sessionId, [], [{ script: kind }]);
  }

  async respond(deviceId: string, sessionId: string, text: string): Promise<DialogueTurn> {
    const state = this.sessions.get(sessionId);
    if (!state) return { utterances: [], end: true };
    const { clientId } = state;

    const counts = await this.repo.clientTurnCounts(deviceId);
    if (counts.minute >= COMPANION_TURNS_PER_MINUTE || counts.today >= COMPANION_TURNS_PER_DAY) {
      await this.record(
        deviceId,
        clientId,
        sessionId,
        [text, ['rate_limited']],
        [{ script: 'rate_limited' }],
      );
      return { utterances: [{ script: 'rate_limited' }], end: false };
    }

    const utterances: Utterance[] = [];
    if (!(await this.repo.saidIntroToday(deviceId))) utterances.push({ script: 'daily_intro' });

    const pre = preCheckCompanionInput(text);
    const signals = new Set<CompanionMessageSignal>();
    const handoffs: {
      category: CompanionHandoffCategory;
      trigger: 'rule' | 'model' | 'fallback';
    }[] = [];
    const alerts: { category: 'crisis' | 'emergency'; trigger: 'keyword' | 'model' }[] = [];
    let end = false;

    const awaiting = state.awaitingForgetAll;
    state.awaitingForgetAll = false;

    if (pre.crisis || pre.emergency) {
      // 危机优先于急症：两种都命中时先念危机话术（含 120 和家人），两条预警都写
      if (pre.crisis) alerts.push({ category: 'crisis', trigger: 'keyword' });
      if (pre.emergency) alerts.push({ category: 'emergency', trigger: 'keyword' });
      utterances.push({ script: pre.crisis ? 'crisis' : 'emergency' });
      const comfort = await this.modelReply(deviceId, sessionId, text, 'crisis');
      if (comfort.ok) utterances.push({ text: comfort.reply.reply });
    } else if (awaiting && confirmsForgetAll(text)) {
      await this.repo.deleteMemories(deviceId, 'all');
      signals.add('forget');
      utterances.push({ script: 'memory_forgotten' });
    } else if (pre.forget) {
      signals.add('forget');
      if (pre.forget.all) {
        state.awaitingForgetAll = true;
        utterances.push({ script: 'memory_forget_confirm' });
      } else {
        const memories = await this.repo.memories(deviceId);
        const matched = matchMemoriesToForget(memories, pre.forget.query);
        await this.repo.deleteMemories(
          deviceId,
          matched.map((m) => m.id),
        );
        utterances.push({ script: 'memory_forgotten' });
      }
    } else if (pre.medical) {
      handoffs.push({ category: pre.medical, trigger: 'rule' });
      utterances.push({ script: 'handoff' });
    } else {
      const result = await this.modelReply(deviceId, sessionId, text, 'normal');
      if (!result.ok) {
        handoffs.push({ category: 'other', trigger: 'fallback' });
        signals.add('fallback');
        utterances.push({ script: 'fallback' });
      } else if (result.reply.crisisSignal || result.reply.emergencySignal) {
        if (result.reply.crisisSignal) alerts.push({ category: 'crisis', trigger: 'model' });
        if (result.reply.emergencySignal) alerts.push({ category: 'emergency', trigger: 'model' });
        utterances.push({ script: result.reply.crisisSignal ? 'crisis' : 'emergency' });
        // 模型这一轮的回答没有按危机模式生成，只在通过危机后的检查时念
        if (!checkCompanionReply(result.reply.reply, { crisis: true }).length) {
          utterances.push({ text: result.reply.reply });
        }
      } else if (result.reply.handoff) {
        handoffs.push({ category: result.reply.handoff, trigger: 'model' });
        utterances.push({ script: 'handoff' });
      } else {
        utterances.push({ text: result.reply.reply });
        end = result.reply.endSession;
      }
    }

    for (const a of alerts) signals.add(a.category);
    if (handoffs.length) signals.add('handoff');
    const clientMessageId = await this.record(
      deviceId,
      clientId,
      sessionId,
      [text, [...signals]],
      utterances,
    );
    const scriptVersions = await this.scriptVersions(deviceId, utterances);
    for (const a of alerts) {
      await this.repo.addAlert(deviceId, clientId, {
        messageId: clientMessageId,
        category: a.category,
        trigger: a.trigger,
        scriptVersion: scriptVersions.get(a.category) ?? null,
      });
    }
    for (const h of handoffs) {
      await this.repo.addHandoff(deviceId, clientId, {
        messageId: clientMessageId,
        category: h.category,
        question: redactCompanionText(text),
        trigger: h.trigger,
      });
    }
    this.logger.log(
      `companion turn ${JSON.stringify({
        signals: [...signals],
        handoffs: handoffs.map((h) => h.category),
        utterances: utterances.map((u) => ('script' in u ? u.script : 'reply')),
      })}`,
    );
    return { utterances, end };
  }

  /** 会话结束：记轮数，后台整理记忆和摘要（失败只记错误类型） */
  end(deviceId: string, sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!state) return Promise.resolve();
    const work = this.finish(deviceId, state.clientId, sessionId);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  /** 等进行中的会话结束整理写完 */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.settled();
  }

  private async finish(deviceId: string, clientId: string, sessionId: string): Promise<void> {
    try {
      const turns = await this.repo.endSession(deviceId, sessionId);
      if (turns === 0) return;
      await this.digest(deviceId, clientId, sessionId);
    } catch (err) {
      this.logger.error(`companion session end failed ${errorKind(err)}`);
    }
  }

  private async digest(deviceId: string, clientId: string, sessionId: string): Promise<void> {
    const turns = await this.repo.turns(deviceId, sessionId, 200);
    const existing = (await this.repo.memories(deviceId)).map((m) => m.text);
    const request = buildCompanionMemoryRequest(turns, existing.slice(0, 100));
    const result = await this.speech.completeStructured(
      deviceId,
      { ...request, maxOutputTokens: 1200 },
      { name: COMPANION_MEMORY_FORMAT, schema: companionMemoryOutputSchema },
    );
    if (result.status !== 'ok') return;
    const digest = acceptCompanionMemory(result.data, existing);
    await this.repo.saveSessionDigest(deviceId, clientId, sessionId, digest);
    this.logger.log(`companion digest ${JSON.stringify({ memories: digest.memories.length })}`);
  }

  private async modelReply(
    deviceId: string,
    sessionId: string,
    text: string,
    mode: 'normal' | 'crisis',
  ): Promise<{ ok: true; reply: CompanionReply } | { ok: false }> {
    try {
      const ctx = await this.repo.context(deviceId, sessionId);
      if (!ctx) return { ok: false };
      const history = await this.repo.turns(deviceId, sessionId);
      const request = buildCompanionRequest(ctx, [...history, { role: 'client', text }], mode);
      const result = await this.speech.completeStructured(
        deviceId,
        { ...request, maxOutputTokens: MAX_OUTPUT_TOKENS },
        { name: COMPANION_REPLY_FORMAT, schema: companionReplySchema },
      );
      if (result.status !== 'ok') return { ok: false };
      const reply = result.data;
      // 要转交、有危机信号时 reply 只是过渡语，不念，不查
      if (mode === 'normal' && (reply.handoff || reply.crisisSignal || reply.emergencySignal)) {
        return { ok: true, reply };
      }
      const issues = checkCompanionReply(reply.reply, { crisis: mode === 'crisis' });
      if (issues.length) {
        this.logger.warn(
          `companion reply rejected ${JSON.stringify({ categories: [...new Set(issues.map((i) => i.category))] })}`,
        );
        return { ok: false };
      }
      return { ok: true, reply };
    } catch (err) {
      this.logger.error(`companion reply failed ${errorKind(err)}`);
      return { ok: false };
    }
  }

  /** 写客户的话和福宝这一轮说的话，返回客户那句的 id */
  private async record(
    deviceId: string,
    clientId: string,
    sessionId: string,
    client: [string, CompanionMessageSignal[]] | [],
    utterances: readonly Utterance[],
  ): Promise<string | null> {
    const scripts = await this.repo.scripts(
      deviceId,
      utterances.flatMap((u) => ('script' in u ? [u.script] : [])),
    );
    const byKind = new Map(scripts.map((s) => [s.kind, s.text]));
    const messages: NewMessage[] = [];
    if (client.length) {
      messages.push({ role: 'client', kind: 'chat', content: client[0], signals: client[1] });
    }
    for (const u of utterances) {
      if ('script' in u) {
        const content = byKind.get(u.script);
        if (content)
          messages.push({ role: 'companion', kind: 'script', scriptKind: u.script, content });
      } else {
        messages.push({ role: 'companion', kind: 'chat', content: u.text });
      }
    }
    const ids = await this.repo.addMessages(deviceId, clientId, sessionId, messages);
    return client.length ? (ids[0] ?? null) : null;
  }

  private async scriptVersions(
    deviceId: string,
    utterances: readonly Utterance[],
  ): Promise<Map<string, number>> {
    const kinds = utterances.flatMap((u) =>
      'script' in u && (u.script === 'crisis' || u.script === 'emergency') ? [u.script] : [],
    );
    const scripts = await this.repo.scripts(deviceId, kinds);
    return new Map(scripts.map((s) => [s.kind, s.version]));
  }
}

function errorKind(err: unknown): string {
  if (err && typeof err === 'object' && 'kind' in err && typeof err.kind === 'string') {
    return err.kind;
  }
  return err instanceof Error ? err.name : typeof err;
}
