# Voah 召回精度修复方案:child 级视觉精细化 + 召回硬过滤

> 状态:设计方案,待评审。涉及入库、向量化、召回三阶段,需重跑入库。
> 触发问题:15秒成片里,proof 段文案"倒水测试、水流过后妆面服帖",画面却是户外补妆大头,语义错配。

## 1. 根因(代码+产物实锤)

不是召回到完全无关素材,而是一条三层失效链:

```text
入库阶段:
  Omni 只对整个 story unit 调用 1 次,生成 unit 级 visual_summary / visual_actions。
  detect_cuts 把 unit 切成多个 child(p00/p01/p02),但 child 的视觉字段被清空,
  标记 needs_vlm_refine=True —— 设计上要"后续单独跑 VLM 细化",但这步从未实现。
  结果:同 unit 所有 child 共享父级描述,无法区分"泼水"在哪个 child 的哪一秒。

召回阶段:
  required_visual 硬画面词(泼水/倒水)只用于"加分/扣分",不硬过滤。
  missing_target_terms 明知 10/13 硬词没命中,仍选用,只标 requires_review。
  高质量的 visual_actions 字段(如 ['户外补妆','泼水','纸巾按压'])没进召回匹配通道。

裁切阶段:
  clip_segment_from_parent_story_unit 为了画面连贯,从父 unit 头部连续切 N 秒,
  child 仅作"定位证据"不真正定位。泼水在 unit 后段,从头切就切不到。
```

一句话:**视觉精度信息在入库阶段就没生成到 child 粒度,后面召回/裁切再努力也无米下锅。**

## 2. 关键事实

- `physical_shots.json`:86% 的 child(44/51)`needs_vlm_refine=True`,即绝大多数 child 没有自己的视觉描述。
- `visual_actions` 字段质量其实不错,但是 **unit 级共享**,粒度不够。
- `needs_vlm_refine` 目前只被 `vectorize.py` 消费来**禁用 child 文本向量通道**(规避,非细化)——也就是说精细化没做,反而把 child 的文本检索能力关掉了。
- 入库现在每视频只调 **1 次** Omni。

## 3. 方案总览(B + 入库精细化)

三阶段改造,从源头补齐 child 粒度:

```text
① 入库精细化(新增 refine_child_vlm 步骤)
   对 needs_vlm_refine=True 的 child,用其裁切片段单独调 Omni,
   生成 child 级 visual_summary / visual_actions / source_meaning,回写。
   清除 needs_vlm_refine,恢复 child 文本向量通道。

② 向量化跟进
   child 被精细化后,文本通道(visual_summary/visual_actions 等)恢复向量化,
   让 child 能按自己的语义被召回,而非继承父级。

③ 召回硬过滤 + visual_actions 接入
   - visual_actions 加入召回匹配通道(现在完全没用)。
   - required_visual 从"扣分"升级为"proof/特写等强画面段硬过滤":
     该段硬词在候选 child 的 visual_actions/visual_summary 完全不命中 → 不进 LLM 候选池。
   - 裁切对齐:从命中硬词的 child 起点切,而非父级头部。
```

## 4. 分阶段改动清单

### 阶段一:入库 child 级精细化

新增 `refine_child_vlm.py`(在 voah-video-intake skill 的 scripts 下):

- 输入:`physical_shots.json` + 各 child 的 `trimmed_oss_url`(裁切上传后才有)。
- 对每个 `needs_vlm_refine=True` 的 child:
  - 用 child 自己的裁切片段 URL + 父级上下文 prompt,调 Omni 单独理解。
  - 解析出 child 级 `visual_summary` / `visual_actions` / `source_meaning` / `selling_points`,回写。
  - 置 `needs_vlm_refine=False`,`child_metadata_precision="child_vlm_refined"`,`text_embedding_policy="allow_child_text_channels"`。
- 接入点:`run_intake.py` 加 `--refine-children`,或作为入库后独立步骤。
- 顺序:必须在 trim_and_upload 之后(要 child 的 URL)、vectorize 之前(细化结果要进向量)。

### 阶段二:向量化

- 改 `vectorize.py` 的 `inherited_child_text_only()`:`child_metadata_precision=="child_vlm_refined"` 时恢复文本通道。
- 重向量化被精细化的 child(视频向量可复用,只补文本通道)。

### 阶段三:召回(voah_retrieve_fill_from_audio_sections.py)

- **visual_actions 接入匹配**:`required_visual_hits` / `keyword_hits` 纳入 child 的 `visual_actions`。
- **硬过滤**:proof / 特写 / required_visual 非空的强画面段,候选 child 必须命中至少 1 个硬词,否则剔除出 LLM 候选池(其他段保持现状的软扣分,避免误伤)。
- **裁切对齐**:`clip_segment_from_parent_story_unit` 改为从命中硬词的 child 起点切;命中多 child 时按连续性合并。保留"父级连续"作为无命中时的 fallback。

## 5. 成本与风险

### 成本:Omni 调用激增

- 现状:每视频 1 次 Omni。
- 精细化后:每视频 +N 次(N=需细化的 child 数,约 35-44)。**约 44 倍**。
- 20 个视频:20 次 → ~900 次 Omni 调用。

降本策略(方案内置):

1. **只精细化"强画面段会用到的"child**:opening/口播段对画面精度要求低,可不细化;proof/特写/CTA 等才细化。按 role 或 can_standalone 筛选,砍掉一大半。
2. **并发调用**:现在 detect_cuts 顺序跑,改 child 细化为并发(线程池),墙钟时间不爆炸。
3. **一次性入库成本**:入库是一次性的,不是每条成片都重跑。150 条/天复用同一份入库索引,摊薄后可接受。
4. **增量**:只对 `needs_vlm_refine=True` 跑,已细化的跳过。

### 风险

- **入库要重跑**:现有 cache/voah_video_intake 的产物没有 child 精细描述,要对在用的产品(花西子、防晒)重跑入库或补跑 refine 步骤。
- **Omni 描述质量**:child 级描述依赖 Omni 对短片段的理解,prompt 要给足父级上下文,否则短片段孤立理解可能更差。需小样本验证。
- **硬过滤误伤**:过滤太严可能导致某些段找不到候选 → 回退到软扣分 + requires_review,不能让流程断。

## 6. 实施顺序建议

1. **先做阶段三的 visual_actions 接入 + 软优先**(不依赖重跑入库,用现有 unit 级 visual_actions 就能让召回更准一点),立即见效。
2. **再做阶段一的 refine_child_vlm**,小样本(1 个产品、5 个视频)验证 child 描述质量和成本。
3. 验证 OK 后接阶段二向量化 + 阶段三硬过滤/裁切对齐,full pipeline 重跑验证。
4. 对在用产品重跑入库。

这样风险可控、每步可验证,而不是一次性大爆改。

## 7. 待确认

1. 成本:child 细化按 role 筛选(只细化 proof/特写/CTA 等强画面段)能不能接受?还是全细化?
2. 实施顺序:同意"先软优化(阶段三 visual_actions)见效 → 再重跑入库精细化"的渐进路线,还是直接一步到位全做?
3. 重跑入库:花西子、防晒两个产品的入库重跑,谁来触发(你手动 / 我跑 / 走 voah intake)?
