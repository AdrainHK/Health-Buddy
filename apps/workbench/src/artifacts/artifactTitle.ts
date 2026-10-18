import type { ArtifactSummary } from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSkillName } from '../i18n/dynamic';

export type ArtifactTitleInput = Pick<
  ArtifactSummary,
  'skillId' | 'version' | 'sourceReportDate' | 'sourceFileName'
>;

/**
 * 产物标题（验收反馈：“版本1”“版本2”难以识别）：
 * “王测试 体检报告（2026-09-12 · 报告.pdf）解读 · 第 1 版”“王测试 近况小结 · 第 1 版”。
 *
 * 只在健管师界面上用。称呼是工作台里已经显示的客户称呼，不写进日志、错误信息和埋点；
 * 没传称呼（如客户档案里，或任务还没关联客户）时省略。
 */
export function useArtifactTitle(): (
  artifact: ArtifactTitleInput,
  clientName?: string | null,
) => string {
  const { t, i18n } = useTranslation();
  const skillName = useSkillName();
  return useCallback(
    (a: ArtifactTitleInput, clientName?: string | null) => {
      const name = clientName?.trim();
      const client = name ? t('results.artifacts.title.client', { name }) : '';
      const source = [a.sourceReportDate, a.sourceFileName]
        .filter(Boolean)
        .join(t('results.artifacts.title.sourceSeparator'));
      // 按技能选模板（键在编译期未知）；没有专门模板的技能用技能名
      const key = `results.artifacts.title.${a.skillId}${source ? '' : 'NoSource'}`;
      if (!i18n.exists(key)) {
        return t('results.artifacts.title.default', {
          client,
          name: skillName(a.skillId),
          version: a.version,
        });
      }
      const dynamicT = t as unknown as (k: string, options: Record<string, unknown>) => string;
      return dynamicT(key, { client, source, version: a.version });
    },
    [t, i18n, skillName],
  );
}
