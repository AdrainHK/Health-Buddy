import { findBannedTerms } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { AUTO_TITLE_MAX, buildTaskTitle, excerpt, type TitleTurn } from './task-title.js';

const turn = (overrides: Partial<TitleTurn> = {}): TitleTurn => ({
  mode: 'ask',
  skillId: null,
  content: '',
  twinConsult: false,
  twinRefs: [],
  expertIds: [],
  ...overrides,
});

describe('任务标题自动生成', () => {
  it('技能和多步计划：为谁做了什么', () => {
    const cases: [string, string][] = [
      ['client-recent-summary', '为王测试生成近况小结'],
      ['report-interpretation', '为王测试解读体检报告'],
      ['interview-outline', '为王测试准备面谈提纲'],
      ['twin-summary', '为王测试生成孪生小结'],
      ['new-client-assessment', '为王测试做新客户完整评估'],
      ['twin-review', '为王测试做孪生复盘'],
      ['some-new-skill', '为王测试调用技能'],
    ];
    for (const [skillId, title] of cases) {
      expect(buildTaskTitle(turn({ mode: 'craft', skillId }), '王测试')).toEqual({
        title,
        source: 'auto_skill',
      });
    }
    expect(buildTaskTitle(turn({ mode: 'plan', skillId: 'twin-review' }), null).title).toBe(
      '做孪生复盘',
    );
  });

  it('问一问、想一想、做一做：模式加问题摘要，关联了客户时带称呼', () => {
    expect(buildTaskTitle(turn({ content: '王测试的血压趋势怎么样？' }), '王测试')).toEqual({
      title: '问一问：王测试的血压趋势怎么样',
      source: 'auto_text',
    });
    expect(buildTaskTitle(turn({ content: '请帮我看看最近血压。谢谢' }), '王测试').title).toBe(
      '问一问：王测试 · 看看最近血压',
    );
    expect(buildTaskTitle(turn({ mode: 'plan', content: '下周随访怎么安排' }), null).title).toBe(
      '想一想：下周随访怎么安排',
    );
    expect(buildTaskTitle(turn({ mode: 'craft', content: '写一段运动建议' }), null).title).toBe(
      '做一做：写一段运动建议',
    );
  });

  it('直接请专家：写明专家', () => {
    const t = buildTaskTitle(
      turn({ content: '血糖偏高要关注什么', expertIds: ['endocrine-metabolism'] }),
      null,
    );
    expect(t.title).toBe('问内分泌与代谢专家：血糖偏高要关注什么');
  });

  it('请专家看看孪生项：写明客户和方面', () => {
    expect(
      buildTaskTitle(
        turn({
          content: '请专家看看',
          twinConsult: true,
          twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        }),
        '王测试',
      ).title,
    ).toBe('请专家看看王测试的心血管状态');
    expect(
      buildTaskTitle(
        turn({ twinConsult: true, twinRefs: [{ kind: 'metric', code: 'sbp' }] }),
        '王测试',
      ).title,
    ).toBe('请专家看看王测试的心血管状态');
    expect(
      buildTaskTitle(
        turn({ twinConsult: true, twinRefs: [{ kind: 'domain', code: 'unknown' }] }),
        null,
      ).title,
    ).toBe('请专家看看孪生状态');
  });

  it('过长的问题截断到侧栏放得下的长度，以省略号结尾', () => {
    const title = buildTaskTitle(turn({ content: '血压'.repeat(60) }), null).title;
    expect(Array.from(title)).toHaveLength(AUTO_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });

  it('问题摘要：取第一句，去掉 @、换行和客套话；整句都是客套话时保留原句', () => {
    expect(excerpt('@王测试 最近\n睡得好吗？还有别的')).toBe('王测试 最近');
    expect(excerpt('  你好，请帮我整理一下随访要点：')).toBe('整理一下随访要点');
    expect(excerpt('请帮我')).toBe('请帮我');
    expect(excerpt('请专家看看')).toBe('');
  });

  it('固定的标题文字不含禁用词', () => {
    const titles = [
      'client-recent-summary',
      'report-interpretation',
      'interview-outline',
      'twin-summary',
      'new-client-assessment',
      'twin-review',
    ].map((skillId) => buildTaskTitle(turn({ mode: 'craft', skillId }), '王测试').title);
    for (const title of titles) expect(findBannedTerms(title)).toEqual([]);
  });
});
