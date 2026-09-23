'use strict';
// 地图服务器方向封包 ID 混淆（roBrowser Network/PacketCrypt）
// 仅对【发送】封包的前 2 字节做流式 XOR；接收方向不加密。
// 密钥组：客户端里存在两组（按 ClientVer 区分），本服用哪组需实测
const KEYSETS = {
  A: [1205481659, 453061308, 592073252],  // ClientVer==3 分支（实测 Eden 线路不用这组）
  B: [1205481659, 453065404, 592073252],  // 实测 V6-Eden 在用（0x0436→0x447D 已对真值验证）
};
class PacketCrypt {
  constructor(keys) {
    this.keys = (keys && [...keys]) || [...KEYSETS.B];
    this.enabled = false;
  }
  setKeys(name) { this.keys = [...KEYSETS[name]]; }
  init() { this.enabled = true; }
  reset() { this.enabled = false; }
  // V6 服务器实际只按流式掩码解前几个认证包，之后的包按【收敛不动点掩码】解
  // （实证：keys B 的流在第 16 次推进后收敛到 0x5945，浏览器所有游戏期封包均用该掩码且被接受）
  converge() {
    let prev = -1;
    for (let i = 0; i < 64; i++) {
      this.keys[0] = (this.imul(this.keys[0], this.keys[1]) + this.keys[2]) >>> 0;
      const mask = (this.keys[0] >>> 16) & 0x7fff;
      if (mask === prev && (this.keys[0] === this.prevK0)) break;
      prev = mask; this.prevK0 = this.keys[0];
    }
  }
  // 与 Math.imul 语义一致的 32 位乘法
  imul(a, b) {
    const aLo = a & 0xffff, aHi = a >>> 16, bLo = b & 0xffff, bHi = b >>> 16;
    return (aLo * bLo + (((aHi * bLo + aLo * bHi) << 16) >>> 0)) >>> 0;
  }
  // buf 为完整封包 Buffer，原地混淆前 2 字节
  process(buf) {
    if (!this.enabled) return;
    const k = this.keys;
    k[0] = (this.imul(k[0], k[1]) + k[2]) >>> 0;
    const d = buf.readInt16LE(0);
    const out = (d ^ ((k[0] >>> 16) & 0x7fff)) & 0xffff;
    buf.writeUInt16LE(out, 0);
  }
}
module.exports = { PacketCrypt, KEYSETS };
