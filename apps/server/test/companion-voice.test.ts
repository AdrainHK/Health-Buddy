import { MockProvider, type MockScript } from '@health-buddy/ai-engine';
import { COMPANION_DEFAULT_SCRIPTS } from '@health-buddy/shared';
import { Logger, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DOWNLINK, encodePcm, UPLINK } from '../src/companion/voice/audio.js';
import { DeviceAuthService } from '../src/companion/device-auth.service.js';
import { BindAttemptLimiter } from '../src/companion/device-credentials.js';
import { CompanionDialogue } from '../src/companion/voice/dialogue.service.js';
import { demuxOggOpus, muxOggOpus } from '../src/companion/voice/ogg.js';
import { DB } from '../src/db/db.provider.js';
import { withDevice, withTenant, type Db } from '../src/db/database.js';
import { localDate } from '../src/twin/time-zone.js';
import { ownerDb, PASSWORD, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { TWIN_QUEUE, type InProcessTwinQueue } from '../src/twin/twin-queue.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

const TODAY = localDate(new Date(), 'Asia/Shanghai');
const SERIAL_A = 'HB-VOICE-0001';
const SERIAL_B = 'HB-VOICE-0002';
const SERIAL_STOCK = 'HB-VOICE-0003';

/** 合成的音频：一段 440 Hz 的音（当作“说话”）和静音 */
function tone(ms: number, rate: number, amplitude = 8000): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++)
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / rate));
  return pcm;
}
const SPEECH_FRAMES = encodePcm(tone(600, UPLINK.sampleRate), UPLINK.sampleRate, 60);
const SILENCE_FRAMES = encodePcm(new Int16Array(16000), UPLINK.sampleRate, 60);
/** 模拟语音合成：返回 0.5 秒的 Ogg Opus（厂商帧长 20 ms，服务器要转成 60 ms） */
const TTS_OGG = muxOggOpus(encodePcm(tone(500, 24000, 3000), 24000, 20), {
  sampleRate: 24000,
  frameDurationMs: 20,
});

/** 每个用例结束时关掉还开着的连接，等会话结束整理写完，再进下一个用例（避免和重置数据并发） */
const OPEN_DEVICES = new Set<FakeDevice>();

type Received = { text: Record<string, unknown> } | { binary: Buffer };

/** 设备模拟：连上 /ws/device，收到的消息按顺序排队 */
class FakeDevice {
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];
  closed = false;

  constructor(readonly ws: WebSocket) {
    OPEN_DEVICES.add(this);
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      this.received.push(
        isBinary
          ? { binary: buf }
          : { text: JSON.parse(buf.toString('utf8')) as Record<string, unknown> },
      );
      this.wake();
    });
    ws.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** 等到满足条件为止（超时报错） */
  async until(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${label}: ${JSON.stringify(this.texts().map((t) => [t.type, t.state]))}`,
        );
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  texts(): Record<string, unknown>[] {
    return this.received.flatMap((m) => ('text' in m ? [m.text] : []));
  }

  /** 等到第 n 次 tts stop，返回这句话之间收到的消息 */
  async utterance(n: number): Promise<{ texts: Record<string, unknown>[]; frames: Buffer[] }> {
    const stops = () => this.texts().filter((t) => t.type === 'tts' && t.state === 'stop').length;
    await this.until(() => stops() >= n, `tts stop #${n}`);
    const out: { texts: Record<string, unknown>[]; frames: Buffer[] } = { texts: [], frames: [] };
    let seen = 0;
    for (const m of this.received) {
      if ('binary' in m) {
        if (seen === n - 1) out.frames.push(m.binary);
        continue;
      }
      if (seen === n - 1 && m.text.type !== 'hello') out.texts.push(m.text);
      if (m.text.type === 'tts' && m.text.state === 'stop') seen++;
      if (seen >= n) break;
    }
    return out;
  }

  send(message: Record<string, unknown>) {
    this.ws.send(JSON.stringify(message));
  }

  speak(frames: Uint8Array[]) {
    for (const f of frames) this.ws.send(f, { binary: true });
  }
}

describe('伴侣语音通道（M6 第 3 步）', () => {
  const owner = ownerDb();
  /** 模拟模型：福宝的回答和后台整理（结构化输出），按请求的格式名给出 */
  const llm: MockScript = {};
  const mock = new MockProvider('openai', llm);
  const REPLY = '记下了，我会告诉您的健管师。';
  let modelReply: Record<string, unknown>;
  let memoryOutput: { memories: string[]; summary: string; observations: unknown[] };
  let app: INestApplication;
  let port: number;
  let f: Fixtures;
  let platform: Agent;
  let a1: Agent;
  let b1: Agent;
  const keys = { a: randomBytes(32), b: randomBytes(32), stock: randomBytes(32) };
  let transcript = '我今天走了五千步';

  const appDb = () => app.get<Db>(DB);
  const otaUrl = () => `http://127.0.0.1:${port}/api/device/ota/`;

  async function ota(serial: string | undefined, method: 'GET' | 'POST' = 'POST') {
    const res = await fetch(otaUrl(), {
      method,
      headers: {
        'Activation-Version': '2',
        'Device-Id': 'aa:bb:cc:dd:ee:ff',
        'Client-Id': '00000000-0000-4000-8000-000000000001',
        'User-Agent': 'fubao-board/1.2.3',
        'Content-Type': 'application/json',
        ...(serial ? { 'Serial-Number': serial } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify({ application: { version: '1.2.3' } }) } : {}),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      server_time: { timestamp: number };
      activation?: { challenge: string };
      websocket?: { url: string; token: string };
    };
  }

  async function activate(serial: string, challenge: string, key: Buffer) {
    const res = await fetch(`${otaUrl()}activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'fubao-board/1.2.3' },
      body: JSON.stringify({
        algorithm: 'hmac-sha256',
        serial_number: serial,
        challenge,
        hmac: createHmac('sha256', key).update(challenge).digest('hex'),
      }),
    });
    return res.status;
  }

  /** 走一遍开机：配置接口 → HMAC 激活，返回令牌 */
  async function boot(serial: string, key: Buffer): Promise<string> {
    const cfg = await ota(serial);
    expect(cfg.activation?.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(await activate(serial, cfg.activation!.challenge, key)).toBe(200);
    return cfg.websocket!.token;
  }

  function connect(
    token: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<FakeDevice | number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Protocol-Version': '1',
          'Device-Id': 'aa:bb:cc:dd:ee:ff',
          'Client-Id': '00000000-0000-4000-8000-000000000001',
          ...headers,
        },
      });
      const device = new FakeDevice(ws);
      ws.on('open', () => resolve(device));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
    });
  }

  async function open(token: string): Promise<FakeDevice> {
    const device = await connect(token);
    if (typeof device === 'number') throw new Error(`connect failed: ${device}`);
    device.send({
      type: 'hello',
      version: 1,
      transport: 'websocket',
      features: { mcp: true },
      audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
    });
    await device.until(() => device.texts().some((t) => t.type === 'hello'), 'server hello');
    return device;
  }

  const consentAndBind = async (agent: Agent, clientId: string, serial: string, code: string) => {
    const base = `/api/clients/${clientId}/companion`;
    await agent
      .post(`${base}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await agent.post(`${base}/device`).send({ serialNo: serial, activationCode: code }).expect(200);
  };

  beforeAll(async () => {
    app = await createTestApp(
      { companionVoiceEnabled: true },
      {
        llmProviders: { openai: mock },
        voice: {
          frameIntervalMs: 0,
          helloTimeoutMs: 500,
          endpoint: { speechRms: 500, silenceMs: 360, maxMs: 30_000, noSpeechMs: 1_200 },
        },
      },
    );
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const d of OPEN_DEVICES) {
      if (!d.closed) d.ws.close();
      await d.until(() => d.closed, 'close');
    }
    OPEN_DEVICES.clear();
    // 服务端处理断开是异步的：等语音会话都结束，再等结束整理写完
    await new Promise((r) => setTimeout(r, 50));
    await app.get(CompanionDialogue).settled();
  });
  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });
  beforeEach(async () => {
    // 配置接口按序列号限次（每 15 分钟 30 次），每个用例都重新开机：用例之间清掉计数
    Reflect.set(
      app.get(DeviceAuthService),
      'configCalls',
      new BindAttemptLimiter({ perUser: 30, windowMs: 15 * 60 * 1000, maxKeys: 10_000 }),
    );
    f = await seedFixtures(owner);
    transcript = '我今天走了五千步';
    mock.speechCalls.length = 0;
    mock.calls.length = 0;
    modelReply = {
      reply: REPLY,
      handoff: null,
      crisisSignal: false,
      emergencySignal: false,
      endSession: false,
    };
    memoryOutput = {
      memories: ['客户的孙子下周放假回家'],
      summary: '聊了孙子放假回家。',
      observations: [],
    };
    llm.respond = (req) =>
      JSON.stringify(req.responseFormat?.name === 'companion_memory' ? memoryOutput : modelReply);
    mock.speech = { transcript: () => transcript, synthesize: () => TTS_OGG };
    platform = await loginAs(app, f.users.platform.email);
    a1 = await loginAs(app, f.users.managerA1.email);
    b1 = await loginAs(app, f.users.managerB1.email);
    await platform
      .post('/api/admin/companion/device-batches')
      .send({
        name: '语音测试批次',
        devices: [
          { serialNo: SERIAL_A, deviceSecret: keys.a.toString('hex'), activationCode: 'VOICE001' },
          { serialNo: SERIAL_B, deviceSecret: keys.b.toString('hex'), activationCode: 'VOICE002' },
          {
            serialNo: SERIAL_STOCK,
            deviceSecret: keys.stock.toString('hex'),
            activationCode: 'VOICE003',
          },
        ],
      })
      .expect(201);
    await platform
      .put('/api/admin/companion/scripts/notice')
      .send({ text: '测试用告知书：福宝不是医生，可以随时撤回同意。' })
      .expect(200);
    await consentAndBind(a1, f.clients.a1[0], SERIAL_A, 'VOICE001');
    await consentAndBind(b1, f.clients.b1, SERIAL_B, 'VOICE002');
  });

  it('Ogg Opus 封装、拆封往返一致；下行统一转成 24 kHz、60 ms 帧', async () => {
    const packets = encodePcm(tone(300, 16000), 16000, 60);
    expect(demuxOggOpus(muxOggOpus(packets, UPLINK)).map((p) => Buffer.from(p))).toEqual(
      packets.map((p) => Buffer.from(p)),
    );
    const { oggToDownlinkFrames } = await import('../src/companion/voice/audio.js');
    // 0.5 秒 = 25 个 20 ms 帧 → 9 个 60 ms 帧（最后一帧补静音）
    expect(oggToDownlinkFrames(TTS_OGG)).toHaveLength(Math.ceil(500 / DOWNLINK.frameDurationMs));
    expect(() => demuxOggOpus(Buffer.from('not an ogg file'))).toThrow('invalid ogg page');
    // 急救电话念成“幺二零”（规格 2.10）
    const { spokenForm } = await import('../src/companion/voice/speech.service.js');
    expect(spokenForm('请马上拨打 120 或让家人送医。')).toBe('请马上拨打 幺二零 或让家人送医。');
    expect(spokenForm('高压 120，低压 80，记下了。')).toBe('高压 120，低压 80，记下了。');
    expect(spokenForm('请马上联系家人，或拨打120。')).toBe('请马上联系家人，或拨打幺二零。');
  });

  it('配置接口：没有序列号、序列号不存在、未绑定都不发令牌；已绑定的设备拿到挑战和令牌', async () => {
    for (const serial of [undefined, 'HB-NOT-EXIST', SERIAL_STOCK, '../bad serial']) {
      const res = await ota(serial);
      expect(res.server_time.timestamp).toBeGreaterThan(0);
      expect(res.activation).toBeUndefined();
      expect(res.websocket).toBeUndefined();
    }
    const get = await ota(SERIAL_A, 'GET');
    expect(get.websocket).toEqual({
      url: `ws://127.0.0.1:${port}/ws/device`,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      version: 1,
    });
    // 令牌只存哈希
    const rows = await owner.selectFrom('companion_device_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.token_hash).toString('utf8')).not.toContain(get.websocket!.token);
  });

  it('HMAC 激活：密钥不对、挑战不对、用别的设备的挑战都 401；令牌激活前不能连语音通道', async () => {
    const cfg = await ota(SERIAL_A);
    const challenge = cfg.activation!.challenge;
    expect(await connect(cfg.websocket!.token)).toBe(401);
    expect(await activate(SERIAL_A, challenge, keys.b)).toBe(401);
    expect(await activate(SERIAL_A, 'f'.repeat(64), keys.a)).toBe(401);
    expect(await activate(SERIAL_B, challenge, keys.b)).toBe(401);
    expect(await activate('HB-NOT-EXIST', challenge, keys.a)).toBe(401);
    const bad = await fetch(`${otaUrl()}activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial_number: SERIAL_A, challenge }),
    });
    expect(bad.status).toBe(400);
    expect(await activate(SERIAL_A, challenge, keys.a)).toBe(200);
    // 同一个挑战不能再用
    expect(await activate(SERIAL_A, challenge, keys.a)).toBe(401);
    const device = await owner
      .selectFrom('companion_devices')
      .select(['status', 'firmware_version', 'activated_at'])
      .where('serial_no', '=', SERIAL_A)
      .executeTakeFirstOrThrow();
    // 激活令牌不等于开通：第一次连上语音通道才算
    expect(device).toEqual({ status: 'bound', firmware_version: '1.2.3', activated_at: null });
  });

  it('第一次连接：开通设备、播开场白；说一句话 → 识别 → 回复固定话术 → 合成 → 播放', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const device = await open(token);
    const hello = device.texts().find((t) => t.type === 'hello');
    expect(hello).toEqual({
      type: 'hello',
      transport: 'websocket',
      session_id: expect.any(String),
      audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 },
    });
    const intro = await device.utterance(1);
    expect(intro.texts.map((t) => t.state)).toEqual(['start', 'sentence_start', 'stop']);
    expect(intro.texts[1]!.text).toBe(COMPANION_DEFAULT_SCRIPTS.intro);
    expect(intro.frames.length).toBe(9);
    const row = await owner
      .selectFrom('companion_devices')
      .select(['status', 'activated_at', 'last_seen_at'])
      .where('serial_no', '=', SERIAL_A)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
    expect(row.activated_at).not.toBeNull();
    expect(row.last_seen_at).not.toBeNull();

    // 自动收音：说话后静音，服务器判断说完
    device.send({ type: 'listen', state: 'detect', text: '你好福宝' });
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    const reply = await device.utterance(2);
    expect(reply.texts[0]).toEqual({
      type: 'stt',
      session_id: hello!.session_id,
      text: '我今天走了五千步',
    });
    // 开场白里已经说过“不是医生”，今天不再念 daily_intro；回答来自模型
    expect(reply.texts[2]).toMatchObject({ type: 'tts', state: 'sentence_start', text: REPLY });
    expect(reply.frames.length).toBeGreaterThan(0);

    // 识别请求：Ogg 文件、中文；合成按客户的语速（默认偏慢）
    const stt = mock.speechCalls.find((c) => c.request.route === 'speech_to_text')!;
    expect(stt.route.model).toBe('gpt-4o-mini-transcribe');
    const sttRequest = stt.request as { audio: Uint8Array; language: string };
    expect(sttRequest.language).toBe('zh');
    expect(demuxOggOpus(sttRequest.audio).length).toBeGreaterThanOrEqual(SPEECH_FRAMES.length);
    // 合成结果在进程内缓存，前面的用例可能已经合成过
    const tts = mock.speechCalls.filter((c) => c.request.route === 'text_to_speech');
    expect(tts.every((c) => (c.request as { speed: number }).speed === 0.85)).toBe(true);

    // 计量记在设备上，没有用户；运营商和平台逐条看不到（Q29）
    const usage = await owner
      .selectFrom('llm_usage')
      .select(['route', 'user_id', 'device_id', 'operator_id'])
      .where('device_id', 'is not', null)
      .execute();
    expect(usage.filter((u) => u.route === 'speech_to_text')).toHaveLength(1);
    expect(usage.filter((u) => u.route === 'companion')).toHaveLength(1);
    expect(usage.every((u) => u.user_id === null && u.operator_id === f.operatorA)).toBe(true);
    for (const ctx of [
      {
        userId: f.users.platform.id,
        role: 'platform_admin' as const,
        operatorId: null,
        orgId: null,
      },
      {
        userId: f.users.operatorAdminA.id,
        role: 'operator_admin' as const,
        operatorId: f.operatorA,
        orgId: null,
      },
    ]) {
      const visible = await withTenant(appDb(), ctx, (trx) =>
        trx.selectFrom('llm_usage').select('id').where('device_id', 'is not', null).execute(),
      );
      expect(visible).toEqual([]);
    }

    // 手动收音：设备发 listen stop；识别结果为空时请客户再说一遍
    transcript = '';
    device.send({ type: 'listen', state: 'start', mode: 'manual' });
    device.speak(SPEECH_FRAMES);
    device.send({ type: 'listen', state: 'stop' });
    const retry = await device.utterance(3);
    expect(retry.texts.find((t) => t.state === 'sentence_start')!.text).toBe(
      COMPANION_DEFAULT_SCRIPTS.asr_retry,
    );
    device.ws.close();
  });

  it('同一句固定话术只合成一次；第二次连接不再播开场白', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const first = await open(token);
    await first.utterance(1);
    first.ws.close();
    await first.until(() => first.closed, 'close');
    const second = await open(token);
    second.send({ type: 'listen', state: 'start', mode: 'auto' });
    second.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    const reply = await second.utterance(1);
    expect(reply.texts.find((t) => t.state === 'sentence_start')!.text).toBe(REPLY);
    second.speak(SILENCE_FRAMES);
    second.send({ type: 'listen', state: 'start', mode: 'auto' });
    second.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    await second.utterance(2);
    // 每句话术最多合成一次（之后用缓存）
    const tts = mock.speechCalls
      .filter((c) => c.request.route === 'text_to_speech')
      .map((c) => (c.request as { text: string }).text)
      .filter((text) => text !== REPLY);
    expect(new Set(tts).size).toBe(tts.length);
    expect(second.texts().filter((t) => t.text === COMPANION_DEFAULT_SCRIPTS.intro)).toEqual([]);
    second.ws.close();
  });

  it('一直没人说话：结束这次会话；没有发 hello 的连接超时断开', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const device = await open(token);
    await device.utterance(1);
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak(SILENCE_FRAMES);
    device.speak(SILENCE_FRAMES);
    await device.until(() => device.closed, 'close on no speech');
    expect(mock.speechCalls.filter((c) => c.request.route === 'speech_to_text')).toHaveLength(0);
    const silent = await connect(token);
    if (typeof silent === 'number') throw new Error('connect failed');
    await silent.until(() => silent.closed, 'close without hello');
    expect(silent.texts()).toEqual([]);
  });

  it('暂停：只播暂停话术然后断开；暂停中重连同样；恢复后撤回同意也同样', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const device = await open(token);
    await device.utterance(1);
    await a1.post(`/api/clients/${f.clients.a1[0]}/companion/pause`).expect(200);
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    const paused = await device.utterance(2);
    expect(paused.texts.find((t) => t.type === 'stt')).toBeUndefined();
    // 暂停、撤回同意时不调用语音识别
    const sttCalls = () => mock.speechCalls.filter((c) => c.request.route === 'speech_to_text');
    expect(sttCalls()).toHaveLength(0);
    expect(paused.texts.find((t) => t.state === 'sentence_start')!.text).toBe(
      COMPANION_DEFAULT_SCRIPTS.paused,
    );
    await device.until(() => device.closed, 'close after paused');

    // 暂停中重新连接：hello 后直接播暂停话术
    const again = await open(token);
    const msg = await again.utterance(1);
    expect(msg.texts.find((t) => t.state === 'sentence_start')!.text).toBe(
      COMPANION_DEFAULT_SCRIPTS.paused,
    );
    await again.until(() => again.closed, 'close');

    await a1.post(`/api/clients/${f.clients.a1[0]}/companion/resume`).expect(200);
    await a1
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    const revoked = await open(token);
    expect((await revoked.utterance(1)).texts[1]!.text).toBe(COMPANION_DEFAULT_SCRIPTS.paused);
    await revoked.until(() => revoked.closed, 'close after revoked');
    expect(sttCalls()).toHaveLength(0);
  });

  it('危机和疑似急症的说法（含繁体、同音误识别）：念危机、急症固定话术，不念“我是福宝”', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    const cases = [
      { said: '最近总想着不如死了算了', script: COMPANION_DEFAULT_SCRIPTS.crisis },
      { said: '我胸口痛，还出冷汗', script: COMPANION_DEFAULT_SCRIPTS.emergency },
      // 识别成繁体、同音字（“死”识别成“此”）同样命中
      { said: '最近總想著不如此了算了', script: COMPANION_DEFAULT_SCRIPTS.crisis },
      { said: '他胸口疼得厲害，喘不過氣', script: COMPANION_DEFAULT_SCRIPTS.emergency },
    ];
    for (const [i, c] of cases.entries()) {
      transcript = c.said;
      device.send({ type: 'listen', state: 'start', mode: 'auto' });
      device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
      const reply = await device.utterance(i + 2);
      expect(reply.texts.find((t) => t.state === 'sentence_start')!.text).toBe(c.script);
    }
    device.ws.close();
  });

  it('解绑后马上绑回同一位客户：进行中的会话也要断开', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    const url = `/api/clients/${f.clients.a1[0]}/companion/device`;
    await a1.delete(url).expect(200);
    await a1.post(url).send({ serialNo: SERIAL_A, activationCode: 'VOICE001' }).expect(200);
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    await device.until(() => device.closed, 'close after rebind');
    expect(mock.speechCalls.filter((c) => c.request.route === 'speech_to_text')).toHaveLength(0);
  });

  it('语音通道开关关闭（正式环境默认）：配置接口不发令牌，已有令牌也连不上', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const closed = await createTestApp({}, { llmProviders: { openai: mock } });
    try {
      await closed.listen(0, '127.0.0.1');
      const p = (closed.getHttpServer().address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${p}/api/device/ota/`, {
        method: 'POST',
        headers: { 'Serial-Number': SERIAL_A, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json()) as { websocket?: unknown; activation?: unknown };
      expect(body.websocket).toBeUndefined();
      expect(body.activation).toBeUndefined();
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}/ws/device`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', reject);
      });
      expect(status).toBe(401);
    } finally {
      await closed.close();
    }
  });

  it('解绑后旧令牌立即失效；设备再绑给别的客户，绑定前的令牌也不能用', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const device = await open(token);
    await device.utterance(1);
    await a1.delete(`/api/clients/${f.clients.a1[0]}/companion/device`).expect(200);
    // 会话进行中解绑：下一句话前发现设备不再属于这位客户，断开，不识别
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    await device.until(() => device.closed, 'close after unbind');
    expect(mock.speechCalls.filter((c) => c.request.route === 'speech_to_text')).toHaveLength(0);
    expect(await connect(token)).toBe(401);
    // 解绑后的设备请求配置接口不发令牌
    expect((await ota(SERIAL_A)).websocket).toBeUndefined();

    await a1
      .post(`/api/clients/${f.clients.a1[1]}/companion/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await a1
      .post(`/api/clients/${f.clients.a1[1]}/companion/device`)
      .send({ serialNo: SERIAL_A, activationCode: 'VOICE001' })
      .expect(200);
    expect(await connect(token)).toBe(401);
    const fresh = await open(await boot(SERIAL_A, keys.a));
    // 换了客户也是“第一次连接”
    expect((await fresh.utterance(1)).texts[1]!.text).toBe(COMPANION_DEFAULT_SCRIPTS.intro);
  });

  it('跨租户：设备令牌只代表自己这台；工作台会话、无令牌、别的协议版本都连不上', async () => {
    const tokenA = await boot(SERIAL_A, keys.a);
    const tokenB = await boot(SERIAL_B, keys.b);
    // 客户 B 的设备会话读不到客户 A 的设备和设置
    const { DeviceSessionRepository } =
      await import('../src/companion/voice/device-session.repository.js');
    const repo = app.get(DeviceSessionRepository);
    const idA = (
      await owner
        .selectFrom('companion_devices')
        .select('id')
        .where('serial_no', '=', SERIAL_A)
        .executeTakeFirstOrThrow()
    ).id as string;
    const idB = (
      await owner
        .selectFrom('companion_devices')
        .select('id')
        .where('serial_no', '=', SERIAL_B)
        .executeTakeFirstOrThrow()
    ).id as string;
    expect((await repo.state(idA))?.clientId).toBe(f.clients.a1[0]);
    expect((await repo.state(idB))?.clientId).toBe(f.clients.b1);
    // 设备 B 的会话上下文查设备 A 的行：看不到
    const seen = await withDevice(appDb(), { deviceId: idB }, (trx) =>
      trx.selectFrom('companion_devices').select('id').where('id', '=', idA).execute(),
    );
    expect(seen).toEqual([]);

    // 工作台会话 Cookie 连 /ws/device → 401；设备令牌调工作台接口 → 401
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.users.managerA1.email, password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(await connect(undefined, { Cookie: cookie })).toBe(401);
    expect(await connect('not-a-real-token')).toBe(401);
    expect(await connect(tokenA, { 'Protocol-Version': '2' })).toBe(400);
    const api = await fetch(`http://127.0.0.1:${port}/api/clients/${f.clients.a1[0]}/companion`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(api.status).toBe(401);

    // 令牌和设备认证函数在有租户上下文时不能调用
    await expect(
      withTenant(
        appDb(),
        { userId: f.users.managerA1.id, role: 'manager', operatorId: f.operatorA, orgId: f.orgA },
        (trx) => sql`select * from companion_device_auth_lookup(${SERIAL_A})`.execute(trx),
      ),
    ).rejects.toThrow();
    await expect(
      withDevice(appDb(), { deviceId: idB }, (trx) =>
        sql`select record_companion_llm_usage(${idA}::uuid, 'companion', 'openai', 'm', 1, 1, null, 1, 'complete', null)`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow();
    // 其余认证函数在健管师、设备上下文里同样不能调用
    const manager = {
      userId: f.users.managerA1.id,
      role: 'manager' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    const guarded = [
      sql`select companion_device_token_issue(${idA}::uuid, ${randomBytes(32)}, ${'a'.repeat(64)}, 3600)`,
      sql`select companion_device_token_activate(${idA}::uuid, ${'a'.repeat(64)}, null)`,
      sql`select * from companion_device_connect(${randomBytes(32)})`,
    ];
    for (const query of guarded) {
      await expect(withTenant(appDb(), manager, (trx) => query.execute(trx))).rejects.toThrow();
      await expect(
        withDevice(appDb(), { deviceId: idA }, (trx) => query.execute(trx)),
      ).rejects.toThrow();
    }
    // 有上下文时刷新在线时间不生效
    await owner.updateTable('companion_devices').set({ last_seen_at: null }).execute();
    await withTenant(appDb(), manager, (trx) =>
      sql`select companion_device_seen(${idA}::uuid)`.execute(trx),
    );
    const seenRow = await owner
      .selectFrom('companion_devices')
      .select('last_seen_at')
      .where('id', '=', idA)
      .executeTakeFirstOrThrow();
    expect(seenRow.last_seen_at).toBeNull();
    // 伴侣设置函数：健管师、运营商、平台读不到；设备 B 只读到客户 B 的
    for (const ctx of [
      manager,
      {
        userId: f.users.operatorAdminA.id,
        role: 'operator_admin' as const,
        operatorId: f.operatorA,
        orgId: null,
      },
      {
        userId: f.users.platform.id,
        role: 'platform_admin' as const,
        operatorId: null,
        orgId: null,
      },
    ]) {
      const { rows } = await withTenant(appDb(), ctx, (trx) =>
        sql`select * from companion_device_settings()`.execute(trx),
      );
      expect(rows).toEqual([]);
    }
    await owner
      .updateTable('clients')
      .set({ companion_voice_speed: 'fast' })
      .where('id', '=', f.clients.a1[0])
      .execute();
    expect((await repo.state(idB))?.voiceSpeed).toBe('slow');
    expect((await repo.state(idA))?.voiceSpeed).toBe('fast');
    // 应用角色读不到令牌表和设备密钥密文
    await expect(sql`select * from companion_device_tokens`.execute(appDb())).rejects.toThrow();
    await expect(
      sql`select secret_encrypted from companion_devices`.execute(appDb()),
    ).rejects.toThrow();
    expect(tokenB).not.toBe(tokenA);
  });

  // ---------- 第 4 步：福宝对话（规格 2.2、2.4–2.6、5.3、5.4） ----------

  /** 说一句话，等这一轮念完，返回这一轮的 sentence_start 文字 */
  async function turn(device: FakeDevice, text: string): Promise<string[]> {
    const stops = () => device.texts().filter((t) => t.type === 'tts' && t.state === 'stop').length;
    const n = stops() + 1;
    transcript = text;
    device.send({ type: 'listen', state: 'start', mode: 'auto' });
    device.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    const out = await device.utterance(n);
    return out.texts.filter((t) => t.state === 'sentence_start').map((t) => String(t.text));
  }
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
  };
  const exists = (q: Promise<unknown>) => q.then(Boolean);
  const companionCalls = () => mock.calls.filter((c) => c.request.route === 'companion');
  const deviceId = async (serial: string) =>
    (
      await owner
        .selectFrom('companion_devices')
        .select('id')
        .where('serial_no', '=', serial)
        .executeTakeFirstOrThrow()
    ).id as string;

  it('用药、症状、诊断类问题：念转交话术、写转交，不调用模型；模型判断要转交时同样', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    expect(await turn(device, '我这个降压药能不能停')).toEqual([COMPANION_DEFAULT_SCRIPTS.handoff]);
    expect(companionCalls()).toHaveLength(0);
    modelReply.handoff = 'symptom';
    modelReply.reply = '好的，我明白了。';
    expect(await turn(device, '最近总觉得没精神')).toEqual([COMPANION_DEFAULT_SCRIPTS.handoff]);
    const handoffs = await owner
      .selectFrom('companion_handoffs')
      .select(['category', 'trigger', 'question', 'status', 'manager_id', 'client_id'])
      .orderBy('created_at')
      .execute();
    expect(handoffs).toEqual([
      {
        category: 'medication',
        trigger: 'rule',
        question: '我这个降压药能不能停',
        status: 'open',
        manager_id: f.users.managerA1.id,
        client_id: f.clients.a1[0],
      },
      expect.objectContaining({ category: 'symptom', trigger: 'model' }),
    ]);
    const messages = await owner
      .selectFrom('companion_messages')
      .select(['role', 'kind', 'script_kind', 'content', 'signals'])
      .where('role', '=', 'client')
      .orderBy('id')
      .execute();
    expect(messages.map((m) => m.signals)).toEqual([['handoff'], ['handoff']]);
    device.ws.close();
  });

  it('输出检查不通过或模型出错：念兜底话术、写转交，不念模型的话', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    modelReply.reply = '您的血压偏高了，要注意。';
    expect(await turn(device, '我今天量了血压')).toEqual([COMPANION_DEFAULT_SCRIPTS.fallback]);
    llm.respond = () => 'not json';
    expect(await turn(device, '今天天气不错')).toEqual([COMPANION_DEFAULT_SCRIPTS.fallback]);
    const handoffs = await owner.selectFrom('companion_handoffs').select('trigger').execute();
    expect(handoffs.map((h) => h.trigger)).toEqual(['fallback', 'fallback']);
    const spoken = await owner
      .selectFrom('companion_messages')
      .select('content')
      .where('role', '=', 'companion')
      .execute();
    expect(spoken.map((m) => m.content)).not.toContain('您的血压偏高了，要注意。');
    device.ws.close();
  });

  it('危机：先念求助话术、写预警，再念模型的陪伴（危机模式）；模型识别出的急症同样写预警', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    modelReply.reply = '我在这儿陪着您，请马上给家人打电话。';
    expect(await turn(device, '活着没什么意思，不想活了')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.crisis,
      '我在这儿陪着您，请马上给家人打电话。',
    ]);
    expect(companionCalls().at(-1)!.request.system).toContain('求助话术');
    modelReply.emergencySignal = true;
    modelReply.reply = '请马上拨打 120。';
    expect((await turn(device, '我老伴刚才突然倒在地上了'))[0]).toBe(
      COMPANION_DEFAULT_SCRIPTS.emergency,
    );
    const alerts = await owner
      .selectFrom('companion_alerts')
      .select(['category', 'trigger', 'script_version', 'status', 'message_id'])
      .orderBy('created_at')
      .execute();
    expect(alerts).toEqual([
      expect.objectContaining({
        category: 'crisis',
        trigger: 'keyword',
        script_version: 1,
        status: 'open',
      }),
      expect.objectContaining({ category: 'emergency', trigger: 'model', script_version: 1 }),
    ]);
    expect(alerts.every((a) => a.message_id !== null)).toBe(true);
    device.ws.close();
  });

  it('每天第一次对话先说“不是医生”（N9）；速率超限时念 rate_limited，不调用模型', async () => {
    const token = await boot(SERIAL_A, keys.a);
    const first = await open(token);
    await first.utterance(1);
    first.ws.close();
    await first.until(() => first.closed, 'close');
    // 开场白记成昨天说的
    await waitFor(() =>
      exists(
        owner
          .selectFrom('companion_messages')
          .select('id')
          .where('script_kind', '=', 'intro')
          .executeTakeFirst(),
      ),
    );
    await owner
      .updateTable('companion_messages')
      .set({ created_at: new Date(Date.now() - 36 * 3600_000) })
      .execute();
    const device = await open(token);
    expect(await turn(device, '早上好')).toEqual([COMPANION_DEFAULT_SCRIPTS.daily_intro, REPLY]);
    expect(await turn(device, '吃过早饭了')).toEqual([REPLY]);
    const calls = companionCalls().length;
    const session = await owner
      .selectFrom('companion_sessions')
      .select(['id'])
      .orderBy('started_at', 'desc')
      .executeTakeFirstOrThrow();
    for (let i = 0; i < 6; i++) {
      await owner
        .insertInto('companion_messages')
        .values({
          client_id: f.clients.a1[0],
          session_id: session.id,
          role: 'client',
          kind: 'chat',
          content: '合成',
        })
        .execute();
    }
    expect(await turn(device, '再聊一会')).toEqual([COMPANION_DEFAULT_SCRIPTS.rate_limited]);
    expect(companionCalls()).toHaveLength(calls);
    // 速率超限时危机照样处理：念求助话术、写预警（合规复审 B1），不再调用模型
    expect(await turn(device, '我不想活了')).toEqual([COMPANION_DEFAULT_SCRIPTS.crisis]);
    expect(companionCalls()).toHaveLength(calls);
    expect(
      await owner.selectFrom('companion_alerts').select(['category', 'trigger']).execute(),
    ).toEqual([{ category: 'crisis', trigger: 'keyword' }]);
    device.ws.close();
  });

  it('“忘掉……”删除对应的记忆；“全都忘掉”先确认一次（N11）', async () => {
    const memory = (text: string) =>
      owner.insertInto('companion_memories').values({ client_id: f.clients.a1[0], text }).execute();
    await memory('客户下周要去北京看孙子');
    await memory('客户喜欢听京剧');
    await memory('客户每天早上去公园打太极');
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    expect(await turn(device, '把去北京那件事忘掉吧')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.memory_forgotten,
    ]);
    const left = () =>
      owner.selectFrom('companion_memories').select('text').orderBy('text').execute();
    expect((await left()).map((m) => m.text)).toEqual([
      '客户喜欢听京剧',
      '客户每天早上去公园打太极',
    ]);
    expect(await turn(device, '把我的事全都忘掉')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.memory_forget_confirm,
    ]);
    expect(await left()).toHaveLength(2);
    // 确认时说别的不算；夹着用药问题时转交，不删记忆（合规复审 B2）
    expect(await turn(device, '别记了，这药我能不能停')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.handoff,
    ]);
    expect(await left()).toHaveLength(2);
    expect(await turn(device, '把我的事全都忘掉')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.memory_forget_confirm,
    ]);
    expect(await turn(device, '对，全都忘掉')).toEqual([
      COMPANION_DEFAULT_SCRIPTS.memory_forgotten_all,
    ]);
    expect(await left()).toEqual([]);
    expect(companionCalls()).toHaveLength(0);
    device.ws.close();
  });

  it('会话结束后整理记忆和摘要：病名药名不记；下一次对话带上称呼、记忆、摘要，不带姓名', async () => {
    await a1
      .patch(`/api/clients/${f.clients.a1[0]}/companion`)
      .send({ nameForClient: '王阿姨' })
      .expect(200);
    memoryOutput = {
      memories: ['客户的孙子下周放假回家', '客户在吃二甲双胍', '客户有高血压'],
      summary: '聊了孙子放假回家。',
      observations: [],
    };
    const token = await boot(SERIAL_A, keys.a);
    const device = await open(token);
    await device.utterance(1);
    modelReply.endSession = true;
    modelReply.reply = '好的，您忙吧，再见。';
    expect(await turn(device, '我孙子下周放假，先不聊了')).toEqual(['好的，您忙吧，再见。']);
    await device.until(() => device.closed, 'end session');
    await waitFor(async () =>
      Boolean(
        await owner
          .selectFrom('companion_sessions')
          .select('id')
          .where('summary', 'is not', null)
          .executeTakeFirst(),
      ),
    );
    expect(
      (await owner.selectFrom('companion_memories').select('text').execute()).map((m) => m.text),
    ).toEqual(['客户的孙子下周放假回家']);
    const session = await owner
      .selectFrom('companion_sessions')
      .select(['turns', 'summary', 'ended_at'])
      .executeTakeFirstOrThrow();
    expect(session).toMatchObject({ turns: 1, summary: '聊了孙子放假回家。' });
    expect(session.ended_at).not.toBeNull();

    modelReply.endSession = false;
    const again = await open(token);
    await turn(again, '你好');
    const system = companionCalls().at(-1)!.request.system!;
    expect(system).toContain('王阿姨');
    expect(system).toContain('客户的孙子下周放假回家');
    expect(system).toContain('聊了孙子放假回家。');
    const client = await owner
      .selectFrom('clients')
      .select('display_name')
      .where('id', '=', f.clients.a1[0])
      .executeTakeFirstOrThrow();
    expect(system).not.toContain(client.display_name);
    again.ws.close();
  });

  it('到期清理：聊天文字 180 天、撤回同意后 7 天连同记忆删除；记忆最多 100 条', async () => {
    const { CompanionPurgeService } =
      await import('../src/companion/voice/companion-purge.service.js');
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '今天天气不错');
    device.ws.close();
    await device.until(() => device.closed, 'close');
    const purge = app.get(CompanionPurgeService);
    expect(await purge.run()).toEqual({ messages: 0, memories: 0 });
    const purgeAfter = await owner.selectFrom('companion_messages').select('purge_after').execute();
    expect(purgeAfter.every((m) => m.purge_after.getTime() > Date.now() + 179 * 86400_000)).toBe(
      true,
    );
    for (let i = 0; i < 101; i++) {
      await owner
        .insertInto('companion_memories')
        .values({ client_id: f.clients.a1[0], text: `合成记忆 ${i}` })
        .execute();
    }
    expect(await owner.selectFrom('companion_memories').select('id').execute()).toHaveLength(100);
    await a1
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    const scheduled = await owner.selectFrom('companion_memories').select('purge_after').execute();
    expect(
      scheduled.every(
        (m) => m.purge_after !== null && m.purge_after.getTime() < Date.now() + 8 * 86400_000,
      ),
    ).toBe(true);
    await owner
      .updateTable('companion_messages')
      .set({ purge_after: new Date(Date.now() - 1000) })
      .execute();
    await owner
      .updateTable('companion_memories')
      .set({ purge_after: new Date(Date.now() - 1000) })
      .execute();
    const purged = await purge.run();
    expect(purged.memories).toBe(100);
    expect(purged.messages).toBeGreaterThan(0);
    expect(await owner.selectFrom('companion_messages').select('id').execute()).toEqual([]);
  });

  it('跨租户：设备、健管师只能读写自己客户的会话、聊天、记忆、转交、预警', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '我是不是得了糖尿病');
    await turn(device, '不想活了');
    device.ws.close();
    await device.until(() => device.closed, 'close');
    // 等会话结束后的后台整理写完
    await waitFor(() =>
      exists(
        owner
          .selectFrom('companion_sessions')
          .select('id')
          .where('summarized_at', 'is not', null)
          .executeTakeFirst(),
      ),
    );
    await owner
      .insertInto('companion_memories')
      .values({ client_id: f.clients.a1[0], text: '客户喜欢听京剧' })
      .execute();
    const idA = await deviceId(SERIAL_A);
    const idB = await deviceId(SERIAL_B);
    const tables = [
      'companion_sessions',
      'companion_messages',
      'companion_memories',
      'companion_handoffs',
      'companion_alerts',
    ] as const;
    const count = async (read: (t: (typeof tables)[number]) => Promise<unknown[]>) =>
      Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await read(t)).length])));
    const ownerCounts = await count((t) => owner.selectFrom(t).select('id').execute());
    expect(Object.values(ownerCounts).every((n) => (n as number) > 0)).toBe(true);
    // 设备 B（客户 B，另一个运营商）读不到客户 A 的任何行
    expect(
      await count((t) =>
        withDevice(appDb(), { deviceId: idB }, (trx) => trx.selectFrom(t).select('id').execute()),
      ),
    ).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    // 设备 A 读得到自己客户的会话、聊天、记忆；转交、预警只能新增不能读（租户审查 S4）
    expect(
      await count((t) =>
        withDevice(appDb(), { deviceId: idA }, (trx) => trx.selectFrom(t).select('id').execute()),
      ),
    ).toEqual({ ...ownerCounts, companion_handoffs: 0, companion_alerts: 0 });
    // 同协会的其他健管师、机构管理员、运营商、平台都读不到；服务的健管师读得到
    const ctxOf = (
      u: { id: string },
      role: 'manager' | 'org_admin' | 'operator_admin' | 'platform_admin',
      operatorId: string | null,
      orgId: string | null,
    ) => ({ userId: u.id, role, operatorId, orgId });
    for (const ctx of [
      ctxOf(f.users.managerA2, 'manager', f.operatorA, f.orgA),
      ctxOf(f.users.managerA3, 'manager', f.operatorA, f.orgA2),
      ctxOf(f.users.managerB1, 'manager', f.operatorB, f.orgB),
      ctxOf(f.users.orgAdminA, 'org_admin', f.operatorA, f.orgA),
      ctxOf(f.users.operatorAdminA, 'operator_admin', f.operatorA, null),
      ctxOf(f.users.platform, 'platform_admin', null, null),
    ]) {
      expect(
        await count((t) =>
          withTenant(appDb(), ctx, (trx) => trx.selectFrom(t).select('id').execute()),
        ),
      ).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    }
    expect(
      await count((t) =>
        withTenant(appDb(), ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA), (trx) =>
          trx.selectFrom(t).select('id').execute(),
        ),
      ),
    ).toEqual(ownerCounts);
    // 设备 B 不能往客户 A 名下写，也不能删客户 A 的记忆
    await expect(
      withDevice(appDb(), { deviceId: idB }, (trx) =>
        trx
          .insertInto('companion_memories')
          .values({ client_id: f.clients.a1[0], text: '冒充' })
          .execute(),
      ),
    ).rejects.toThrow();
    await withDevice(appDb(), { deviceId: idB }, (trx) =>
      trx.deleteFrom('companion_memories').execute(),
    );
    expect(await owner.selectFrom('companion_memories').select('id').execute()).toHaveLength(
      ownerCounts.companion_memories as number,
    );
    // 设备 A 不能把会话记在设备 B 名下；更新不了客户 B 的会话（租户审查 S8）
    const clientOf = { [idA]: f.clients.a1[0], [idB]: f.clients.b1 };
    await expect(
      withDevice(appDb(), { deviceId: idA }, (trx) =>
        trx
          .insertInto('companion_sessions')
          .values({ client_id: clientOf[idA]!, device_id: idB })
          .execute(),
      ),
    ).rejects.toThrow();
    const sessionA = await owner
      .selectFrom('companion_sessions')
      .select('id')
      .executeTakeFirstOrThrow();
    const updated = await withDevice(appDb(), { deviceId: idB }, (trx) =>
      trx
        .updateTable('companion_sessions')
        .set({ summary: '篡改' })
        .where('id', '=', sessionA.id)
        .executeTakeFirst(),
    );
    expect(Number(updated.numUpdatedRows)).toBe(0);
    // 清理函数只在没有租户上下文时可用
    for (const run of [
      (q: ReturnType<typeof sql>) =>
        withDevice(appDb(), { deviceId: idA }, (trx) => q.execute(trx)),
      (q: ReturnType<typeof sql>) =>
        withTenant(appDb(), ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA), (trx) =>
          q.execute(trx),
        ),
    ]) {
      await expect(run(sql`select * from companion_purge()`)).rejects.toThrow();
    }
    // 健管师不能写对话、转交、预警（只经设备会话）
    await expect(
      withTenant(appDb(), ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA), (trx) =>
        trx
          .insertInto('companion_alerts')
          .values({ client_id: f.clients.a1[0], category: 'crisis', trigger: 'keyword' })
          .execute(),
      ),
    ).rejects.toThrow();
    // 客户资料函数只给设备会话
    const { rows } = await withTenant(
      appDb(),
      ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA),
      (trx) => sql`select * from companion_device_profile()`.execute(trx),
    );
    expect(rows).toEqual([]);
    // 暂停后设备读写不了任何对话数据
    await a1.post(`/api/clients/${f.clients.a1[0]}/companion/pause`).expect(200);
    expect(
      await count((t) =>
        withDevice(appDb(), { deviceId: idA }, (trx) => trx.selectFrom(t).select('id').execute()),
      ),
    ).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    await expect(
      withDevice(appDb(), { deviceId: idA }, (trx) =>
        trx
          .insertInto('companion_memories')
          .values({ client_id: f.clients.a1[0], text: '暂停中写入' })
          .execute(),
      ),
    ).rejects.toThrow();
    const deleted = await withDevice(appDb(), { deviceId: idA }, (trx) =>
      trx.deleteFrom('companion_memories').executeTakeFirst(),
    );
    expect(Number(deleted.numDeletedRows)).toBe(0);
    // 解绑后再绑给另一位客户：同一台设备读不到前一位客户的会话、聊天、记忆
    await a1.post(`/api/clients/${f.clients.a1[0]}/companion/resume`).expect(200);
    await a1.delete(`/api/clients/${f.clients.a1[0]}/companion/device`).expect(200);
    await a1
      .post(`/api/clients/${f.clients.a1[1]}/companion/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await a1
      .post(`/api/clients/${f.clients.a1[1]}/companion/device`)
      .send({ serialNo: SERIAL_A, activationCode: 'VOICE001' })
      .expect(200);
    expect(
      await count((t) =>
        withDevice(appDb(), { deviceId: idA }, (trx) => trx.selectFrom(t).select('id').execute()),
      ),
    ).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
  });

  // ---------- 第 5 步：打卡（规格 2.3） ----------

  /** 打卡用的“北京时间现在”：测试里换成固定时刻，用完恢复（窗口按时段判断，不能依赖跑测试的时间） */
  const setClock = async (local: string | null) => {
    const body = local
      ? sql.raw(`select timestamp '${local}'`)
      : sql.raw(`select now() at time zone 'Asia/Shanghai'`);
    await sql`create or replace function checkin_local_now() returns timestamp
      language sql stable as $$ ${body} $$`.execute(owner);
  };
  const addDays = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const plan = async (agent: Agent, clientId: string, body: Record<string, unknown>) =>
    (await agent.post(`/api/clients/${clientId}/checkin-plans`).send(body).expect(201)).body
      .plan as {
      id: string;
    };
  const S = COMPANION_DEFAULT_SCRIPTS;
  const managerCtx = (u: { id: string }, operatorId: string, orgId: string) => ({
    userId: u.id,
    role: 'manager' as const,
    operatorId,
    orgId,
  });

  it('打卡：唤醒时先补说到期的提醒；服药、运动记结果，血压复述确认后写入监测、孪生入队', async () => {
    const client = f.clients.a1[0];
    await plan(a1, client, {
      kind: 'medication',
      slots: [{ slot: 'morning', time: '08:00' }],
      note: '合成备注：只给健管师看',
    });
    await plan(a1, client, {
      kind: 'measurement',
      metric: 'bp',
      slots: [{ slot: 'morning', time: '08:30' }],
    });
    await plan(a1, client, { kind: 'exercise', slots: [{ slot: 'morning', time: '09:00' }] });
    // 还没到提醒时间的不说
    await plan(a1, client, { kind: 'exercise', slots: [{ slot: 'evening', time: '18:00' }] });
    await setClock(`${TODAY} 09:30`);
    try {
      const device = await open(await boot(SERIAL_A, keys.a));
      await device.utterance(1);
      // 开场白后接着补说第一条提醒；服药提醒里没有药名和备注
      const reminder = await device.utterance(2);
      expect(reminder.texts.filter((t) => t.state === 'sentence_start').map((t) => t.text)).toEqual(
        [S.reminder_medication],
      );
      expect(await turn(device, '吃过了')).toEqual([
        S.checkin_noted,
        '该记一下今天的血压了，您告诉我数就行。',
      ]);
      expect(await turn(device, '一百三十二，八十六')).toEqual([
        '您说的是高压一百三十二，低压八十六，对吗？',
      ]);
      expect(await turn(device, '对')).toEqual([S.checkin_recorded, S.reminder_exercise]);
      expect(await turn(device, '只做了一部分')).toEqual([S.checkin_noted]);
      // 打卡全程不调用模型
      expect(companionCalls()).toHaveLength(0);

      const checkins = await owner
        .selectFrom('checkins')
        .select(['status', 'reading_values', 'slot', 'manager_id'])
        .orderBy('answered_at')
        .execute();
      expect(checkins).toEqual([
        { status: 'done', reading_values: [], slot: 'morning', manager_id: f.users.managerA1.id },
        {
          status: 'done',
          reading_values: [132, 86],
          slot: 'morning',
          manager_id: f.users.managerA1.id,
        },
        {
          status: 'partial',
          reading_values: [],
          slot: 'morning',
          manager_id: f.users.managerA1.id,
        },
      ]);
      const readings = await owner
        .selectFrom('monitoring_readings')
        .select(['metric', 'value', 'unit', 'source'])
        .where('client_id', '=', client)
        .where('source', '=', 'companion')
        .orderBy('metric', 'desc')
        .execute();
      expect(readings).toEqual([
        { metric: 'sbp', value: '132.000', unit: 'mmHg', source: 'companion' },
        { metric: 'dbp', value: '86.000', unit: 'mmHg', source: 'companion' },
      ]);
      const twin = await owner
        .selectFrom('twin_compute_state')
        .select('requested_at')
        .where('client_id', '=', client)
        .executeTakeFirst();
      expect(twin?.requested_at).toBeTruthy();
      expect(await owner.selectFrom('companion_alerts').select('id').execute()).toEqual([]);
      // 聊天记录里的复述是替换后的文字
      const said = await owner
        .selectFrom('companion_messages')
        .select('content')
        .where('script_kind', '=', 'checkin_confirm_reading')
        .execute();
      expect(said.map((m) => m.content)).toEqual(['您说的是高压一百三十二，低压八十六，对吗？']);

      // 健管师看到近 30 天的打卡；别人的客户 404
      const res = await a1.get(`/api/clients/${client}/checkins`).expect(200);
      expect(res.body.checkins).toHaveLength(3);
      expect(res.body.checkins.find((c: { metric: string }) => c.metric === 'bp')).toMatchObject({
        dueOn: TODAY,
        status: 'done',
        values: [132, 86],
      });
      await b1.get(`/api/clients/${client}/checkins`).expect(404);

      // 同一时间段再唤醒：已经打过卡的不再提醒
      device.ws.close();
      await device.until(() => device.closed, 'close');
      const again = await open(await boot(SERIAL_A, keys.a));
      expect(await turn(again, '今天天气不错')).toEqual([REPLY]);
      // 给模型的资料里有今天的打卡（客户报的数可以复述），没有健管师的备注
      const system = companionCalls().at(-1)!.request.system as string;
      expect(system).toContain('今天的打卡');
      expect(system).toContain('早上量血压：报了 132、86');
      expect(system).toContain('早上吃药：吃了');
      expect(system).not.toContain('合成备注');
      expect(system).not.toContain('晚上运动');
    } finally {
      await setClock(null);
    }
  });

  it('打卡：说“不对”重新复述；两次超出合理范围记成待确认、不写监测；命中危急阈值念固定话术、写预警', async () => {
    const client = f.clients.a1[0];
    await plan(a1, client, {
      kind: 'measurement',
      metric: 'bp',
      slots: [{ slot: 'noon', time: '11:30' }],
    });
    await plan(a1, client, {
      kind: 'measurement',
      metric: 'fpg',
      slots: [{ slot: 'noon', time: '11:30' }],
    });
    await setClock(`${TODAY} 12:00`);
    try {
      const device = await open(await boot(SERIAL_A, keys.a));
      await device.utterance(1);
      await device.utterance(2);
      // 血压：数值不对（听错了）请再说一遍；第二次仍不对，记成待确认，接着问血糖
      expect(await turn(device, '一千三百二，八十六')).toEqual([S.checkin_retry]);
      // 两次都超出合理范围：不写监测、记成待确认；高压超过危急阈值，念危急指标话术、写预警
      expect(await turn(device, '一千三百二，八十六')).toEqual([
        S.critical_value,
        '该记一下今天的空腹血糖了，您告诉我数就行。',
      ]);
      expect(await turn(device, '七点八')).toEqual(['您说的是空腹血糖七点八，对吗？']);
      expect(await turn(device, '不对，是二点八')).toEqual(['您说的是空腹血糖二点八，对吗？']);
      expect(await turn(device, '对的')).toEqual([S.critical_value]);
      // 测试里说得快：把已说的话记早两分钟，免得撞上每分钟 6 句的速率限制
      await owner
        .updateTable('companion_messages')
        .set({ created_at: new Date(Date.now() - 120_000) })
        .execute();
      // 没被提醒时主动报的血压（计划今天还没打卡）：同样复述确认
      expect(await turn(device, '我血压一百八十五，一百二十五')).toEqual([
        '您说的是高压一百八十五，低压一百二十五，对吗？',
      ]);
      expect(await turn(device, '是的')).toEqual([S.critical_value]);
      // 说的是以前的数，不算今天的打卡
      expect(await turn(device, '昨天量的血压一百五，九十五')).toEqual([REPLY]);

      const pending = await owner
        .selectFrom('companion_observations')
        .select([
          'category',
          'status',
          'metric',
          'reading_values',
          'source_message_id',
          'manager_id',
        ])
        .execute();
      expect(pending).toEqual([
        {
          category: 'measurement',
          status: 'pending_confirm',
          metric: 'bp',
          reading_values: [1320, 86],
          source_message_id: expect.any(String),
          manager_id: f.users.managerA1.id,
        },
      ]);
      const readings = await owner
        .selectFrom('monitoring_readings')
        .select(['metric', 'value'])
        .where('source', '=', 'companion')
        .orderBy('id')
        .execute();
      expect(readings).toEqual([
        { metric: 'fpg', value: '2.800' },
        { metric: 'sbp', value: '185.000' },
        { metric: 'dbp', value: '125.000' },
      ]);
      const alerts = await owner
        .selectFrom('companion_alerts')
        .select(['category', 'trigger', 'reading_id', 'script_version', 'manager_id'])
        .orderBy('created_at')
        .execute();
      expect(alerts).toEqual([
        expect.objectContaining({
          category: 'critical_value',
          trigger: 'threshold',
          script_version: 1,
          reading_id: null,
        }),
        expect.objectContaining({ category: 'critical_value', trigger: 'threshold' }),
        expect.objectContaining({ category: 'critical_value', trigger: 'threshold' }),
      ]);
      // 待确认的那条没有读数；写进监测的两条指向读数
      expect(alerts.slice(1).every((a) => a.reading_id !== null)).toBe(true);
      expect(alerts.every((a) => a.manager_id === f.users.managerA1.id)).toBe(true);
    } finally {
      await setClock(null);
    }
  });

  it('打卡：窗口过了没回答记“未应答”；危机优先于打卡；跨租户的计划、打卡、函数都碰不到', async () => {
    const clientA = f.clients.a1[0];
    const planA = await plan(a1, clientA, {
      kind: 'medication',
      slots: [{ slot: 'morning', time: '08:00' }],
      note: '合成备注',
    });
    const planB = await plan(b1, f.clients.b1, {
      kind: 'medication',
      slots: [{ slot: 'morning', time: '08:00' }],
    });
    await setClock(`${TODAY} 08:10`);
    try {
      const device = await open(await boot(SERIAL_A, keys.a));
      await device.utterance(1);
      await device.utterance(2);
      // 刚念完提醒客户说了危机的话：先处理危机，提醒放下
      modelReply.reply = '我在这儿陪着您，请马上联系家人。';
      expect(await turn(device, '我不想活了')).toEqual([
        S.crisis,
        '我在这儿陪着您，请马上联系家人。',
      ]);
      modelReply.reply = REPLY;
      expect(await turn(device, '吃了')).toEqual([REPLY]);
      // 提醒还没回答时问“我今天药吃了吗”：是问句，不记成打卡，交给模型（合规审查 B1）
      expect(await turn(device, '我今天药吃了吗')).toEqual([REPLY]);
      expect(await owner.selectFrom('checkins').select('id').execute()).toEqual([]);
      device.ws.close();

      const idA = await deviceId(SERIAL_A);
      const asDevice = <T>(fn: Parameters<typeof withDevice<T>>[2]) =>
        withDevice(appDb(), { deviceId: idA }, fn);
      // 设备看到的到期提醒只有自己客户的；直接读计划、打卡表一行都读不到（备注也读不到）
      const due = await asDevice((trx) =>
        sql`select plan_id from companion_due_checkins(${clientA}::uuid)`.execute(trx),
      );
      expect(due.rows).toEqual([{ plan_id: planA.id }]);
      // 拿别的客户 id 调：读不到（会话开始后设备换了客户也是这样，租户审查 S1）
      for (const fn of ['companion_due_checkins', 'companion_today_checkins']) {
        const other = await asDevice((trx) =>
          sql`select * from ${sql.raw(fn)}(${f.clients.b1}::uuid)`.execute(trx),
        );
        expect(other.rows).toEqual([]);
      }
      expect(
        await asDevice((trx) => trx.selectFrom('checkin_plans').select('note').execute()),
      ).toEqual([]);
      expect(await asDevice((trx) => trx.selectFrom('checkins').select('id').execute())).toEqual(
        [],
      );
      // 用别人客户的计划打卡、写读数都失败
      await expect(
        asDevice((trx) =>
          sql`select companion_checkin_record(${clientA}::uuid, ${planB.id}::uuid, 'morning', 'done')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asDevice((trx) =>
          sql`select * from companion_checkin_reading(${clientA}::uuid, ${planB.id}::uuid, 'morning', array[130, 80]::numeric[])`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      // 自己的计划但客户 id 不是设备当前绑定的客户：失败
      await expect(
        asDevice((trx) =>
          sql`select companion_checkin_record(${f.clients.b1}::uuid, ${planA.id}::uuid, 'morning', 'done')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      // 待确认的测量：客户 id 不对、指向别的客户的消息都失败
      const messageB = await owner
        .insertInto('companion_sessions')
        .values({ client_id: f.clients.b1, device_id: await deviceId(SERIAL_B) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const msgB = await owner
        .insertInto('companion_messages')
        .values({
          client_id: f.clients.b1,
          session_id: messageB.id,
          role: 'client',
          kind: 'chat',
          content: '合成',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(
        asDevice((trx) =>
          sql`select companion_pending_reading(${f.clients.b1}::uuid, 'bp', array[130, 80]::numeric[], '合成', null)`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asDevice((trx) =>
          sql`select companion_pending_reading(${clientA}::uuid, 'bp', array[130, 80]::numeric[], '合成', ${msgB.id}::bigint)`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      // 不在计划里的时间段、服药计划写数值都失败
      await expect(
        asDevice((trx) =>
          sql`select companion_checkin_record(${clientA}::uuid, ${planA.id}::uuid, 'evening', 'done')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asDevice((trx) =>
          sql`select * from companion_checkin_reading(${clientA}::uuid, ${planA.id}::uuid, 'morning', array[130, 80]::numeric[])`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      // 设备不能直接写打卡、监测
      await expect(
        asDevice((trx) =>
          trx
            .insertInto('monitoring_readings')
            .values({
              client_id: clientA,
              metric: 'sbp',
              value: '130',
              unit: 'mmHg',
              measured_at: new Date(),
              source: 'companion',
            } as never)
            .execute(),
        ),
      ).rejects.toThrow();
      // 暂停后设备什么都打不了卡
      await a1.post(`/api/clients/${clientA}/companion/pause`).expect(200);
      expect(
        (
          await asDevice((trx) =>
            sql`select * from companion_due_checkins(${clientA}::uuid)`.execute(trx),
          )
        ).rows,
      ).toEqual([]);
      await expect(
        asDevice((trx) =>
          sql`select companion_checkin_record(${clientA}::uuid, ${planA.id}::uuid, 'morning', 'done')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
      await a1.post(`/api/clients/${clientA}/companion/resume`).expect(200);
      // 设备会话调不了定时任务
      await expect(
        asDevice((trx) => sql`select companion_checkin_sweep()`.execute(trx)),
      ).rejects.toThrow();

      // 定时任务：窗口过了没回答的记“未应答”（设备没开通的客户 B 不记）；健管师调不了
      await setClock(`${addDays(TODAY, 2)} 12:00`);
      const swept = await sql<{ n: number }>`select companion_checkin_sweep() as n`.execute(
        appDb(),
      );
      expect(swept.rows[0]!.n).toBe(2);
      const rows = await owner
        .selectFrom('checkins')
        .select(['plan_id', 'status', 'answered_at'])
        .execute();
      expect(
        rows.every((r) => r.plan_id === planA.id && r.status === 'no_response' && !r.answered_at),
      ).toBe(true);
      await expect(
        withTenant(appDb(), managerCtx(f.users.managerA1, f.operatorA, f.orgA), (trx) =>
          sql`select companion_checkin_sweep()`.execute(trx),
        ),
      ).rejects.toThrow();
    } finally {
      await setClock(null);
    }
  });

  it('打卡：客户转给别的健管师、换机构后计划和打卡跟着走，原健管师看不到，设备照常用', async () => {
    const client = f.clients.a1[0];
    const created = await plan(a1, client, {
      kind: 'medication',
      slots: [{ slot: 'morning', time: '08:00' }],
      note: '合成备注',
    });
    await setClock(`${TODAY} 08:30`);
    try {
      const device = await open(await boot(SERIAL_A, keys.a));
      await device.utterance(1);
      await device.utterance(2);
      expect(await turn(device, '吃了')).toEqual([S.checkin_noted]);
      device.ws.close();
      await device.until(() => device.closed, 'close');
      // 同协会另一位健管师、同机构另一位健管师都看不到
      const a2 = await loginAs(app, f.users.managerA2.email);
      await a2.get(`/api/clients/${client}/checkin-plans`).expect(404);
      await a2.get(`/api/clients/${client}/checkins`).expect(404);
      await expect(
        withTenant(appDb(), managerCtx(f.users.managerA2, f.operatorA, f.orgA), (trx) =>
          trx
            .updateTable('checkin_plans')
            .set({ note: '改别人的' })
            .where('id', '=', created.id)
            .executeTakeFirst(),
        ),
      ).resolves.toMatchObject({ numUpdatedRows: 0n });
      await expect(
        withTenant(appDb(), managerCtx(f.users.managerA2, f.operatorA, f.orgA), (trx) =>
          trx
            .insertInto('checkin_plans')
            .values({
              client_id: client,
              kind: 'exercise',
              metric: null,
              slots: JSON.stringify([{ slot: 'evening', time: '18:00' }]),
              goal_template_id: null,
              note: null,
              created_by: f.users.managerA2.id,
            })
            .execute(),
        ),
      ).rejects.toThrow();

      // 转给另一个机构的健管师
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
        .where('id', '=', client)
        .execute();
      for (const table of ['checkin_plans', 'checkins'] as const) {
        const rows = await owner
          .selectFrom(table)
          .select(['manager_id', 'org_id', 'operator_id'])
          .where('client_id', '=', client)
          .execute();
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.every(
            (r) =>
              r.manager_id === f.users.managerA3.id &&
              r.org_id === f.orgA2 &&
              r.operator_id === f.operatorA,
          ),
        ).toBe(true);
      }
      await a1.get(`/api/clients/${client}/checkin-plans`).expect(404);
      await a1.get(`/api/clients/${client}/checkins`).expect(404);
      const a3 = await loginAs(app, f.users.managerA3.email);
      const plans = await a3.get(`/api/clients/${client}/checkin-plans`).expect(200);
      expect(plans.body.plans).toEqual([
        expect.objectContaining({ id: created.id, note: '合成备注' }),
      ]);
      const history = await a3.get(`/api/clients/${client}/checkins`).expect(200);
      expect(history.body.checkins).toEqual([expect.objectContaining({ status: 'done' })]);
      // 设备照常读到期提醒（今天已经打过卡，换一个还没到的时间段看不到也正常，这里只确认能调用）
      const idA = await deviceId(SERIAL_A);
      const due = await withDevice(appDb(), { deviceId: idA }, (trx) =>
        sql`select plan_id from companion_due_checkins(${client}::uuid)`.execute(trx),
      );
      expect(due.rows).toEqual([]);
    } finally {
      await setClock(null);
    }
  });

  it('打卡计划接口：只有服务这位客户的健管师；时间在窗口外、测量没选项目都 400；别人的计划 404', async () => {
    const client = f.clients.a1[0];
    const base = `/api/clients/${client}/checkin-plans`;
    await a1
      .post(base)
      .send({ kind: 'medication', slots: [{ slot: 'morning', time: '12:00' }] })
      .expect(400);
    await a1
      .post(base)
      .send({ kind: 'measurement', slots: [{ slot: 'morning', time: '08:00' }] })
      .expect(400);
    await a1
      .post(base)
      .send({ kind: 'medication', metric: 'bp', slots: [{ slot: 'morning', time: '08:00' }] })
      .expect(400);
    await a1
      .post(base)
      .send({
        kind: 'medication',
        slots: [
          { slot: 'morning', time: '08:00' },
          { slot: 'morning', time: '09:00' },
        ],
      })
      .expect(400);
    const created = await plan(a1, client, {
      kind: 'measurement',
      metric: 'weight',
      slots: [
        { slot: 'morning', time: '07:00' },
        { slot: 'bedtime', time: '21:30' },
      ],
    });
    // 别人的客户、别的健管师 404；其他角色 404
    await b1.get(base).expect(404);
    await b1
      .post(base)
      .send({ kind: 'medication', slots: [{ slot: 'morning', time: '08:00' }] })
      .expect(404);
    await b1.patch(`${base}/${created.id}`).send({ active: false }).expect(404);
    await b1
      .patch(`/api/clients/${f.clients.b1}/checkin-plans/${created.id}`)
      .send({ active: false })
      .expect(404);
    const orgAdmin = await loginAs(app, f.users.orgAdminA.email);
    await orgAdmin.get(base).expect(404);
    // 修改、停用；类别和项目不能改
    const updated = await a1
      .patch(`${base}/${created.id}`)
      .send({ slots: [{ slot: 'noon', time: '12:30' }], note: '  ', active: false })
      .expect(200);
    expect(updated.body.plan).toMatchObject({
      kind: 'measurement',
      metric: 'weight',
      slots: [{ slot: 'noon', time: '12:30' }],
      note: null,
      active: false,
    });
    await a1.patch(`${base}/${created.id}`).send({ kind: 'medication' }).expect(400);
    // 非运动计划不能挂行为目标
    await a1
      .patch(`${base}/${created.id}`)
      .send({ goalTemplateId: '00000000-0000-4000-8000-000000000000' })
      .expect(400);
    const list = await a1.get(base).expect(200);
    expect(list.body.plans).toHaveLength(1);
    // 数据库也拦住：直接改类别失败
    await expect(
      withTenant(appDb(), managerCtx(f.users.managerA1, f.operatorA, f.orgA), (trx) =>
        sql`update checkin_plans set kind = 'exercise' where id = ${created.id}`.execute(trx),
      ),
    ).rejects.toThrow();
    // 健管师 B 直接查不到 A 的计划
    const seen = await withTenant(
      appDb(),
      managerCtx(f.users.managerB1, f.operatorB, f.orgB),
      (trx) => trx.selectFrom('checkin_plans').select('id').execute(),
    );
    expect(seen).toEqual([]);
  });

  // ---------- 第 6 步（6a）：转交、预警、收集信息的处理（规格 2.4、2.5、2.7、N10、N13、N18） ----------

  /** 等会话结束整理写完（断开后服务端异步处理） */
  const closeAndSettle = async (device: FakeDevice) => {
    device.ws.close();
    await device.until(() => device.closed, 'close');
    await new Promise((r) => setTimeout(r, 50));
    await app.get(CompanionDialogue).settled();
  };

  it('转交：健管师直接回复（过禁用词检查）→ 客户下次唤醒时先念回复开场、再念原文，只念一次', async () => {
    const client = f.clients.a1[0];
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '我这个降压药能不能停');
    await turn(device, '最近总是头晕');
    await closeAndSettle(device);

    const inbox = await a1.get('/api/companion/inbox').expect(200);
    expect(inbox.body.handoffs).toHaveLength(2);
    const [first, second] = inbox.body.handoffs as { id: string; question: string }[];
    expect(first!.question).toBe('我这个降压药能不能停');
    // 别的健管师（同协会、别的协会）看不到、回复不了
    const a2 = await loginAs(app, f.users.managerA2.email);
    expect((await a2.get('/api/companion/inbox').expect(200)).body.handoffs).toEqual([]);
    expect((await b1.get('/api/companion/inbox').expect(200)).body.handoffs).toEqual([]);
    await a2.post(`/api/companion/handoffs/${first!.id}/reply`).send({ text: '好的' }).expect(404);
    await b1
      .post(`/api/companion/handoffs/${first!.id}/close`)
      .send({ outcome: 'closed' })
      .expect(404);
    const orgAdmin = await loginAs(app, f.users.orgAdminA.email);
    await orgAdmin.get('/api/companion/inbox').expect(404);
    // 含禁用词的回复不能发
    const bad = await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: '这个可以根治，不用担心。' })
      .expect(400);
    expect(bad.body.error).toBe('invalid_content');
    // 只给健管师看的提示语不能念给客户（合规审查 S1）
    const managerOnly = await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: '仅供健管师参考，非医疗诊断，请勿直接转发给客户' })
      .expect(400);
    expect(managerOnly.body.reasons).toEqual(['manager_only_text']);
    // 有药名：先提醒，健管师确认后才发（合规审查 S2）
    const reply = '王阿姨，降压药先按原来的吃，别自己停，我明天上午给您打电话细说。';
    const warned = await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: reply })
      .expect(400);
    expect(warned.body.reasons[0]).toBe('needs_confirmation');
    const ok = await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: reply, acknowledgeWarnings: true })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'replied', replyText: reply });
    // 回复过的不能再回复；另一条选“已电话联系”
    await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: '再说一次' })
      .expect(409);
    await a1
      .post(`/api/companion/handoffs/${second!.id}/close`)
      .send({ outcome: 'closed_by_call' })
      .expect(200);

    // 设备不能直接读转交表；读回复只能读自己客户的
    const idA = await deviceId(SERIAL_A);
    expect(
      await withDevice(appDb(), { deviceId: idA }, (trx) =>
        trx.selectFrom('companion_handoffs').select('id').execute(),
      ),
    ).toEqual([]);
    const other = await withDevice(appDb(), { deviceId: idA }, (trx) =>
      sql`select * from companion_pending_replies(${f.clients.b1}::uuid)`.execute(trx),
    );
    expect(other.rows).toEqual([]);

    // 下次唤醒：先念回复开场，再念原文
    const again = await open(await boot(SERIAL_A, keys.a));
    const said = await again.utterance(1);
    expect(said.texts.filter((t) => t.state === 'sentence_start').map((t) => t.text)).toEqual([
      COMPANION_DEFAULT_SCRIPTS.handoff_reply_intro,
      reply,
    ]);
    await closeAndSettle(again);
    const rows = await owner
      .selectFrom('companion_handoffs')
      .select(['status', 'delivered_at', 'replied_by'])
      .where('client_id', '=', client)
      .orderBy('created_at')
      .execute();
    expect(rows).toEqual([
      { status: 'delivered', delivered_at: expect.any(Date), replied_by: f.users.managerA1.id },
      { status: 'closed_by_call', delivered_at: null, replied_by: null },
    ]);
    // 再唤醒不再念
    const third = await open(await boot(SERIAL_A, keys.a));
    expect(await turn(third, '今天天气不错')).toEqual([REPLY]);
    // 设备只能把自己客户已回复的标成已播报：传别的 id 不生效
    const marked = await withDevice(appDb(), { deviceId: idA }, (trx) =>
      sql<{
        n: number;
      }>`select companion_mark_replies_delivered(${f.clients.a1[0]}::uuid, array[${second!.id}]::uuid[]) as n`.execute(
        trx,
      ),
    );
    expect(marked.rows[0]!.n).toBe(0);
    // 健管师调不了设备的函数，设备调不了健管师的函数
    await expect(
      withTenant(appDb(), managerCtx(f.users.managerA1, f.operatorA, f.orgA), (trx) =>
        sql`select * from companion_pending_replies(${f.clients.a1[0]}::uuid)`.execute(trx),
      ).then((r) => r.rows),
    ).resolves.toEqual([]);
    await expect(
      withDevice(appDb(), { deviceId: idA }, (trx) =>
        sql`select companion_offline_ack(${f.clients.a1[0]}::uuid)`.execute(trx),
      ),
    ).rejects.toThrow();
    // 已播报的不能再关闭
    await a1
      .post(`/api/companion/handoffs/${first!.id}/close`)
      .send({ outcome: 'closed' })
      .expect(409);
    // 数据库也拦：直接改原话、直接标已播报都失败
    await expect(
      withTenant(appDb(), managerCtx(f.users.managerA1, f.operatorA, f.orgA), (trx) =>
        sql`update companion_handoffs set question = '改过' where id = ${second!.id}`.execute(trx),
      ),
    ).rejects.toThrow();
  });

  it('预警：今日跟进置顶、有原话和福宝说的话；处理方式必填，不能忽略；别人的 404', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    modelReply.reply = '我在这儿陪着您，请马上联系家人。';
    await turn(device, '我不想活了');
    await closeAndSettle(device);
    const inbox = await a1.get('/api/companion/inbox').expect(200);
    expect(inbox.body.alerts).toEqual([
      expect.objectContaining({
        category: 'crisis',
        said: '我不想活了',
        companionSaid: COMPANION_DEFAULT_SCRIPTS.crisis,
        status: 'open',
        clientId: f.clients.a1[0],
      }),
    ]);
    const id = inbox.body.alerts[0].id as string;
    expect((await b1.get('/api/companion/inbox').expect(200)).body.alerts).toEqual([]);
    await b1.post(`/api/companion/alerts/${id}/handle`).send({ resolution: 'called' }).expect(404);
    await a1.post(`/api/companion/alerts/${id}/handle`).send({}).expect(400);
    await a1.post(`/api/companion/alerts/${id}/handle`).send({ resolution: 'other' }).expect(400);
    await a1.post(`/api/companion/alerts/${id}/handle`).send({ resolution: 'ignored' }).expect(400);
    const handled = await a1
      .post(`/api/companion/alerts/${id}/handle`)
      .send({ resolution: 'contacted_family', note: '已联系女儿' })
      .expect(200);
    expect(handled.body).toMatchObject({ status: 'handled', resolution: 'contacted_family' });
    await a1.post(`/api/companion/alerts/${id}/handle`).send({ resolution: 'called' }).expect(409);
    expect((await a1.get('/api/companion/inbox').expect(200)).body.alerts).toEqual([]);
    // 客户的伴侣视图仍能看到已处理的
    const cases = await a1.get(`/api/clients/${f.clients.a1[0]}/companion/cases`).expect(200);
    expect(cases.body.alerts).toEqual([expect.objectContaining({ status: 'handled' })]);
    await b1.get(`/api/clients/${f.clients.a1[0]}/companion/cases`).expect(404);
    // 数据库也拦：改回未处理失败
    await expect(
      withTenant(appDb(), managerCtx(f.users.managerA1, f.operatorA, f.orgA), (trx) =>
        sql`update companion_alerts set status = 'open' where id = ${id}`.execute(trx),
      ),
    ).rejects.toThrow();
  });

  it('收集信息：会话结束后整理（药名换成“药物”），闲聊里的测量值待确认；确认才写监测，驳回不写', async () => {
    memoryOutput = {
      memories: [],
      summary: '聊了最近睡得不好。',
      observations: [
        {
          category: 'sleep',
          text: '客户说昨晚只睡了四个小时',
          polarity: 'negative',
          metric: null,
          values: [],
        },
        {
          category: 'adherence',
          text: '客户说昨天晚上二甲双胍忘吃了',
          polarity: null,
          metric: null,
          values: [],
        },
        {
          category: 'measurement',
          text: '客户说昨天量的血压一百五、九十五',
          polarity: null,
          metric: 'bp',
          values: [150, 95],
        },
        {
          category: 'measurement',
          text: '客户说体重一百三十斤',
          polarity: null,
          metric: 'weight',
          values: [65],
        },
      ],
    };
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '昨天量的血压一百五、九十五，晚上只睡了四个小时');
    await closeAndSettle(device);

    const list = await a1.get(`/api/clients/${f.clients.a1[0]}/companion/observations`).expect(200);
    const observations = list.body.observations as {
      id: string;
      category: string;
      text: string;
      status: string;
      metric: string | null;
    }[];
    expect(observations).toHaveLength(4);
    // 有睡眠类（带极性）的收集信息：孪生按条数规则重算（6c，触发原因 companion）
    await app.get<InProcessTwinQueue>(TWIN_QUEUE).idle();
    const recomputed = await owner
      .selectFrom('twin_status_history')
      .select('trigger')
      .where('client_id', '=', f.clients.a1[0])
      .where('trigger', '=', 'companion')
      .execute();
    expect(recomputed.length).toBeGreaterThan(0);
    expect(observations.find((o) => o.category === 'adherence')!.text).toBe(
      '客户说昨天晚上药物忘吃了',
    );
    const bp = observations.find((o) => o.metric === 'bp')!;
    const weight = observations.find((o) => o.metric === 'weight')!;
    expect(bp.status).toBe('pending_confirm');
    // 闲聊里的数没有直接写进监测
    expect(
      await owner
        .selectFrom('monitoring_readings')
        .select('id')
        .where('source', '=', 'companion')
        .execute(),
    ).toEqual([]);
    const inbox = await a1.get('/api/companion/inbox').expect(200);
    expect(inbox.body.pendingReadings).toHaveLength(2);
    // 别人的 404；确认写监测；驳回不写；处理过的再处理 404
    await b1.post(`/api/companion/observations/${bp.id}/confirm`).expect(404);
    await b1.get(`/api/clients/${f.clients.a1[0]}/companion/observations`).expect(404);
    const confirmed = await a1.post(`/api/companion/observations/${bp.id}/confirm`).expect(200);
    expect(confirmed.body.status).toBe('confirmed');
    await a1.post(`/api/companion/observations/${weight.id}/dismiss`).expect(200);
    await a1.post(`/api/companion/observations/${bp.id}/dismiss`).expect(404);
    const readings = await owner
      .selectFrom('monitoring_readings')
      .select(['metric', 'value', 'source'])
      .where('source', '=', 'companion')
      .orderBy('metric', 'desc')
      .execute();
    expect(readings).toEqual([
      { metric: 'sbp', value: '150.000', source: 'companion' },
      { metric: 'dbp', value: '95.000', source: 'companion' },
    ]);
    expect((await a1.get('/api/companion/inbox').expect(200)).body.pendingReadings).toEqual([]);
    // 设备不能直接写收集信息；用别的客户、别的会话调函数都失败
    const idA = await deviceId(SERIAL_A);
    const session = await owner
      .selectFrom('companion_sessions')
      .select('id')
      .where('client_id', '=', f.clients.a1[0])
      .executeTakeFirstOrThrow();
    const items = JSON.stringify([
      { category: 'life', text: '合成', polarity: null, metric: null, values: [] },
    ]);
    await expect(
      withDevice(appDb(), { deviceId: idA }, (trx) =>
        sql`select companion_add_observations(${f.clients.b1}::uuid, ${session.id}::uuid, ${items}::jsonb)`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withDevice(appDb(), { deviceId: idA }, (trx) =>
        trx
          .insertInto('companion_observations')
          .values({ client_id: f.clients.a1[0] } as never)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('验收 15、26：服务器不存音频；一轮含危机描述、测量值和手机号的对话后，日志里搜不到原文、数值和手机号', async () => {
    const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
    const spies = methods.flatMap((m) => [vi.spyOn(Logger.prototype, m), vi.spyOn(Logger, m)]);
    try {
      memoryOutput = {
        memories: [],
        summary: '聊了最近的心情和血压。',
        observations: [
          {
            category: 'measurement',
            text: '客户说昨天量的血压一百五十二、九十六',
            polarity: null,
            metric: 'bp',
            values: [152, 96],
          },
        ],
      };
      const device = await open(await boot(SERIAL_A, keys.a));
      await device.utterance(1);
      modelReply.reply = '我在这儿陪着您，请马上给家人打电话。';
      await turn(device, '我电话13812345678，最近总想着不如死了算了');
      modelReply.reply = '谢谢您告诉我，我记下了。';
      await turn(device, '昨天量的血压152、96');
      await closeAndSettle(device);
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
        .join('\n');
      expect(logged.length).toBeGreaterThan(0);
      for (const secret of ['13812345678', '不如死了', '算了', '152', '一百五十二', '血压']) {
        expect(logged, secret).not.toContain(secret);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
    // 没有任何存音频的列或表：伴侣相关表里的二进制列只有设备密钥和令牌的哈希、密文，也没有名字带 audio 的列
    const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public'
        and (data_type = 'bytea' or column_name ilike '%audio%' or table_name ilike '%audio%')
    `.execute(owner);
    expect(
      columns.rows
        .filter((r) => r.table_name.startsWith('companion'))
        .map((r) => `${r.table_name}.${r.column_name}`)
        .sort(),
    ).toEqual([
      'companion_device_tokens.token_hash',
      'companion_devices.secret_encrypted',
      'companion_devices.secret_hash',
    ]);
    expect(columns.rows.filter((r) => /audio/i.test(r.table_name + r.column_name))).toEqual([]);
  });

  it('聊天和记忆（N10）：只给服务这位客户的健管师看；健管师能删记忆', async () => {
    await owner
      .insertInto('companion_memories')
      .values({ client_id: f.clients.a1[0], text: '客户喜欢听京剧' })
      .execute();
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '今天天气不错');
    await closeAndSettle(device);
    const base = `/api/clients/${f.clients.a1[0]}/companion`;
    const sessions = await a1.get(`${base}/sessions`).expect(200);
    expect(sessions.body.next).toBeNull();
    expect(sessions.body.sessions[0].messages.map((m: { content: string }) => m.content)).toEqual([
      COMPANION_DEFAULT_SCRIPTS.intro,
      '今天天气不错',
      REPLY,
    ]);
    await a1.get(`${base}/sessions?before=not-a-date`).expect(400);
    const memories = await a1.get(`${base}/memories`).expect(200);
    expect(memories.body.memories.map((m: { text: string }) => m.text)).toContain('客户喜欢听京剧');
    const memoryId = memories.body.memories.find(
      (m: { text: string }) => m.text === '客户喜欢听京剧',
    ).id as string;
    const a2 = await loginAs(app, f.users.managerA2.email);
    for (const agent of [b1, a2]) {
      await agent.get(`${base}/sessions`).expect(404);
      await agent.get(`${base}/memories`).expect(404);
      await agent.delete(`${base}/memories/${memoryId}`).expect(404);
    }
    const operator = await loginAs(app, f.users.operatorAdminA.email);
    await operator.get(`${base}/sessions`).expect(404);
    await a1.delete(`${base}/memories/${memoryId}`).expect(204);
    await a1.delete(`${base}/memories/${memoryId}`).expect(404);
  });

  it('设备离线超过 24 小时：今日跟进出现提醒；点“知道了”后消失，再上线又离线时重新提醒', async () => {
    await open(await boot(SERIAL_A, keys.a)).then(closeAndSettle);
    const idA = await deviceId(SERIAL_A);
    await owner
      .updateTable('companion_devices')
      .set({ last_seen_at: new Date(Date.now() - 30 * 3600_000) } as never)
      .where('id', '=', idA)
      .execute();
    const inbox = await a1.get('/api/companion/inbox').expect(200);
    expect(inbox.body.offlineDevices).toEqual([
      expect.objectContaining({ clientId: f.clients.a1[0] }),
    ]);
    expect((await b1.get('/api/companion/inbox').expect(200)).body.offlineDevices).toEqual([]);
    await b1.post(`/api/clients/${f.clients.a1[0]}/companion/offline-ack`).expect(404);
    await a1.post(`/api/clients/${f.clients.a1[0]}/companion/offline-ack`).expect(204);
    expect((await a1.get('/api/companion/inbox').expect(200)).body.offlineDevices).toEqual([]);
    // 再上线后又离线：重新提醒
    await owner
      .updateTable('companion_devices')
      .set({
        last_seen_at: new Date(Date.now() - 25 * 3600_000),
        offline_ack_at: new Date(Date.now() - 26 * 3600_000),
      } as never)
      .where('id', '=', idA)
      .execute();
    expect((await a1.get('/api/companion/inbox').expect(200)).body.offlineDevices).toHaveLength(1);
  });

  it('转交：回复没念完（连接断了）不算已播报，下次唤醒再念；已回复还没播报的可以关闭', async () => {
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '我这个降压药能不能停');
    await turn(device, '最近总是头晕');
    await closeAndSettle(device);
    const [first, second] = (await a1.get('/api/companion/inbox').expect(200)).body.handoffs as {
      id: string;
    }[];
    await a1
      .post(`/api/companion/handoffs/${first!.id}/reply`)
      .send({ text: '王阿姨，这个我们电话里细说。' })
      .expect(200);
    await a1
      .post(`/api/companion/handoffs/${second!.id}/reply`)
      .send({ text: '王阿姨，头晕的事我明天给您打电话。' })
      .expect(200);
    // 已回复、还没播报的可以选“已电话联系”（租户审查 B1）
    const closed = await a1
      .post(`/api/companion/handoffs/${second!.id}/close`)
      .send({ outcome: 'closed_by_call' })
      .expect(200);
    expect(closed.body).toMatchObject({ status: 'closed_by_call', replyText: expect.any(String) });
    // 合成失败：回复没念出来，不标记已播报
    mock.speech = {
      transcript: () => transcript,
      synthesize: (request) => {
        if (request.text.includes('电话里细说')) throw new Error('合成失败');
        return TTS_OGG;
      },
    };
    const again = await open(await boot(SERIAL_A, keys.a));
    await again.utterance(1);
    await closeAndSettle(again);
    const row = await owner
      .selectFrom('companion_handoffs')
      .select(['status', 'delivered_at'])
      .where('id', '=', first!.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'replied', delivered_at: null });
    // 聊天记录里健管师的回复单独标记（合规审查 S6）
    const kinds = await owner
      .selectFrom('companion_messages')
      .select('kind')
      .where('kind', '=', 'handoff_reply')
      .execute();
    expect(kinds.length).toBeGreaterThan(0);
  });

  it('后台角色在所有新接口上都 404；客户转出后转交、预警、收集信息、记忆跟着新健管师走', async () => {
    const client = f.clients.a1[0];
    memoryOutput = {
      memories: ['客户喜欢听京剧'],
      summary: '聊了血压。',
      observations: [
        {
          category: 'measurement',
          text: '客户说昨天血压二百一，一百二十五',
          polarity: null,
          metric: 'bp',
          values: [210, 125],
        },
      ],
    };
    const device = await open(await boot(SERIAL_A, keys.a));
    await device.utterance(1);
    await turn(device, '我这个降压药能不能停');
    modelReply.reply = '我在这儿陪着您，请马上联系家人。';
    await turn(device, '我不想活了');
    await closeAndSettle(device);
    // 闲聊里的数命中危急阈值：也写“危急指标”预警（合规审查 S7）
    const alerts = await owner.selectFrom('companion_alerts').select('category').execute();
    expect(alerts.map((a) => a.category).sort()).toEqual(['crisis', 'critical_value']);

    const inbox = (await a1.get('/api/companion/inbox').expect(200)).body as {
      alerts: { id: string }[];
      handoffs: { id: string }[];
      pendingReadings: { id: string }[];
    };
    const memoryId = (
      await owner.selectFrom('companion_memories').select('id').executeTakeFirstOrThrow()
    ).id;
    const base = `/api/clients/${client}/companion`;
    const admins = await Promise.all([
      loginAs(app, f.users.platform.email),
      loginAs(app, f.users.operatorAdminA.email),
      loginAs(app, f.users.orgAdminA.email),
    ]);
    for (const agent of admins) {
      await agent.get('/api/companion/inbox').expect(404);
      await agent
        .post(`/api/companion/alerts/${inbox.alerts[0]!.id}/handle`)
        .send({ resolution: 'called' })
        .expect(404);
      await agent
        .post(`/api/companion/handoffs/${inbox.handoffs[0]!.id}/reply`)
        .send({ text: '好的' })
        .expect(404);
      await agent
        .post(`/api/companion/handoffs/${inbox.handoffs[0]!.id}/close`)
        .send({ outcome: 'closed' })
        .expect(404);
      await agent
        .post(`/api/companion/observations/${inbox.pendingReadings[0]!.id}/confirm`)
        .expect(404);
      await agent
        .post(`/api/companion/observations/${inbox.pendingReadings[0]!.id}/dismiss`)
        .expect(404);
      for (const path of ['cases', 'observations', 'sessions', 'memories']) {
        await agent.get(`${base}/${path}`).expect(404);
      }
      await agent.delete(`${base}/memories/${memoryId}`).expect(404);
      await agent.post(`${base}/offline-ack`).expect(404);
    }
    await b1
      .post(`/api/companion/observations/${inbox.pendingReadings[0]!.id}/dismiss`)
      .expect(404);
    // 健管师 A2 直接改 A1 的转交、预警：一行都改不到
    const a2ctx = managerCtx(f.users.managerA2, f.operatorA, f.orgA);
    const updated = await withTenant(appDb(), a2ctx, (trx) =>
      trx
        .updateTable('companion_alerts')
        .set({ status: 'handled', resolution: 'called', note: null })
        .executeTakeFirst(),
    );
    expect(Number(updated.numUpdatedRows)).toBe(0);

    // A1 点过“知道了”后转出：新健管师照常看到离线提醒（租户审查 S1）
    const idA = await deviceId(SERIAL_A);
    await owner
      .updateTable('companion_devices')
      .set({ last_seen_at: new Date(Date.now() - 30 * 3600_000) } as never)
      .where('id', '=', idA)
      .execute();
    await a1.post(`${base}/offline-ack`).expect(204);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
      .where('id', '=', client)
      .execute();
    for (const path of ['cases', 'observations', 'sessions', 'memories']) {
      await a1.get(`${base}/${path}`).expect(404);
    }
    const a3 = await loginAs(app, f.users.managerA3.email);
    const moved = (await a3.get('/api/companion/inbox').expect(200)).body;
    expect(moved.alerts).toHaveLength(2);
    expect(moved.handoffs).toHaveLength(1);
    expect(moved.pendingReadings).toHaveLength(1);
    expect(moved.offlineDevices).toHaveLength(1);
    expect((await a3.get(`${base}/memories`).expect(200)).body.memories).toHaveLength(1);
    // 新健管师回复，福宝照常播报
    await a3
      .post(`/api/companion/handoffs/${inbox.handoffs[0]!.id}/reply`)
      .send({ text: '王阿姨，这个我们电话里细说。' })
      .expect(200);
    const again = await open(await boot(SERIAL_A, keys.a));
    const said = await again.utterance(1);
    expect(said.texts.filter((t) => t.state === 'sentence_start').map((t) => t.text)).toContain(
      '王阿姨，这个我们电话里细说。',
    );
    await closeAndSettle(again);
    expect(
      (
        await owner
          .selectFrom('companion_handoffs')
          .select('status')
          .where('id', '=', inbox.handoffs[0]!.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('delivered');
  });
});
