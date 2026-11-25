import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { gameConfig, validateConfig, loadGameConfig, applyGameConfig } from '../src/config.js';
import { Game } from '../src/game.js';
import { stats, initialRpgState, itemDefinitions, skillDefinitions } from '../src/rpg.js';
import { parseCommand } from '../src/terminal.js';
import { screenLines } from '../src/tui.js';
import { createGameServer } from '../src/server.js';

// 校验类型、重复项和跨文件引用，防止配置错误在玩家行动时才暴露。
test('配置字段及引用校验', () => {
  const invalid = (mutate: (config: any) => void, pattern: RegExp) => {
    const config = structuredClone(gameConfig); mutate(config); assert.throws(() => validateConfig(config), pattern);
  };
  invalid(c => c.items[0].attack = -1, /items.json\[0\].attack/);
  invalid(c => c.items[0].atack = 10, /atack.*未知字段/);
  invalid(c => c.items.push({ ...c.items[0] }), /重复/);
  invalid(c => c.items[0].name = 'constructor', /保留字段/);
  invalid(c => c.items.find((i: any) => i.kind === 'potion').restore = { hp: 40 }, /restore.hp/);
  invalid(c => c.skills[0].target = 'nobody', /target/);
  invalid(c => c.skills[0].damage = 10, /二选一/);
  invalid(c => c.world.startMap = 'missing', /startMap/);
  invalid(c => c.world.maps[0].exits = ['missing'], /无效出口/);
  invalid(c => c.world.maps[1].groundItems[0].itemId = 'missing', /物品.*不存在/);
  invalid(c => c.world.maps[0].encounters[0].members[0].enemyId = 'missing', /enemyId/);
  invalid(c => c.player.equipment.weapon = 'cloth', /槽位不符/);
  invalid(c => c.player.starterInventory.items.wood_sword = 0, /必须持有/);
  invalid(c => c.player.skills = ['missing'], /技能重复或引用不存在/);
});

// 写入临时 JSON，再运行原有引擎；不改任何 TypeScript 即可新增内容。
test('仅改 JSON 定义新物品、技能和地图，并由服务器同步到旧本地配置的客户端', { timeout: 15000 }, async () => {
  const original = structuredClone(gameConfig);
  const config = structuredClone(gameConfig);
  config.items.push(
    { id: 'test_blade', name: '配置测试剑', kind: 'equipment', slot: 'weapon', attack: 27, description: '来自配置的武器' },
    { id: 'test_herb', name: '配置草药', kind: 'consumable', restore: { health: 5 }, description: '恢复生命5' },
  );
  config.skills.push({ id: 'test_spark', name: '配置火花', cost: 3, target: 'enemy', damage: 7, description: '单体魔法伤害7' });
  config.world.maps[0].name = '中央营地';
  config.world.maps[0].exits.push('lake');
  config.world.maps.push({ id: 'lake', name: '湖畔', description: '湖水静静流动。', exits: ['camp'], groundItems: [{ id: 'herb_spawn', itemId: 'test_herb', quantity: 2 }] });
  config.enemies[0].name = '训练人偶';
  config.world.maps[0].encounters![0].members[0].count = 3;
  config.player.starterInventory.items.test_herb = 0;
  const directory = mkdtempSync(join(tmpdir(), 'textgame-config-'));
  let app: ReturnType<typeof createGameServer> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('等待配置集成测试超时：' + output.slice(-1500));
      await new Promise(r => setTimeout(r, 10));
    }
  };
  try {
    for (const name of ['items', 'skills', 'world', 'player', 'enemies'] as const) writeFileSync(join(directory, name + '.json'), JSON.stringify(config[name]));
    applyGameConfig(loadGameConfig(directory));
    assert(itemDefinitions.some(i => i.id === 'test_blade'));
    assert(skillDefinitions.some(s => s.id === 'test_spark'));
    assert(initialRpgState().skills.includes('test_spark'));
    assert.deepEqual(parseCommand('前往 湖畔'), { type: 'move', target: 'lake' });
    const game = new Game(), p = game.join('本地验证');
    game.changeEquipment(p, '配置测试剑'); assert.equal(stats(p).attack, 27);
    game.attack(p, '训练人偶 C'); assert.equal(p.combat!.enemyIds.length, 3);
    const screen = screenLines({ state: game.snapshot(p.id), events: [], commands: [], connection: '已连接', attach: '' }, { width: 80, height: 24, focus: 'commands', eventOffset: 0, commandOffset: 0, input: '' }).join('\n');
    assert(screen.includes('中央营地 · 练习战斗'));
    assert(screen.includes('训练人偶 A') && screen.includes('训练人偶 B') && screen.includes('▶ [3] 训练人偶 C'));
    assert.equal(game.defend(p).filter(l => l.includes('一动不动')).length, 3);
    game.move(p, 'lake'); assert.match(game.look(p), /配置草药/);
    game.pickup(p, '配置草药'); assert.equal(p.inventory['配置草药'], 1);
    p.vitals.health = 90; game.useItem(p, '配置草药'); assert.equal(p.vitals.health, 95);
    game.move(p, 'camp'); game.move(p, 'forest');
    assert.throws(() => game.move(p, 'lake'), /没有通往/);
    app = createGameServer();
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert(address && typeof address === 'object');
    child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--connect', `ws://127.0.0.1:${address.port}/ws`, '--name', '配置联机玩家'], {
      env: { ...process.env, TEXTGAME_CONFIG_DIR: fileURLToPath(new URL('../config/', import.meta.url)) }, stdio: 'pipe',
    });
    child.stdout!.on('data', data => { output += data.toString(); }); child.stderr!.on('data', data => { output += data.toString(); });
    await until(() => output.includes('中央营地'));
    const remotePlayer = () => [...app!.game.players.values()].find(p => p.name === '配置联机玩家')!;
    child.stdin!.write('装备 配置测试剑\n');
    await until(() => remotePlayer()?.equipment.weapon === 'test_blade');
    child.stdin!.write('攻击 训练人偶 C\n施放 配置火花 dummy-3\n');
    await until(() => remotePlayer()?.vitals.mana === 97);
    child.stdin!.write('脱离战斗\n前往 湖畔\n拾取 配置草药\n');
    await until(() => remotePlayer()?.location === 'lake' && remotePlayer()?.inventory['配置草药'] === 1);
    assert(output.includes('配置测试剑'));
    child.stdin!.write('退出\n');
    await until(() => child!.exitCode !== null);
    assert.equal(child.exitCode, 0);
  } finally {
    child?.kill('SIGKILL'); if (app) await app.close();
    applyGameConfig(original); rmSync(directory, { recursive: true, force: true });
  }
});
