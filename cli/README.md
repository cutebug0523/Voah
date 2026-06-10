# Voah CLI

Voah CLI 是当前生产内核入口。它负责调度本地 worker、ffmpeg、HyperFrames、临时 OSS 资源、任务 manifest、日志和 QA gate。

员工操作层可以调用 CLI，但不应重新实现生产编排。

## 常用命令

```bash
node cli/src/bin/voah.js doctor --workspace /Users/noah/混剪
node cli/src/bin/voah.js config get
node cli/src/bin/voah.js intake run --product huaxizi-qidian --source-dir /Users/noah/混剪/原片/气垫 --limit 6 --label selected6_cli_v1
node cli/src/bin/voah.js task create --product huaxizi-qidian --intake-run /path/to/intake_run --target-duration 45 --label 45秒抖音投放版
node cli/src/bin/voah.js task run /path/to/task_dir
node cli/src/bin/voah.js task run /path/to/task_dir --from retrieve
node cli/src/bin/voah.js batch run --product huaxizi-qidian --intake-run /path/to/intake_run --count 2 --concurrency 2
```

## 状态文件

单任务：

```text
task_manifest.json
logs/{stage}.jsonl
logs/{stage}.stdout.log
logs/{stage}.stderr.log
resource_manifest.json
```

批量：

```text
batch_manifest.json
tasks.json
passed_videos.json
logs/
```

## Secret

CLI 读取：

```text
~/.voah/config.json
~/.voah/secrets.env
workspace/.env
~/.voah/video_intake/.env
```

`voah config get` 只展示 key 是否存在，不回显明文。
