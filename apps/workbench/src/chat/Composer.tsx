import { IconButton } from '@health-buddy/ui';
import {
  TASK_MODES,
  type ClientSummary,
  type SkillSummary,
  type TaskMode,
} from '@health-buddy/shared';
import { ArrowUp, AtSign, Slash, Square, X } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSkillName } from '../i18n/dynamic';
import styles from './Composer.module.css';

type TriggerKind = 'skill' | 'client';

interface Trigger {
  kind: TriggerKind;
  query: string;
  /** 触发字符（/ 或 @）在文本里的位置 */
  start: number;
  /** 光标位置，选中后把 start..end 这段删掉 */
  end: number;
}

/** 光标前是“行首或空白 + / 或 @ + 连续非空白字符”时，弹出对应的列表 */
const TRIGGER_RE = /(^|\s)([/@])([^\s/@]*)$/;

export function detectTrigger(text: string, caret: number): Trigger | null {
  const match = TRIGGER_RE.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[3] ?? '';
  return {
    kind: match[2] === '/' ? 'skill' : 'client',
    query,
    start: caret - query.length - 1,
    end: caret,
  };
}

interface Option {
  id: string;
  label: string;
  description?: string;
  select: () => void;
}

export interface ComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
  skill: SkillSummary | null;
  onSkillChange: (skill: SkillSummary | null) => void;
  client: ClientSummary | null;
  /** 选中或移除客户。是否允许引用（任务已关联别的客户时不允许）由上层判断 */
  onClientChange: (client: ClientSummary | null) => void;
  skills: SkillSummary[];
  clients: ClientSummary[];
  disabled: boolean;
  generating: boolean;
  onSubmit: () => void;
  onStop: () => void;
  /** 输入框上方的提示（技能和模式不匹配、请先 @ 客户、出错等） */
  notice?: ReactNode;
}

/** 输入框：模式切换、/ 技能和 @ 客户补全、发送和停止 */
export function Composer({
  inputRef,
  text,
  onTextChange,
  mode,
  onModeChange,
  skill,
  onSkillChange,
  client,
  onClientChange,
  skills,
  clients,
  disabled,
  generating,
  onSubmit,
  onStop,
  notice,
}: ComposerProps) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);

  const pick = (fn: () => void) => () => {
    if (!trigger) return;
    // 去掉输入的 /xxx 或 @xxx，换成上方的标签
    onTextChange(text.slice(0, trigger.start) + text.slice(trigger.end));
    setTrigger(null);
    fn();
    inputRef.current?.focus();
  };

  const query = trigger?.query.toLowerCase() ?? '';
  const options: Option[] = !trigger
    ? []
    : trigger.kind === 'skill'
      ? skills
          .filter((s) => skillName(s.id).toLowerCase().includes(query) || s.id.includes(query))
          .map((s) => ({
            id: s.id,
            label: skillName(s.id),
            select: pick(() => onSkillChange(s)),
          }))
      : clients
          .filter((c) => c.displayName.toLowerCase().includes(query))
          .map((c) => ({ id: c.id, label: c.displayName, select: pick(() => onClientChange(c)) }));
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const menuOpen = trigger !== null;

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    onTextChange(value);
    setTrigger(detectTrigger(value, e.target.selectionStart ?? value.length));
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // 输入法正在选字
    if (menuOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
      if (options.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      if (options.length && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        options[activeIndex]?.select();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form className={styles.composer} onSubmit={submit}>
      {notice && <div className={styles.notice}>{notice}</div>}

      {(skill || client) && (
        <div className={styles.chips}>
          {skill && (
            <Chip
              icon={<Slash size={12} />}
              label={skillName(skill.id)}
              removeLabel={t('chat.removeSkill', { name: skillName(skill.id) })}
              onRemove={() => onSkillChange(null)}
              disabled={disabled}
            />
          )}
          {client && (
            <Chip
              icon={<AtSign size={12} />}
              label={client.displayName}
              removeLabel={t('chat.removeClient', { name: client.displayName })}
              onRemove={() => onClientChange(null)}
              disabled={disabled}
            />
          )}
        </div>
      )}

      <div className={styles.inputWrap}>
        <textarea
          ref={inputRef}
          className={styles.input}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={() => setTrigger(null)}
          placeholder={disabled ? t('chat.readOnlyPlaceholder') : t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={
            menuOpen && options[activeIndex] ? `${listId}-${activeIndex}` : undefined
          }
          disabled={disabled}
        />
        {menuOpen && (
          <ul
            id={listId}
            className={styles.menu}
            role="listbox"
            aria-label={trigger.kind === 'skill' ? t('chat.skillMenu') : t('chat.clientMenu')}
          >
            {options.length === 0 && <li className={styles.menuEmpty}>{t('chat.noMatch')}</li>}
            {options.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={styles.option}
                // 用 mousedown 选中，避免输入框先失焦把列表关掉
                onMouseDown={(e) => {
                  e.preventDefault();
                  option.select();
                }}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.bar}>
        <div className={styles.modes} role="radiogroup" aria-label={t('chat.modes.label')}>
          {TASK_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={styles.mode}
              disabled={disabled}
              onClick={() => onModeChange(m)}
            >
              {t(`chat.modes.${m}`)}
            </button>
          ))}
        </div>
        {generating ? (
          <IconButton
            variant="secondary"
            label={t('chat.stop')}
            icon={<Square size={14} fill="currentColor" />}
            onClick={onStop}
          />
        ) : (
          <IconButton
            type="submit"
            variant="primary"
            label={t('chat.send')}
            icon={<ArrowUp size={18} />}
            disabled={disabled || !text.trim()}
          />
        )}
      </div>
    </form>
  );
}

function Chip({
  icon,
  label,
  removeLabel,
  onRemove,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  removeLabel: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <span className={styles.chip}>
      {icon}
      <span>{label}</span>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        disabled={disabled}
      >
        <X size={12} />
      </button>
    </span>
  );
}
