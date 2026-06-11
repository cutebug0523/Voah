export const MODEL_MODULES = [
  {
    id: "material_understanding",
    module: "素材理解",
    model: "qwen3.5-omni-plus",
    providerId: "dashscope",
    providerName: "通义千问",
    configKey: "dashscope.api_key",
    envKey: "DASHSCOPE_API_KEY",
    runtimeEnv: {
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VOAH_MATERIAL_UNDERSTANDING_MODEL: "qwen3.5-omni-plus"
    }
  },
  {
    id: "material_vectorization",
    module: "素材向量化",
    model: "qwen3-vl-embedding",
    providerId: "dashscope",
    providerName: "通义千问",
    configKey: "dashscope.api_key",
    envKey: "DASHSCOPE_API_KEY",
    runtimeEnv: {
      DASHSCOPE_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com",
      VOAH_MATERIAL_EMBEDDING_MODEL: "qwen3-vl-embedding"
    }
  },
  {
    id: "material_retrieval",
    module: "素材召回",
    model: "qwen3-vl-embedding",
    providerId: "dashscope",
    providerName: "通义千问",
    configKey: "dashscope.api_key",
    envKey: "DASHSCOPE_API_KEY",
    runtimeEnv: {
      DASHSCOPE_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com",
      VOAH_MATERIAL_RETRIEVAL_MODEL: "qwen3-vl-embedding"
    }
  },
  {
    id: "copy_generation",
    module: "文案生成",
    model: "deepseek-v4-pro",
    providerId: "deepseek",
    providerName: "DeepSeek",
    configKey: "deepseek.api_key",
    envKey: "DEEPSEEK_API_KEY",
    runtimeEnv: {
      VOAH_TEXT_LLM_BASE_URL: "https://api.deepseek.com",
      VOAH_COPY_LLM_PROVIDER: "deepseek",
      VOAH_COPY_LLM_MODEL: "deepseek-v4-pro",
      VOAH_COPY_LLM_ENDPOINT: "/chat/completions"
    }
  },
  {
    id: "product_context_refinement",
    module: "卖点提炼",
    model: "deepseek-v4-pro",
    providerId: "deepseek",
    providerName: "DeepSeek",
    configKey: "deepseek.api_key",
    envKey: "DEEPSEEK_API_KEY",
    runtimeEnv: {
      VOAH_TEXT_LLM_BASE_URL: "https://api.deepseek.com",
      VOAH_PRODUCT_CONTEXT_LLM_PROVIDER: "deepseek",
      VOAH_PRODUCT_CONTEXT_LLM_MODEL: "deepseek-v4-pro",
      VOAH_PRODUCT_CONTEXT_LLM_ENDPOINT: "/chat/completions"
    }
  },
  {
    id: "selection_planner",
    module: "选片计划",
    model: "MiniMax-M3",
    providerId: "minimax",
    providerName: "MiniMax",
    configKey: "minimax.api_key",
    envKey: "MINIMAX_API_KEY",
    runtimeEnv: {
      MINIMAX_LLM_BASE_URL: "https://api.minimaxi.com/v1",
      VOAH_SELECTION_LLM_PROVIDER: "minimax-official",
      VOAH_SELECTION_LLM_MODEL: "MiniMax-M3",
      VOAH_SELECTION_LLM_ENDPOINT: "/text/chatcompletion_v2"
    }
  },
  {
    id: "tts_primary",
    module: "TTS",
    model: "speech-2.8-hd",
    providerId: "minimax",
    providerName: "MiniMax",
    configKey: "minimax.api_key",
    envKey: "MINIMAX_API_KEY",
    runtimeEnv: {
      MINIMAX_BASE_URL: "https://api.minimaxi.com",
      VOAH_TTS_PROVIDER: "minimax-official",
      VOAH_TTS_MODEL: "speech-2.8-hd"
    }
  },
  {
    id: "tts_fallback",
    module: "TTS备用",
    model: "speech-2.8-hd",
    providerId: "vectorengine",
    providerName: "VectorEngine",
    configKey: "vectorengine.api_key",
    envKey: "VECTORENGINE_API_KEY",
    runtimeEnv: {
      VECTORENGINE_BASE_URL: "https://api.vectorengine.ai",
      VOAH_TTS_FALLBACK_PROVIDER: "vectorengine-minimax",
      VOAH_TTS_FALLBACK_MODEL: "speech-2.8-hd"
    }
  }
];

export const MODEL_PROVIDERS = [
  {
    id: "dashscope",
    name: "通义千问",
    configKey: "dashscope.api_key",
    envKey: "DASHSCOPE_API_KEY",
    visible: true
  },
  {
    id: "minimax",
    name: "MiniMax",
    configKey: "minimax.api_key",
    envKey: "MINIMAX_API_KEY",
    visible: true
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    configKey: "deepseek.api_key",
    envKey: "DEEPSEEK_API_KEY",
    visible: true
  },
  {
    id: "vectorengine",
    name: "VectorEngine",
    configKey: "vectorengine.api_key",
    envKey: "VECTORENGINE_API_KEY",
    visible: false
  }
];

export function moduleById(id) {
  return MODEL_MODULES.find((item) => item.id === id) || null;
}

export function runtimeEnvForModuleIds(moduleIds) {
  const ids = new Set(moduleIds);
  return MODEL_MODULES.filter((item) => ids.has(item.id)).reduce((env, item) => ({ ...env, ...(item.runtimeEnv || {}) }), {});
}

export function envKeysForModuleIds(moduleIds) {
  const ids = new Set(moduleIds);
  return [...new Set(MODEL_MODULES.filter((item) => ids.has(item.id)).map((item) => item.envKey))];
}

export function visibleModelProviders() {
  return MODEL_PROVIDERS.filter((item) => item.visible);
}
