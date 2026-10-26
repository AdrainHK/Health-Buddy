import type { ArtifactSummary } from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDynamicT, useSkillName } from '../i18n/dynamic';
import { displayDate } from '../record/errors';

export type ArtifactTitleInput = Pick<ArtifactSummary, 'skillId' | 'version' | 'createdAt'>;

/**
 * 产物和版本的名称（产品负责人反馈的命名规则）：客户称呼 + 几个字的内容概括 + 日期 + 第几版，
 * 如“王测试 近况小结 2026-10-19 第2版”“王测试 体检报告解读 2026-10-19 第1版”。
 * 日期是这一版的生成日期，按健管师本地时区。产物列表、版本列表、预览标题和客户档案都用这一个规则。
 *
 * 只在健管师界面上用。称呼是工作台里已经显示的客户称呼，不写进日志、错误信息和埋点；
 * 没传称呼（任务还没关联客户）时省略。
 */
export function useArtifactTitle(): (
  artifact: ArtifactTitleInput,
  clientName?: string | null,
) => string {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const skillName = useSkillName();
  return useCallback(
    (a: ArtifactTitleInput, clientName?: string | null) => {
      const name = clientName?.trim();
      // 按技能取概括（键在编译期未知）；没有专门概括的技能用技能名
      const summary = dt(`results.artifacts.title.summary.${a.skillId}`, skillName(a.skillId));
      return t('results.artifacts.title.pattern', {
        client: name ? t('results.artifacts.title.client', { name }) : '',
        summary,
        date: displayDate(a.createdAt),
        version: a.version,
      });
    },
    [t, dt, skillName],
  );
}

/**
 * 依据的报告（日期和第一个原件的文件名），如“依据报告 2026-09-12 · 报告.pdf”。名称里不再放依据，
 * 改在悬停提示里显示，同一任务里依据不同报告的产物仍然分得清。没有依据报告时返回 undefined。
 */
export function useArtifactSource(): (
  artifact: Pick<ArtifactSummary, 'sourceReportDate' | 'sourceFileName'>,
) => string | undefined {
  const { t } = useTranslation();
  return useCallback(
    (a: Pick<ArtifactSummary, 'sourceReportDate' | 'sourceFileName'>) => {
      const source = [a.sourceReportDate, a.sourceFileName]
        .filter(Boolean)
        .join(t('results.artifacts.title.sourceSeparator'));
      return source ? t('results.artifacts.title.source', { source }) : undefined;
    },
    [t],
  );
}
