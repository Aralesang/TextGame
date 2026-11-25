import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { stats, battleOptions, itemDefinitions } from '../src/rpg.js';
import { BattleFlow } from '../src/battle-flow.js';
import { parseCommand } from '../src/terminal.js';

// 更换所有装备位均由服务器校验；装备引用背包物品，不转移或复制数量。
test('装备武器、护甲、头盔、饰品，战斗更换各消耗一回合', () => {
  const game = new Game(), p = game.join('装备测试');
  assert.equal(stats(p).attack, 10);
  const inventory = { ...p.inventory };
  game.changeEquipment(p, '铁剑');
  game.changeEquipment(p, '力量戒指');
  assert.equal(stats(p).attack, 20);
  assert.equal(p.combat, null);
  game.attack(p, '木桩 A');
  for (const name of ['法杖', '锁甲', '铁盔', '魔力护符']) {
    const round = p.combat!.round;
    const lines = game.changeEquipment(p, name);
    assert.equal(p.combat!.round, round + 1);
    assert.equal(lines.filter(line => line.includes('一动不动')).length, 2);
  }
  assert.deepEqual(stats(p), { attack: 8, defense: 9, magic: 18 });
  assert.deepEqual(p.inventory, inventory);
  assert.equal(game.dummies[0].hits, 0);
  const round = p.combat!.round;
  game.changeEquipment(p, '饰品', true);
  assert.equal(stats(p).magic, 10);
  assert.equal(p.combat!.round, round + 1);
  assert.equal(p.inventory['魔力护符'], 1);
  const before = JSON.stringify(p);
  assert.throws(() => game.changeEquipment(p, '法杖'), /已经装备/);
  assert.throws(() => game.changeEquipment(p, '生命药水'), /不能装备/);
  assert.throws(() => game.changeEquipment(p, '不存在'));
  assert.equal(JSON.stringify(p), before);
  p.inventory['木剑'] = 0;
  assert.throws(() => game.changeEquipment(p, '木剑'), /没有这件装备/);
});

test('技能单体、群体、治疗及失败操作不扣法力回合', () => {
  const game = new Game(), p = game.join('技能测试');
  game.attack(p, '木桩 A');
  game.useSkill(p, '重击', '木桩 B');
  assert.equal(game.dummies[1].damageTaken, 20);
  assert.equal(p.vitals.mana, 92);
  game.useSkill(p, '横扫', undefined);
  assert.equal(game.dummies[0].damageTaken, 8);
  assert.equal(game.dummies[1].damageTaken, 28);
  game.changeEquipment(p, '法杖'); game.changeEquipment(p, '魔力护符');
  game.useSkill(p, '火球', '木桩 A');
  assert.equal(game.dummies[0].damageTaken, 56);
  p.vitals.health = 80;
  game.useSkill(p, '治疗', undefined);
  assert.equal(p.vitals.health, 100);
  let before = JSON.stringify(p);
  assert.throws(() => game.useSkill(p, '治疗', undefined), /生命已满/);
  assert.throws(() => game.useSkill(p, '火球', '其他目标'));
  assert.throws(() => game.useSkill(p, '无敌技能', undefined));
  assert.equal(JSON.stringify(p), before);
  p.vitals.mana = 1; before = JSON.stringify(p);
  assert.throws(() => game.useSkill(p, '火球', '木桩 A'), /法力不足/);
  assert.equal(JSON.stringify(p), before);
});

test('恢复药水上限、数量与回合，增益持续三次后续行动', () => {
  const game = new Game(), p = game.join('药水测试');
  assert.throws(() => game.useItem(p, '生命药水'), /属性已满/);
  assert.equal(p.inventory['生命药水'], 3);
  p.vitals = { health: 80, mana: 40, satiety: 30, hydration: 25 };
  game.useItem(p, '生命药水');
  assert.equal(p.vitals.health, 100);
  assert.equal(p.inventory['生命药水'], 2);
  game.useItem(p, '法力药水'); game.useItem(p, 'food_potion'); game.useItem(p, 'water_potion');
  assert.deepEqual(p.vitals, { health: 100, mana: 75, satiety: 70, hydration: 65 });
  game.attack(p, '木桩 A');
  let round = p.combat!.round;
  game.useItem(p, '复合药水');
  assert.equal(p.vitals.mana, 100);
  assert.equal(p.combat!.round, round + 1);
  game.useItem(p, '力量药水');
  assert.equal(p.effects[0].turns, 3);
  for (let i = 0; i < 3; i++) assert.equal(game.attack(p, undefined).damage, 18);
  assert.equal(game.attack(p, undefined).damage, 10);
  assert.equal(p.effects.length, 0);
  game.useItem(p, '魔力药水');
  assert.equal(stats(p).magic, 10);
  game.useItem(p, '魔力药水');
  assert.equal(stats(p).magic, 10);
  assert.equal(p.effects.find(e => e.kind === 'magic')!.turns, 3);
  p.vitals.health = 50;
  game.useItem(p, '再生药水');
  assert.equal(p.vitals.health, 50);
  for (let i = 0; i < 3; i++) game.defend(p);
  assert.equal(p.vitals.health, 80);
  assert.equal(p.effects.length, 0);
  p.inventory['生命药水'] = 0; round = p.combat!.round;
  assert.throws(() => game.useItem(p, '生命药水'), /没有该消耗品/);
  assert.equal(p.combat!.round, round);
  game.leaveCombat(p);
  assert.equal(p.effects.length, 0);
});

test('战斗子菜单空格确认，技能选目标，取消不提交，已装备不可重复切换', () => {
  const game = new Game(), p = game.join('菜单测试'); game.attack(p, '木桩 A');
  const flow = new BattleFlow(), enemies = p.combat!.enemyIds;
  try {
    flow.start(1, 0);
    flow.key('right', undefined, enemies); flow.key('space', ' ', enemies);
    assert.equal(flow.mode, 'skills');
    flow.options = battleOptions(p, flow.mode);
    flow.key('down', undefined, enemies);
    assert.equal(flow.key('return', undefined, enemies), undefined);
    flow.key('space', ' ', enemies);
    assert.equal(flow.mode, 'target');
    flow.key('right', undefined, enemies);
    assert.equal(flow.key('space', ' ', enemies), '施放 fireball dummy-2');
    flow.start(1, 0); flow.menuIndex = 3; flow.key('space', ' ', enemies);
    flow.options = battleOptions(p, flow.mode);
    assert.equal(flow.key('space', ' ', enemies), undefined);
    assert.equal(flow.mode, 'equipment');
    flow.key('down', undefined, enemies);
    assert.equal(flow.key('space', ' ', enemies), '装备 iron_sword');
    flow.start(1, 0); flow.menuIndex = 2; flow.key('space', ' ', enemies);
    flow.options = battleOptions(p, flow.mode); flow.key('escape', undefined, enemies);
    assert.equal(flow.mode, 'menu');
    assert(itemDefinitions.filter(i => i.kind === 'potion').length >= 8);
    assert.deepEqual(parseCommand('施放 火球 木桩 B'), { type: 'useSkill', skill: '火球', target: '木桩 B' });
    assert.deepEqual(parseCommand('装备 铁剑'), { type: 'equip', item: '铁剑' });
  } finally { flow.dispose(); }
});
