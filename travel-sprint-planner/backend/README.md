# 后端攻略优化服务

这是一个独立后端，用于处理攻略优化逻辑与量化评分，不再依赖前端直接计算最佳方案。

## 启动

1. 进入 backend 目录
2. 安装依赖：npm install
3. 启动服务：npm run dev
4. 默认地址：http://localhost:3001

## API

### GET /api/health

健康检查。

### POST /api/optimize-strategy

输入当前行程与约束，输出最佳攻略与评分。

接口会执行两段式流程：

1. 若请求中提供 aiConfig，则先调用 AI（可联网）提取热门度信号。
2. 将 AI 信号与本地信号合并后，进入量化优化引擎，输出最佳攻略。

请求体示例：

{
  "city": "北京",
  "mode": "balanced",
  "days": 3,
  "dayStart": 420,
  "dayEnd": 1350,
  "mustSpots": ["故宫", "天坛"],
  "guideSignals": [
    { "name": "故宫", "popularity": 0.95 },
    { "name": "什刹海", "popularity": 0.8 }
  ],
  "aiConfig": {
    "endpoint": "https://openrouter.ai/api/v1/chat/completions",
    "model": "openai/gpt-4.1-mini",
    "apiKey": "YOUR_KEY"
  },
  "basePlan": [
    {
      "dayIndex": 1,
      "slots": [
        {
          "spot": { "name": "故宫", "score": 10, "stay": 180, "x": 52, "y": 52, "open": [8, 17] },
          "transit": 35,
          "wait": 0
        }
      ]
    }
  ]
}

返回重点字段：

- result.best.profile: 最佳策略画像
- result.best.score.totalScore: 综合评分
- result.best.score.breakdown: 各项量化分数
- result.best.plans: 优化后日程
- result.evaluationStandard: 评分标准说明
- ai.signalCount: AI 提供的热门信号数量
- ai.warning: AI 调用失败时的降级提示

## 量化评判标准

- coverageScore：景点覆盖度
- mustHitScore：必打卡完成率
- efficiencyScore：交通效率
- popularityScore：热门匹配度
- fatigueScore：体力可持续性

综合得分范围 0-100，分值越高代表可执行性与收益越优。
