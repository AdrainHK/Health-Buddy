import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ExtractionContentPart } from '../report-extraction/index.js';

/**
 * 聊天截图转写（M5 规格 2.9“聊天截图”，Q21 改为 B）。不是技能，不在 / 列表里：
 * 后端在上传随访素材前调用一次，把截图转写成文字，健管师核对后再保存为素材。
 * 原图不保存；输出结构里没有昵称、头像等字段。提示词放在 prompt.md，便于合规审查。
 */
export const CHAT_TRANSCRIPTION_PROMPT = readFileSync(
  new URL('./prompt.md', import.meta.url),
  'utf8',
).trim();

export const CHAT_TRANSCRIPTION_CATEGORIES = ['chat', 'not_a_chat', 'unreadable'] as const;
export const CHAT_SPEAKERS = ['manager', 'client', 'other', 'system'] as const;
export type ChatSpeaker = (typeof CHAT_SPEAKERS)[number];

export const chatTranscriptionOutputSchema = z.object({
  category: z.enum(CHAT_TRANSCRIPTION_CATEGORIES),
  messages: z.array(z.object({ speaker: z.enum(CHAT_SPEAKERS), text: z.string() })),
});
export type ChatTranscriptionOutput = z.output<typeof chatTranscriptionOutputSchema>;

/** 结构化输出的名称（OpenAI 要求只含字母、数字、下划线） */
export const CHAT_TRANSCRIPTION_FORMAT_NAME = 'chat_transcription';

/** 一张截图（PNG 或 JPEG；HEIC 由后端先转成 JPEG） */
export interface ChatScreenshotInput {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
}

/** 组装用户消息：只有张数和截图本身，不带客户姓名或任何档案资料 */
export function buildChatTranscriptionContent(
  images: readonly ChatScreenshotInput[],
): ExtractionContentPart[] {
  return [
    {
      type: 'text',
      text: `下面是同一段聊天的 ${images.length} 张截图，按顺序排列。请按规则转写。`,
    },
    ...images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.base64 })),
  ];
}

const SPEAKER_ZH: Record<ChatSpeaker, string> = {
  manager: '健管师',
  client: '客户',
  other: '其他人',
  system: '',
};

/** 转写结果渲染成素材文字：一条一行，“健管师：……”“客户：……”；时间分隔单独一行，用【】括起来 */
export function renderChatTranscript(output: ChatTranscriptionOutput): string {
  return output.messages
    .map((m) => ({ ...m, text: m.text.trim() }))
    .filter((m) => m.text)
    .map((m) => (m.speaker === 'system' ? `【${m.text}】` : `${SPEAKER_ZH[m.speaker]}：${m.text}`))
    .join('\n');
}
