import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../src/server.js';

// 使用真实端口和两条 WebSocket 连接，覆盖共享世界的完整交互。
test('双客户端同步、竞争领取、聊天和离线清理', async () => {
  const app = createGameServer();
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const connect = async () => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
    const messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); });
    return { ws, messages, send: (data: unknown) => ws.send(JSON.stringify(data)) };
  };
  // 有界等待实际消息，失败时不留下悬挂测试。
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('等待服务器消息超时');
      await new Promise(r => setTimeout(r, 10));
    }
  };
  try {
    const response = await fetch(url + '/health');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /服务器运行中/);
    assert.equal((await fetch(url + '/src/server.ts')).status, 404);
    const a = await connect(), b = await connect();
    a.send({ type: 'join', name: '旅人甲' }); b.send({ type: 'join', name: '旅人乙' });
    await until(() => a.messages.some(m => m.type === 'state' && m.players.length === 2) && b.messages.some(m => m.type === 'state' && m.players.length === 2));
    a.send({ type: 'pickup', target: '金币' });
    await until(() => a.messages.some(m => m.type === 'error' && m.text.includes('这里没有该物品')));
    a.send({ type: 'move', target: 'forest' }); b.send({ type: 'move', target: 'forest' });
    await until(() => [...app.game.players.values()].every(p => p.location === 'forest'));
    a.send({ type: 'look' });
    await until(() => a.messages.some(m => m.type === 'message' && m.text.includes('金币（coin）×1') && m.text.includes('石头（stone）×1')));
    a.send({ type: 'pickup' });
    await until(() => a.messages.some(m => m.type === 'error' && m.text.includes('请指定物品')));
    a.send({ type: 'pickup', target: '不存在' });
    await until(() => a.messages.some(m => m.type === 'error' && m.text.includes('这里没有该物品')));
    assert.equal(app.game.coinAvailable, true);
    a.send({ type: 'pickup', target: '金币' }); b.send({ type: 'pickup', target: '金币' });
    await until(() => [...a.messages, ...b.messages].some(m => m.type === 'error' && m.text.includes('已经被')));
    assert.equal([...app.game.players.values()].reduce((sum, p) => sum + p.coins, 0), 1);
    for (const client of [a, b]) assert.equal(client.messages.filter(m => m.type === 'state').at(-1).coinAvailable, false);
    a.send({ type: 'pickup', target: 'stone' });
    await until(() => [...app.game.players.values()].some(p => p.inventory['石头'] === 1));
    assert.equal([...app.game.players.values()].reduce((sum, p) => sum + p.coins, 0), 1);
    a.send({ type: 'look' });
    await until(() => a.messages.some(m => m.type === 'message' && m.text.includes('森林：') && m.text.includes('地面物品：无')));
    a.send({ type: 'chat', text: '<script>你好</script>' });
    await until(() => b.messages.some(m => m.kind === 'chat' && m.text.includes('<script>你好</script>')));
    a.ws.send('{broken');
    await until(() => a.messages.some(m => m.type === 'error' && m.text === '无效消息格式。'));
    a.ws.close();
    await until(() => b.messages.some(m => m.type === 'state' && m.players.length === 1));
    assert.equal(app.game.players.size, 1);
  } finally { await app.close(); }
});

test('昵称校验与重复加入不会创建多余角色', async () => {
  const { Game } = await import('../src/game.js');
  const game = new Game();
  for (const name of ['', ' ', 'a'.repeat(17), '\n名字', null]) assert.throws(() => game.join(name));
  game.join('旅人');
  assert.throws(() => game.join(' 旅人 '));
  assert.equal(game.players.size, 1);
});

// 属性属于服务器上的各自角色，不能共用同一份可变对象。
test('新角色四项属性满值且互相独立', async () => {
  const { Game } = await import('../src/game.js');
  const game = new Game();
  const a = game.join('甲'), b = game.join('乙');
  assert.deepEqual(a.vitals, { health: 100, mana: 100, satiety: 100, hydration: 100 });
  a.vitals.health = 70;
  assert.equal(b.vitals.health, 100);
  assert.equal(game.snapshot(a.id).players.find(p => p.id === a.id)!.vitals.health, 70);
});
