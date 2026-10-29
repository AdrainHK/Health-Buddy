import type { CompanionMemory, CompanionSession } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteCompanionMemory,
  listCompanionMemories,
  listCompanionSessions,
} from '../api/companion';
import { isAbortError } from '../api/http';
import { displayDateTime } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import { caseErrorText } from './CompanionCases';
import care from './Companion.module.css';

/**
 * 伴侣视图的聊天文字和记忆（N10 按 A：服务这位客户的健管师能看完整的聊天文字和全部记忆，
 * 客户转出后新健管师也能看）。健管师可以删记忆（N11）。聊天文字保存 180 天（N19）。
 */
export function ChatSection({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<{ clientId: string; items: CompanionSession[] } | null>(
    null,
  );
  const [next, setNext] = useState<string | null>(null);
  const [memories, setMemories] = useState<{ clientId: string; items: CompanionMemory[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([
      listCompanionSessions(clientId, null, controller.signal),
      listCompanionMemories(clientId, controller.signal),
    ])
      .then(([page, items]) => {
        setSessions({ clientId, items: page.sessions });
        setNext(page.next);
        setMemories({ clientId, items });
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(t('companion.chat.loadFailed'));
      });
    return () => controller.abort();
  }, [clientId, version, t]);

  const loadMore = () => {
    if (!next) return;
    setLoading(true);
    listCompanionSessions(clientId, next)
      .then((page) => {
        setSessions((prev) =>
          prev && prev.clientId === clientId
            ? { clientId, items: [...prev.items, ...page.sessions] }
            : prev,
        );
        setNext(page.next);
      })
      .catch((err: unknown) => setError(caseErrorText(t, err)))
      .finally(() => setLoading(false));
  };

  const remove = (memoryId: string) => {
    setError(null);
    deleteCompanionMemory(clientId, memoryId)
      .then(() =>
        setMemories((prev) =>
          prev ? { ...prev, items: prev.items.filter((m) => m.id !== memoryId) } : prev,
        ),
      )
      .catch((err: unknown) => setError(caseErrorText(t, err)));
  };

  const shownSessions = sessions?.clientId === clientId ? sessions.items : null;
  const shownMemories = memories?.clientId === clientId ? memories.items : null;
  if (!shownSessions || !shownMemories) {
    return error ? (
      <div role="alert">
        <p className={styles.error}>{error}</p>
        <Button onClick={() => setVersion((v) => v + 1)}>{t('companion.retry')}</Button>
      </div>
    ) : (
      <p className={styles.muted} role="status">
        {t('companion.chat.loading')}
      </p>
    );
  }
  return (
    <>
      <p className={styles.muted}>{t('companion.chat.hint')}</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <h6 className={styles.basisTitle}>{t('companion.chat.memoriesTitle')}</h6>
      {shownMemories.length === 0 ? (
        <p className={styles.muted}>{t('companion.chat.noMemories')}</p>
      ) : (
        <ul className={care.planList}>
          {shownMemories.map((m) => (
            <li key={m.id} className={care.memoryItem}>
              <span>{m.text}</span>
              <Button variant="ghost" onClick={() => remove(m.id)}>
                {t('companion.chat.forget')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h6 className={styles.basisTitle}>{t('companion.chat.sessionsTitle')}</h6>
      {shownSessions.length === 0 ? (
        <p className={styles.muted}>{t('companion.chat.noSessions')}</p>
      ) : (
        <ul className={care.planList}>
          {shownSessions.map((s) => (
            <li key={s.id} className={care.caseItem}>
              <details>
                <summary>
                  {displayDateTime(s.startedAt)}
                  {s.summary && ` · ${s.summary}`}
                </summary>
                <ol className={care.transcript}>
                  {s.messages.map((m) => (
                    <li key={m.id} data-role={m.role}>
                      <span className={care.speaker}>
                        {m.role === 'client'
                          ? t('companion.chat.client')
                          : t('companion.chat.companion')}
                      </span>
                      {m.content}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <div className={styles.cardActions}>
          <Button variant="ghost" disabled={loading} onClick={loadMore}>
            {t('companion.chat.more')}
          </Button>
        </div>
      )}
    </>
  );
}
