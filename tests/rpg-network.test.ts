import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server.js';

// 实际联网验证换装、技能、药水统一消耗回合，旁观者同步且不能伪造数值。
test('装备技能药水的双客户端服务器结算', async () => {
  const app = createGameServer();
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert(address && typeof address === 'object');
  const connect = async (name: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', name }));
    return { messages, send: (value: unknown) => ws.send(JSON.stringify(value)) };
  };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('等待 RPG 联机同步超时'); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    const a = await connect('练习者'), b = await connect('旁观者');
    await until(() => app.game.players.size === 2);
    const player = [...app.game.players.values()].find(p => p.name === '练习者')!;
    a.send({ type: 'attack', target: '木桩 A' });
    await until(() => !!player.combat);
    a.send({ type: 'equip', item: '力量戒指' });
    await until(() => b.messages.some(m => m.type === 'state' && m.players.some((p: any) => p.name === '练习者' && p.equipment.accessory === 'power_ring' && p.combat.round === 2)));
    assert.equal(app.game.dummies[0].hits, 0);
    a.send({ type: 'attack', damage: 10000 });
    await until(() => player.combat!.round === 3);
    assert.equal(app.game.dummies[0].damageTaken, 14);
    a.send({ type: 'useSkill', skill: 'fireball', target: 'dummy-2', cost: 0, damage: 10000 });
    await until(() => player.combat!.round === 4);
    assert.equal(player.vitals.mana, 88);
    assert.equal(app.game.dummies[1].damageTaken, 30);
    a.send({ type: 'useItem', item: 'mana_potion' });
    await until(() => player.combat!.round === 5);
    assert.equal(player.vitals.mana, 100);
    assert.equal(player.inventory['法力药水'], 2);
    a.send({ type: 'equip', item: 'chainmail' });
    await until(() => player.combat!.round === 6);
    a.send({ type: 'equip', item: 'iron_helm' });
    await until(() => player.combat!.round === 7);
    a.send({ type: 'equip', item: 'iron_helm' });
    a.send({ type: 'useItem', item: 'health_potion' });
    await until(() => a.messages.filter(m => m.type === 'error').length === 2);
    assert.equal(player.combat!.round, 7);
    assert.equal(player.inventory['生命药水'], 3);
    const sequences = a.messages.filter(m => m.type === 'combatSequence' && m.round > 0 && m.lines.some((line: string) => line.includes('一动不动')));
    assert.equal(sequences.length, 6);
    for (const sequence of sequences) assert.equal(sequence.lines.filter((line: string) => line.includes('一动不动')).length, 2);
    const peer = [...app.game.players.values()].find(p => p.name === '旁观者')!;
    assert.equal(peer.vitals.mana, 100);
    assert.equal(peer.equipment.accessory, null);
    assert.equal(peer.inventory['法力药水'], 3);
  } finally { await app.close(); }
});
