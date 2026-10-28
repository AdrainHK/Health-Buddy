/**
 * Ogg Opus 的封装和拆封（RFC 7845）。设备发来、播放用的都是裸 Opus 帧（xiaozhi 协议 v1），
 * 语音识别接口要 Ogg 文件，语音合成接口返回 Ogg 文件，在这里转换。只处理单声道、单个逻辑流。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
/** 每页最多 255 段；每页放的包少一些，页不至于太大 */
const PACKETS_PER_PAGE = 50;

function page(
  packets: Uint8Array[],
  flags: number,
  granule: bigint,
  serial: number,
  sequence: number,
): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('ogg page has too many segments');
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const out = Buffer.concat([header, ...packets]);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

export interface OggOpusInfo {
  /** 编码前的采样率（OpusHead 里的 input sample rate），只作参考 */
  sampleRate: number;
  /** 每帧的毫秒数，用来算 granule position */
  frameDurationMs: number;
}

/** 裸 Opus 帧 → Ogg Opus 文件 */
export function muxOggOpus(packets: Uint8Array[], info: OggOpusInfo): Buffer {
  const serial = 0x48420001;
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1; // 版本
  head[9] = 1; // 声道
  head.writeUInt16LE(0, 10); // pre-skip
  head.writeUInt32LE(info.sampleRate, 12);
  head.writeInt16LE(0, 16); // 输出增益
  head[18] = 0; // 声道映射
  const vendor = Buffer.from('health-buddy', 'ascii');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  // granule position 按 48 kHz 计
  const samplesPerFrame = BigInt(Math.round(48 * info.frameDurationMs));
  const pages = [page([head], FLAG_BOS, 0n, serial, 0), page([tags], 0, 0n, serial, 1)];
  let seq = 2;
  let granule = 0n;
  for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
    const chunk = packets.slice(i, i + PACKETS_PER_PAGE);
    granule += samplesPerFrame * BigInt(chunk.length);
    const last = i + PACKETS_PER_PAGE >= packets.length;
    pages.push(page(chunk, last ? FLAG_EOS : 0, granule, serial, seq++));
  }
  if (packets.length === 0) pages.push(page([], FLAG_EOS, 0n, serial, seq));
  return Buffer.concat(pages);
}

/** Ogg Opus 文件 → 裸 Opus 帧（去掉 OpusHead、OpusTags）。格式不对时抛错，错误里不带内容 */
export function demuxOggOpus(data: Uint8Array): Uint8Array[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const packets: Uint8Array[] = [];
  let pending: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 27 > buf.length || buf.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error('invalid ogg page');
    }
    const flags = buf[offset + 5]!;
    const segments = buf[offset + 26]!;
    const tableStart = offset + 27;
    let bodyOffset = tableStart + segments;
    if (bodyOffset > buf.length) throw new Error('invalid ogg page');
    if (!(flags & FLAG_CONTINUED) && pending.length) pending = [];
    for (let i = 0; i < segments; i++) {
      const len = buf[tableStart + i]!;
      if (bodyOffset + len > buf.length) throw new Error('invalid ogg page');
      pending.push(buf.subarray(bodyOffset, bodyOffset + len));
      bodyOffset += len;
      if (len < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    offset = bodyOffset;
  }
  const isHeader = (p: Uint8Array, magic: string) =>
    p.length >= 8 && Buffer.from(p.subarray(0, 8)).toString('ascii') === magic;
  return packets.filter((p) => !isHeader(p, 'OpusHead') && !isHeader(p, 'OpusTags'));
}
