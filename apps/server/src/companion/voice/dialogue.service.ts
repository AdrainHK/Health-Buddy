import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  checkinValuesInRange,
  type CompanionHandoffCategory,
  type CompanionScriptKind,
} from '@health-buddy/shared';
import {
  acceptCompanionMemory,
  acceptCompanionObservations,
  CHECKIN_METRIC_SPOKEN,
  isCompanionQuestion,
  buildCompanionMemoryRequest,
  buildCompanionRequest,
  checkCompanionReply,
  COMPANION_MEMORY_FORMAT,
  COMPANION_REPLY_FORMAT,
  companionMemoryOutputSchema,
  companionReplySchema,
  confirmsForgetAll,
  matchMemoriesToForget,
  normalizeTranscript,
  parseCheckinReading,
  parseCheckinStatus,
  parseConfirmation,
  preCheckCompanionInput,
  redactCompanionText,
  renderCompanionScript,
  spokenReading,
  type CompanionReply,
} from '@health-buddy/skills';
import type { DueCheckin } from '../../db/companion-checkins.js';
import type { CompanionMessageSignal } from '../../db/types.js';
import { TwinComputeService } from '../../twin/twin-compute.service.js';
import { DialogueRepository, type NewMessage } from './dialogue.repository.js';
import { CompanionSpeech } from './speech.service.js';

/** 速率（规格 5.4 第 6 条，Q30） */
export const COMPANION_TURNS_PER_MINUTE = 6;
export const COMPANION_TURNS_PER_DAY = 200;
/** 模型回答的输出上限：念出来的话很短，留余量给结构化字段 */
const MAX_OUTPUT_TOKENS = 600;

/** 测量值两次超出合理范围后不再追问，记成待确认的测量（规格 2.3） */
const READING_ATTEMPTS = 2;

/**
 * 一段要念的话：平台固定话术（vars 替换话术里的占位符，如测量项目、复述的数值），
 * 或通过了输出检查的模型回答
 */
export type Utterance =
  | { script: CompanionScriptKind; vars?: Readonly<Record<string, string>> }
  | {
      text: string;
      /** 健管师的转交回复（N13）：念完后标记已播报，聊天记录里记成 handoff_reply */
      replyId?: string;
    };

export interface DialogueTurn {
  utterances: Utterance[];
  /** 客户表示要结束（再见），念完后结束会话 */
  end: boolean;
}

interface SessionState {
  clientId: string;
  /** 福宝问过“全都忘掉吗”，等客户确认（N11） */
  awaitingForgetAll: boolean;
  checkin: CheckinState;
}

/** 打卡的对话状态（规格 2.3）：唤醒时补说到期的提醒，一条一条问 */
interface CheckinState {
  /** 这次会话还没问的到期提醒 */
  queue: DueCheckin[];
  /** 刚念过提醒，等客户回答 */
  asking: DueCheckin | null;
  /** 刚复述了数值，等客户确认 */
  confirming: { due: DueCheckin; values: number[] } | null;
  /** 这条提醒的数值超出合理范围的次数 */
  attempts: number;
}

/** 打卡这一轮的结果 */
interface CheckinTurn {
  utterances: Utterance[];
  /** 两次超出合理范围的数值，写成待确认的测量 */
  pending?: { metric: NonNullable<DueCheckin['metric']>; values: number[] };
  outcome: 'status' | 'confirm' | 'recorded' | 'critical' | 'retry' | 'pending' | 'duplicate';
}

function emptyCheckin(): CheckinState {
  return { queue: [], asking: null, confirming: null, attempts: 0 };
}

/** 提醒的话术：服药不说药名和剂量（N15），测量说项目名 */
function reminderOf(due: DueCheckin): Utterance {
  if (due.kind === 'medication') return { script: 'reminder_medication' };
  if (due.kind === 'exercise') return { script: 'reminder_exercise' };
  return { script: 'reminder_measurement', vars: { metric: CHECKIN_METRIC_SPOKEN[due.metric!] } };
}

/** 话术的文字（占位符已替换） */
export function scriptText(text: string, u: { vars?: Readonly<Record<string, string>> }): string {
  return u.vars ? renderCompanionScript(text, u.vars) : text;
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
    private readonly twin: TwinComputeService,
  ) {}

  async start(deviceId: string, clientId: string): Promise<string> {
    const sessionId = await this.repo.startSession(deviceId, clientId);
    this.sessions.set(sessionId, { clientId, awaitingForgetAll: false, checkin: emptyCheckin() });
    return sessionId;
  }

  /**
   * 唤醒后先说健管师的回复（N13：先念“您的健管师回复了……”，再念回复原文，不改写），
   * 再补说到期的打卡提醒（规格 2.3 暂行做法），然后听客户说话；都没有时不说话。
   * 今天还没说过“不是医生”时先说每日开场（N9）。念的话记进聊天记录；回复要等设备真正念完
   * 才标记已播报（markRepliesDelivered，合规审查 B1）。
   */
  async greet(deviceId: string, sessionId: string): Promise<Utterance[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const replies = await this.repo.pendingReplies(deviceId, state.clientId);
    const due = await this.repo.dueCheckins(deviceId, state.clientId);
    const first = due.shift();
    if (!replies.length && !first) return [];
    const utterances: Utterance[] = [];
    if (!(await this.repo.saidIntroToday(deviceId))) utterances.push({ script: 'daily_intro' });
    for (const reply of replies) {
      utterances.push({ script: 'handoff_reply_intro' }, { text: reply.text, replyId: reply.id });
    }
    if (first) {
      state.checkin = { queue: due, asking: first, confirming: null, attempts: 0 };
      utterances.push(reminderOf(first));
    }
    await this.record(deviceId, state.clientId, sessionId, [], utterances);
    this.logger.log(
      `companion greet ${JSON.stringify({ replies: replies.length, due: first ? due.length + 1 : 0 })}`,
    );
    return utterances;
  }

  /** 会话开始时福宝主动说的固定话术（开场白），记进聊天记录 */
  async noteScript(deviceId: string, sessionId: string, kind: CompanionScriptKind): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await this.record(deviceId, state.clientId, sessionId, [], [{ script: kind }]);
  }

  async respond(deviceId: string, sessionId: string, heard: string): Promise<DialogueTurn> {
    const state = this.sessions.get(sessionId);
    if (!state) return { utterances: [], end: true };
    // 识别偶尔输出繁体：规则、打卡数值、聊天记录都按简体
    const text = normalizeTranscript(heard);
    const { clientId } = state;

    const pre = preCheckCompanionInput(text);
    const urgent = pre.crisis || pre.emergency;
    // 速率超限时危机、急症照样处理（合规复审 B1），只是不再调用模型陪伴
    const counts = await this.repo.clientTurnCounts(deviceId);
    const limited =
      counts.minute >= COMPANION_TURNS_PER_MINUTE || counts.today >= COMPANION_TURNS_PER_DAY;
    if (limited && !urgent) {
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
    const needIntro = !(await this.repo.saidIntroToday(deviceId));
    // 每天第一次对话先说“不是医生”；危机、急症时求助话术先念（1 秒内开始），开场放到后面
    if (needIntro && !urgent) utterances.push({ script: 'daily_intro' });

    const signals = new Set<CompanionMessageSignal>();
    const handoffs: {
      category: CompanionHandoffCategory;
      trigger: 'rule' | 'model' | 'fallback';
    }[] = [];
    const alerts: { category: 'crisis' | 'emergency'; trigger: 'keyword' | 'model' }[] = [];
    let end = false;

    const awaiting = state.awaitingForgetAll;
    state.awaitingForgetAll = false;
    let checkin: CheckinTurn | null = null;

    if (urgent || pre.medical) {
      // 危机、急症、用药等问题优先；正在问的打卡先放下，下次唤醒再问（窗口内）
      state.checkin.asking = null;
      state.checkin.confirming = null;
    }

    if (urgent) {
      // 危机优先于急症：两种都命中时先念危机话术（含 120 和家人），两条预警都写
      if (pre.crisis) alerts.push({ category: 'crisis', trigger: 'keyword' });
      if (pre.emergency) alerts.push({ category: 'emergency', trigger: 'keyword' });
      utterances.push({ script: pre.crisis ? 'crisis' : 'emergency' });
      if (!limited) {
        const comfort = await this.modelReply(deviceId, sessionId, text, 'crisis');
        if (comfort.ok) {
          // 陪伴时模型另外识别出的信号也写预警（宁可多报）
          if (comfort.reply.crisisSignal && !pre.crisis) {
            alerts.push({ category: 'crisis', trigger: 'model' });
          }
          if (comfort.reply.emergencySignal && !pre.emergency) {
            alerts.push({ category: 'emergency', trigger: 'model' });
          }
          utterances.push({ text: comfort.reply.reply });
        }
      }
      if (needIntro) utterances.push({ script: 'daily_intro' });
    } else if (pre.medical) {
      // 用药、症状、诊断类问题优先于“忘掉”命令（合规复审 B2）
      handoffs.push({ category: pre.medical, trigger: 'rule' });
      utterances.push({ script: 'handoff' });
    } else if ((checkin = await this.checkinTurn(deviceId, state, text))) {
      utterances.push(...checkin.utterances);
    } else if (awaiting && confirmsForgetAll(text)) {
      await this.repo.deleteMemories(deviceId, clientId, 'all');
      signals.add('forget');
      utterances.push({ script: 'memory_forgotten_all' });
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
          clientId,
          matched.map((m) => m.id),
        );
        utterances.push({ script: 'memory_forgotten' });
      }
    } else {
      const result = await this.modelReply(deviceId, sessionId, text, 'normal');
      if (!result.ok) {
        handoffs.push({ category: 'other', trigger: 'fallback' });
        signals.add('fallback');
        utterances.push({ script: 'fallback' });
      } else if (result.reply.crisisSignal || result.reply.emergencySignal) {
        if (result.reply.crisisSignal) alerts.push({ category: 'crisis', trigger: 'model' });
        if (result.reply.emergencySignal) alerts.push({ category: 'emergency', trigger: 'model' });
        utterances.unshift({ script: result.reply.crisisSignal ? 'crisis' : 'emergency' });
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
    if (limited) signals.add('rate_limited');

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
    if (checkin?.pending) {
      const { metric, values } = checkin.pending;
      await this.repo.addPendingReading(
        deviceId,
        clientId,
        metric,
        values,
        `客户报的${CHECKIN_METRIC_SPOKEN[metric]}：${values.join('、')}（两次超出合理范围，没有写入监测）`,
        clientMessageId,
      );
    }
    // 日志只记类别和结果，不记文字和数值
    this.logger.log(
      `companion turn ${JSON.stringify({
        signals: [...signals],
        handoffs: handoffs.map((h) => h.category),
        checkin: checkin?.outcome ?? null,
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

  /** 回复原文已经完整念给客户：标记已播报，下次不再念 */
  async markRepliesDelivered(
    deviceId: string,
    sessionId: string,
    replyIds: readonly string[],
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !replyIds.length) return;
    await this.repo.markRepliesDelivered(deviceId, state.clientId, replyIds);
  }

  /**
   * 打卡的回答（规格 2.3、5.4 第 5 条），按规则识别，不调用模型；不是打卡的回答时返回 null，
   * 交给后面的普通对话（这条提醒留着，窗口内下次唤醒再问）。
   * - 服药、运动：记结果，念“好的，记下了”，接着问下一条；
   * - 测量：复述数值请客户确认 → 确认后写监测、念“记下了”（命中危急阈值时念危急指标话术，
   *   预警由数据库函数写）→ 孪生入队；说“不对”就请再说一遍；
   * - 数值超出合理范围请再说一遍，第二次仍超出不写监测，记成待确认的测量给健管师
   *   （命中危急阈值时念危急指标话术，预警由数据库函数写）。
   * 客户没被提醒、主动说“药吃了”“血压一百三八十六”时，对上今天到期的计划也按同样的流程；
   * 问句（“我今天药吃了吗”）不是回答，交给模型按今天的打卡回答（合规审查 B1）。
   */
  private async checkinTurn(
    deviceId: string,
    state: SessionState,
    text: string,
  ): Promise<CheckinTurn | null> {
    const c = state.checkin;
    if (c.confirming) {
      const { due, values } = c.confirming;
      c.confirming = null;
      const answer = parseConfirmation(text);
      if (answer === 'yes') {
        c.attempts = 0;
        const result = await this.repo.recordReading(
          deviceId,
          state.clientId,
          due.planId,
          due.slot,
          values,
        );
        if (result.checkinId) void this.twin.requestFromCompanion(state.clientId);
        const outcome = !result.checkinId
          ? 'duplicate'
          : result.criticalReadingId
            ? 'critical'
            : 'recorded';
        const said: Utterance =
          outcome === 'critical' ? { script: 'critical_value' } : { script: 'checkin_recorded' };
        return { utterances: [said, ...this.nextReminder(c)], outcome };
      }
      // “不对，是一百三十五”：直接按新的数再复述一次
      const again = parseCheckinReading(due.metric!, text);
      if (again) return this.readingAnswer(deviceId, c, due, again);
      if (answer === 'no') {
        c.asking = due;
        return { utterances: [{ script: 'checkin_retry' }], outcome: 'retry' };
      }
      return null;
    }
    if (c.asking) {
      const due = c.asking;
      c.asking = null;
      return this.answer(deviceId, state, due, text);
    }
    // 没被提醒时主动报的：只认说到了项目的（“药吃了”“血压……”），对上今天到期的计划
    const volunteered = volunteeredKind(text);
    if (!volunteered) return null;
    const due = (await this.repo.dueCheckins(deviceId, state.clientId)).find(
      (d) =>
        d.kind === volunteered.kind &&
        (volunteered.kind !== 'measurement' || d.metric === volunteered.metric),
    );
    if (!due) return null;
    c.queue = c.queue.filter((q) => q.planId !== due.planId || q.slot !== due.slot);
    return this.answer(deviceId, state, due, text);
  }

  private async answer(
    deviceId: string,
    state: SessionState,
    due: DueCheckin,
    text: string,
  ): Promise<CheckinTurn | null> {
    const c = state.checkin;
    if (due.kind === 'measurement') {
      const values = parseCheckinReading(due.metric!, text);
      return values ? this.readingAnswer(deviceId, c, due, values) : null;
    }
    const status = parseCheckinStatus(due.kind, text);
    if (!status) return null;
    c.attempts = 0;
    const id = await this.repo.recordCheckin(
      deviceId,
      state.clientId,
      due.planId,
      due.slot,
      status,
    );
    return {
      utterances: [{ script: 'checkin_noted' }, ...this.nextReminder(c)],
      outcome: id ? 'status' : 'duplicate',
    };
  }

  /**
   * 听到了测量值：在合理范围内就复述请确认；超出时请再说一遍，第二次仍超出记成待确认。
   * 记成待确认的数命中危急阈值时念危急指标话术（数据库函数同时写预警，合规审查 S3）
   */
  private async readingAnswer(
    deviceId: string,
    c: CheckinState,
    due: DueCheckin,
    values: number[],
  ): Promise<CheckinTurn> {
    const metric = due.metric!;
    if (!checkinValuesInRange(metric, values)) {
      c.attempts += 1;
      if (c.attempts >= READING_ATTEMPTS) {
        c.attempts = 0;
        const critical = await this.repo.readingCritical(deviceId, metric, values);
        return {
          utterances: [
            { script: critical ? 'critical_value' : 'checkin_recorded' },
            ...this.nextReminder(c),
          ],
          pending: { metric, values },
          outcome: 'pending',
        };
      }
      c.asking = due;
      return { utterances: [{ script: 'checkin_retry' }], outcome: 'retry' };
    }
    c.confirming = { due, values };
    return {
      utterances: [
        { script: 'checkin_confirm_reading', vars: { reading: spokenReading(metric, values) } },
      ],
      outcome: 'confirm',
    };
  }

  /** 接着问这次会话里下一条到期的提醒 */
  private nextReminder(c: CheckinState): Utterance[] {
    const next = c.queue.shift();
    if (!next) return [];
    c.asking = next;
    c.attempts = 0;
    return [reminderOf(next)];
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
      const turns = await this.repo.endSession(deviceId, clientId, sessionId);
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
    // 收集信息只给健管师（规格 2.7）；闲聊里的测量值记成待确认，不直接写监测
    const observations = acceptCompanionObservations(result.data.observations);
    await this.repo.addObservations(deviceId, clientId, sessionId, observations);
    // 情绪、睡眠类收集信息参与孪生“心理”“睡眠”的条数规则（M6 Q20）
    if (observations.some((o) => o.polarity && (o.category === 'mood' || o.category === 'sleep')))
      void this.twin.requestFromCompanion(clientId, 'companion');
    this.logger.log(
      `companion digest ${JSON.stringify({ memories: digest.memories.length, observations: observations.length })}`,
    );
  }

  private async modelReply(
    deviceId: string,
    sessionId: string,
    text: string,
    mode: 'normal' | 'crisis',
  ): Promise<{ ok: true; reply: CompanionReply } | { ok: false }> {
    try {
      const state = this.sessions.get(sessionId);
      if (!state) return { ok: false };
      const ctx = await this.repo.context(deviceId, state.clientId, sessionId);
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
        if (content) {
          messages.push({
            role: 'companion',
            kind: 'script',
            scriptKind: u.script,
            content: scriptText(content, u),
          });
        }
      } else {
        messages.push({
          role: 'companion',
          kind: u.replyId ? 'handoff_reply' : 'chat',
          content: u.text,
        });
      }
    }
    const ids = await this.repo.addMessages(deviceId, clientId, sessionId, messages);
    return client.length ? (ids[0] ?? null) : null;
  }

  /** 预警记下这一轮实际念的求助话术版本（危机、急症都命中时念的是危机话术） */
  private async scriptVersions(
    deviceId: string,
    utterances: readonly Utterance[],
  ): Promise<Map<string, number>> {
    const played = utterances.find(
      (u): u is { script: 'crisis' | 'emergency' } =>
        'script' in u && (u.script === 'crisis' || u.script === 'emergency'),
    );
    if (!played) return new Map();
    const [script] = await this.repo.scripts(deviceId, [played.script]);
    if (!script) return new Map();
    return new Map([
      ['crisis', script.version],
      ['emergency', script.version],
    ]);
  }
}

/** 没被提醒时主动报的打卡：说到了吃药、运动，或说到了测量项目 */
function volunteeredKind(
  text: string,
): { kind: DueCheckin['kind']; metric?: DueCheckin['metric'] } | null {
  const t = text.replace(/\s+/g, '');
  // 问句不是回答（“我今天药吃了吗”），交给模型按今天的打卡回答（合规审查 B1）
  if (isCompanionQuestion(t)) return null;
  // 说的是以前的事（“昨天量的血压……”）不算今天的打卡（规格 2.7：闲聊里的数值不写监测）
  if (/昨天|前天|上次|上回|那天|以前|之前|平时|前几天|上周/.test(t)) return null;
  if (/血压|高压|低压/.test(t)) return { kind: 'measurement', metric: 'bp' };
  if (/血糖/.test(t)) return { kind: 'measurement', metric: 'fpg' };
  if (/体重|称了|公斤|斤/.test(t)) return { kind: 'measurement', metric: 'weight' };
  if (/步数|走了.*步/.test(t)) return { kind: 'measurement', metric: 'steps' };
  if (/睡了.*(?:小时|钟头)/.test(t)) return { kind: 'measurement', metric: 'sleep_hours' };
  if (/药/.test(t)) return { kind: 'medication' };
  if (/运动|锻炼|散步|走路|练了|做操|打拳/.test(t)) return { kind: 'exercise' };
  return null;
}

function errorKind(err: unknown): string {
  if (err && typeof err === 'object' && 'kind' in err && typeof err.kind === 'string') {
    return err.kind;
  }
  return err instanceof Error ? err.name : typeof err;
}
