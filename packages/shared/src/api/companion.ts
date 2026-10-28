import { z } from 'zod';

/**
 * AI 健康伴侣“福宝”（M6 规格）：设备、线下告知和同意、伴侣设置、平台固定话术。
 *
 * 伴侣是放在客户家里的语音机器人（ESP32 + 麦克风 + 喇叭，没有屏幕和摄像头）。客户不登录任何系统，
 * 健管师用序列号 + 激活码把设备绑定给自己的客户（Q2、N2）。明细只给服务这位客户的健管师看；
 * 机构管理员、运营商、平台都看不到（Q28）。激活码、设备密钥只在导入和绑定的请求里出现，不进日志。
 */

/** 设备状态：库存、已绑定待激活、已开通、已暂停、客户已撤回同意（规格 6.2） */
export const COMPANION_DEVICE_STATUSES = ['stock', 'bound', 'active', 'paused', 'revoked'] as const;
export const companionDeviceStatusSchema = z.enum(COMPANION_DEVICE_STATUSES);
export type CompanionDeviceStatus = z.infer<typeof companionDeviceStatusSchema>;

/** 工作台“伴侣”视图显示的状态（规格 2.8）：没有设备时是 unbound */
export const COMPANION_STATUSES = [
  'unbound',
  'pending_activation',
  'active',
  'paused',
  'revoked',
] as const;
export const companionStatusSchema = z.enum(COMPANION_STATUSES);
export type CompanionStatus = z.infer<typeof companionStatusSchema>;

/** 语速（N17：默认比正常稍慢）和音量 */
export const COMPANION_VOICE_SPEEDS = ['slow', 'medium', 'fast'] as const;
export const companionVoiceSpeedSchema = z.enum(COMPANION_VOICE_SPEEDS);
export const COMPANION_VOLUMES = ['low', 'medium', 'high'] as const;
export const companionVolumeSchema = z.enum(COMPANION_VOLUMES);
export const COMPANION_DEFAULT_VOICE_SPEED = 'slow';
export const COMPANION_DEFAULT_VOLUME = 'medium';

/** 伴侣称呼客户的叫法（Q7，如“王阿姨”） */
export const COMPANION_NAME_FOR_CLIENT_MAX = 10;

/**
 * 序列号由硬件厂商生成，格式以厂商为准；这里只限制字符和长度。
 * 激活码印在设备背面（N2），按大写比较，录入时去掉空格和连字符。
 */
export const companionSerialNoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/);
export const companionActivationCodeSchema = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{6,32}$/));
/** 设备密钥：烧录在设备里，只在平台导入批次时出现 */
export const companionDeviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

/** 序列号只显示后 4 位（规格 2.8） */
export function serialLast4(serialNo: string): string {
  return serialNo.slice(-4);
}

// ---------- 平台：出厂批次（规格 2.10、N2） ----------

export const COMPANION_BATCH_MAX_DEVICES = 1000;

export const importDeviceBatchRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  devices: z
    .array(
      z.object({
        serialNo: companionSerialNoSchema,
        deviceSecret: companionDeviceSecretSchema,
        activationCode: companionActivationCodeSchema,
      }),
    )
    .min(1)
    .max(COMPANION_BATCH_MAX_DEVICES),
});
export type ImportDeviceBatchRequest = z.infer<typeof importDeviceBatchRequestSchema>;

/** 平台只看每批的数量和绑定数，不看设备绑给了谁 */
export const deviceBatchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  deviceCount: z.number().int(),
  boundCount: z.number().int(),
  importedAt: z.iso.datetime(),
});
export type DeviceBatch = z.infer<typeof deviceBatchSchema>;
export const deviceBatchListResponseSchema = z.object({ batches: z.array(deviceBatchSchema) });
export type DeviceBatchListResponse = z.infer<typeof deviceBatchListResponseSchema>;

// ---------- 平台：固定话术和线下告知书模板（规格 2.10、Q22、N4） ----------

/**
 * 福宝说的固定话术：不经模型生成，由平台维护，内容待产品负责人和医学、心理顾问审定。
 * notice 是线下告知书模板（可打印，不由福宝播放），版本号记进同意记录。
 */
export const COMPANION_SCRIPT_KINDS = [
  'intro',
  'daily_intro',
  'crisis',
  'emergency',
  'critical_value',
  'handoff',
  'fallback',
  'paused',
  'rate_limited',
  'asr_retry',
  'handoff_reply_intro',
  'reminder_medication',
  'reminder_measurement',
  'reminder_exercise',
  'notice',
] as const;
export const companionScriptKindSchema = z.enum(COMPANION_SCRIPT_KINDS);
export type CompanionScriptKind = z.infer<typeof companionScriptKindSchema>;

/** 念出来的话术要短；告知书模板是打印用的长文 */
export const COMPANION_SCRIPT_MAX = 300;
export const COMPANION_NOTICE_MAX = 10000;

export function companionScriptMax(kind: CompanionScriptKind): number {
  return kind === 'notice' ? COMPANION_NOTICE_MAX : COMPANION_SCRIPT_MAX;
}

export const companionScriptSchema = z.object({
  kind: companionScriptKindSchema,
  version: z.number().int(),
  text: z.string(),
  updatedAt: z.iso.datetime(),
});
export type CompanionScript = z.infer<typeof companionScriptSchema>;

/** 每种话术的当前版本；没有任何版本的种类不出现（告知书模板在法务提供正文前没有版本） */
export const companionScriptListResponseSchema = z.object({
  scripts: z.array(companionScriptSchema),
});
export type CompanionScriptListResponse = z.infer<typeof companionScriptListResponseSchema>;

/** 保存即生成新版本，旧版本保留作为修改记录；含禁用词时 400 invalid_content */
export const updateCompanionScriptRequestSchema = z.object({
  text: z.string().trim().min(1).max(COMPANION_NOTICE_MAX),
});
export type UpdateCompanionScriptRequest = z.infer<typeof updateCompanionScriptRequestSchema>;

export const companionScriptHistoryResponseSchema = z.object({
  versions: z.array(companionScriptSchema),
});
export type CompanionScriptHistoryResponse = z.infer<typeof companionScriptHistoryResponseSchema>;

// ---------- 健管师：线下告知和同意（Q4、Q5、N4） ----------

export const recordCompanionConsentRequestSchema = z.object({
  /** 线下使用的告知书模板版本，必须是平台已有的版本 */
  noticeVersion: z.number().int().min(1),
  /** 线下告知并取得同意的日期，不能晚于今天 */
  consentedOn: z.iso.date(),
  /** 必须勾选“已向客户本人线下告知并取得同意” */
  confirmed: z.literal(true),
});
export type RecordCompanionConsentRequest = z.infer<typeof recordCompanionConsentRequestSchema>;

export const revokeCompanionConsentRequestSchema = z.object({
  revokedOn: z.iso.date(),
});
export type RevokeCompanionConsentRequest = z.infer<typeof revokeCompanionConsentRequestSchema>;

export const companionConsentSchema = z.object({
  noticeVersion: z.number().int(),
  consentedOn: z.iso.date(),
  recordedAt: z.iso.datetime(),
  /** 撤回后不为空；撤回后可以重新记录同意 */
  revokedOn: z.iso.date().nullable(),
});
export type CompanionConsent = z.infer<typeof companionConsentSchema>;

// ---------- 健管师：设备和伴侣设置（规格 2.1、2.8） ----------

export const bindCompanionDeviceRequestSchema = z.object({
  serialNo: companionSerialNoSchema,
  activationCode: companionActivationCodeSchema,
});
export type BindCompanionDeviceRequest = z.infer<typeof bindCompanionDeviceRequestSchema>;

export const companionDeviceSchema = z.object({
  serialLast4: z.string(),
  status: companionDeviceStatusSchema,
  boundAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  online: z.boolean(),
  firmwareVersion: z.string().nullable(),
});
export type CompanionDevice = z.infer<typeof companionDeviceSchema>;

export const companionSettingsSchema = z.object({
  nameForClient: z.string().nullable(),
  voiceSpeed: companionVoiceSpeedSchema,
  volume: companionVolumeSchema,
});
export type CompanionSettings = z.infer<typeof companionSettingsSchema>;

export const updateCompanionSettingsRequestSchema = z
  .object({
    nameForClient: z.string().trim().min(1).max(COMPANION_NAME_FOR_CLIENT_MAX).nullable(),
    voiceSpeed: companionVoiceSpeedSchema,
    volume: companionVolumeSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export type UpdateCompanionSettingsRequest = z.infer<typeof updateCompanionSettingsRequestSchema>;

/** 设备最近 2 分钟内有心跳算在线 */
export const COMPANION_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export const companionOverviewSchema = z.object({
  status: companionStatusSchema,
  device: companionDeviceSchema.nullable(),
  consent: companionConsentSchema.nullable(),
  settings: companionSettingsSchema,
  /** 平台当前的告知书模板版本；还没有时为空，此时不能记录同意 */
  currentNoticeVersion: z.number().int().nullable(),
});
export type CompanionOverview = z.infer<typeof companionOverviewSchema>;

export function companionStatusOf(
  device: { status: CompanionDeviceStatus } | null,
): CompanionStatus {
  if (!device || device.status === 'stock') return 'unbound';
  if (device.status === 'bound') return 'pending_activation';
  return device.status;
}

/**
 * 固定话术的初始版本（规格 2.2–2.5、Q5、Q22）：**候选，待产品负责人和医学、心理顾问审定**，
 * 平台管理员可以在后台改。迁移 0024 写入第 1 版，有测试对照。
 * reminder_measurement 里的 {metric} 由后端换成测量项目的名称（血压、血糖等）。
 * 告知书模板没有初始版本：正文由法务和产品负责人提供（N4）。
 */
export const COMPANION_DEFAULT_SCRIPTS: Readonly<
  Record<Exclude<CompanionScriptKind, 'notice'>, string>
> = {
  intro:
    '您好，我是 AI 伴侣福宝，不是医生，不能替代看病。我可以陪您聊天，提醒您吃药、量血压，有问题我会转给您的健管师。',
  daily_intro: '我是 AI 伴侣福宝，不是医生。',
  crisis: '请马上联系家人，或拨打 120；也可以拨打当地的心理援助热线。',
  emergency: '请马上拨打 120 或让家人送医。',
  critical_value: '这个数值需要尽快告诉医生，我已经通知您的健管师了。',
  handoff: '这个问题需要健管师或医生来回答，我已经帮您转给您的健管师了。',
  fallback: '这个问题我回答不好，已经帮您转给健管师了。',
  paused: '伴侣已暂停，请联系您的健管师。',
  rate_limited: '今天聊得很多了，休息一下吧。',
  asr_retry: '我没听清，您能再说一遍吗？',
  handoff_reply_intro: '您的健管师回复了您之前问的问题。',
  reminder_medication: '该按医嘱吃药了，吃了吗？',
  reminder_measurement: '该记一下今天的{metric}了，您告诉我数就行。',
  reminder_exercise: '今天的运动做了吗？',
};
