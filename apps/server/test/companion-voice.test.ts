import { MockProvider } from '@health-buddy/ai-engine';
import { COMPANION_DEFAULT_SCRIPTS } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DOWNLINK, encodePcm, UPLINK } from '../src/companion/voice/audio.js';
import { demuxOggOpus, muxOggOpus } from '../src/companion/voice/ogg.js';
import { DB } from '../src/db/db.provider.js';
import { withDevice, withTenant, type Db } from '../src/db/database.js';
import { localDate } from '../src/twin/time-zone.js';
import { ownerDb, PASSWORD, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

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

type Received = { text: Record<string, unknown> } | { binary: Buffer };

/** 设备模拟：连上 /ws/device，收到的消息按顺序排队 */
class FakeDevice {
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];
  closed = false;

  constructor(readonly ws: WebSocket) {
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
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
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
  const mock = new MockProvider('openai');
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
      .post(`${base}/consents`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await agent.post(`${base}/device`).send({ serialNo: serial, activationCode: code }).expect(200);
  };

  beforeAll(async () => {
    app = await createTestApp(
      {},
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
  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
    transcript = '我今天走了五千步';
    mock.speechCalls.length = 0;
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
    expect(reply.texts[2]).toMatchObject({
      type: 'tts',
      state: 'sentence_start',
      text: COMPANION_DEFAULT_SCRIPTS.daily_intro,
    });
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
    expect(
      usage.map((u) => u.route).every((r) => r === 'speech_to_text' || r === 'text_to_speech'),
    ).toBe(true);
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
    expect(reply.texts.find((t) => t.state === 'sentence_start')!.text).toBe(
      COMPANION_DEFAULT_SCRIPTS.daily_intro,
    );
    second.speak(SILENCE_FRAMES);
    second.send({ type: 'listen', state: 'start', mode: 'auto' });
    second.speak([...SPEECH_FRAMES, ...SILENCE_FRAMES]);
    await second.utterance(2);
    // 每句话术最多合成一次（之后用缓存）
    const tts = mock.speechCalls
      .filter((c) => c.request.route === 'text_to_speech')
      .map((c) => (c.request as { text: string }).text);
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
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents/revoke`)
      .send({ revokedOn: TODAY })
      .expect(200);
    const revoked = await open(token);
    expect((await revoked.utterance(1)).texts[1]!.text).toBe(COMPANION_DEFAULT_SCRIPTS.paused);
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
      .post(`/api/clients/${f.clients.a1[1]}/companion/consents`)
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
    // 应用角色读不到令牌表和设备密钥密文
    await expect(sql`select * from companion_device_tokens`.execute(appDb())).rejects.toThrow();
    await expect(
      sql`select secret_encrypted from companion_devices`.execute(appDb()),
    ).rejects.toThrow();
    expect(tokenB).not.toBe(tokenA);
  });
});
