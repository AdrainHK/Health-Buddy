import { z } from 'zod';

/** 已支持的界面语言。繁体中文（zh-TW）以后补充时加在这里。 */
export const SUPPORTED_LOCALES = ['zh-CN'] as const;

export const localeSchema = z.enum(SUPPORTED_LOCALES);

export type Locale = z.infer<typeof localeSchema>;

export const DEFAULT_LOCALE: Locale = 'zh-CN';
