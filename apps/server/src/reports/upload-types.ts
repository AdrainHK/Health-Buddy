import type { InspectedFile } from './file-inspect.js';

/** 通过检查、准备保存的一个上传文件 */
export interface InspectedFileUpload {
  buffer: Buffer;
  inspected: InspectedFile;
  /** 原文件名，只存数据库用于显示，不进日志和存储路径 */
  originalName: string;
}
