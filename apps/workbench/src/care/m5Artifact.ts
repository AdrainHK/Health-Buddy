import {
  POPSCI_SKILL_KINDS,
  carePlanStructuredSchema,
  popsciContentSchema,
  visitRecordStructuredSchema,
  visitScheduleStructuredSchema,
  type Artifact,
  type CarePlanStructured,
  type HandoffReplyStructured,
  type M5ArtifactKind,
  type PopsciContent,
  type VisitRecordStructured,
  type VisitScheduleStructured,
} from '@health-buddy/shared';

/** M5 四个技能的 id 和产物 kind（规格 5.1），加 M6 的 /转交回复（回复原文在结构化内容里） */
const SKILL_KINDS: Readonly<Record<string, M5ArtifactKind | 'handoff_reply'>> = {
  'care-plan': 'care_plan',
  'visit-schedule': 'visit_schedule',
  'visit-script': 'visit_script',
  'visit-record': 'visit_record',
  'handoff-reply': 'handoff_reply',
};

export function m5Kind(
  artifact: Pick<Artifact, 'skillId'>,
): M5ArtifactKind | 'handoff_reply' | null {
  return SKILL_KINDS[artifact.skillId] ?? null;
}

/** 按 kind 解析的结构化内容；解析不了（不应发生）时为 null，界面不显示编辑器 */
export type M5Structured =
  | { kind: 'care_plan'; value: CarePlanStructured }
  | { kind: 'visit_schedule'; value: VisitScheduleStructured }
  | { kind: 'visit_record'; value: VisitRecordStructured }
  | { kind: 'handoff_reply'; value: HandoffReplyStructured }
  /** M8 科普：文章、PPT、社群稿；编辑中可以暂时不合规（空字段、超长），保存前前端提示 */
  | { kind: 'popsci'; value: PopsciContent };

export function parseM5Structured(
  artifact: Pick<Artifact, 'skillId' | 'structured'>,
): M5Structured | null {
  if (artifact.skillId in POPSCI_SKILL_KINDS) {
    const p = popsciContentSchema.safeParse(artifact.structured);
    return p.success ? { kind: 'popsci', value: p.data } : null;
  }
  const kind = m5Kind(artifact);
  if (kind === 'care_plan') {
    const p = carePlanStructuredSchema.safeParse(artifact.structured);
    return p.success ? { kind, value: p.data } : null;
  }
  if (kind === 'visit_schedule') {
    const p = visitScheduleStructuredSchema.safeParse(artifact.structured);
    return p.success ? { kind, value: p.data } : null;
  }
  if (kind === 'visit_record') {
    const p = visitRecordStructuredSchema.safeParse(artifact.structured);
    return p.success ? { kind, value: p.data } : null;
  }
  if (kind === 'handoff_reply') {
    // 编辑中的回复可以暂时为空或超长（界面提示），这里只取形状
    const v = artifact.structured as Partial<HandoffReplyStructured> | null;
    return typeof v?.handoffId === 'string' && typeof v.reply === 'string'
      ? { kind, value: { handoffId: v.handoffId, reply: v.reply } }
      : null;
  }
  return null;
}

/** 科普内容能不能保存：字段为空、超长时不能（后端同一套 schema 再校验） */
export function popsciProblems(value: PopsciContent): 'popsciInvalid'[] {
  return popsciContentSchema.safeParse(value).success ? [] : ['popsciInvalid'];
}

/** 两份结构化内容是否相同（判断有没有未保存的修改） */
export function sameStructured(a: M5Structured | null, b: M5Structured | null): boolean {
  return JSON.stringify(a?.value ?? null) === JSON.stringify(b?.value ?? null);
}
