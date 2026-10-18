/**
 * 专家智能体框架（M3 规格 4.1、第五节）。
 *
 * 每位专家是 src/<专家 id>/ 下的一个目录：
 * - expert.md：元数据（--- 包起来的 key: value）+ 角色和分析流程提示词
 * - sources.md：知识来源清单和条目卡片（医学顾问写或审核）
 * - evals/cases.ts：评测用例
 *
 * 加载时校验元数据、禁用词、正文的必备小节、卡片总长度；published 状态还要满足上线条件（规格 5.4）。
 * 任何一项不满足都直接报错，构建和单元测试会失败。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CARD_ID_PATTERN,
  EXPERT_ID_PATTERN,
  EXPERT_STATUSES,
  INDICATOR_CODES,
  SOURCE_ID_PATTERN,
  SOURCE_SCOPES,
  findBannedTerms,
  type ExpertStatus,
  type SourcePriority,
  type SourceScope,
} from '@health-buddy/shared';
import { HEALTH_HISTORY_CATEGORIES } from '@health-buddy/skills';
import { z } from 'zod';

/** 正文必须依次包含的小节（规格 4.1） */
export const REQUIRED_SECTIONS = [
  '角色',
  '擅长的问题',
  '不负责的问题和转介去向',
  '分析流程',
  '输出要求',
  '禁止事项',
] as const;

/** 单位专家的条目卡片总长度上限（规格 3.7、Q3）：超过时提醒拆分或改用检索 */
export const CARDS_MAX_CHARS = 8000;

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const noBanned = (field: string) => (v: string) => {
  if (findBannedTerms(v).length) throw new Error(`expert.md 的 ${field} 含禁用词`);
  return v;
};

export const expertMetaSchema = z.object({
  id: z.string().regex(EXPERT_ID_PATTERN),
  name: z.string().min(2).max(20).transform(noBanned('name')),
  tagline: z.string().min(4).max(60).transform(noBanned('tagline')),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version 必须是语义化版本号'),
  status: z.enum(EXPERT_STATUSES),
  indicatorCodes: z
    .string()
    .default('')
    .transform(csv)
    .refine(
      (codes) =>
        codes.every((c) => c === '*' || (INDICATOR_CODES as readonly string[]).includes(c)),
      'indicatorCodes 只能是指标目录里的编码或 *',
    ),
  historyCategories: z
    .string()
    .default('')
    .transform(csv)
    .refine(
      (cats) => cats.every((c) => (HEALTH_HISTORY_CATEGORIES as readonly string[]).includes(c)),
      'historyCategories 只能是健康史类别',
    ),
  maxOutputTokens: z.coerce.number().int().min(500).max(4000).default(1500),
});
export type ExpertMeta = z.output<typeof expertMetaSchema>;

/** 读 expert.md：元数据和正文 */
export function parseExpertMd(text: string): { meta: ExpertMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('expert.md 缺少元数据');
  const raw: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const parsed = expertMetaSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || i.message))];
    throw new Error(`expert.md 元数据不合法：${fields.join('、')}`);
  }
  const body = (match[2] ?? '').trim();
  let from = 0;
  for (const section of REQUIRED_SECTIONS) {
    const at = body.indexOf(`## ${section}`, from);
    if (at === -1) throw new Error(`expert.md 缺少小节或顺序不对：${section}`);
    from = at;
  }
  return { meta: parsed.data, body };
}

/** 正文某个小节里的列表项（用于专家卡片的“擅长”“不负责”） */
export function sectionItems(body: string, section: string): string[] {
  const start = body.indexOf(`## ${section}`);
  if (start === -1) return [];
  const rest = body.slice(start + section.length + 3);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => /^- /.test(l))
    .map((l) => l.slice(2).trim());
}

export type SourceStatus = 'candidate' | 'confirmed' | 'retired';

export interface SourceEntry {
  sourceId: string;
  /** 文件名，照清单原样 */
  name: string;
  /** 清单里的病种分组标题（来源清单下的 ### 标题）；没有分组为空 */
  section: string | null;
  /** 颁布机构（issuer），照清单原样 */
  publisher: string | null;
  /** 版本，照清单原样（如“2024版”“2019主指南+2024合并症补充版”） */
  version: string | null;
  /** 1 国内官方指南 > 2 国内专家共识 > 3 国际学会指南 > 4 兜底细则 */
  priority: SourcePriority;
  /** advice 可以作为建议依据；referral_only 只用来识别什么时候该转介（规格 5.1） */
  scope: SourceScope;
  status: SourceStatus;
  confirmedBy: string | null;
  confirmedOn: string | null;
}

export interface SourceCard {
  cardId: string;
  sourceId: string;
  section: string;
  point: string;
  /** “可引用数值”原文；没有为空 */
  citableValues: string | null;
  /** 从“可引用数值”里取出的数字 */
  numbers: number[];
  population: string | null;
  /** 来源的优先级和使用范围（卡片跟随来源） */
  priority: SourcePriority;
  scope: SourceScope;
  /** 卡片有确认人和日期，并且来源已确认 */
  confirmed: boolean;
}

export interface SourcesDoc {
  /** 医学顾问在 sources.md 顶部的签字（姓名或代号、日期）；没签为空 */
  signOff: string | null;
  /** 来源清单的出处（如“产品负责人提供 2026-10-18”）；没写为空 */
  provenance: string | null;
  sources: SourceEntry[];
  cards: SourceCard[];
  /** sources.md 内容指纹 */
  version: string;
}

const STATUS_ZH: Record<string, SourceStatus> = {
  候选: 'candidate',
  待医学顾问核实: 'candidate',
  已确认: 'confirmed',
  已停用: 'retired',
};

/** 表格里“未填”的写法 */
const EMPTY = /^(?:—|-|无|未填|待核实|待确认|未签字)?$/;
const orNull = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return EMPTY.test(t) ? null : t;
};

const DATE = /\d{4}-\d{2}-\d{2}/;

/** 来源清单表格的列（规格 5.1），顺序固定 */
export const SOURCE_COLUMNS = [
  'sourceId',
  '文件名',
  '颁布机构',
  '版本',
  '优先级',
  '使用范围',
  '确认状态',
  '确认人',
  '确认日期',
] as const;

/**
 * 详情页显示的分组名称不能有的说法：禁用词之外，还有“决策”（如“AI 急救决策必备”）——
 * 专家只做参考，不做决策（规格 5.1）。
 */
const SECTION_WORDING = /决策/;

/**
 * 分组标题的显示名称：去掉括号里的说明（“九、心血管急症（AI 急救决策必备，不可缺失）”→“九、心血管急症”）。
 * 标题下一行写“显示名称：……”时用这一行（原文去掉括号后仍有禁用词时用）。
 */
function sectionDisplay(heading: string): string {
  return heading.replace(/\s*[（(][^）)]*[）)]/g, '').trim();
}

function checkShownText(where: string, text: string): void {
  if (findBannedTerms(text).length) throw new Error(`sources.md ${where}含禁用词`);
  if (SECTION_WORDING.test(text.replace(/\s+/g, '')))
    throw new Error(`sources.md ${where}含“决策”`);
}

/** “1级”“1 级”“1” → 1；其余为空 */
function parsePriority(v: string | undefined): SourcePriority | null {
  const m = /^([1-4])\s*级?$/.exec((v ?? '').trim());
  return m ? (Number(m[1]) as SourcePriority) : null;
}

/**
 * 读 sources.md（规格 5.1）：顶部签字、来源清单表格、条目卡片。
 * 卡片“可引用数值”不为空时必须有确认人和日期，否则只能在预览环境引用。
 */
export function parseSourcesMd(raw: string): SourcesDoc {
  // 代码块里是格式示例，不是卡片
  const text = raw.replace(/^```[\s\S]*?^```/gm, '');
  const signLine = /^>\s*顾问签字[：:]\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const signOff = orNull(signLine) && DATE.test(signLine) ? signLine : null;
  const provenance = orNull(/^>\s*来源清单出处[：:]\s*(.*)$/m.exec(text)?.[1]);

  const sources: SourceEntry[] = [];
  // 病种分组：来源清单里的 ### 标题（卡片编号形式的 ### 是卡片，不算分组）；遇到 ## 标题清空
  let section: string | null = null;
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) section = null;
    const heading = /^### (.+)$/.exec(line)?.[1]?.trim();
    if (heading && !CARD_ID_PATTERN.test(heading)) section = sectionDisplay(heading);
    const display = /^显示名称[：:]\s*(.+)$/.exec(line.trim())?.[1]?.trim();
    if (display && section !== null) section = sectionDisplay(display);
    if (!/^\|\s*S\d/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const [id, name, publisher, version, priorityCell, scopeCell, status, by, on] = cells;
    if (!id || !SOURCE_ID_PATTERN.test(id)) throw new Error(`sources.md 来源编号不合法：${id}`);
    if (cells.length !== SOURCE_COLUMNS.length) {
      throw new Error(
        `sources.md 来源 ${id} 的列数不对：应为 ${SOURCE_COLUMNS.join('、')} 共 ${SOURCE_COLUMNS.length} 列`,
      );
    }
    const priority = parsePriority(priorityCell);
    if (!priority) throw new Error(`sources.md 来源 ${id} 的优先级只能是 1级 到 4级`);
    const scope = (SOURCE_SCOPES as readonly string[]).includes(scopeCell ?? '')
      ? (scopeCell as SourceScope)
      : null;
    if (!scope) throw new Error(`sources.md 来源 ${id} 的使用范围只能是 advice 或 referral_only`);
    // 3级国际学会指南只作对标参考，不作为建议依据（各清单的版本质控说明）
    if (priority === 3 && scope !== 'referral_only') {
      throw new Error(`sources.md 来源 ${id} 是 3级国际学会指南，使用范围只能是 referral_only`);
    }
    // 详情页显示分组名称：文件名照原样可以含禁用词，分组名称不行（合规复审 C）
    if (section) checkShownText(`来源 ${id} 的分组名称`, section);
    const mapped = STATUS_ZH[status ?? ''];
    if (!mapped) {
      throw new Error(
        `sources.md 来源 ${id} 的确认状态只能是候选（待医学顾问核实）、已确认、已停用`,
      );
    }
    if (!name) throw new Error(`sources.md 来源 ${id} 缺少名称`);
    const confirmedBy = orNull(by);
    const confirmedOn = orNull(on);
    if (mapped === 'confirmed' && (!confirmedBy || !confirmedOn || !DATE.test(confirmedOn))) {
      throw new Error(`sources.md 来源 ${id} 已确认但缺少确认人或日期`);
    }
    if (sources.some((s) => s.sourceId === id)) throw new Error(`sources.md 来源编号重复：${id}`);
    sources.push({
      sourceId: id,
      name,
      section,
      publisher: orNull(publisher),
      version: orNull(version),
      priority,
      scope,
      status: mapped,
      confirmedBy,
      confirmedOn,
    });
  }

  const cards: SourceCard[] = [];
  // 只有标题是卡片编号的 ### 块才是卡片（来源清单的病种分组也用 ###）
  const blocks = text
    .split(/^### /m)
    .slice(1)
    .filter((b) => CARD_ID_PATTERN.test((b.split('\n')[0] ?? '').trim()));
  for (const block of blocks) {
    const [heading = '', ...lines] = block.split('\n');
    const cardId = heading.trim();
    const field = (key: string) =>
      lines
        .find((l) => l.startsWith(`- ${key}：`) || l.startsWith(`- ${key}:`))
        ?.replace(/^- [^：:]+[：:]/, '')
        .trim() ?? '';
    const sourceRef = field('来源');
    const sourceId = /^S\d{1,3}/.exec(sourceRef)?.[0] ?? '';
    const source = sources.find((s) => s.sourceId === sourceId);
    if (!source || !cardId.startsWith(`${sourceId}-`)) {
      throw new Error(`sources.md 卡片 ${cardId} 的来源不在来源清单里`);
    }
    const point = field('要点');
    if (!point) throw new Error(`sources.md 卡片 ${cardId} 缺少要点`);
    // 卡片的要点和章节会进提示词、显示在引用里，不能含禁用词（文件名的例外不适用于卡片）
    checkShownText(`卡片 ${cardId} 的要点`, point);
    checkShownText(`卡片 ${cardId} 的章节`, sourceRef);
    // 卡片可以单独标使用范围，只能比来源更窄：advice 来源里的某张卡片可以标 referral_only，反过来不行
    const cardScopeRaw = orNull(field('使用范围'));
    if (cardScopeRaw && !(SOURCE_SCOPES as readonly string[]).includes(cardScopeRaw)) {
      throw new Error(`sources.md 卡片 ${cardId} 的使用范围只能是 advice 或 referral_only`);
    }
    if (cardScopeRaw === 'advice' && source.scope === 'referral_only') {
      throw new Error(`sources.md 卡片 ${cardId} 的使用范围不能比来源宽（来源是 referral_only）`);
    }
    const cardScope = (cardScopeRaw as SourceScope | null) ?? source.scope;
    const citableValues = orNull(field('可引用数值'));
    const confirmation = orNull(field('确认'));
    const confirmed = Boolean(
      confirmation && DATE.test(confirmation) && source.status === 'confirmed',
    );
    cards.push({
      cardId,
      sourceId,
      section: sourceRef.replace(/^S\d{1,3}[，,]?\s*/, ''),
      point,
      citableValues,
      numbers: (citableValues?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
      population: orNull(field('适用人群')),
      priority: source.priority,
      scope: cardScope,
      confirmed,
    });
  }
  if (new Set(cards.map((c) => c.cardId)).size !== cards.length) {
    throw new Error('sources.md 卡片编号重复');
  }
  const cardChars = blocks.join('').length;
  if (cardChars > CARDS_MAX_CHARS) {
    throw new Error(
      `sources.md 条目卡片总长度 ${cardChars} 超过 ${CARDS_MAX_CHARS}，请拆分或改用检索`,
    );
  }
  return {
    signOff,
    provenance,
    sources,
    cards,
    version: createHash('sha256').update(raw).digest('hex').slice(0, 12),
  };
}

export interface ExpertDefinition {
  meta: ExpertMeta;
  /** expert.md 正文（专家自己的提示词） */
  prompt: string;
  strengths: string[];
  outOfScope: string[];
  sources: SourcesDoc;
}

/**
 * 从同目录的 expert.md 和 sources.md 构建专家定义。目录名必须和 id 一致。
 * evalCardRefs：评测用例引用到的卡片编号（规格 5.4：published 时这些卡片都要已确认）。
 */
export function loadExpert(dir: URL, evalCardRefs: readonly string[] = []): ExpertDefinition {
  const expert = parseExpertMd(readFileSync(new URL('expert.md', dir), 'utf8'));
  const sources = parseSourcesMd(readFileSync(new URL('sources.md', dir), 'utf8'));
  const folder = dir.pathname.replace(/\/$/, '').split('/').pop();
  if (folder !== expert.meta.id) throw new Error(`专家目录名和 id 不一致：${expert.meta.id}`);
  const def: ExpertDefinition = {
    meta: expert.meta,
    prompt: expert.body,
    strengths: sectionItems(expert.body, '擅长的问题'),
    outOfScope: sectionItems(expert.body, '不负责的问题和转介去向'),
    sources,
  };
  // 专家库卡片和详情页会显示擅长、不负责的问题，同样不能含禁用词（合规审查第 13 条）。
  // 来源的文件名是正式发布文件的原名（如“……诊断与治疗专家共识”），照原样保留、不改写，
  // 所以不在这里检查；文件名只出现在健管师端的专家详情页，不进提示词，也不会出现在给客户的文字里（规格 5.1）。
  const shown = [
    ...def.strengths.map((t) => ['擅长的问题', t]),
    ...def.outOfScope.map((t) => ['不负责的问题', t]),
  ];
  for (const [field, text] of shown) {
    if (findBannedTerms(text ?? '').length)
      throw new Error(`专家 ${expert.meta.id} 的${field}含禁用词`);
  }
  assertPublishable(def, evalCardRefs);
  return def;
}

/**
 * 上线条件（规格 5.4）：published 状态需要至少一条已确认来源、医学顾问签字、
 * 评测用例引用到的卡片都已确认。评测全部通过由 pnpm eval 把关，不在这里检查。
 */
export function assertPublishable(def: ExpertDefinition, evalCardRefs: readonly string[]): void {
  if (def.meta.status !== 'published') return;
  const problems: string[] = [];
  if (!def.sources.sources.some((s) => s.status === 'confirmed')) problems.push('没有已确认的来源');
  if (!def.sources.signOff) problems.push('sources.md 顶部没有医学顾问签字');
  for (const ref of evalCardRefs) {
    const card = def.sources.cards.find((c) => c.cardId === ref);
    if (!card?.confirmed) problems.push(`评测引用的卡片 ${ref} 未确认`);
  }
  if (problems.length) {
    throw new Error(`专家 ${def.meta.id} 不满足上线条件：${problems.join('、')}`);
  }
}

/**
 * 当前环境是否可用（规格 2.2、Q2）：published 正式可用；review 只在预览环境可用；
 * draft、retired 都不可用。
 */
export function statusAllowed(status: ExpertStatus, preview: boolean): boolean {
  return status === 'published' || (preview && status === 'review');
}

/** 知识来源还没有全部确认（卡片上标“知识来源待医学顾问确认，仅供试用”） */
export function sourcesPending(def: ExpertDefinition): boolean {
  return (
    !def.sources.signOff ||
    !def.sources.sources.length ||
    def.sources.sources.some((s) => s.status === 'candidate')
  );
}
