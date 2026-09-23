'use strict';
// 最小探针：进图 → PIN → 单步走路，验证移动是否被服务器接受
const { ROClient } = require('./lib/client');
const OPT = {
  account: process.env.RO_USER || 'xiezixing',
  password: process.env.RO_PASS || '',
  charSlot: parseInt(process.env.RO_CHAR || '0', 10),
  line: process.env.RO_LINE || 'eden',
};
const TX = parseInt(process.env.RO_TX || '110', 10);
const TY = parseInt(process.env.RO_TY || '55', 10);

const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
let attempts = 0;
function startLogin() {
  attempts++;
  console.log(`--- 第 ${attempts} 次尝试 ---`);
  c.login().catch((e) => { console.error('连接失败:', e.message); process.exit(1); });
}
process.on('uncaughtException', (e) => { console.error('[崩溃]', e.message); try { c.close(); } catch (_) {} setTimeout(() => process.exit(1), 400); });
process.on('SIGINT', () => { c.close(); setTimeout(() => process.exit(0), 400); });
process.on('exit', () => {
  const cc = c.packetCounts || {};
  console.log('收包:', Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `0x${(+k).toString(16)}×${v}`).join(' '));
});

c.on('login_refuse', (p) => { console.log(`拒绝 code=${p.ErrorCode} from=${p.from}`); if (attempts < 8) return setTimeout(startLogin, p.from === 'zone' ? 75000 : 30000); process.exit(1); });
c.on('banned', (p) => { console.log('被踢', p.code); if (attempts < 8 && p.code === 8) return setTimeout(startLogin, 30000); process.exit(1); });

c.on('login_ok', (p) => {
  const srv = p.ServerList[0];
  if (!srv) process.exit(1);
  c.connectChar(srv.ipStr, srv.port).catch((e) => { console.error(e.message); process.exit(1); });
});
c.on('char_list', (p) => {
  const mine = p.chars.find((ch) => ch.CharNum === OPT.charSlot) || p.chars[0];
  c.session.charName = mine.name;
  console.log(`选角 ${mine.name}`);
  c.selectChar(mine.CharNum);
});
c.on('zone_info', (p) => { c.connectZone(p.ipStr, p.port).catch((e) => { console.error(e.message); process.exit(1); }); });

let pos = null;
c.on('map_enter', (p) => {
  pos = [p.pos[0], p.pos[1]];
  console.log(`进图 ${c.mapName} @ (${pos})`);
  setTimeout(() => {
    c.mapLoaded();
    console.log('ACTORINIT 已发');
    setTimeout(() => {
      if (process.env.RO_MODE === 'airship-same') {
        // 同图飞艇定位测试：飞到当前地图的指定坐标
        const map = (c.mapName || '').replace(/\.gat$/i, '');
        console.log(`🚌 同图飞艇测试: ${map} (${TX},${TY})`);
        c.airshipTeleport(map, TX, TY);
        setTimeout(() => {
          console.log(`\n结果: 当前位置 (${pos}) 目标 (${TX},${TY}) ${pos[0] === TX && pos[1] === TY ? '✅ 同图定位传送成功' : '❌ 未生效'}`);
          c.close(); setTimeout(() => process.exit(0), 2200);
        }, 12000);
        return;
      }
      if (process.env.RO_MODE === 'flywing') {
        // 苍蝇翅膀/瞬移测试：用道具 14527 → 等 WARPLIST → 选当前图
        const map = (c.mapName || '').replace(/\.gat$/i, '');
        const fw = (c.inventory || []).find((it) => it.ITID === 14527);
        if (!fw) {
          console.log(`❌ 背包没有苍蝇翅膀(14527)。物品栏 ${ (c.inventory || []).length } 件：`);
          (c.inventory || []).slice(0, 15).forEach((it) => console.log(`   index=${it.index} ITID=${it.ITID} x${it.count}`));
          return finish0();
        }
        console.log(`🪰 使用苍蝇翅膀 index=${fw.index} x${fw.count} @ ${map} 当前 (${pos})`);
        c.send(require('./lib/protocol').BUILD.useItem(fw.index, c.session.AID));
        // 15 秒观察：WARPLIST 到达则选当前图
        c.on('warp_list', (p) => {
          console.log(`   收到 WARPLIST，选择当前图 [${map}]`);
          setTimeout(() => c.send(require('./lib/protocol').BUILD.selectWarppoint(p.SKID, map)), 800);
        });
        setTimeout(() => {
          console.log(`\n结果: 位置 (${pos}) ${pos[0] === TX && pos[1] === TY ? '✅ 到达目标' : `未到目标(${TX},${TY}) — 看是否随机/原地`}`);
          finish0();
        }, 15000);
        return;
      }
      if (process.env.RO_MODE === 'cmd') {
        // @命令探测：批量发送候选命令，观察服务器回复与瞬移
        const cands = (process.env.RO_CMDS || '@jump 160 100|@move 160 100|@tp 160 100|@fly 160 100|@go 0|@rura morocc 160 100|@warp morocc 160 100|@help|@commands').split('|');
        let i = 0;
        const map0 = (c.mapName || '').replace(/\.gat$/i, '');
        const pos0 = [...pos];
        console.log(`🧪 @命令探测 @ ${map0} (${pos0}) 目标附近 (160,100)`);
        const next = () => {
          if (i >= cands.length) {
            console.log(`\n结果: 位置 (${pos}) [起点 (${pos0})] ${JSON.stringify(pos) !== JSON.stringify(pos0) ? '⚡有瞬移发生' : '无位移'}`);
            return finish0();
          }
          const cmd = cands[i++];
          console.log(`\n> ${cmd}`);
          c.chat(cmd);
          setTimeout(next, 3500);
        };
        setTimeout(next, 500);
        return;
      }
      if (process.env.RO_MODE === 'skill') {
        // 瞬间移动技能测试：USE_SKILL(26) → 观察 WARPLIST/直接瞬移
        const map = (c.mapName || '').replace(/\.gat$/i, '');
        console.log(`🌀 使用瞬间移动技能(26) @ ${map} (${pos})`);
        c.send(require('./lib/protocol').BUILD.useSkill(26, 1, c.session.GID));
        c.on('warp_list', (p) => {
          console.log(`   → 收到列表，选当前图 [${map}]`);
          setTimeout(() => c.send(require('./lib/protocol').BUILD.selectWarppoint(p.SKID, map)), 800);
        });
        setTimeout(() => {
          console.log(`\n结果: (${pos}) [起点见上] ${pos[0] !== 140 || pos[1] !== 90 ? '⚡ 发生瞬移' : '原地'}`);
          finish0();
        }, 15000);
        return;
      }
      if (process.env.RO_MODE === 'airship2') {
        // 同图飞艇 type 变体测试
        const map = (c.mapName || '').replace(/\.gat$/i, '');
        const variants = [
          ['type=0 无坐标', [map, 0, 0, 0]],
          ['type=2 带坐标', [map, TX, TY, 2]],
          ['type=3 带坐标', [map, TX, TY, 3]],
          ['type=1 带坐标(复测)', [map, TX, TY, 1]],
        ];
        let i = 0;
        const pos0 = [...pos];
        console.log(`🚌 同图飞艇变体测试 @ ${map} (${pos0}) → (${TX},${TY})`);
        const next = () => {
          if (i >= variants.length) {
            console.log(`\n结果: (${pos}) [起点 (${pos0})] ${JSON.stringify(pos) !== JSON.stringify(pos0) ? '⚡ 有瞬移' : '全部无效'}`);
            return finish0();
          }
          const [label, args] = variants[i++];
          console.log(`\n> ${label}`);
          c.send(require('./lib/protocol').BUILD.airshipRequest(...args));
          setTimeout(next, 4000);
        };
        setTimeout(next, 500);
        return;
      }
      if (process.env.RO_MODE === 'skills') {
        // 打印技能表+快捷栏，找蝴蝶卡瞬间移动的真实 SKID
        setTimeout(() => {
          const iconv = require('iconv-lite');
          console.log(`\n📚 技能列表 (${(c.skills || []).length}):`);
          (c.skills || []).forEach((s) => console.log(`   SKID=${s.SKID} Lv${s.level} type=${s.type} range=${s.attackRange} sp=${s.spcost} ${iconv.decode(Buffer.from(s.name, 'latin1'), 'gbk')}`));
          console.log(`\n⌨ 快捷栏:`);
          (c.shortcuts ? c.shortcuts.keys : []).forEach((k, i) => { if (k.ID) console.log(`   [${i}] ${k.isSkill ? '技能' : '物品'} ID=${k.ID} x${k.count}`); });
          finish0();
        }, 6000);
        return;
      }
      if (process.env.RO_MODE === 'skill2') {
        // 定位瞬移变体测试：地面版技能 / 直接选图 / 等级2
        const map = (c.mapName || '').replace(/\.gat$/i, '');
        const B = require('./lib/protocol').BUILD;
        console.log(`🎯 定位瞬移变体 @ ${map} (${pos}) → 固定目标 (${TX},${TY})`);
        const steps = [
          ['USE_SKILL_TOGROUND(26,1,x,y)', () => { const w = new (require('./lib/binary').BinaryWriter)(10); w.writeShort(0x0366); w.buf.writeInt16LE(1, 2); w.buf.writeInt16LE(26, 4); w.buf.writeInt16LE(TX, 6); w.buf.writeInt16LE(TY, 8); c.send(w.buffer); }],
          ['SELECT_WARPPOINT(26,当前图)', () => c.send(B.selectWarppoint(26, map))],
          ['USE_SKILL(26,2,self)', () => c.send(B.useSkill(26, 2, c.session.GID))],
        ];
        let i = 0;
        const next = () => {
          if (i >= steps.length) {
            console.log(`\n结果: 最终 (${pos})`);
            return finish0();
          }
          const [label, fn] = steps[i++];
          console.log(`\n> ${label}  [当前 (${pos})]`);
          fn();
          setTimeout(next, 5000);
        };
        setTimeout(next, 500);
        c.on('warp_list', (p) => console.log(`   ⚠ 收到 WARPLIST SKID=${p.SKID}: ${p.mapName.filter(Boolean).join(',')}`));
        return;
      }
      console.log(`尝试单步走路 → (${TX},${TY})`);
      c.send(require('./lib/protocol').BUILD.requestAct(0, 3)); // 站起
      setTimeout(() => {
        c.walk(TX, TY);
        console.log('walk 已发，等 0x0087 ...');
      }, 600);
    }, 2500);
  }, 500);
});
c.on('self_move', (p) => {
  pos = [p.move[2], p.move[3]];
  console.log(`✅ 移动确认 → (${pos[0]},${pos[1]})`);
  if (!process.env.RO_MODE) setTimeout(() => { c.close(); setTimeout(() => process.exit(0), 2200); }, 1200);
});
function finish0() { c.close(); setTimeout(() => process.exit(0), 2200); }
c.on('warp_map', (p) => { pos = [p.xPos, p.yPos]; });
c.on('disconnect', () => { console.log('[断开]'); });
setTimeout(() => { console.log('[超时窗口结束]'); try { c.close(); } catch (_) {} setTimeout(() => process.exit(0), 2500); }, parseInt(process.env.RO_SECONDS || '300', 10) * 1000);
startLogin();
