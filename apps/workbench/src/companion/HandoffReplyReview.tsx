import { COMPANION_REPLY_MAX, type HandoffReplyStructured } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendHandoffReply } from '../api/artifacts';
import { ApiError } from '../api/http';
import styles from '../care/Care.module.css';
import type { StructuredProblem } from '../care/StructuredEditors';
import twin from '../twin/Twin.module.css';
import { displayDateTime } from '../twin/errors';
import care from './Companion.module.css';
import type { ArtifactDetailResponse } from '@health-buddy/shared';

/** 回复为空或超过 150 字时不能保存 */
export function handoffReplyProblems(value: HandoffReplyStructured): StructuredProblem[] {
  const n = [...value.reply.trim()].length;
  if (n === 0) return ['replyEmpty'];
  return n > COMPANION_REPLY_MAX ? ['replyTooLong'] : [];
}

/** /转交回复 草稿：改念给客户听的回复原文（M6 规格 2.9）。福宝会原样念出，不改写 */
export function HandoffReplyEditor({
  value,
  disabled,
  onChange,
}: {
  value: HandoffReplyStructured;
  disabled: boolean;
  onChange: (next: HandoffReplyStructured) => void;
}) {
  const { t } = useTranslation();
  const count = [...value.reply].length;
  return (
    <div className={styles.editor} data-testid="handoff-reply-editor">
      <p className={twin.muted}>{t('companion.draft.hint')}</p>
      <label className={twin.label}>
        {t('companion.draft.reply', { max: COMPANION_REPLY_MAX })}
        <textarea
          className={twin.input}
          rows={4}
          value={value.reply}
          disabled={disabled}
          aria-invalid={count === 0 || count > COMPANION_REPLY_MAX ? true : undefined}
          onChange={(e) => onChange({ ...value, reply: e.target.value })}
        />
      </label>
      <p className={twin.muted}>
        {t('companion.draft.count', { count, max: COMPANION_REPLY_MAX })}
      </p>
    </div>
  );
}

/**
 * 审核通过后“发送给福宝”（红线 3：只有已审核的才能发，校验在后端）。发送前再确认一次；
 * 有药名、判断等提醒时先列出来，健管师确认后再发。发送过的显示时间
 */
export function HandoffReplySend({
  detail,
  disabled,
  onSent,
}: {
  detail: ArtifactDetailResponse;
  disabled: boolean;
  onSent: (next: ArtifactDetailResponse) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = detail.events.find((e) => e.action === 'companion_reply_sent');
  if (sent) {
    return (
      <span className={twin.muted}>
        {t('companion.draft.sentAt', { time: displayDateTime(sent.createdAt) })}
      </span>
    );
  }
  const send = (acknowledge: boolean) => {
    setBusy(true);
    setError(null);
    sendHandoffReply(detail.artifact.id, acknowledge)
      .then((next) => {
        setConfirming(false);
        setWarnings(null);
        onSent(next);
      })
      .catch((err: unknown) => {
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          err.reasons[0] === 'needs_confirmation'
        ) {
          setWarnings(err.reasons.slice(1));
          return;
        }
        setError(
          err instanceof ApiError && err.status === 409 && err.reasons.includes('handoff_closed')
            ? t('companion.draft.errors.closed')
            : err instanceof ApiError && err.status === 404
              ? t('companion.draft.errors.notFound')
              : t('companion.draft.errors.failed'),
        );
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className={care.draftSend}>
      {warnings && (
        <div className={care.warningBox} role="alert">
          <p>{t('companion.cases.warningsTitle')}</p>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{t(`companion.cases.warnings.${w}`, { defaultValue: w })}</li>
            ))}
          </ul>
          <p>{t('companion.cases.warningsHint')}</p>
        </div>
      )}
      {error && (
        <p className={twin.error} role="alert">
          {error}
        </p>
      )}
      {warnings ? (
        <Button variant="primary" disabled={disabled || busy} onClick={() => send(true)}>
          {t('companion.cases.sendAnyway')}
        </Button>
      ) : confirming ? (
        <>
          <span className={twin.muted}>{t('companion.draft.confirm')}</span>
          <Button variant="primary" disabled={disabled || busy} onClick={() => send(false)}>
            {t('companion.draft.confirmYes')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            {t('companion.cancel')}
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={disabled || busy} onClick={() => setConfirming(true)}>
          {t('companion.draft.send')}
        </Button>
      )}
    </div>
  );
}
