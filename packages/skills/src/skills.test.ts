import { DISCLAIMER } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clientRecentSummary, type RecentSummaryOutput } from './client-recent-summary/index.js';
import { parseSkillMeta } from './framework.js';
import { SNAPSHOTS } from './fixtures.js';
import {
  CRISIS_NOTICE,
  GUARDRAILS,
  buildSystemPrompt,
  checkClientText,
  detectCrisisKeywords,
  finalizeClientText,
  redactClientIdentity,
} from './guardrails.js';
import { ASK_NOTICE, criticalNotice, suggestSkill } from './ask.js';
import { getSkill, skillSummaries } from './registry.js';

describe('skill metadata', () => {
  it('reads the sample skill from skill.md', () => {
    expect(clientRecentSummary).toMatchObject({
      id: 'client-recent-summary',
      kind: 'recent_summary',
      requiresClient: true,
      modes: ['plan', 'craft'],
      clientFacing: true,
      involvesHealthJudgment: true,
    });
    expect(clientRecentSummary.prompt).toContain('客户近况小结');
  });

  it('rejects malformed metadata', () => {
    const ok = {
      id: 'demo',
      kind: 'k',
      requiresClient: 'true',
      modes: 'craft',
      clientFacing: 'false',
      involvesHealthJudgment: 'false',
    };
    expect(() => parseSkillMeta(ok)).not.toThrow();
    expect(() => parseSkillMeta({ ...ok, id: 'Bad Id' })).toThrow();
    expect(() => parseSkillMeta({ ...ok, modes: 'ask' })).toThrow();
    expect(() => parseSkillMeta({ ...ok, clientFacing: 'yes' })).toThrow();
  });

  it('lists skills for the API and looks them up by id', () => {
    expect(skillSummaries()).toEqual([
      {
        id: 'client-recent-summary',
        requiresClient: true,
        modes: ['plan', 'craft'],
        clientFacing: true,
        involvesHealthJudgment: true,
      },
    ]);
    expect(getSkill('client-recent-summary')).toBe(clientRecentSummary);
    expect(getSkill('nope')).toBeUndefined();
  });
});

describe('guardrails', () => {
  it('puts the shared rules before the skill prompt and injects the banned terms', () => {
    const prompt = buildSystemPrompt(clientRecentSummary);
    expect(prompt.startsWith(GUARDRAILS)).toBe(true);
    expect(prompt).toContain(clientRecentSummary.prompt);
    for (const term of ['诊断', '筛查', '治愈', '根治']) expect(GUARDRAILS).toContain(`“${term}”`);
  });

  it('appends the disclaimer exactly once', () => {
    expect(finalizeClientText('您好，最近血压平稳。')).toBe(
      `您好，最近血压平稳。\n\n${DISCLAIMER}`,
    );
    expect(finalizeClientText(`您好。\n${DISCLAIMER}\n`)).toBe(`您好。\n\n${DISCLAIMER}`);
    expect(finalizeClientText(`您好。（${DISCLAIMER}`)).toBe(`您好。\n\n${DISCLAIMER}`);
    expect(finalizeClientText(`您好（${DISCLAIMER}）。多走路。`)).toBe(
      `您好多走路。\n\n${DISCLAIMER}`,
    );
    expect(finalizeClientText('您好。仅供参考,非医疗诊断。')).toBe(`您好。\n\n${DISCLAIMER}`);
    // 夹空格、零宽字符、逗号写成句号，都不会留下重复的声明
    for (const variant of [
      '仅供参考 ，非医疗诊断',
      '仅供参考，非医疗 诊\u200B断',
      '仅供参考。非医疗诊断',
    ]) {
      expect(finalizeClientText(`您好。${variant}。多走路。`), variant).toBe(
        `您好。多走路。\n\n${DISCLAIMER}`,
      );
    }
  });

  it('checks banned terms and the disclaimer', () => {
    expect(checkClientText(finalizeClientText('您好，坚持快走。'))).toEqual({
      bannedTerms: [],
      hasDisclaimer: true,
      judgementHints: [],
      criticalValueMentions: [],
    });
    const bad = checkClientText('您好，可以根 治。');
    expect(bad.hasDisclaimer).toBe(false);
    expect(bad.bannedTerms.map((t) => t.term)).toEqual(['根治']);
  });

  it('hints at disease wording and critical values without blocking', () => {
    const flags = SNAPSHOTS.criticalHighBp.criticalFlags;
    const result = checkClientText(
      '您好，最近收缩压到了 185，有中风风险，和 18 天前比有所上升。',
      flags,
    );
    expect(result.judgementHints.map((h) => h.text)).toEqual(['有中风风险']);
    expect(result.criticalValueMentions).toEqual([{ metric: 'sbp', value: 185, index: 11 }]);
  });

  it('detects crisis keywords without relying on the model', () => {
    expect(detectCrisisKeywords(['帮我写小结', '她说最近活着 没意思'])).toBe(true);
    expect(detectCrisisKeywords(['帮我写小结，她最近睡得少'])).toBe(false);
  });

  it('removes the client name, nicknames and phone number from manager text', () => {
    const text = '帮我给张阿姨写个小结，张秀英电话 13800001234，小英最近忙';
    expect(redactClientIdentity(text, ['张秀英', '小英', '13800001234'])).toBe(
      '帮我给该客户写个小结，该客户电话 该客户，该客户最近忙',
    );
  });

  it('uses the generic crisis wording until hotlines are provided', () => {
    expect(CRISIS_NOTICE).toContain('当地急救电话');
  });
});

describe('client-recent-summary', () => {
  it('describes the client without any identifying fields', () => {
    const message = clientRecentSummary.buildUserMessage({
      client: SNAPSHOTS.singleAbnormal,
      managerRequest: '帮我写个近况小结',
    });
    expect(message).toContain('年龄段：60-69 岁；性别：男');
    expect(message).toContain('收缩压（mmHg）：2026-09-15 146');
    expect(message).toContain('血尿酸：380 umol/L，参考范围 150–420');
    expect(message).toContain('危急指标');
    expect(message).toContain('无。');
    expect(message).toContain('帮我写个近况小结');
  });

  it('says plainly when data is missing', () => {
    const message = clientRecentSummary.buildUserMessage({
      client: SNAPSHOTS.missingData,
      managerRequest: '小结',
    });
    expect(message).toContain('没有体检报告。');
  });

  it('lists critical flags and the return reason', () => {
    const message = clientRecentSummary.buildUserMessage({
      client: SNAPSHOTS.criticalHighBp,
      managerRequest: '小结',
      returnReason: '语气再温和一点',
    });
    expect(message).toContain('收缩压 185 mmHg（2026-09-24，日常监测），阈值 ≥ 180，需尽快就医');
    expect(message).toContain('语气再温和一点');
  });

  it('has a schema that both vendors accept in strict mode', () => {
    const schema = z.toJSONSchema(clientRecentSummary.outputSchema, { io: 'output' });
    // OpenAI strict 模式：每个对象都关闭额外字段，且所有字段都必填
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(
          Object.keys(n.properties as object).sort(),
        );
      }
      Object.values(n).forEach(visit);
    };
    visit(schema);
  });

  it('renders the professional part and passes the client text through', () => {
    const output: RecentSummaryOutput = {
      professional: {
        overview: '血压近两周偏高。',
        findings: [
          {
            indicator: '收缩压',
            observation: '9 月 24 日 155 mmHg',
            source: 'monitoring',
            date: '2026-09-24',
          },
        ],
        suggestions: ['一周内复测'],
        referralAdvice: null,
        missingData: [],
      },
      clientFacing: '您好，最近血压有些波动。',
      crisisSignal: false,
    };
    const artifact = clientRecentSummary.render(output);
    expect(artifact.professional).toContain('## 近况概述');
    expect(artifact.professional).toContain(
      '**收缩压**：9 月 24 日 155 mmHg（日常监测，2026-09-24）',
    );
    expect(artifact.professional).not.toContain('就医或转介建议');
    expect(artifact.clientFacing).toBe('您好，最近血压有些波动。');
  });

  it('puts the fixed crisis notice first when the model flags a crisis', () => {
    const artifact = clientRecentSummary.render({
      professional: {
        overview: '近况平稳。',
        findings: [],
        suggestions: [],
        referralAdvice: null,
        missingData: [],
      },
      clientFacing: '您好。',
      crisisSignal: true,
    });
    expect(artifact.professional.startsWith(`## 心理危机提示\n${CRISIS_NOTICE}`)).toBe(true);
  });
});

describe('ask mode helpers', () => {
  it('suggests the summary skill for natural-language requests only', () => {
    expect(suggestSkill('帮我给张阿姨写个近况小结')).toBe('client-recent-summary');
    expect(suggestSkill('血压 150 要紧吗')).toBeUndefined();
  });

  it('builds a fixed critical notice for the manager', () => {
    expect(
      criticalNotice([
        {
          metric: 'sbp',
          value: 185,
          unit: 'mmHg',
          observedOn: '2026-10-01',
          source: 'monitoring',
          rule: { comparator: 'gte', value: 180, level: 'urgent' },
        },
      ]),
    ).toContain('收缩压 185 mmHg（2026-10-01，日常监测）：需尽快就医');
    expect(criticalNotice([])).toBe('');
  });

  it('ends the ask notice with the disclaimer wording', () => {
    expect(ASK_NOTICE).toContain(DISCLAIMER);
  });
});
