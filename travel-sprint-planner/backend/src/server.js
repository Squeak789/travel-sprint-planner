import express from "express";
import cors from "cors";
import { optimizeStrategy } from "./optimizer.js";

const app = express();
const port = Number(process.env.PORT || 3001);

const seedCityData = {
  北京: [
    { name: "故宫", score: 10, stay: 180, x: 52, y: 52, open: [8, 17] },
    { name: "天坛", score: 8, stay: 120, x: 49, y: 60, open: [8, 18] },
    { name: "颐和园", score: 9, stay: 180, x: 36, y: 38, open: [7, 18] },
    { name: "八达岭长城", score: 10, stay: 210, x: 12, y: 12, open: [7, 18] },
    { name: "什刹海", score: 7, stay: 90, x: 54, y: 46, open: [0, 24] },
    { name: "国家博物馆", score: 8, stay: 150, x: 53, y: 54, open: [9, 17] },
    { name: "鸟巢", score: 7, stay: 90, x: 63, y: 40, open: [10, 22] },
    { name: "南锣鼓巷", score: 6, stay: 80, x: 56, y: 48, open: [0, 24] }
  ],
  上海: [
    { name: "外滩", score: 9, stay: 90, x: 50, y: 48, open: [0, 24] },
    { name: "东方明珠", score: 9, stay: 120, x: 54, y: 45, open: [9, 21] },
    { name: "豫园", score: 7, stay: 90, x: 48, y: 50, open: [9, 17] },
    { name: "上海博物馆", score: 8, stay: 140, x: 43, y: 52, open: [9, 17] },
    { name: "武康路", score: 7, stay: 80, x: 40, y: 58, open: [0, 24] },
    { name: "迪士尼", score: 10, stay: 300, x: 80, y: 44, open: [8, 22] },
    { name: "田子坊", score: 7, stay: 90, x: 45, y: 56, open: [10, 21] },
    { name: "南京路步行街", score: 8, stay: 100, x: 51, y: 47, open: [0, 24] }
  ],
  成都: [
    { name: "宽窄巷子", score: 7, stay: 90, x: 45, y: 50, open: [0, 24] },
    { name: "锦里", score: 8, stay: 100, x: 42, y: 57, open: [9, 22] },
    { name: "武侯祠", score: 8, stay: 110, x: 41, y: 58, open: [8, 18] },
    { name: "都江堰", score: 9, stay: 190, x: 8, y: 20, open: [8, 18] },
    { name: "熊猫基地", score: 10, stay: 180, x: 68, y: 26, open: [7, 18] },
    { name: "春熙路", score: 7, stay: 90, x: 50, y: 52, open: [0, 24] },
    { name: "杜甫草堂", score: 8, stay: 110, x: 36, y: 53, open: [8, 18] },
    { name: "人民公园", score: 6, stay: 70, x: 44, y: 52, open: [6, 22] }
  ]
};

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonArray(content) {
  const direct = safeJsonParse(content);
  if (Array.isArray(direct)) {
    return direct;
  }

  const codeBlockMatch = content.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const parsed = safeJsonParse(codeBlockMatch[1]);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  const bracketMatch = content.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    const parsed = safeJsonParse(bracketMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  return [];
}

function getUniqueSpotNames(basePlan) {
  const set = new Set();
  for (const day of basePlan || []) {
    for (const slot of day.slots || []) {
      const name = slot?.spot?.name;
      if (name) {
        set.add(name);
      }
    }
  }
  return [...set];
}

async function fetchAiGuideSignals({ city, spotNames, aiConfig }) {
  if (!aiConfig?.endpoint || !aiConfig?.model || !aiConfig?.apiKey || !spotNames?.length) {
    return [];
  }

  const prompt = [
    `城市：${city}`,
    `景点候选：${spotNames.join("、")}`,
    "请联网综合热门攻略和游客反馈，输出 JSON 数组。",
    "格式必须为: [{\"name\":\"景点名\",\"popularity\":0.0-1.0,\"note\":\"一句理由\"}]",
    "只返回 JSON，不要解释。"
  ].join("\n");

  const response = await fetch(aiConfig.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: "system",
          content: "你是旅行情报分析助手，擅长将热门攻略信息量化为可计算信号。"
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      extra_body: { enable_search: true }
    })
  });

  if (!response.ok) {
    throw new Error(`AI upstream HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const arr = extractJsonArray(content);
  return arr
    .map((item) => ({
      name: String(item?.name || "").trim(),
      popularity: Math.max(0, Math.min(1, Number(item?.popularity ?? 0.6))),
      note: String(item?.note || "")
    }))
    .filter((x) => x.name);
}

function mergeSignals(baseSignals, aiSignals) {
  const map = new Map();
  for (const signal of baseSignals || []) {
    map.set(signal.name, { ...signal });
  }
  for (const signal of aiSignals || []) {
    map.set(signal.name, { ...map.get(signal.name), ...signal });
  }
  return [...map.values()];
}

function extractJsonObject(content) {
  const direct = safeJsonParse(content);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }

  const codeBlockMatch = content.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const parsed = safeJsonParse(codeBlockMatch[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  const braceMatch = content.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const parsed = safeJsonParse(braceMatch[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeSpotList(spots) {
  return (spots || [])
    .map((spot, index) => ({
      name: String(spot?.name || "").trim(),
      score: Math.max(1, Math.min(10, Number(spot?.score ?? 6))),
      stay: Math.max(45, Number(spot?.stay ?? 90)),
      open: Array.isArray(spot?.open) && spot.open.length === 2 ? spot.open : [8, 18],
      x: Number.isFinite(Number(spot?.x)) ? Number(spot.x) : 50 + index,
      y: Number.isFinite(Number(spot?.y)) ? Number(spot.y) : 50 + index,
      reason: String(spot?.reason || ""),
      source: String(spot?.source || "ai")
    }))
    .filter((spot) => spot.name);
}

async function recommendHotspotsFromAi({ city, count, aiConfig, candidates }) {
  if (!aiConfig?.endpoint || !aiConfig?.model || !aiConfig?.apiKey) {
    return null;
  }

  const candidateText = (candidates || []).map((spot) => `${spot.name}(评分${spot.score})`).join("、");
  const prompt = candidates?.length
    ? [
        `城市：${city}`,
        `候选景点：${candidateText}`,
        `请从候选景点中挑选最适合特种兵旅游的 ${count} 个必打卡景点，并按优先级输出。`,
        "输出格式：{\"mustSpots\":[\"景点1\",\"景点2\"],\"spots\":[{\"name\":\"景点名\",\"score\":1-10,\"stay\":分钟,\"open\":[8,18],\"reason\":\"一句理由\"}]}",
        "只返回 JSON，不要解释。"
      ].join("\n")
    : [
        `城市：${city}`,
        `请生成最适合特种兵旅游的 ${count} 个热门景点，要求覆盖城市最有代表性的打卡点。`,
        "输出格式：{\"mustSpots\":[\"景点1\",\"景点2\"],\"spots\":[{\"name\":\"景点名\",\"score\":1-10,\"stay\":分钟,\"open\":[8,18],\"reason\":\"一句理由\"}]}",
        "只返回 JSON，不要解释。"
      ].join("\n");

  const response = await fetch(aiConfig.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        {
          role: "system",
          content: "你是资深旅行攻略编辑与景点筛选器，只输出严格 JSON。"
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      extra_body: { enable_search: true }
    })
  });

  if (!response.ok) {
    throw new Error(`AI upstream HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return null;
  }

  return {
    mustSpots: Array.isArray(parsed.mustSpots) ? parsed.mustSpots.map((item) => String(item).trim()).filter(Boolean) : [],
    spots: normalizeSpotList(parsed.spots || [])
  };
}

app.post("/api/city-hotspots", async (req, res) => {
  try {
    const city = String(req.body?.city || "").trim();
    const count = Math.max(4, Math.min(12, Number(req.body?.count || 8)));
    const aiConfig = req.body?.aiConfig || {};

    if (!city) {
      return res.status(400).json({ ok: false, message: "city is required" });
    }

    const seed = seedCityData[city];
    if (seed) {
      const seedSpots = seed.slice(0, count).map((spot) => ({ ...spot, source: "seed" }));
      let aiResult = null;
      let warning = "";
      try {
        aiResult = await recommendHotspotsFromAi({
          city,
          count,
          aiConfig,
          candidates: seedSpots
        });
      } catch (error) {
        warning = error.message || "ai hotspot selection failed";
      }

      const mustSpots = aiResult?.mustSpots?.length
        ? aiResult.mustSpots
        : seedSpots.slice(0, Math.min(4, seedSpots.length)).map((spot) => spot.name);
      const spots = aiResult?.spots?.length
        ? aiResult.spots.slice(0, count)
        : seedSpots;

      return res.json({
        ok: true,
        result: {
          city,
          source: aiResult?.spots?.length ? "ai-seeded" : "seed",
          spots,
          mustSpots,
          summary: aiResult?.spots?.length ? "AI 已基于城市种子库筛选热门景点" : "使用本地城市种子库"
        },
        ai: {
          warning,
          generated: Boolean(aiResult?.spots?.length)
        }
      });
    }

    if (!aiConfig?.endpoint || !aiConfig?.model || !aiConfig?.apiKey) {
      return res.status(400).json({
        ok: false,
        message: "未知城市需要填写 AI 接口配置，以便生成热门景点包"
      });
    }

    const aiResult = await recommendHotspotsFromAi({ city, count, aiConfig });
    if (!aiResult?.spots?.length) {
      return res.status(500).json({ ok: false, message: "AI 未返回有效景点数据" });
    }

    const mustSpots = aiResult.mustSpots?.length ? aiResult.mustSpots : aiResult.spots.slice(0, Math.min(4, aiResult.spots.length)).map((spot) => spot.name);
    res.json({
      ok: true,
      result: {
        city,
        source: "ai-generated",
        spots: aiResult.spots.slice(0, count),
        mustSpots,
        summary: "AI 根据城市生成热门景点包"
      },
      ai: {
        warning: ""
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "city hotspot recommendation failed" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "travel-strategy-optimizer", time: new Date().toISOString() });
});

app.post("/api/optimize-strategy", async (req, res) => {
  try {
    const payload = req.body || {};
    const spotNames = getUniqueSpotNames(payload.basePlan);

    let aiSignals = [];
    let aiWarning = "";
    try {
      aiSignals = await fetchAiGuideSignals({
        city: payload.city,
        spotNames,
        aiConfig: payload.aiConfig
      });
    } catch (error) {
      aiWarning = error.message || "ai guide signal failed";
    }

    const mergedSignals = mergeSignals(payload.guideSignals || [], aiSignals);
    const result = optimizeStrategy({
      ...payload,
      guideSignals: mergedSignals
    });

    res.json({
      ok: true,
      result,
      ai: {
        signalCount: aiSignals.length,
        warning: aiWarning
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "optimizer failed" });
  }
});

app.listen(port, () => {
  console.log(`optimizer api running at http://localhost:${port}`);
});
