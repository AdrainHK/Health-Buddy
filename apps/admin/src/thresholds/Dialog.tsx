import { useId, type ReactNode } from 'react';
import styles from './Thresholds.module.css';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** 简单的模态框：遮罩 + 卡片，Esc 关闭。 */
export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();
  return (
    <div
      className={styles.overlay}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.dialogTitle}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
