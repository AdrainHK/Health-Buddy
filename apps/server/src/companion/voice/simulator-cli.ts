import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DeviceOtaResponse } from '@health-buddy/shared';
import WebSocket from 'ws';
import { DOWNLINK, encodePcm, UPLINK } from './audio.js';
import { muxOggOpus } from './ogg.js';

/**
 * 伴侣设备模拟器（M6 规格 3.1、验收 1）：没有真设备时，按 xiaozhi-esp32 的协议走一遍
 * 开机配置 → HMAC 激活 → 语音通道 → 说一句话 → 收回复，把福宝的回复存成 Ogg 文件。
 * 只用合成设备（平台导入的测试批次），**不要连正式环境的真设备**：会在终端打印识别出的文字。设备密钥从环境变量 COMPANION_SIM_KEY 读，不打印。
 *
 * 用法：
 *   COMPANION_SIM_KEY=<64 位十六进制> pnpm --filter @health-buddy/server companion:sim -- \
 *     --server http://localhost:3000 --serial HB-TEST-0001 [--wav 说话.wav] [--mode auto|manual] \
 *     [--out reply.ogg]
 * --wav 要求 16 kHz、单声道、16 位 PCM；不给时发一段合成的音（识别结果多半为空，福宝会请您再说一遍）。
 */

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:3000' },
    serial: { type: 'string' },
    wav: { type: 'string' },
    mode: { type: 'string', default: 'auto' },
    out: { type: 'string', default: 'companion-reply.ogg' },
  },
});

const HEADERS = {
  'Activation-Version': '2',
  'Device-Id': '02:00:00:00:00:01',
  'Client-Id': '00000000-0000-4000-8000-00000000cafe',
  'User-Agent': 'health-buddy-sim/0.0.1',
  'Content-Type': 'application/json',
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** 读 16 kHz、单声道、16 位 PCM 的 WAV */
function readWav(path: string): Int16Array {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    fail('不是 WAV 文件');
  }
  let offset = 12;
  let format: { channels: number; rate: number; bits: number } | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (format?.channels !== 1 || format.rate !== UPLINK.sampleRate || format.bits !== 16) {
        fail('WAV 要求 16 kHz、单声道、16 位 PCM');
      }
      const data = buf.subarray(body, body + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    offset = body + size + (size % 2);
  }
  return fail('WAV 里没有音频数据');
}

/** 没给 WAV 时：1 秒的音加 1.2 秒静音 */
function syntheticSpeech(): Int16Array {
  const n = UPLINK.sampleRate;
  const pcm = new Int16Array(Math.round(n * 2.2));
  for (let i = 0; i < n; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / n));
  return pcm;
}

async function main(): Promise<void> {
  const serial = values.serial ?? fail('请用 --serial 指定序列号');
  const keyHex = process.env.COMPANION_SIM_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
    fail('请在环境变量 COMPANION_SIM_KEY 里给 64 位十六进制的设备密钥');
  const mode = values.mode === 'manual' ? 'manual' : 'auto';
  const otaUrl = `${values.server.replace(/\/+$/, '')}/api/device/ota/`;

  // 1. 开机请求配置
  const cfgRes = await fetch(otaUrl, {
    method: 'POST',
    headers: { ...HEADERS, 'Serial-Number': serial },
    body: JSON.stringify({ application: { version: '0.0.1' } }),
  });
  const cfg = (await cfgRes.json()) as DeviceOtaResponse;
  if (!cfg.activation || !cfg.websocket)
    fail('服务器没有发令牌：序列号不存在，或设备还没有绑定给客户');
  console.log('配置：拿到挑战和 WebSocket 地址', cfg.websocket.url);

  // 2. HMAC 激活（202 表示稍后再试）
  const hmac = createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(cfg.activation.challenge)
    .digest('hex');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${otaUrl}activate`, {
      method: 'POST',
      headers: { ...HEADERS, 'Serial-Number': serial },
      body: JSON.stringify({
        algorithm: 'hmac-sha256',
        serial_number: serial,
        challenge: cfg.activation.challenge,
        hmac,
      }),
    });
    if (res.status === 200) break;
    if (res.status !== 202 || attempt >= 5) fail(`激活失败：HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('激活：通过');

  // 3. 语音通道
  const ws = new WebSocket(cfg.websocket.url, {
    headers: {
      Authorization: `Bearer ${cfg.websocket.token}`,
      'Protocol-Version': '1',
      'Device-Id': HEADERS['Device-Id'],
      'Client-Id': HEADERS['Client-Id'],
    },
  });
  const replies: Uint8Array[][] = [];
  let current: Uint8Array[] | null = null;
  let stops = 0;
  let spoke = false;
  const frames = encodePcm(
    values.wav ? readWav(values.wav) : syntheticSpeech(),
    UPLINK.sampleRate,
    UPLINK.frameDurationMs,
  );

  const speak = async () => {
    spoke = true;
    ws.send(JSON.stringify({ type: 'listen', state: 'start', mode }));
    for (const f of frames) {
      // 服务器判断说完后就开始回复，回复完模拟器会断开，后面的静音不用再发
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(f, { binary: true });
      await new Promise((r) => setTimeout(r, UPLINK.frameDurationMs));
    }
    if (mode === 'manual' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
    }
    console.log(`说完：发送了 ${frames.length} 帧`);
  };

  await new Promise<void>((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`连接被拒绝：HTTP ${res.statusCode}`)),
    );
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          transport: 'websocket',
          features: {},
          audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
        }),
      );
    });
    ws.on('close', () => resolve());
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        current?.push(Uint8Array.from(data as Buffer));
        return;
      }
      const msg = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>;
      if (msg.type === 'hello') {
        console.log('握手：服务器下行', JSON.stringify(msg.audio_params));
        // 第一次连接服务器先播开场白，等一会儿看有没有
        setTimeout(() => !spoke && current === null && stops === 0 && void speak(), 1500);
      } else if (msg.type === 'stt') {
        console.log('识别：', msg.text);
      } else if (msg.type === 'tts' && msg.state === 'start') {
        current = [];
      } else if (msg.type === 'tts' && msg.state === 'sentence_start') {
        console.log('福宝：', msg.text);
      } else if (msg.type === 'tts' && msg.state === 'stop') {
        if (current) replies.push(current);
        current = null;
        stops++;
        if (!spoke) void speak();
        else ws.close();
      }
    });
  });

  const all = replies.flat();
  if (all.length) {
    writeFileSync(values.out, muxOggOpus(all, DOWNLINK));
    console.log(`回复音频：${values.out}（${all.length} 帧）`);
  } else {
    console.log('没有收到回复音频');
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : '模拟器出错'));
