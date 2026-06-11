export const MINIMAX_DOCS = {
  t2a: "https://platform.minimax.io/docs/api-reference/speech-t2a-http.md",
  getVoice: "https://platform.minimax.io/docs/api-reference/voice-management-get.md",
  systemVoiceList: "https://platform.minimax.io/docs/faq/system-voice-id.md"
};

export const TTS_RANGES = {
  speed: { min: 0.5, max: 2, step: 0.05, defaultValue: 1.1 },
  vol: { min: 0.1, max: 10, step: 0.1, defaultValue: 1 },
  pitch: { min: -12, max: 12, step: 1, defaultValue: 0 },
  modifyPitch: { min: -100, max: 100, step: 1, defaultValue: 20 },
  intensity: { min: -100, max: 100, step: 1, defaultValue: 20 },
  timbre: { min: -100, max: 100, step: 1, defaultValue: 0 }
};

export const TTS_EMOTIONS = [
  { value: "happy", label: "开心" },
  { value: "sad", label: "悲伤" },
  { value: "angry", label: "愤怒" },
  { value: "fearful", label: "害怕" },
  { value: "disgusted", label: "厌恶" },
  { value: "surprised", label: "惊讶" },
  { value: "calm", label: "平静" }
];

export const FALLBACK_TTS_VOICES = [
  {
    voice_id: "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
    voice_name: "当前默认音色",
    description: "已验证的带货女声基线"
  },
  {
    voice_id: "Chinese (Mandarin)_Warm_Bestie",
    voice_name: "亲和闺蜜女声",
    description: "适合口语种草、日常分享"
  },
  {
    voice_id: "Chinese (Mandarin)_Sweet_Lady",
    voice_name: "甜美女声",
    description: "适合轻快带货和氛围感表达"
  },
  {
    voice_id: "Chinese (Mandarin)_Warm_Girl",
    voice_name: "温暖少女",
    description: "适合自然、亲切的产品介绍"
  },
  {
    voice_id: "Chinese (Mandarin)_Crisp_Girl",
    voice_name: "清亮少女",
    description: "适合节奏更利落的口播"
  },
  {
    voice_id: "Chinese (Mandarin)_News_Anchor",
    voice_name: "新闻主播女声",
    description: "适合清晰稳重的说明段"
  },
  {
    voice_id: "Chinese (Mandarin)_Radio_Host",
    voice_name: "电台主持",
    description: "适合温和、有陪伴感的讲述"
  },
  {
    voice_id: "Chinese (Mandarin)_Gentleman",
    voice_name: "绅士男声",
    description: "适合稳重男性口播"
  }
];

export const VOICE_NAME_ZH = {
  "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d": "当前默认音色",
  "Chinese (Mandarin)_Reliable_Executive": "可靠高管",
  "Chinese (Mandarin)_News_Anchor": "新闻主播女声",
  "Chinese (Mandarin)_Unrestrained_Young_Man": "洒脱青年男声",
  "Chinese (Mandarin)_Mature_Woman": "成熟女声",
  Arrogant_Miss: "傲娇小姐",
  Robot_Armor: "机甲音色",
  "Chinese (Mandarin)_Kind-hearted_Antie": "热心阿姨",
  "Chinese (Mandarin)_HK_Flight_Attendant": "港风空乘",
  "Chinese (Mandarin)_Humorous_Elder": "幽默长辈",
  "Chinese (Mandarin)_Gentleman": "绅士男声",
  "Chinese (Mandarin)_Warm_Bestie": "亲和闺蜜女声",
  "Chinese (Mandarin)_Stubborn_Friend": "倔强朋友",
  "Chinese (Mandarin)_Sweet_Lady": "甜美女声",
  "Chinese (Mandarin)_Southern_Young_Man": "南方青年男声",
  "Chinese (Mandarin)_Wise_Women": "睿智女声",
  "Chinese (Mandarin)_Gentle_Youth": "温柔青年",
  "Chinese (Mandarin)_Warm_Girl": "温暖少女",
  "Chinese (Mandarin)_Male_Announcer": "男播音员",
  "Chinese (Mandarin)_Kind-hearted_Elder": "热心长辈",
  "Chinese (Mandarin)_Cute_Spirit": "元气可爱",
  "Chinese (Mandarin)_Radio_Host": "电台主持",
  "Chinese (Mandarin)_Lyrical_Voice": "抒情女声",
  "Chinese (Mandarin)_Straightforward_Boy": "直率男孩",
  "Chinese (Mandarin)_Sincere_Adult": "真诚成人",
  "Chinese (Mandarin)_Gentle_Senior": "温和长者",
  "Chinese (Mandarin)_Crisp_Girl": "清亮少女",
  "Chinese (Mandarin)_Pure-hearted_Boy": "纯净男孩",
  "Chinese (Mandarin)_Soft_Girl": "柔软少女",
  "Chinese (Mandarin)_IntellectualGirl": "知性女声",
  "Chinese (Mandarin)_Warm_HeartedGirl": "暖心少女",
  "Chinese (Mandarin)_Laid_BackGirl": "松弛少女",
  "Chinese (Mandarin)_ExplorativeGirl": "探索少女",
  "Chinese (Mandarin)_Warm-HeartedAunt": "暖心阿姨",
  "Chinese (Mandarin)_BashfulGirl": "羞涩少女",
  "Cantonese_ProfessionalHost (F)": "粤语专业女主持",
  Cantonese_GentleLady: "粤语温柔女声",
  "Cantonese_ProfessionalHost (M)": "粤语专业男主持",
  Cantonese_PlayfulMan: "粤语活泼男声",
  Cantonese_CuteGirl: "粤语可爱女声",
  Cantonese_KindWoman: "粤语亲切女声"
};

export const SUBTITLE_PRESETS = [
  { value: "songti_white_gold_lower", label: "白金描边下方" },
  { value: "live_bar_lower", label: "直播口播条下方" }
];

export const FONT_OPTIONS = [
  {
    id: "smiley-sans",
    label: "得意黑",
    family: "Smiley Sans",
    style: "标题体 / 俏皮醒目",
    license: "SIL Open Font License 1.1，可商用",
    license_url: "https://github.com/atelier-anchor/smiley-sans/blob/main/LICENSE",
    bundled_file: "SmileySans-Oblique.otf",
    font_format: "opentype",
    candidate_paths: [
      "~/.voah/fonts/SmileySans-Oblique.otf",
      "/Library/Fonts/SmileySans-Oblique.ttf",
      "/Library/Fonts/SmileySans-Oblique.otf",
      "/Library/Fonts/得意黑.ttf"
    ]
  },
  {
    id: "zcool-kuaile",
    label: "站酷快乐体",
    family: "ZCOOL KuaiLe",
    style: "促销体 / 活泼醒目",
    license: "SIL Open Font License 1.1，可商用",
    license_url: "https://github.com/googlefonts/zcool-kuaile/blob/main/OFL.txt",
    bundled_file: "ZCOOLKuaiLe-Regular.ttf",
    font_format: "truetype",
    candidate_paths: [
      "~/.voah/fonts/ZCOOLKuaiLe-Regular.ttf",
      "/Library/Fonts/ZCOOLKuaiLe-Regular.ttf",
      "/Library/Fonts/ZCOOL KuaiLe Regular.ttf"
    ]
  },
  {
    id: "zcool-qingke",
    label: "站酷庆科黄油体",
    family: "ZCOOL QingKe HuangYou",
    style: "标题体 / 年轻利落",
    license: "SIL Open Font License 1.1，可商用",
    license_url: "https://github.com/googlefonts/zcool-qingke-huangyou/blob/main/OFL.txt",
    bundled_file: "ZCOOLQingKeHuangYou-Regular.ttf",
    font_format: "truetype",
    candidate_paths: [
      "~/.voah/fonts/ZCOOLQingKeHuangYou-Regular.ttf",
      "/Library/Fonts/ZCOOLQingKeHuangYou-Regular.ttf",
      "/Library/Fonts/ZCOOL QingKe HuangYou Regular.ttf"
    ]
  },
  {
    id: "songti-sc",
    label: "系统宋体",
    family: "Songti SC",
    style: "宋体 / 稳重美妆",
    license: "macOS 系统字体，随本机系统授权使用",
    license_url: "https://www.apple.com/legal/sla/",
    candidate_paths: ["/System/Library/Fonts/Supplemental/Songti.ttc"]
  }
];

export const DEFAULT_PREVIEW_TEXT = "早上赶时间出门，这块气垫上脸服帖自然，气色一下就干净了。";
