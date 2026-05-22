const mapCache = {
  geo: new Map(),
  transit: new Map(),
  cityKit: new Map()
};

const intensityConfig = {
  balanced: { fatigueBuffer: 70, scoreBoost: 1 },
  hardcore: { fatigueBuffer: 45, scoreBoost: 1.1 },
  extreme: { fatigueBuffer: 25, scoreBoost: 1.2 }
};

const cityInput = document.querySelector("#cityInput");
const startDateInput = document.querySelector("#startDate");
const daysInput = document.querySelector("#days");
const startHourInput = document.querySelector("#startHour");
const endHourInput = document.querySelector("#endHour");
const intensitySelect = document.querySelector("#intensity");
const originInput = document.querySelector("#originInput");
const mapProviderSelect = document.querySelector("#mapProvider");
const mapApiKeyInput = document.querySelector("#mapApiKey");
const transportModeSelect = document.querySelector("#transportMode");
const mustContainer = document.querySelector("#mustContainer");
const planBtn = document.querySelector("#planBtn");
const loadCityBtn = document.querySelector("#loadCityBtn");
const routeResult = document.querySelector("#routeResult");
const summaryTag = document.querySelector("#summaryTag");
const aiEnabledInput = document.querySelector("#aiEnabled");
const optimizerApiInput = document.querySelector("#optimizerApi");
const aiEndpointInput = document.querySelector("#aiEndpoint");
const aiModelInput = document.querySelector("#aiModel");
const aiApiKeyInput = document.querySelector("#aiApiKey");
const aiResult = document.querySelector("#aiResult");

const state = {
  activeCityKit: null,
  loadingCityKit: false
};

function formatDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function minutesFromTimeString(v) {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}

function timeString(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMapConfig() {
  return {
    provider: mapProviderSelect.value,
    key: mapApiKeyInput.value.trim(),
    mode: transportModeSelect.value,
    originName: originInput.value.trim() || "市中心"
  };
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

function renderMustSpots(spots, mustNames = []) {
  mustContainer.innerHTML = "";
  const mustSet = new Set(mustNames);

  spots.forEach((spot, index) => {
    const row = document.createElement("label");
    row.className = "must-item";
    const checked = mustSet.size ? mustSet.has(spot.name) : index < Math.min(4, spots.length);
    row.innerHTML = `<input type="checkbox" value="${index}" ${checked ? "checked" : ""} /> ${escapeHtml(spot.name)}`;
    mustContainer.appendChild(row);
  });
}

function getCheckedMustSet(spots) {
  const selectedMust = Array.from(mustContainer.querySelectorAll("input:checked")).map((el) => Number(el.value));
  return new Set(selectedMust.map((index) => spots[index]?.name).filter(Boolean));
}

function cityKitCacheKey(city, aiConfig) {
  return [
    city,
    aiConfig?.endpoint || "",
    aiConfig?.model || "",
    aiConfig?.apiKey ? "1" : "0"
  ].join("|");
}

async function fetchCityKit(force = false) {
  const city = cityInput.value.trim();
  if (!city) {
    alert("请先输入城市名称。");
    return null;
  }

  const aiConfig = {
    endpoint: aiEndpointInput.value.trim(),
    model: aiModelInput.value.trim(),
    apiKey: aiApiKeyInput.value.trim()
  };

  const cacheKey = cityKitCacheKey(city, aiConfig);
  if (!force && mapCache.cityKit.has(cacheKey)) {
    const cached = mapCache.cityKit.get(cacheKey);
    state.activeCityKit = cached;
    renderMustSpots(cached.spots, cached.mustSpots);
    return cached;
  }

  state.loadingCityKit = true;
  loadCityBtn.disabled = true;
  loadCityBtn.textContent = "AI 获取中...";

  try {
    const response = await fetch(`${optimizerApiInput.value.trim().replace(/\/$/, "")}/api/city-hotspots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city,
        count: 8,
        aiConfig
      })
    });

    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }

    const kit = {
      city,
      source: data.result.source,
      summary: data.result.summary,
      spots: normalizeSpotList(data.result.spots),
      mustSpots: Array.isArray(data.result.mustSpots) ? data.result.mustSpots.map((item) => String(item).trim()).filter(Boolean) : []
    };

    if (!kit.spots.length) {
      throw new Error("AI 未返回可用热门景点");
    }

    state.activeCityKit = kit;
    mapCache.cityKit.set(cacheKey, kit);
    renderMustSpots(kit.spots, kit.mustSpots);
    return kit;
  } catch (error) {
    alert(error.message || "获取城市热点失败");
    return null;
  } finally {
    state.loadingCityKit = false;
    loadCityBtn.disabled = false;
    loadCityBtn.textContent = "AI 获取热门景点";
  }
}

function calcTransitEstimated(a, b, mode) {
  const modeFactor = { walking: 4.1, driving: 2.1, transit: 2.8 };
  const ax = Number(a?.x ?? 50);
  const ay = Number(a?.y ?? 50);
  const bx = Number(b?.x ?? 50);
  const by = Number(b?.y ?? 50);
  const dx = ax - bx;
  const dy = ay - by;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return Math.max(12, Math.round(distance * (modeFactor[mode] || 2.8)));
}

async function geocodeKeyword(keyword, city, mapConfig) {
  if (!mapConfig.key) {
    return null;
  }

  const cacheKey = `${mapConfig.provider}|${city}|${keyword}`;
  if (mapCache.geo.has(cacheKey)) {
    return mapCache.geo.get(cacheKey);
  }

  try {
    if (mapConfig.provider === "amap") {
      const url = new URL("https://restapi.amap.com/v3/place/text");
      url.searchParams.set("key", mapConfig.key);
      url.searchParams.set("keywords", `${city}${keyword}`);
      url.searchParams.set("city", city);
      url.searchParams.set("offset", "1");
      url.searchParams.set("page", "1");

      const response = await fetch(url.toString());
      const data = await response.json();
      if (data.status === "1" && data.pois && data.pois.length > 0 && data.pois[0].location) {
        const [lng, lat] = data.pois[0].location.split(",").map(Number);
        const geo = { lng, lat };
        mapCache.geo.set(cacheKey, geo);
        return geo;
      }
      return null;
    }

    const url = new URL("https://api.map.baidu.com/place/v2/search");
    url.searchParams.set("ak", mapConfig.key);
    url.searchParams.set("query", keyword);
    url.searchParams.set("region", city);
    url.searchParams.set("output", "json");
    url.searchParams.set("page_size", "1");

    const response = await fetch(url.toString());
    const data = await response.json();
    if (data.status === 0 && data.results && data.results.length > 0 && data.results[0].location) {
      const geo = {
        lng: Number(data.results[0].location.lng),
        lat: Number(data.results[0].location.lat)
      };
      mapCache.geo.set(cacheKey, geo);
      return geo;
    }
    return null;
  } catch {
    return null;
  }
}

async function enrichSpotsWithCoords(spots, city, mapConfig) {
  const list = [];
  for (const spot of spots) {
    const geo = await geocodeKeyword(spot.name, city, mapConfig);
    list.push({ ...spot, geo });
  }
  return list;
}

function durationFromAmap(data, mode) {
  if (mode === "transit") {
    return Number(data?.route?.transits?.[0]?.duration || 0);
  }
  return Number(data?.route?.paths?.[0]?.duration || 0);
}

function durationFromBaidu(data, mode) {
  if (mode === "transit") {
    return Number(data?.result?.routes?.[0]?.duration || 0);
  }
  return Number(data?.result?.routes?.[0]?.duration || 0);
}

async function queryTransitDuration(fromPoint, toPoint, city, mapConfig) {
  if (!mapConfig.key || !fromPoint.geo || !toPoint.geo) {
    return { minutes: calcTransitEstimated(fromPoint, toPoint, mapConfig.mode), source: "estimated" };
  }

  const transitCacheKey = [
    mapConfig.provider,
    mapConfig.mode,
    fromPoint.geo.lng,
    fromPoint.geo.lat,
    toPoint.geo.lng,
    toPoint.geo.lat
  ].join("|");

  if (mapCache.transit.has(transitCacheKey)) {
    return mapCache.transit.get(transitCacheKey);
  }

  try {
    if (mapConfig.provider === "amap") {
      let url;
      const origin = `${fromPoint.geo.lng},${fromPoint.geo.lat}`;
      const destination = `${toPoint.geo.lng},${toPoint.geo.lat}`;

      if (mapConfig.mode === "driving") {
        url = new URL("https://restapi.amap.com/v3/direction/driving");
        url.searchParams.set("strategy", "0");
      } else if (mapConfig.mode === "walking") {
        url = new URL("https://restapi.amap.com/v3/direction/walking");
      } else {
        url = new URL("https://restapi.amap.com/v3/direction/transit/integrated");
        url.searchParams.set("city", city);
      }

      url.searchParams.set("key", mapConfig.key);
      url.searchParams.set("origin", origin);
      url.searchParams.set("destination", destination);

      const response = await fetch(url.toString());
      const data = await response.json();
      const durationSec = durationFromAmap(data, mapConfig.mode);
      if (durationSec > 0) {
        const value = { minutes: Math.max(8, Math.round(durationSec / 60)), source: "realtime" };
        mapCache.transit.set(transitCacheKey, value);
        return value;
      }
    } else {
      const origin = `${fromPoint.geo.lat},${fromPoint.geo.lng}`;
      const destination = `${toPoint.geo.lat},${toPoint.geo.lng}`;
      const modePath = mapConfig.mode === "driving" ? "driving" : mapConfig.mode === "walking" ? "walking" : "transit";
      const url = new URL(`https://api.map.baidu.com/directionlite/v1/${modePath}`);

      url.searchParams.set("ak", mapConfig.key);
      url.searchParams.set("origin", origin);
      url.searchParams.set("destination", destination);
      if (mapConfig.mode === "transit") {
        url.searchParams.set("region", city);
      }

      const response = await fetch(url.toString());
      const data = await response.json();
      const durationSec = durationFromBaidu(data, mapConfig.mode);
      if (durationSec > 0) {
        const value = { minutes: Math.max(8, Math.round(durationSec / 60)), source: "realtime" };
        mapCache.transit.set(transitCacheKey, value);
        return value;
      }
    }
  } catch {
    return { minutes: calcTransitEstimated(fromPoint, toPoint, mapConfig.mode), source: "estimated" };
  }

  return { minutes: calcTransitEstimated(fromPoint, toPoint, mapConfig.mode), source: "estimated" };
}

async function chooseNextSpot(candidates, currentPoint, currentMinute, config, mustSet, city, mapConfig) {
  let best = null;
  let bestUtility = -Infinity;

  const evaluated = await Promise.all(
    candidates.map(async (spot) => {
      const transitInfo = await queryTransitDuration(currentPoint, spot, city, mapConfig);
      return { spot, transitInfo };
    })
  );

  for (const item of evaluated) {
    const transit = item.transitInfo.minutes;
    const arriveMinute = currentMinute + transit;
    const openMinute = item.spot.open[0] * 60;
    const closeMinute = item.spot.open[1] * 60;
    const wait = Math.max(0, openMinute - arriveMinute);

    if (arriveMinute + wait + item.spot.stay > closeMinute) {
      continue;
    }

    const mustBonus = mustSet.has(item.spot.name) ? 130 : 0;
    const utility =
      (item.spot.score * config.scoreBoost * 120 + mustBonus) /
      Math.max(30, transit + wait + item.spot.stay * 0.72);

    if (utility > bestUtility) {
      bestUtility = utility;
      best = { spot: item.spot, transit, wait, source: item.transitInfo.source };
    }
  }

  return best;
}

async function buildPlan() {
  const city = cityInput.value.trim();
  const startDate = startDateInput.value || formatDate(0);
  const days = Math.min(14, Math.max(1, Number(daysInput.value) || 3));
  const dayStart = minutesFromTimeString(startHourInput.value);
  const dayEnd = minutesFromTimeString(endHourInput.value);
  const intensity = intensitySelect.value;
  const mapConfig = buildMapConfig();

  if (dayEnd - dayStart < 240) {
    alert("每天游玩时长至少 4 小时。");
    return null;
  }

  let kit = state.activeCityKit;
  if (!kit || kit.city !== city) {
    kit = await fetchCityKit(false);
  }

  if (!kit?.spots?.length) {
    return null;
  }

  const config = intensityConfig[intensity];
  const rawSpots = kit.spots.map((spot) => ({ ...spot }));
  const mustSet = getCheckedMustSet(rawSpots);

  const spots = await enrichSpotsWithCoords(rawSpots, city, mapConfig);
  const originGeo = await geocodeKeyword(mapConfig.originName, city, mapConfig);
  const plans = [];
  const remaining = [...spots];
  let doneCount = 0;
  let totalTransit = 0;
  let realtimeTransitCount = 0;

  for (let d = 0; d < days; d += 1) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateLabel = `${date.getMonth() + 1}/${date.getDate()}`;

    let current = dayStart;
    let currentPoint = {
      name: mapConfig.originName,
      geo: originGeo,
      x: 50,
      y: 50
    };
    const slots = [];

    while (remaining.length > 0) {
      const candidate = await chooseNextSpot(remaining, currentPoint, current, config, mustSet, city, mapConfig);
      if (!candidate) {
        break;
      }

      const startVisit = current + candidate.transit + candidate.wait;
      const endVisit = startVisit + candidate.spot.stay;

      if (endVisit > dayEnd - config.fatigueBuffer) {
        break;
      }

      slots.push({
        spot: candidate.spot,
        startVisit,
        endVisit,
        transit: candidate.transit,
        wait: candidate.wait,
        source: candidate.source
      });

      totalTransit += candidate.transit;
      if (candidate.source === "realtime") {
        realtimeTransitCount += 1;
      }
      current = endVisit;
      currentPoint = candidate.spot;
      doneCount += 1;

      const idx = remaining.findIndex((s) => s.name === candidate.spot.name);
      remaining.splice(idx, 1);
    }

    plans.push({ dayIndex: d + 1, dateLabel, slots });
    if (remaining.length === 0) {
      break;
    }
  }

  return {
    city,
    kit,
    plans,
    mustSet,
    doneCount,
    totalCount: rawSpots.length,
    totalTransit,
    realtimeTransitCount,
    mapConfig,
    geocodedCount: spots.filter((s) => !!s.geo).length,
    missedMust: [...mustSet].filter((name) => remaining.some((s) => s.name === name))
  };
}

function renderPlan(result) {
  if (!result) {
    return;
  }

  const { city, kit, plans, mustSet, doneCount, totalCount, totalTransit, missedMust, realtimeTransitCount, geocodedCount, mapConfig } = result;
  const density = (doneCount / Math.max(1, plans.length)).toFixed(1);
  const pathState = mapConfig.key ? `${mapConfig.provider} 实时段数 ${realtimeTransitCount}` : "未启用地图 Key";
  summaryTag.textContent = `${city} | ${kit.summary || "热门景点已加载"} | 共打卡 ${doneCount}/${totalCount} | 日均 ${density} 个 | ${pathState}`;

  const mustListHtml = kit.spots
    .map((spot) => {
      const badge = mustSet.has(spot.name) ? `<span class="badge-must">必打卡</span>` : "";
      return `
        <div class="slot">
          <time>热门</time>
          <div>
            <div class="spot">${escapeHtml(spot.name)}${badge}</div>
            <div class="detail">评分 ${spot.score} · 停留 ${spot.stay} 分钟${spot.reason ? ` · ${escapeHtml(spot.reason)}` : ""}</div>
          </div>
        </div>`;
    })
    .join("");

  const html = plans
    .map((plan) => {
      if (!plan.slots.length) {
        return `
          <article class="day-card">
            <div class="day-title">
              <span>Day ${plan.dayIndex} · ${plan.dateLabel}</span>
              <span class="day-meta">建议补觉 + 自由探索</span>
            </div>
            <div class="timeline">
              <div class="slot">
                <time>${timeString(minutesFromTimeString(startHourInput.value))}</time>
                <div>
                  <div class="spot">当前热门景点已排满</div>
                  <div class="detail">可加入咖啡馆、夜景散步或返程预留。</div>
                </div>
              </div>
            </div>
          </article>`;
      }

      const slotsHtml = plan.slots
        .map((s) => {
          const must = `<span class="badge-must">必打卡</span>`;
          const sourceText = s.source === "realtime" ? "实时路况" : "估算";
          return `
            <div class="slot">
              <time>${timeString(s.startVisit)}</time>
              <div>
                <div class="spot">${escapeHtml(s.spot.name)}${mustSet.has(s.spot.name) ? must : ""}</div>
                <div class="detail">停留 ${s.spot.stay} 分钟 · 路程 ${s.transit} 分钟（${sourceText}）${s.wait ? ` · 等待 ${s.wait} 分钟` : ""}</div>
              </div>
            </div>`;
        })
        .join("");

      const used = plan.slots.reduce((acc, cur) => acc + cur.spot.stay + cur.transit + cur.wait, 0);
      return `
        <article class="day-card">
          <div class="day-title">
            <span>Day ${plan.dayIndex} · ${plan.dateLabel}</span>
            <span class="day-meta">有效时长 ${Math.round(used / 60)}h</span>
          </div>
          <div class="timeline">${slotsHtml}</div>
        </article>`;
    })
    .join("");

  const tips = `
    <article class="day-card">
      <div class="day-title">
        <span>行程提示</span>
        <span class="day-meta">机动建议</span>
      </div>
      <div class="timeline">
        <div class="slot">
          <time>城市包</time>
          <div>
            <div class="spot">已加载 ${kit.spots.length} 个热门景点</div>
            <div class="detail">${escapeHtml(kit.summary || "AI 已自动选择本城市的热门必打卡景点")}</div>
          </div>
        </div>
        <div class="slot">
          <time>统计</time>
          <div>
            <div class="spot">全程移动约 ${Math.round(totalTransit / 60)} 小时</div>
            <div class="detail">地理编码成功 ${geocodedCount}/${totalCount}，失败时自动回退估算时长。</div>
          </div>
        </div>
        <div class="slot">
          <time>提醒</time>
          <div>
            <div class="spot">${missedMust.length ? `未排入必打卡：${missedMust.join("、")}` : "必打卡点位已全部安排"}</div>
            <div class="detail">热门景点建议提前预约，避免现场排队打乱节奏。</div>
          </div>
        </div>
      </div>
    </article>`;

  routeResult.innerHTML = `
    <article class="day-card">
      <div class="day-title">
        <span>AI 选点结果</span>
        <span class="day-meta">${escapeHtml(city)} · ${escapeHtml(kit.source || "ai")}</span>
      </div>
      <div class="timeline">${mustListHtml}</div>
    </article>
    ${html}
    ${tips}`;
}

function renderAiResult(content, isError = false) {
  aiResult.classList.add("show");
  if (isError) {
    aiResult.innerHTML = `
      <article class="day-card">
        <div class="day-title">
          <span>AI 热门攻略增强</span>
          <span class="day-meta">调用失败</span>
        </div>
        <div class="timeline">
          <div class="slot">
            <time>提示</time>
            <div>
              <div class="spot">AI 接口调用异常</div>
              <div class="detail">${escapeHtml(content)}</div>
            </div>
          </div>
        </div>
      </article>`;
    return;
  }

  aiResult.innerHTML = `
    <article class="day-card">
      <div class="day-title">
        <span>AI 热门攻略增强</span>
        <span class="day-meta">已生成</span>
      </div>
      <pre>${escapeHtml(content)}</pre>
    </article>`;
}

function formatOptimizerReport(payload, meta = {}) {
  const best = payload?.best;
  if (!best) {
    return "优化服务未返回有效结果。";
  }
  const b = best.score.breakdown;
  const lines = [
    `最佳策略画像：${best.profile}`,
    `综合评分：${best.score.totalScore}`,
    "",
    `AI 热门信号数：${Number(meta.signalCount || 0)}`,
    meta.warning ? `AI 提示：${meta.warning}` : "AI 提示：已正常融合热门攻略信号",
    "",
    "量化拆解：",
    `- 覆盖度 coverageScore: ${b.coverageScore}`,
    `- 必打卡完成率 mustHitScore: ${b.mustHitScore}`,
    `- 交通效率 efficiencyScore: ${b.efficiencyScore}`,
    `- 热门匹配度 popularityScore: ${b.popularityScore}`,
    `- 体力可持续 fatigueScore: ${b.fatigueScore}`,
    "",
    "推荐路线："
  ];

  for (const day of best.plans || []) {
    const route = (day.slots || []).map((slot) => `${slot.spot.name}(${slot.transit}min)`).join(" -> ") || "无";
    lines.push(`Day ${day.dayIndex}: ${route}`);
  }

  if (Array.isArray(best.unplanned) && best.unplanned.length > 0) {
    lines.push("");
    lines.push(`未排入（建议候补）：${best.unplanned.join("、")}`);
  }

  return lines.join("\n");
}

async function runAiEnhancement(result) {
  if (!aiEnabledInput.checked) {
    aiResult.classList.remove("show");
    aiResult.innerHTML = "";
    return;
  }

  const optimizerApi = optimizerApiInput.value.trim();
  if (!optimizerApi) {
    renderAiResult("请先填写后端优化服务地址。", true);
    return;
  }

  aiResult.classList.add("show");
  aiResult.innerHTML = `
    <article class="day-card">
      <div class="day-title">
        <span>AI 热门攻略增强</span>
        <span class="day-meta">生成中</span>
      </div>
      <div class="timeline">
        <div class="slot">
          <time>状态</time>
          <div>
            <div class="spot">正在请求 AI</div>
            <div class="detail">建议使用支持联网搜索的模型以获得更准的热门攻略。</div>
          </div>
        </div>
      </div>
    </article>`;

  const aiConfig = {
    endpoint: aiEndpointInput.value.trim(),
    model: aiModelInput.value.trim(),
    apiKey: aiApiKeyInput.value.trim()
  };

  const guideSignals = [];
  for (const day of result.plans) {
    for (const slot of day.slots) {
      guideSignals.push({
        name: slot.spot.name,
        popularity: Math.max(0.4, Math.min(0.98, slot.spot.score / 10))
      });
    }
  }

  try {
    const response = await fetch(`${optimizerApi.replace(/\/$/, "")}/api/optimize-strategy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        city: result.city,
        mode: intensitySelect.value,
        days: Number(daysInput.value) || 3,
        dayStart: minutesFromTimeString(startHourInput.value),
        dayEnd: minutesFromTimeString(endHourInput.value),
        mustSpots: [...result.mustSet],
        guideSignals,
        basePlan: result.plans,
        aiConfig
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data?.ok) {
      throw new Error(data?.message || "后端优化失败");
    }
    const content = formatOptimizerReport(data.result, data.ai || {});
    renderAiResult(content, false);
  } catch (error) {
    renderAiResult(error.message || "未知错误", true);
  }
}

async function handlePlanClick() {
  planBtn.disabled = true;
  planBtn.textContent = "规划中，请稍候...";
  try {
    if (!state.activeCityKit || state.activeCityKit.city !== cityInput.value.trim()) {
      const kit = await fetchCityKit(false);
      if (!kit) {
        return;
      }
    }

    const result = await buildPlan();
    if (!result) {
      return;
    }
    renderPlan(result);
    await runAiEnhancement(result);
  } finally {
    planBtn.disabled = false;
    planBtn.textContent = "生成特种兵路线";
  }
}

function init() {
  startDateInput.value = formatDate(0);
  cityInput.value = cityInput.value.trim() || "北京";

  loadCityBtn.addEventListener("click", async () => {
    await fetchCityKit(true);
  });

  cityInput.addEventListener("change", () => {
    state.activeCityKit = null;
    aiResult.classList.remove("show");
    routeResult.innerHTML = '<p class="placeholder">点击左侧按钮，生成你的高强度行程。</p>';
  });

  mapProviderSelect.addEventListener("change", () => {
    mapCache.geo.clear();
    mapCache.transit.clear();
  });

  transportModeSelect.addEventListener("change", () => {
    mapCache.transit.clear();
  });

  planBtn.addEventListener("click", handlePlanClick);
}

init();
