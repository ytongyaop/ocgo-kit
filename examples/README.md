# examples

## `memory.example.json` 是什么

记忆库的格式示例：用虚构的"阳台园艺工具"项目，演示实体和关系在文件里长什么样。

## 格式：JSONL，不是 JSON 数组

一行一个 JSON 对象，每行独立解析。memory MCP 就是这么存的，所以示例也这么写。整份文件用 JSON 数组包起来会被当成一行读，直接解析失败。

## 怎么用

1. **当格式参考**：照着写你自己的 `memory.json`，字段名照抄。
2. **当空白模板**：复制成 `~/.config/opencode/memory.json`（或你在配置里用 `MEMORY_FILE_PATH` 指定的那个路径），把内容换成自己的，然后重启 opencode。
3. **先跑一遍体检**：`node scripts/memory-lint.mjs --memory examples/memory.example.json`，示例本身应无 FAIL。

## 字段说明

实体（`"type":"entity"`）：

- `name`：实体名，必须以 `user:` / `project:` / `tool:` / `protocol:` / `state:` 开头。
- `entityType`：分类标签，自由字符串，上面那五个前缀的对应值即可。
- `observations`：字符串数组，一条一个原子事实。
  - 其中必须至少有行首为 `状态：`（带日期）、`边界：`（管什么不管什么）、`明细：`（存档指针）的三条。
  - 单条不超过 160 字，超长当场拆成两条。

关系（`"type":"relation"`）：

- `from` / `to`：两端实体名，必须和某个实体的 `name` 完全一致。
- `relationType`：关系名，自由字符串（示例用 `owns` / `uses` / `maintains`）。

索引实体：名字里带「记忆索引」的那个，用 `【user】名字` 这样的行登记其他实体；漏登记会出 WARN，登记了不存在的实体会出 FAIL。

## 注意

- 文件顶部不能加注释，JSONL 不支持。
- 示例内容全部虚构；不要把自己的业务数据、真实姓名、真实路径塞进示例文件。
- 热层（每次会话必读）的实体要小，过程性内容进存档，只在记忆里留结论和指针。
