import { z } from 'zod';
import { CRITICAL_COMPARATORS, CRITICAL_LEVELS } from '../health/critical.js';

/** 产物状态（规格 3.6）。voided 只由系统在客户转出或删除时设置（Q11）。 */
export const artifactStatusSchema = z.enum(['draft', 'approved', 'returned', 'voided']);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const artifactContentSchema = z.object({
  /** 专业版，只给健管师看 */
  professional: z.string(),
  /** 通俗版，审核后可给客户；免责声明由后端拼接 */
  clientFacing: z.string(),
});
export type ArtifactContent = z.infer<typeof artifactContentSchema>;

/** 后端按阈值识别出的危急指标，只给健管师看，不进通俗版 */
export const criticalFlagSchema = z.object({
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  observedOn: z.iso.date(),
  source: z.enum(['monitoring', 'report']),
  /** 命中时生效的规则快照，阈值以后改了也能追溯 */
  rule: z.object({
    comparator: z.enum(CRITICAL_COMPARATORS),
    value: z.number(),
    level: z.enum(CRITICAL_LEVELS),
  }),
});
export type CriticalFlag = z.infer<typeof criticalFlagSchema>;

export const artifactSummarySchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  skillId: z.string(),
  version: z.number().int().positive(),
  status: artifactStatusSchema,
  hasCriticalFlags: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactSchema = artifactSummarySchema.extend({
  clientId: z.uuid().nullable(),
  parentId: z.uuid().nullable(),
  content: artifactContentSchema,
  criticalFlags: z.array(criticalFlagSchema),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const ARTIFACT_ACTIONS = [
  'created',
  'edited',
  'approved',
  'returned',
  'voided',
  'copied',
  'exported',
] as const;

/** 修改、审核、复制和导出记录。只记谁在什么时候做了什么，不记内容。 */
export const artifactEventSchema = z.object({
  id: z.uuid(),
  artifactId: z.uuid(),
  actorId: z.uuid().nullable(),
  action: z.enum(ARTIFACT_ACTIONS),
  reason: z.string().nullable(),
  format: z.enum(['png', 'pdf']).nullable(),
  createdAt: z.iso.datetime(),
});
export type ArtifactEvent = z.infer<typeof artifactEventSchema>;

export const artifactDetailResponseSchema = z.object({
  artifact: artifactSchema,
  /** 同一产物链上的所有版本，按版本号升序 */
  versions: z.array(artifactSummarySchema),
  events: z.array(artifactEventSchema),
});
export type ArtifactDetailResponse = z.infer<typeof artifactDetailResponseSchema>;

export const ARTIFACT_TEXT_MAX = 20000;
export const RETURN_REASON_MAX = 500;

export const updateArtifactRequestSchema = z.object({
  version: z.number().int().positive(),
  content: z.object({
    professional: z.string().max(ARTIFACT_TEXT_MAX),
    clientFacing: z.string().max(ARTIFACT_TEXT_MAX),
  }),
});
export type UpdateArtifactRequest = z.infer<typeof updateArtifactRequestSchema>;

export const approveArtifactRequestSchema = z.object({
  /** 必须等于最新草稿的版本号 */
  version: z.number().int().positive(),
  /** 有危急指标时必须为 true */
  acknowledgedCritical: z.boolean().default(false),
});
export type ApproveArtifactRequest = z.input<typeof approveArtifactRequestSchema>;

export const returnArtifactRequestSchema = z.object({
  reason: z.string().trim().min(1).max(RETURN_REASON_MAX),
});
export type ReturnArtifactRequest = z.infer<typeof returnArtifactRequestSchema>;

export const exportFormatSchema = z.enum(['png', 'pdf']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const clientTextResponseSchema = z.object({ text: z.string() });
export type ClientTextResponse = z.infer<typeof clientTextResponseSchema>;

/** 确认被拒绝时的原因，前端据此标出问题位置 */
export const approveRejectionSchema = z.object({
  error: z.literal('conflict'),
  reasons: z.array(
    z.enum([
      'not_latest_draft',
      'banned_terms',
      'missing_disclaimer',
      'critical_not_acknowledged',
      'read_only',
    ]),
  ),
  bannedTerms: z.array(z.object({ term: z.string(), index: z.number().int() })).optional(),
});
export type ApproveRejection = z.infer<typeof approveRejectionSchema>;
