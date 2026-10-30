import type {
  ExpertCall,
  ExpertConsultation,
  ExpertDetail,
  ExpertOpinion,
  ExpertSummary,
  SkillSummary,
} from '@health-buddy/shared';
import { NOW, ids } from './mockApi';

/** 测试用的合成专家数据。不含真实客户信息；来源名称是合成的。 */

export const expertIds = {
  consultation: '90000000-0000-4000-8000-0000000000c1',
  consultation2: '90000000-0000-4000-8000-0000000000c2',
  callEndo: '90000000-0000-4000-8000-0000000000e1',
  callNutri: '90000000-0000-4000-8000-0000000000e2',
  callMental: '90000000-0000-4000-8000-0000000000e3',
};

export const ENDO: ExpertSummary = {
  id: 'endocrine-metabolism',
  name: '内分泌与代谢专家',
  tagline: '血糖、血脂、尿酸相关指标的解读要点',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
export const NUTRI: ExpertSummary = {
  id: 'nutrition',
  name: '营养专家',
  tagline: '结合客户数据给出饮食方面的建议要点',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
export const CARDIO: ExpertSummary = {
  id: 'cardiovascular',
  name: '心血管专家',
  tagline: '血压、心率和血脂的监测要点',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
export const MENTAL: ExpertSummary = {
  id: 'mental-health',
  name: '心理专家',
  tagline: '帮助健管师理解情绪、压力和睡眠情况',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
export const EXPERTS: ExpertSummary[] = [ENDO, NUTRI, CARDIO, MENTAL];

export const ENDO_DETAIL: ExpertDetail = {
  ...ENDO,
  strengths: ['合成擅长：血糖和血脂指标的关联'],
  outOfScope: ['合成不负责：药物选择和剂量（转介内分泌科医生）'],
  sources: [
    {
      sourceId: 'S1',
      name: '合成糖尿病防治指南',
      section: '一、糖尿病',
      publisher: null,
      version: null,
      priority: 1,
      scope: 'advice',
      status: 'candidate',
    },
    {
      sourceId: 'S2',
      name: '合成诊疗共识（文件原名）',
      section: '一、糖尿病',
      publisher: null,
      version: null,
      priority: 2,
      scope: 'referral_only',
      status: 'candidate',
    },
    {
      sourceId: 'S3',
      name: '合成血脂指南',
      section: '二、血脂',
      publisher: '合成学会',
      version: '2024版',
      priority: 1,
      scope: 'advice',
      status: 'confirmed',
    },
  ],
  cards: [
    {
      cardId: 'S1-01',
      sourceId: 'S1',
      section: '第 1 章',
      point: '合成卡片要点：监测空腹血糖',
      scope: 'advice',
      confirmed: false,
    },
    {
      cardId: 'S3-01',
      sourceId: 'S3',
      section: '第 2 章',
      point: '合成卡片要点：控制饱和脂肪',
      scope: 'advice',
      confirmed: true,
    },
  ],
  myUsageCount: 7,
};

export const SKILL_AUTO: SkillSummary = {
  id: 'report-interpretation',
  requiresClient: true,
  modes: ['plan', 'craft'],
  clientFacing: true,
  involvesHealthJudgment: true,
  requiresReport: false,
  usesReport: false,
  allowsEmptyRequest: false,
  planSkills: [],
  experts: 'auto',
  usesMaterials: false,
  usesHandoff: false,
  usesPlanOptions: false,
};

export function opinion(overrides: Partial<ExpertOpinion> = {}): ExpertOpinion {
  return {
    inScope: true,
    outOfScopeNote: null,
    summary: '合成结论：空腹血糖高于报告参考范围',
    findings: [
      {
        point: '合成要点：血糖偏高',
        basis: 'cited',
        dataRefs: [{ label: '空腹血糖', value: '6.5 mmol/L', date: '2026-09-12' }],
        citations: [
          { sourceId: 'S1', cardId: 'S1-01' },
          { sourceId: 'S3', cardId: 'S3-01' },
        ],
      },
    ],
    suggestions: [{ text: '合成建议：减少精制碳水', category: 'lifestyle', citations: [] }],
    referral: { needed: false, urgency: null, to: null, reason: null },
    questionsToAsk: [],
    dataGaps: [],
    crisisSignal: false,
    emergencySignal: false,
    ...overrides,
  };
}

export function call(overrides: Partial<ExpertCall> = {}): ExpertCall {
  return {
    id: expertIds.callEndo,
    expertId: ENDO.id,
    expertVersion: '0.1.0',
    selectedReason: 'manager',
    status: 'done',
    failureCategory: null,
    opinion: opinion(),
    removedFindings: 0,
    feedback: null,
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

export function consultation(overrides: Partial<ExpertConsultation> = {}): ExpertConsultation {
  return {
    id: expertIds.consultation,
    taskId: ids.task,
    messageId: ids.assistantMsg,
    trigger: 'mention',
    status: 'done',
    origin: null,
    reportCorrectedSince: false,
    followUpItemId: null,
    twinRefs: [],
    routing: {
      selected: [
        { expertId: ENDO.id, selectedReason: 'manager', reasons: [{ kind: 'manager' }] },
        {
          expertId: NUTRI.id,
          selectedReason: 'rule',
          reasons: [{ kind: 'indicator', code: 'fpg', direction: 'high' }],
        },
      ],
      excluded: [CARDIO.id],
      overCap: [],
      ruleOnly: false,
    },
    synthesis: null,
    synthesisStatus: 'skipped',
    crisisSignal: false,
    emergencySignal: false,
    calls: [call()],
    createdAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}
