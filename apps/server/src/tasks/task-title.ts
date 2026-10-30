import { expertName } from '@health-buddy/experts';
import {
  TWIN_CONSULT_DEFAULT_REQUEST,
  TWIN_RULE_SOURCES,
  domainOfMetric,
  type TaskMode,
  type TwinDomain,
  type TwinRef,
} from '@health-buddy/shared';

/**
 * 任务标题自动生成（产品负责人反馈：对话记录列表每一行都是“新任务”，要改成这一轮对话的一句话
 * 概括，如“为王测试生成近况小结”）。
 *
 * 不调用模型：按第一轮的模式、技能、关联客户的称呼和问题摘要拼出来。和 DEFAULT_TASK_TITLE 一样，
 * 标题是存进 tasks 表的数据，模板写在后端；工作台照原样显示，超出侧栏宽度时用省略号截断。
 *
 * 标题里有客户称呼和问题原文，和消息内容一样只存在租户隔离的 tasks 行里，不写日志、错误信息和埋点。
 */

/** 自动标题最多几个字（侧栏一行大约能放下这么多，再长的由界面加省略号） */
export const AUTO_TITLE_MAX = 40;

export type AutoTitleSource = 'auto_text' | 'auto_skill';

export interface TitleTurn {
  mode: TaskMode;
  /** 技能或多步计划的 id */
  skillId: string | null;
  content: string;
  /** “请专家看看”（M4 规格 2.6 之二） */
  twinConsult: boolean;
  twinRefs: readonly TwinRef[];
  /** 直接请的专家：专家中心任务绑定的专家，或问一问里 @ 的专家 */
  expertIds: readonly string[];
}

/** 技能和多步计划的标题：[有客户, 没有客户]，{client} 换成客户称呼 */
const SKILL_TITLES: Record<string, readonly [string, string]> = {
  'client-recent-summary': ['为{client}生成近况小结', '生成近况小结'],
  'report-interpretation': ['为{client}解读体检报告', '解读体检报告'],
  'interview-outline': ['为{client}准备面谈提纲', '准备面谈提纲'],
  'twin-summary': ['为{client}生成孪生小结', '生成孪生小结'],
  'new-client-assessment': ['为{client}做新客户完整评估', '做新客户完整评估'],
  'twin-review': ['为{client}做孪生复盘', '做孪生复盘'],
};
/** 没有专门模板的技能（新登记的技能） */
const SKILL_FALLBACK: readonly [string, string] = ['为{client}调用技能', '调用技能'];

const MODE_PREFIX: Record<TaskMode, string> = {
  ask: '问一问：',
  plan: '想一想：',
  craft: '做一做：',
};

const DOMAIN_LABELS: Record<TwinDomain, string> = {
  metabolic: '代谢',
  cardiovascular: '心血管',
  sleep: '睡眠',
  weight: '体重',
  mental: '心理',
};

export function buildTaskTitle(
  turn: TitleTurn,
  clientName: string | null,
): { title: string; source: AutoTitleSource } {
  const client = clientName?.trim() || null;
  if (turn.skillId) {
    const [withClient, withoutClient] = SKILL_TITLES[turn.skillId] ?? SKILL_FALLBACK;
    const title = client ? withClient.replace('{client}', client) : withoutClient;
    return { title: clip(title), source: 'auto_skill' };
  }
  if (turn.twinConsult) {
    const label = twinLabel(turn.twinRefs);
    const subject = client ? `${client}的${label}` : label;
    return { title: clip(`请专家看看${subject}`), source: 'auto_text' };
  }
  const prefix = turn.expertIds.length
    ? `问${turn.expertIds.slice(0, 2).map(expertName).join('、')}：`
    : MODE_PREFIX[turn.mode];
  const text = excerpt(turn.content);
  const subject = client && !text.includes(client) ? (text ? `${client} · ${text}` : client) : text;
  return { title: clip(`${prefix}${subject}`), source: 'auto_text' };
}

/**
 * 问题摘要：取第一句，去掉换行、@ 符号和“请帮我”之类的开头，不带结尾的标点。
 * 默认问题（“请专家看看”）不算摘要。
 */
export function excerpt(content: string): string {
  const s = content.replace(/@/g, '').trim();
  if (s === TWIN_CONSULT_DEFAULT_REQUEST) return '';
  const first = (s.split(/[。！？!?；;\n]/).find((part) => part.trim()) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = first
    .replace(/^(你好|您好)[，,\s]*/, '')
    .replace(/^(请你?|麻烦你?|能不能|可不可以|可以)?\s*(帮我|帮忙)?\s*/, '')
    .replace(/[，,、：:\s]+$/, '')
    .trim();
  // 整句都是客套话时保留原句
  return stripped || first;
}

/** 按字（码位）截断，超长时以省略号结尾 */
function clip(text: string, max = AUTO_TITLE_MAX): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** 孪生项对应的方面，如“心血管状态”“心血管、代谢状态”；不认识的编码写“孪生状态” */
function twinLabel(refs: readonly TwinRef[]): string {
  const domains: TwinDomain[] = [];
  for (const ref of refs) {
    const domain =
      ref.kind === 'domain'
        ? ((ref.code in DOMAIN_LABELS ? ref.code : null) as TwinDomain | null)
        : (TWIN_RULE_SOURCES.map((s) => domainOfMetric(s, ref.code)).find(Boolean) ?? null);
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  if (!domains.length) return '孪生状态';
  return `${domains
    .slice(0, 2)
    .map((d) => DOMAIN_LABELS[d])
    .join('、')}状态`;
}
