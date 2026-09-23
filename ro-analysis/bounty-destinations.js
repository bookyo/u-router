'use strict';

// 送信（喵喵）——按任务名关键词映射地图。
const MAIL = [
  { key: /吉芬地下|吉芬密穴/, map: 'gef_dun00', x: 48, y: 165, cave: true },
  { key: /兽人村落/, map: 'gef_fild10', x: 231, y: 208 },
  { key: /史芬克斯|斯芬克斯/, map: 'in_sphinx1', x: 83, y: 173, cave: true },
  { key: /姜饼城原野/, map: 'xmas_fild01', x: 210, y: 240 },
  { key: /废弃矿场|妙勒尼/, map: 'mjo_dun01', x: 227, y: 310, cave: true },
  // 普隆德拉地下水道 1 层：飞艇落在安全空格，NPC 坐标单独保留给扫描和巡路。
  { key: /(?:^|[\s\-－—])(?:地下水道|下水道)\s*1层(?=\s|★|$)/, map: 'prt_sewb1', x: 192, y: 253, flyX: 194, flyY: 254, cave: true },
  { key: /废弃村落/, map: 'pay_dun00', x: 155, y: 142, cave: true },
  { key: /沉没之船/, map: 'treasure01', x: 72, y: 49, cave: true },
  { key: /海底洞/, map: 'iz_dun00', x: 360, y: 323, cave: true, alt: ['iz_dun01'], npcRe: /喵喵/ },
];

// 区域类送信（例如「[送货] - 吉芬区域6★」）。
const AREA_PREFIX = { 吉芬: 'gef_fild', 普隆德拉: 'prt_fild', 斐扬: 'pay_fild', 梦罗克: 'moc_fild', 姜饼城: 'xmas_fild' };
const AREA_SPOTS = { gef_fild06: [127, 220] };

function parseArea(text) {
  const m = String(text || '').match(/(吉芬|普隆德拉|斐扬|梦罗克|姜饼城)区域\s*(\d+)/);
  if (!m) return null;
  const map = AREA_PREFIX[m[1]] + String(parseInt(m[2], 10)).padStart(2, '0');
  const spot = AREA_SPOTS[map] || null;
  return { map, x: spot ? spot[0] : null, y: spot ? spot[1] : null, npcRe: /喵喵/, kind: '送信', areaUnknown: !spot };
}

function parseDeliveryDestination(taskText) {
  const text = String(taskText || '');
  const match = MAIL.find((entry) => entry.key.test(text) || entry.key.test(text.replace(/[★\s]/g, '')));
  if (match) {
    return {
      map: match.map,
      x: match.x,
      y: match.y,
      flyX: match.flyX,
      flyY: match.flyY,
      alt: match.alt,
      cave: !!match.cave,
      npcRe: match.npcRe || /喵喵/,
      kind: '送信',
    };
  }
  return parseArea(text);
}

async function navigateDestination(destination, { gotoMap, isOnMap = () => false, onAlternative = () => {} }) {
  const flightX = destination.flyX ?? destination.x;
  const flightY = destination.flyY ?? destination.y;
  let map = destination.map;
  let ok = await gotoMap(map, flightX, flightY, destination.cave);

  if (!ok) {
    for (const alternative of (destination.alt || [])) {
      onAlternative(alternative);
      if (await gotoMap(alternative, flightX, flightY, destination.cave)) {
        map = alternative;
        ok = true;
        break;
      }
    }
  }

  if (!ok) ok = !!isOnMap(map);
  return { ok, map, targetX: destination.x, targetY: destination.y };
}

module.exports = { parseDeliveryDestination, navigateDestination };
