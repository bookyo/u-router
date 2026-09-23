'use strict';
// GRF 提取器（移植 roBrowser GameFile.js / GameFileDecrypt.js）
// 用法：
//   node grf-extract.js list      # (GRF 路径在脚本顶部常量)                    # 列出全部文件
//   node grf-extract.js find <regex>            # 按正则搜文件
//   node grf-extract.js get <grf内路径> <输出>   # 提取单文件
const fs = require('fs');
const zlib = require('zlib');

const GRF_PATH = '/Users/quyue/Downloads/LRO/LRO_Data/StreamingAssets/data.grf';
const CMD = process.argv[2] || 'list';

// ---------- DES 解密（roBrowser GameFileDecrypt） ----------
const mask = new Uint8Array([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]);
const tmp = new Uint8Array(8), tmp2 = new Uint8Array(8), clean = new Uint8Array(8);
const ipTable = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const fpTable = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const tpTable = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const sbox = [
  [0xef,0x03,0x41,0xfd,0xd8,0x74,0x1e,0x47,0x26,0xef,0xfb,0x22,0xb3,0xd8,0x84,0x1e,0x39,0xac,0xa7,0x60,0x62,0xc1,0xcd,0xba,0x5c,0x96,0x90,0x59,0x05,0x3b,0x7a,0x85,0x40,0xfd,0x1e,0xc8,0xe7,0x8a,0x8b,0x21,0xda,0x43,0x64,0x9f,0x2d,0x14,0xb1,0x72,0xf5,0x5b,0xc8,0xb6,0x9c,0x37,0x76,0xec,0x39,0xa0,0xa3,0x05,0x52,0x6e,0x0f,0xd9],
  [0xa7,0xdd,0x0d,0x78,0x9e,0x0b,0xe3,0x95,0x60,0x36,0x36,0x4f,0xf9,0x60,0x5a,0xa3,0x11,0x24,0xd2,0x87,0xc8,0x52,0x75,0xec,0xbb,0xc1,0x4c,0xba,0x24,0xfe,0x8f,0x19,0xda,0x13,0x66,0xaf,0x49,0xd0,0x90,0x06,0x8c,0x6a,0xfb,0x91,0x37,0x8d,0x0d,0x78,0xbf,0x49,0x11,0xf4,0x23,0xe5,0xce,0x3b,0x55,0xbc,0xa2,0x57,0xe8,0x22,0x74,0xce],
  [0x2c,0xea,0xc1,0xbf,0x4a,0x24,0x1f,0xc2,0x79,0x47,0xa2,0x7c,0xb6,0xd9,0x68,0x15,0x80,0x56,0x5d,0x01,0x33,0xfd,0xf4,0xae,0xde,0x30,0x07,0x9b,0xe5,0x83,0x9b,0x68,0x49,0xb4,0x2e,0x83,0x1f,0xc2,0xb5,0x7c,0xa2,0x19,0xd8,0xe5,0x7c,0x2f,0x83,0xda,0xf7,0x6b,0x90,0xfe,0xc4,0x01,0x5a,0x97,0x61,0xa6,0x3d,0x40,0x0b,0x58,0xe6,0x3d],
  [0x4d,0xd1,0xb2,0x0f,0x28,0xbd,0xe4,0x78,0xf6,0x4a,0x0f,0x93,0x8b,0x17,0xd1,0xa4,0x3a,0xec,0xc9,0x35,0x93,0x56,0x7e,0xcb,0x55,0x20,0xa0,0xfe,0x6c,0x89,0x17,0x62,0x17,0x62,0x4b,0xb1,0xb4,0xde,0xd1,0x87,0xc9,0x14,0x3c,0x4a,0x7e,0xa8,0xe2,0x7d,0xa0,0x9f,0xf6,0x5c,0x6a,0x09,0x8d,0xf0,0x0f,0xe3,0x53,0x25,0x95,0x36,0x28,0xcb],
];
function permute(src, index, table) {
  for (let i = 0; i < table.length; ++i) {
    const j = table[i] - 1;
    if (src[index + ((j >> 3) & 7)] & mask[j & 7]) tmp[(i >> 3) & 7] |= mask[i & 7];
  }
  src.set(tmp, index); tmp.set(clean);
}
function transposition(src, index) {
  for (let i = 0; i < 32; ++i) {
    const j = tpTable[i] - 1;
    if (src[index + (j >> 3)] & mask[j & 7]) tmp[(i >> 3) + 4] |= mask[i & 7];
  }
  src.set(tmp, index); tmp.set(clean);
}
function expansion(src, index) {
  tmp[0] = ((src[index + 7] << 5) | (src[index + 4] >> 3)) & 0x3f;
  tmp[1] = ((src[index + 4] << 1) | (src[index + 5] >> 7)) & 0x3f;
  tmp[2] = ((src[index + 4] << 5) | (src[index + 5] >> 3)) & 0x3f;
  tmp[3] = ((src[index + 5] << 1) | (src[index + 6] >> 7)) & 0x3f;
  tmp[4] = ((src[index + 5] << 5) | (src[index + 6] >> 3)) & 0x3f;
  tmp[5] = ((src[index + 6] << 1) | (src[index + 7] >> 7)) & 0x3f;
  tmp[6] = ((src[index + 6] << 5) | (src[index + 7] >> 3)) & 0x3f;
  tmp[7] = ((src[index + 7] << 1) | (src[index + 4] >> 7)) & 0x3f;
  src.set(tmp, index); tmp.set(clean);
}
function substitutionBox(src, index) {
  for (let i = 0; i < 4; ++i) {
    tmp[i] = (sbox[i][src[i * 2 + index]] & 0xf0) | (sbox[i][src[i * 2 + 1 + index]] & 0x0f);
  }
  src.set(tmp, index); tmp.set(clean);
}
function roundFunction(src, index) {
  for (let i = 0; i < 8; i++) tmp2[i] = src[index + i];
  expansion(tmp2, 0); substitutionBox(tmp2, 0); transposition(tmp2, 0);
  src[index + 0] ^= tmp2[4]; src[index + 1] ^= tmp2[5];
  src[index + 2] ^= tmp2[6]; src[index + 3] ^= tmp2[7];
}
function decryptBlock(src, index) {
  permute(src, index, ipTable);
  roundFunction(src, index);
  permute(src, index, fpTable);
}
const shuffleTable = (() => {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; ++i) out[i] = i;
  const list = [0x00, 0x2b, 0x6c, 0x80, 0x01, 0x68, 0x48, 0x77, 0x60, 0xff, 0xb9, 0xc0, 0xfe, 0xeb];
  for (let i = 0; i < list.length; i += 2) { out[list[i + 1]] = list[i]; out[list[i]] = list[i + 1]; }
  return out;
})();
function shuffleDec(src, index) {
  tmp[0] = src[index + 3]; tmp[1] = src[index + 4]; tmp[2] = src[index + 6];
  tmp[3] = src[index + 0]; tmp[4] = src[index + 1]; tmp[5] = src[index + 2];
  tmp[6] = src[index + 5]; tmp[7] = shuffleTable[src[index + 7]];
  src.set(tmp, index); tmp.set(clean);
}
function decodeFull(buf, len, entryLen) {
  const nblocks = len >> 3;
  const digits = String(entryLen).length;
  const cycle = digits < 3 ? 3 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15;
  for (let i = 0; i < 20 && i < nblocks; ++i) decryptBlock(buf, i * 8);
  for (let i = 20, j = 0; i < nblocks; ++i) {
    if (i % cycle === 0) { decryptBlock(buf, i * 8); continue; }
    if (j === 7) { shuffleDec(buf, i * 8); j = 0; }
    j++;
  }
}
function decodeHeader(buf, len) {
  const nblocks = len >> 3;
  for (let i = 0; i < 20 && i < nblocks; ++i) decryptBlock(buf, i * 8);
}

// ---------- GRF 读取 ----------
const fd = fs.openSync(GRF_PATH, 'r');
const fsize = fs.fstatSync(fd).size;
function readAt(pos, len) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  return buf;
}
const header = readAt(0, 0x2e);
if (header.slice(0, 15).toString() !== 'Master of Magic') throw new Error('非 GRF 文件');
const tableOffset = header.readUInt32LE(0x1e);
const skip = header.readUInt32LE(0x22);
let fileCount = header.readUInt32LE(0x26);
const version = header.readUInt32LE(0x2a);
fileCount -= skip + 7;
console.error(`GRF v0x${version.toString(16)} 文件数 ${fileCount} 表@0x${tableOffset.toString(16)} 总 ${(fsize / 1e9).toFixed(2)}GB`);

const tbl = readAt(tableOffset + 0x2e, 8);
const packSize = tbl.readUInt32LE(0), realSize = tbl.readUInt32LE(4);
const out = zlib.inflateSync(readAt(tableOffset + 0x2e + 8, packSize));
if (out.length < realSize) throw new Error(`表解压不足 ${out.length}/${realSize}`);

const entries = new Map();
let pos = 0;
for (let i = 0; i < fileCount; i++) {
  const start = pos;
  while (out[pos]) pos++;
  const name = out.slice(start, pos).toString('utf8');
  pos++;
  const pack = out.readInt32LE(pos); pos += 4;
  const aligned = out.readInt32LE(pos); pos += 4;
  const real = out.readInt32LE(pos); pos += 4;
  const type = out[pos]; pos += 1;
  const off = out.readUInt32LE(pos); pos += 4;
  entries.set(name.toLowerCase(), { name, pack, aligned, real, type, off: off + 0x2e });
}

function extract(entry) {
  let data = readAt(entry.off, entry.aligned);
  if (entry.type & 0x02) { // ENCRYPT_MIXED
    if (/\.(gnd|gat|act|str)$/i.test(entry.name)) decodeHeader(data, entry.aligned);
    else decodeFull(data, entry.aligned, entry.pack);
  } else if (entry.type & 0x04) { // ENCRYPT_HEADER
    decodeHeader(data, entry.aligned);
  }
  // 头两字节检查 zlib 魔数（0x200 的 type 1 文件本身即 zlib）
  if (data[0] === 0x78 && (data[1] === 0x9c || data[1] === 0x01 || data[1] === 0xda || data[1] === 0x5e)) {
    return zlib.inflateSync(data);
  }
  return data;
}

if (CMD === 'list') {
  for (const e of entries.keys()) console.log(e);
} else if (CMD === 'find') {
  const re = new RegExp(process.argv[3] || '.', 'i');
  for (const e of entries.keys()) if (re.test(e)) console.log(e);
} else if (CMD === 'get') {
  const key = (process.argv[3] || '').toLowerCase();
  const e = entries.get(key);
  if (!e) { console.error('未找到: ' + key); process.exit(1); }
  fs.writeFileSync(process.argv[4] || 'grf-out.bin', extract(e));
  console.error(`已提取 ${e.name} (${e.real}B)`);
}
