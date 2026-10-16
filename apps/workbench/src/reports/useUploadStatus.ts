import type { ReportUploadSummary } from '@health-buddy/shared';
import { useEffect, useState } from 'react';
import { isAbortError } from '../api/http';
import { isActive, watchUpload } from '../api/reports';

/** 断线后多久重新订阅 */
const RECONNECT_MS = 3000;

/**
 * 识别记录的最新状态：排队中、识别中时订阅进度（SSE），结束后停止。
 * 连接断开时稍后重新订阅；组件卸载或换记录时取消。
 */
export function useUploadStatus(initial: ReportUploadSummary): ReportUploadSummary {
  const [upload, setUpload] = useState(initial);

  // 外面传进来的更新（如重新识别后的状态）优先
  useEffect(() => {
    setUpload((current) =>
      current.id !== initial.id ||
      current.attempts !== initial.attempts ||
      current.status !== initial.status
        ? initial
        : current,
    );
  }, [initial]);

  const active = isActive(upload.status);
  const id = upload.id;
  const attempts = upload.attempts;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      watchUpload(
        id,
        (event) => event.type !== 'error' && setUpload(event.upload),
        controller.signal,
      )
        .then(() => {
          // 服务端到时间后关闭连接，还没结束就重新订阅
          if (!controller.signal.aborted) timer = setTimeout(connect, RECONNECT_MS);
        })
        .catch((err: unknown) => {
          if (isAbortError(err) || controller.signal.aborted) return;
          timer = setTimeout(connect, RECONNECT_MS);
        });
    };
    connect();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, active, attempts]);

  return upload;
}
