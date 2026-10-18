import type { ExpertSummary } from '@health-buddy/shared';
import { createContext, useCallback, useContext } from 'react';
import { useDynamicT } from '../i18n/dynamic';

/**
 * 当前账号可用的专家（GET /api/experts），工作台里各处共用：@ 列表、执行步骤、专家标签、审核栏。
 * 专家预览没开时是空列表，所有专家入口都不显示。
 */
export const ExpertsContext = createContext<readonly ExpertSummary[]>([]);

export function useExperts(): readonly ExpertSummary[] {
  return useContext(ExpertsContext);
}

/**
 * 专家显示名。优先用接口给的名称；已被平台暂停的专家不在列表里，但历史意见仍要能看（规格 2.2），
 * 这时用词条里首批专家的名称，再找不到就显示“AI 专家”，不把英文 id 显示给健管师。
 */
export function useExpertName(): (id: string) => string {
  const experts = useExperts();
  const dt = useDynamicT();
  return useCallback(
    (id: string) =>
      experts.find((e) => e.id === id)?.name ??
      dt(`experts.names.${id}`, dt('experts.unknownName', '')),
    [experts, dt],
  );
}

/** 一组专家的名称，用顿号连起来（如“内分泌与代谢专家、营养专家”） */
export function useExpertNames(): (ids: readonly string[]) => string {
  const name = useExpertName();
  const dt = useDynamicT();
  return useCallback(
    (ids: readonly string[]) => ids.map(name).join(dt('experts.separator', ', ')),
    [name, dt],
  );
}
