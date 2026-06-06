export const MODEL_MODULE_IDS = {
  MATERIAL_UNDERSTANDING: "material_understanding",
  MATERIAL_VECTORIZATION: "material_vectorization",
  MATERIAL_RETRIEVAL: "material_retrieval",
  COPY_GENERATION: "copy_generation",
  SELECTION_PLANNER: "selection_planner",
  TTS_PRIMARY: "tts_primary",
  TTS_FALLBACK: "tts_fallback"
};

export const MODEL_MODULES = [
  {
    id: MODEL_MODULE_IDS.MATERIAL_UNDERSTANDING,
    module: "素材理解",
    model: "qwen3.5-omni-plus",
    envKey: "DASHSCOPE_API_KEY",
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpoint: "/chat/completions",
    runtimeEnv: {
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VOAH_MATERIAL_UNDERSTANDING_MODEL: "qwen3.5-omni-plus"
    },
    defaultParams: {
      modalities: ["text"],
      stream: true
    }
  },
  {
    id: MODEL_MODULE_IDS.MATERIAL_VECTORIZATION,
    module: "素材向量化",
    model: "qwen3-vl-embedding",
    envKey: "DASHSCOPE_API_KEY",
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com",
    endpoint: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    runtimeEnv: {
      DASHSCOPE_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com",
      VOAH_MATERIAL_EMBEDDING_MODEL: "qwen3-vl-embedding"
    },
    defaultParams: {
      enable_fusion: false
    }
  },
  {
    id: MODEL_MODULE_IDS.MATERIAL_RETRIEVAL,
    module: "素材召回",
    model: "qwen3-vl-embedding",
    envKey: "DASHSCOPE_API_KEY",
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com",
    endpoint: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    runtimeEnv: {
      DASHSCOPE_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com",
      VOAH_MATERIAL_RETRIEVAL_MODEL: "qwen3-vl-embedding"
    },
    defaultParams: {
      enable_fusion: true
    }
  },
  {
    id: MODEL_MODULE_IDS.COPY_GENERATION,
    module: "文案生成",
    model: "MiniMax-M3",
    envKey: "MINIMAX_API_KEY",
    provider: "minimax-official",
    baseUrl: "https://api.minimaxi.com/v1",
    endpoint: "/text/chatcompletion_v2",
    runtimeEnv: {
      VOAH_TEXT_LLM_BASE_URL: "https://api.minimaxi.com/v1",
      VOAH_COPY_LLM_PROVIDER: "minimax-official",
      VOAH_COPY_LLM_MODEL: "MiniMax-M3",
      VOAH_COPY_LLM_ENDPOINT: "/text/chatcompletion_v2"
    },
    defaultParams: {
      temperature: 0.4
    }
  },
  {
    id: MODEL_MODULE_IDS.SELECTION_PLANNER,
    module: "选片计划",
    model: "MiniMax-M3",
    envKey: "MINIMAX_API_KEY",
    provider: "minimax-official",
    baseUrl: "https://api.minimaxi.com/v1",
    endpoint: "/text/chatcompletion_v2",
    runtimeEnv: {
      MINIMAX_LLM_BASE_URL: "https://api.minimaxi.com/v1",
      VOAH_SELECTION_LLM_PROVIDER: "minimax-official",
      VOAH_SELECTION_LLM_MODEL: "MiniMax-M3",
      VOAH_SELECTION_LLM_ENDPOINT: "/text/chatcompletion_v2"
    },
    defaultParams: {
      temperature: 0.25,
      max_tokens: 1200,
      thinking: {
        type: "disabled"
      }
    }
  },
  {
    id: MODEL_MODULE_IDS.TTS_PRIMARY,
    module: "TTS",
    model: "speech-2.8-hd",
    envKey: "MINIMAX_API_KEY",
    provider: "minimax-official",
    baseUrl: "https://api.minimaxi.com",
    endpoint: "/v1/t2a_v2",
    runtimeEnv: {
      MINIMAX_BASE_URL: "https://api.minimaxi.com",
      VOAH_TTS_PROVIDER: "minimax-official",
      VOAH_TTS_MODEL: "speech-2.8-hd"
    },
    defaultParams: {
      speed: 1.1,
      emotion: "happy",
      voice_modify: {
        pitch: 20,
        intensity: 20,
        timbre: 0
      }
    }
  },
  {
    id: MODEL_MODULE_IDS.TTS_FALLBACK,
    module: "TTS备用",
    model: "speech-2.8-hd",
    envKey: "VECTORENGINE_API_KEY",
    provider: "vectorengine-minimax",
    baseUrl: "https://api.vectorengine.ai",
    endpoint: "/minimax/v1/t2a_v2",
    runtimeEnv: {
      VECTORENGINE_BASE_URL: "https://api.vectorengine.ai",
      VOAH_TTS_FALLBACK_PROVIDER: "vectorengine-minimax",
      VOAH_TTS_FALLBACK_MODEL: "speech-2.8-hd"
    },
    defaultParams: {
      speed: 1.1,
      emotion: "happy"
    }
  }
];

export function publicModelModules() {
  return MODEL_MODULES.map(({ id, module, model }) => ({ id, module, model }));
}

export function getModelModule(moduleId) {
  return MODEL_MODULES.find((item) => item.id === moduleId) || null;
}

export function envKeysForModuleIds(moduleIds) {
  const ids = new Set(moduleIds);
  return [...new Set(MODEL_MODULES.filter((item) => ids.has(item.id)).map((item) => item.envKey))];
}

export function runtimeEnvForModuleIds(moduleIds) {
  const ids = new Set(moduleIds);
  return MODEL_MODULES.filter((item) => ids.has(item.id)).reduce(
    (env, item) => ({
      ...env,
      ...(item.runtimeEnv || {})
    }),
    {}
  );
}
