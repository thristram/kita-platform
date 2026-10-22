export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** Builds a portable ZIP using the STORE method so raw HTML remains byte-for-byte unchanged. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const normalized = entries.map((entry) => ({
    name: encoder.encode(entry.name.replaceAll("\\", "/").replace(/^\/+/, "")),
    data: typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data,
  }));
  const localSize = normalized.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = normalized.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of normalized) {
    offsets.push(offset);
    const checksum = crc32(entry.data);
    write32(view, offset, 0x04034b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 0x0800);
    write16(view, offset + 8, 0);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, 0x0021);
    write32(view, offset + 14, checksum);
    write32(view, offset + 18, entry.data.length);
    write32(view, offset + 22, entry.data.length);
    write16(view, offset + 26, entry.name.length);
    write16(view, offset + 28, 0);
    output.set(entry.name, offset + 30);
    output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }

  const centralOffset = offset;
  normalized.forEach((entry, index) => {
    const checksum = crc32(entry.data);
    write32(view, offset, 0x02014b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 20);
    write16(view, offset + 8, 0x0800);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, 0);
    write16(view, offset + 14, 0x0021);
    write32(view, offset + 16, checksum);
    write32(view, offset + 20, entry.data.length);
    write32(view, offset + 24, entry.data.length);
    write16(view, offset + 28, entry.name.length);
    write16(view, offset + 30, 0);
    write16(view, offset + 32, 0);
    write16(view, offset + 34, 0);
    write16(view, offset + 36, 0);
    write32(view, offset + 38, 0);
    write32(view, offset + 42, offsets[index]);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });

  write32(view, offset, 0x06054b50);
  write16(view, offset + 4, 0);
  write16(view, offset + 6, 0);
  write16(view, offset + 8, normalized.length);
  write16(view, offset + 10, normalized.length);
  write32(view, offset + 12, centralSize);
  write32(view, offset + 16, centralOffset);
  write16(view, offset + 20, 0);
  return output;
}
