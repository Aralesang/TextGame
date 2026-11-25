import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { GameConfig, MapDefinition } from './config-types.js';
export type * from './config-types.js';

// 启动即校验并指出配置路径，拒绝无效值、拼错字段和断开的引用。
function fail(path: string, message: string): never { throw new Error(`配置错误 ${path}：${message}`); }
function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
  return value as Record<string, any>;
}
function fields(value: Record<string, any>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, '未知字段');
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) fail(path, '必须是首尾无空白的可见文本');
}
function id(value: unknown, path: string): asserts value is string {
  text(value, path);
  if (!/^[a-z][a-z0-9_-]*$/.test(value) || ['constructor', 'prototype'].includes(value)) fail(path, 'ID 使用小写英文字母开头，只含字母、数字、_、-');
}
function number(value: unknown, path: string, min = 0, max = 1000000, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(path, `必须是 ${min}～${max} 的${integer ? '整数' : '数值'}`);
}
function list(value: unknown, path: string): any[] { if (!Array.isArray(value)) fail(path, '必须是数组'); return value; }
function named(value: unknown, path: string) {
  const entry = object(value, path); id(entry.id, path + '.id'); text(entry.name, path + '.name'); if (Object.hasOwn(Object.prototype, entry.name)) fail(path + '.name', '名称不能使用对象保留字段'); return entry;
}
function unique(entries: any[], path: string) {
  const aliases = new Map<string, number>();
  entries.forEach((entry, i) => {
    for (const value of new Set([entry.id, entry.name])) {
      if (aliases.has(value)) fail(`${path}[${i}]`, `名称或 ID「${value}」与第 ${aliases.get(value)! + 1} 项重复`);
      aliases.set(value, i);
    }
  });
}
const slots = ['weapon', 'body', 'head', 'accessory'];
const vitals = ['health', 'mana', 'satiety', 'hydration'];
const kinds = ['equipment', 'potion', 'consumable', 'material'];
const effectKinds = ['strength', 'magic', 'regeneration'];
export function validateConfig(raw: unknown): GameConfig {
  const root = object(raw, 'config'); fields(root, ['items', 'skills', 'world', 'player', 'enemies'], 'config');
  const items = list(root.items, 'items.json');
  items.forEach((value, i) => {
    const p = `items.json[${i}]`, item = named(value, p);
    fields(item, ['id', 'name', 'kind', 'description', 'slot', 'attack', 'defense', 'magic', 'currencyValue', 'restore', 'effect', 'power', 'turns'], p);
    text(item.description, p + '.description');
    if (!kinds.includes(item.kind)) fail(p + '.kind', '支持 equipment / consumable / potion / material');
    if (item.kind === 'equipment') {
      if (!slots.includes(item.slot)) fail(p + '.slot', '支持 weapon / body / head / accessory');
      for (const key of ['attack', 'defense', 'magic']) if (item[key] !== undefined) number(item[key], p + '.' + key);
    } else for (const key of ['slot', 'attack', 'defense', 'magic']) if (item[key] !== undefined) fail(p + '.' + key, '该字段仅用于装备');
    const consumable = item.kind === 'potion' || item.kind === 'consumable';
    if (item.currencyValue !== undefined) { if (item.kind !== 'material') fail(p + '.currencyValue', '只允许材料配置货币价值'); number(item.currencyValue, p + '.currencyValue', 0, 1000000, true); }
    if (!consumable && ['restore', 'effect', 'power', 'turns'].some(key => item[key] !== undefined)) fail(p, '恢复和持续效果仅用于消耗品');
    if (consumable) {
      let effective = false;
      if (item.restore !== undefined) {
        const restore = object(item.restore, p + '.restore'); fields(restore, vitals, p + '.restore');
        for (const [key, amount] of Object.entries(restore)) { number(amount, `${p}.restore.${key}`, 0, 100); if ((amount as number) > 0) effective = true; }
      }
      if (item.effect !== undefined) {
        if (!effectKinds.includes(item.effect)) fail(p + '.effect', '支持 strength / magic / regeneration');
        number(item.power, p + '.power', 1); number(item.turns, p + '.turns', 1, 1000, true); effective = true;
      } else if (item.power !== undefined || item.turns !== undefined) fail(p, 'power/turns 需要同时配置 effect');
      if (!effective) fail(p, '消耗品至少需要一个非零恢复量或持续效果');
    }
  });
  unique(items, 'items.json');
  const itemMap = new Map(items.map(item => [item.id, item]));
  const skills = list(root.skills, 'skills.json');
  skills.forEach((value, i) => {
    const p = `skills.json[${i}]`, skill = named(value, p);
    fields(skill, ['id', 'name', 'cost', 'description', 'target', 'damage', 'multiplier', 'heal'], p);
    text(skill.description, p + '.description'); number(skill.cost, p + '.cost', 0, 1000000, true);
    if (!['enemy', 'all', 'self'].includes(skill.target)) fail(p + '.target', '支持 enemy / all / self');
    if (skill.target === 'self') {
      number(skill.heal, p + '.heal', 1, 100);
      if (skill.damage !== undefined || skill.multiplier !== undefined) fail(p, '自身治疗不能同时配置伤害');
    } else {
      if ((skill.damage !== undefined) === (skill.multiplier !== undefined) || skill.heal !== undefined) fail(p, '伤害技能必须二选一配置 damage 或 multiplier，不能配置 heal');
      if (skill.damage !== undefined) number(skill.damage, p + '.damage', 0);
      if (skill.multiplier !== undefined) number(skill.multiplier, p + '.multiplier', 0.01, 1000);
    }
  });
  unique(skills, 'skills.json');
  const skillIds = new Set(skills.map(s => s.id));
  const enemyIds = new Set(list(root.enemies, 'enemies.json').map((value, i) => object(value, `enemies.json[${i}]`).id));
  const world = object(root.world, 'world.json'); fields(world, ['startMap', 'maps'], 'world.json');
  id(world.startMap, 'world.json.startMap');
  const maps = list(world.maps, 'world.json.maps'); if (!maps.length) fail('world.json.maps', '至少配置一个地图');
  maps.forEach((value, i) => {
    const p = `world.json.maps[${i}]`, map = named(value, p); fields(map, ['id', 'name', 'description', 'exits', 'groundItems', 'encounters'], p); text(map.description, p + '.description');
    list(map.exits, p + '.exits').forEach((v, n) => id(v, `${p}.exits[${n}]`));
    if (new Set(map.exits).size !== map.exits.length) fail(p + '.exits', '不能重复');
    list(map.encounters ?? [], p + '.encounters').forEach((value, n) => {
      const ep = `${p}.encounters[${n}]`, encounter = object(value, ep); fields(encounter, ['id', 'members'], ep); id(encounter.id, ep + '.id');
      const members = list(encounter.members, ep + '.members');
      if (!members.length) fail(ep + '.members', '至少配置一种敌人');
      members.forEach((value, m) => {
        const mp = `${ep}.members[${m}]`, member = object(value, mp); fields(member, ['enemyId', 'count'], mp);
        if (!enemyIds.has(member.enemyId)) fail(mp + '.enemyId', '敌人定义不存在');
        number(member.count, mp + '.count', 1, 10, true);
      });
      if (new Set(members.map(m => m.enemyId)).size !== members.length) fail(ep + '.members', '同种敌人使用 count 配置数量，不要重复定义');
      if (members.reduce((n, m) => n + m.count, 0) > 10) fail(ep + '.members', '每场遭遇最多支持10个敌人');
    });
    list(map.groundItems, p + '.groundItems').forEach((value, n) => {
      const ip = `${p}.groundItems[${n}]`, spawn = object(value, ip); fields(spawn, ['id', 'itemId', 'quantity'], ip);
      id(spawn.id, ip + '.id'); id(spawn.itemId, ip + '.itemId');
      if (!itemMap.has(spawn.itemId)) fail(ip + '.itemId', `物品 ${spawn.itemId} 不存在`);
      number(spawn.quantity, ip + '.quantity', 1, 1000000, true);
    });
  });
  unique(maps, 'world.json.maps');
  const mapIds = new Set(maps.map(m => m.id));
  if (!mapIds.has(world.startMap)) fail('world.json.startMap', '地图不存在');
  maps.forEach((m, i) => m.exits.forEach((exit: string) => { if (!mapIds.has(exit) || exit === m.id) fail(`world.json.maps[${i}].exits`, `无效出口 ${exit}`); }));
  const encounters = maps.flatMap(m => m.encounters ?? []);
  unique(encounters.map(e => ({ id: e.id, name: e.id })), 'world.json.encounters');
  const spawns = maps.flatMap(m => m.groundItems); unique(spawns.map(s => ({ id: s.id, name: s.id })), 'world.json.groundItems');
  const enemies = list(root.enemies, 'enemies.json');
  enemies.forEach((value, i) => {
    const p = `enemies.json[${i}]`, enemy = named(value, p);
    fields(enemy, ['id', 'name', 'health', 'idleText', 'mana', 'attack', 'defense', 'magic', 'skills', 'behavior', 'loot', 'resources'], p);
    text(enemy.idleText, p + '.idleText');
    if (enemy.health !== 'infinite') number(enemy.health, p + '.health', 1, 1000000, true);
    for (const key of ['mana', 'attack', 'defense', 'magic']) number(enemy[key], p + '.' + key, 0, 1000000, true);
    list(enemy.loot ?? [], p + '.loot').forEach((value, n) => {
      const lp = `${p}.loot[${n}]`, entry = object(value, lp); fields(entry, ['itemId', 'chance', 'min', 'max'], lp);
      if (!itemMap.has(entry.itemId)) fail(lp + '.itemId', '物品不存在');
      number(entry.chance, lp + '.chance', 0, 1);
      number(entry.min, lp + '.min', 1, 1000000, true); number(entry.max, lp + '.max', entry.min, 1000000, true);
    });
    list(enemy.resources ?? [], p + '.resources').forEach((value, n) => {
      const rp = `${p}.resources[${n}]`, entry = object(value, rp); fields(entry, ['itemId', 'quantity'], rp);
      if (!itemMap.has(entry.itemId)) fail(rp + '.itemId', '物品不存在');
      number(entry.quantity, rp + '.quantity', 1, 1000000, true);
    });
    const learned = list(enemy.skills, p + '.skills');
    if (new Set(learned).size !== learned.length || learned.some(id => !skillIds.has(id))) fail(p + '.skills', '技能重复或引用不存在');
    const ai = object(enemy.behavior, p + '.behavior'); fields(ai, ['mode', 'fallback', 'actions'], p + '.behavior');
    if (!['idle', 'attack', 'cycle', 'priority'].includes(ai.mode)) fail(p + '.behavior.mode', '支持 idle / attack / cycle / priority');
    if (!['idle', 'attack'].includes(ai.fallback)) fail(p + '.behavior.fallback', '支持 idle / attack');
    const actions = list(ai.actions, p + '.behavior.actions');
    if (['cycle', 'priority'].includes(ai.mode) && !actions.length) fail(p + '.behavior.actions', '循环或优先级模式至少需要一个行动');
    actions.forEach((value, n) => {
      const ap = `${p}.behavior.actions[${n}]`, action = object(value, ap); fields(action, ['type', 'skill', 'when'], ap);
      if (!['idle', 'attack', 'defend', 'skill'].includes(action.type)) fail(ap + '.type', '无效的敌人行动');
      if (action.type === 'skill') { if (!learned.includes(action.skill)) fail(ap + '.skill', '必须引用该敌人已掌握的技能'); }
      else if (action.skill !== undefined) fail(ap + '.skill', '只有技能行动才能指定 skill');
      if (action.when !== undefined) {
        const when = object(action.when, ap + '.when'); fields(when, ['healthBelowPercent', 'every'], ap + '.when');
        if (when.healthBelowPercent !== undefined) number(when.healthBelowPercent, ap + '.when.healthBelowPercent', 0, 100);
        if (when.every !== undefined) number(when.every, ap + '.when.every', 1, 1000, true);
      }
    });

  });
  unique(enemies, 'enemies.json');
  // 防止基础名本身带后缀时，与自动生成的战斗标识撞名。
  for (const encounter of encounters) {
    const members = encounter.members.flatMap((member: any) => Array.from({ length: member.count }, () => enemies.find(enemy => enemy.id === member.enemyId)!));
    const seen = new Map<string, number>();
    const labels = members.map((enemy: any) => {
      const index = seen.get(enemy.name) ?? 0; seen.set(enemy.name, index + 1);
      return members.filter((other: any) => other.name === enemy.name).length > 1 ? `${enemy.name} ${String.fromCharCode(65 + index)}` : enemy.name;
    });
    if (new Set(labels).size !== labels.length) fail(`world.json.encounters.${encounter.id}`, '自动战斗后缀与其他敌人名称冲突');
  }
  const player = object(root.player, 'player.json'); fields(player, ['vitals', 'coins', 'unarmedAttack', 'equipment', 'skills', 'starterInventory'], 'player.json');
  const initialVitals = object(player.vitals, 'player.json.vitals'); fields(initialVitals, vitals, 'player.json.vitals');
  vitals.forEach(key => number(initialVitals[key], 'player.json.vitals.' + key, key === 'health' ? 1 : 0, 100));
  number(player.coins, 'player.json.coins', 0, 1000000, true); number(player.unarmedAttack, 'player.json.unarmedAttack');
  const starter = object(player.starterInventory, 'player.json.starterInventory'); fields(starter, [...kinds, 'items'], 'player.json.starterInventory');
  kinds.forEach(key => number(starter[key], 'player.json.starterInventory.' + key, 0, 1000000, true));
  const extraItems = object(starter.items, 'player.json.starterInventory.items');
  for (const [key, amount] of Object.entries(extraItems)) { if (!itemMap.has(key)) fail('player.json.starterInventory.items.' + key, '物品不存在'); number(amount, 'player.json.starterInventory.items.' + key, 0, 1000000, true); }
  const equipment = object(player.equipment, 'player.json.equipment'); fields(equipment, slots, 'player.json.equipment');
  for (const slot of slots) {
    const value = equipment[slot]; if (value === null) continue;
    const item = itemMap.get(value);
    if (!item || item.kind !== 'equipment' || item.slot !== slot) fail('player.json.equipment.' + slot, '引用不存在或槽位不符的装备');
    if (!(Number(extraItems[value] ?? starter.equipment) > 0)) fail('player.json.equipment.' + slot, '初始背包必须持有此装备');
  }
  if (player.skills !== 'all') {
    const learned = list(player.skills, 'player.json.skills');
    if (new Set(learned).size !== learned.length || learned.some(id => !skillIds.has(id))) fail('player.json.skills', '技能重复或引用不存在');
  }
  // 克隆后返回，避免后续游戏状态修改污染原始输入和配置文件。
  return structuredClone(root) as GameConfig;
}
export function loadGameConfig(directory = process.env.TEXTGAME_CONFIG_DIR ?? fileURLToPath(new URL('../config/', import.meta.url))): GameConfig {
  const read = (name: string) => {
    const path = resolve(directory, name + '.json');
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`无法读取配置 ${path}：${error instanceof Error ? error.message : String(error)}`); }
  };
  return validateConfig({ items: read('items'), skills: read('skills'), world: read('world'), player: read('player'), enemies: read('enemies') });
}
export const gameConfig = loadGameConfig();
export const mapDefinitions: Record<string, MapDefinition> = Object.fromEntries(gameConfig.world.maps.map(map => [map.id, map]));
// 联机以服务器下发的配置为准；保留数组和地图表引用，所有模块随之更新。
export function applyGameConfig(raw: unknown) {
  const next = validateConfig(raw);
  gameConfig.items.splice(0, gameConfig.items.length, ...next.items);
  gameConfig.skills.splice(0, gameConfig.skills.length, ...next.skills);
  gameConfig.enemies.splice(0, gameConfig.enemies.length, ...next.enemies);
  gameConfig.world = next.world;
  const vitals = gameConfig.player.vitals; Object.assign(vitals, next.player.vitals);
  gameConfig.player = { ...next.player, vitals };
  Object.keys(mapDefinitions).forEach(key => delete mapDefinitions[key]);
  Object.assign(mapDefinitions, Object.fromEntries(next.world.maps.map(map => [map.id, map])));
}
