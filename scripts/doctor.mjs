#!/usr/bin/env node
/**
 * doctor.mjs — opencode 配置体检（只读，不修改任何文件）
 *
 * 用途：检查一个 opencode 配置目录是否装对了、有哪些坑。
 *       12 项检查覆盖：目录/配置文件/占位符/门禁/workflows/agents/死链/memory/权限/模型 ID。
 *
 * 用法：
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --config-dir "C:/Users/你的名字/.config/opencode"
 *   node scripts/doctor.mjs --json > report.json
 *   node scripts/doctor.mjs --help
 *
 * 参数：
 *   --config-dir <path>  要体检的配置目录；默认 XDG_CONFIG_HOME（未设则 ~/.config）+ /opencode
 *   --json               输出机器可读 JSON（一份对象），而不是表格
 *   --help               打印本说明
 *
 * 输出格式（表格模式）：PASS|WARN|FAIL <TAB> 对象 <TAB> 规则 <TAB> 详情
 *   末尾必有：--- 汇总: PASS=n WARN=n FAIL=n ---
 *
 * 退出码：
 *   0 = 没有 FAIL（可能有 WARN）
 *   1 = 有 FAIL（配置有硬错误，需要修）
 *   2 = 参数错误（比如 --config-dir 后面没给值）
 *
 * 依赖：只用 Node 18+ 内置模块，无 npm 依赖；Windows / macOS / Linux 均可。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const SCRIPT = 'doctor.mjs';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

class UsageError extends Error {}

function parseArgv(argv) {
  const flags = new Set();
  const values = new Map();
  const takesValue = new Set(['config-dir']);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h') {
      flags.add('help');
      continue;
    }
    if (!raw.startsWith('--')) throw new UsageError(`不认识的参数：${raw}`);

    let name = raw.slice(2);
    let inlineValue;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    if (takesValue.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError(`--${name} 需要一个值，例如 --${name} /path/to/opencode`);
        }
      }
      values.set(name, value);
    } else if (inlineValue !== undefined) {
      throw new UsageError(`--${name} 不接受值`);
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

const KNOWN_FLAGS = new Set(['help', 'json']);

function helpText() {
  return [
    `${SCRIPT} — opencode 配置体检（只读）`,
    '',
    '用法：',
    '  node scripts/doctor.mjs',
    '  node scripts/doctor.mjs --config-dir <path>',
    '  node scripts/doctor.mjs --config-dir <path> --json',
    '  node scripts/doctor.mjs --help',
    '',
    '参数：',
    '  --config-dir <path>  要体检的配置目录（默认 ~/.config/opencode；设了 XDG_CONFIG_HOME 则以它为准）',
    '  --json               输出机器可读 JSON，而不是表格',
    '  --help, -h           打印本说明',
    '',
    '输出：每行 PASS/WARN/FAIL <TAB> 对象 <TAB> 规则 <TAB> 详情，末尾一行汇总。',
    '退出码：0 无 FAIL；1 有 FAIL；2 参数错误。',
    '',
    '示例：',
    '  node scripts/doctor.mjs --config-dir "C:/Users/me/.config/opencode"',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const rows = [];
function row(level, obj, rule, detail) {
  rows.push({ level, object: obj, rule, detail: String(detail) });
}

/** 表格模式下把制表符/换行压平，避免一行变多行 */
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

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

function bytes(n) {
  if (n < 1024) return `${n} 字节`;
  const kb = n / 1024;
  if (kb < 1024) return `${n} 字节（${kb.toFixed(1)} KB）`;
  return `${n} 字节（${(kb / 1024).toFixed(1)} MB）`;
}

function offsetToLineCol(text, offset) {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  return { line, col };
}

/**
 * 尽量给出 JSON 语法错误的行号。
 * Node 20+ 的 V8 有时会在消息里带 "at position N (line L column C)"，有时不带
 * （例如尾随逗号只说 "is not valid JSON"）。不带时用两个启发式定位：
 *   1) 去掉尾随逗号后再解析：能通过 → 问题就是尾随逗号，报第一处位置；
 *   2) 出现行注释或块注释开头 → 说明这是 JSONC，报第一处注释所在行。
 * 都定位不到就如实写"行未知"，不编造行号。
 */
function describeJsonError(text, err) {
  const msg = err && err.message ? err.message : String(err);

  const m = /at position (\d+)/.exec(msg);
  if (m) {
    const { line, col } = offsetToLineCol(text, Number(m[1]));
    return `第 ${line} 行第 ${col} 列：${msg}`;
  }
  const m2 = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (m2) return `第 ${m2[1]} 行第 ${m2[2]} 列：${msg}`;

  const noTrailing = /,(\s*[}\]])/g;
  let repaired = text;
  let firstTrailing = -1;
  repaired = repaired.replace(noTrailing, (all, tail, offset) => {
    if (firstTrailing < 0) firstTrailing = offset;
    return tail;
  });
  if (firstTrailing >= 0) {
    try {
      JSON.parse(repaired);
      const { line, col } = offsetToLineCol(text, firstTrailing);
      return `第 ${line} 行附近有多余的逗号（尾随逗号）：${msg}`;
    } catch {
      /* 还有别的问题，继续往下判断 */
    }
  }

  const comment = /(^|\n)\s*(\/\/|\/\*)/.exec(text);
  if (comment) {
    const offset = comment.index + (comment[1] ? comment[1].length : 0);
    const { line } = offsetToLineCol(text, offset);
    return `第 ${line} 行有注释，JSON 不支持注释（jsonc 才支持）：${msg}`;
  }

  return `行未知（V8 没给位置信息）：${msg}`;
}

/* ------------------------------------------------------------------ */
/* 检查项                                                              */
/* ------------------------------------------------------------------ */

const PLACEHOLDERS = [
  { token: 'YOUR_USERNAME', hint: '旧版用户名占位符' },
  { token: '<provider>', hint: '模型 provider 占位符' },
  { token: '<你的', hint: '路径/值占位符' },
  { token: '<最便宜', hint: '模型档位占位符' },
];

/**
 * 令牌占位符：{{USER}} / {{CFG_ROOT}} / {{WORK_ROOT}} / {{KNOWLEDGE_ROOT}} / {{WORKSPACE_ROOT}} / {{MODEL_*}}
 * 只匹配「双花括号 + 大写字母/下划线」的真令牌，而不是简单看有没有 `{{`：
 * AGENTS.md 与模板里还有 `{{...}}` 这种说明性写法，按字符找会把它误判成没替换完（永远 FAIL）。
 */
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/;

/** 在文件里找占位符，返回 [{file, line, token}] */
function findPlaceholders(file, label) {
  const hits = [];
  let text;
  try {
    text = readText(file);
  } catch {
    return hits;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    for (const { token } of PLACEHOLDERS) {
      if (lineText.includes(token)) hits.push({ file: label, line: i + 1, token });
    }
    const m = PLACEHOLDER_RE.exec(lineText);
    if (m) hits.push({ file: label, line: i + 1, token: m[0] });
  });
  return hits;
}

const WORKFLOW_FILES = ['需求', '架构', '开发', '测试', '发布', '观察', '继续', '委派', '知识库'].map(
  (n) => `${n}.md`,
);
const WF_TOTAL = WORKFLOW_FILES.length;
const AGENT_ROLES = ['advisor.md', 'final.md', 'writer.md'];

const GATES = [
  { name: '无可测验收不进计划', re: /无可测|验收标准/ },
  { name: '只动计划内文件', re: /只动计划内|计划内文件/ },
  { name: '停点=可独立验收的增量', re: /停点/ },
  { name: '报数字必须贴证据', re: /报数字|贴证据/ },
];

function findMemoryServer(cfgJson) {
  const mcp = cfgJson && cfgJson.mcp;
  if (!mcp || typeof mcp !== 'object') return null;
  if (mcp.memory && typeof mcp.memory === 'object') return mcp.memory;
  if (mcp.servers && typeof mcp.servers === 'object' && mcp.servers.memory) return mcp.servers.memory;
  return null;
}

function collectModels(cfgJson) {
  const out = [];
  if (!cfgJson || typeof cfgJson !== 'object') return out;
  if (typeof cfgJson.model === 'string') out.push({ role: '顶层默认', model: cfgJson.model });
  for (const key of ['agents', 'agent']) {
    const bag = cfgJson[key];
    if (!bag || typeof bag !== 'object') continue;
    for (const [role, def] of Object.entries(bag)) {
      if (def && typeof def === 'object' && typeof def.model === 'string') {
        out.push({ role, model: def.model });
      }
    }
  }
  return out;
}

function isPlaceholderValue(v) {
  return /[<>]/.test(v) || v.includes('YOUR_USERNAME') || PLACEHOLDER_RE.test(v);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function defaultConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

function run(configDirRaw) {
  const configDir = path.resolve(expandHome(configDirRaw));
  const ocPath = path.join(configDir, 'opencode.json');
  const agentsMdPath = path.join(configDir, 'AGENTS.md');

  let ocText = null;
  let ocJson = null;
  let jsonError = null;

  /* --- 1. 配置目录存在 --- */
  const cfgOk = isDir(configDir);
  if (cfgOk) {
    row('PASS', '配置目录', '存在', configDir);
  } else {
    row(
      'FAIL',
      '配置目录',
      '存在',
      `找不到 ${configDir} → 确认 opencode 已安装并至少启动过一次；macOS/Linux 与 Windows 都是 ~/.config/opencode（Windows 即 C:\\Users\\<你>\\.config\\opencode），设了 XDG_CONFIG_HOME 则以它为准；也可以用 --config-dir 指到别处`,
    );
  }

  /* --- 2. opencode.json 存在且是合法 JSON --- */
  if (isFile(ocPath)) {
    try {
      ocText = readText(ocPath);
      ocJson = JSON.parse(ocText);
      row('PASS', 'opencode.json', '合法 JSON', `已解析，${bytes(Buffer.byteLength(ocText, 'utf8'))}`);
    } catch (err) {
      jsonError = describeJsonError(ocText || '', err);
      row(
        'FAIL',
        'opencode.json',
        '合法 JSON',
        `${jsonError} → 按行号修掉语法错误（常见：尾随逗号、注释、少了引号），或先备份再用编辑器 / JSON 校验器重排`,
      );
    }
  } else {
    const jsonc = path.join(configDir, 'opencode.jsonc');
    const example = path.join(configDir, 'opencode.json.example');
    let detail;
    if (isFile(jsonc)) {
      detail =
        '没找到 opencode.json，但检测到 opencode.jsonc（jsonc 允许注释，本脚本不解析它）→ 确认 opencode 读的是哪一份，两个同时存在容易改错文件';
    } else if (isFile(example)) {
      detail = '没找到 opencode.json，只有 opencode.json.example（模板）→ 复制成 opencode.json 再逐个替换占位符';
    } else {
      detail = `${configDir} 里没有 opencode.json → 用仓库的 config/opencode.json.example 起步，或先让 opencode 启动一次生成默认配置`;
    }
    row('WARN', 'opencode.json', '存在', detail);
  }

  /* --- 3. 残留占位符 --- */
  const placeholderHits = [];
  if (isFile(ocPath)) placeholderHits.push(...findPlaceholders(ocPath, 'opencode.json'));
  if (isFile(agentsMdPath)) placeholderHits.push(...findPlaceholders(agentsMdPath, 'AGENTS.md'));
  if (placeholderHits.length > 0) {
    const list = placeholderHits
      .slice(0, 8)
      .map((h) => `${h.file}:${h.line} ${h.token}`)
      .join('；');
    const more = placeholderHits.length > 8 ? `；… 共 ${placeholderHits.length} 处` : '';
    row(
      'FAIL',
      '占位符',
      '无残留占位符',
      `命中 ${placeholderHits.length} 处：${list}${more} → 把占位符换成你的真实用户名/路径/模型 ID，然后重启 opencode`,
    );
  } else {
    row('PASS', '占位符', '无残留占位符', 'opencode.json 与 AGENTS.md 都没发现占位符');
  }

  /* --- 4. _说明 字段 --- */
  if (ocJson && typeof ocJson === 'object') {
    if (Object.prototype.hasOwnProperty.call(ocJson, '_说明')) {
      row(
        'WARN',
        'opencode.json',
        '_说明 字段',
        '存在 _说明（不是有效配置项，opencode 不读它）→ 建议删掉，避免新版对未知字段报错',
      );
    } else {
      row('PASS', 'opencode.json', '_说明 字段', '没有 _说明');
    }
  } else {
    row('WARN', 'opencode.json', '_说明 字段', '没有可解析的 opencode.json，本项跳过');
  }

  /* --- 5. AGENTS.md 存在 --- */
  const agentsText = isFile(agentsMdPath) ? readText(agentsMdPath) : null;
  if (agentsText !== null) {
    row('PASS', 'AGENTS.md', '存在', `${agentsMdPath}，${bytes(Buffer.byteLength(agentsText, 'utf8'))}`);
  } else {
    row(
      'FAIL',
      'AGENTS.md',
      '存在',
      `找不到 ${agentsMdPath} → 从仓库 config/AGENTS.md 复制过去（全局规则必须在这个位置才对所有项目生效）`,
    );
  }

  /* --- 6. AGENTS.md 含门禁四条 --- */
  if (agentsText === null) {
    row('WARN', 'AGENTS.md', '门禁四条', 'AGENTS.md 不存在，无法校验门禁（先修上一项）');
  } else {
    const missing = GATES.filter((g) => !g.re.test(agentsText)).map((g) => g.name);
    const found = GATES.length - missing.length;
    if (missing.length === 0) {
      row('PASS', 'AGENTS.md', '门禁四条', `4/4 条都在：${GATES.map((g) => g.name).join('、')}`);
    } else if (missing.length <= 2) {
      row(
        'WARN',
        'AGENTS.md',
        '门禁四条',
        `${found}/4 条，缺：${missing.join('、')} → 把缺的门禁条文补回 AGENTS.md「工程总纲 / 门禁」段`,
      );
    } else {
      row(
        'FAIL',
        'AGENTS.md',
        '门禁四条',
        `只有 ${found}/4 条，缺：${missing.join('、')} → 门禁是这套配置的核心，务必照 AGENTS.md 的「门禁（硬规则）」一节补齐`,
      );
    }
  }

  /* --- 7. workflows 目录 --- */
  const wfDir = path.join(configDir, 'workflows');
  const presentWf = [];
  const missingWf = [];
  for (const f of WORKFLOW_FILES) {
    (isFile(path.join(wfDir, f)) ? presentWf : missingWf).push(f);
  }
  let wfListText = '';
  if (isDir(wfDir)) {
    try {
      const actual = fs.readdirSync(wfDir).filter((f) => f.endsWith('.md'));
      wfListText = actual.length ? `目录现有：${actual.join('、')}` : '目录是空的';
    } catch {
      wfListText = '目录读不了';
    }
  } else {
    wfListText = 'workflows 目录不存在';
  }
  if (missingWf.length === 0) {
    row('PASS', 'workflows', `${WF_TOTAL} 个流程文件`, `${WF_TOTAL}/${WF_TOTAL} 都在（${presentWf.join('、')}）`);
  } else if (presentWf.length === 0) {
    row(
      'FAIL',
      'workflows',
      `${WF_TOTAL} 个流程文件`,
      `0/${WF_TOTAL}，全缺（${wfListText}）→ 把仓库 config/workflows/*.md 整个复制到 ${wfDir}`,
    );
  } else {
    row(
      'WARN',
      'workflows',
      `${WF_TOTAL} 个流程文件`,
      `${presentWf.length}/${WF_TOTAL}，缺 ${missingWf.length} 个：${missingWf.join('、')}（${wfListText}）→ 补上缺的流程 md`,
    );
  }

  /* --- 8. agents 目录 --- */
  // opencode 实际读的是 agent/（单数），仓库模板目录叫 agents/；两边都查，避免装错位置被误判。
  const agentDirs = [path.join(configDir, 'agent'), path.join(configDir, 'agents')];
  const foundRoles = new Map();
  for (const dir of agentDirs) {
    if (!isDir(dir)) continue;
    for (const role of AGENT_ROLES) {
      if (!foundRoles.has(role) && isFile(path.join(dir, role))) foundRoles.set(role, dir);
    }
  }
  const missingRoles = AGENT_ROLES.filter((r) => !foundRoles.has(r));
  const agentDirText = agentDirs.map((d) => (isDir(d) ? d : `${d}（缺）`)).join(' / ');
  if (missingRoles.length === 0) {
    const where = [...new Set(foundRoles.values())].join('、');
    row('PASS', 'agents', 'advisor/final/writer', `3/3 都在：${where}`);
  } else if (foundRoles.size === 0) {
    row(
      'WARN',
      'agents',
      'advisor/final/writer',
      `0/3，agent/ 和 agents/ 目录都没有（${agentDirText}）→ 这 3 个角色会不可用；把 config/agents/*.md 复制到 ${path.join(configDir, 'agent')}`,
    );
  } else {
    row(
      'WARN',
      'agents',
      'advisor/final/writer',
      `${foundRoles.size}/3，缺：${missingRoles.join('、')} → 这些角色会不可用（${agentDirText}）`,
    );
  }

  /* --- 9. 死链检查 --- */
  if (agentsText === null) {
    row('WARN', 'AGENTS.md', '死链', 'AGENTS.md 不存在，无法检查引用');
  } else {
    const refs = new Map(); // rel -> firstLine
    const re = /(workflows|docs)[\\/]([^\s`"'()（）<>[\]，。、；;|]+?\.md)/g;
    let m;
    while ((m = re.exec(agentsText)) !== null) {
      const rel = `${m[1]}/${m[2]}`;
      if (!refs.has(rel)) {
        const line = agentsText.slice(0, m.index).split('\n').length;
        refs.set(rel, line);
      }
    }
    const dead = [];
    for (const [rel, line] of refs) {
      const candidates = [
        path.resolve(configDir, rel),
        path.resolve(configDir, '..', rel), // 仓库根目录下的 docs/ 之类
      ];
      if (!candidates.some((p) => isFile(p))) dead.push(`${rel}(第${line}行)`);
    }
    if (refs.size === 0) {
      row('PASS', 'AGENTS.md', '死链', '没有引用任何 workflows/ 或 docs/ 文件');
    } else if (dead.length === 0) {
      row('PASS', 'AGENTS.md', '死链', `${refs.size} 个引用全部存在`);
    } else {
      row(
        'WARN',
        'AGENTS.md',
        '死链',
        `${dead.length}/${refs.size} 个引用找不到：${dead.join('、')} → 补文件，或把 AGENTS.md 里的路径改成实际位置`,
      );
    }
  }

  /* --- 10. memory 配置一致性 --- */
  if (!ocJson) {
    row('WARN', 'memory', 'MEMORY_FILE_PATH', '没有可解析的 opencode.json，本项跳过');
  } else {
    const mem = findMemoryServer(ocJson);
    if (!mem) {
      row(
        'WARN',
        'memory',
        'MEMORY_FILE_PATH',
        'opencode.json 没配 memory MCP → 可选功能，不装也能用（开场路由靠 AGENTS.md 的类别兜底）；要用就加 mcp.memory + MEMORY_FILE_PATH',
      );
    } else {
      const env = (mem.environment && typeof mem.environment === 'object' ? mem.environment : null) ||
        (mem.env && typeof mem.env === 'object' ? mem.env : null) || {};
      const raw = env.MEMORY_FILE_PATH;
      if (typeof raw !== 'string' || raw.trim() === '') {
        row(
          'FAIL',
          'memory',
          'MEMORY_FILE_PATH',
          'memory server 没有 MEMORY_FILE_PATH（或不是字符串）→ 在 environment 里补上真实路径，例如 ~/.config/opencode/memory.json',
        );
      } else if (isPlaceholderValue(raw)) {
        row(
          'FAIL',
          'memory',
          'MEMORY_FILE_PATH',
          `还是占位符：${raw} → 换成真实路径（如 C:/Users/<你>/.config/opencode/memory.json），否则 memory 会写到错误位置`,
        );
      } else {
        const memPath = path.resolve(expandHome(raw));
        if (isFile(memPath)) {
          const size = fs.statSync(memPath).size;
          row('PASS', 'memory', 'MEMORY_FILE_PATH', `${memPath} 存在，${bytes(size)}`);
        } else {
          const parent = path.dirname(memPath);
          const parentNote = isDir(parent) ? '父目录存在' : `父目录也不存在（${parent}），memory 启动可能报错`;
          row(
            'WARN',
            'memory',
            'MEMORY_FILE_PATH',
            `${memPath} 不存在（首次使用会自动创建；${parentNote}）→ 想立刻确认可用，就手动建个空文件再重启`,
          );
        }
      }
    }
  }

  /* --- 11. 权限路径合法性 --- */
  if (!ocJson) {
    row('WARN', 'permission', '路径键合法性', '没有可解析的 opencode.json，本项跳过');
  } else {
    const perm = ocJson.permission;
    const offenders = [];
    if (perm && typeof perm === 'object') {
      for (const [section, body] of Object.entries(perm)) {
        const keys = [];
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          keys.push(...Object.keys(body));
        } else if (Array.isArray(body)) {
          for (const item of body) {
            if (item && typeof item === 'object') {
              for (const k of ['resource', 'pattern', 'path']) {
                if (typeof item[k] === 'string') keys.push(item[k]);
              }
            }
          }
        }
        for (const k of keys) {
          if (/[<>]/.test(k)) offenders.push(`permission.${section} → ${k}`);
        }
      }
    }
    if (offenders.length > 0) {
      row(
        'FAIL',
        'permission',
        '路径键合法性',
        `${offenders.length} 个键里含 < 或 >：${offenders.slice(0, 5).join('；')} → 换成真实绝对路径，含尖括号会让 opencode 解析失败`,
      );
    } else if (!perm || typeof perm !== 'object') {
      row('PASS', 'permission', '路径键合法性', '没有 permission 段（用默认权限），无非法键');
    } else {
      row('PASS', 'permission', '路径键合法性', '没有含 < 或 > 的路径键');
    }
  }

  /* --- 12. 模型 ID --- */
  if (!ocJson) {
    row('WARN', 'model', '占位符', '没有可解析的 opencode.json，本项跳过');
  } else {
    const models = collectModels(ocJson);
    if (models.length === 0) {
      row(
        'WARN',
        'model',
        '占位符',
        '配置里一个 model 字段都没有 → 至少给顶层 model 或各角色配一个，否则会话起不来',
      );
    } else {
      const bad = models.filter((x) => isPlaceholderValue(x.model));
      if (bad.length > 0) {
        row(
          'FAIL',
          'model',
          '占位符',
          `${bad.length}/${models.length} 处还是占位符：${bad
            .map((x) => `${x.role}=${x.model}`)
            .join('；')} → 换成你套餐里当前可用的模型 ID`,
        );
      } else {
        const roles = models.map((x) => x.role).join('、');
        row('PASS', 'model', '占位符', `${models.length} 处模型配置都不是占位符：${roles}`);
      }
    }
  }

  /* --- 汇总 --- */
  const summary = {
    PASS: rows.filter((r) => r.level === 'PASS').length,
    WARN: rows.filter((r) => r.level === 'WARN').length,
    FAIL: rows.filter((r) => r.level === 'FAIL').length,
  };
  return { configDir, rows, summary };
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
    console.error('用 node scripts/doctor.mjs --help 看用法');
    process.exit(2);
  }
  throw err;
}

for (const flag of parsed.flags) {
  if (!KNOWN_FLAGS.has(flag)) {
    console.error(`参数错误：不认识的选项 --${flag}`);
    console.error('用 node scripts/doctor.mjs --help 看用法');
    process.exit(2);
  }
}

if (parsed.flags.has('help')) {
  console.log(helpText());
  process.exit(0);
}

const wantJson = parsed.flags.has('json');
const configDirArg = parsed.values.get('config-dir') || defaultConfigDir();
const result = run(configDirArg);

if (wantJson) {
  const payload = {
    tool: SCRIPT,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    configDir: result.configDir,
    checks: result.rows,
    summary: result.summary,
    ok: result.summary.FAIL === 0,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  const lines = result.rows.map((r) => `${r.level}\t${flat(r.object)}\t${flat(r.rule)}\t${flat(r.detail)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stdout.write(
    `--- 汇总: PASS=${result.summary.PASS} WARN=${result.summary.WARN} FAIL=${result.summary.FAIL} ---\n`,
  );
}

process.exit(result.summary.FAIL > 0 ? 1 : 0);
