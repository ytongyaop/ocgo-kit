#!/usr/bin/env node
/**
 * memory-lint.mjs — opencode 记忆库体检（只读；只有显式 --update-baseline 时才写基线文件）
 *
 * 用途：逐条移植 tools/memory-lint.ps1 的 11 条规则，检查 memory.json（JSONL）是否健康：
 *       解析 / 重名 / 关系端点 / 命名规范 / 三字段 / 索引死链与漏登 / 分层预算 /
 *       热层进展日志 / 重复观察 / 存档指针 / 单条长度（原子性）。
 *
 * 用法：
 *   node scripts/memory-lint.mjs
 *   node scripts/memory-lint.mjs --memory ~/.config/opencode/memory.json
 *   node scripts/memory-lint.mjs --memory ./memory.json --archive ./记忆存档.md
 *   node scripts/memory-lint.mjs --memory ./memory.json --baseline ./memory-lint-baseline.json --update-baseline
 *   node scripts/memory-lint.mjs --help
 *
 * 参数：
 *   --memory <path>      memory.json 路径（默认 ~/.config/opencode/memory.json；JSONL：每行一个 JSON 对象）
 *   --archive <path>     记忆存档 md 路径（可选；不给就跳过「存档指针」检查）
 *   --baseline <path>    超长观察豁免基线 json（可选；不给就当作没有基线）
 *   --update-baseline    把当前超长观察的哈希写进 --baseline 指定的文件（必须同时给 --baseline）
 *   --hot-pattern <re>   热层实体的名字正则（默认 记忆索引|教学约定|工作流路由表|^user:）
 *   --help, -h           打印本说明
 *
 * 输出：PASS|WARN|FAIL|INFO <TAB> 对象 <TAB> 规则 <TAB> 实测/上限，末尾一行汇总（与 ps1 一致）。
 * 退出码：0 = 没有 FAIL；1 = 有 FAIL；2 = 参数错误。
 *
 * 依赖：只用 Node 18+ 内置模块（fs/path/os/crypto），无 npm 依赖。
 *
 * 与 ps1 的三处有意差异（详见报告）：
 *   1. 不再写死用户名：热层正则改为 --hot-pattern，默认用通用形态。
 *   2. 默认路径改为 os.homedir()；--archive / --baseline 不再默认指向某个固定盘符。
 *   3. memory.json / 存档不存在时输出 FAIL/WARN 行并继续跑完，而不是直接抛异常中断。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import process from 'node:process';

const SCRIPT = 'memory-lint.mjs';
const LIMIT = 160; // 单条观察字符上限（AGENTS.md：一条观察 = 一个原子事实，≤160 字）

const DEFAULT_HOT_PATTERN = '记忆索引|教学约定|工作流路由表|^user:';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

class UsageError extends Error {}

const TAKES_VALUE = new Set(['memory', 'archive', 'baseline', 'hot-pattern']);
const KNOWN_FLAGS = new Set(['help', 'update-baseline']);

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
    `${SCRIPT} — opencode 记忆库体检（只读）`,
    '',
    '用法：',
    '  node scripts/memory-lint.mjs',
    '  node scripts/memory-lint.mjs --memory <path> [--archive <path>] [--baseline <path>]',
    '  node scripts/memory-lint.mjs --memory <path> --baseline <path> --update-baseline',
    '  node scripts/memory-lint.mjs --help',
    '',
    '参数：',
    '  --memory <path>      memory.json 路径（默认 ~/.config/opencode/memory.json；JSONL 格式，每行一个对象）',
    '  --archive <path>     记忆存档 md（可选；不给就跳过「存档指针」检查）',
    '  --baseline <path>    超长观察豁免基线（可选）',
    '  --update-baseline    把当前超长观察的哈希写进基线（需同时给 --baseline）',
    '  --hot-pattern <re>   热层实体名字正则（默认 记忆索引|教学约定|工作流路由表|^user:）',
    '  --help, -h           打印本说明',
    '',
    '检查项（11 条）：解析 / 重名 / 关系端点 / 命名规范 / 三字段 / 索引死链与漏登 /',
    '  分层预算 / 热层进展日志 / 重复观察 / 存档指针 / 单条长度。',
    '输出：PASS|WARN|FAIL|INFO <TAB> 对象 <TAB> 规则 <TAB> 实测/上限，末尾一行汇总。',
    '退出码：0 无 FAIL；1 有 FAIL；2 参数错误。',
    '',
    '示例：',
    '  node scripts/memory-lint.mjs --memory "C:/Users/me/.config/opencode/memory.json"',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const rows = [];
function row(level, obj, rule, detail) {
  rows.push({ level, object: String(obj), rule: String(rule), detail: String(detail) });
}

function flat(s) {
  return String(s).replace(/[\t\r\n]+/g, ' ').trim();
}

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

/** 模仿 ps1 的 "{0:N0}" —— 千分位逗号 */
function num(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * 字符长度：PowerShell 的 .Length 与 JS 的 String.length 都是 UTF-16 code unit 计数，
 * 所以这里用 str.length 保持与 ps1 完全一致（中文算 1，emoji 算 2）。
 * 刻意不用 [...str].length —— 那会按 code point 计数，与现有基线和 ps1 结论对不上。
 */
function clen(s) {
  return s.length;
}

/** ps1 的 Get-ObsHash：UTF-8 → SHA256 → 大写 hex → 前 16 位 */
function obsHash(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase().slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main(opts) {
  /* ---------- 1. 解析（memory.json 是 JSONL：每行一个 JSON 对象） ---------- */
  let entities = [];
  let relations = [];
  let parseOk = false;

  if (!isFile(opts.memory)) {
    row('FAIL', 'memory.json', '存在性', `文件不存在：${opts.memory} → 用 --memory 指到真实位置（或让 memory MCP 先写一次）`);
  } else {
    let raw;
    try {
      raw = fs.readFileSync(opts.memory, 'utf8').replace(/^\uFEFF/, '');
      parseOk = true;
    } catch (err) {
      row('FAIL', 'memory.json', '读取', `${err.message} → 检查文件权限/是否被占用`);
    }

    if (parseOk) {
      let bad = 0;
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue; // ps1: Where-Object { $_.Trim() }
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          bad++;
          // 与 ps1 的差异：用物理行号（ps1 用非空行序号），定位更准。
          row('FAIL', `line${i + 1}`, 'JSON解析', '无法解析 → 这一行不是合法 JSON（常见：多了/少了逗号、被截断）');
          continue;
        }
        if (obj && obj.type === 'entity') entities.push(obj);
        else if (obj && obj.type === 'relation') relations.push(obj);
        else row('FAIL', `line${i + 1}`, '记录类型', `未知类型: ${obj && obj.type}`);
      }
      if (bad === 0) {
        row('PASS', 'memory.json', 'JSONL解析', `${entities.length} 实体 / ${relations.length} 关系`);
      }
    }
  }

  const obsOf = (e) => (Array.isArray(e.observations) ? e.observations.map((x) => String(x)) : []);

  /* ---------- 2. 重名 ---------- */
  // PowerShell 的 Group-Object 对字符串大小写不敏感，这里用 lowerCase 归组保持语义一致。
  const byName = new Map();
  for (const e of entities) {
    const key = String(e.name ?? '').toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }
  const dups = [...byName.values()].filter((g) => g.length > 1);
  if (dups.length > 0) {
    for (const g of dups) row('FAIL', g[0].name, '实体重名', `${g.length} 次 → 合并成一个实体，或改名（记忆按名字索引）`);
  } else {
    row('PASS', '实体', '重名检查', '0');
  }

  /* ---------- 3. 关系端点 ---------- */
  const nameSet = new Set(entities.map((e) => String(e.name ?? '').toLowerCase()));
  const badRel = relations.filter(
    (r) => !nameSet.has(String(r.from ?? '').toLowerCase()) || !nameSet.has(String(r.to ?? '').toLowerCase()),
  );
  if (badRel.length > 0) {
    for (const r of badRel) {
      row('FAIL', `${r.from}->${r.to}`, '关系端点', '指向不存在的实体 → 修正 from/to，或先建实体');
    }
  } else {
    row('PASS', '关系', '端点存在', '0');
  }

  /* ---------- 4. 命名规范 ---------- */
  const NAMING = /^(user|project|tool|protocol|state):/i; // ps1 的 -notmatch 大小写不敏感
  const badName = entities.filter((e) => !NAMING.test(String(e.name ?? '')));
  if (badName.length > 0) {
    for (const e of badName) row('WARN', e.name, '命名规范', '未使用 类型:主题 → 改成 user:/project:/tool:/protocol:/state: 之一');
  } else {
    row('PASS', '实体', '命名规范', '全部合规');
  }

  /* ---------- 5. 三字段（必须出现在观察行首才算） ---------- */
  for (const e of entities) {
    const txt = obsOf(e).join('\n');
    const miss = [];
    if (!/^状态[:：]/m.test(txt)) miss.push('状态');
    if (!/^边界[:：]/m.test(txt)) miss.push('边界');
    if (!/^明细[:：]/m.test(txt)) miss.push('明细');
    if (miss.length > 0) row('WARN', e.name, '三字段', `缺 ${miss.join('/')} → 每条实体都要有行首的 状态：/边界：/明细：`);
  }

  /* ---------- 6. 索引死链 / 漏登 ---------- */
  const idx = entities.find((e) => /记忆索引/.test(String(e.name ?? '')));
  if (idx) {
    const idxObs = obsOf(idx);
    const idxTxt = idxObs.join('\n');
    const refs = [];
    for (const ob of idxObs) {
      let m = /【(?:user|project|tool|protocol|state)】\s*([^｜|]+)/i.exec(ob);
      if (m) {
        refs.push(m[1].trim());
      } else {
        m = /【索引】\s*([^|｜]+)/.exec(ob);
        if (m) refs.push(m[1].trim());
      }
    }
    const dead = refs.filter((r) => !nameSet.has(r.toLowerCase()));
    if (dead.length > 0) {
      for (const d of dead) row('FAIL', d, '索引死链', '实体不存在 → 删掉这条索引，或把实体补回来');
    } else {
      row('PASS', '记忆索引', '死链', '0');
    }
    const unlisted = entities.filter(
      (e) => String(e.name) !== String(idx.name) && !idxTxt.toLowerCase().includes(String(e.name).toLowerCase()),
    );
    if (unlisted.length > 0) {
      for (const e of unlisted) row('WARN', e.name, '索引漏登', '未出现在索引中 → 在索引实体里登记一行');
    } else {
      row('PASS', '记忆索引', '漏登', '0');
    }
  } else {
    row('FAIL', '记忆索引', '索引存在', '找不到索引实体 → 建一个名字含「记忆索引」的实体，每条实体都要在里面登记');
  }

  /* ---------- 7. 层级预算 ---------- */
  const hotRe = new RegExp(opts.hotPattern, 'i');
  let hotChars = 0;
  let hotObs = 0;
  const hotNames = [];
  let temperatureChecked = parseOk;
  for (const e of entities) {
    const obs = obsOf(e);
    const chars = obs.reduce((s, o) => s + clen(o), 0);
    const cnt = obs.length;
    if (hotRe.test(String(e.name ?? ''))) {
      hotChars += chars;
      hotObs += cnt;
      hotNames.push(String(e.name));
      if (chars > 3000) row('WARN', e.name, '热层单实体预算', `${num(chars)} / 3,000 → 精简或把细节挪进存档`);
    } else {
      if (chars > 4000) row('WARN', e.name, '温层实体预算', `${num(chars)} / 4,000 字符 → 同上`);
      if (cnt > 40) row('INFO', e.name, '条数偏多(诊断)', `${cnt} / 40 条 — 可能「删旧」没执行或该拆`);
    }
  }
  if (temperatureChecked) {
    // 把判定为热层的实体名一并打印：口径可见，才不会「数字变了不知道为什么」。
    const namePart = hotNames.length
      ? `；热层实体：${hotNames.slice(0, 6).join('、')}${hotNames.length > 6 ? ` 等 ${hotNames.length} 个` : ''}`
      : '；热层实体：无';
    if (hotChars > 8000) {
      row('FAIL', '热层合计', '热层预算', `${num(hotChars)} / 8,000（${hotObs} 条${namePart}）→ 热层每次必读，超了就删旧/转存档`);
    } else {
      row('PASS', '热层合计', '热层预算', `${num(hotChars)} / 8,000（${hotObs} 条${namePart}）`);
    }
  }

  /* ---------- 8. 疑似进展日志（只看热层） ---------- */
  const progRe = /已完成|已通过|已交付|复盘通过|验收通过|已提交|刚刚|今天/;
  for (const e of entities) {
    if (!hotRe.test(String(e.name ?? ''))) continue;
    const hit = obsOf(e).filter((ob) => !/^(状态|边界|明细)[:：]/.test(ob) && progRe.test(ob));
    if (hit.length > 0) row('WARN', e.name, '热层含进展日志', `${hit.length} 条 → 进展/排障过程进存档，记忆只留结论`);
  }

  /* ---------- 9. 重复观察 ---------- */
  for (const e of entities) {
    const counts = new Map();
    for (const ob of obsOf(e)) {
      const k = ob.toLowerCase(); // Group-Object 大小写不敏感
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const dupGroups = [...counts.values()].filter((c) => c > 1).length;
    if (dupGroups > 0) row('WARN', e.name, '重复观察', `${dupGroups} 组 → 删掉重复的那条`);
  }

  /* ---------- 10. 存档指针（需要 --archive） ---------- */
  let archiveText = null;
  if (opts.archive) {
    if (!isFile(opts.archive)) {
      row('WARN', '存档', '存档文件', `不存在：${opts.archive} → 检查 --archive 路径（本项跳过）`);
    } else {
      try {
        archiveText = fs.readFileSync(opts.archive, 'utf8');
      } catch (err) {
        row('WARN', '存档', '存档文件', `读不了：${err.message}（本项跳过）`);
      }
    }
  }
  if (archiveText !== null) {
    for (const e of entities) {
      for (const ob of obsOf(e)) {
        const m = /明细[:：]\s*([^#\s]+\.md)(?:#([^\s；;]+))?/.exec(ob);
        if (!m) continue;
        const file = m[1];
        const sec = m[2];
        const full = path.isAbsolute(file) ? file : path.join(path.dirname(opts.archive), file);
        if (!isFile(full)) {
          row('WARN', e.name, '存档指针', `文件不存在: ${file} → 改指针或补存档文件`);
        } else if (sec) {
          if (!archiveText.toLowerCase().includes(sec.toLowerCase())) {
            row('WARN', e.name, '存档指针', `小节不存在: #${sec} → 存档里补这一节，或改指针`);
          }
        }
      }
    }
  }

  /* ---------- 11. 单条长度（原子性） ---------- */
  const long = [];
  for (const e of entities) {
    for (const ob of obsOf(e)) {
      if (clen(ob) > LIMIT) long.push({ entity: e.name, text: ob });
    }
  }

  let baselineHashes = [];
  if (opts.baseline && isFile(opts.baseline)) {
    try {
      const bl = JSON.parse(fs.readFileSync(opts.baseline, 'utf8').replace(/^\uFEFF/, ''));
      baselineHashes = Array.isArray(bl.longObs) ? bl.longObs.map((x) => String(x).toLowerCase()) : [];
    } catch {
      baselineHashes = []; // ps1: 解析失败就当作没有基线
    }
  }

  const newLong = long.filter((x) => !baselineHashes.includes(obsHash(x.text).toLowerCase()));

  if (long.length > 0) {
    row('INFO', '全库', '单条超长(存量)', `${long.length} 条 >${LIMIT} 字 — 已豁免，按 top5 分期消化`);
    let i = 0;
    for (const t of [...long].sort((a, b) => clen(b.text) - clen(a.text)).slice(0, 5)) {
      i++;
      row('INFO', t.entity, `超长 top${i} (${clen(t.text)} 字)`, t.text.slice(0, Math.min(40, clen(t.text))));
    }
  }
  for (const nl of newLong) {
    row(
      'FAIL',
      nl.entity,
      '新写入超长',
      `${clen(nl.text)} 字 > ${LIMIT}：${nl.text.slice(0, Math.min(30, clen(nl.text)))}… → 拆成两条再写（先写后修等于自罚）`,
    );
  }
  if (newLong.length === 0) {
    row('PASS', '全库', '新写入超长', '0（存量已豁免）');
  }

  if (opts.updateBaseline) {
    const payload = {
      updated: timestampYmdHm(),
      limit: LIMIT,
      longObs: long.map((x) => obsHash(x.text)),
    };
    try {
      const dir = path.dirname(opts.baseline);
      if (!isDir(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.baseline, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      row('INFO', 'baseline', '已更新', `${long.length} 条超长记入豁免（${opts.baseline}）`);
    } catch (err) {
      row('FAIL', 'baseline', '写入失败', `${err.message} → 检查 --baseline 路径是否可写`);
    }
  }
}

/** ps1: Get-Date -Format 'yyyy-MM-dd HH:mm'（本地时间） */
function timestampYmdHm(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

const updateBaseline = parsed.flags.has('update-baseline');
const baselinePath = parsed.values.get('baseline');
if (updateBaseline && !baselinePath) {
  console.error('参数错误：--update-baseline 必须同时给 --baseline <path>（不猜默认写盘位置）');
  console.error(`用 node scripts/${SCRIPT} --help 看用法`);
  process.exit(2);
}

const hotPattern = parsed.values.get('hot-pattern') || DEFAULT_HOT_PATTERN;
try {
  new RegExp(hotPattern); // 早失败：正则写错要立刻报，而不是跑到一半崩
} catch (err) {
  console.error(`参数错误：--hot-pattern 不是合法正则：${err.message}`);
  process.exit(2);
}

const opts = {
  memory: path.resolve(expandHome(parsed.values.get('memory') || path.join(os.homedir(), '.config', 'opencode', 'memory.json'))),
  archive: parsed.values.get('archive') ? path.resolve(expandHome(parsed.values.get('archive'))) : null,
  baseline: baselinePath ? path.resolve(expandHome(baselinePath)) : null,
  updateBaseline,
  hotPattern,
};

main(opts);

const lines = rows.map((r) => `${r.level}\t${flat(r.object)}\t${flat(r.rule)}\t${flat(r.detail)}`);
process.stdout.write(`${lines.join('\n')}\n`);
const count = (lvl) => rows.filter((r) => r.level === lvl).length;
process.stdout.write(
  `\n===== 汇总: PASS ${count('PASS')} / WARN ${count('WARN')} / FAIL ${count('FAIL')} / INFO ${count('INFO')} =====\n`,
);

process.exit(count('FAIL') > 0 ? 1 : 0);
