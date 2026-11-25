import { initialRpgState } from '../src/rpg.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { parseCommand, render, clean } from '../src/terminal.js';

// 验证命令映射、终端控制字符过滤与各独立视图。
test('终端指令及视图', () => {
  assert.deepEqual(parseCommand('前往 森林'), { type: 'move', target: 'forest' });
  assert.deepEqual(parseCommand('说 你好 世界'), { type: 'chat', text: '你好 世界' });
  assert.throws(() => parseCommand('前往 月球'));
  assert.equal(parseCommand('背包'), 'inventory');
  assert.equal(parseCommand('关闭背包'), 'closeInventory');
  assert.deepEqual(parseCommand('查看'), { type: 'look' });
  assert.deepEqual(parseCommand('拾取 石头'), { type: 'pickup', target: '石头' });
  assert.throws(() => parseCommand('拾取'), /请指定物品/);
  assert.equal(clean('\x1b[2J名字\r'), '[2J名字');
  const display = { connection: '已连接', attach: '123:abc', events: ['测试事件'], state: { selfId: 'a', players: [{ ...initialRpgState(), id: 'a', name: '甲', location: 'camp' as const, coins: 0, combat: null, vitals: { health: 100, mana: 100, satiety: 100, hydration: 100 }, inventory: {} }], coinAvailable: true, dummies: [], items: [], places: { camp: { id: 'camp', exits: [], groundItems: [], name: '营地', description: '' } } } };
  assert.match(render(display, 'all'), /角色状态[\s\S]*地图[\s\S]*事件与聊天[\s\S]*命令/);
  assert.doesNotMatch(render(display, 'status'), /── 地图/);
});

// 启动真实命令行进程并附加观察窗口，确保附加窗口不生成新玩家。
test('命令行会话、独立视图、拾取与退出', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--name', '命令行甲'], { env: { ...process.env, PORT: '31987' }, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const until = async (condition: () => boolean) => {
    const start = Date.now();
    while (!condition()) { if (Date.now() - start > 7000) throw new Error(output); await new Promise(r => setTimeout(r, 20)); }
  };
  let observer: WebSocket | undefined;
  try {
    await until(() => output.includes('命令行甲 · 营地'));
    const code = output.match(/--attach (\d+):([a-f0-9]{32})/)!;
    observer = new WebSocket(`ws://127.0.0.1:${code[1]}/?token=${code[2]}`);
    const snapshots: any[] = [];
    observer.on('message', raw => snapshots.push(JSON.parse(raw.toString())));
    await until(() => snapshots.some(s => s.state?.players.length === 1));
    child.stdin.write('前往 森林\n');
    await until(() => snapshots.some(s => s.state?.players[0].location === 'forest'));
    child.stdin.write('查看\n');
    await until(() => output.includes('金币（coin）×1') && output.includes('石头（stone）×1'));
    observer.send(JSON.stringify({ command: '拾取 金币' }));
    await until(() => snapshots.some(s => s.state?.players[0].coins === 1));
    assert.equal(snapshots.at(-1).state.players.length, 1);
    child.stdin.write('背包\n');
    await until(() => output.includes('背包：') && output.includes('金币 ×1'));
    child.stdin.write('关闭背包\n');
    await until(() => output.includes('背包已关闭。'));
    observer.close();
    child.stdin.write('说 终端测试通过\n');
    await until(() => output.includes('命令行甲：终端测试通过'));
    child.stdin.write('退出\n');
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
  } finally { observer?.terminate(); child.kill('SIGKILL'); }
});
