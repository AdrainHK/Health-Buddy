import { Button, IconButton } from '@health-buddy/ui';
import {
  EXPERTS_PER_CALL_MAX,
  TWIN_DOMAINS,
  TWIN_REFS_MAX,
  twinRefKey,
  type ArtifactSummary,
  type ClientSummary,
  type DuplicateUpload,
  type ExpertSummary,
  type ReportUploadSummary,
  type SkillSummary,
  type Task,
  type TaskMode,
  type TaskPlan,
  type TwinRef,
} from '@health-buddy/shared';
import { FileText, Menu, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { type ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listTaskConsultations } from '../api/experts';
import { ApiError, isAbortError } from '../api/http';
import { confirmPlan, sendMessage, type StreamOptions } from '../api/stream';
import { DuplicateFileError, listReports, listUploads, uploadReport } from '../api/reports';
import { createTask, getTask, stopTask } from '../api/workbench';
import { getTwin } from '../api/twin';
import { Composer, type ReportOption, type TwinItemOption } from '../chat/Composer';
import {
  conversationReducer,
  emptyConversation,
  LOCAL_PREFIX,
  type ViewMessage,
} from '../chat/conversation';
import { MessageList } from '../chat/MessageList';
import { AiBadge, ExpertAvatar } from '../experts/ExpertBadges';
import { useExpertName, useExperts } from '../experts/ExpertsContext';
import expertStyles from '../experts/Experts.module.css';
import { ExpertSelector } from '../experts/ExpertSelector';
import { isExpertStep } from '../experts/ExpertSteps';
import { useSkillName } from '../i18n/dynamic';
import { uploadErrorKey, type UploadErrorKey } from '../reports/errors';
import { useTwinRefLabel } from '../twin/TwinActions';
import reportStyles from '../reports/Reports.module.css';
import { UploadCard } from '../reports/UploadCard';
import styles from './ChatPane.module.css';
import { isReadOnlyTask } from './taskGroups';

/** 报告选择里最多列出几份（新的在前） */
const REPORT_PICKER_MAX = 5;

/** 识别卡片上“生成解读”调用的技能 */
const INTERPRETATION_SKILL_ID = 'report-interpretation';

/**
 * 孪生里点了“请专家看看”“生成孪生小结”（M4 规格 2.6 之二、2.7）：在这个任务里预先填好输入框，
 * 由健管师补充问题后发送（也可以直接发送）。key 每次点击都变。
 */
export interface ComposerPrefill {
  key: number;
  taskId: string;
  mode: TaskMode;
  skillId?: string;
  twinRefs?: TwinRef[];
  twinConsult?: boolean;
  followUpItemId?: string;
}

export interface ChatPaneProps {
  narrow: boolean;
  onOpenMenu: () => void;
  resultsOpen: boolean;
  onToggleResults: () => void;
  /** 当前任务；为空时显示欢迎页，发送第一条消息时自动新建任务 */
  task?: Task | null;
  skills?: SkillSummary[];
  clients?: ClientSummary[];
  /** 在对话区里新建了任务（欢迎页直接发送时） */
  onTaskCreated?: (task: Task) => void;
  /** 任务可能变了（更新时间、关联客户、只读），侧栏需要刷新 */
  onTaskChanged?: () => void;
  /** 生成了草稿，结果区需要刷新 */
  onArtifact?: (artifact: ArtifactSummary) => void;
  /**
   * 对话在对话区之外有了变化（如结果区里的退回重写生成了新一轮）时改变，
   * 对话区据此重新加载当前任务的对话。
   */
  conversationVersion?: number;
  /** 输入框里 @ 的客户变了（结果区据此显示客户资料） */
  onDraftClientChange?: (client: ClientSummary | null) => void;
  /** 回到欢迎页准备新建任务（为另一位客户新建任务时） */
  onNewTask?: () => void;
  /** 点了识别卡片上的“去核对”：结果区打开核对界面 */
  onReviewUpload?: (uploadId: string) => void;
  /** 对话里上传了报告或识别状态变了：结果区的核对标签需要刷新 */
  onUploadsChanged?: () => void;
  /**
   * 识别记录在对话区之外有了变化（结果区里确认核对、放弃、重新识别）时改变，
   * 对话区据此刷新识别卡片（验收反馈 3）。
   */
  uploadsVersion?: number;
  /**
   * 在专家中心点了“向 TA 提问”、任务还没建：发送第一条消息时新建绑定这位专家的任务，
   * 模式固定为问一问（M3 规格 2.3、Q9）
   */
  pendingExpert?: ExpertSummary | null;
  /** 点了“查看专家意见”：结果区打开专家标签 */
  onOpenExperts?: (consultationId: string | null) => void;
  /** 一次专家调用结束：结果区的专家标签需要刷新 */
  onConsultation?: () => void;
  /** 孪生里的操作带过来的输入（只对 taskId 这个任务生效） */
  prefill?: ComposerPrefill | null;
}

interface Draft {
  text: string;
  mode: TaskMode;
  skill: SkillSummary | null;
  client: ClientSummary | null;
  report?: ReportOption | null;
  /** @ 的专家和“一定要请”的专家（M3 规格 2.4、2.5） */
  expertRefs?: string[];
  /** “不要请”的专家，只对这一条消息生效（Q22） */
  excludedExperts?: string[];
  /** @ 的孪生项（M4 规格 2.8），只能在问一问里用 */
  twinRefs?: TwinRef[];
  /** “请专家看看”（2.6 之二）：按孪生项请专家，可以不写问题 */
  twinConsult?: boolean;
  /** 从跟进项发起的“请专家看看” */
  followUpItemId?: string | null;
  /**
   * 不是从输入框发出的（识别卡片上的“生成解读”、核对后自动解读）：
   * 发送时不清空、失败时也不恢复输入框，健管师正在输入的内容不受影响。
   */
  auto?: boolean;
}

type ErrorKey =
  | 'busy'
  | 'tooMany'
  | 'readOnly'
  | 'noVerifiedReport'
  | 'noTwinData'
  | 'badRequest'
  | 'notFound'
  | 'conflict'
  | 'network'
  | 'unknown';

type Notice =
  | { kind: 'needClient' }
  | { kind: 'uploadNeedClient' }
  | { kind: 'uploadError'; key: UploadErrorKey }
  | { kind: 'otherClient'; client: ClientSummary }
  | { kind: 'duplicate'; status: ReportUploadSummary['status']; uploadId: string; date: string }
  | { kind: 'error'; key: ErrorKey };

/**
 * @专家 不能用在这里（M3 规格 2.4）：技能不接入专家时提示“这个技能暂不调用专家”；
 * 没有技能时只能在问一问里直接请专家（专家中心的任务本来就是问一问）。
 */
function expertConflict(
  refs: readonly string[],
  skill: SkillSummary | null,
  mode: TaskMode,
): 'skillNoExperts' | 'needAsk' | null {
  if (refs.length === 0) return null;
  if (skill) return skill.experts === 'auto' ? null : 'skillNoExperts';
  return mode === 'ask' ? null : 'needAsk';
}

function errorKey(err: unknown): ErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.status === 429) return 'tooMany';
  if (err.status === 409) {
    if (err.reasons.includes('read_only')) return 'readOnly';
    if (err.reasons.includes('busy')) return 'busy';
    // /体检解读、/面谈提纲：这位客户还没有已核对的报告（规格 2.6）
    if (err.reasons.includes('no_verified_report')) return 'noVerifiedReport';
    // /孪生小结：这位客户还没有孪生数据（M4 规格 2.7）
    if (err.reasons.includes('no_twin_data')) return 'noTwinData';
    return 'conflict';
  }
  if (err.status === 400) return 'badRequest';
  if (err.status === 404) return 'notFound';
  return 'unknown';
}

const EMPTY: never[] = [];

/** 技能不能在当前模式下用：问一问不能用技能（Q4）；多步计划只能在想一想下用（Q22） */
function modeConflict(skill: SkillSummary | null, mode: TaskMode): 'ask' | 'planOnly' | null {
  if (!skill) return null;
  if (mode === 'ask') return 'ask';
  if (!skill.modes.includes(mode) && skill.modes.includes('plan')) return 'planOnly';
  return null;
}

/** 中间对话区：消息流、执行步骤、计划和输入框（M1 规格 3.2–3.5） */
export function ChatPane({
  narrow,
  onOpenMenu,
  resultsOpen,
  onToggleResults,
  task = null,
  skills = EMPTY,
  clients = EMPTY,
  onTaskCreated,
  onTaskChanged,
  onArtifact,
  conversationVersion = 0,
  onDraftClientChange,
  onNewTask,
  onReviewUpload,
  onUploadsChanged,
  uploadsVersion = 0,
  pendingExpert = null,
  onOpenExperts,
  onConsultation,
  prefill = null,
}: ChatPaneProps) {
  const { t } = useTranslation();
  const twinRefLabel = useTwinRefLabel();
  const skillName = useSkillName();
  const experts = useExperts();
  const expertName = useExpertName();
  const [conversation, dispatch] = useReducer(conversationReducer, emptyConversation);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  // 默认“做一做”，与 WorkBuddy 的默认模式一致。
  const [mode, setMode] = useState<TaskMode>('craft');
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  const [client, setClient] = useState<ClientSummary | null>(null);
  /** @ 引用的已核对报告（规格 2.6） */
  const [report, setReport] = useState<ReportOption | null>(null);
  /** @ 的专家（也是专家选择条里的“一定要请”）和“不要请”的专家，只对这一条消息生效 */
  const [expertRefs, setExpertRefs] = useState<string[]>([]);
  const [excludedExperts, setExcludedExperts] = useState<string[]>([]);
  /** @ 的孪生项、“请专家看看”和发起它的跟进项（M4），只对这一条消息生效 */
  const [twinRefs, setTwinRefs] = useState<TwinRef[]>([]);
  const [twinConsult, setTwinConsult] = useState(false);
  const [followUpItemId, setFollowUpItemId] = useState<string | null>(null);
  /** @ 列表里的孪生项：当前客户的四个方面，加上有预测的指标 */
  const [twinMetrics, setTwinMetrics] = useState<string[]>([]);
  /** 当前客户的报告：已核对的可以 @，还没核对完的列出来但不能选 */
  const [reportOptions, setReportOptions] = useState<ReportOption[]>([]);
  /** 本任务里上传的报告（识别进度卡片） */
  const [uploads, setUploads] = useState<ReportUploadSummary[]>([]);
  const [uploadVersion, setUploadVersion] = useState(0);
  /** 本任务发送时 @ 过的客户：任务列表刷新出关联关系之前，结果区先用它显示资料 */
  const [sentClient, setSentClient] = useState<ClientSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [generating, setGenerating] = useState(false);
  const [queued, setQueued] = useState<Draft | null>(null);
  /** 发消息时才发现任务已只读（409 read_only），在侧栏刷新前先禁用输入 */
  const [readOnlyTaskId, setReadOnlyTaskId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generatingRef = useRef(false);
  const queuedRef = useRef<Draft | null>(null);
  const createdTaskIdRef = useRef<string | null>(null);
  const localSeq = useRef(0);
  const submitRef = useRef<(draft: Draft) => void>(() => {});
  /** 为另一位客户新建任务时带到欢迎页的输入内容 */
  const carryRef = useRef<Draft | null>(null);
  /**
   * 上传时就想要解读的识别记录（选了 /体检解读，或要求里写了“解读”）：核对确认后自动开始解读，
   * 每份只开始一次。只在本页面里记住，刷新后不再自动开始。
   */
  const [interpretIntent, setInterpretIntent] = useState<ReadonlySet<string>>(new Set());
  const interpretIntentRef = useRef<ReadonlySet<string>>(interpretIntent);
  interpretIntentRef.current = interpretIntent;
  const interpretedRef = useRef(new Set<string>());
  const autoInterpretRef = useRef<(upload: ReportUploadSummary) => void>(() => {});
  /** /体检解读 因为“还没有已核对的报告”被拒绝：接下来上传的报告核对后自动解读 */
  const wantsInterpretRef = useRef(false);

  const taskId = task?.id ?? null;
  const readOnly = task !== null && (isReadOnlyTask(task) || readOnlyTaskId === task.id);
  /** 专家中心发起的任务绑定的专家（已建的任务，或还没建、从专家中心过来的） */
  const boundExpertId = task ? task.expertId : (pendingExpert?.id ?? null);
  const taskIdRef = useRef<string | null>(taskId);
  taskIdRef.current = taskId;

  // 专家中心的任务固定为问一问（Q9）
  useEffect(() => {
    if (boundExpertId) setMode('ask');
  }, [boundExpertId]);

  /** 取任务里的专家调用（路由原因、每位专家的最终状态、汇总），刷新后也能完整显示（规格 2.6） */
  const loadConsultations = (id: string, signal?: AbortSignal) => {
    listTaskConsultations(id, signal)
      .then((consultations) => {
        if (taskIdRef.current === id) dispatch({ type: 'consultations', consultations });
      })
      .catch(() => {
        // 取不到时步骤仍按 step 事件显示，只是少了每位专家的最终状态
      });
  };

  // 切换任务：停止上一个任务的流（后端把断开当作停止），加载新任务的历史
  useEffect(() => {
    if (taskId !== null && createdTaskIdRef.current === taskId) {
      // 刚在欢迎页新建的任务，对话就在本地，不用加载
      createdTaskIdRef.current = null;
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    generatingRef.current = false;
    queuedRef.current = null;
    setGenerating(false);
    setQueued(null);
    setNotice(null);
    setSkill(null);
    setClient(null);
    setReport(null);
    setExpertRefs([]);
    setExcludedExperts([]);
    setTwinRefs([]);
    setTwinConsult(false);
    setFollowUpItemId(null);
    setUploads([]);
    setSentClient(null);
    setInterpretIntent(new Set());
    wantsInterpretRef.current = false;
    dispatch({ type: 'reset' });
    if (taskId === null) {
      setLoadState('idle');
      const carry = carryRef.current;
      carryRef.current = null;
      if (carry) {
        setText(carry.text);
        setMode(carry.mode);
        setSkill(carry.skill);
        setClient(carry.client);
        inputRef.current?.focus();
      }
      return;
    }
    carryRef.current = null;
    setLoadState('loading');
    const controller = new AbortController();
    getTask(taskId, controller.signal)
      .then((detail) => {
        dispatch({ type: 'load', detail });
        setUploads(detail.uploads);
        setLoadState('idle');
        if (detail.steps.some(isExpertStep)) loadConsultations(taskId, controller.signal);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoadState('error');
      });
    return () => controller.abort();
  }, [taskId, reloadKey]);

  // 对话在别处有了变化（退回重写）：静默重新加载，不清空已显示的内容，避免闪烁。
  // 本地正在生成时跳过（退回重写和对话生成互斥，后端会拒绝其中一个）。
  const seenConversationVersion = useRef(conversationVersion);
  useEffect(() => {
    if (seenConversationVersion.current === conversationVersion) return;
    seenConversationVersion.current = conversationVersion;
    if (taskId === null || generatingRef.current) return;
    const controller = new AbortController();
    getTask(taskId, controller.signal)
      .then((detail) => {
        if (generatingRef.current || detail.task.id !== taskId) return;
        dispatch({ type: 'load', detail });
        setLoadState('idle');
        if (detail.steps.some(isExpertStep)) loadConsultations(taskId, controller.signal);
      })
      .catch(() => {
        // 静默刷新失败时保留当前内容，切换任务或刷新页面后可以看到
      });
    return () => controller.abort();
  }, [conversationVersion, taskId]);

  // @ 列表里的报告：任务关联的客户，或输入框里 @ 的客户
  const reportClientId = task?.clientId ?? client?.id ?? sentClient?.id ?? null;
  useEffect(() => {
    setReport((r) => (reportClientId === null ? null : r));
    if (reportClientId === null) {
      setReportOptions([]);
      return;
    }
    const controller = new AbortController();
    Promise.all([
      listReports(reportClientId, controller.signal),
      listUploads(reportClientId, controller.signal).catch(() => []),
    ])
      .then(([reports, pending]) => {
        setReportOptions([
          ...reports.map((r) => ({
            id: r.id,
            date: r.reportDate,
            pending: false,
            ...(r.hasCritical ? { critical: true } : {}),
          })),
          ...pending
            .filter((u) => ['queued', 'processing', 'needs_review'].includes(u.status))
            .map((u) => ({ id: u.id, date: u.createdAt.slice(0, 10), pending: true })),
        ]);
      })
      .catch(() => setReportOptions([]));
    return () => controller.abort();
  }, [reportClientId, uploadVersion]);

  // @ 列表里的孪生项：只列当前客户的（四个方面 + 有预测的指标，M4 规格 2.8）
  useEffect(() => {
    setTwinRefs((refs) => (reportClientId === null ? [] : refs));
    if (reportClientId === null) {
      setTwinMetrics([]);
      return;
    }
    const controller = new AbortController();
    getTwin(reportClientId, controller.signal)
      .then((twin) => setTwinMetrics([...new Set(twin.forecasts.map((f) => f.metric))]))
      .catch(() => setTwinMetrics([]));
    return () => controller.abort();
  }, [reportClientId]);

  // 孪生里点了“请专家看看”“生成孪生小结”：任务切换完成后预先填好输入框，每次点击只填一次
  const appliedPrefill = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || prefill.taskId !== taskId || appliedPrefill.current === prefill.key) return;
    appliedPrefill.current = prefill.key;
    setNotice(null);
    setMode(prefill.mode);
    setSkill(prefill.skillId ? (skills.find((s) => s.id === prefill.skillId) ?? null) : null);
    setTwinRefs(prefill.twinRefs ?? []);
    setTwinConsult(Boolean(prefill.twinConsult));
    setFollowUpItemId(prefill.followUpItemId ?? null);
    setExpertRefs([]);
    setExcludedExperts([]);
    inputRef.current?.focus();
  }, [prefill, taskId, skills]);

  const shownClient = client ?? sentClient;
  useEffect(() => {
    onDraftClientChange?.(shownClient);
  }, [shownClient, onDraftClientChange]);

  // 离开页面时停止正在进行的流
  useEffect(() => () => abortRef.current?.abort(), []);

  // 新内容出现时滚到底部
  const lastMessage = conversation.messages.at(-1);
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [conversation.messages.length, lastMessage?.content, conversation.steps.length]);

  const clearComposer = () => {
    setText('');
    setSkill(null);
    setClient(null);
    setReport(null);
    setExpertRefs([]);
    setExcludedExperts([]);
    setTwinRefs([]);
    setTwinConsult(false);
    setFollowUpItemId(null);
  };

  const restoreComposer = (draft: Draft) => {
    setText(draft.text);
    setSkill(draft.skill);
    setClient(draft.client);
    setReport(draft.report ?? null);
    setExpertRefs(draft.expertRefs ?? []);
    setExcludedExperts(draft.excludedExperts ?? []);
    setTwinRefs(draft.twinRefs ?? []);
    setTwinConsult(Boolean(draft.twinConsult));
    setFollowUpItemId(draft.followUpItemId ?? null);
  };

  const nextLocalId = () => `${LOCAL_PREFIX}${++localSeq.current}`;

  /**
   * 跑一轮流式生成。流打开前被拒绝（400、404、409、429）时撤回本地消息、恢复输入；
   * 打开后断开时保留已显示的内容并标为出错。
   */
  async function runStream(
    target: Task,
    start: { manager?: ViewMessage; assistant: ViewMessage },
    open: (options: StreamOptions) => Promise<void>,
    hooks: { onOpen?: () => void; draft?: Draft; restore?: boolean } = {},
  ): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setNotice(null);
    dispatch({ type: 'start', ...start });

    let opened = false;
    let refusedId: string | null = null;
    const current = () => abortRef.current === controller;
    try {
      await open({
        signal: controller.signal,
        onOpen: () => {
          opened = true;
          hooks.onOpen?.();
          // 后端在流打开前已按这一轮生成了任务标题，刷新任务列表让侧栏和标题栏马上换上
          onTaskChanged?.();
        },
        onEvent: (event) => {
          if (!current()) return;
          if (event.type === 'done' && event.reason === 'refused') refusedId = event.messageId;
          if (event.type === 'artifact') onArtifact?.(event.artifact);
          dispatch({ type: 'event', event });
          if (event.type === 'consultation') {
            // 一次专家调用结束：取回路由原因、最终状态和汇总，结果区的专家标签也刷新
            loadConsultations(target.id);
            onConsultation?.();
          }
        },
      });
      if (current()) dispatch({ type: 'end' });
    } catch (err) {
      if (!current()) return; // 已切换到别的任务
      if (isAbortError(err)) {
        dispatch({ type: 'end', stopped: true });
      } else if (!opened) {
        const ids = [start.manager?.id, start.assistant.id].filter((x): x is string => !!x);
        dispatch({ type: 'rollback', ids });
        if (hooks.draft && hooks.restore !== false) restoreComposer(hooks.draft);
        const key = errorKey(err);
        if (key === 'readOnly') setReadOnlyTaskId(target.id);
        // 想解读但还没有已核对的报告：接下来上传的报告核对后自动开始解读
        if (key === 'noVerifiedReport' && hooks.draft?.skill?.id === INTERPRETATION_SKILL_ID) {
          wantsInterpretRef.current = true;
        }
        setNotice({ kind: 'error', key });
      } else {
        dispatch({ type: 'end', errorKind: 'network' });
      }
    }
    if (!current()) return;

    abortRef.current = null;
    generatingRef.current = false;
    setGenerating(false);
    onTaskChanged?.();

    // 拒答：本轮流式文本已清空，换成后端保存的内容（只有固定提醒）
    const refused = refusedId;
    if (refused) {
      try {
        const detail = await getTask(target.id);
        const saved = detail.messages.find((m) => m.id === refused);
        if (saved && !generatingRef.current) dispatch({ type: 'restore', message: saved });
      } catch {
        // 加载失败时保持清空，刷新后可以看到
      }
    }

    // 生成中输入的追问，等这一轮结束后再发
    const next = queuedRef.current;
    if (next) {
      queuedRef.current = null;
      setQueued(null);
      submitRef.current(next);
    }
  }

  /**
   * 输入框为空也能发送：技能不需要再写要求（技能元数据 allowsEmptyRequest），客户已选好，
   * 要报告的技能已引用报告（验收反馈 8）。后端用技能的默认要求。
   */
  function canSendEmpty(draft: Draft): boolean {
    // “请专家看看”可以不写问题（后端用默认的问题）
    if (draft.twinConsult && draft.mode === 'ask' && (draft.twinRefs ?? []).length > 0) return true;
    const s = draft.skill;
    if (!s?.allowsEmptyRequest || modeConflict(s, draft.mode)) return false;
    if (s.requiresClient && !draft.client && !task?.clientId) return false;
    if (s.requiresReport && s.planSkills.length === 0 && !draft.report) return false;
    return true;
  }

  async function submit(draft: Draft): Promise<void> {
    if (readOnly) return;
    const fromComposer = !draft.auto;
    const content = draft.text.trim();
    if (!content && !canSendEmpty(draft)) return;
    // 问一问不能用技能（Q4）、多步计划只能在想一想下用：提示切换模式，不发送
    if (modeConflict(draft.skill, draft.mode)) return;
    const refs = draft.expertRefs ?? [];
    // @专家 只能在问一问或接入专家的技能里用（M3 规格 2.4），提示已显示在输入框上方
    if (expertConflict(refs, draft.skill, draft.mode)) return;
    // “不要请”只对会自动请专家的技能有效
    const excluded = draft.skill?.experts === 'auto' ? (draft.excludedExperts ?? []) : [];
    // @孪生项 只能在问一问里用（M4 规格 2.8），提示已显示在输入框上方
    const twin = draft.twinRefs ?? [];
    if (twin.length && (draft.mode !== 'ask' || draft.skill)) return;
    const consult = Boolean(draft.twinConsult) && twin.length > 0;
    const linkedClientId = task?.clientId ?? null;
    if (twin.length && !draft.client && !linkedClientId) {
      setNotice({ kind: 'needClient' });
      return;
    }
    if (draft.client && linkedClientId && draft.client.id !== linkedClientId) {
      setNotice({ kind: 'otherClient', client: draft.client });
      return;
    }
    if (draft.skill?.requiresClient && !draft.client && !linkedClientId) {
      setNotice({ kind: 'needClient' });
      return;
    }
    if (generatingRef.current) {
      // 生成中的追问排队，当前回答结束或被停止后再发（规格 3.2）
      queuedRef.current = draft;
      setQueued(draft);
      if (fromComposer) clearComposer();
      return;
    }

    if (fromComposer) clearComposer();
    if (draft.client) setSentClient(draft.client);
    let target = task;
    if (!target) {
      try {
        // 从专家中心过来：新建绑定这位专家的任务（M3 规格 2.3）。标题由后端按第一条消息生成，
        // 如“问营养专家：王测试 · 最近饮食怎么调整”
        target = await createTask(pendingExpert ? { expertId: pendingExpert.id } : {});
      } catch (err) {
        if (fromComposer) restoreComposer(draft);
        setNotice({ kind: 'error', key: errorKey(err) });
        return;
      }
      createdTaskIdRef.current = target.id;
      onTaskCreated?.(target);
    }

    const manager: ViewMessage = {
      id: nextLocalId(),
      role: 'manager',
      mode: draft.mode,
      content,
      skillId: draft.skill?.id ?? null,
      clientRefs: draft.client ? [draft.client.id] : [],
      ...(draft.report ? { reportRefs: [draft.report.id] } : {}),
      ...(refs.length ? { expertRefs: refs } : {}),
      ...(excluded.length ? { excludedExperts: excluded } : {}),
      ...(twin.length ? { twinRefs: twin } : {}),
      status: 'complete',
    };
    const assistant: ViewMessage = {
      id: nextLocalId(),
      role: 'assistant',
      mode: draft.mode,
      content: '',
      skillId: draft.skill?.id ?? null,
      clientRefs: [],
      status: 'streaming',
    };
    const taskForSend = target;
    await runStream(
      taskForSend,
      { manager, assistant },
      (options) =>
        sendMessage(
          taskForSend.id,
          {
            mode: draft.mode,
            content,
            ...(draft.skill ? { skillId: draft.skill.id } : {}),
            clientRefs: draft.client ? [draft.client.id] : [],
            ...(draft.report ? { reportRefs: [draft.report.id] } : {}),
            ...(refs.length ? { expertRefs: refs } : {}),
            ...(excluded.length ? { excludedExperts: excluded } : {}),
            ...(twin.length ? { twinRefs: twin } : {}),
            ...(consult ? { twinConsult: true } : {}),
            ...(consult && draft.followUpItemId ? { followUpItemId: draft.followUpItemId } : {}),
          },
          options,
        ),
      { draft, restore: fromComposer },
    );
  }

  useEffect(() => {
    submitRef.current = (draft) => void submit(draft);
  });

  /**
   * 上传报告（规格 2.3 第 1 条）：必须先 @ 客户或在已关联客户的任务里；
   * 欢迎页上传时先为这位客户新建任务，识别进度卡片显示在对话里。
   */
  const onAttachFiles = async (files: File[]) => {
    if (readOnly) return;
    const linkedId = task?.clientId ?? null;
    const target = linkedId
      ? (clients.find((c) => c.id === linkedId) ?? { id: linkedId })
      : (client ?? sentClient);
    if (!target) {
      setNotice({ kind: 'uploadNeedClient' });
      return;
    }
    setNotice(null);
    // 上传时就想要解读：选了 /体检解读、要求里写了“解读”，或刚才 /体检解读 因为没有已核对的报告被拒绝
    const wantsInterpret =
      skill?.id === INTERPRETATION_SKILL_ID ||
      text.includes(t('chat.interpretKeyword')) ||
      wantsInterpretRef.current;
    let taskForUpload = task;
    try {
      if (!taskForUpload) {
        taskForUpload = await createTask({ clientId: target.id });
        createdTaskIdRef.current = taskForUpload.id;
        if (client) setSentClient(client);
        onTaskCreated?.(taskForUpload);
      }
      const created = await uploadReport(target.id, files, taskForUpload.id);
      setUploads((list) => [...list.filter((u) => u.id !== created.id), created]);
      if (wantsInterpret) addInterpretIntent(created.id);
      setUploadVersion((v) => v + 1);
      onTaskChanged?.();
      onUploadsChanged?.();
    } catch (err) {
      if (err instanceof DuplicateFileError && err.existing) {
        onDuplicate(err.existing, wantsInterpret);
        return;
      }
      setNotice({ kind: 'uploadError', key: uploadErrorKey(err) });
    }
  };

  const addInterpretIntent = (uploadId: string) => {
    wantsInterpretRef.current = false;
    setInterpretIntent((set) => new Set(set).add(uploadId));
  };

  /**
   * 同一个文件已经上传过（验收反馈 6）：已核对的直接引用那份报告；还没核对完的引导去核对，
   * 想要解读时核对后自动开始。只有已核对的报告能解读，这一点后端也校验。
   */
  const onDuplicate = (existing: DuplicateUpload, wantsInterpret: boolean) => {
    if (existing.status === 'verified' && existing.reportId) {
      const date = existing.reportDate ?? '';
      setReport({ id: existing.reportId, date, pending: false });
      if (wantsInterpret && interpretSkill && !skill) setSkill(interpretSkill);
      setNotice({ kind: 'duplicate', status: 'verified', uploadId: existing.uploadId, date });
      return;
    }
    if (wantsInterpret && existing.status !== 'failed') addInterpretIntent(existing.uploadId);
    setNotice({
      kind: 'duplicate',
      status: existing.status,
      uploadId: existing.uploadId,
      date: '',
    });
  };

  const onUploadChanged = (next: ReportUploadSummary) => {
    setUploads((list) => list.map((u) => (u.id === next.id ? next : u)));
    setUploadVersion((v) => v + 1);
    onUploadsChanged?.();
    // 识别完成：自动打开核对界面（产品决定，验收反馈 6）
    if (next.status === 'needs_review' && !readOnly) onReviewUpload?.(next.id);
  };

  // 识别记录在结果区里有了变化（确认核对、放弃、重新识别）：刷新卡片；想要解读的报告核对完成时自动开始解读
  const seenUploadsVersion = useRef(uploadsVersion);
  useEffect(() => {
    if (seenUploadsVersion.current === uploadsVersion) return;
    seenUploadsVersion.current = uploadsVersion;
    if (reportClientId === null) return;
    const controller = new AbortController();
    listUploads(reportClientId, controller.signal)
      .then((fresh) => {
        const byId = new Map(fresh.map((u) => [u.id, u]));
        setUploads((list) =>
          list.map((u) => {
            const f = byId.get(u.id);
            return f && f.attempts >= u.attempts ? f : u;
          }),
        );
        setUploadVersion((v) => v + 1);
        for (const u of fresh) autoInterpretRef.current(u);
      })
      .catch(() => {
        // 刷新失败时保留当前卡片，切换任务或刷新页面后可以看到
      });
    return () => controller.abort();
  }, [uploadsVersion, reportClientId]);

  /** 识别卡片上的“生成解读”（规格 2.5 第 1 条）：相当于在做一做模式下发送 /体检解读 @报告 */
  const interpretSkill = skills.find((s) => s.id === INTERPRETATION_SKILL_ID) ?? null;
  const onInterpret = (upload: ReportUploadSummary) => {
    if (!interpretSkill || !upload.reportId || readOnly) return;
    const date = reportOptions.find((r) => r.id === upload.reportId)?.date ?? '';
    setMode('craft');
    void submit({
      text: t('chat.interpretRequest'),
      mode: 'craft',
      skill: interpretSkill,
      client: null,
      report: { id: upload.reportId, date, pending: false },
      auto: true,
    });
  };

  // 上传时就想要解读的报告核对完成：自动开始 /体检解读（产品决定，验收反馈 6），每份只开始一次
  useEffect(() => {
    autoInterpretRef.current = (upload) => {
      if (!interpretIntentRef.current.has(upload.id) || interpretedRef.current.has(upload.id)) {
        return;
      }
      if (upload.status !== 'verified' || !upload.reportId || !interpretSkill || readOnly) return;
      interpretedRef.current.add(upload.id);
      setInterpretIntent((set) => {
        const next = new Set(set);
        next.delete(upload.id);
        return next;
      });
      // 输入框里只选了 /体检解读、没写别的：已经替健管师发出了，去掉这个技能
      if (skill?.id === INTERPRETATION_SKILL_ID && !text.trim()) setSkill(null);
      onInterpret(upload);
    };
  });

  const onConfirmPlan = (plan: TaskPlan) => {
    if (!task || readOnly || generatingRef.current) return;
    const target = task;
    const assistant: ViewMessage = {
      id: nextLocalId(),
      role: 'assistant',
      mode: 'craft',
      content: '',
      skillId: null,
      clientRefs: [],
      status: 'streaming',
    };
    void runStream(target, { assistant }, (options) => confirmPlan(target.id, plan.id, options), {
      onOpen: () => dispatch({ type: 'planConfirmed', planId: plan.id }),
    });
  };

  const onStop = () => {
    if (!task) return;
    // 后端停止后会推送 done(stopped)，已生成的内容保留；停止请求本身失败时直接断开
    stopTask(task.id).catch(() => abortRef.current?.abort());
  };

  const onUseSkill = (skillId: string) => {
    const found = skills.find((s) => s.id === skillId);
    if (!found) return;
    setSkill(found);
    inputRef.current?.focus();
  };

  /**
   * 回答下方的“请 @某专家 看看”（M3 Q6）：把这条回答对应的问题原样交给这位专家，在问一问里直接请。
   * 健管师点了才调用；不影响输入框里正在写的内容。
   */
  const onAskExpert = (expertId: string, answerId: string) => {
    if (readOnly || generatingRef.current) return;
    const index = conversation.messages.findIndex((m) => m.id === answerId);
    const question = conversation.messages
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((m) => m.role === 'manager');
    if (!question?.content.trim()) return;
    void submit({
      text: question.content,
      mode: 'ask',
      skill: null,
      client: null,
      expertRefs: [expertId],
      auto: true,
    });
  };

  const onClientChange = (next: ClientSummary | null) => {
    if (next && task?.clientId && next.id !== task.clientId) {
      // 每个任务只关联一位客户（Q6）：提示并提供一键为该客户新建任务
      setNotice({ kind: 'otherClient', client: next });
      return;
    }
    setClient(next);
    if (next && (notice?.kind === 'needClient' || notice?.kind === 'uploadNeedClient')) {
      setNotice(null);
    }
  };

  const onSkillChange = (next: SkillSummary | null) => {
    setSkill(next);
    if (notice?.kind === 'needClient' && !next?.requiresClient) setNotice(null);
  };

  const conflict = modeConflict(skill, mode);
  const expertIssue = expertConflict(expertRefs, skill, mode);
  const twinIssue = twinRefs.length > 0 && (mode !== 'ask' || skill !== null);
  let noticeNode: ReactNode = null;
  if (twinIssue) {
    noticeNode = (
      <>
        <span role="alert">{t('chat.twin.needAsk')}</span>
        <Button
          variant="ghost"
          onClick={() => {
            setSkill(null);
            setMode('ask');
          }}
        >
          {t('chat.experts.switchToAsk')}
        </Button>
      </>
    );
  } else if (conflict === null && expertIssue === 'skillNoExperts') {
    noticeNode = <span role="alert">{t('chat.experts.skillNoExperts')}</span>;
  } else if (conflict === null && expertIssue === 'needAsk') {
    noticeNode = (
      <>
        <span role="alert">{t('chat.experts.needAsk')}</span>
        <Button variant="ghost" onClick={() => setMode('ask')}>
          {t('chat.experts.switchToAsk')}
        </Button>
      </>
    );
  } else if (conflict === 'ask') {
    noticeNode = (
      <>
        <span>{t('chat.hints.askSkill')}</span>
        <Button
          variant="ghost"
          onClick={() => setMode(skill?.modes.includes('craft') ? 'craft' : 'plan')}
        >
          {skill?.modes.includes('craft')
            ? t('chat.hints.switchToCraft')
            : t('chat.hints.switchToPlan')}
        </Button>
      </>
    );
  } else if (conflict === 'planOnly' && skill) {
    noticeNode = (
      <>
        <span>{t('chat.hints.planOnly', { name: skillName(skill.id) })}</span>
        <Button variant="ghost" onClick={() => setMode('plan')}>
          {t('chat.hints.switchToPlan')}
        </Button>
      </>
    );
  } else if (notice?.kind === 'otherClient') {
    const other = notice.client;
    noticeNode = (
      <>
        <span role="alert">{t('chat.hints.otherClient')}</span>
        {onNewTask && (
          <Button
            variant="ghost"
            onClick={() => {
              carryRef.current = { text, mode, skill, client: other };
              setNotice(null);
              onNewTask();
            }}
          >
            {t('chat.hints.newTaskForClient', { name: other.displayName })}
          </Button>
        )}
      </>
    );
  } else if (notice?.kind === 'duplicate') {
    const { status, uploadId, date } = notice;
    noticeNode =
      status === 'verified' ? (
        <span role="status">{t('chat.duplicateVerified', { date })}</span>
      ) : (
        <>
          <span role="alert">
            {status === 'failed' ? t('chat.duplicateFailed') : t('chat.duplicatePending')}
          </span>
          {onReviewUpload && (
            <Button variant="ghost" onClick={() => onReviewUpload(uploadId)}>
              {t('chat.openReview')}
            </Button>
          )}
        </>
      );
  } else if (notice) {
    noticeNode = (
      <span role="alert">
        {notice.kind === 'needClient'
          ? t('chat.hints.needClient')
          : notice.kind === 'uploadNeedClient'
            ? t('chat.hints.uploadNeedClient')
            : notice.kind === 'uploadError'
              ? t(`reports.errors.${notice.key}`)
              : t(`chat.errors.${notice.key}`)}
      </span>
    );
  } else if (queued) {
    noticeNode = (
      <>
        <span role="status">{t('chat.queued')}</span>
        <Button
          variant="ghost"
          onClick={() => {
            const draft = queuedRef.current;
            queuedRef.current = null;
            setQueued(null);
            if (draft) restoreComposer(draft);
          }}
        >
          {t('chat.cancelQueued')}
        </Button>
      </>
    );
  }

  // 选了用报告的技能、还没引用报告：列出这位客户已核对的报告供选择（验收反馈 6）。
  // /面谈提纲 报告可选：不选也能直接发送，提示里写明
  const verifiedReports = reportOptions
    .filter((r) => !r.pending)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, REPORT_PICKER_MAX);
  if (
    noticeNode === null &&
    skill?.usesReport &&
    skill.planSkills.length === 0 &&
    !report &&
    !readOnly &&
    verifiedReports.length > 0
  ) {
    noticeNode = (
      <div className={styles.picker} role="group" aria-label={t('chat.reportPicker')}>
        <span>{t('chat.reportPicker')}</span>
        {verifiedReports.map((r) => (
          <Button
            key={r.id}
            variant="secondary"
            icon={<FileText size={14} />}
            onClick={() => setReport(r)}
          >
            {t('chat.reportOption', { date: r.date })}
            {r.critical && (
              <>
                {' '}
                <span className={reportStyles.criticalMark}>{t('record.reports.critical')}</span>
              </>
            )}
          </Button>
        ))}
        <span className={styles.pickerHint}>
          {t(skill.requiresReport ? 'chat.reportPickerHint' : 'chat.reportPickerOptionalHint')}
        </span>
      </div>
    );
  }

  // @ 列表里的专家：不列绑定的专家本身；一条消息连同绑定的专家最多 3 位（Q5）
  const mentionable = experts.filter((e) => e.available && e.id !== boundExpertId);
  const maxExperts = EXPERTS_PER_CALL_MAX - (boundExpertId ? 1 : 0);
  const changeExpertRefs = (ids: string[]) => {
    setExpertRefs(ids);
    setExcludedExperts((list) => list.filter((id) => !ids.includes(id)));
  };
  // 运行会自动请专家的技能（/体检解读）时，输入框上方显示专家选择条（规格 2.5）
  const expertBar =
    skill?.experts === 'auto' && conflict === null && mentionable.length > 0 && !readOnly ? (
      <ExpertSelector
        experts={mentionable}
        included={expertRefs}
        excluded={excludedExperts}
        maxIncluded={maxExperts}
        disabled={loadState !== 'idle'}
        onChange={(inc, exc) => {
          setExpertRefs(inc);
          setExcludedExperts(exc);
        }}
      />
    ) : null;

  // “请专家看看”：输入框上方说明这次按哪些孪生项请专家，可以取消（M4 规格 2.6 之二）
  const twinConsultBar =
    twinConsult && twinRefs.length > 0 && !readOnly ? (
      <>
        <span role="status">
          {t('chat.twin.consultBar', {
            items: twinRefs.map(twinRefLabel).join(t('chat.twin.separator')),
          })}
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            setTwinConsult(false);
            setFollowUpItemId(null);
          }}
        >
          {t('chat.twin.cancelConsult')}
        </Button>
      </>
    ) : null;

  // @ 列表里的孪生项：当前客户的四个方面和有预测的指标
  const twinItems: TwinItemOption[] =
    reportClientId === null
      ? []
      : [
          ...TWIN_DOMAINS.map((code) => ({ kind: 'domain' as const, code })),
          ...twinMetrics.map((code) => ({ kind: 'metric' as const, code })),
        ].map((ref) => ({ ref, label: twinRefLabel(ref) }));
  const changeTwinRefs = (refs: TwinRef[]) => {
    const unique = refs.filter(
      (r, i) => refs.findIndex((x) => twinRefKey(x) === twinRefKey(r)) === i,
    );
    setTwinRefs(unique.slice(0, TWIN_REFS_MAX));
    if (unique.length === 0) {
      setTwinConsult(false);
      setFollowUpItemId(null);
    }
  };

  const boundBar = boundExpertId ? (
    <div className={expertStyles.boundBar} role="note" aria-label={t('experts.bound.label')}>
      <ExpertAvatar name={expertName(boundExpertId)} />
      <div className={expertStyles.boundText}>
        <span className={expertStyles.boundName}>
          {expertName(boundExpertId)}
          <AiBadge />
        </span>
        <span>{t('experts.bound.askOnly')}</span>
        <span className={expertStyles.forwardNote}>{t('experts.bound.note')}</span>
      </div>
    </div>
  ) : null;

  const composer = (
    <Composer
      inputRef={inputRef}
      text={text}
      onTextChange={setText}
      mode={mode}
      onModeChange={setMode}
      skill={skill}
      onSkillChange={onSkillChange}
      client={client}
      onClientChange={onClientChange}
      // 专家中心的任务不能用技能（Q9）
      skills={boundExpertId ? EMPTY : skills}
      clients={clients}
      disabled={readOnly || loadState !== 'idle'}
      generating={generating}
      onSubmit={() =>
        void submit({
          text,
          mode,
          skill,
          client,
          report,
          expertRefs,
          excludedExperts,
          twinRefs,
          twinConsult,
          followUpItemId,
        })
      }
      canSendEmpty={canSendEmpty({ text, mode, skill, client, report, twinRefs, twinConsult })}
      onStop={onStop}
      notice={noticeNode}
      reports={reportOptions}
      report={report}
      onReportChange={setReport}
      onAttachFiles={(files) => void onAttachFiles(files)}
      experts={mentionable}
      expertRefs={expertRefs}
      {...(mentionable.length > 0 && !readOnly ? { onExpertRefsChange: changeExpertRefs } : {})}
      maxExperts={maxExperts}
      {...(boundExpertId ? { lockedMode: 'ask' as const } : {})}
      expertBar={expertBar ?? twinConsultBar}
      twinItems={boundExpertId ? EMPTY : twinItems}
      twinRefs={twinRefs}
      {...(!readOnly && !boundExpertId ? { onTwinRefsChange: changeTwinRefs } : {})}
    />
  );

  const hasMessages = conversation.messages.length > 0 || uploads.length > 0;
  const headerTitle =
    task?.title ||
    (pendingExpert ? t('experts.askTaskTitle', { name: pendingExpert.name }) : t('chat.untitled'));
  const reportDates = new Map(reportOptions.map((r) => [r.id, r.date]));

  return (
    <main className={styles.pane}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        <h1 className={styles.title} title={headerTitle}>
          {headerTitle}
        </h1>
        <IconButton
          label={resultsOpen ? t('results.close') : t('results.open')}
          icon={resultsOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          aria-expanded={resultsOpen}
          aria-controls="hb-results"
          onClick={onToggleResults}
        />
      </header>

      {loadState === 'loading' && (
        <div className={styles.body}>
          <p className={styles.hint} role="status">
            {t('chat.loading')}
          </p>
        </div>
      )}
      {loadState === 'error' && (
        <div className={styles.body}>
          <p className={styles.hint} role="alert">
            {t('chat.loadFailed')}
          </p>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('chat.retry')}</Button>
        </div>
      )}
      {loadState === 'idle' &&
        (hasMessages ? (
          <>
            <div className={styles.thread}>
              <div className={styles.column}>
                {boundBar}
                <MessageList
                  conversation={conversation}
                  clients={clients}
                  reportDates={reportDates}
                  canConfirm={!readOnly && !generating}
                  onConfirmPlan={onConfirmPlan}
                  onUseSkill={onUseSkill}
                  {...(onOpenExperts ? { onOpenExperts } : {})}
                  {...(!readOnly && !generating ? { onAskExpert } : {})}
                />
                {uploads.length > 0 && (
                  <ul className={reportStyles.chatUploads} aria-label={t('chat.uploads')}>
                    {uploads.map((u) => (
                      <li key={`${u.id}-${u.attempts}`}>
                        <UploadCard
                          upload={u}
                          readOnly={readOnly}
                          inChat
                          {...(interpretIntent.has(u.id) && u.status !== 'verified'
                            ? { note: t('chat.autoInterpret') }
                            : {})}
                          onChanged={onUploadChanged}
                          {...(onReviewUpload ? { onReview: onReviewUpload } : {})}
                          {...(interpretSkill && !readOnly && !generating
                            ? { onInterpret: () => onInterpret(u) }
                            : {})}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <div ref={bottomRef} />
              </div>
            </div>
            <div className={styles.dock}>
              <div className={styles.column}>{composer}</div>
            </div>
          </>
        ) : (
          <div className={styles.body}>
            <div className={styles.welcome}>
              {boundExpertId ? (
                <>
                  <p className={styles.greeting}>
                    {t('experts.bound.greeting', { name: expertName(boundExpertId) })}
                  </p>
                  <p className={styles.subtitle}>{t('experts.bound.subtitle')}</p>
                  {boundBar}
                </>
              ) : (
                <>
                  <p className={styles.greeting}>{t('chat.greeting')}</p>
                  <p className={styles.subtitle}>{t('chat.subtitle')}</p>
                </>
              )}
              {composer}
            </div>
          </div>
        ))}
    </main>
  );
}
