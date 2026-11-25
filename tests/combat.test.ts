import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Game, initialVitals } from '../src/game.js';
import { createGameServer } from '../src/server.js';
import { parseCommand } from '../src/terminal.js';

// 重复攻击仍无限生命，目标每次行动均不反击；多人独立回合共享木桩统计。
test('木桩无限生命、完整回合与多人独立练习', () => {
  const game = new Game(), a = game.join('甲'), b = game.join('乙');
  assert.equal(game.dummies.filter(d => d.location === 'camp').length, 2);
  assert.match(game.look(a), /木桩 ×2/);
  assert.doesNotMatch(game.look(a), /木桩 [AB]/);
  assert.throws(() => game.attack(a, undefined), /请指定目标/);
  assert.throws(() => game.attack(a, '木桩3'), /没有这个攻击目标/);
  const entry = game.attack(a, '木桩');
  assert.equal(entry.started, true);
  assert.equal(a.combat!.round, 1);
  assert.deepEqual(a.combat!.enemyIds, ['dummy-1', 'dummy-2']);
  assert.equal(game.dummies[0].hits, 0);
  for (let round = 1; round <= 100; round++) {
    const result = game.attack(a, round === 1 ? '木桩 A' : undefined);
    assert.equal(result.round, round);
    assert(result.lines.some(line => line.includes('木桩 A的回合：木桩 A一动不动，没有反击')));
    assert(result.lines.some(line => line.includes('木桩 B的回合：木桩 B一动不动，没有反击')));
    assert.equal(a.combat!.turn, 'player');
    assert.equal(a.combat!.round, round + 1);
  }
  assert.deepEqual(a.vitals, initialVitals);
  assert.equal(game.dummies[0].health, 'infinite');
  assert.equal(game.dummies[0].damageTaken, 1000);
  assert.equal(game.dummies[1].hits, 0);
  game.selectCombatTarget(a, '2');
  assert.equal(a.combat!.targetId, 'dummy-2');
  assert.equal(a.combat!.round, 101);
  assert.throws(() => game.selectCombatTarget(a, 'dummy-3'));
  game.selectCombatTarget(a, '1');
  game.attack(b, 'dummy-1');
  game.attack(b, undefined);
  assert.equal(b.combat!.round, 2);
  assert.equal(a.combat!.round, 101);
  assert.equal(game.dummies[0].hits, 101);
  const wire = JSON.parse(JSON.stringify(game.snapshot(a.id)));
  assert.equal(wire.dummies[0].health, 'infinite');
  assert.match(game.combatStatus(a), /累计伤害 1000/);
  const defense = game.defend(a);
  assert.equal(a.combat!.round, 102);
  assert.equal(game.dummies[0].hits, 101);
  assert(defense.some(line => line.includes('木桩 B的回合')));
  game.attack(a, '木桩 B');
  assert.equal(a.combat!.targetId, 'dummy-2');
  assert.equal(game.dummies[1].hits, 1);
  game.leaveCombat(a);
  assert.equal(a.combat, null);
  game.attack(a, 'dummy-2');
  game.move(a, 'forest');
  assert.equal(a.combat, null);
  assert.throws(() => game.attack(a, 'dummy-1'), /没有这个攻击目标/);
  assert.deepEqual(parseCommand('攻击 木桩 B'), { type: 'attack', target: '木桩 B' });
  assert.deepEqual(parseCommand('攻击'), { type: 'attack' });
  assert.deepEqual(parseCommand('脱离战斗'), { type: 'leaveCombat' });
});

// 使用真实连接验证结果顺序、客户端不能伪造伤害、旁观玩家收到同步。
test('服务器战斗判定与双客户端同步', async () => {
  const app = createGameServer();
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert(address && typeof address === 'object');
  const connect = async (name: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', name }));
    return { ws, messages, send: (data: unknown) => ws.send(JSON.stringify(data)) };
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('等待战斗消息超时'); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    const a = await connect('甲'), b = await connect('乙');
    await until(() => app.game.players.size === 2);
    a.send({ type: 'attack', target: 'dummy-1', damage: 999999 });
    await until(() => a.messages.some(m => m.type === 'state' && m.players.find((p: any) => p.id === m.selfId)?.combat?.enemyIds.length === 2));
    assert.equal(app.game.dummies[0].hits, 0);
    a.send({ type: 'attack', damage: 999999 });
    await until(() => a.messages.some(m => m.type === 'combatSequence' && m.nextRound === 2) && b.messages.some(m => m.type === 'state' && m.dummies[0].hits === 1));
    assert.equal(app.game.dummies[0].damageTaken, 10);
    const results = a.messages.filter(m => m.type === 'combatSequence').flatMap(m => m.lines);
    assert(results.findIndex(t => t.includes('造成 10 点伤害')) < results.findIndex(t => t.includes('木桩 A的回合')));
    assert(b.messages.some(m => m.text?.includes('甲 第1回合攻击木桩 A')));
    a.send({ type: 'attack' }); b.send({ type: 'attack', target: '木桩 B' });
    b.send({ type: 'attack' });
    await until(() => app.game.dummies[0].hits === 2 && app.game.dummies[1].hits === 1);
    for (const player of app.game.players.values()) assert.equal(player.vitals.health, 100);
    a.send({ type: 'leaveCombat' });
    await until(() => a.messages.some(m => m.text?.includes('你结束了与木桩 A')));
    a.ws.close(); b.ws.close();
  } finally { await app.close(); }
});
