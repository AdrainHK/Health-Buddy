import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 翻译服务端给出的 i18n 键（如步骤的 labelKey、技能名 skills.<id>.name）。
 * 这些键在编译期未知，缺失时用 fallback，不把原始键显示给用户。
 */
export function useDynamicT(): (key: string, fallback: string) => string {
  const { t, i18n } = useTranslation();
  return useCallback(
    (key: string, fallback: string) =>
      i18n.exists(key) ? (t as unknown as (k: string) => string)(key) : fallback,
    [t, i18n],
  );
}

/** 技能显示名：skills.<id>.name，缺失时显示 id */
export function useSkillName(): (skillId: string) => string {
  const dt = useDynamicT();
  return useCallback((skillId: string) => dt(`skills.${skillId}.name`, skillId), [dt]);
}
