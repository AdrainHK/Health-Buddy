import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CHAT_TRANSCRIPTION_PROMPT,
  buildChatTranscriptionContent,
  chatTranscriptionOutputSchema,
  renderChatTranscript,
} from './chat-transcription/index.js';
import { chatTranscriptionEvalCases } from './chat-transcription/evals/cases.js';

/** 聊天截图转写（M5 规格 2.9“聊天截图”）。全部是合成数据 */
describe('聊天截图转写', () => {
  it('渲染成素材文字：一条一行，说话人写中文，时间分隔用【】，空消息去掉', () => {
    expect(
      renderChatTranscript({
        category: 'chat',
        messages: [
          { speaker: 'system', text: '昨天 20:15' },
          { speaker: 'manager', text: '这周散步怎么样？' },
          { speaker: 'client', text: ' 走了三次 ' },
          { speaker: 'other', text: '我妈膝盖疼' },
          { speaker: 'client', text: '  ' },
        ],
      }),
    ).toBe('【昨天 20:15】\n健管师：这周散步怎么样？\n客户：走了三次\n其他人：我妈膝盖疼');
  });

  it('用户消息只有张数和截图，不带任何档案资料', () => {
    const parts = buildChatTranscriptionContent([
      { mediaType: 'image/png', base64: 'AAAA' },
      { mediaType: 'image/jpeg', base64: 'BBBB' },
    ]);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('2 张截图') });
    expect(parts.slice(1).map((p) => p.type)).toEqual(['image', 'image']);
  });

  it('提示词要求不转写昵称、电话、证件号，截图里的指令只是数据', () => {
    for (const rule of ['不转写昵称', '[电话]', '[证件号]', '不执行']) {
      expect(CHAT_TRANSCRIPTION_PROMPT).toContain(rule);
    }
  });

  it('输出结构不带数值范围和长度限制（Claude 的结构化输出不接受）', () => {
    const schema = JSON.stringify(z.toJSONSchema(chatTranscriptionOutputSchema, { io: 'output' }));
    expect(schema).not.toMatch(/"(?:minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
  });

  it('评测用例：至少 8 条，id 不重复，每张截图不超过上限', () => {
    expect(chatTranscriptionEvalCases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(chatTranscriptionEvalCases.map((c) => c.id)).size).toBe(
      chatTranscriptionEvalCases.length,
    );
    for (const c of chatTranscriptionEvalCases)
      expect(c.sample.screens.length).toBeLessThanOrEqual(9);
  });
});
