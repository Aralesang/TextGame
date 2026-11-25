import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, initialVitals } from '../src/game.js';
import { gameConfig, applyGameConfig, validateConfig } from '../src/config.js';
import type { EnemyDefinition } from '../src/config-types.js';
import { BattleFlow } from '../src/battle-flow.js';
import { screenLines } from '../src/tui.js';

// 每个用例独立替换普通敌人，木桩定义保持原样；结束后恢复配置。
function setup(definitions: EnemyDefinition[], run: (game: Game) => void) {
  const original = structuredClone(gameConfig);
  try { const config = structuredClone(original); config.enemies = definitions; config.world.maps.forEach(map => { map.encounters = map.id === 'forest' ? [{ id: 'pack', members: definitions.map(enemy => ({ enemyId: enemy.id, count: 1 })) }] : []; }); applyGameConfig(config); run(new Game()); }
  finally { applyGameConfig(original); }
}
const enemy = (id: string, patch: Partial<EnemyDefinition> = {}): EnemyDefinition => ({
  id, name: id, health: 100, mana: 40, attack: 20, defense: 0, magic: 0,
  skills: ['heavy_strike', 'fireball', 'heal'], idleText: '停下脚步。', behavior: { mode: 'attack', fallback: 'attack', actions: [] }, ...patch,
});

test('普通敌人反击、护甲与防御减伤、循环技能及法力不足后备行动', () => {
  setup([enemy('rat', { defense: 2, behavior: { mode: 'cycle', fallback: 'attack', actions: [{ type: 'attack' }, { type: 'skill', skill: 'heavy_strike' }, { type: 'defend' }] } })], game => {
    const p = game.join('测试者'); game.move(p, 'forest'); game.attack(p, 'rat');
    const attack = game.attack(p, undefined);
    assert.equal(attack.damage, 8); assert.equal(p.vitals.health, 83);
    const defense = game.defend(p);
    assert.equal(p.vitals.health, 65); // (20*2 - 默认防御3) / 2 向下取整
    assert.equal(game.enemies[0].mana, 32);
    assert(defense.some(line => line.includes('已防御减伤')));
    game.changeEquipment(p, '锁甲'); // 敌人第三次行动防御，不造成伤害
    assert.equal(p.vitals.health, 65); assert.equal(game.enemies[0].defending, true);
    assert.equal(game.attack(p, undefined).damage, 4); // (10-2)/2
    assert.equal(p.vitals.health, 52); // 锁甲6+皮帽1 => 20-7
    game.enemies[0].mana = 0;
    game.defend(p); // 技能法力不足，后备普攻 (20-7)/2
    assert.equal(p.vitals.health, 46); assert.equal(game.enemies[0].mana, 0);
  });
});

test('优先级、低生命治疗、每N次行动、魔法技能与法力消耗', () => {
  setup([enemy('mage', { attack: 10, magic: 5, behavior: { mode: 'priority', fallback: 'idle', actions: [
    { type: 'skill', skill: 'heal', when: { healthBelowPercent: 50 } },
    { type: 'skill', skill: 'fireball', when: { every: 2 } },
  ] } })], game => {
    const p = game.join('测试者'); game.move(p, 'forest'); game.attack(p, 'mage');
    const mage = game.enemies[0]; mage.health = 30;
    const lines = game.defend(p);
    assert.equal(mage.health, 65); assert.equal(mage.mana, 30);
    assert(lines.some(line => line.includes('恢复 35 点生命')));
    game.attack(p, undefined); // 第2次敌人行动，火球(30+5-3/2)=33
    assert.equal(mage.mana, 18); assert.equal(p.vitals.health, 67);
    game.attack(p, undefined); // 生命45，优先治疗
    assert.equal(mage.health, 80); assert.equal(mage.mana, 8);
    game.defend(p); // 没蓝施放火球且无需治疗，后备待机
    assert.equal(p.vitals.health, 67); assert.equal(mage.mana, 8);
  });
});

test('死亡目标不行动、不再可选，最后一击胜利且不可重复结算', () => {
  setup([enemy('first', { health: 9 }), enemy('second', { health: 9 })], game => {
    const p = game.join('测试者'); game.move(p, 'forest'); game.attack(p, 'first');
    const hit = game.attack(p, undefined);
    assert.equal(hit.damage, 9); assert.equal(game.enemies[0].health, 0);
    assert.equal(game.enemies[0].actionsTaken, 0); assert.equal(game.enemies[1].actionsTaken, 1);
    assert.equal(p.vitals.health, 83); assert.equal(p.combat!.targetId, 'pack-2');
    const before = JSON.stringify(p);
    assert.throws(() => game.selectCombatTarget(p, 'first'), /倒下/);
    assert.throws(() => game.useSkill(p, '火球', 'first'), /倒下/);
    assert.equal(JSON.stringify(p), before);
    const flow = new BattleFlow(); flow.start(2, 0); flow.key('space', ' ', p.combat!.enemyIds);
    assert.equal(flow.key('space', ' ', p.combat!.enemyIds, ['pack-2']), '攻击 pack-2'); flow.dispose();
    const win = game.attack(p, undefined);
    assert.equal(p.combat!.outcome, 'victory'); assert.equal(p.combat!.turn, 'finished');
    assert.equal(p.vitals.health, 83); assert(win.lines.some(line => line.includes('战斗胜利')));
    assert.equal(win.lines.filter(line => line.includes('的回合')).length, 0);
    assert.throws(() => game.attack(p, undefined), /已结束/);
    const screen = screenLines({ state: game.snapshot(p.id), events: [], commands: [], connection: '已连接', attach: '' }, { width: 80, height: 24, focus: 'commands', eventOffset: 0, commandOffset: 0, input: '' }).join('\n');
    assert(screen.includes('× [1] first')); assert(screen.includes('0/9'));
    game.completeCombat(p); assert.equal(p.combat, null);
    assert.throws(() => game.completeCombat(p), /尚未结束/);
    assert.throws(() => game.attack(p, 'first'), /已经倒下/);
  });
});

test('群体技能击杀后停止敌方行动，玩家失败后恢复出生点', () => {
  setup([enemy('first', { health: 8 }), enemy('second', { health: 8 })], game => {
    const p = game.join('群攻'); game.move(p, 'forest'); game.attack(p, 'first');
    game.useSkill(p, '横扫', undefined);
    assert.equal(p.combat!.outcome, 'victory'); assert.equal(p.vitals.health, 100);
    assert(game.enemies.every(e => e.health === 0 && e.actionsTaken === 0));
  });
  setup([enemy('killer', { attack: 999 }), enemy('follower')], game => {
    const p = game.join('战败'); game.move(p, 'forest'); game.attack(p, 'killer');
    const inventory = { ...p.inventory }, equipment = { ...p.equipment };
    const lines = game.attack(p, undefined).lines;
    assert.equal(p.vitals.health, 0); assert.equal(p.combat!.outcome, 'defeat');
    assert.equal(game.enemies[1].actionsTaken, 0); assert(lines.some(line => line.includes('战斗失败')));
    assert.throws(() => game.useItem(p, '生命药水'), /已结束/);
    game.completeCombat(p);
    assert.equal(p.location, gameConfig.world.startMap); assert.deepEqual(p.vitals, initialVitals);
    assert.deepEqual(p.inventory, inventory); assert.deepEqual(p.equipment, equipment);
    assert(game.enemies.every(e => e.engagedBy === null));
  });
});

test('普通敌人遭遇锁在离开和断线时释放，配置校验技能和行动规则', () => {
  setup([enemy('rat')], game => {
    const a = game.join('甲'), b = game.join('乙'); game.move(a, 'forest'); game.move(b, 'forest');
    game.attack(a, 'rat'); assert.throws(() => game.attack(b, 'rat'), /其他玩家/);
    game.move(a, 'camp'); game.attack(b, 'rat'); assert.equal(game.enemies[0].engagedBy, b.id);
    game.removePlayer(b.id); assert.equal(game.enemies[0].engagedBy, null);
    game.move(a, 'forest'); game.attack(a, 'rat');
  });
  for (const patch of [
    { health: 0 }, { attack: -1 }, { skills: ['missing'] },
    { behavior: { mode: 'cycle', fallback: 'attack', actions: [] } },
    { behavior: { mode: 'priority', fallback: 'attack', actions: [{ type: 'skill', skill: 'missing' }] } },
  ]) {
    const config = structuredClone(gameConfig); config.enemies = [enemy('invalid', patch as any)]; config.world.maps.forEach(map => { map.encounters = [{ id: map.id + '_test', members: [{ enemyId: 'invalid', count: 1 }] }]; });
    assert.throws(() => validateConfig(config), /enemies.json/);
  }
});

test('胜负播报完成自动返回探索，旧计时不能重复触发结算', async () => {
  let count = 0;
  const flow = new BattleFlow(() => {}, 10);
  try {
    flow.present(['敌人倒下。', '战斗胜利！'], 1, 1, () => { count++; });
    const deadline = Date.now() + 2000;
    while (count === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    assert.equal(count, 1); assert.equal(flow.mode, 'waiting');
    flow.present(['战斗失败'], 1, 1, () => { count++; });
    flow.dispose(); await new Promise(r => setTimeout(r, 30)); assert.equal(count, 1);
  } finally { flow.dispose(); }
});

// 同种敌人只定义一次，由地图数量生成实例；后缀只用于战斗标识。
test('单一定义生成同名实例，地图不暴露后缀，生命与法力互相独立', () => {
  const original = structuredClone(gameConfig), config = structuredClone(gameConfig);
  try {
    const template = enemy('slime', { name: '史莱姆', health: 30 });
    config.enemies = [template];
    config.world.maps.forEach(map => { map.encounters = map.id === 'forest' ? [{ id: 'slimes', members: [{ enemyId: 'slime', count: 2 }] }] : []; });
    applyGameConfig(config);
    const game = new Game(), p = game.join('实例验证'); game.move(p, 'forest');
    assert.equal(gameConfig.enemies.length, 1); assert.equal(game.enemies.length, 2);
    assert.deepEqual(game.enemies.map(e => e.name), ['史莱姆', '史莱姆']);
    assert.deepEqual(game.enemies.map(e => e.battleName), ['史莱姆 A', '史莱姆 B']);
    assert.match(game.look(p), /史莱姆 ×2/); assert.doesNotMatch(game.look(p), /史莱姆 [AB]/);
    game.attack(p, '史莱姆'); game.attack(p, undefined);
    assert.equal(game.enemies[0].health, 20); assert.equal(game.enemies[1].health, 30);
    game.enemies[0].mana = 0; assert.equal(game.enemies[1].mana, 40);
    assert.equal(gameConfig.enemies[0].health, 30);
    config.world.maps.find(m => m.id === 'forest')!.encounters![0].members[0].count = 1;
    applyGameConfig(config); assert.equal(new Game().enemies[0].battleName, '史莱姆');
    config.world.maps.find(m => m.id === 'forest')!.encounters!.push({ id: 'other_slimes', members: [{ enemyId: 'slime', count: 1 }] });
    applyGameConfig(config);
    const shared = new Game(), a = shared.join('甲'), b = shared.join('乙'); shared.move(a, 'forest'); shared.move(b, 'forest');
    shared.attack(a, '史莱姆'); shared.attack(b, '史莱姆');
    assert.notEqual(a.combat!.targetId, b.combat!.targetId);
  } finally { applyGameConfig(original); }
});
