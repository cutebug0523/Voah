# OhMyCrab 索引

这个目录是 Crab/OhMyCrab 自动生成的项目索引和记忆，不是 Voah 正式工程文档。

## 当前文件

```text
project-memory.md          人类可读的项目记忆
project-index.v2.json      自动项目索引
file-summaries.v1.json     自动文件摘要
dir-summaries.v1.json      自动目录摘要
```

## 使用规则

- 新 agent 可以把这里当辅助上下文，但真源仍是 `../README.md`、`../AGENTS.md` 和 `../docs/README.md`。
- 不要手工维护大型 JSON 索引；需要更新时由对应工具重新生成。
- 正式流程、schema 和决策必须写回 `../docs/`，不能只留在这里。
