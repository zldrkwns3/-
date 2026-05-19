import express from "express";
import "express-async-errors";
import path from "path";
import { createServer as createViteServer } from "vite";
import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { getKisPrice, getKisBalance, buyOrder, sellOrder, sendSlackNotification, getFilteredTopStocks } from "./server/kisService.ts";
import { aiLimiter } from "./server/aiRateLimiter.ts";

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error("🔥 [Uncaught Exception]:", err);
  sendSlackNotification(`🚨 [*Uncaught Exception*]\n> *Message*: ${err.message || String(err)}\n\`\`\`${err.stack || ""}\`\`\``);
});

process.on('unhandledRejection', (reason: any, promise) => {
  console.error("🔥 [Unhandled Rejection]:", reason);
  sendSlackNotification(`🚨 [*Unhandled Rejection*]\n> *Reason*: ${reason?.message || String(reason)}\n\`\`\`${reason?.stack || ""}\`\`\``);
});

// 0.1초 ~ 0.2초씩 코드를 잠시 멈춰주는 유틸리티 함수
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

import fs from "fs";
import cron from "node-cron";
import { saveSnapshotToFirestore } from "./server/firebase.ts";

let isLoopRunning = false;

// Cron job to run every 30 seconds during market hours
cron.schedule("*/30 * * * * *", async () => {
  if (memory.isRunning && !isLoopRunning) {
    isLoopRunning = true;
    try {
      // console.log("Cron triggering monitoring loop...");
      await monitoringLoop();
    } catch (e) {
      console.error("Critical error in monitoring loop:", e);
    } finally {
      isLoopRunning = false;
    }
  } else if (memory.isRunning && isLoopRunning) {
    // console.log("Loop still running, skipping this tick.");
  }
});

// [Debug] API to check server status and paths
app.get("/api/debug/paths", (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const distPath = path.join(process.cwd(), "dist");
  const indexPath = path.join(distPath, "index.html");
  const fallbackPath = path.join(__dirname, "index.html");
  
  res.json({
    isProduction,
    cwd: process.cwd(),
    dirname: typeof __dirname !== 'undefined' ? __dirname : 'N/A',
    distPath,
    indexExists: fs.existsSync(indexPath),
    fallbackExists: fs.existsSync(fallbackPath),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      GEMINI_KEY: process.env.GEMINI_API_KEY ? "SET (Length: " + process.env.GEMINI_API_KEY.length + ")" : "NOT SET",
      KIS_KEY: process.env.KIS_APP_KEY ? "SET" : "NOT SET"
    }
  });
});

// ------------------------------------
// 1. 메모리 구조 확장 설계 (장부 관리)
// ------------------------------------
interface StockConfig {
  symbol: string;
  name: string;
  investAmount: number;
  takeProfitPct: number;
  stopLossPct: number;
  useAI: boolean;
}

interface ActivePosition {
  symbol: string;
  name?: string;
  buyPrice: number;
  qty: number;
  totalInvested: number;
  buyTime: number;
  highestPrice?: number;
}

interface TradeJournal {
  symbol: string;
  name?: string;
  buyPrice: number;
  sellPrice: number;
  profitRate: number;
  profitAmount?: number;
  qty?: number;
  review: string;
  date: number;
}

interface TradeOrder {
  symbol: string;
  name?: string;
  type: 'BUY' | 'SELL';
  price: number;
  qty: number;
  amount: number;
  timestamp: number;
  status: 'SUCCESS' | 'FAILED';
  message?: string;
  aiReason?: string;
  aiConfidence?: number;
  profitRate?: number;
  profitAmount?: number;
}

const KOSPI_TOP_20 = [
  { symbol: "005930", name: "삼성전자" },
  { symbol: "000660", name: "SK하이닉스" },
  { symbol: "373220", name: "LG에너지솔루션" },
  { symbol: "207940", name: "삼성바이오로직스" },
  { symbol: "005380", name: "현대차" },
  { symbol: "000270", name: "기아" },
  { symbol: "068270", name: "셀트리온" },
  { symbol: "051910", name: "LG화학" },
  { symbol: "005490", name: "POSCO홀딩스" },
  { symbol: "035420", name: "NAVER" },
  { symbol: "035720", name: "카카오" },
  { symbol: "006400", name: "삼성SDI" },
  { symbol: "012330", name: "현대모비스" },
  { symbol: "105560", name: "KB금융" },
  { symbol: "055550", name: "신한지주" },
  { symbol: "032830", name: "삼성생명" },
  { symbol: "003670", name: "포스코퓨처엠" },
  { symbol: "033780", name: "KT&G" },
  { symbol: "011200", name: "HMM" },
  { symbol: "323410", name: "카카오뱅크" },
  { symbol: "000810", name: "삼성화재" },
  { symbol: "034730", name: "SK" },
  { symbol: "015760", name: "한국전력" },
  { symbol: "017670", name: "SK텔레콤" },
  { symbol: "010130", name: "고려아연" },
];

interface AssetSnapshot {
  date: string;          // "2026-05-18" 형식
  totalEquity: number;   // 운용 풀 + 금고 + 주식 평가금 합계
  operationPool: number; // 실제 운용 가능 투자금
  safeVault: number;     // 안전 금고 잔고
}

class TradingMemory {
  public watchList: Map<string, StockConfig> = new Map();
  public positions: Map<string, ActivePosition> = new Map();
  public availableCapital: number = 5000000; // 500만원
  public safeReserve: number = 0;            // 수익금의 20% 락업
  public totalEquity: number = 0;            // 총 자산 (예수금 + 주식)
  public isRunning: boolean = false;
  private isStarting: boolean = false;
  public intervalId: NodeJS.Timeout | null = null;
  public logs: string[] = [];
  public journals: TradeJournal[] = [];
  public orders: TradeOrder[] = [];
  public history: AssetSnapshot[] = [];

  public save() {
    try {
      const data = {
        watchList: Array.from(this.watchList.entries()),
        positions: Array.from(this.positions.entries()),
        availableCapital: this.availableCapital,
        safeReserve: this.safeReserve,
        totalEquity: this.totalEquity,
        journals: this.journals,
        orders: this.orders,
        history: this.history
      };
      fs.writeFileSync('./bot-memory.json', JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Failed to save memory', e);
    }
  }

  public load() {
    try {
      if (fs.existsSync('./bot-memory.json')) {
        const data = JSON.parse(fs.readFileSync('./bot-memory.json', 'utf8'));
        this.watchList = new Map(data.watchList);
        this.positions = new Map(data.positions);
        this.availableCapital = data.availableCapital || 5000000;
        this.safeReserve = data.safeReserve || 0;
        this.totalEquity = data.totalEquity || 0;
        this.journals = (data.journals || []).map((j: any) => {
          if (j.profitAmount === null || j.profitAmount === undefined) {
             if (j.sellPrice && j.buyPrice && j.qty) {
               j.profitAmount = (j.sellPrice - j.buyPrice) * j.qty;
             } else {
               j.profitAmount = 0;
             }
          }
          return j;
        });
        this.orders = data.orders || [];
        this.history = data.history || [];
        if (data.logs) {
          this.logs = data.logs;
          console.log('[DEBUG] Loaded logs from bot-memory.json:', this.logs.length);
        } else {
          console.log('[DEBUG] No logs found in bot-memory.json');
        }
      }
    } catch (e) {}
  }
}

export const memory = new TradingMemory();
memory.load(); // 최초 서버 부팅시 파일에서 장부 복구

// 서버 부팅 시 잔고 한 번 시도 (실패해도 무관)
setTimeout(() => {
  getKisBalance().then(res => {
    if (res !== null) {
      memory.availableCapital = res.balance;
      memory.totalEquity = res.totalEquity;
      // 실계좌 포지션과 memory 동기화
      const apiSymbols = new Set(res.positions.map((p: any) => p.symbol));
      for (const key of memory.positions.keys()) {
        if (!apiSymbols.has(key)) {
          memory.positions.delete(key);
        }
      }
      res.positions.forEach((p: any) => {
        if (!p.totalInvested) p.totalInvested = p.buyPrice * p.qty;
        if (!p.buyTime) p.buyTime = Date.now();
        if (!memory.positions.has(p.symbol)) {
           memory.positions.set(p.symbol, p);
        } else {
           const existing = memory.positions.get(p.symbol);
           existing.qty = p.qty;
           existing.buyPrice = p.buyPrice;
           if (p.name) existing.name = p.name;
        }
      });
      console.log(`[초기화] KIS 잔고 동기화 완료: ${res.balance}`);
    }
  }).catch(err => {
    console.error("[초기화] 잔고 동기화 에러:", err.message);
  });
}, 5000);

function isKoreanMarketOpenStrict() {
  const krTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = krTime.getHours();
  const minute = krTime.getMinutes();
  const day = krTime.getDay();
  
  if (day === 0 || day === 6) return false;
  
  // 08:00 ~ 15:59 사이만 거래 (동시호가/장전 시간외 ~ 장후 시간외 포함)
  // 정규장은 09:00~15:30이지만 봇의 감시 및 준비를 위해 8시부터 가동합니다.
  const timeNum = hour * 100 + minute;
  if (timeNum < 800) return false;
  if (timeNum > 1559) return false;
  
  return true;
}

function addBotLog(msg: string, currentPrice?: number, profitPct?: number) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul", hour12: false });
  let extraInfo = "";
  if (currentPrice !== undefined) {
    extraInfo += ` | 현재가: ${currentPrice.toLocaleString()}원`;
  }
  if (profitPct !== undefined) {
    const colorIcon = profitPct > 0 ? "🔴" : profitPct < 0 ? "🔵" : "⚪";
    extraInfo += ` | 수익률: ${colorIcon} ${(profitPct * 100).toFixed(2)}%`;
  }
  
  const logMsg = `[${timestamp}] ${msg}${extraInfo}`;
  console.log(logMsg);
  memory.logs.unshift(logMsg);
  if (memory.logs.length > 50) memory.logs.pop(); 
  
  // 성공, 익절, 손절 등 중요 알림은 Slack 전송
  if (msg.includes("성공") || msg.includes("익절") || msg.includes("손절")) {
     sendSlackNotification(logMsg);
  }
}

// Global AI Rate Limiting & Caching
let aiGlobalRateLimitEnd = 0;
// ttl을 함께 저장하여 사유별로 쿨타임을 다르게 부여합니다.
const aiCache = new Map<string, { approved: boolean, reason: string, timestamp: number, ttl: number }>();

async function analyzeWithAI(symbol: string, currentPrice: number, indicators: any, retryCount = 0): Promise<{ approved: boolean, reason: string, confidence: number }> {
   const apiKey = process.env.GEMINI_API_KEY;
   if (!apiKey || apiKey.length < 10) {
     return { approved: true, reason: "API key missing or invalid, auto-approved", confidence: 100 };
   }

   // 1. 글로벌 쿼터 제한 확인 (429 에러 발생 시 60초간 AI 통신 쿨다운)
   if (Date.now() < aiGlobalRateLimitEnd) {
      if (indicators.rsi < 28 || indicators.rsi > 75) {
         return { approved: true, reason: "AI 쿼터 초과 쿨다운 중 (기술적 지표 자동 승인)", confidence: 100 };
      }
      return { approved: false, reason: "AI 쿼터 초과 쿨다운 중 (잠시 보류)", confidence: 0 };
   }

   // 2. 사유별 맞춤 캐시(쿨다운) 확인
   const cached = aiCache.get(symbol);
   if (cached && (Date.now() - cached.timestamp) < cached.ttl) {
     const remainingSeconds = Math.ceil((cached.ttl - (Date.now() - cached.timestamp)) / 1000);
     const timeDisplay = remainingSeconds > 60 ? `${Math.ceil(remainingSeconds/60)}분` : `${remainingSeconds}초`;
     addBotLog(`♻️ 캐시된 AI 결과 재사용 (${symbol}): ${cached.approved ? 'YES' : 'NO'} (남은 유효시간: ${timeDisplay})`);
     return { approved: cached.approved, reason: cached.reason, confidence: (cached as any).confidence || (cached.approved ? 80 : 0) };
   }

   // 3. 글로벌 쿨다운 (최소 호출 간격 보장)
   const canCall = await aiLimiter.waitForTurn('LOW', `매수분석-${symbol}`);
   if (!canCall) {
      addBotLog(`🛡️ [방어막] 트래픽 폭주로 ${symbol} 신규 매수 AI 분석을 건너뜁니다. (트래픽 병목)`);
      // 단순 트래픽 잼으로 튕겼을 때는 30초의 매우 짧은 쿨타임만 부여하여 다음 타점을 놓치지 않게 합니다.
      aiCache.set(symbol, { approved: false, reason: "단순 쿼터 초과 (트래픽 잼)", timestamp: Date.now(), ttl: 30 * 1000 });
      return { approved: false, reason: "AI 쿼터 대기열 초과 (잠시 후 자동 재시도)", confidence: 0 };
   }

   try {
     addBotLog(`Gemini 분석 호출 중... (${symbol} | RSI: ${Math.round(indicators.rsi)})`);
     
     const recentJournals = memory.journals.slice(0, 5);
     const journalsText = recentJournals.length > 0 
       ? "\n[최근 매매 복기 내역 (과거의 실수를 반복하지 않기 위해 참고하세요)]\n" + recentJournals.map(j => `- 종목: ${j.symbol}, 매수가: ${j.buyPrice}, 매도가: ${j.sellPrice}, 수익률: ${(j.profitRate*100).toFixed(2)}%\n  복기: ${j.review}\n`).join('\n')
       : "";

      const stockName = memory.watchList.get(symbol)?.name || symbol;
      const prompt = `
        당신은 한국 주식 시장의 단타(스캘핑/데이 트레이딩) 최고 전문가입니다.
        현재 '${stockName}' 종목이 알고리즘상 매수 타점에 도달했습니다.
        아래 제공된 오늘자 최신 뉴스와 시장 분위기(검색 허용)를 분석하여 당일 진입해도 좋은지 판단해주세요.

        ${journalsText}

        [현재 데이터]
        - 현재가: ${currentPrice.toLocaleString()}원
        - 전일 고가: ${indicators.yesterdayHigh ? indicators.yesterdayHigh.toLocaleString() : currentPrice.toLocaleString()}원
        - 거래량 폭증 비율 (현재/5일평균): ${indicators.volumeRatio ? indicators.volumeRatio.toFixed(2) : 1}배
        - RSI (14): ${indicators.rsi.toFixed(2)}
        - 5일 이평선 이격도: ${((currentPrice - (indicators.ma5 || currentPrice)) / (indicators.ma5 || currentPrice) * 100).toFixed(2)}%

        [평가 기준]
        1. 전일 고가 돌파 여부 판단: 주가가 '전일 고가(yesterdayHigh)'를 돌파하며 상승 중인지 확인하세요. 강력한 매수 신호입니다. (가산점)
        2. 거래량 폭발 판단: '거래량 폭증 비율(volumeRatio)'이 2배 이상이면 시장의 관심이 쏠렸다는 뜻으로 확률이 높습니다. (가산점)
        3. 이 종목이 현재 시장을 주도하는 테마의 1등주(대장주)인가? (2, 3등주는 감점)
        4. 당일 강력한 상승을 뒷받침할 명확한 호재(국책과제, 대규모 수주, 세계 최초 등)가 있는가?
        5. 뉴스가 이미 재료 소멸(설거지) 단계인지, 이제 막 시작된 재료인지 파악할 것.

        결과를 아래 JSON 형식으로만 반환하세요.
        {
          "buy_approved": true 또는 false,
          "confidence_score": 1부터 100까지의 확신도 점수 (정수),
          "reason": "결정에 대한 1~2줄의 짧고 명확한 이유"
        }
      `;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });
      
      let resText = response.text || "{}";
      // Extract from markdown code block if present
      const match = resText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match) {
         resText = match[1];
      }
      resText = resText.trim();
      
      let parsed = { buy_approved: false, confidence_score: 50, reason: "" };
      try {
        parsed = JSON.parse(resText);
      } catch(e) {
        console.error("Failed to parse JSON:", resText);
        // Fallback robust parsing (in case of extra text or broken JSON)
        const isApproved = /"buy_approved"\s*:\s*true/i.test(resText);
        parsed = { 
           buy_approved: isApproved, 
           confidence_score: 50,
           reason: isApproved ? "JSON Parsing failed, fallback guess: TRUE" : "JSON Parsing failed, fallback guess: FALSE" 
        };
      }
      
      let approved = parsed.buy_approved === true;
      const confidence = parsed.confidence_score || 0;
      let reason = parsed.reason || "이유를 찾을 수 없음";
      if (!reason) reason = resText.substring(0, 100);

      // 확신도 점수 적용
      if (approved) {
          if (confidence < 70) {
              approved = false;
              reason = `(승인 보류: 확신도 ${confidence}점 미달, 수동 확인 요망) ` + reason;
          } else {
              reason = `(신뢰도 ${confidence}점) ` + reason;
          }
      }

      // AI의 확실한 거절(NO)인 경우 1분간 대기 (빠른 시장 변화 대응을 위해 1분으로 단축)
      // 승인된 경우 10분간 캐시 유지 (승인 후엔 이미 포지션에 들어갈 테니 넉넉하게)
      const ttl = approved ? (10 * 60 * 1000) : (60 * 1000); 
      const result = { approved, reason: reason.substring(0, 80), timestamp: Date.now(), ttl, confidence };
      
      // 결과 캐싱
      aiCache.set(symbol, result);

     addBotLog(`Gemini 분석 완료: ${approved ? 'YES ✅' : 'NO ❌'} (${result.reason})`);
     return { approved: result.approved, reason: result.reason, confidence: result.confidence };
   } catch (error: any) {
     const errorMsg = error.message || String(error);
     
     // 429 에러(Quota Exceeded) 처리: 즉시 실패 처리 (단순 트래픽 초과로 30초 대기!)
     if (errorMsg.includes("429")) {
       aiGlobalRateLimitEnd = Date.now() + 60000; // 60초간 글로벌 호출 중지
       if (indicators.rsi < 28 || indicators.rsi > 75) {
          addBotLog(`💡 AI 쿼터 초과(429)로 인해 기술적 지표 기반 조건부 진입을 시도합니다. (RSI: ${indicators.rsi.toFixed(1)})`);
          return { approved: true, reason: "AI 쿼터 초과 (기술적 지표 강세 기반 자동 승인)", confidence: 100 };
       }
       addBotLog(`⚠️ ${symbol} AI 쿼터 초과. 30초 후 재시도 기회를 줍니다.`);
       // 단순 쿼터 초과 (사유에 따라 30초 맞춤 쿨타임)
       aiCache.set(symbol, { approved: false, reason: "API 쿼터 초과 에러", timestamp: Date.now(), ttl: 30 * 1000 });
       return { approved: false, reason: "AI 쿼터 초과", confidence: 0 };
     }

     if (retryCount < 2) {
         const waitTime = (retryCount + 1) * 3000; // 3초, 6초
         addBotLog(`⚠️ AI 분석 지연/오류. ${waitTime/1000}초 후 재시도합니다... (시도 ${retryCount + 1}/2)`);
         await new Promise(resolve => setTimeout(resolve, waitTime));
         return analyzeWithAI(symbol, currentPrice, indicators, retryCount + 1);
     }

     console.error("Gemini Analysis Error:", error);
     addBotLog(`Gemini 분석 오류: ${errorMsg.substring(0, 50)}...`);
     return { approved: false, reason: `AI 분석 오류: ${errorMsg.substring(0, 30)}`, confidence: 0 };
   }
}

const aiSellCache = new Map<string, { lastChecked: number, sellRecommended: boolean, reason: string }>();

async function askGeminiForSell(
  symbol: string,
  stockName: string, 
  currentProfitPct: number, 
  holdingTimeMinutes: number,
  aiTriggerReason: string,
  dropFromHighPct: number = 0
): Promise<{ recommended: boolean, reason: string, confidence: number }> {
   const apiKey = process.env.GEMINI_API_KEY;
   if (!apiKey || apiKey.length < 10) return { recommended: false, reason: "API Key missing", confidence: 0 };

   // 1. 글로벌 쿼터 제한 확인 (429 에러 발생 시)
   if (Date.now() < aiGlobalRateLimitEnd) {
      return { recommended: false, reason: "Quota Limit", confidence: 0 }; // 보류
   }

   // 2. 종목별로 최소 3분 쿨다운 두기
   const cached = aiSellCache.get(symbol);
   if (cached && (Date.now() - cached.lastChecked) < 3 * 60 * 1000) {
      return { recommended: false, reason: "Cooldown", confidence: 0 }; // 너무 잦은 질문 방지 (3분 제한)
   }

   // 3. 글로벌 쿨다운 확인
   const canCall = await aiLimiter.waitForTurn('HIGH', `매도분석-${stockName}`);
   if (!canCall) {
      addBotLog(`🛡️ [방어막] 트래픽 폭주로 ${stockName} 매도 AI 분석을 건너뜁니다. (기계적 기준 유지)`);
      return { recommended: false, reason: "Throttle", confidence: 0 };
   }

   try {
     addBotLog(`🤖 AI에게 '${stockName}' 조기 매도 판단 요청 중... (수익률: ${currentProfitPct.toFixed(2)}%)`);
     
     const prompt = `
당신은 한국 주식 단타(데이 트레이딩) 최고 전문가입니다.
현재 봇이 보유 중인 '${stockName}(${symbol})'의 '조기 청산(매도)' 여부를 결정해야 합니다.
기계적인 설정값(익절 3%, 손절 -5%)에 도달하지 않았지만, 시장 상황과 재료를 바탕으로 지금 당장 시장가로 던져야 할지 판단하세요.

[현재 포지션 상태]
- 종목명: ${stockName}
- 현재 수익률: ${currentProfitPct.toFixed(2)}%
- 보유 시간: ${holdingTimeMinutes}분
- 최고점 대비 하락률 (변동성 지표): ${dropFromHighPct.toFixed(2)}%

[매도 판단 검사 발동 사유]
- ${aiTriggerReason}

[매도 판단 기준 (하나라도 심각하면 즉시 매도 승인)]
1. 악재 발생 또는 재료 소멸: 구글 검색을 활용해서 최신 뉴스를 확인하세요. 뉴스가 부정적이거나 재료 소멸인가?
2. 높은 변동성 및 추세 이탈: 고점 대비 하락률(변동성 지표)이 방어선을 위협하는가?
3. 모멘텀 둔화 및 수익 보전: 단기 상승 동력을 잃어 차익실현이 필요한가?
4. 시간 가치 하락: 보유 시간에 비해 진전이 없어 자금 회전이 필요한가?

결과를 아래 JSON 형식으로만 반환하세요.
{
  "sell_recommended": true 또는 false,
  "confidence_score": 1부터 100까지의 확신도 점수 (정수),
  "reason": "결정에 대한 1~2줄의 명확한 이유"
}
     `;
     const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
     });

     let resText = response.text || "{}";
     const match = resText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
     if (match) {
        resText = match[1];
     }
     resText = resText.trim();
     let parsed = { sell_recommended: false, confidence_score: 50, reason: "" };
     try {
       parsed = JSON.parse(resText);
     } catch(e) {
       console.error("Failed to parse JSON for sell analysis:", resText);
       // Fallback robust parsing (in case of extra text or broken JSON)
       const isRecommended = /"sell_recommended"\s*:\s*true/i.test(resText);
       parsed = { 
          sell_recommended: isRecommended,
          confidence_score: 50,
          reason: isRecommended ? "JSON Parsing failed, fallback guess: TRUE" : "JSON Parsing failed, fallback guess: FALSE" 
       };
     }
     
     let recommended = parsed.sell_recommended === true;
     const confidence = parsed.confidence_score || 0;
     let reason = parsed.reason || "이유 불명";

     // 신뢰도 점수(confidence_score)와 변동성(dropFromHighPct)을 결합한 매도 로직
     if (recommended) {
         if (confidence < 70) {
             if (dropFromHighPct >= 2.0) {
                 reason = `(확신도 낮음:${confidence} - 하지만 변동성 위험으로 강제 승인) ` + reason;
             } else {
                 recommended = false;
                 reason = `(매도 취소: 확신도 ${confidence}점 미달, 변동성 안정적) ` + reason;
             }
         } else {
             reason = `(신뢰도 ${confidence}점) ` + reason;
         }
     }
     
     aiSellCache.set(symbol, { lastChecked: Date.now(), sellRecommended: recommended, reason });
     
     addBotLog(`🤖 [AI 청산 판단]: ${recommended ? '🚨 즉시 매도 지시' : '🛡️ 홀딩 (유지)'} (사유: ${reason})`);
     
     return { recommended, reason, confidence };
   } catch(error: any) {
     const errorMsg = error.message || String(error);
     if (errorMsg.includes("429")) {
        aiGlobalRateLimitEnd = Date.now() + 60000;
        addBotLog(`⚠️ AI 청산 감시 중 쿼터 초과(429). 60초간 호출 중지.`);
     } else {
        console.error("❌ AI 매도 분석 오류:", errorMsg.substring(0, 50));
     }
     return { recommended: false, reason: "Error: " + errorMsg.substring(0, 30), confidence: 0 };
   }
}

// ------------------------------------
// 수익금 +20% 격리 및 장부 업데이트 로직
// ------------------------------------
async function handleTakeProfit(symbol: string, sellPrice: number, position: ActivePosition, context?: { trigger: string, stopLossPct?: number, holdTimeMinutes?: number, dropFromHighPct?: number }) {
  const totalSellAmount = sellPrice * position.qty;
  const investedAmount = position.totalInvested || (position.buyPrice * position.qty);
  const rawProfit = totalSellAmount - investedAmount;
  const profitRate = (sellPrice - position.buyPrice) / position.buyPrice;

  if (rawProfit > 0) {
    const reserveAmount = Math.floor(rawProfit * 0.20);
    const reinvestProfit = rawProfit - reserveAmount;

    memory.safeReserve += reserveAmount;
    memory.availableCapital += (position.totalInvested + reinvestProfit);

    addBotLog(`🎉 [익절 성공] 종목: ${symbol}`, sellPrice, profitRate);
    addBotLog(`💵 실현 수익: ${rawProfit.toLocaleString()}원`);
    addBotLog(`🔒 출금용 확보금(+20%): ${reserveAmount.toLocaleString()}원 누적 적립! (총: ${memory.safeReserve.toLocaleString()}원)`);
  } else {
    // 본전 또는 손실
    memory.availableCapital += totalSellAmount;
    addBotLog(`⚠️ [매도 환수] ${symbol} 실현 손익: ${rawProfit.toLocaleString()}원`, sellPrice, profitRate);
  }
  
  memory.positions.delete(symbol);
  memory.save();

  // 매도 후 잔고 동기화 (stale API 데이터 방지를 위해 제거, 로컬에서 캐피탈 가산)
  // setTimeout(() => updateBalance(), 2000); 
  
  // AI 매매 복기 모듈
  if (process.env.GEMINI_API_KEY) {
      if (Date.now() < aiGlobalRateLimitEnd) {
         memory.journals.unshift({
            symbol, name: position.name || symbol, qty: position.qty, buyPrice: position.buyPrice, sellPrice, profitRate, profitAmount: rawProfit, review: "AI 쿼터 초과로 인해 요약이 생략되었습니다.", date: Date.now()
         });
         if (memory.journals.length > 30) memory.journals.pop();
         memory.save();
         return;
      }
      try {
        const canCall = await aiLimiter.waitForTurn('LOW', `복기-${symbol}`);
        if (!canCall) {
            addBotLog(`🤖 [AI 매매 복기 대기열 초과] 패스 (기본형 기록 남김)`);
            memory.journals.unshift({
               symbol, name: position.name || symbol, qty: position.qty, buyPrice: position.buyPrice, sellPrice, profitRate, profitAmount: rawProfit, review: "대기열 초과로 인해 요약이 생성되지 않았습니다.", date: Date.now()
            });
            if (memory.journals.length > 30) memory.journals.pop();
            memory.save();
            return;
        }

        const isWin = rawProfit > 0;
        
        const contextStr = context ? `
- 청산 트리거: ${context.trigger}
${context.stopLossPct !== undefined ? `- 설정된 손절선: ${context.stopLossPct.toFixed(2)}%` : ''}
${context.holdTimeMinutes !== undefined ? `- 보유 시간: ${context.holdTimeMinutes}분` : ''}
${context.dropFromHighPct !== undefined ? `- 최고점 대비 하락률(변동성 지표): ${context.dropFromHighPct.toFixed(2)}%` : ''}
`.trim() : '';

        const reviewPrompt = `
나는 한국 증시 초단타/스윙 자동매매 봇이야. 방금 ${symbol} 종목 포지션을 청산했어.
- 진입가: ${position.buyPrice}원
- 청산가: ${sellPrice}원
- 수익률: ${(profitRate * 100).toFixed(2)}%
- 최종 결과: ${isWin ? '익절' : '손실/타임컷'}${contextStr ? '\n' + contextStr : ''}

나의 이 거래 결과에 대해 왜 이런 결과가 나왔을지 유추해보고, 다음 거래를 위해 어떤 점을 유지하거나 보완하면 좋을지 리스크 관리 관점을 포함하여 2~3문장으로 짧게 피드백해줘.
`;
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: reviewPrompt,
        });
        const reviewText = response.text.trim();
        addBotLog(`🤖 [AI 매매 복기] ${reviewText}`);
        
        memory.journals.unshift({
           symbol, name: position.name || symbol, qty: position.qty, buyPrice: position.buyPrice, sellPrice, profitRate, profitAmount: rawProfit, review: reviewText, date: Date.now()
        });
        if (memory.journals.length > 30) memory.journals.pop(); // 최대 30개 기록 유지
        memory.save();
      } catch (e: any) {
        if (e.message && e.message.includes("429")) {
             aiGlobalRateLimitEnd = Date.now() + 60000;
             addBotLog(`⚠️ AI 복기 생성 중 쿼터 초과(429). 60초간 호출 중지.`);
        }
        memory.journals.unshift({
           symbol, name: position.name || symbol, qty: position.qty, buyPrice: position.buyPrice, sellPrice, profitRate, profitAmount: rawProfit, review: "수동 또는 에러로 인해 요약이 생성되지 않았습니다.", date: Date.now()
        });
        if (memory.journals.length > 30) memory.journals.pop(); // 최대 30개 기록 유지
        memory.save();
      }
  } else {
      memory.journals.unshift({
         symbol, name: position.name || symbol, qty: position.qty, buyPrice: position.buyPrice, sellPrice, profitRate, profitAmount: rawProfit, review: "AI 연동 부족으로 요약이 생성되지 않았습니다.", date: Date.now()
      });
      if (memory.journals.length > 30) memory.journals.pop(); // 최대 30개 기록 유지
      memory.save();
  }
}

// [도구] 분봉/일봉 데이터를 기반으로 지표를 계산하는 헬퍼 함수 (가정)
// 실제 연동 시 KIS API의 'inquire-time-itemchartprice'(분봉조회) 호출 결과를 활용합니다.
async function getTechnicalIndicators(symbol: string, currentPrice: number) {
  try {
    const yfSymbol = `${symbol}.KS`;
    const start = new Date();
    start.setDate(start.getDate() - 150); // 최근 150일 데이터 (일목균형표 52+26을 위해)
    
    // Yahoo Finance 타임아웃 처리 (8초)
    const chartPromise = yahooFinance.chart(yfSymbol, {
      period1: start,
      period2: new Date(),
      interval: "1d",
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Yahoo Finance Timeout")), 8000)
    );

    const chart: any = await Promise.race([chartPromise, timeoutPromise]);

    if (chart && chart.quotes && chart.quotes.length > 26) {
      const quotes = chart.quotes.filter((q: any) => q.close !== null && q.high !== null && q.low !== null);
      const closes = quotes.map((q: any) => q.close);
      const volumes = quotes.map((q: any) => q.volume || 1);
      
      // 거래량 급증 비율 (당일 거래량 / 최근 5일 평균 거래량)
      const currentVolume = volumes[volumes.length - 1] || 1;
      const avgVolume5 = volumes.slice(Math.max(0, volumes.length - 6), -1).reduce((a: number, b: number) => a + b, 0) / 5;
      const volumeRatio = currentVolume / (avgVolume5 || 1);

      // 5일 이동평균선
      const ma5 = closes.slice(-5).reduce((a: number, b: number) => a + b, 0) / 5;
      
      // RSI (단순 연산)
      let ups = 0;
      let downs = 0;
      for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff > 0) ups += diff;
        else downs += Math.abs(diff);
      }
      const rsi = ups === 0 ? 0 : 100 - (100 / (1 + (ups / (downs || 1))));

      // 볼린저 밴드 하단 (20일 평균 - 2표준편차)
      const closes20 = Math.max(20, closes.length) === closes.length ? closes.slice(-20) : closes;
      const ma20 = closes20.reduce((a: number, b: number) => a + b, 0) / closes20.length;
      const stdDev = Math.sqrt(closes20.map((x: number) => Math.pow(x - ma20, 2)).reduce((a, b) => a + b) / closes20.length);
      const bbLower = ma20 - (stdDev * 2);
      
      // 일목균형표 당일 기준 계산
      const getHighLow = (period: number, index: number = quotes.length - 1) => {
         if (index < period - 1) return null;
         const slice = quotes.slice(index - period + 1, index + 1);
         return {
             high: Math.max(...slice.map((q: any) => q.high)),
             low: Math.min(...slice.map((q: any) => q.low))
         };
      };

      let tenkan = currentPrice, kijun = currentPrice, spanA = currentPrice, spanB = currentPrice;
      const hl9 = getHighLow(9);
      if (hl9) tenkan = (hl9.high + hl9.low) / 2;
      const hl26 = getHighLow(26);
      if (hl26) kijun = (hl26.high + hl26.low) / 2;
      
      // 당일의 선행스팬A, B (26일 전의 전환선, 기준선)
      const pastIndex = quotes.length - 1 - 26;
      if (pastIndex >= 0) {
          const pastHl9 = getHighLow(9, pastIndex);
          const pastHl26 = getHighLow(26, pastIndex);
          if (pastHl9 && pastHl26) {
              const pTenkan = (pastHl9.high + pastHl9.low) / 2;
              const pKijun = (pastHl26.high + pastHl26.low) / 2;
              spanA = (pTenkan + pKijun) / 2;
          }
          const pastHl52 = getHighLow(52, pastIndex);
          if (pastHl52) {
              spanB = (pastHl52.high + pastHl52.low) / 2;
          }
      }

      return {
        currentPrice,
        openPrice: quotes[quotes.length - 1].open || currentPrice,
        ma5,
        ma20,
        rsi,
        bbLower,
        tenkan,
        kijun,
        spanA,
        spanB,
        volumeRatio,
        yesterdayHigh: quotes.length >= 2 ? (quotes[quotes.length - 2].high || currentPrice) : currentPrice,
        todayVolume: currentVolume,
        yesterdayVolume: volumes.length >= 2 ? (volumes[volumes.length - 2] || 1) : 1,
        vwap: (quotes[quotes.length - 1].high + quotes[quotes.length - 1].low + closes[closes.length - 1]) / 3 || currentPrice
      };
    }
  } catch (e: any) {
    console.error("Indicator error:", e);
    addBotLog(`⚠️ [지표 오류] ${symbol} 데이터 수집 실패 (${e.message})`);
  }

  // 실패 시 기본 데이터
  return {
    currentPrice: currentPrice,
    openPrice: currentPrice,
    ma5: currentPrice,
    ma20: currentPrice,
    rsi: 50,
    bbLower: currentPrice * 0.95,
    tenkan: currentPrice,
    kijun: currentPrice,
    spanA: currentPrice,
    spanB: currentPrice,
    volumeRatio: 1,
    yesterdayHigh: currentPrice,
    todayVolume: 1,
    yesterdayVolume: 1,
    vwap: currentPrice
  };
}

// ------------------------------------
// 2. 복수 종목 순회 감시 루프
// ------------------------------------
async function monitoringLoop() {
  if (!memory.isRunning) return;
  
  if (!isKoreanMarketOpenStrict()) {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const timeStr = now.toTimeString().split(' ')[0];
    addBotLog(`💤 [장외 시간] 현재 시각 ${timeStr} - 한국 주식 시장이 열려있지 않습니다 (평일 09:00~15:30).`);
    return;
  }
  
  const symbolsToScan = Array.from(new Set([...memory.watchList.keys(), ...memory.positions.keys()]));
  addBotLog(`🔍 총 ${symbolsToScan.length}개 종목 스캔을 시작합니다. (감시+보유)`);
  let scannedCount = 0;
  let matchesCount = 0;

  for (const symbol of symbolsToScan) {
    if (!memory.isRunning) break;
    
    // 기본 설정값 (객체 분해를 통해 타입 안전성 확보)
    const defaultConfig = { 
      symbol, 
      name: symbol, 
      investAmount: 1000000, 
      takeProfitPct: 0.03, 
      stopLossPct: -0.05, 
      useAI: false 
    };
    
    // watchList 또는 positions에서 설정을 가져오되, 부족한 필드는 defaultConfig로 채움
    const config = {
      ...defaultConfig,
      ...(memory.watchList.get(symbol) || {}),
      ...(memory.positions.get(symbol) ? { name: memory.positions.get(symbol)?.name || symbol } : {})
    };

    try {
      // 5종목마다 진행 상황 보고
      if (scannedCount > 0 && scannedCount % 5 === 0) {
        addBotLog(`...진행 중 (${scannedCount}/${symbolsToScan.length})`);
      }

      // API 통신 과부하를 막기 위해 종목당 500ms 대기 (초당 2회 미만)
      await delay(500);

      const stock = await getKisPrice(symbol);
      if (!stock) continue;
      
      // 전역 캐시에 최근 가격 갱신 (UI용)
      (global as any).priceCache = (global as any).priceCache || {};
      (global as any).priceCache[symbol] = { price: stock.price, name: stock.name, time: Date.now() };

      
      scannedCount++;
      const currentPrice = stock.price;
      const position = memory.positions.get(symbol);

      if (position) {
        // 최고가 업데이트 (트레일링 스탑용)
        if (!position.highestPrice || currentPrice > position.highestPrice) {
           position.highestPrice = currentPrice;
           // memory.save(); // 너무 잦은 쓰기를 피하기 위해 생략해도 무방, 나중에 저장됨
        }

        // [상황 A] 보유 중인 종목 감시 (익절/손절/타임컷)
        const profitRate = (currentPrice - position.buyPrice) / position.buyPrice;
        const highestProfitRate = (position.highestPrice - position.buyPrice) / position.buyPrice;
        const dropFromHigh = (position.highestPrice - currentPrice) / position.highestPrice;
        const holdTimeHours = position.buyTime ? (Date.now() - position.buyTime) / (1000 * 60 * 60) : 0;

        // 보유 종목은 매 루프마다 상태 출력 (너무 잦으면 3번에 한번 등으로 조절 가능하지만 현재는 매번)
        addBotLog(`[감시] ${stock.name} ${currentPrice.toLocaleString()}원 (${(profitRate * 100).toFixed(2)}%)`);

        // 트레일링 스탑 (수익이 5% 이상 났을 때, 최고점 대비 2% 이상 하락하면 익절)
        if (highestProfitRate >= 0.05 && dropFromHigh >= 0.02) {
          addBotLog(`🛡️ [트레일링 스탑] ${config.name} 고점 대비 하락 감지하여 안전 익절!`, currentPrice, profitRate);
          const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());
          
          memory.orders.unshift({
            symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty, 
            amount: currentPrice * position.qty, timestamp: Date.now(), 
            status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? 'Trailing Stop' : order.message,
            profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
          });
          if (memory.orders.length > 50) memory.orders.pop();
          memory.save();

          if (order.success) handleTakeProfit(symbol, currentPrice, position, { trigger: '트레일링 스탑', dropFromHighPct: dropFromHigh * 100, holdTimeMinutes: Math.floor(holdTimeHours * 60) });
          else addBotLog(`매도 실패: ${order.message}`);
        }
        else if (profitRate >= config.takeProfitPct) {
          addBotLog(`🚀 [목표가 도달] ${config.name} 익절 매도!`, currentPrice, profitRate);
          const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());
          
          memory.orders.unshift({
            symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty, 
            amount: currentPrice * position.qty, timestamp: Date.now(), 
            status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? 'Take Profit' : order.message,
            profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
          });
          if (memory.orders.length > 50) memory.orders.pop();
          memory.save();

          if (order.success) handleTakeProfit(symbol, currentPrice, position, { trigger: '목표 수익 도달 (익절)', holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
          else addBotLog(`매도 실패: ${order.message}`);
        }
        else if (profitRate <= config.stopLossPct) {
          addBotLog(`⚠️ [손절선 도달] ${config.name} 리스크 컷!`, currentPrice, profitRate);
          const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());
          
          memory.orders.unshift({
            symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty, 
            amount: currentPrice * position.qty, timestamp: Date.now(), 
            status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? 'Stop Loss' : order.message,
            profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
          });
          if (memory.orders.length > 50) memory.orders.pop();
          memory.save();

          if (order.success) handleTakeProfit(symbol, currentPrice, position, { trigger: '손절선 도달 (손절)', stopLossPct: config.stopLossPct * 100, holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
          else addBotLog(`매도 실패: ${order.message}`);
        }
        else if (holdTimeHours >= 24) {
          addBotLog(`⏰ [보유시간 초과] ${config.name} 24시간 도달, 시장가(현재가) 강제 청산식 매도!`, currentPrice, profitRate);
          const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());
          
          memory.orders.unshift({
            symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty, 
            amount: currentPrice * position.qty, timestamp: Date.now(), 
            status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? 'Time Out' : order.message,
            profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
          });
          if (memory.orders.length > 50) memory.orders.pop();
          memory.save();

          if (order.success) handleTakeProfit(symbol, currentPrice, position, { trigger: '최대 보유 가능 시간 초과 (타임컷)', holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
          else addBotLog(`청산 매도 실패: ${order.message}`);
        }
        else if (process.env.GEMINI_API_KEY) {
          const holdTimeMinutes = Math.floor(holdTimeHours * 60);

          // API 과부하 방지 처리는 askGeminiForSell 모듈 안에 aiSellCache 3분 제한으로 반영되어있습니다.

          let aiTriggerReason = "";

          // [트리거 1] 수익 수성 구간
          if (profitRate >= 0.015) {
            aiTriggerReason = "수익 보전 (1.5% 도달, 추가 모멘텀 둔화 여부 판독)";
          } 
          // [트리거 2] 손절 방어 구간
          else if (profitRate <= -0.025) {
            aiTriggerReason = "손절 방어 (-2.5% 하락, 추가 투매 위험 판독)";
          } 
          // [트리거 3] 고점 대비 2% 이상 하락
          else if (dropFromHigh >= 0.02) {
            aiTriggerReason = "고점 대비 하락 (최고가 대비 2% 이상 하락, 하락 추세 전환 판독)";
          }
          // [트리거 4] 기회비용 (시간 컷) 방어 구간
          else if (holdTimeMinutes >= 45 && profitRate < 0.01) {
            aiTriggerReason = "시간 컷 (45분 이상 정체 및 수익률 1% 미만, 재료 소멸 및 기회비용 상실 판독)";
          }

          if (aiTriggerReason !== "") {
             // addBotLog(`\n🔍 [AI 스마트 매도 검사 발동] 종목: ${config.name}`);
             // addBotLog(`👉 발동 사유: ${aiTriggerReason} | 현재 수익률: ${(profitRate * 100).toFixed(2)}%`);
             
             const aiSell = await askGeminiForSell(symbol, stock.name, profitRate * 100, holdTimeMinutes, aiTriggerReason, dropFromHigh * 100);
             if (aiSell.recommended) {
                addBotLog(`🤖 🚨 AI가 조기 매도 지시! 즉시 시장가 청산을 진행합니다. (사유: ${aiTriggerReason})`);
                const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());
                
                memory.orders.unshift({
                  symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty, 
                  amount: currentPrice * position.qty, timestamp: Date.now(), 
                  status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? 'AI Decision' : order.message,
                  aiReason: aiSell.reason || aiTriggerReason,
                  aiConfidence: aiSell.confidence,
                  profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
                });
                if (memory.orders.length > 50) memory.orders.pop();
                memory.save();

                if (order.success) handleTakeProfit(symbol, currentPrice, position, { trigger: `AI 조기 매도 지시 (${aiTriggerReason})`, holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
                else addBotLog(`청산 매도 실패: ${order.message}`);
             }
          }
        }
      } 
      else {
        // [상황 B] 미보유 종목 타점 감시
        const indicators = await getTechnicalIndicators(symbol, currentPrice);
        const { openPrice, ma5, ma20, rsi, bbLower } = indicators;
        
        let strategyMatched = false;
        let matchedStrategyName = "";

        // 현재 한국 시간(KST) 추출 (UTC 기준 서버 시간을 KST로 변환)
        const now = new Date();
        const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
        const hours = kstTime.getUTCHours();
        const minutes = kstTime.getUTCMinutes();
        const currentTime = hours * 100 + minutes;

        // =====================================================================
        // 🔥 [전략 1] 09:00 ~ 09:30: 시초가 거래량 폭발 돌파 매매 (야수의 시간)
        // =====================================================================
        if (currentTime >= 900 && currentTime < 930) {
          const isVolumeExploded = indicators.todayVolume > (indicators.yesterdayVolume * 0.5); // 30분만에 전일 거래량의 50% 돌파
          const isBreakingHigh = currentPrice > indicators.yesterdayHigh; // 전일 고점 돌파

          if (isVolumeExploded && isBreakingHigh) {
            strategyMatched = true;
            matchedStrategyName = "🔥 오전장: 거래량 폭발 돌파";
          }
        }
        // =====================================================================
        // 🛡️ [전략 2] 09:30 ~ 14:30: VWAP + RSI + 일목균형표 눌림목 매매 (방어의 시간)
        // =====================================================================
        else if (currentTime >= 930 && currentTime < 1430) {
          // 1. VWAP 지지: 현재가가 당일 평균단가(VWAP)의 -0.5% ~ +1% 이내
          const vwapGap = (currentPrice - indicators.vwap) / indicators.vwap;
          const isNearVwap = vwapGap >= -0.005 && vwapGap <= 0.01;

          // 2. 보조지표: RSI 과열 해소 (60 이하) & 일목 구름대 위
          const isRsiCooledDown = rsi <= 60; 
          const isAboveCloud = currentPrice > Math.max(indicators.spanA || currentPrice, indicators.spanB || currentPrice);

          if (isNearVwap && isRsiCooledDown && isAboveCloud) {
            strategyMatched = true;
            matchedStrategyName = "🛡️ 중반장: VWAP 및 보조지표 눌림목 지지";
          }
        }
        // =====================================================================
        // 🛑 [전략 3] 14:30 ~ 15:20: 신규 매수 금지 (마의 시간)
        // =====================================================================
        else {
          // 투매가 자주 나오는 오후장 후반부는 신규 매수 차단
          strategyMatched = false; 
        }

        if (strategyMatched) {
          matchesCount++;
          let aiApproved = true;
          let aiReason = "AI 검토 미사용";
          let aiConfidence: number | undefined = undefined;

          if (config.useAI) {
             const result = await analyzeWithAI(symbol, currentPrice, indicators);
             aiApproved = result.approved;
             aiReason = result.reason;
             aiConfidence = result.confidence;
          }

          if (aiApproved && memory.availableCapital >= config.investAmount) {
            addBotLog(`\n⚡ [매수 타점 포착!] 종목: ${config.name} (${symbol})`);
            addBotLog(`🎯 발동 전략: ${matchedStrategyName} | 현재가: ${currentPrice.toLocaleString()}원`);
            
            const qtyToBuy = Math.floor(config.investAmount / currentPrice);
            if (qtyToBuy > 0) {
                addBotLog(`${config.name} ${qtyToBuy}주 매수 주문 전송 중...`);
                const order = await buyOrder(symbol, currentPrice.toString(), qtyToBuy.toString());
                
                memory.orders.unshift({
                  symbol, name: config.name, type: 'BUY', price: currentPrice, qty: qtyToBuy, 
                  amount: currentPrice * qtyToBuy, timestamp: Date.now(), 
                  status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? matchedStrategyName : order.message,
                  aiReason: config.useAI ? aiReason : undefined,
                  aiConfidence: config.useAI ? aiConfidence : undefined
                });
                if (memory.orders.length > 50) memory.orders.pop();
                memory.save();

                if (order.success) {
                    addBotLog(`✅ [매수 성공] 장부 등록 완료! (체결: ${qtyToBuy}주)`, currentPrice, 0);
                    
                    memory.availableCapital -= (currentPrice * qtyToBuy);
                    
                    // KIS API 잔고 동기화는 10분 배치에 맡기고, 로컬 캐시를 즉시 반영합니다.
                    // setTimeout(() => updateBalance(), 2000);

                    memory.positions.set(symbol, {
                    symbol,
                    name: config.name,
                    buyPrice: currentPrice,
                    qty: qtyToBuy,
                    totalInvested: currentPrice * qtyToBuy,
                    buyTime: Date.now(),
                    highestPrice: currentPrice
                  });
                  memory.save();
                } else {
                  addBotLog(`매수 거절: ${order.message}`);
                }
            }
          } else if (aiApproved && memory.availableCapital < config.investAmount) {
            addBotLog(`⚠️ [기회 놓침] ${config.name} 타점이 포착되었으나 예수대기금(${memory.availableCapital.toLocaleString()}원)이 부족합니다.`);
          } else {
            addBotLog(`🤖 AI 진입 거부: ${config.name} (${aiReason})`);
          }
        }
      }
    } catch (error: any) {
      addBotLog(`❌ [${symbol}] 감시 중 에러: ${error.message}`);
    }
  }
  
  if (scannedCount > 0) {
    addBotLog(`✅ 스캔 완료: ${scannedCount}종목 체크됨 (발견된 타점: ${matchesCount}개)`);
  }
}

async function updateBalance() {
  const res = await getKisBalance();
  if (res && !res.error) {
    memory.availableCapital = res.balance;
    memory.totalEquity = res.totalEquity;
    // 포지션 동기화
    if (res.positions) {
      const apiSymbols = new Set(res.positions.map((p: any) => p.symbol));
      for (const key of memory.positions.keys()) {
        if (!apiSymbols.has(key)) {
          memory.positions.delete(key);
        }
      }
      
      res.positions.forEach((p: any) => {
         if (!p.totalInvested) p.totalInvested = p.buyPrice * p.qty;
         if (!p.buyTime) p.buyTime = Date.now();
         if (!memory.positions.has(p.symbol)) {
            memory.positions.set(p.symbol, p);
         } else {
            // 기존 포지션 업데이트 (수량 등)
            const existing = memory.positions.get(p.symbol);
            existing.qty = p.qty;
            existing.buyPrice = p.buyPrice;
            if (p.name) existing.name = p.name;
         }
      });
    }

    memory.save();
    addBotLog(`💰 [계좌 동기화 성공] 예수금: ${res.balance.toLocaleString()}원, 총평가액: ${res.totalEquity.toLocaleString()}원`);
    return true;
  }
  
  const errMsg = res?.error || "알 수 없는 에러";
  addBotLog(`❌ [잔고 동기화 실패] ${errMsg}`);
  return false;
}

async function startAutoBot() {
  if (memory.isRunning) {
    addBotLog("ℹ️ 봇이 이미 가동 중입니다.");
    return;
  }
  
  (memory as any).isStarting = true;
  memory.isRunning = true;
  
  const isVts = process.env.KIS_URL ? process.env.KIS_URL.includes("vts") : true; 
  addBotLog(`🚀 봇 가동 시작! (${isVts ? '모의투자' : '실전투자'} 계좌 연결 중...)`);
  
  try {
    const success = await updateBalance();
    if (!success) {
      addBotLog("⚠️ 초기 잔고 동기화에 실패했습니다. API 키, 계좌번호, 장 운영 여부를 확인하세요. 안전을 위해 봇 가동을 일시 중단합니다.");
      memory.isRunning = false;
    } else {
      addBotLog("✅ 잔고 동기화 성공! 이제 30초 간격으로 매수/매수 타점을 스캔합니다.");
    }
  } catch (err: any) {
    addBotLog(`❌ 봇 기동 중 치명적 오류 발생: ${err.message}`);
    memory.isRunning = false;
  } finally {
    (memory as any).isStarting = false;
  }
}

// 10분마다 잔고 강제 동기화 (오차 누적 방지)
cron.schedule("0 */10 * * * *", () => {
  if (memory.isRunning) {
    updateBalance();
  }
});

// 매월-금요일 오후 15시 20분에 자동으로 실행되는 스케줄러 (장마감 직전 스냅샷)
cron.schedule('20 15 * * 1-5', async () => {
  console.log("⏱️ [장마감 자산 스냅샷] 오늘의 투자 성과를 장부에 기록합니다...");

  // 1. 현재 보유 주식의 총 평가금액 계산
  let totalPositionValue = 0;
  for (const [symbol, pos] of memory.positions) {
    await delay(500);
    const stock = await getKisPrice(symbol);
    const currentPrice = stock ? stock.price : pos.buyPrice; // 현재가 조회 (실패 시 매수가로 대체)
    totalPositionValue += (currentPrice * pos.qty);
  }

  // 2. 총자산 합계 = 운용 풀 잔고 + 안전 금고 잔고 + 주식 평가금
  const currentTotal = memory.availableCapital + memory.safeReserve + totalPositionValue;
  const todayStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })).toISOString().split('T')[0];

  // 3. 역사 장부에 추가
  const newSnapshot: AssetSnapshot = {
    date: todayStr,
    totalEquity: currentTotal,
    operationPool: memory.availableCapital,
    safeVault: memory.safeReserve
  };

  memory.history.push(newSnapshot);
  
  // 4. 로컬 JSON 파일에 영구 백업 및 Firestore에 기록
  memory.save();
  saveSnapshotToFirestore(newSnapshot).catch(e => console.error("Firestore sync error:", e));

  // 5. 슬랙으로 오늘 하루 최종 결산 보고서 발송
  const prevTotal = memory.history.length >= 2 ? memory.history[memory.history.length - 2].totalEquity : currentTotal;
  const dailyNet = currentTotal - prevTotal;
  const dailyPct = ((dailyNet / prevTotal) * 100).toFixed(2);
  const sign = dailyNet >= 0 ? '📈 +' : '📉 ';

  const slackMsg = `📝 *[일일 마감 결산 리포트]*\n▪️ 날짜: ${todayStr}\n▪️ 총 자산: ${currentTotal.toLocaleString()}원\n▪️ 금일 순손익: ${sign}${dailyNet.toLocaleString()}원 (${dailyPct}%)`;
  addBotLog(`⏱️ [장마감 스냅샷] 총 자산: ${currentTotal.toLocaleString()}원`);
  sendSlackNotification(slackMsg);
});

function stopAutoBot() {
  memory.isRunning = false;
  (memory as any).isStarting = false;
  addBotLog("⏸️ 봇 가동 중지됨");
}

import { runBacktest } from './backtest.ts';

// ------------------------------------
// API Routes
// ------------------------------------

app.get("/api/backtest", async (req, res) => {
  try {
    const symbol = req.query.symbol as string;
    const days = parseInt(req.query.days as string || "365");
    const initialCapital = parseInt(req.query.capital as string || "10000000");
    
    if (!symbol) return res.status(400).json({ error: "Missing symbol param" });

    const result = await runBacktest(symbol, days, initialCapital, 0.03, -0.05);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/bot/status", async (req, res) => {
  let targetSymbol = "005930";
  let targetPrice = 1000000;
  let useAI = true;
  let profitTarget = 0.03;
  let lossLimits = -0.05;
  
  if (memory.watchList.size > 0) {
    const firstConfig = Array.from(memory.watchList.values())[0];
    targetSymbol = firstConfig.symbol;
    targetPrice = firstConfig.investAmount;
    useAI = firstConfig.useAI;
    profitTarget = firstConfig.takeProfitPct;
    lossLimits = firstConfig.stopLossPct;
  }
  
  // 무한 로딩 (API Rate Limit Limit)의 주범이었던 getKisBalance() 동기식 호출을 
  // 매초 실행되는 폴링(Status Endpoint)에서 제거하고 장부(memory)에 저장된 값만 반환합니다.
  
  // 현재 보유 중인 포지션들의 현재가 조회 (단순히 캐시만 사용, API 백그라운드 호출 완전 제거)
  const enhancedPositions = Array.from(memory.positions.values()).map((pos) => {
    let currentPrice = pos.buyPrice;
    
    const localMatch = KOSPI_TOP_20.find(s => s.symbol === pos.symbol);
    let stockName = localMatch ? localMatch.name : pos.symbol;
    
    if ((global as any).priceCache && (global as any).priceCache[pos.symbol]) {
      currentPrice = (global as any).priceCache[pos.symbol].price;
      if ((global as any).priceCache[pos.symbol].name) {
         stockName = (global as any).priceCache[pos.symbol].name;
      }
    } else {
      // 캐시가 없으면 기본값 세팅 (API 직접 호출 안함)
      (global as any).priceCache = (global as any).priceCache || {};
      (global as any).priceCache[pos.symbol] = { price: pos.buyPrice, name: stockName, time: Date.now() };
    }
    
    const profitRate = (currentPrice - pos.buyPrice) / pos.buyPrice;
    const profitAmount = (currentPrice - pos.buyPrice) * pos.qty;
    
    return {
      ...pos,
      name: stockName,
      currentPrice,
      profitRate,
      profitAmount
    };
  });

  res.json({
    isRunning: memory.isRunning,
    targetSymbol,
    targetPrice,
    tradeQty: 1,
    profitTarget,
    lossLimits,
    useAI,
    logs: memory.logs,
    capital: memory.availableCapital,
    totalEquity: memory.totalEquity,
    reserve: memory.safeReserve,
    positions: enhancedPositions,
    journals: memory.journals,
    orders: (memory.orders || []).slice(0, 50),
    history: memory.history,
    watchList: Array.from(memory.watchList.values())
  });
});

app.post("/api/bot/config", async (req, res) => {
  const { action, symbol, price, qty, profitTarget, lossLimits, useAI } = req.body;
  
  if (action === "START") {
    if (memory.isRunning) return res.json({ success: true, isRunning: true });

    memory.watchList.clear(); // 초기화 후 필터대기
    startAutoBot();
    addBotLog(`🚀 봇 가동 시작! 실시간 퀀트 스캐닝을 통해 조건에 맞는 종목(시총 1천억~2조)을 탐색 중입니다 (1~2분 소요)...`);
    
    // Non-blocking background scan
    res.json({ success: true, isRunning: true });

    setTimeout(async () => {
      try {
          if (!memory.isRunning) return;
          
          const filteredStocks = await getFilteredTopStocks();
          
          if (filteredStocks.length > 0) {
            memory.watchList.clear(); // 필터링 결과로 교체
            for (const st of filteredStocks) {
              memory.watchList.set(st.symbol, {
                symbol: st.symbol,
                name: st.name,      
                investAmount: Number(price) || 1000000, 
                takeProfitPct: Number(profitTarget) || 0.03,
                stopLossPct: Number(lossLimits) || -0.05,
                useAI: useAI !== undefined ? useAI : true
              });
            }
            addBotLog(`🚀 퀀트 필터링 완료: 주도주 ${filteredStocks.length}개로 감시 풀이 업데이트되었습니다.`);
            memory.save();
          } else {
            addBotLog(`⚠️ 필터링 결과 매매 적합 종목이 없습니다.`);
          }
      } catch(e) {
          addBotLog(`⚠️ 실시간 필터링 중 오류가 발생했습니다. 잠시 후 봇을 껐다 켜주세요.`);
      }
    }, 0);
    return;
  } else if (action === "STOP") {
    stopAutoBot();
  }
  
  res.json({ success: true, isRunning: memory.isRunning });
});

app.get("/api/kis/balance", async (req, res) => {
  try {
    const result = await getKisBalance();
    if (result && !result.error) {
      memory.availableCapital = result.balance;
      memory.totalEquity = result.totalEquity;
      const apiSymbols = new Set(result.positions.map((p: any) => p.symbol));
      for (const key of memory.positions.keys()) {
        if (!apiSymbols.has(key)) {
          memory.positions.delete(key);
        }
      }
      
      result.positions.forEach((p: any) => {
         if (!p.totalInvested) p.totalInvested = p.buyPrice * p.qty;
         if (!p.buyTime) p.buyTime = Date.now();
         if (!memory.positions.has(p.symbol)) {
            memory.positions.set(p.symbol, p);
         } else {
            const existing = memory.positions.get(p.symbol);
            existing.qty = p.qty;
            existing.buyPrice = p.buyPrice;
            if (p.name) existing.name = p.name;
         }
      });
      memory.save();
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to get KIS balance" });
  }
});

// API Routes
app.get("/api/stock/:symbol", async (req, res) => {
  try {
    let { symbol } = req.params;
    
    // 한글이 포함된 경우 (예: 삼성전자), 자동 검색 후 가장 매칭되는 심볼로 치환
    if (/[가-힣]/.test(symbol)) {
       const localMatch = KOSPI_TOP_20.find(s => s.name.includes(symbol as string));
       if (localMatch) {
          symbol = localMatch.symbol;
       } else {
          return res.status(404).json({ error: "No matching stock found locally." });
       }
    }

    // Yahoo Finance requires .KS or .KQ suffix for Korean stocks
    const yfSymbol = /^\d{6}$/.test(symbol) ? `${symbol}.KS` : symbol;

    // KIS API로부터 실시간 가격 및 이름 가져오기
    const kisQuote = await getKisPrice(symbol);
    
    // Yahoo Finance에서는 과거 차트 데이터만 가져오기
    const quote = kisQuote ? {
      regularMarketPrice: kisQuote.price,
      displayName: kisQuote.name,
      longName: kisQuote.name
    } : null;
    
    let chartQuotes: any[] = [];
    try {
      const start = new Date();
      start.setDate(start.getDate() - 150); 
      
      const chartPromise = yahooFinance.chart(yfSymbol, {
        period1: start,
        period2: new Date(),
        interval: "1d",
      });

      const timeoutPromise = new Promise((_, reject) => {
        const id = setTimeout(() => reject(new Error("Yahoo Finance Chart Timeout")), 8000);
        // Clear timeout if the other promise finishes
        chartPromise.then(() => clearTimeout(id)).catch(() => clearTimeout(id));
      });
      
      const chart: any = await Promise.race([chartPromise, timeoutPromise]);
      
      if (chart && chart.quotes) {
         // 일목균형표 계산
         const quotes = chart.quotes.filter((q: any) => q.close !== null && q.high !== null && q.low !== null);
         const getHighLow = (period: number, index: number) => {
             if (index < period - 1) return null;
             const slice = quotes.slice(index - period + 1, index + 1);
             return {
                 high: Math.max(...slice.map((q: any) => q.high)),
                 low: Math.min(...slice.map((q: any) => q.low))
             };
         };

         for (let i = 0; i < quotes.length; i++) {
             const hl9 = getHighLow(9, i);
             if (hl9) quotes[i].tenkan = (hl9.high + hl9.low) / 2;

             const hl26 = getHighLow(26, i);
             if (hl26) quotes[i].kijun = (hl26.high + hl26.low) / 2;
             
             // SpanA, SpanB는 26일 전의 데이터로 현재의 SpanA, SpanB를 계산
             if (i >= 26) {
                 const past = quotes[i - 26];
                 if (past && past.tenkan && past.kijun) {
                     quotes[i].spanA = (past.tenkan + past.kijun) / 2;
                 }
                 const hl52_past = getHighLow(52, i - 26);
                 if (hl52_past) {
                     quotes[i].spanB = (hl52_past.high + hl52_past.low) / 2;
                 }
             }
         }
         
         // 26일 미래(선행스팬) 연장
         const lastQuotes = quotes[quotes.length - 1];
         if (lastQuotes) {
             let lastDate = new Date(lastQuotes.date);
             for(let k=1; k<=26; k++) {
                 lastDate.setDate(lastDate.getDate() + 1); // 단순 1일씩 증가 (휴일 무시)
                 const pastIndex = quotes.length - 1 - 26 + k;
                 let spanA = null, spanB = null;
                 if (pastIndex >= 0) {
                     const past = quotes[pastIndex];
                     if (past.tenkan && past.kijun) spanA = (past.tenkan + past.kijun) / 2;
                     const hl52_past = getHighLow(52, pastIndex);
                     if (hl52_past) spanB = (hl52_past.high + hl52_past.low) / 2;
                 }
                 quotes.push({ date: new Date(lastDate), spanA, spanB });
             }
         }
         chartQuotes = quotes;
         
         // 현재가(KIS)를 마지막 시세 데이터에 반영 (차트 최신 갱신)
         if (kisQuote) {
             let lastRealQuoteIdx = -1;
             for (let i = chartQuotes.length - 1; i >= 0; i--) {
                if (chartQuotes[i].close !== undefined && chartQuotes[i].close !== null) {
                   lastRealQuoteIdx = i;
                   break;
                }
             }
             if (lastRealQuoteIdx !== -1) {
                // 당일 데이터 갱신
                const lastQ = chartQuotes[lastRealQuoteIdx];
                const qDate = new Date(lastQ.date).toISOString().split('T')[0];
                const tDate = new Date().toISOString().split('T')[0];
                if (qDate === tDate) {
                   chartQuotes[lastRealQuoteIdx].close = kisQuote.price;
                } else {
                   // 새 날짜인 경우, 배열의 lastRealQuoteIdx + 1 에 끼워넣기 (미래 스팬 이전)
                   chartQuotes.splice(lastRealQuoteIdx + 1, 0, {
                       date: new Date().toISOString(),
                       close: kisQuote.price,
                       open: kisQuote.price, // 근사치
                       high: kisQuote.price,
                       low: kisQuote.price
                   });
                }
             }
         }
      }
    } catch (e) {
      console.error("Chart fetch error:", e);
    }

    res.json({ quote, chart: chartQuotes });
  } catch (error) {
    console.error("Stock API Error:", error);
    res.status(500).json({ error: "Failed to fetch stock data" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Query required" });
    }
    
    if (/[가-힣]/.test(q)) {
      const locals = KOSPI_TOP_20.filter(s => s.name.includes(q))
         .map(s => ({ symbol: s.symbol, name: s.name, exchange: 'KSC' }));
      return res.json(locals);
    }

    const results: any = await yahooFinance.search(q);
    
    let quotes = (results.quotes || []).filter((q: any) => q.symbol && (q.symbol.endsWith('.KS') || q.symbol.endsWith('.KQ')));
    if (quotes.length === 0) quotes = results.quotes || [];

    const formatted = quotes.filter((q: any) => q.symbol).slice(0, 10).map((q: any) => ({
      symbol: q.symbol.split('.')[0],
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange
    }));
    
    res.json(formatted);
  } catch (error) {
    console.error("Search failed for q=", req.query.q, error);
    res.status(500).json({ error: "Search failed: " + (error as any).message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { symbol, price, history, isSellCheck } = req.body;
    
    if (Date.now() < aiGlobalRateLimitEnd) {
       return res.status(503).json({ error: "AI Rate Limit Exceeded. Quota limits are active. Please try again later (60s cooldown)." });
    }
    
    const prompt = isSellCheck ? `
      You are a professional stock market analyst.
      Evaluate whether a user holding ${symbol} should SELL or HOLD right now.
      Current Price: ${price}
      Recent history (JSON, includes Ichimoku attributes: tenkan, kijun, spanA, spanB): ${JSON.stringify(history.slice(-10))}
      
      Provide a brief analysis on whether they should sell to take profit / cut losses, or hold for better opportunities.
      Format your reasoning clearly in Markdown.
      
      Return your answer in the following JSON format ONLY:
      {
        "recommendation": "SELL" or "HOLD",
        "analysis": "Your markdown formatted analysis text here",
        "confidence_score": <an integer between 1 and 100 representing your confidence>
      }
    ` : `
      You are a professional stock market analyst. 
      Analyze the following stock: ${symbol}
      Current Price: ${price}
      Recent history (JSON, includes Ichimoku attributes: tenkan, kijun, spanA, spanB): ${JSON.stringify(history.slice(-10))}
      
      Provide a brief analysis including:
      1. Market Sentiment (Bullish/Bearish/Neutral)
      2. Key Technical Observation (Must include Ichimoku Cloud analysis - e.g., Kumo breakout, Tenkan/Kijun cross)
      3. Potential "Strategy" for a trading bot (e.g., "Buy if price drops below X, Sell if it hits Y")
      
      Keep it professional and concise. Formatting: Markdown.
      
      Return your answer in the following JSON format ONLY:
      {
        "analysis": "Your markdown formatted analysis text here",
        "confidence_score": <an integer between 1 and 100 representing your confidence>
      }
    `;

    const canCall = await aiLimiter.waitForTurn('LOW', `수동분석-${symbol}`);
    if (!canCall) {
       return res.status(503).json({ error: "AI Rate Limit Exceeded. Please try again later." });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    let resText = response.text || "{}";
    const match = resText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
        resText = match[1];
    }
    resText = resText.trim();
    let parsed: any = { analysis: "분석 실패", confidence_score: 0 };
    try {
      parsed = JSON.parse(resText);
    } catch(e) {
      console.error("Failed to parse JSON for manual analysis:", resText);
      parsed.analysis = resText;
    }

    res.json({ 
      analysis: parsed.analysis, 
      confidence_score: parsed.confidence_score,
      recommendation: parsed.recommendation
    });
  } catch (error) {
    console.error("AI Analysis Error:", error);
    res.status(500).json({ error: "AI Analysis failed" });
  }
});

app.post("/api/bot/snapshot/manual", async (req, res) => {
  try {
    let totalPositionValue = 0;
    for (const [symbol, pos] of memory.positions) {
      await delay(500);
      const stock = await getKisPrice(symbol);
      const currentPrice = stock ? stock.price : pos.buyPrice;
      totalPositionValue += (currentPrice * pos.qty);
    }
    const currentTotal = memory.availableCapital + memory.safeReserve + totalPositionValue;
    const todayStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })).toISOString().split('T')[0];
    
    // 이미 오늘 스냅샷이 있다면 덮어쓰거나, 아니면 추가
    const existingIdx = memory.history.findIndex(h => h.date === todayStr);
    const newSnapshot: AssetSnapshot = {
      date: todayStr,
      totalEquity: currentTotal,
      operationPool: memory.availableCapital,
      safeVault: memory.safeReserve
    };

    if (existingIdx >= 0) {
      memory.history[existingIdx] = newSnapshot;
    } else {
      memory.history.push(newSnapshot);
    }
    
    memory.save();
    saveSnapshotToFirestore(newSnapshot).catch(() => {});
    res.json({ success: true, snapshot: newSnapshot });
  } catch (e) {
    res.status(500).json({ error: "Failed to create snapshot" });
  }
});

app.head("/api/bot/ping", (req, res) => {
  res.status(200).end();
});

// Vite Middleware
async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";
  console.log(`Starting server in ${isProduction ? 'production' : 'development'} mode...`);

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Determine the dist path relative to the process CWD
    const distPath = path.join(process.cwd(), 'dist');
    
    console.log(`Serving static files from: ${distPath}`);
    
    // Serve static assets first
    app.use(express.static(distPath));
    
    // Fallback for SPA
    app.get('*', (req, res) => {
      // If the request is for an API route that wasn't handled, return 404
      if (req.url.startsWith('/api/')) {
        return res.status(404).json({ error: "API route not found" });
      }

      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        // Retry with relative path to __dirname as fallback
        const fallbackPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(fallbackPath)) {
          res.sendFile(fallbackPath);
        } else {
          res.status(404).send(`Production index.html not found. Checked: ${indexPath} and ${fallbackPath}`);
        }
      }
    });
  }

  // Global Error Handler Middleware
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("🔥 [Global Error Handler] Caught exception:", err);
    sendSlackNotification(`🚨 [*Unhandled Exception*]\n> *Message*: ${err.message || String(err)}\n> *Path*: ${req.path}\n\`\`\`${err.stack || ""}\`\`\``);
    res.status(500).json({ error: "Internal Server Error" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
