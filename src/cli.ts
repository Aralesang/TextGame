import { applyGameConfig } from './config.js';
import readline from 'node:readline';
import { TerminalUI } from './tui.js';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createGameServer } from './server.js';
import { clean, help, parseCommand, render, type Display, type View } from './terminal.js';

// 一个主客户端拥有一个远程角色；附加窗口仅连接本机中继，不向世界创建角色。
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const view = (option('--view') ?? 'all') as View;
  if (!['all', 'status', 'inventory', 'map', 'events', 'commands'].includes(view)) throw new Error('--view 支持 all/status/inventory/map/events/commands');
  const attach = option('--attach');
  if (args.includes('--attach') && !attach) throw new Error('--attach 后需要主窗口显示的连接码');
  let display: Display = { events: [], connection: '正在连接', attach: '' };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let closed = false;
  let tui: TerminalUI | undefined;
  const fixedScreen = !!process.stdin.isTTY && !!process.stdout.isTTY && view === 'all';
  let socket: WebSocket | undefined;
  let broker: WebSocketServer | undefined;
  let owned: ReturnType<typeof createGameServer> | undefined;
  const interactive = view === 'all' || view === 'commands';
  const paint = () => {
    if (closed) return;
    if (tui) { tui.draw(); return; }
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    console.log(render(display, view, process.stdout.rows));
    if (interactive) { rl.setPrompt('> '); rl.prompt(true); }
  };
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    tui?.close();
    socket?.terminate(); broker?.clients.forEach(s => s.terminate());
    broker?.close(); rl.close(); process.stdin.pause(); process.stdin.destroy();
    process.stdout.removeListener('resize', paint);
    if (owned) await owned.close();
    console.log('\n已退出。');
  };
  rl.on('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.stdout.on('resize', paint);
  try {
    if (attach) {
      const match = /^(\d+):([a-f0-9]{32})$/.exec(attach);
      if (!match || Number(match[1]) > 65535) throw new Error('附加窗口连接码无效');
      socket = new WebSocket(`ws://127.0.0.1:${match[1]}/?token=${match[2]}`);
      socket.on('message', raw => { display = JSON.parse(raw.toString()); paint(); });
    } else {
      let url = option('--connect');
      if (args.includes('--connect') && !url) throw new Error('--connect 后需要服务器地址，例如 ws://192.168.1.2:3000/ws');
      if (!url) {
        const port = Number(process.env.PORT ?? 3000);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1～65535');
        owned = createGameServer();
        const app = owned;
        await new Promise<void>((resolve, reject) => {
          app.server.once('error', reject);
          app.server.listen(port, args.includes('--multiplayer') ? '0.0.0.0' : '127.0.0.1', resolve);
        });
        url = `ws://127.0.0.1:${port}/ws`;
      }
      const parsed = new URL(url);
      if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('服务器地址必须以 ws:// 或 wss:// 开头');
      if (parsed.pathname === '/') parsed.pathname = '/ws';
      // 自动生成可读昵称并带随机后缀，测试时无需交互输入；显式昵称仍优先。
      const prefixes = ['晨雾', '星河', '松林', '晚风', '流云', '月影'];
      const randomName = `${prefixes[randomBytes(1)[0] % prefixes.length]}旅人-${randomBytes(3).toString('hex')}`;
      const name = option('--name') ?? randomName;
      const token = randomBytes(16).toString('hex');
      broker = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 4096 });
      await new Promise<void>((resolve, reject) => { broker!.once('listening', resolve); broker!.once('error', reject); });
      const address = broker.address();
      if (typeof address !== 'object' || !address) throw new Error('本机会话启动失败');
      display.attach = `${address.port}:${token}`;
      const attached = new Set<WebSocket>();
      const publish = () => {
        paint();
        attached.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(display)); });
      };
      const event = (text: string) => { display.events.push(clean(text)); display.events = display.events.slice(-150); publish(); };
      broker.on('connection', (client, req) => {
        if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') !== token) { client.close(1008); return; }
        attached.add(client);
        client.on('close', () => attached.delete(client));
        client.on('error', () => client.terminate());
        client.send(JSON.stringify(display));
        client.on('message', raw => {
          try {
            const data = JSON.parse(raw.toString());
            if (typeof data.command === 'string' && data.command.length <= 1000) execute(data.command);
          } catch { client.close(1008); }
        });
      });
      socket = new WebSocket(parsed);
      socket.on('open', () => socket!.send(JSON.stringify({ type: 'join', name })));
      socket.on('message', raw => {
        const data = JSON.parse(raw.toString());
        if (data.type === 'config') {
          try { applyGameConfig(data.config); }
          catch (error) { event(`服务器配置无效：${error instanceof Error ? error.message : String(error)}`); void shutdown(); }
        } else if (data.type === 'corpseView') {
          display.corpse = data.view; paint();
        } else if (data.type === 'corpseClosed') {
          display.corpse = undefined; paint();
        } else if (data.type === 'state') {
          const previousCombat = display.state?.players.find(p => p.id === display.state!.selfId)?.combat;
          const nextCombat = data.players.find((p: { id: string }) => p.id === data.selfId)?.combat;
          // 进入遭遇时清理探索记录，让战斗窗口只展示本次行动与结果。
          if (!previousCombat && nextCombat) display.commands = [];
          display.state = data; display.connection = '已连接'; publish();

        }
        else if (data.type === 'combatSequence') {
          display.commands ??= []; display.commands.push(...data.lines.map(clean)); display.commands = display.commands.slice(-150);
          tui?.presentBattle(data.lines, data.round, data.nextRound, data.outcome); publish();
          if (!tui && data.outcome) sendComplete();
        }
        else if (data.type === 'error' || data.type === 'message') {
          if (data.type === 'error') tui?.battleError(data.text);
          else if (data.kind === 'result') tui?.battleResult(data.text);
          if (data.type === 'error' || data.kind === 'result') {
            display.commands ??= []; display.commands.push(clean(data.text)); display.commands = display.commands.slice(-150); publish();
          } else event(data.text);
          if (data.type === 'error' && !display.state) void shutdown();
        }
      });
      display.events.push(`服务器：${parsed.href}`, '主窗口退出时角色离线；自建服务器也会关闭。');
      if (args.includes('--multiplayer')) {
        const { networkInterfaces } = await import('node:os');
        for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) display.events.push(`好友连接：npm run client -- ws://${a.address}:${process.env.PORT ?? 3000}/ws --name 好友`);
      }
    }
    function sendComplete() { socket?.send(JSON.stringify(attach ? { command: '结束战斗' } : { type: 'completeCombat' })); }
    function execute(line: string) {
      try {
        display.commands ??= []; display.commands.push('> ' + clean(line)); display.commands = display.commands.slice(-150);
        const command = parseCommand(line);
        if (command === 'quit') { void shutdown(); return; }
        if (command === 'inventory' || command === 'closeInventory') {
          if (!display.state) throw new Error('尚未连接到世界。');
          if (command === 'inventory' && display.state.players.find(p => p.id === display.state!.selfId)?.combat) throw new Error('战斗中请先「脱离战斗」，再打开背包。');
          if (tui) tui.showInventory(command === 'inventory');
          else if (command === 'inventory') {
            const self = display.state.players.find(p => p.id === display.state!.selfId);
            display.commands.push('背包：' + (Object.entries(self?.inventory ?? {}).filter(([, n]) => n > 0).map(([name, n]) => `${name} ×${n}`).join('、') || '空'));
          } else display.commands.push('背包已关闭。');
          paint(); return;
        }
        if (command === 'help') { tui?.battleResult(help); display.commands!.push(help); paint(); return; }
        if (socket?.readyState !== WebSocket.OPEN || !display.state) throw new Error('尚未连接到世界。');
        socket.send(JSON.stringify(attach ? { command: line } : command));
        paint();
      } catch (error) { tui?.battleError(error instanceof Error ? error.message : '命令失败'); display.commands ??= []; display.commands.push(error instanceof Error ? error.message : '命令失败'); paint(); }
    }
    if (fixedScreen) {
      // 由 TUI 管理原始键盘输入，避免 readline 回显推动界面。
      rl.close();
      tui = new TerminalUI(() => display, execute, () => { void shutdown(); });
    }
    rl.on('line', line => { if (interactive && line.trim()) execute(line); else paint(); });
    rl.on('close', () => { void shutdown(); });
    socket!.on('error', error => { display.events.push(`连接失败：${error.message}`); paint(); });
    socket!.on('close', () => { if (!closed) { display.connection = '连接已断开'; paint(); void shutdown(); } });
    paint();
  } catch (error) { await shutdown(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
