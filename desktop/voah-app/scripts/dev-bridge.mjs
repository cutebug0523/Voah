#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StoreService } from "../electron/services/storeService.js";
import { ProductionRecipe } from "../electron/services/productionRecipe.js";
import { ModelKeyService } from "../electron/services/modelKeyService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const appDataDir = path.join(os.homedir(), "Library", "Application Support", "Voah Chrome Dev");
const port = Number(process.env.VOAH_DEV_BRIDGE_PORT || 5174);

const storeService = new StoreService({ appDataDir, workspaceRoot });
const modelKeyService = new ModelKeyService({
  appDataDir,
  envPaths: [
    path.join(workspaceRoot, ".env"),
    path.join(os.homedir(), ".voah", "video_intake", ".env")
  ]
});
const productionRecipe = new ProductionRecipe({ storeService, modelKeyService });

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function getState() {
  const data = await storeService.read();
  const modelKeys = await modelKeyService.getPublicConfig();
  return {
    ...data,
    model_keys: modelKeys,
    paths: storeService.getPaths()
  };
}

async function handleRoute(method, pathname, body) {
  if (method === "GET" && pathname === "/state") {
    return getState();
  }
  if (method === "POST" && pathname === "/createBatch") {
    const tasks = await productionRecipe.createBatch(body);
    return { schema_version: "voah-create-batch-response.v1", tasks };
  }
  if (method === "POST" && pathname === "/saveProduct") {
    const next = await storeService.mutate(async (draft) => {
      const product = body.product || {};
      const productId = product.id || `product_${Date.now()}`;
      const existingIndex = draft.products.findIndex((item) => item.id === productId);
      const saved = {
        ...(existingIndex >= 0 ? draft.products[existingIndex] : {}),
        ...product,
        id: productId,
        updated_at: new Date().toISOString()
      };
      saved.status = saved.latest_intake_run ? "ready" : saved.status || "needs_intake";
      saved.material_status = saved.status === "ready" ? "可生产" : saved.material_status || "需处理素材";
      if (existingIndex >= 0) {
        draft.products[existingIndex] = saved;
      } else {
        draft.products.push(saved);
      }
      return draft;
    });
    return {
      schema_version: "voah-save-product-response.v1",
      product: next.products.find((item) => item.id === (body.product?.id || "")) || next.products.at(-1)
    };
  }
  if (method === "POST" && pathname === "/startIntakeJob") {
    return productionRecipe.startIntakeJob(body);
  }
  if (method === "POST" && pathname === "/runTask") {
    return productionRecipe.runTask(body.task_id, { failStage: body.fail_stage || null });
  }
  if (method === "POST" && pathname === "/retryTask") {
    return productionRecipe.retryFailedTask(body.task_id);
  }
  if (method === "POST" && pathname === "/previewTts") {
    return productionRecipe.previewTts(body);
  }
  if (method === "POST" && pathname === "/reviewOutput") {
    const next = await storeService.mutate(async (draft) => {
      const task = draft.tasks.find((item) => item.id === body.task_id);
      if (!task) {
        throw new Error("未找到任务");
      }
      const review = {
        id: `review_${Date.now()}`,
        task_id: task.id,
        decision: body.decision || "manual_review",
        note: body.note || "",
        created_at: new Date().toISOString()
      };
      draft.output_reviews = [review, ...(draft.output_reviews || [])];
      if (review.decision === "approved") {
        task.status = "completed";
      }
      if (review.decision === "rejected") {
        task.status = "failed";
        task.human_error = {
          task: task.title,
          failed_step: "人工审核",
          reason: review.note || "成品未通过人工审核",
          impact: "该成品不会进入发布队列。",
          suggested_action: "重试失败步骤"
        };
      }
      if (review.decision === "manual_review") {
        task.status = "awaiting_review";
      }
      task.updated_at = new Date().toISOString();
      return draft;
    });
    return { schema_version: "voah-output-review-response.v1", reviews: next.output_reviews };
  }
  if (method === "POST" && pathname === "/saveSettings") {
    const next = await storeService.mutate(async (draft) => {
      draft.settings = {
        ...(draft.settings || {}),
        ...(body.settings || {})
      };
      if (body.settings?.copy) {
        draft.settings.copy = {
          ...(draft.settings.copy || {}),
          ...body.settings.copy
        };
      }
      if (body.settings?.tts) {
        draft.settings.tts = {
          ...(draft.settings.tts || {}),
          ...body.settings.tts,
          voice_modify: {
            ...(draft.settings.tts?.voice_modify || {}),
            ...(body.settings.tts.voice_modify || {})
          }
        };
      }
      if (body.settings?.subtitle) {
        draft.settings.subtitle = {
          ...(draft.settings.subtitle || {}),
          ...body.settings.subtitle
        };
      }
      return draft;
    });
    return { schema_version: "voah-save-settings-response.v1", settings: next.settings };
  }
  if (method === "POST" && pathname === "/saveModelKey") {
    return modelKeyService.saveModuleKey(body.module_id, body.key);
  }
  if (method === "POST" && pathname === "/deleteModelKey") {
    return modelKeyService.deleteModuleKey(body.module_id);
  }
  if (method === "POST" && pathname === "/validateModelKeys") {
    return modelKeyService.validateRequiredKeys(body.module_ids || []);
  }
  if (method === "POST" && pathname === "/revealPath") {
    return { ok: true, path: body.path || "" };
  }
  return null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const routePath = url.pathname.replace(/^\/api\/voah/, "") || "/";
    const body = request.method === "POST" ? await readBody(request) : {};
    const result = await handleRoute(request.method || "GET", routePath, body);
    if (result === null) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: "bridge_error",
      message: error.message || String(error)
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Voah dev bridge listening on http://127.0.0.1:${port}/api/voah`);
  console.log(`workspaceRoot=${workspaceRoot}`);
});
