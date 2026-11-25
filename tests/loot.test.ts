import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { gameConfig, applyGameConfig, validateConfig } from '../src/config.js';
import type { LootEntry, ResourceEntry } from '../src/config-types.js';
import { corpseChoices } from '../src/corpse-menu.js';
import { parseCommand } from '../src/terminal.js';
import { screenLines } from '../src/tui.js';

function configured(loot: LootEntry[], resources: ResourceEntry[], run: (game: Game) => void, random = () => 0, count = 1) {
  const original = structuredClone(gameConfig), config = structuredClone(gameConfig);
  const rat = config.enemies.find(e => e.id === 'forest_rat')!;
  Object.assign(rat, { health: 1, defense: 0, attack: 0, skills: [], behavior: { mode: 'idle', fallback: 'idle', actions: [] }, loot, resources });
  config.world.maps.find(m => m.id === 'forest')!.encounters![0].members[0].count = count;
  try { applyGameConfig(config); run(new Game(random)); } finally { applyGameConfig(original); }
}
const coin = { itemId: 'coin', chance: 1, min: 2, max: 2 };
const resources = [{ itemId: 'raw_meat', quantity: 2 }, { itemId: 'bone', quantity: 2 }];
const enter = (game: Game, name = '测试者') => { const p = game.join(name); game.move(p, 'forest'); return p; };
const kill = (game: Game, player: ReturnType<Game['join']>) => { game.attack(player, '森林鼠'); game.attack(player, undefined); game.completeCombat(player); };

// 两个同种敌人各自抽取一次，开关容器、死亡与搜刮不会再次调用随机数。
test('出生时随机背包且彼此独立，尸体反复打开不刷新，公共状态不泄露背包', () => {
  const samples = [0.1, 0, 0.9]; let calls = 0;
  configured([{ itemId: 'coin', chance: 0.5, min: 1, max: 3 }], [], game => {
    const rats = game.enemies.filter(e => e.templateId === 'forest_rat');
    assert.deepEqual(rats.map(e => e.inventory), [{ coin: 1 }, {}]); assert.equal(calls, 3);
    const p = enter(game);
    assert(game.snapshot(p.id).dummies.every(e => !('inventory' in e)));
    game.attack(p, '森林鼠'); game.useSkill(p, '横扫', undefined); game.completeCombat(p);
    assert.throws(() => game.searchCorpse(p, '森林鼠'), /多个尸体/);
    const view = game.searchCorpse(p, rats[0].id);
    assert.equal(view.items[0].quantity, 1);
    view.items[0].quantity = 999; // 容器响应不是服务器背包的可变引用
    game.closeCorpse(p); assert.equal(game.searchCorpse(p, rats[0].id).items[0].quantity, 1);
    assert.equal(game.takeAllFromCorpse(p), '金币 ×1');
    assert.equal(p.coins, 1); assert.deepEqual(game.getOpenCorpse(p)!.items, []);
    assert.throws(() => game.takeAllFromCorpse(p), /已经空/);
    game.searchCorpse(p, rats[1].id); assert.deepEqual(game.getOpenCorpse(p)!.items, []);
    game.decomposeCorpse(p); assert.equal(calls, 3);
  }, () => samples[calls++]!, 2);
});

test('部分搜刮后分解：固定资源与剩余背包散落地面，不自动入包、不重复生成', () => {
  configured([coin, { itemId: 'health_potion', chance: 1, min: 1, max: 1 }, { itemId: 'bone', chance: 1, min: 1, max: 1 }], resources, game => {
    const p = enter(game), other = enter(game, '另一玩家'); kill(game, p);
    const corpse = game.enemies.find(e => e.templateId === 'forest_rat')!;
    game.searchCorpse(p, '森林鼠'); game.searchCorpse(other, corpse.id);
    assert.equal(game.takeFromCorpse(p, '金币', 1), '金币 ×1');
    assert.equal(p.coins, 1); assert.equal(corpse.inventory.coin, 1);
    const result = game.decomposeCorpse(p, corpse.id);
    assert.deepEqual(Object.fromEntries(result.items.map(i => [i.itemId, i.quantity])), { raw_meat: 2, bone: 3, coin: 1, health_potion: 1 });
    assert.equal(p.inventory['生肉'] ?? 0, 0); assert.equal(p.inventory['生命药水'], 3);
    assert.equal(game.getOpenCorpse(p), null); assert.equal(game.getOpenCorpse(other), null);
    assert(!game.snapshot(p.id).dummies.some(e => e.id === corpse.id)); assert.equal(game.snapshot(p.id).corpses.length, 0);
    const count = game.items.length;
    assert.throws(() => game.decomposeCorpse(other, corpse.id), /已经被分解/); assert.equal(game.items.length, count);
    assert.throws(() => game.takeFromCorpse(other, '生命药水'), /先「搜刮/);
    game.pickup(p, result.items.find(i => i.itemId === 'coin')!.id); assert.equal(p.coins, 2);
    game.pickup(p, '骨头'); assert.equal(p.inventory['骨头'], 1);
  });
});

test('空尸体仍可分解固定资源，活体/异地/战斗中不可搜刮，非法数量不扣物品', () => {
  configured([coin], resources, game => {
    const p = enter(game), b = game.join('营地玩家');
    assert.throws(() => game.searchCorpse(p, '森林鼠'), /没有该尸体/);
    game.attack(p, '森林鼠'); game.attack(p, undefined);
    assert.throws(() => game.searchCorpse(p, '森林鼠'), /结束战斗/);
    game.completeCombat(p);
    assert.throws(() => game.searchCorpse(b, '森林鼠'), /没有该尸体/);
    game.searchCorpse(p, '森林鼠');
    for (const amount of [0, -1, 1.5, null, '2', 3]) assert.throws(() => game.takeFromCorpse(p, '金币', amount), /数量/);
    assert.equal(game.getOpenCorpse(p)!.items[0].quantity, 2); assert.equal(p.coins, 0);
    game.move(p, 'camp'); assert.equal(game.getOpenCorpse(p), null);
    game.move(p, 'forest'); game.searchCorpse(p, '森林鼠'); game.takeAllFromCorpse(p);
    const result = game.decomposeCorpse(p);
    assert.deepEqual(Object.fromEntries(result.items.map(i => [i.itemId, i.quantity])), { raw_meat: 2, bone: 2 });
    assert.equal(p.coins, 2);
  });
});

test('尸体菜单、拿取数量指令与配置概率校验', () => {
  configured([coin], resources, game => {
    const p = enter(game); kill(game, p);
    const view = game.searchCorpse(p, '森林鼠');
    assert.deepEqual(corpseChoices(view).map(c => c.command), ['拿取 coin', '全部拿取', '关闭搜刮', '分解 rat_group-1']);
    const screen = screenLines({ state: game.snapshot(p.id), events: [], commands: [], connection: '已连接', attach: '', corpse: view }, { width: 80, height: 24, focus: 'commands', eventOffset: 0, commandOffset: 0, input: '' });
    assert(screen.some(l => l.includes('搜刮：森林鼠的尸体'))); assert(screen.some(l => l.includes('金币 ×2')));
    assert(screen.some(l => l.includes('[尸体]'))); assert.equal(screen.length, 24);
    game.takeAllFromCorpse(p); assert.equal(corpseChoices(game.getOpenCorpse(p)!)[0].command, '关闭搜刮');
  });
  assert.deepEqual(parseCommand('搜刮 森林鼠'), { type: 'searchCorpse', target: '森林鼠' });
  assert.deepEqual(parseCommand('拿取 金币 2'), { type: 'takeCorpseItem', item: '金币', quantity: 2 });
  assert.deepEqual(parseCommand('拿取 金币 全部'), { type: 'takeCorpseItem', item: '金币', quantity: 'all' });
  for (const loot of [[{ ...coin, chance: 2 }], [{ ...coin, min: 4 }], [{ ...coin, itemId: 'missing' }]]) {
    const config = structuredClone(gameConfig); config.enemies[1].loot = loot;
    assert.throws(() => validateConfig(config), /loot/);
  }
  const config = structuredClone(gameConfig); config.enemies[1].resources = [{ itemId: 'bone', quantity: 0 }];
  assert.throws(() => validateConfig(config), /resources/);
});
