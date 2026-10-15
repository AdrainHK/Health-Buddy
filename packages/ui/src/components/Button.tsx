import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  block = false,
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], block && styles.block, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 只有图标的按钮必须提供可读名称，供读屏软件使用。 */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: 'small' | 'medium';
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'medium',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles.icon,
    size === 'small' && styles.small,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}
