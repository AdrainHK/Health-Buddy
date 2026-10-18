import { IconButton } from '@health-buddy/ui';
import {
  TASK_MODES,
  type ClientSummary,
  type ExpertSummary,
  type SkillSummary,
  type TaskMode,
} from '@health-buddy/shared';
import { ArrowUp, AtSign, FileText, Paperclip, Slash, Square, Stethoscope, X } from 'lucide-react';
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { REPORT_ACCEPT } from '../api/reports';
import { AiBadge } from '../experts/ExpertBadges';
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
  /** 列出来但不能选（如还没核对完的报告） */
  disabled?: boolean;
  /** 分组标题：这一项是该组的第一项时，在它前面显示（@ 列表的“专家”组，M3 规格 2.1） */
  group?: string;
  /** 专家带“AI”标记（Q24） */
  ai?: boolean;
  select: () => void;
}

/** @ 列表里的报告：已核对的可以引用；还没核对完的列出来但不能选（规格 2.6） */
export interface ReportOption {
  id: string;
  date: string;
  pending: boolean;
  /** 已核对报告的当前指标命中危急指标阈值 */
  critical?: boolean;
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
  /** 输入框为空也能发送（技能不需要再写要求，验收反馈 8） */
  canSendEmpty?: boolean;
  onStop: () => void;
  /** 输入框上方的提示（技能和模式不匹配、请先 @ 客户、出错等） */
  notice?: ReactNode;
  /** 当前客户的报告，@ 列表里列出 */
  reports?: ReportOption[];
  report?: ReportOption | null;
  onReportChange?: (report: ReportOption | null) => void;
  /** 选择、粘贴或拖入了报告文件（一次算一份报告） */
  onAttachFiles?: (files: File[]) => void;
  /** @ 列表里可以选的专家（M3 规格 2.4）；专家预览没开时为空 */
  experts?: readonly ExpertSummary[];
  /** 这条消息 @ 的专家 id */
  expertRefs?: readonly string[];
  onExpertRefsChange?: (ids: string[]) => void;
  /** 这条消息最多还能 @ 几位专家（Q5：一条消息最多 3 位，含绑定的专家） */
  maxExperts?: number;
  /** 模式固定（专家中心的任务固定为问一问，Q9）：其他模式不能选 */
  lockedMode?: TaskMode;
  /** 输入框上方的专家选择条（运行会自动请专家的技能时，规格 2.5） */
  expertBar?: ReactNode;
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
  canSendEmpty = false,
  onStop,
  notice,
  reports = [],
  report = null,
  onReportChange,
  onAttachFiles,
  experts = [],
  expertRefs = [],
  onExpertRefsChange,
  maxExperts = 3,
  lockedMode,
  expertBar,
}: ComposerProps) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const listId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
      : [
          ...clients
            .filter((c) => c.displayName.toLowerCase().includes(query))
            .map((c) => ({
              id: c.id,
              label: c.displayName,
              select: pick(() => onClientChange(c)),
            })),
          ...(onReportChange ? reports : [])
            .map((r) => ({ r, label: t('chat.reportOption', { date: r.date }) }))
            .filter(({ r, label }) => label.toLowerCase().includes(query) || r.date.includes(query))
            .map(({ r, label }) => ({
              id: r.id,
              label,
              ...(r.pending ? { description: t('chat.reportPending'), disabled: true } : {}),
              ...(!r.pending && r.critical ? { description: t('record.reports.critical') } : {}),
              select: r.pending ? () => {} : pick(() => onReportChange?.(r)),
            })),
          ...(onExpertRefsChange ? experts : [])
            .filter((e) => !expertRefs.includes(e.id))
            .filter(
              (e) =>
                e.name.toLowerCase().includes(query) || e.tagline.toLowerCase().includes(query),
            )
            .map((e, i) => {
              const full = expertRefs.length >= maxExperts;
              return {
                id: `expert:${e.id}`,
                label: e.name,
                description: full ? t('chat.experts.max') : e.tagline,
                ai: true,
                ...(i === 0 ? { group: t('chat.experts.group') } : {}),
                ...(full ? { disabled: true } : {}),
                select: full ? () => {} : pick(() => onExpertRefsChange?.([...expertRefs, e.id])),
              };
            }),
        ];
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

  // 粘贴截图、拖入文件都按上传报告处理
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!onAttachFiles || files.length === 0) return;
    e.preventDefault();
    onAttachFiles(files);
  };
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const onDragOver = (e: DragEvent<HTMLFormElement>) => {
    if (!onAttachFiles || disabled || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    if (!onAttachFiles || disabled || !hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length) onAttachFiles(files);
  };

  return (
    <form
      className={styles.composer}
      onSubmit={submit}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-dragging={dragging || undefined}
    >
      {notice && <div className={styles.notice}>{notice}</div>}
      {dragging && (
        <div className={styles.notice} role="status">
          {t('chat.dropHint')}
        </div>
      )}

      {expertBar && <div className={styles.notice}>{expertBar}</div>}

      {(skill || client || report || expertRefs.length > 0) && (
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
          {report && (
            <Chip
              icon={<FileText size={12} />}
              label={t('chat.reportOption', { date: report.date })}
              removeLabel={t('chat.removeReport', { date: report.date })}
              onRemove={() => onReportChange?.(null)}
              disabled={disabled}
            />
          )}
          {expertRefs.map((id) => {
            const name = experts.find((e) => e.id === id)?.name ?? id;
            return (
              <Chip
                key={id}
                icon={<Stethoscope size={12} />}
                label={name}
                removeLabel={t('chat.experts.removeExpert', { name })}
                onRemove={() => onExpertRefsChange?.(expertRefs.filter((x) => x !== id))}
                disabled={disabled}
              />
            );
          })}
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
          onPaste={onPaste}
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
            {options.map((option, index) => [
              option.group && (
                <li key={`group-${option.id}`} role="presentation" className={styles.menuGroup}>
                  {option.group}
                </li>
              ),
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={option.disabled || undefined}
                className={styles.option}
                // 用 mousedown 选中，避免输入框先失焦把列表关掉
                onMouseDown={(e) => {
                  e.preventDefault();
                  option.select();
                }}
              >
                {option.label}
                {option.ai && (
                  <>
                    {' '}
                    <AiBadge />
                  </>
                )}
                {option.description && (
                  <span className={styles.optionNote}>{option.description}</span>
                )}
              </li>,
            ])}
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
              disabled={disabled || (lockedMode !== undefined && m !== lockedMode)}
              onClick={() => onModeChange(m)}
            >
              {t(`chat.modes.${m}`)}
            </button>
          ))}
        </div>
        <div className={styles.barEnd}>
          {onAttachFiles && (
            <>
              <IconButton
                label={t('chat.attach')}
                icon={<Paperclip size={16} />}
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              />
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept={REPORT_ACCEPT}
                aria-label={t('chat.attachLabel')}
                data-testid="chat-file-input"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length) onAttachFiles(files);
                }}
              />
            </>
          )}
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
              disabled={disabled || (!text.trim() && !canSendEmpty)}
            />
          )}
        </div>
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
