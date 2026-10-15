/**
 * 指标目录：体检指标和日常监测项的编码、单位和成人参考范围。
 * 名称和解释走各端的 i18n（键为 indicators.<code>），这里只放数据。
 * 参考范围用于合成数据和红黄绿状态的初步判断，具体阈值在 M2、M4 由规格确认。
 */
export interface IndicatorDef {
  code: string;
  unit: string;
  /** 参考范围，缺一端表示只有单侧界限 */
  refLow?: number;
  refHigh?: number;
}

export const REPORT_INDICATORS = [
  { code: 'height', unit: 'cm' },
  { code: 'weight', unit: 'kg' },
  { code: 'bmi', unit: 'kg/m2', refLow: 18.5, refHigh: 24 },
  { code: 'waist', unit: 'cm' },
  { code: 'sbp', unit: 'mmHg', refHigh: 140 },
  { code: 'dbp', unit: 'mmHg', refHigh: 90 },
  { code: 'fpg', unit: 'mmol/L', refLow: 3.9, refHigh: 6.1 },
  { code: 'hba1c', unit: '%', refLow: 4, refHigh: 6 },
  { code: 'tc', unit: 'mmol/L', refHigh: 5.2 },
  { code: 'tg', unit: 'mmol/L', refHigh: 1.7 },
  { code: 'ldl_c', unit: 'mmol/L', refHigh: 3.4 },
  { code: 'hdl_c', unit: 'mmol/L', refLow: 1.0 },
  { code: 'alt', unit: 'U/L', refHigh: 40 },
  { code: 'ast', unit: 'U/L', refHigh: 40 },
  { code: 'creatinine', unit: 'umol/L', refLow: 44, refHigh: 133 },
  { code: 'uric_acid', unit: 'umol/L', refLow: 150, refHigh: 420 },
] as const satisfies readonly IndicatorDef[];

export const MONITORING_METRICS = [
  { code: 'sbp', unit: 'mmHg', refHigh: 140 },
  { code: 'dbp', unit: 'mmHg', refHigh: 90 },
  { code: 'heart_rate', unit: 'bpm', refLow: 60, refHigh: 100 },
  { code: 'weight', unit: 'kg' },
  { code: 'fpg', unit: 'mmol/L', refLow: 3.9, refHigh: 6.1 },
  { code: 'steps', unit: 'steps' },
  { code: 'sleep_hours', unit: 'h' },
] as const satisfies readonly IndicatorDef[];

export type ReportIndicatorCode = (typeof REPORT_INDICATORS)[number]['code'];
export type MonitoringMetricCode = (typeof MONITORING_METRICS)[number]['code'];
