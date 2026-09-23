'use strict';
// 二进制读写工具，字段顺序/字节序与 roBrowser Utils/BinaryWriter 一致（小端）
class BinaryWriter {
  constructor(size) {
    this.buf = Buffer.alloc(size);
    this.pos = 0;
  }
  writeShort(v) { this.buf.writeUInt16LE(v & 0xffff, this.pos); this.pos += 2; return this; }
  writeUShort(v) { return this.writeShort(v); }
  writeLong(v) { this.buf.writeInt32LE(v | 0, this.pos); this.pos += 4; return this; }
  writeULong(v) { this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; return this; }
  writeUChar(v) { this.buf.writeUInt8(v & 0xff, this.pos); this.pos += 1; return this; }
  // 定长字符串（GBK，不足补 0）
  writeString(s, len) {
    const b = require('iconv-lite').encode(s, 'gbk');
    this.buf.fill(0, this.pos, this.pos + len);
    b.copy(this.buf, this.pos, 0, Math.min(b.length, len));
    this.pos += len;
    return this;
  }
  // RO 12-bit 坐标（低 4 位是方向），big-endian 布局：b0=x>>2, b1=(x&3)<<6|y>>4, b2=(y&15)<<4
  writePos(x, y, dir = 0) {
    this.buf.writeUInt8((x >> 2) & 0xff, this.pos);
    this.buf.writeUInt8((((x & 3) << 6) | (y >> 4)) & 0xff, this.pos + 1);
    this.buf.writeUInt8((((y & 15) << 4) | (dir & 15)) & 0xff, this.pos + 2);
    this.pos += 3;
    return this;
  }
  get buffer() { return this.buf; }
}

class BinaryReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  tell() { return this.pos; }
  seek(n, whence = 0) { this.pos = whence ? this.pos + n : n; return this; }
  get rest() { return this.buf.length - this.pos; }
  readUChar() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  readChar() { const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  readShort() { const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  readUShort() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  readLong() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  readULong() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  readBinaryString(len) { const v = this.buf.toString('latin1', this.pos, this.pos + len).replace(/\0+$/, ''); this.pos += len; return v; }
  // GBK 字符串读到 \0 或末尾
  readString(maxLen) {
    const end = maxLen == null ? this.buf.length : Math.min(this.buf.length, this.pos + maxLen);
    let z = this.buf.indexOf(0, this.pos);
    if (z < 0 || z > end) z = end;
    const v = require('iconv-lite').decode(this.buf.slice(this.pos, z), 'gbk');
    this.pos = maxLen == null ? end : this.pos + maxLen;
    return v;
  }
  // 单坐标：低4位方向，中10位y，高10位x
  readPos() {
    const b0 = this.readUChar(), b1 = this.readUChar(), b2 = this.readUChar();
    const a = ((b0 << 16) | (b1 << 8) | b2) >>> 0;
    const dir = a & 15;
    const v = a >>> 4;
    return [ (v >>> 10) & 0x3ff, v & 0x3ff, dir ];
  }
  // 双坐标（移动确认封包：起点+终点），逐字节对照 roBrowser readPos2
  readPos2() {
    const a = this.readUChar(), d = this.readUChar(), b = this.readUChar();
    const c = this.readUChar(), e = this.readUChar(); this.readUChar();
    return [
      ((a & 255) << 2) | ((d & 192) >> 6),   // x1
      ((d & 63) << 4) | ((b & 240) >> 4),    // y1
      ((c & 252) >> 2) | ((b & 15) << 6),    // x2
      ((c & 3) << 8) | (e & 255),            // y2
    ];
  }
}

module.exports = { BinaryReader, BinaryWriter };
