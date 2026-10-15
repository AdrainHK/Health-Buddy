import type { IndicatorCode } from '@health-buddy/shared';

/**
 * 提示词里用的中文指标名。界面上的指标名走各端 i18n，这里只服务于模型输入，
 * 避免模型看到 fpg、ldl_c 这样的编码后自己猜含义。
 */
export const INDICATOR_NAMES_ZH: Record<IndicatorCode, string> = {
  height: '身高',
  weight: '体重',
  bmi: '体重指数（BMI）',
  waist: '腰围',
  sbp: '收缩压',
  dbp: '舒张压',
  fpg: '空腹血糖',
  hba1c: '糖化血红蛋白',
  tc: '总胆固醇',
  tg: '甘油三酯',
  ldl_c: '低密度脂蛋白胆固醇',
  hdl_c: '高密度脂蛋白胆固醇',
  alt: '谷丙转氨酶',
  ast: '谷草转氨酶',
  creatinine: '肌酐',
  uric_acid: '血尿酸',
  heart_rate: '心率',
  steps: '步数',
  sleep_hours: '睡眠时长',
};

export function indicatorName(code: string): string {
  return (INDICATOR_NAMES_ZH as Record<string, string>)[code] ?? code;
}
