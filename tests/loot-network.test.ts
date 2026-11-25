import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { gameConfig, applyGameConfig } from '../src/config.js';
import { createGameServer } from '../src/server.js';

// 两名玩家把同一尸体当共享容器操作，所有领取与分解必须保持物品守恒。
test('联机竞争搜刮与分解只结算一次，并同步关闭失效容器', async () => {
  const original = structuredClone(gameConfig), config = structuredClone(gameConfig);
  const definition = config.enemies.find(e => e.id === 'forest_rat')!;
  Object.assign(definition, { health: 1, defense: 0, attack: 0, skills: [], behavior: { mode: 'idle', fallback: 'idle', actions: [] },
    loot: [{ itemId: 'coin', chance: 1, min: 1, max: 1 }, { itemId: 'health_potion', chance: 1, min: 1, max: 1 }], resources: [{ itemId: 'raw_meat', quantity: 2 }, { itemId: 'bone', quantity: 1 }] });
  applyGameConfig(config);
  const app = createGameServer();
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('等待搜刮同步超时'); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert(address && typeof address === 'object');
    const connect = async (name: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`), messages: any[] = [];
      ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const send = (data: unknown) => ws.send(JSON.stringify(data)); send({ type: 'join', name }); send({ type: 'move', target: 'forest' });
      await until(() => messages.some(m => m.type === 'state' && m.players.some((p: any) => p.id === m.selfId && p.location === 'forest')));
      return { messages, send };
    };
    const a = await connect('甲'), b = await connect('乙');
    assert(a.messages.filter(m => m.type === 'state').every(m => m.dummies.every((enemy: any) => !('inventory' in enemy))));
    a.send({ type: 'attack', target: '森林鼠' }); a.send({ type: 'attack' });
    await until(() => a.messages.some(m => m.type === 'combatSequence' && m.outcome === 'victory'));
    a.send({ type: 'completeCombat' });
    await until(() => [...app.game.players.values()].find(p => p.name === '甲')!.combat === null);
    a.send({ type: 'searchCorpse', target: '森林鼠' }); b.send({ type: 'searchCorpse', target: '森林鼠' });
    await until(() => [a, b].every(c => c.messages.some(m => m.type === 'corpseView' && m.view.items.length === 2)));
    a.send({ type: 'takeCorpseItem', item: 'coin', quantity: 1 }); b.send({ type: 'takeCorpseItem', item: 'coin', quantity: 1 });
    await until(() => [...a.messages, ...b.messages].some(m => m.type === 'error' && m.text.includes('没有该物品')));
    assert.equal([...app.game.players.values()].reduce((sum, p) => sum + p.coins, 0), 1);
    await until(() => [a, b].every(c => c.messages.filter(m => m.type === 'corpseView').at(-1)?.view.items.every((i: any) => i.itemId !== 'coin')));
    // 拿取与分解同时到达，药水只能进一名玩家背包或进入地面，不能两者都有。
    b.send({ type: 'decomposeCorpse', target: 'rat_group-1' });
    a.send({ type: 'takeCorpseItem', item: 'health_potion', quantity: 1 }); a.send({ type: 'decomposeCorpse', target: 'rat_group-1' });
    await until(() => [a, b].every(c => c.messages.some(m => m.type === 'corpseClosed')));
    const drops = app.game.items.filter(i => i.id.startsWith('drop-'));
    assert.equal(drops.filter(i => i.itemId === 'raw_meat').reduce((sum, i) => sum + i.quantity, 0), 2);
    assert.equal(drops.filter(i => i.itemId === 'bone').reduce((sum, i) => sum + i.quantity, 0), 1);
    const bags = [...app.game.players.values()].reduce((sum, p) => sum + p.inventory['生命药水'] - 3, 0);
    const ground = drops.filter(i => i.itemId === 'health_potion').reduce((sum, i) => sum + i.quantity, 0);
    assert.equal(bags + ground, 1);
    assert.equal(app.game.snapshot([...app.game.players.keys()][0]).corpses.length, 0);
    const quantity = drops.reduce((sum, i) => sum + i.quantity, 0);
    b.send({ type: 'decomposeCorpse', target: 'rat_group-1' });
    await until(() => b.messages.some(m => m.type === 'error' && m.text.includes('已经被分解')));
    assert.equal(app.game.items.filter(i => i.id.startsWith('drop-')).reduce((sum, i) => sum + i.quantity, 0), quantity);
  } finally { await app.close(); applyGameConfig(original); }
});
