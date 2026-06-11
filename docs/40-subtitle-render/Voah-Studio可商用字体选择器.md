# Voah Studio 可商用字幕字体选择器

## 决策

Studio 首批不把大型中文字体文件直接放进普通 git。设置页提供字体选择器、license 追溯和本机安装检测；生产时把已安装字体的 `font_source` 写入任务参数，由 `voah_build_caption_plan.py`、HyperFrames 字幕工程和 PNG fallback 共用同一字体路径。

原因：

- 思源黑体、思源宋体、霞鹜文楷等单字重常见 13-25MB，普通 git 会快速膨胀。
- 当前 HyperFrames 工程已支持小型 `.ttf/.otf/.woff/.woff2` 嵌入，大型字体应走本机字体库或后续安装器/下载器。
- 字幕 fallback 已读取 `caption_plan.style.font_source`，只要 task 传入同一字体路径即可复刻。

## 首批候选

| 字体 | 用途 | License | 来源 |
|---|---|---|---|
| 思源黑体 SC | 清晰黑体字幕 | SIL OFL 1.1，可商用 | <https://github.com/adobe-fonts/source-han-sans/blob/release/LICENSE.txt> |
| 思源宋体 SC | 美妆、高级感宋体 | SIL OFL 1.1，可商用 | <https://github.com/adobe-fonts/source-han-serif/blob/release/LICENSE.txt> |
| 得意黑 | 醒目标题/促销强调 | SIL OFL 1.1，可商用 | <https://github.com/atelier-anchor/smiley-sans/blob/main/LICENSE> |
| 霞鹜文楷 Lite | 亲和、种草、手写感 | SIL OFL 1.1，可商用 | <https://github.com/lxgw/LxgwWenKai-Lite/blob/main/OFL.txt> |
| 站酷快乐体 | 活泼促销字幕 | SIL OFL 1.1，可商用 | <https://github.com/googlefonts/zcool-kuaile/blob/main/OFL.txt> |
| 站酷庆科黄油体 | 标题感、年轻化 | SIL OFL 1.1，可商用 | <https://github.com/googlefonts/zcool-qingke-huangyou/blob/main/OFL.txt> |

阿里巴巴普惠体官方标注永久免费正版商用字体，但再分发边界不如 OFL 字体直接，先作为用户本地安装备选，不放首批内置资产。

## 工程约定

- Studio 前端展示中文字体名、预览样例、安装状态、license 来源。
- `desktop/voah-studio/electron/voahService.js` 检测本机候选路径，返回 `installed_path`。
- `desktop/voah-studio/src/features/NewBatchDrawer.jsx` 把 `settings.subtitle.font_source` 转为 `--font-source`。
- `cli/src/commands/task.js` 和 `cli/src/commands/batch.js` 将字幕 preset/font_source 写入 `task_manifest.json`。
- `cli/src/core/taskPipeline.js` 的 subtitle 阶段优先读取 `manifest.subtitle.font_source`。

## 后续

若要把小体积字体随包发布，优先考虑：

- 站酷快乐体：约 1.45MB，OFL。
- 得意黑：单文件通常小于 8MB，OFL。
- 站酷庆科黄油体：约 7.94MB，OFL，接近当前 8MB 嵌入阈值。

大型字体建议走安装器下载、Git LFS 或本机字体库，不直接提交到普通 git。
