#!/usr/bin/env node
/**
 * install.mjs — 把仓库 config/ 装进本机 opencode 配置目录（默认 dry-run，不动手）
 *
 * 用途：把可安全复制的纯文本配置装到位，并在覆盖前自动备份。
 *   - config/AGENTS.md        → <配置目录>/AGENTS.md
 *   - config/agents/*.md      → <配置目录>/agent/      （opencode 读的是单数 agent/）
 *   - config/workflows/*.md   → <配置目录>/workflows/
 *   **绝不碰 opencode.json**（那需要按人个性化合并，交给 PROMPT.md 或手工对照）。
 *
 * 用法：
 *   node scripts/install.mjs                          # dry-run：只打印计划
 *   node scripts/install.mjs --apply                  # 真的装（已存在的文件默认跳过）
 *   node scripts/install.mjs --apply --force          # 已存在的文件先备份再覆盖
 *   node scripts/install.mjs --config-dir <path>      # 指定配置目录
 *   node scripts/install.mjs --help
 *
 * 参数：
 *   --config-dir <path>  目标配置目录（默认 ~/.config/opencode；设了 XDG_CONFIG_HOME 则以它为准）
 *   --apply              真的写盘；不带就是 dry-run
 *   --force              配合 --apply：目标已存在时备份后覆盖（默认是跳过）
 *   --help, -h           打印本说明
 *
 * 退出码：
 *   0 = 成功（dry-run 也算成功）
 *   1 = 执行期出错（某个文件复制失败；已做的备份不会删除）
 *   2 = 参数错误
 *
 * 红线：不删除任何用户文件；不改 opencode.json；默认 dry-run。
 * 依赖：只用 Node 18+ 内置模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'install.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

class UsageError extends Error {}

const KNOWN_FLAGS = new Set(['help', 'apply', 'force']);
const TAKES_VALUE = new Set(['config-dir']);

function parseArgv(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h') {
      flags.add('help');
      continue;
    }
    if (!raw.startsWith('--')) throw new UsageError(`不认识的参数：${raw}`);
    let name = raw.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (TAKES_VALUE.has(name)) {
      let value = inline;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} 需要一个值`);
      }
      values.set(name, value);
    } else if (inline !== undefined) {
      throw new UsageError(`--${name} 不接受值`);
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

function helpText() {
  return [
    `${SCRIPT} — 安装 config/ 到本机 opencode 配置目录（默认 dry-run）`,
    '',
    '用法：',
    '  node scripts/install.mjs                        # 只打印计划，不写文件',
    '  node scripts/install.mjs --apply                # 真的装（已存在则跳过）',
    '  node scripts/install.mjs --apply --force        # 已存在的先备份再覆盖',
    '  node scripts/install.mjs --config-dir <path>    # 指定配置目录',
    '  node scripts/install.mjs --help',
    '',
    '参数：',
    '  --config-dir <path>  目标配置目录（默认 ~/.config/opencode）',
    '  --apply              真的写盘；不带就是 dry-run',
    '  --force              配合 --apply：目标已存在时备份后覆盖',
    '  --help, -h           打印本说明',
    '',
    '会做：',
    '  config/AGENTS.md      → <配置目录>/AGENTS.md',
    '  config/agents/*.md    → <配置目录>/agent/',
    '  config/workflows/*.md → <配置目录>/workflows/',
    '不会做：不改 opencode.json、不删任何文件。',
    '',
    '退出码：0 成功；1 执行期出错；2 参数错误。',
    '',
    '装完建议跑：node scripts/doctor.mjs --config-dir <配置目录>',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

/** ps1/PROMPT.md 约定的备份名：<原文件名>.bak-YYYYMMDD-HHMMSS */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}`;
}

function listMd(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 计划                                                                */
/* ------------------------------------------------------------------ */

function buildPlan(configDir) {
  const plan = [];
  const warnings = [];

  // 1) AGENTS.md
  const agentsSrc = path.join(REPO_ROOT, 'config', 'AGENTS.md');
  const agentsDst = path.join(configDir, 'AGENTS.md');
  if (isFile(agentsSrc)) plan.push({ src: agentsSrc, dst: agentsDst, label: 'config/AGENTS.md' });
  else warnings.push(`源文件缺失，跳过：${agentsSrc}`);

  // 2) agents/*.md → <配置目录>/agent/
  const rolesDir = path.join(REPO_ROOT, 'config', 'agents');
  const roleFiles = listMd(rolesDir);
  if (roleFiles.length === 0) warnings.push(`源目录里没有 .md，跳过：${rolesDir}`);
  for (const f of roleFiles) {
    plan.push({
      src: path.join(rolesDir, f),
      dst: path.join(configDir, 'agent', f),
      label: `config/agents/${f}`,
    });
  }

  // 3) workflows/*.md → <配置目录>/workflows/
  const wfDir = path.join(REPO_ROOT, 'config', 'workflows');
  const wfFiles = listMd(wfDir);
  if (wfFiles.length === 0) warnings.push(`源目录里没有 .md，跳过：${wfDir}`);
  for (const f of wfFiles) {
    plan.push({
      src: path.join(wfDir, f),
      dst: path.join(configDir, 'workflows', f),
      label: `config/workflows/${f}`,
    });
  }

  for (const a of plan) {
    if (!isFile(a.dst)) a.action = 'create';
    else a.action = 'skip'; // --force 时再改成 overwrite，好让 dry-run 也显示「会覆盖」
    a.exists = isFile(a.dst);
  }
  return { plan, warnings };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

let parsed;
try {
  parsed = parseArgv(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`参数错误：${err.message}`);
    console.error(`用 node scripts/${SCRIPT} --help 看用法`);
    process.exit(2);
  }
  throw err;
}

for (const flag of parsed.flags) {
  if (!KNOWN_FLAGS.has(flag)) {
    console.error(`参数错误：不认识的选项 --${flag}`);
    console.error(`用 node scripts/${SCRIPT} --help 看用法`);
    process.exit(2);
  }
}

if (parsed.flags.has('help')) {
  console.log(helpText());
  process.exit(0);
}

const apply = parsed.flags.has('apply');
const force = parsed.flags.has('force');
const configDir = path.resolve(expandHome(parsed.values.get('config-dir') || defaultConfigDir()));

if (force && !apply) {
  console.log('提示：--force 只在配合 --apply 时生效；本次仍是 dry-run。');
}

/* --- 1. 探测配置目录 --- */
console.log(`仓库根目录：${REPO_ROOT}`);
console.log(`目标配置目录：${configDir}${isDir(configDir) ? '（已存在）' : '（不存在，--apply 时会创建）'}`);
console.log('');

const { plan, warnings } = buildPlan(configDir);
for (const w of warnings) console.log(`WARN\t${w}`);
if (warnings.length > 0) console.log('');

if (plan.length === 0) {
  console.log('没有可安装的文件——检查仓库的 config/ 目录是否完整（是否需要先 git clone 完整仓库）。');
  process.exit(1);
}

/* --- 2. 列出动作 --- */
const verb = (a) => {
  if (!a.exists) return '新建';
  return force ? '覆盖' : '跳过';
};

const width = Math.max(...plan.map((a) => a.label.length));
for (const a of plan) {
  const v = verb(a);
  const note = v === '跳过' ? '（已存在；要覆盖加 --force）' : v === '覆盖' ? '（覆盖前备份）' : '';
  console.log(`[${v}]\t${a.label.padEnd(width)}\t->\t${a.dst}${note}`);
}

const planned = {
  create: plan.filter((a) => verb(a) === '新建').length,
  skip: plan.filter((a) => verb(a) === '跳过').length,
  overwrite: plan.filter((a) => verb(a) === '覆盖').length,
};

console.log('');
console.log(`--- 计划: 新建 ${planned.create} / 跳过 ${planned.skip} / 覆盖 ${planned.overwrite} ---`);
console.log('');
console.log(
  '注意：opencode.json 涉及个性化合并，请用仓库根目录的 PROMPT.md 让 AI 处理，或手工对照 config/opencode.json.example',
);
console.log('');

/* --- 3. dry-run 到此为止 --- */
if (!apply) {
  console.log('（dry-run）没有写入任何文件。确认上面的计划没问题，再加 --apply 真正执行。');
  process.exit(0);
}

/* --- 4. apply --- */
if (!isDir(configDir)) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch (err) {
    console.error(`FAIL\t创建配置目录失败：${err.message}`);
    process.exit(1);
  }
}

const report = { created: 0, overwritten: 0, skipped: 0, backup: 0 };
const errors = [];
const backupStamp = stamp();

for (const a of plan) {
  const action = verb(a);
  try {
    if (action === '跳过') {
      report.skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(a.dst), { recursive: true });
    if (action === '覆盖') {
      const bak = `${a.dst}.bak-${backupStamp}`;
      fs.copyFileSync(a.dst, bak);
      report.backup++;
      console.log(`备份\t${bak}`);
    }
    fs.copyFileSync(a.src, a.dst);
    if (action === '覆盖') report.overwritten++;
    else report.created++;
    console.log(`${action}\t${a.dst}`);
  } catch (err) {
    errors.push(`${a.dst}：${err.message}`);
    console.error(`FAIL\t${a.dst}\t${err.message}`);
  }
}

/* --- 5. 报告 --- */
console.log('');
console.log(
  `--- install 报告: 新建 ${report.created} / 覆盖 ${report.overwritten} / 跳过 ${report.skipped} / 备份 ${report.backup} ---`,
);
if (errors.length > 0) {
  console.log(`有 ${errors.length} 个文件没装成功：`);
  for (const e of errors) console.log(`  - ${e}`);
}
console.log('提示：opencode.json 没有动（个性化合并请走 PROMPT.md 或手工对照 config/opencode.json.example）。');
console.log(`下一步：node scripts/doctor.mjs --config-dir "${configDir}"`);
console.log('改完配置记得重启 opencode 才生效。');

process.exit(errors.length > 0 ? 1 : 0);
