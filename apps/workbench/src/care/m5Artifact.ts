import {
  carePlanStructuredSchema,
  visitRecordStructuredSchema,
  visitScheduleStructuredSchema,
  type Artifact,
  type CarePlanStructured,
  type M5ArtifactKind,
  type VisitRecordStructured,
  type VisitScheduleStructured,
} from '@health-buddy/shared';

/** M5 四个技能的 id 和产物 kind（规格 5.1） */
const SKILL_KINDS: Readonly<Record<string, M5ArtifactKind>> = {
  'care-plan': 'care_plan',
  'visit-schedule': 'visit_schedule',
  'visit-script': 'visit_script',
  'visit-record': 'visit_record',
};

export function m5Kind(artifact: Pick<Artifact, 'skillId'>): M5ArtifactKind | null {
  return SKILL_KINDS[artifact.skillId] ?? null;
}

/** 按 kind 解析的结构化内容；解析不了（不应发生）时为 null，界面不显示编辑器 */
export type M5Structured =
  | { kind: 'care_plan'; value: CarePlanStructured }
  | { kind: 'visit_schedule'; value: VisitScheduleStructured }
  | { kind: 'visit_record'; value: VisitRecordStructured };

export function parseM5Structured(
  artifact: Pick<Artifact, 'skillId' | 'structured'>,
): M5Structured | null {
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
  return null;
}

/** 两份结构化内容是否相同（判断有没有未保存的修改） */
export function sameStructured(a: M5Structured | null, b: M5Structured | null): boolean {
  return JSON.stringify(a?.value ?? null) === JSON.stringify(b?.value ?? null);
}
