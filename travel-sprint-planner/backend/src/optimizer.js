const defaultWeightsByMode = {
  balanced: {
    attraction: 0.32,
    popularity: 0.16,
    mustHit: 0.2,
    efficiency: 0.18,
    fatigue: 0.14
  },
  hardcore: {
    attraction: 0.36,
    popularity: 0.15,
    mustHit: 0.2,
    efficiency: 0.2,
    fatigue: 0.09
  },
  extreme: {
    attraction: 0.4,
    popularity: 0.17,
    mustHit: 0.2,
    efficiency: 0.17,
    fatigue: 0.06
  }
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizePopularity(spotName, guideSignals) {
  const entry = (guideSignals || []).find((s) => s.name === spotName);
  if (!entry) {
    return 0.55;
  }
  return clamp(Number(entry.popularity ?? 0.65), 0, 1);
}

function estimateTransit(a, b) {
  const ax = Number(a?.x ?? 50);
  const ay = Number(a?.y ?? 50);
  const bx = Number(b?.x ?? 50);
  const by = Number(b?.y ?? 50);
  const dx = ax - bx;
  const dy = ay - by;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return Math.max(12, Math.round(distance * 2.8));
}

function flattenSpots(basePlan) {
  const seen = new Set();
  const output = [];
  for (const day of basePlan || []) {
    for (const slot of day.slots || []) {
      const name = slot?.spot?.name;
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      output.push({
        ...slot.spot,
        originalTransit: Number(slot.transit || 0)
      });
    }
  }
  return output;
}

function buildDayBuckets(days, dayStart, dayEnd) {
  const buckets = [];
  for (let i = 0; i < days; i += 1) {
    buckets.push({
      dayIndex: i + 1,
      currentMinute: dayStart,
      slots: [],
      transitTotal: 0,
      stayTotal: 0,
      waitTotal: 0,
      lastSpot: { x: 50, y: 50, name: "起点" },
      dayStart,
      dayEnd
    });
  }
  return buckets;
}

function calcSpotUtility(spot, context) {
  const popularity = normalizePopularity(spot.name, context.guideSignals);
  const isMust = context.mustSet.has(spot.name);
  const transit = estimateTransit(context.currentSpot, spot);
  const arrive = context.currentMinute + transit;
  const open = (spot.open?.[0] ?? 0) * 60;
  const close = (spot.open?.[1] ?? 24) * 60;
  const wait = Math.max(0, open - arrive);
  const leave = arrive + wait + Number(spot.stay || 90);
  const feasible = leave <= close && leave <= context.dayEnd - context.fatigueBuffer;

  const attractionScore = clamp(Number(spot.score || 6) / 10, 0, 1);
  const transitPenalty = clamp(transit / 120, 0, 1);
  const utility =
    attractionScore * context.weights.attraction +
    popularity * context.weights.popularity +
    (isMust ? 1 : 0) * context.weights.mustHit -
    transitPenalty * 0.15;

  return {
    utility,
    feasible,
    transit,
    wait,
    arrive,
    leave,
    popularity,
    isMust
  };
}

function scheduleWithGreedy(spots, options) {
  const days = buildDayBuckets(options.days, options.dayStart, options.dayEnd);
  const remaining = [...spots];

  for (const day of days) {
    let guard = 0;
    while (remaining.length > 0 && guard < 50) {
      guard += 1;
      let bestIndex = -1;
      let bestEval = null;

      for (let i = 0; i < remaining.length; i += 1) {
        const spot = remaining[i];
        const evalResult = calcSpotUtility(spot, {
          guideSignals: options.guideSignals,
          mustSet: options.mustSet,
          currentSpot: day.lastSpot,
          currentMinute: day.currentMinute,
          dayEnd: day.dayEnd,
          fatigueBuffer: options.fatigueBuffer,
          weights: options.weights
        });

        if (!evalResult.feasible) {
          continue;
        }

        if (!bestEval || evalResult.utility > bestEval.utility) {
          bestEval = evalResult;
          bestIndex = i;
        }
      }

      if (bestIndex < 0 || !bestEval) {
        break;
      }

      const selected = remaining.splice(bestIndex, 1)[0];
      day.slots.push({
        spot: selected,
        startVisit: bestEval.arrive + bestEval.wait,
        endVisit: bestEval.leave,
        transit: bestEval.transit,
        wait: bestEval.wait,
        popularity: bestEval.popularity,
        source: "optimizer"
      });
      day.currentMinute = bestEval.leave;
      day.lastSpot = selected;
      day.transitTotal += bestEval.transit;
      day.stayTotal += Number(selected.stay || 90);
      day.waitTotal += bestEval.wait;
    }
  }

  return { days, remaining };
}

function scoreItinerary(days, context) {
  const allSlots = days.flatMap((d) => d.slots);
  const plannedCount = allSlots.length;
  const totalTransit = allSlots.reduce((acc, s) => acc + Number(s.transit || 0), 0);
  const totalStay = allSlots.reduce((acc, s) => acc + Number(s.spot?.stay || 0), 0);
  const avgPopularity =
    plannedCount > 0 ? allSlots.reduce((acc, s) => acc + Number(s.popularity || 0.55), 0) / plannedCount : 0;

  const mustDone = allSlots.filter((s) => context.mustSet.has(s.spot.name)).length;
  const mustTotal = Math.max(1, context.mustSet.size);
  const target = Math.max(1, context.targetCount);

  const coverageScore = clamp(plannedCount / target, 0, 1) * 100;
  const mustHitScore = clamp(mustDone / mustTotal, 0, 1) * 100;
  const efficiencyScore = totalStay + totalTransit > 0 ? clamp(totalStay / (totalStay + totalTransit), 0, 1) * 100 : 0;
  const popularityScore = clamp(avgPopularity, 0, 1) * 100;

  const dayBusyScores = days.map((d) => {
    const active = d.stayTotal + d.transitTotal + d.waitTotal;
    const cap = Math.max(1, d.dayEnd - d.dayStart);
    const ratio = active / cap;
    return ratio <= 0.95 ? 1 : clamp(1 - (ratio - 0.95) * 2.5, 0, 1);
  });
  const fatigueScore =
    dayBusyScores.length > 0
      ? (dayBusyScores.reduce((acc, s) => acc + s, 0) / dayBusyScores.length) * 100
      : 0;

  const w = context.weights;
  const totalScore =
    coverageScore * 0.22 +
    mustHitScore * w.mustHit +
    efficiencyScore * w.efficiency +
    popularityScore * w.popularity +
    fatigueScore * w.fatigue +
    (allSlots.reduce((acc, s) => acc + Number(s.spot?.score || 6), 0) / Math.max(1, plannedCount) / 10) *
      w.attraction *
      100;

  return {
    totalScore: Number(totalScore.toFixed(2)),
    breakdown: {
      coverageScore: Number(coverageScore.toFixed(1)),
      mustHitScore: Number(mustHitScore.toFixed(1)),
      efficiencyScore: Number(efficiencyScore.toFixed(1)),
      popularityScore: Number(popularityScore.toFixed(1)),
      fatigueScore: Number(fatigueScore.toFixed(1))
    },
    stats: {
      plannedCount,
      totalTransit,
      totalStay,
      mustDone,
      mustTotal
    }
  };
}

function candidateWeightProfiles(mode) {
  const base = defaultWeightsByMode[mode] || defaultWeightsByMode.balanced;
  return [
    { name: "balanced", weights: base },
    {
      name: "hotspot-first",
      weights: {
        ...base,
        popularity: clamp(base.popularity + 0.08, 0, 0.35),
        efficiency: clamp(base.efficiency - 0.04, 0.05, 0.35)
      }
    },
    {
      name: "must-first",
      weights: {
        ...base,
        mustHit: clamp(base.mustHit + 0.1, 0.15, 0.45),
        fatigue: clamp(base.fatigue - 0.03, 0.03, 0.25)
      }
    }
  ];
}

export function optimizeStrategy(payload) {
  const mode = payload?.mode || "balanced";
  const dayStart = Number(payload?.dayStart ?? 420);
  const dayEnd = Number(payload?.dayEnd ?? 1320);
  const days = Math.max(1, Number(payload?.days || 3));
  const fatigueBuffer = Number(payload?.fatigueBuffer ?? (mode === "extreme" ? 25 : mode === "hardcore" ? 45 : 70));
  const guideSignals = Array.isArray(payload?.guideSignals) ? payload.guideSignals : [];

  const baseSpots = flattenSpots(payload?.basePlan || []);
  const mustSet = new Set(Array.isArray(payload?.mustSpots) ? payload.mustSpots : []);

  const profiles = candidateWeightProfiles(mode);
  const candidates = [];

  for (const profile of profiles) {
    const scheduled = scheduleWithGreedy(baseSpots, {
      days,
      dayStart,
      dayEnd,
      fatigueBuffer,
      guideSignals,
      mustSet,
      weights: profile.weights
    });

    const score = scoreItinerary(scheduled.days, {
      mustSet,
      targetCount: Math.max(baseSpots.length, mustSet.size),
      weights: profile.weights
    });

    candidates.push({
      profile: profile.name,
      score,
      plans: scheduled.days.map((d) => ({
        dayIndex: d.dayIndex,
        slots: d.slots
      })),
      unplanned: scheduled.remaining.map((s) => s.name)
    });
  }

  candidates.sort((a, b) => b.score.totalScore - a.score.totalScore);
  const best = candidates[0];

  return {
    best,
    candidates,
    evaluationStandard: {
      dimensions: [
        "coverageScore: 景点覆盖度",
        "mustHitScore: 必打卡完成率",
        "efficiencyScore: 交通效率",
        "popularityScore: 热门匹配度",
        "fatigueScore: 体力可持续性"
      ],
      explain: "综合得分 = 多维度加权和，范围 0-100，分数越高表示越适合高强度可执行行程。"
    }
  };
}
