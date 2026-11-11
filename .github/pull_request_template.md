## 这个 PR 改变了什么行为

（不是"改了哪几行"，而是使用者会感觉到什么变化。比如：装完之后少一个 FAIL、某个流程不再被触发、默认权限范围缩小了。）

## 为什么

（取舍理由：不这么做会怎样。本仓库加一条规则等于给所有使用者加一条约束，所以这里要说清"不加会出什么问题"，而不只是"加了更好"。）

## 验证

- [ ] `node --check` 三个脚本通过
- [ ] `opencode.json.example` 是合法 JSON
- [ ] `memory-lint` 对示例无 FAIL
- [ ] `install.mjs` dry-run 未写入任何文件
- [ ] 若改了 `config/`，`docs/` 与 `doctor.mjs` 已同步
- [ ] 无真实姓名 / 路径 / token / 内部流程

<details>
<summary>验证输出（贴关键几行即可）</summary>

```text
（把命令和输出粘在这里）
```

</details>
