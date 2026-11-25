import { initialRpgState } from '../src/rpg.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellWidth, fit, screenLines, type ScreenOptions } from '../src/tui.js';
import { initialVitals } from '../src/game.js';
import type { Display } from '../src/terminal.js';
const display: Display = {
  connection: '已连接', attach: '', events: ['玩家进入了营地'], commands: ['> 查看', '地面物品：无'],
  state: { selfId: 'a', players: [{ ...initialRpgState(), id: 'a', name: '旅人', location: 'camp', coins: 0, combat: null, vitals: { ...initialVitals }, inventory: {} }], coinAvailable: true, dummies: [], items: [], places: { camp: { id: 'camp', exits: [], groundItems: [], name: '营地', description: '篝火静静燃烧。' } } },
};
const options: ScreenOptions = { width: 80, height: 24, focus: 'commands', eventOffset: 0, commandOffset: 0, input: '拾取 金币' };
// 分栏更新不能改变另一个区域、属性栏和固定输入行。
test('角色四项属性、右下事件与左下命令独立更新', () => {
  const before = screenLines(display, options);
  assert.equal(before.length, 24);
  assert(before[1].indexOf('角色状态') < before[1].indexOf('地图'));
  assert(before[7].indexOf('命令记录与结果') < before[7].indexOf('事件与聊天'));
  assert(!before.slice(0, 20).some(line => line.includes('背包')));
  for (const label of ['生命值', '法力值', '饱食度', '水分值']) assert(before.slice(2, 7).some(line => line.includes(label)));
  const after = screenLines({ ...display, commands: Array(100).fill('很长的中文执行结果'.repeat(20)) }, options);
  assert.deepEqual(before.slice(0, 7), after.slice(0, 7));
  assert.deepEqual(before.slice(8, 20).map(l => l.split(' │ ')[1]), after.slice(8, 20).map(l => l.split(' │ ')[1]));
  const events = screenLines({ ...display, events: Array(100).fill('新事件') }, options);
  assert.deepEqual(before.slice(8, 20).map(l => l.split(' │ ')[0]), events.slice(8, 20).map(l => l.split(' │ ')[0]));
  assert.equal(after[22], before[22]);
  assert(after.every(line => cellWidth(line) === 79));
});
test('中文宽度、控制字符、历史视口和缩放', () => {
  assert.equal(cellWidth('中文abc'), 7);
  assert.equal(cellWidth('e\u0301'), 1);
  assert.equal(cellWidth(fit('中文abcdef', 5)), 5);
  assert(!fit('\x1b[31m危险', 20).includes('\x1b'));
  const events = Array.from({ length: 30 }, (_, i) => `事件${i}`);
  const old = screenLines({ ...display, events }, { ...options, eventOffset: 10 });
  assert(old.some(l => l.includes('事件19')));
  assert(!old.some(l => l.includes('事件29')));
  assert.equal(screenLines(display, { ...options, width: 120, height: 40 }).length, 40);
  assert(screenLines(display, { ...options, width: 40, height: 12 }).some(l => l.includes('请将窗口放大')));
});
// 背包按需替换左下区域，事件保持可见，关闭后命令历史恢复。
test('命令打开背包、分页和关闭恢复布局', () => {
  const inventory = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`道具${i + 1}`, i + 1]));
  const d: Display = { ...display, state: { ...display.state!, players: [{ ...display.state!.players[0], inventory }] } };
  const closed = screenLines(d, options);
  const opened = screenLines(d, { ...options, inventoryOpen: true });
  assert.match(opened[7], /背包 1\/3/);
  assert(opened.some(l => l.includes('道具12 ×12')));
  assert(!opened.some(l => l.includes('道具13 ×13')));
  assert.deepEqual(opened.slice(0, 7), closed.slice(0, 7));
  assert.deepEqual(opened.slice(8, 20).map(l => l.split(' │ ')[1]), closed.slice(8, 20).map(l => l.split(' │ ')[1]));
  const last = screenLines(d, { ...options, inventoryOpen: true, inventoryPage: 2 });
  assert.match(last[7], /背包 3\/3/);
  assert(last.some(l => l.includes('道具27 ×27')));
  assert.equal(last[22], closed[22]);
  assert.deepEqual(screenLines(d, { ...options, inventoryOpen: false }), closed);
  assert(screenLines(display, { ...options, inventoryOpen: true }).some(l => l.includes('背包为空')));
});

// 任意木桩引发一对二战斗，当前目标标记随服务器状态切换，退出恢复探索。
test('独立战斗界面、两个敌人和选中标记', async () => {
  const { Game } = await import('../src/game.js');
  const game = new Game(), player = game.join('战斗玩家');
  game.attack(player, '木桩 B');
  const d: Display = { ...display, state: game.snapshot(player.id) };
  const battle = screenLines(d, { ...options, inventoryOpen: true });
  assert(battle.some(l => l.includes('第 1 回合')));
  assert.match(battle[0], /练习战斗/);
  assert(battle.some(l => l.includes('队伍状态')));
  assert(battle.some(l => l.includes('战斗消息')));
  assert(battle.some(l => l.includes('▶ [2] 木桩 B')));
  assert(battle.some(l => l.includes('[1] 木桩 A')));
  assert(battle.some(l => l.includes('选择行动')));
  assert(!battle.some(l => l.includes('事件与聊天')));
  assert(!battle.some(l => l.includes('背包 1/')));
  game.selectCombatTarget(player, '1');
  const switched = screenLines(d, options);
  assert(switched.some(l => l.includes('▶ [1] 木桩 A')));
  assert.equal(player.combat!.round, 1);
  game.attack(player, undefined);
  assert(screenLines(d, options).some(l => l.includes('第 2 回合')));
  assert.equal(battle.length, 24);
  assert(battle.every(line => cellWidth(line) === 79));
  game.leaveCombat(player);
  const exploration = screenLines(d, options);
  assert(exploration[1].includes('角色状态') && exploration[1].includes('地图'));
  assert.match(exploration[22], /拾取 金币/);
});

// 消息框同屏显示多条已播出结果，历史分页不改变场景和菜单位置。
test('战斗结果累积显示并可翻阅旧记录', async () => {
  const { Game } = await import('../src/game.js');
  const { BattleFlow } = await import('../src/battle-flow.js');
  const game = new Game(), player = game.join('记录测试');
  game.attack(player, '木桩 A');
  const d: Display = { ...display, state: game.snapshot(player.id) };
  const flow = new BattleFlow();
  flow.start(1, 0);
  flow.history = ['玩家攻击木桩 A，伤害10。', '木桩 A一动不动。', '木桩 B一动不动。'];
  const screen = screenLines(d, { ...options, battle: flow });
  for (const text of flow.history) assert(screen.slice(8, 15).some(l => l.includes(text)));
  flow.history = Array.from({ length: 20 }, (_, i) => `战斗记录${i}`);
  const latest = screenLines(d, { ...options, battle: flow });
  const old = screenLines(d, { ...options, battle: flow, battleHistoryOffset: 10 });
  assert(latest.slice(8, 15).some(l => l.includes('战斗记录19')));
  assert(old.slice(8, 15).some(l => l.includes('战斗记录9')));
  assert(!old.slice(8, 15).some(l => l.includes('战斗记录19')));
  assert.deepEqual(old.slice(0, 7), latest.slice(0, 7));
  assert.deepEqual(old.slice(15, 22), latest.slice(15, 22));
  assert.equal(screen.length, 24);
  assert(screen.every(l => cellWidth(l) === 79));
});
