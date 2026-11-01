import { z } from 'zod';

/**
 * 科普内容工厂（M8 规格 2.1、3.1、3.2）。科普不针对任何个人、不读客户数据；
 * 产物沿用 M1 的 artifacts 表和审核流程，client_id 为空。
 */

export const POPSCI_KINDS = ['popsci_article', 'lecture_deck', 'community_post'] as const;
export const popsciKindSchema = z.enum(POPSCI_KINDS);
export type PopsciKind = z.infer<typeof popsciKindSchema>;

export function isPopsciKind(kind: string): kind is PopsciKind {
  return (POPSCI_KINDS as readonly string[]).includes(kind);
}

/** 三个科普技能和产物类型的对应 */
export const POPSCI_SKILL_KINDS = {
  'popsci-article': 'popsci_article',
  'lecture-deck': 'lecture_deck',
  'community-post': 'community_post',
} as const satisfies Record<string, PopsciKind>;

/** 所有科普产物末尾由后端固定加上的两句（红线 5，规格 2.1 第 8 条），不由模型生成 */
export const POPSCI_FOOTER = ['仅供参考，非医疗诊断', '如有不适请及时就医'] as const;
/** 导出时的署名尾注（Q1）：健管师姓名、协会名称之后 */
export const POPSCI_GENERATED_BY = '由 Health Buddy 辅助生成';

const text = (max: number) => z.string().trim().min(1).max(max);

export const popsciArticleSchema = z.object({
  kind: z.literal('popsci_article'),
  title: text(60),
  sections: z
    .array(z.object({ heading: text(40), body: text(2000) }))
    .min(1)
    .max(12),
  summary: z.string().trim().max(300),
});

export const lectureDeckSchema = z.object({
  kind: z.literal('lecture_deck'),
  title: text(60),
  slides: z
    .array(
      z.object({
        title: text(40),
        bullets: z.array(text(80)).min(1).max(6),
        notes: z.string().trim().max(600),
      }),
    )
    .min(1)
    .max(30),
});

export const communityPostSchema = z.object({
  kind: z.literal('community_post'),
  paragraphs: z.array(text(600)).min(1).max(8),
  interaction: z.string().trim().max(200),
});

/** 科普产物的结构化内容（artifacts.structured） */
export const popsciContentSchema = z.discriminatedUnion('kind', [
  popsciArticleSchema,
  lectureDeckSchema,
  communityPostSchema,
]);
export type PopsciContent = z.infer<typeof popsciContentSchema>;

/** 生成要求表单（规格 2.1 第 3 条）；第 2b 步接技能时使用 */
export const POPSCI_AUDIENCES = ['adults', 'elderly', 'chronic', 'family'] as const;
export const POPSCI_TONES = ['plain', 'warm', 'professional'] as const;
export const POPSCI_LENGTHS = {
  popsci_article: [800, 1500, 2500],
  lecture_deck: [10, 15, 20],
  community_post: [200, 400],
} as const satisfies Record<PopsciKind, readonly number[]>;

export const popsciRequestSchema = z.object({
  topic: text(60),
  audiences: z.array(z.enum(POPSCI_AUDIENCES)).min(1).max(POPSCI_AUDIENCES.length),
  length: z.number().int().positive(),
  tone: z.enum(POPSCI_TONES),
  mustInclude: z.array(text(60)).max(5).default([]),
  avoid: z.array(text(60)).max(5).default([]),
});
export type PopsciRequest = z.infer<typeof popsciRequestSchema>;

/** 命中项在内容里的位置：字段 + 第几节、第几页或第几段（从 0 开始）+ 第几条要点 */
export const POPSCI_FIELDS = [
  'title',
  'heading',
  'body',
  'summary',
  'slideTitle',
  'bullet',
  'notes',
  'paragraph',
  'interaction',
] as const;
export const popsciLocationSchema = z.object({
  field: z.enum(POPSCI_FIELDS),
  index: z.number().int().nonnegative().nullable(),
  item: z.number().int().nonnegative().nullable(),
});
export type PopsciLocation = z.infer<typeof popsciLocationSchema>;

export const contentCheckCategorySchema = z.enum(['forbid', 'review']);
export type ContentCheckCategory = z.infer<typeof contentCheckCategorySchema>;

export const contentCheckHitSchema = z.object({
  /** 规则组 id；内置检查以 builtin_ 开头 */
  ruleId: z.string(),
  category: contentCheckCategorySchema,
  /** 命中的词或片段（规范化后） */
  term: z.string(),
  reason: z.string(),
  location: popsciLocationSchema,
});
export type ContentCheckHit = z.infer<typeof contentCheckHitSchema>;

/** 一份科普产物的合规检查结果（content_compliance_results） */
export const contentCheckResultSchema = z.object({
  rulesVersion: z.number().int().positive(),
  hits: z.array(contentCheckHitSchema),
  checkedAt: z.iso.datetime(),
  /** “需要人工判断”的项目由谁、何时勾选了“已核对”；内容一改就清空 */
  ackedBy: z.uuid().nullable(),
  ackedAt: z.iso.datetime().nullable(),
});
export type ContentCheckResult = z.infer<typeof contentCheckResultSchema>;

/** 勾选“已核对”：带上预览时的内容指纹，保证核对的是看到的这一版 */
export const complianceAckRequestSchema = z.object({ contentHash: z.string().min(1).max(128) });
export type ComplianceAckRequest = z.infer<typeof complianceAckRequestSchema>;
