import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ChatSample, ChatSampleLine } from '@health-buddy/skills';
import {
  SAMPLE_FONT_FAMILY as FAMILY,
  SampleFontMissingError,
  findFont,
} from './report-samples.js';

/**
 * 合成聊天截图（M5 规格 2.9“聊天截图”的评测）：把用例里的聊天描述渲染成手机截图（PNG），
 * 仿微信的样式：右侧绿色气泡是健管师本人，左侧白色气泡是对方，群聊里左侧气泡上方有昵称。
 * 昵称、电话都是合成的，用来检查转写结果里不出现。
 */

const W = 750;
const H = 1334;
const BUBBLE_MAX = 440;
const FONT = 30;
const LINE = 42;

/** 按宽度逐字折行（中文没有空格） */
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > width) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawChrome(ctx: SKRSContext2D, title: string) {
  ctx.fillStyle = '#ededed';
  ctx.fillRect(0, 0, W, H);
  // 状态栏
  ctx.fillStyle = '#111';
  ctx.font = `bold 26px ${FAMILY}`;
  ctx.textAlign = 'left';
  ctx.fillText('9:41', 40, 34);
  ctx.textAlign = 'right';
  ctx.fillText('5G  86%', W - 40, 34);
  // 标题栏
  ctx.textAlign = 'center';
  ctx.font = `bold 32px ${FAMILY}`;
  ctx.fillText(title, W / 2, 96);
  ctx.textAlign = 'left';
  ctx.fillText('<', 24, 98);
  ctx.textAlign = 'right';
  ctx.fillText('···', W - 24, 96);
  ctx.fillStyle = '#d6d6d6';
  ctx.fillRect(0, 128, W, 1);
  // 输入框
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0, H - 110, W, 110);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 90, H - 92, W - 260, 70, 10);
}

function drawLine(ctx: SKRSContext2D, line: ChatSampleLine, y: number): number {
  ctx.textAlign = 'left';
  if (line.side === 'time' || line.side === 'notice') {
    ctx.font = `24px ${FAMILY}`;
    ctx.fillStyle = '#9a9a9a';
    ctx.textAlign = 'center';
    ctx.fillText(line.text, W / 2, y + 28);
    return y + 64;
  }
  const right = line.side === 'right';
  const avatarX = right ? W - 24 - 76 : 24;
  ctx.fillStyle = right ? '#5b8def' : '#c9a27a';
  roundRect(ctx, avatarX, y, 76, 76, 8);
  let top = y;
  if (!right && line.nickname) {
    ctx.font = `22px ${FAMILY}`;
    ctx.fillStyle = '#8a8a8a';
    ctx.fillText(line.nickname, 120, y + 22);
    top += 32;
  }
  ctx.font = `${FONT}px ${FAMILY}`;
  if (line.media === 'image') {
    const x = right ? W - 120 - 240 : 120;
    ctx.fillStyle = '#b8c4cc';
    roundRect(ctx, x, top, 240, 180, 8);
    ctx.fillStyle = '#7d8f99';
    ctx.beginPath();
    ctx.moveTo(x + 40, top + 150);
    ctx.lineTo(x + 110, top + 70);
    ctx.lineTo(x + 170, top + 130);
    ctx.lineTo(x + 200, top + 100);
    ctx.lineTo(x + 230, top + 150);
    ctx.closePath();
    ctx.fill();
    return top + 180 + 36;
  }
  if (line.media === 'sticker') {
    const x = right ? W - 120 - 150 : 120;
    ctx.fillStyle = '#ffcf33';
    ctx.beginPath();
    ctx.arc(x + 75, top + 75, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a3d00';
    ctx.font = `bold 44px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('^_^', x + 75, top + 92);
    return top + 150 + 36;
  }
  const text = line.media === 'voice' ? '((( 6″' : line.text;
  const lines = wrap(ctx, text, BUBBLE_MAX - 44);
  const width =
    line.media === 'voice' ? 200 : Math.max(...lines.map((l) => ctx.measureText(l).width)) + 44;
  const height = lines.length * LINE + 30;
  const x = right ? W - 120 - width : 120;
  ctx.fillStyle = right ? '#95ec69' : '#ffffff';
  roundRect(ctx, x, top, width, height, 10);
  ctx.fillStyle = '#111';
  lines.forEach((l, i) => ctx.fillText(l, x + 22, top + 46 + i * LINE));
  return top + Math.max(height, 76) + 36;
}

/** 渲染一个聊天样本：每张截图一张 PNG */
export function renderChatSample(sample: ChatSample): Buffer[] {
  if (!findFont()) throw new SampleFontMissingError();
  if (sample.kind === 'not_a_chat') {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1d1d1d';
    ctx.font = `30px ${FAMILY}`;
    (sample.freeText ?? '').split('\n').forEach((l, i) => ctx.fillText(l, 60, 140 + i * 64));
    return [canvas.toBuffer('image/png')];
  }
  return sample.screens.map((screen) => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    drawChrome(ctx, sample.title);
    let y = 160;
    for (const line of screen) y = drawLine(ctx, line, y);
    return canvas.toBuffer('image/png');
  });
}
