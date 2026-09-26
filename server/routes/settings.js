import { Router } from "express";
import { auth, requireAdmin, wrap } from "../mw.js";
import { getSetting, setSetting } from "../db.js";
import { aiConfig, baiduOcrConfig } from "../lib/ai.js";

const r = Router();
r.use(auth);

const KEY = "ai_models";

// 读取已配置的模型列表（兼容旧版单配置 ai_config，首次访问自动转为一个模型）
function readModels() {
  const raw = getSetting(KEY, "");
  if (!raw) {
    const legacy = getSetting("ai_config", "");
    if (legacy) {
      try {
        const c = JSON.parse(legacy);
        const arr = [
          {
            id: "m_legacy",
            name: "默认模型",
            provider: c.provider || "",
            baseUrl: c.baseUrl || "",
            apiKey: c.apiKey || "",
            model: c.model || "",
            imageModel: c.imageModel || "",
            isDefault: true,
          },
        ];
        setSetting(KEY, JSON.stringify(arr));
        return arr;
      } catch {}
    }
    return [];
  }
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}
function writeModels(arr) {
  setSetting(KEY, JSON.stringify(arr));
}

// 读取所有 AI 模型（apiKey 脱敏，避免明文暴露）
r.get("/ai", (req, res) => {
  const models = readModels();
  const live = aiConfig();
  res.json({
    models: models.map((m) => ({
      ...m,
      apiKey: m.apiKey ? "******" : "",
    })),
    enabled: live.enabled,
  });
});

// 保存模型列表（整体替换）。每个模型可单独填 API Key；
// 回填占位符「******」表示沿用原值，不修改。
r.put(
  "/ai",
  requireAdmin,
  wrap((req, res) => {
    const input = Array.isArray(req.body?.models) ? req.body.models : [];
    if (!input.length) return res.status(400).json({ error: "至少要添加一个模型" });

    const cur = readModels();
    const curById = Object.fromEntries(cur.map((m) => [m.id, m]));

    const out = input.map((m, i) => {
      const id = m.id || `m_${Date.now()}_${i}`;
      let apiKey = (m.apiKey || "").trim();
      if (apiKey === "******") apiKey = curById[id]?.apiKey || "";
      return {
        id,
        name: (m.name || "").trim() || "未命名模型",
        provider: (m.provider || "").trim(),
        baseUrl: (m.baseUrl || "").trim().replace(/\/$/, ""),
        apiKey,
        model: (m.model || "").trim(),
        imageModel: (m.imageModel || "").trim(),
        isDefault: !!m.isDefault || i === 0,
      };
    });
    // 保证只有一个默认模型
    if (!out.some((m) => m.isDefault)) out[0].isDefault = true;

    writeModels(out);
    res.json({ ok: true });
  })
);

// ---------- 百度 OCR（图片识别，无需大模型） ----------
const BAIDU_KEY = "baidu_ocr";
function readBaiduOcr() {
  try {
    return JSON.parse(getSetting(BAIDU_KEY, "")) || {};
  } catch {
    return {};
  }
}
// 读取百度 OCR 配置（密钥脱敏，避免明文暴露）
r.get("/baidu-ocr", (req, res) => {
  const saved = readBaiduOcr();
  const live = baiduOcrConfig();
  res.json({
    enabled: live.enabled,
    apiKey: saved.apiKey ? "******" : "",
    hasSecret: !!saved.secretKey,
  });
});
// 保存百度 OCR 密钥。「******」占位符表示沿用原值不修改。
r.put(
  "/baidu-ocr",
  requireAdmin,
  wrap((req, res) => {
    let apiKey = (req.body?.apiKey || "").trim();
    let secretKey = (req.body?.secretKey || "").trim();
    const saved = readBaiduOcr();
    if (apiKey === "******") apiKey = saved.apiKey || "";
    if (secretKey === "******") secretKey = saved.secretKey || "";
    if (!apiKey || !secretKey) {
      return res.status(400).json({ error: "请填写百度智能云的 API Key 和 Secret Key" });
    }
    setSetting(BAIDU_KEY, JSON.stringify({ apiKey, secretKey }));
    res.json({ ok: true });
  })
);

export default r;
