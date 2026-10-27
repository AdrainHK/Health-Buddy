import { useId, type ReactNode } from 'react';
import styles from './Thresholds.module.css';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 内容多的表单和详情（方案库条目）用宽一些的卡片 */
  wide?: boolean;
}

/** 简单的模态框：遮罩 + 卡片，Esc 关闭。 */
export function Dialog({ title, onClose, children, wide = false }: DialogProps) {
  const titleId = useId();
  return (
    <div
      className={styles.overlay}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className={wide ? `${styles.dialog} ${styles.dialogWide}` : styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className={styles.dialogTitle}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
