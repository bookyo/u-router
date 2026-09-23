'use strict';
/**
 * V6 内挂设置完整控制（2026-09-19 从 Online_mn.js 客户端 UI 代码逆向实证）
 * ============================================================
 * 机制：所有设置共用一个包 0x0AFE (u8 id + i32 value)，服务器逐项回 0x0AF6 同构包；
 *       定向怪物走 0x0AFD (u32 mobID + u8 1加/0移)，回执 0x0AF1；
 *       登录时服务器 0x0AF5 全量下发（58B）。
 * id 映射（switch(a.id) 完整提取）：
 *   0  被非目标魔物攻击时(下拉: 瞬移/无视…)      1  与目标攻击距离 d>=(格)
 *   2  与目标施法距离 d>=(格)                    3  自动瞬移间隔(秒)
 *   4  优先使用HP转换(开)                        5  附近BOSS自动瞬移(开)
 *   6  被群殴数量最小值 n>= 技能解围             7  被群殴数量最大值 n>= 自动瞬移
 *   8  优先使用治愈术(开)                        9  HP少于x%自动瞬移
 *   10 SP少于x%自动瞬移                         11 HP少于x%强制下线
 *   12 自动使用缰绳(开)                         13 找不到宠物饲料(下拉)
 *   14 自动坐下(开)                             15 坐下HP范围下限%
 *   16 坐下SP范围下限%                          17 坐下HP恢复上限%
 *   18 坐下SP恢复上限%                          19 坐下时被锁定(还击/无视)
 *   20 拾取概率%(拾取概率为x%以下的物品)         21 加血范围 血量低于x%
 *   22 加气范围 气量低于x%                      23 AutoUseItem_jsys(复选)
 *   24 属性转换药(开)                           25 万能药(开)
 *   26 齐格弗里德(开)                           27 跟随状态(下拉)
 *   28 跟随模式(下拉)                           29 跟随距离(格)
 *   30 无法瞬移时(下拉: 无视…)                  31 保护队员HP阈值
 *   32 保护队员SP阈值                           33 属性转换药选择(ITID)
 *   34 自动战斗开关                             35 自动拾取开关
 *   36 自动吃药开关                             37 跟随战斗开关
 *   38 寻怪模式(移动寻怪…)                      39 主动技能ID(技能ID)
 *   40 主动技能等级                             41 主动技能概率%
 *   42 触发技能ID                               43 触发技能开启
 *   44 解围技能ID                               45 解围技能等级
 *   46 HP药品(1) ITID    47 HP药品(2) ITID      48 HP药品(3) ITID
 *   49 SP药品(1) ITID    50 SP药品(2) ITID      51 SP药品(3) ITID
 *   52 AutoUseItem_Protection(复选)             53 辅助技能ID(279/2286 特殊UI)
 *   54 辅助技能等级                             55 辅助技能开启
 *   56 战斗模式(输出…)                          57 药品设置槽位(1-3=HP槽 4-6=SP槽, 0=清空)
 */
const { BUILD } = require('./protocol');

// 语义名 → 设置 id
const NAME = {
  '被非目标攻击': 0, '攻击距离': 1, '施法距离': 2, '瞬移间隔': 3, 'HP转换优先': 4,
  'BOSS瞬移': 5, '群殴解围数': 6, '群殴瞬移数': 7, '治愈术优先': 8, '瞬移HP': 9,
  '瞬移SP': 10, '下线HP': 11, '缰绳': 12, '宠物饲料': 13, '自动坐下': 14,
  '坐下HP下限': 15, '坐下SP下限': 16, '坐下HP上限': 17, '坐下SP上限': 18, '坐下被锁定': 19,
  '拾取概率': 20, '加血阈值': 21, '加气阈值': 22, 'jsys': 23, '属性药': 24,
  '万能药': 25, '齐格弗里德': 26, '跟随状态': 27, '跟随模式': 28, '跟随距离': 29,
  '无法瞬移时': 30, '保护HP': 31, '保护SP': 32, '属性药ITID': 33,
  '自动战斗': 34, '自动拾取': 35, '自动吃药': 36, '跟随战斗': 37, '寻怪模式': 38,
  '主动技能': 39, '主动技能等级': 40, '主动技能概率': 41, '触发技能': 42, '触发技能开启': 43,
  '解围技能': 44, '解围技能等级': 45, 'HP药1': 46, 'HP药2': 47, 'HP药3': 48,
  'SP药1': 49, 'SP药2': 50, 'SP药3': 51, '药品保护': 52, '辅助技能': 53,
  '辅助技能等级': 54, '辅助技能开启': 55, '战斗模式': 56, '药品槽': 57,
};

class BotConfig {
  /** @param {ROClient} client */
  constructor(client, log = console.log) {
    this.c = client;
    this.log = log;
    this.state = {};                       // 0x0AF6 回执镜像
    client.on('bot_setting', (p) => { this.state[p.id] = p.value; });
  }

  /** 发送单项设置（id 可为数字或语义名） */
  set(id, value) {
    const real = typeof id === 'number' ? id : NAME[id];
    if (real == null) { this.log(`⚠ 未知设置项 ${id}`); return false; }
    this.c.send(BUILD.notifyUpdateinfo(real, value));
    this.log(`⚙ 设置[${real}:${Object.keys(NAME).find((k) => NAME[k] === real) || '?'}] = ${value}`);
    return true;
  }

  /** 批量：set({ 攻击距离: 2, 自动战斗: 1, ... }) */
  apply(map) { for (const [k, v] of Object.entries(map)) this.set(k, v); }

  /** 主动技能：技能ID + 等级 + 概率%（三连发 39/40/41） */
  setAutoSkill(skillId, lv = 10, pro = 100) { this.set(39, skillId); this.set(40, lv); this.set(41, pro); }

  /** 辅助技能：技能ID + 等级 + 开关（53/54/55） */
  setSupportSkill(skillId, lv = 10, on = true) { this.set(53, skillId); this.set(54, lv); this.set(55, on ? 1 : 0); }

  /** 触发技能（42 + 43 开关） */
  setTriggerSkill(skillId, on = true) { this.set(42, skillId); this.set(43, on ? 1 : 0); }

  /** 解围技能（44 + 45 等级；被群殴 n>=6 时触发） */
  setRescueSkill(skillId, lv = 9) { this.set(44, skillId); this.set(45, lv); }

  /** 吃药：加血/加气阈值 + HP药×3 + SP药×3（ITID 可为 null 跳过） */
  setPotion({ hpPct, spPct, hpItems = [], spItems = [] } = {}) {
    if (hpPct != null) this.set(21, hpPct);
    if (spPct != null) this.set(22, spPct);
    [46, 47, 48].forEach((id, i) => { if (hpItems[i] != null) this.set(id, hpItems[i]); });
    [49, 50, 51].forEach((id, i) => { if (spItems[i] != null) this.set(id, spItems[i]); });
  }

  /** 自动坐下（UI 原文语义，2026-09-19 从客户端模板抠出）：
   *  on=开关(14)；hpMin/hpMax=坐下HP范围%(15/17)，spMin/spMax=坐下SP范围%(16/18)；
   *  attacked=坐下时被锁定的行为(19)：0=无视（还击等其它选项值需实测枚举） */
  setSit({ on = true, hpMin, hpMax, spMin, spMax, attacked = 0 } = {}) {
    this.set(14, on ? 1 : 0);
    if (hpMin != null) this.set(15, hpMin);
    if (hpMax != null) this.set(17, hpMax);
    if (spMin != null) this.set(16, spMin);
    if (spMax != null) this.set(18, spMax);
    this.set(19, attacked);
  }

  /** 拾取：开关 + 概率阈值%（拾取概率 ≤x% 的物品） */
  setLoot(on, probPct = 2) { this.set(35, on ? 1 : 0); if (on) this.set(20, probPct); }

  /** 一键纯猎怪配置：关跟随/吃药/坐下，按攻击距离平A */
  plainHunt({ attack, skill } = {}) {
    this.apply({ 跟随战斗: 0, 自动吃药: 0, 自动坐下: 0, 拾取概率: 2 });
    this.set(34, 1);                                   // 开自动战斗
    if (attack != null) this.set(1, attack);
    if (skill != null) this.set(2, skill);
  }

  /** 定向怪物列表（0x0AFD）：mobId + 加入/移除 */
  targetMob(mobId, on = true) {
    this.c.send(BUILD.notifyOnlytarget(mobId, on ? 1 : 0));
    this.log(`🎯 定向目标 mob#${mobId} ${on ? '加入' : '移除'}`);
  }

  /** 批量定向怪物 */
  targetMobs(mobIds) { mobIds.forEach((m) => this.targetMob(m, true)); }
}

module.exports = { BotConfig, BOT_NAME: NAME };
