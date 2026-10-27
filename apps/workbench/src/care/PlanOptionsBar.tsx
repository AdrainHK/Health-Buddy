import { CARE_PLAN_CYCLE_WEEKS, PLAN_SECTIONS, type PlanOptions } from '@health-buddy/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  sections: [...PLAN_SECTIONS],
  cycleWeeks: 8,
};

/**
 * 方案选项条（M5 规格 2.2 第 2 条）：包含哪几部分（默认全选，至少一个）、方案周期（4、8、12 周）。
 * 选了 /方案生成 时显示在输入框上方。
 */
export function PlanOptionsBar({
  value,
  disabled,
  onChange,
}: {
  value: PlanOptions;
  disabled: boolean;
  onChange: (next: PlanOptions) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const toggle = (section: PlanOptions['sections'][number], on: boolean) => {
    const next = on
      ? PLAN_SECTIONS.filter((s) => s === section || value.sections.includes(s))
      : value.sections.filter((s) => s !== section);
    // 至少保留一部分
    if (next.length) onChange({ ...value, sections: next });
  };
  return (
    <div className={care.planOptions} role="group" aria-labelledby={`${id}-title`}>
      <span id={`${id}-title`} className={styles.label}>
        {t('care.planOptions.title')}
      </span>
      <div className={styles.choices}>
        {PLAN_SECTIONS.map((s) => {
          const checked = value.sections.includes(s);
          return (
            <label key={s} className={styles.choice}>
              <input
                type="checkbox"
                checked={checked}
                // 只剩一部分时不能再取消
                disabled={disabled || (checked && value.sections.length === 1)}
                onChange={(e) => toggle(s, e.target.checked)}
              />
              {t(`care.sections.${s}`)}
            </label>
          );
        })}
      </div>
      <label className={styles.label}>
        {t('care.planOptions.cycle')}
        <select
          className={styles.select}
          value={value.cycleWeeks}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...value, cycleWeeks: Number(e.target.value) as PlanOptions['cycleWeeks'] })
          }
        >
          {CARE_PLAN_CYCLE_WEEKS.map((w) => (
            <option key={w} value={w}>
              {t('care.planOptions.weeks', { count: w })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
