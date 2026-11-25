import { corpseChoices } from './corpse-menu.js';
import { healthText, isAlive, worldEnemySummary } from './combat.js';
import readline from 'node:readline';
import { BattleFlow, battleActions } from './battle-flow.js';
import { battleOptions, stats, itemById, effectNames, type BattleOption } from './rpg.js';
import { clean, type Display } from './terminal.js';

// 按终端显示列处理中文、组合字符和常用 emoji，防止边框被文字挤动。
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string) => [...segmenter.segment(text)].map(part => part.segment);
export function cellWidth(text: string): number {
  return graphemes(clean(text)).reduce((sum, c) => sum + (/\p{Emoji_Presentation}|\uFE0F/u.test(c) || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(c) ? 2 : /^\p{Mark}+$/u.test(c) ? 0 : 1), 0);
}
export function fit(text: string, width: number) {
  let result = '', used = 0;
  for (const c of graphemes(clean(text))) { const size = cellWidth(c); if (used + size > width) break; result += c; used += size; }
  return result + ' '.repeat(Math.max(0, width - used));
}
function wrap(text: string, width: number) {
  const lines: string[] = []; let line = '', used = 0;
  for (const c of graphemes(clean(text))) {
    const size = cellWidth(c);
    if (used + size > width) { lines.push(line); line = ''; used = 0; }
    line += c; used += size;
  }
  lines.push(line); return lines;
}
export interface ScreenOptions { width: number; height: number; focus: 'events' | 'commands'; inventoryPage?: number; inventoryOpen?: boolean; eventOffset: number; commandOffset: number; input: string; battle?: Pick<BattleFlow, 'mode' | 'menuIndex' | 'targetIndex' | 'message' | 'round' | 'history' | 'optionIndex' | 'options'>; battleCommandMode?: boolean; battleHistoryOffset?: number; corpseIndex?: number }
// 经典回合制布局：上方完整敌阵，中间累积展示战斗历史，下方菜单与队伍状态。
function battleScreen(display: Display, options: ScreenOptions): string[] {
  const state = display.state!, self = state.players.find(p => p.id === state.selfId)!, combat = self.combat!;
  const w = options.width - 1, inside = w - 4;
  const flow = options.battle ?? { mode: 'menu', menuIndex: 0, targetIndex: combat.enemyIds.indexOf(combat.targetId), message: '你要怎么做？', round: combat.round, history: [] as string[], optionIndex: 0, options: [] as BattleOption[] };
  const center = (text: string, size: number) => fit(' '.repeat(Math.max(0, Math.floor((size - cellWidth(text)) / 2))) + text, size);
  const rule = (text: string, size: number) => fit(`─ ${text} `, size).replace(/ +$/, p => '─'.repeat(p.length));
  const full = (text: string) => `│ ${fit(text, inside)} │`;
  const row = (label: string) => `├${rule(label, w - 2)}┤`;
  let phase = flow.mode === 'menu' ? '选择行动' : flow.mode === 'target' ? '选择攻击目标' : flow.mode === 'waiting' ? '正在结算' : flow.mode === 'skills' ? '选择技能' : flow.mode === 'items' ? '选择道具' : flow.mode === 'equipment' ? '更换装备' : '行动结果';
  if (flow.mode === 'narration') {
    const actor = state.dummies.find(enemy => flow.message.startsWith(`${enemy.battleName}的回合：`));
    if (actor) phase = `${actor.battleName}的行动`;
    else if (flow.message.includes('你攻击') || flow.message.includes('防御姿态') || flow.message.includes('你施放') || /^(使用|更换|卸下)/u.test(flow.message)) phase = '你的行动';
  }
  const acting = flow.mode === 'narration' ? state.dummies.find(enemy => flow.message.startsWith(`${enemy.battleName}的回合：`))?.id : undefined;
  const members = combat.enemyIds.map(id => state.dummies.find(d => d.id === id)!);
  const names = members.map((enemy, i) => `${!isAlive(enemy) ? '× ' : enemy.id === acting ? '◆ ' : flow.targetIndex === i ? '▶ ' : '  '}[${i + 1}] ${enemy.battleName}`);
  const half = Math.floor(inside / 2);
  const scene = (texts: string[]) => texts.length === 1 ? center(texts[0], inside) : center(texts[0] ?? '', half) + center(texts[1] ?? '', inside - half);
  // 少量目标保持经典阵型，更多目标按两列展开，最多展示配置允许的十个目标。
  const arena = combat.enemyIds.length <= 2 ? ['', scene(names), scene(members.map(enemy => `生命值 ${healthText(enemy)}`)), scene(combat.enemyIds.map((id, i) => !isAlive(members[i]) ? '已经倒下' : id === acting ? '正在行动' : flow.targetIndex === i ? '当前目标' : '')), '']
    : Array.from({ length: 5 }, (_, row) => scene(names.slice(row * 2, row * 2 + 2).map((name, col) => `${name} HP ${healthText(members[row * 2 + col])}`)));
  const result = [`┌${rule(`${state.places[self.location].name} · ${members.every(e => e.maxHealth === "infinite") ? "练习战斗" : "回合制战斗"}`, w - 2)}┐`, full(center(`第 ${flow.round} 回合 · ${phase}`, inside)), ...arena.map(full), row(options.battleHistoryOffset ? '战斗消息 · 历史记录' : '战斗消息 · 最新记录')];
  const messageHeight = options.height - 17;
  // 只追加已经播出的结果，后续待播内容不能提前出现在历史中。
  const historyLines = flow.history.length ? flow.history.flatMap(message => wrap(message, inside)) : wrap(flow.message, inside);
  const end = Math.max(0, historyLines.length - (options.battleHistoryOffset ?? 0));
  const messageLines = historyLines.slice(Math.max(0, end - messageHeight), end);
  for (let i = 0; i < messageHeight; i++) result.push(full(messageLines[i] ?? ''));
  const left = Math.floor((w - 7) / 3), right = w - 7 - left;
  const subList = ['skills', 'items', 'equipment'].includes(flow.mode);
  result.push(`├${rule(subList ? `${flow.mode === 'skills' ? '技能' : flow.mode === 'items' ? '道具' : '装备'} ${flow.optionIndex + 1}/${flow.options.length}` : '指令', left + 2)}┬${rule('队伍状态', right + 2)}┤`);
  const listStart = Math.floor(flow.optionIndex / 4) * 4;
  const list = flow.options.slice(listStart, listStart + 4);
  const power = stats(self);
  const status = [self.name + ` · ${itemById(self.equipment.weapon)?.name ?? '空手'}`, `HP ${self.vitals.health}/100 · MP ${self.vitals.mana}/100`, `攻击 ${power.attack} 防御 ${power.defense} 魔法 ${power.magic}`, self.effects.length ? self.effects.map(e => `${effectNames[e.kind]}:${e.turns}`).join(' ') : `累计伤害 ${combat.damageDealt}`];
  for (let i = 0; i < 4; i++) {
    let text = '';
    if (subList) text = list[i] ? `${listStart + i === flow.optionIndex ? '▶' : ' '} ${list[i].label}` : '';
    else if (i < 3) {
      const halfMenu = Math.floor(left / 2);
      text = [i * 2, i * 2 + 1].map((n, col) => fit(`${flow.mode === 'menu' && flow.menuIndex === n ? '▶' : ' '} ${battleActions[n]}`, col === 0 ? halfMenu : left - halfMenu)).join('');
    } else text = flow.mode === 'target' ? '请选择敌人' : flow.mode === 'narration' ? '行动自动进行中' : '';

    result.push(`│ ${fit(text, left)} │ ${fit(status[i], right)} │`);
  }
  result.push(`├${rule('操作', left + 2)}┴${'─'.repeat(right + 2)}┤`);
  const hint = flow.mode === 'narration' ? '自动播放中 · PgUp/PgDn 翻阅战斗记录' : flow.mode === 'target' ? '← → 选择敌人 · 空格 确认目标 · Esc 返回' : flow.mode === 'waiting' ? '等待服务器响应……' : subList ? '↑ ↓ 选择 · 空格 确认 · Esc 返回' : '↑ ↓ ← → 选择行动 · 空格 确认 · PgUp/PgDn 记录 · / 命令';
  result.push(full(hint), full(options.battleCommandMode ? '> ' + options.input : flow.mode === 'target' ? '也可用数字选择目标（0代表第10个），空格确认。' : flow.mode === 'narration' ? '无需按键，播报结束后自动返回行动菜单。' : options.battleHistoryOffset ? '正在查看历史，PgDn 可返回最新记录。' : subList ? (flow.options[flow.optionIndex] ? `${flow.options[flow.optionIndex].disabled ? flow.options[flow.optionIndex].disabled + "；" : ""}${flow.options[flow.optionIndex].description}` : flow.message) : flow.message),
    `└${rule(options.battleCommandMode ? 'Enter 提交命令 · Esc 返回菜单' : '敌人倒下后不再行动 · 逃跑可返回探索', w - 2)}┘`);
  return result.map(line => fit(line, w));
}

export function screenLines(display: Display, options: ScreenOptions): string[] {
  const { width, height, focus, eventOffset, commandOffset, input } = options;
  const w = Math.max(10, width - 1);
  if (width < 60 || height < 22) return [`文字冒险 · ${display.connection} · 在线${display.state?.players.length ?? 0}`, '请将窗口放大到至少 60 列 × 22 行。', ...Array(Math.max(0, height - 4)).fill(''), '> ' + input].map(line => fit(line, w));
  const state = display.state, self = state?.players.find(p => p.id === state.selfId);
  if (self?.combat) return battleScreen(display, options);
  // 左上属性、右上地图；左下为命令/按需打开的背包，右下为事件聊天。
  const left = Math.floor((w - 7) / 2), right = w - 7 - left;
  // 窄窗口省略固定上限，仍完整显示四个属性名称与当前值。
  const vital = (label: string, value: number) => `${label} ${value}${left >= 34 ? '/100' : ''}`;
  const status = self && state ? [self.name, `位置：${state.places[self.location].name} · ${itemById(self.equipment.weapon)?.name ?? "空手"}`,
    `${vital('生命值', self.vitals.health)} · ${vital('法力值', self.vitals.mana)}`,
    `${vital('饱食度', self.vitals.satiety)} · ${vital('水分值', self.vitals.hydration)}`,
    `攻击${stats(self).attack} 防御${stats(self).defense} 魔法${stats(self).magic} 金币${self.coins}`] : ['等待入场…'];
  const entities = self && state ? [
    ...(state.corpses ?? []).filter(corpse => corpse.location === self.location).map(corpse => `[尸体] ${corpse.name}`),
    ...worldEnemySummary(state.dummies.filter(enemy => enemy.location === self.location && isAlive(enemy))),
  ] : [];
  const map = self && state ? [`[${state.places[self.location].name}]`, `出口：${state.places[self.location].exits.map(id => state.places[id].name).join('、') || '无'}`, '地面：' + (state.items.filter(i => i.location === self.location).map(i => `${i.name} ×${i.quantity}`).join('、') || '无'), ...(entities.length ? entities : wrap(state.places[self.location].description, right))] : ['等待世界状态…'];
  // 所有面板共用闭合实线框，交点使用连接字符，长文本不能覆盖边框。
  const rule = (label: string, size: number) => label ? fit(`─ ${label} `, size).replace(/ +$/, spaces => '─'.repeat(spaces.length)) : '─'.repeat(size);
  const columns = (a: string, b: string) => `│ ${fit(a, left)} │ ${fit(b, right)} │`;
  const result = [`┌${rule(`文字冒险 · ${display.connection} · 在线${display.state?.players.length ?? 0}`, left + 2)}┬${rule('', right + 2)}┐`, columns('角色状态', '地图')];
  for (let i = 0; i < 5; i++) result.push(columns(status[i] ?? '', map[i] ?? ''));
  const historyHeight = height - 12;
  // 两列历史分别换行、滚动，不会推动上方属性和底部输入行。
  const history = (entries: string[], size: number, offset: number) => {
    const lines = entries.flatMap(entry => wrap(entry, size));
    const end = Math.max(0, lines.length - offset), start = Math.max(0, end - historyHeight);
    return [...lines.slice(start, end), ...Array(Math.max(0, historyHeight - (end - start))).fill('')];
  };
  let leftTitle = `${focus === 'commands' ? '▶' : ''} 命令记录与结果 ${commandOffset ? '（历史）' : ''}`;
  let leftLines = history(display.commands ?? [], left, commandOffset);
  if (options.inventoryOpen) {
    const items = self ? Object.entries(self.inventory).filter(([, n]) => n > 0) : [];
    const pages = Math.max(1, Math.ceil(items.length / historyHeight));
    const page = Math.max(0, Math.min(options.inventoryPage ?? 0, pages - 1));
    leftTitle = `${focus === 'commands' ? '▶' : ''} 背包 ${page + 1}/${pages} · Esc 关闭`;
    leftLines = items.length ? items.slice(page * historyHeight, (page + 1) * historyHeight).map(([name, n]) => `${name} ×${n}${Object.values(self!.equipment).some(id => itemById(id)?.name === name) ? " [已装备]" : ""}`) : ['背包为空'];
  }
  if (display.corpse) {
    const choices = corpseChoices(display.corpse);
    const selected = Math.min(options.corpseIndex ?? 0, choices.length - 1);
    const start = Math.floor(selected / historyHeight) * historyHeight;
    leftTitle = `搜刮：${display.corpse.name}${display.corpse.items.length ? '' : '（空）'}`;
    leftLines = choices.slice(start, start + historyHeight).map((choice, i) => `${start + i === selected ? '▶' : ' '} ${choice.label}`);
  }
  result.push(`├${rule(leftTitle, left + 2)}┼${rule(`${focus === 'events' ? '▶' : ''} 事件与聊天 ${eventOffset ? '（历史）' : ''}`, right + 2)}┤`);
  const eventLines = history(display.events, right, eventOffset);
  for (let i = 0; i < historyHeight; i++) result.push(columns(leftLines[i] ?? '', eventLines[i] ?? ''));
  result.push(`├${rule('命令输入', left + 2)}┴${rule('', right + 2)}┤`,
    `│ ${fit(display.corpse ? '↑ ↓ 选择 · 空格 拿取/确认 · Esc 关闭 · 也可输入命令' : 'Tab 切换 · PgUp/PgDn 翻页 · ↑↓ 历史 · Ctrl+C 退出', w - 4)} │`,
    `│ ${fit('> ' + input, w - 4)} │`,
    `└${rule(display.corpse ? '拿取 物品名 [数量/全部] | 全部拿取 | 分解 | 关闭搜刮' : '搜刮 尸体名 | 分解 尸体名 | 攻击 目标名 | 背包 | 查看', w - 2)}┘`);
  return result.slice(0, height).map(line => fit(line, w));
}

// 备用屏幕中按行差异更新，禁止清屏重画或向终端追加输出。
export class TerminalUI {
  private previous: string[] = [];
  private active = true;
  private input: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private focus: 'events' | 'commands' = 'commands';
  private inventoryPage = 0;
  private inventoryOpen = false;
  private wasInCombat = false;
  private corpseIndex = 0;
  private lastCorpseSignature = '';
  private battle = new BattleFlow(() => this.draw());
  private battleCommandMode = false;
  private battleHistoryOffset = 0;
  private battleHistoryLines = 0;
  presentBattle(lines: string[], round: number, nextRound: number, outcome?: string) { this.battle.present(lines.map(clean), round, nextRound, outcome ? () => this.execute('结束战斗') : undefined); this.battleCommandMode = false; this.draw(); }
  battleResult(message: string) { if (this.wasInCombat) { const combat = this.display().state!.players.find(p => p.id === this.display().state!.selfId)!.combat!; this.battle.present([clean(message)], combat.round, combat.round); this.draw(); } }
  battleError(message: string) { if (this.wasInCombat) { this.battle.fail(clean(message)); this.battleCommandMode = false; this.draw(); } }
  // 背包仅改变本地视图，打开、关闭均不向服务器发送游戏操作。
  showInventory(open: boolean) { this.inventoryOpen = open; this.inventoryPage = 0; this.focus = 'commands'; this.draw(); }
  private eventOffset = 0;
  private commandOffset = 0;
  private lastEvents = 0;
  private lastCommands = 0;
  constructor(private display: () => Display, private execute: (line: string) => void, private exit: () => void) {
    process.stdout.write('\x1b[?1049h\x1b[?7l\x1b[49m\x1b[39m\x1b[2J');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('keypress', this.key);
    process.stdout.on('resize', this.resize);
    this.draw();
  }
  private resize = () => { this.previous = []; this.draw(); };
  private key = (text: string | undefined, key: readline.Key) => {
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) { this.exit(); return; }
    const self = this.display().state?.players.find(p => p.id === this.display().state?.selfId);
    const combat = self?.combat;
    if (self) this.battle.options = battleOptions(self, this.battle.mode);
    if (combat && !this.battleCommandMode) {
      if (key.name === 'pageup' || key.name === 'pagedown') {
        this.battleHistoryOffset = Math.max(0, this.battleHistoryOffset + (key.name === 'pageup' ? 3 : -3));
        this.draw(); return;
      }
      if (text === '/' && this.battle.mode === 'menu') { this.battleCommandMode = true; this.input = []; this.cursor = 0; }
      else {
        const command = this.battle.key(key.name ?? '', text, combat.enemyIds, this.display().state!.dummies.filter(isAlive).map(e => e.id));
        if (command) this.execute(command);
      }
      this.draw(); return;
    }
    const corpse = this.display().corpse;
    if (!combat && corpse && key.name === 'escape') { this.execute('关闭搜刮'); this.draw(); return; }
    if (!combat && corpse && this.focus === 'commands' && this.input.length === 0 && ['up', 'down', 'space'].includes(key.name ?? '')) {
      const choices = corpseChoices(corpse);
      if (key.name === 'up' || key.name === 'down') this.corpseIndex = (this.corpseIndex + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
      else this.execute(choices[this.corpseIndex]?.command ?? '关闭搜刮');
      this.draw(); return;
    }
    if (combat && key.name === 'escape') { this.battleCommandMode = false; this.input = []; this.cursor = 0; this.draw(); return; }
    if (key.name === 'escape') this.showInventory(false);
    else if (key.name === 'tab') this.focus = this.focus === 'commands' ? 'events' : 'commands';
    else if (key.name === 'pageup' || key.name === 'pagedown') {
      const delta = key.name === 'pageup' ? 3 : -3;
      if (this.focus === 'commands' && this.inventoryOpen) this.inventoryPage = Math.max(0, this.inventoryPage + (key.name === 'pagedown' ? 1 : -1));
      else if (this.focus === 'events') this.eventOffset = Math.max(0, this.eventOffset + delta);
      else this.commandOffset = Math.max(0, this.commandOffset + delta);
    } else if (key.name === 'return' || key.name === 'enter') {
      const line = this.input.join('').trim();
      this.input = []; this.cursor = 0; this.commandOffset = 0;
      if (line) {
        if (combat) { this.battleCommandMode = false; if (/^(攻击|attack|防御|defend|脱离战斗|flee|装备|equip|换装|换武器|卸下|unequip|使用|use|施放|cast|技能|skill)(\s|$)/u.test(line)) this.battle.wait(); }
        this.history.push(line); this.history = this.history.slice(-100); this.historyIndex = this.history.length; this.draft = ''; this.execute(line); }
    } else if (key.name === 'backspace') { if (this.cursor > 0) this.input.splice(--this.cursor, 1); }
    else if (key.name === 'delete') this.input.splice(this.cursor, 1);
    else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = this.input.length;
    else if (key.name === 'up' || key.name === 'down') {
      if (this.historyIndex === this.history.length) this.draft = this.input.join('');
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.input = graphemes(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]); this.cursor = this.input.length;
    } else if (text && !key.ctrl && !key.meta && !/[\p{Cc}\p{Cf}]/u.test(text) && this.input.length < 1000) {
      const chars = graphemes(text); this.input.splice(this.cursor, 0, ...chars); this.cursor += chars.length;
    }
    this.draw();
  };
  draw() {
    if (!this.active) return;
    const display = this.display(), width = process.stdout.columns || 80, height = process.stdout.rows || 24;
    const corpseSignature = display.corpse ? display.corpse.id + ':' + display.corpse.items.map(item => item.itemId).join(',') : '';
    if (corpseSignature !== this.lastCorpseSignature) {
      this.corpseIndex = 0; this.lastCorpseSignature = corpseSignature;
      if (display.corpse) { this.inventoryOpen = false; this.focus = 'commands'; }
    }
    const inCombat = !!display.state?.players.find(p => p.id === display.state?.selfId)?.combat;
    if (inCombat !== this.wasInCombat) {
      // 探索和战斗切换时回到最新记录，避免沿用背包或旧历史偏移。
      this.inventoryOpen = false; this.commandOffset = 0; this.eventOffset = 0;
      this.lastCommands = 0; this.lastEvents = 0; this.focus = 'commands';
      this.wasInCombat = inCombat;
      this.battleHistoryOffset = 0; this.battleHistoryLines = 0;
      if (!inCombat) this.battle.dispose();
      this.battleCommandMode = false; this.input = []; this.cursor = 0;
      if (inCombat) { const combat = display.state!.players.find(p => p.id === display.state!.selfId)!.combat!; this.battle.start(combat.round, combat.enemyIds.indexOf(combat.targetId)); }
    }
    if (inCombat) {
      const player = display.state!.players.find(p => p.id === display.state!.selfId)!;
      this.battle.options = battleOptions(player, this.battle.mode);
      if (this.battle.options.length) this.battle.optionIndex = Math.max(0, Math.min(this.battle.optionIndex, this.battle.options.length - 1));
    }
    if (inCombat && this.battle.mode === 'menu') {
      const combat = display.state!.players.find(p => p.id === display.state!.selfId)!.combat!;
      this.battle.targetIndex = Math.max(0, combat.enemyIds.indexOf(combat.targetId));
    }
    if (inCombat) {
      const lines = this.battle.history.flatMap(message => wrap(message, Math.max(1, width - 5))).length;
      // 翻阅旧记录时，新播报只增加尾部偏移，保持当前阅读位置。
      if (this.battleHistoryOffset > 0) this.battleHistoryOffset += Math.max(0, lines - this.battleHistoryLines);
      this.battleHistoryOffset = Math.min(this.battleHistoryOffset, Math.max(0, lines - Math.max(1, height - 17)));
      this.battleHistoryLines = lines;
    }
    // 偏移以显示行计；滚动上限由当前内容决定，防止滚进空白。
    const leftWidth = Math.max(9, Math.floor((width - 8) / 2)), rightWidth = Math.max(9, width - 8 - leftWidth);
    const count = (entries: string[], columns: number) => entries.flatMap(e => wrap(e, columns)).length;
    const eventCount = count(display.events, rightWidth), commandCount = count(display.commands ?? [], leftWidth);
    if (this.eventOffset) this.eventOffset += Math.max(0, eventCount - this.lastEvents);
    if (this.commandOffset) this.commandOffset += Math.max(0, commandCount - this.lastCommands);
    this.eventOffset = Math.min(this.eventOffset, Math.max(0, eventCount - 1));
    this.commandOffset = Math.min(this.commandOffset, Math.max(0, commandCount - 1));
    const self = display.state?.players.find(p => p.id === display.state?.selfId);
    const itemCount = Object.values(self?.inventory ?? {}).filter(count => count > 0).length;
    this.inventoryPage = Math.min(this.inventoryPage, Math.max(0, Math.ceil(itemCount / Math.max(1, height - 12)) - 1));
    this.lastEvents = eventCount; this.lastCommands = commandCount;
    // 输入过长时水平移动视口，光标始终留在底部输入区域。
    let start = 0;
    while (cellWidth(this.input.slice(start, this.cursor).join('')) > width - 9) start++;
    const visible = this.input.slice(start).join('');
    const lines = screenLines(display, { width, height, focus: this.focus, inventoryPage: this.inventoryPage, inventoryOpen: this.inventoryOpen, eventOffset: this.eventOffset, commandOffset: this.commandOffset, input: visible, battle: this.battle, battleCommandMode: this.battleCommandMode, battleHistoryOffset: this.battleHistoryOffset, corpseIndex: this.corpseIndex });
    let output = '\x1b[?25l';
    lines.forEach((line, i) => { if (line !== this.previous[i]) output += `\x1b[${i + 1};1H${line}\x1b[K`; });
    this.previous = lines;
    const row = width < 60 || height < 22 ? lines.length : height - 1;
    const inputColumn = width < 60 || height < 22 ? 3 : 5;
    output += `\x1b[${row};${inputColumn + cellWidth(this.input.slice(start, this.cursor).join(''))}H${inCombat && !this.battleCommandMode ? '\x1b[?25l' : '\x1b[?25h'}`;
    process.stdout.write(output);
  }
  close() {
    this.active = false;
    this.battle.dispose();
    process.stdin.removeListener('keypress', this.key); process.stdout.removeListener('resize', this.resize);
    process.stdin.setRawMode(false);
    process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
  }
}
