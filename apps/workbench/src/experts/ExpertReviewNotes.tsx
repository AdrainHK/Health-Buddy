import type { ExpertConsultation } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useTranslation } from 'react-i18next';
import styles from './Experts.module.css';

/**
 * 专业版里有没有写就医或转介建议：找到这一节的标题，并且标题下面有内容。
 * heading 是技能生成专业版时用的小节标题（如“就医或转介建议”）。
 */
export function hasReferralSection(professional: string, heading: string): boolean {
  const lines = professional.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => {
    const m = /^#{1,6}\s+(.*)$/.exec(line.trim());
    return m !== null && (m[1] ?? '').trim() === heading;
  });
  if (start === -1) return false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line.trim())) break;
    if (line.trim()) return true;
  }
  return false;
}

/** 有没有专家建议转介（汇总里合并的转介，或任何一位专家的意见） */
export function expertsSuggestReferral(c: ExpertConsultation): boolean {
  return (
    (c.synthesis?.referrals.length ?? 0) > 0 ||
    c.calls.some((call) => call.opinion?.inScope && call.opinion.referral.needed)
  );
}

export interface ExpertReviewNotesProps {
  /** 产物上结构化的危机、急症信号（M3 合规审查）：审核栏最前面醒目显示，不能关掉 */
  crisisSignal: boolean;
  emergencySignal: boolean;
  /** 产物用到的专家调用；没有调用专家时为空 */
  consultation: ExpertConsultation | null;
  /** 专业版内容，用来判断有没有写转介建议 */
  professional: string;
  onOpenExperts?: (consultationId: string) => void;
}

/**
 * 审核栏里和专家有关的提示（M3 规格 2.7、Q20）：
 * - 危机和急症信号放在最前面，只给健管师看，不进通俗版；
 * - “本次调用了 N 位专家，有 M 处分歧”，有分歧只提示、不拦截确认；
 * - 专家建议转介、专业版却没写转介建议时醒目提示，同样不拦截。
 */
export function ExpertReviewNotes({
  crisisSignal,
  emergencySignal,
  consultation,
  professional,
  onOpenExperts,
}: ExpertReviewNotesProps) {
  const { t } = useTranslation();
  const disagreements = consultation?.synthesis?.disagreements.length ?? 0;
  const missingReferral =
    consultation !== null &&
    expertsSuggestReferral(consultation) &&
    !hasReferralSection(professional, t('results.artifacts.experts.referralHeading'));
  if (!crisisSignal && !emergencySignal && !consultation) return null;
  return (
    <div className={styles.block} data-testid="expert-review-notes">
      {crisisSignal && (
        <p className={styles.alert} role="alert">
          <strong>{t('results.artifacts.signals.crisis')}</strong>
          {t('results.artifacts.signals.crisisText')}
        </p>
      )}
      {emergencySignal && (
        <p className={styles.alert} role="alert">
          <strong>{t('results.artifacts.signals.emergency')}</strong>
          {t('results.artifacts.signals.emergencyText')}
        </p>
      )}
      {(crisisSignal || emergencySignal) && (
        <p className={styles.note}>{t('results.artifacts.signals.note')}</p>
      )}
      {consultation && (
        <div className={styles.feedback}>
          <span>
            {t('results.artifacts.experts.summary', {
              count: consultation.calls.length,
              disagreements,
            })}
          </span>
          {onOpenExperts && (
            <Button variant="ghost" onClick={() => onOpenExperts(consultation.id)}>
              {t('results.artifacts.experts.open')}
            </Button>
          )}
        </div>
      )}
      {disagreements > 0 && (
        <p className={styles.note}>{t('results.artifacts.experts.disagreementHint')}</p>
      )}
      {missingReferral && (
        <p className={styles.warn} role="note">
          {t('results.artifacts.experts.missingReferral')}
        </p>
      )}
    </div>
  );
}
