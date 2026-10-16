declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer | Uint8Array>;
  export default convert;
}
