process.env.TZ = 'Asia/Seoul'; // 전체 Date 객체 KST 고정 (최상단 필수)

import express from "express";
import "express-async-errors";
import basicAuth from "express-basic-auth";
import path from "path";
import { createServer as createViteServer } from "vite";
import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { getKisPrice, getKisBalance, buyOrder, sellOrder, sendSlackNotification, getFilteredTopStocks, getKisMinuteBars, getKospiStatus, getKisDailyBars } from "./server/kisService.ts";
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

// 대시보드 Basic Auth (.env에서 설정)
const dashUser = process.env.DASHBOARD_USER;
const dashPass = process.env.DASHBOARD_PASS;
if (dashUser && dashPass) {
  app.use(basicAuth({
    users: { [dashUser]: dashPass },
    challenge: true,
    realm: "StockBot Dashboard",
  }));
}

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
import { saveSnapshotToFirestore, saveTradeToFirestore, saveLessonsToFirestore, getLessonsFromFirestore, saveMemoryToFirestore, loadMemoryFromFirestore } from "./server/firebase.ts";

let isLoopRunning = false;

// ─── 트레이딩 핵심 상수 ─────────────────────────────────────────────────────
const DEFAULT_PROFIT_TARGET   = 0.03;   // 기본 익절 목표 (3%)
const DEFAULT_STOP_LOSS       = -0.03;  // 기본 손절선 (-3%)
const DEFAULT_INVEST_AMOUNT   = 1_000_000; // 기본 1회 투자금 (100만원)
const TRAILING_STOP_DROP      = 0.015;  // 트레일링 스탑 낙폭 (고점 대비 1.5%)
const SAFE_VAULT_RATIO        = 0.20;   // 수익금 안전금고 적립 비율 (20%)
const KOSPI_DOWN_THRESHOLD    = -1.5;   // KOSPI 하락 경보 임계값 (-1.5%)
const MAX_POSITIONS           = 5;      // 전체 최대 보유 종목 수
const MAX_STRATEGY_A_POSITIONS = 2;     // 기법 A 최대 보유 종목 수
// 모의투자 2주 관찰 모드 (2026-05-20~): 전략 전체 ON → 실거래 데이터 수집 후 재조정
const ENABLED_STRATEGIES: Record<string, boolean> = {
  A: true,  // 승률 49.5%, 평균수익 +0.38%
  B: true,  // 승률 58.0%, 평균수익 -0.38% (손익비 역전 여부 실거래 확인)
  C: true,  // 승률 52.4%, 평균수익 +0.58%
  D: true,  // 승률 49.5%, 평균수익 +0.39%
  E: true,  // 승률 46.9%, 평균수익 +0.45%
  F: true,  // 승률 52.1%, 평균수익 +0.69%
  G: true,  // 승률 48.1%, 평균수익 +0.19%
  H: true,  // 승률 50.5%, 평균수익 +0.52%
  I: true,  // 승률 48.9%, 평균수익 +0.48%
  J: true,  // 승률 50.0%, 평균수익 +0.22%
  K: true,  // 승률 47.4%, 평균수익 -0.05%
};

const AI_SELL_TRIGGER_PROFIT  = 0.025;  // AI 매도 검토: 수익 2.5% 이상 (1.5%→2.5%, 손익비 개선)
const AI_SELL_TRIGGER_LOSS    = -0.025; // AI 매도 검토: 손실 -2.5% 이하
const AI_SELL_TRIGGER_DROP    = 0.02;   // AI 매도 검토: 고점 대비 2% 낙폭
const AI_SELL_TRIGGER_MINUTES = 60;     // AI 시간컷: 60분 정체 (45분→60분, 추세 여유)
// ──────────────────────────────────────────────────────────────────────────────

let kospiCache: { price: number; changeRate: number; isDown: boolean; updatedAt: number } | null = null;
const KOSPI_CACHE_TTL = 3 * 60 * 1000;

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

// 장 마감 후 교훈 추출 크론 (평일 KST 15:40)
cron.schedule("40 15 * * 1-5", async () => {
  addBotLog("📚 [교훈 추출 크론] 장 마감 후 복기 분석을 시작합니다...");
  await extractAndSaveLessons().catch((e: any) => console.error("Lesson cron error:", e));
});

// 서버 시작 시 Firestore에서 교훈 로드
getLessonsFromFirestore().then(l => {
  if (l) {
    memory.lessons = l;
    console.log("📚 Firestore에서 AI 교훈을 로드했습니다.");
  }
}).catch((e: any) => console.error("Lessons load error:", e));

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
  strategyName?: string;
  maxPaperProfit?: number; // 진입 후 최고 수익률 (나중에 최적 익절 타이밍 분석용)
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
  strategyName?: string;
  holdTimeMinutes?: number; // 보유 시간 (전략별 최적 타이밍 분석용)
  maxPaperProfit?: number;  // 진입 후 최고 수익률 (익절 타이밍 분석용)
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
  public isStarting: boolean = false;
  public intervalId: NodeJS.Timeout | null = null;
  public logs: string[] = [];
  public journals: TradeJournal[] = [];
  public orders: TradeOrder[] = [];
  public history: AssetSnapshot[] = [];
  public lessons: string = "";

  public save() {
    try {
      const data = {
        watchList: Array.from(this.watchList.entries()),
        positions: Array.from(this.positions.entries()),
        availableCapital: this.availableCapital,
        safeReserve: this.safeReserve,
        totalEquity: this.totalEquity,
        isRunning: this.isRunning,
        journals: this.journals,
        orders: this.orders,
        history: this.history,
        lessons: this.lessons,
        logs: this.logs.slice(-200),
      };
      // 로컬 JSON (빠른 캐시)
      fs.writeFileSync('./bot-memory.json', JSON.stringify(data, null, 2));
      // Firestore (영구 백업, fire-and-forget)
      saveMemoryToFirestore(data).catch(e => console.error('[Firestore] 메모리 저장 실패:', e));
    } catch (e) {
      console.error('Failed to save memory', e);
    }
  }

  public localLoadOk = false;

  public load() {
    try {
      if (fs.existsSync('./bot-memory.json')) {
        const data = JSON.parse(fs.readFileSync('./bot-memory.json', 'utf8'));
        this._applyData(data);
        this.localLoadOk = true;
        console.log('[Memory] 로컬 JSON 로드 완료');
      }
    } catch (e) {
      console.error('[CRITICAL] bot-memory.json 로드 실패 → Firestore에서 복구 시도:', e);
    }
  }

  public async loadFromFirestore(): Promise<boolean> {
    try {
      const data = await loadMemoryFromFirestore();
      if (!data) return false;
      this._applyData(data);
      // 복구된 데이터를 로컬 JSON에도 즉시 저장
      fs.writeFileSync('./bot-memory.json', JSON.stringify({
        ...data,
        watchList: Array.from(this.watchList.entries()),
        positions: Array.from(this.positions.entries()),
      }, null, 2));
      console.log('[Memory] Firestore에서 복구 완료');
      return true;
    } catch (e) {
      console.error('[Memory] Firestore 복구 실패:', e);
      return false;
    }
  }

  private _applyData(data: any) {
    this.watchList = new Map(data.watchList || []);
    this.positions = new Map(data.positions || []);
    this.availableCapital = data.availableCapital || 5000000;
    this.safeReserve = data.safeReserve || 0;
    this.totalEquity = data.totalEquity || 0;
    this.isRunning = data.isRunning || false;
    this.journals = (data.journals || []).map((j: any) => {
      if (j.profitAmount === null || j.profitAmount === undefined) {
        j.profitAmount = (j.sellPrice && j.buyPrice && j.qty)
          ? (j.sellPrice - j.buyPrice) * j.qty : 0;
      }
      return j;
    });
    this.orders = data.orders || [];
    this.history = data.history || [];
    this.lessons = data.lessons || "";
    this.logs = data.logs || [];
  }
}

export const memory = new TradingMemory();
memory.load(); // 로컬 JSON 우선 로드

// 로컬 JSON 로드 실패 시 Firestore에서 복구 후 자동 재시작 흐름 진입
if (!memory.localLoadOk) {
  memory.loadFromFirestore().then(ok => {
    if (ok) addBotLog('🔥 [Firestore 복구] 로컬 JSON 손상 → Firestore에서 메모리 복구 완료');
    else addBotLog('⚠️ [초기화] Firestore 복구도 실패 — 빈 상태로 시작합니다');
  });
}

// 이전 실행 상태가 isRunning=true였으면 서버 재시작 후 자동 재가동
if (memory.isRunning) {
  memory.isRunning = false; // startAutoBot 진입 가능하도록 리셋
  setTimeout(async () => {
    console.log('[자동 재시작] 이전 봇 상태(isRunning=true) 감지 → 자동 재가동 시작...');
    addBotLog('🔄 [자동 재시작] 서버 재시작 감지. 봇 상태를 복구합니다...');
    await startAutoBot();
    if (memory.isRunning) {
      addBotLog('✅ [자동 재시작 완료] 봇이 정상적으로 재가동되었습니다.');
      // 저장된 watchList가 있으면 그대로 사용, 없으면 재탐색
      if (memory.watchList.size === 0) {
        addBotLog('♻️ watchList가 비어있어 종목 재탐색을 시작합니다...');
        getFilteredTopStocks().then(stocks => {
          if (stocks.length > 0) {
            memory.watchList.clear();
            for (const st of stocks) {
              memory.watchList.set(st.symbol, {
                symbol: st.symbol,
                name: st.name,
                investAmount: DEFAULT_INVEST_AMOUNT,
                takeProfitPct: DEFAULT_PROFIT_TARGET,
                stopLossPct: DEFAULT_STOP_LOSS,
                useAI: true
              });
            }
            addBotLog(`✅ 재시작 후 종목 재탐색 완료: ${stocks.length}개`);
            memory.save();
          }
        }).catch(e => addBotLog(`⚠️ 재시작 종목 탐색 실패: ${e.message}`));
      } else {
        addBotLog(`📋 저장된 watchList ${memory.watchList.size}개 종목 그대로 사용`);
      }
    }
  }, 8000); // 잔고 초기 동기화(5초) 후 여유 두고 8초에 실행
}

// 서버 부팅 시 잔고 한 번 시도 (실패해도 무관)
setTimeout(() => {
  getKisBalance().then(res => {
    if (res !== null && !res.error) {
      memory.availableCapital = res.balance;
      memory.totalEquity = res.totalEquity;
      // 실계좌 포지션과 memory 동기화 (API가 0 반환 시엔 로컬 유지 — VTS 불일치 방지)
      if (res.positions && res.positions.length > 0) {
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
             if (existing) {
               existing.qty = p.qty;
               existing.buyPrice = p.buyPrice;
               if (p.name) existing.name = p.name;
             }
          }
        });
      }
      console.log(`[초기화] KIS 잔고 동기화 완료: ${res.balance}`);
    }
  }).catch(err => {
    console.error("[초기화] 잔고 동기화 에러:", err.message);
  });
}, 5000);

function isKoreanMarketOpenStrict() {
  const krTime = new Date();
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
  const timestamp = new Date().toLocaleString("ko-KR", { hour12: false });
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
      if (indicators.rsi < 28) {
         return { approved: true, reason: "AI 쿼터 초과 쿨다운 중 (RSI 과매도 자동 승인)", confidence: 80 };
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
     
     const lessonsBlock = memory.lessons
       ? `\n[📚 과거 복기 분석으로 도출된 AI 교훈 — 반드시 참고]\n${memory.lessons}\n`
       : "";
     const recentJournals = memory.journals.slice(0, 5);
     const journalsText = recentJournals.length > 0
       ? "\n[최근 매매 복기 (최신 5건)]\n" + recentJournals.map(j => `- ${j.symbol} [${j.strategyName || '?'}] ${(j.profitRate*100).toFixed(1)}%: ${j.review}`).join('\n')
       : "";

      const stockName = memory.watchList.get(symbol)?.name || symbol;
      const prompt = `
        당신은 한국 주식 시장의 단타(스캘핑/데이 트레이딩) 최고 전문가입니다.
        현재 '${stockName}' 종목이 알고리즘상 매수 타점에 도달했습니다.
        아래 제공된 오늘자 최신 뉴스와 시장 분위기(검색 허용)를 분석하여 당일 진입해도 좋은지 판단해주세요.

        ${lessonsBlock}${journalsText}

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
          tools: [{ googleSearch: {} }]
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
       if (indicators.rsi < 28) {
          addBotLog(`💡 AI 쿼터 초과(429)로 인해 RSI 과매도 기반 조건부 진입을 시도합니다. (RSI: ${indicators.rsi.toFixed(1)})`);
          return { approved: true, reason: "AI 쿼터 초과 (RSI 과매도 기반 자동 승인)", confidence: 80 };
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
  currentPrice: number,
  currentProfitPct: number, 
  holdingTimeMinutes: number,
  aiTriggerReason: string,
  dropFromHighPct: number = 0,
  indicators: any = null
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
     
     const indicatorsText = indicators ? `
[기술적 지표 및 모멘텀]
- 거래량 폭증 비율 (현재/5일평균): ${indicators.volumeRatio ? indicators.volumeRatio.toFixed(2) : 1}배
- 전일 고가 돌파/이탈 여부: ${indicators.yesterdayHigh ? (currentPrice < indicators.yesterdayHigh ? '전일 고가 하향 이탈 (매도 압력 우세)' : '전일 고가 지지 중') : '알 수 없음'}
- 현재가: ${currentPrice} (전일 고가: ${indicators.yesterdayHigh})` : '';

     const prompt = `
당신은 한국 주식 단타(데이 트레이딩) 최고 전문가입니다.
현재 봇이 보유 중인 '${stockName}(${symbol})'의 '조기 청산(매도)' 여부를 결정해야 합니다.
기계적인 설정값(익절 3%, 손절 -5%)에 도달하지 않았지만, 시장 상황과 재료를 바탕으로 지금 당장 시장가로 던져야 할지 판단하세요.

[현재 포지션 상태]
- 종목명: ${stockName}
- 현재 수익률: ${currentProfitPct.toFixed(2)}%
- 보유 시간: ${holdingTimeMinutes}분
- 최고점 대비 하락률 (변동성 지표): ${dropFromHighPct.toFixed(2)}%${indicatorsText}

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
          tools: [{ googleSearch: {} }]
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
     let confidence = parsed.confidence_score || 0;
     let reason = parsed.reason || "이유 불명";

     // volumeRatio 및 yesterdayHigh 지표에 따른 확신도 보정 로직
     if (indicators) {
        // 1. 거래량이 크게 터지면서 고점 대비 많이 하락 => 강한 투매 신호 (추세 역전 우려)
        if (indicators.volumeRatio && indicators.volumeRatio > 1.5 && dropFromHighPct >= 2.0) {
            confidence += 20;
            if (!recommended) { 
                recommended = true; 
                reason = "(보정: 대량 거래 수반 고점 이탈 투매 징후 - 매도 승인) " + reason; 
            }
        }
        // 2. 거래량이 소외될 정도로 매마를 경우 단기 모멘텀 이탈 위험
        else if (indicators.volumeRatio && indicators.volumeRatio < 0.5) {
            confidence += 10; 
        }

        if (indicators.yesterdayHigh) {
            if (currentPrice < indicators.yesterdayHigh) {
                // 전일 고가를 이탈한 상태에서 하락폭이 커지면 위험성 가중
                confidence += 15; 
                if (dropFromHighPct >= 1.5 && confidence >= 60 && !recommended) {
                    recommended = true;
                    reason = "(보정: 전일 고가 이탈 및 낙폭 확대 - 매도 승인) " + reason;
                }
            } else if (currentPrice >= indicators.yesterdayHigh * 1.01 && dropFromHighPct < 1.5) {
                // 전일 고가 위에서 강력히 지지될 경우 섣부른 익절 방지
                confidence -= 15;
            }
        }
     }

     // 신뢰도 점수(confidence_score)와 변동성(dropFromHighPct)을 결합한 매도 로직
     if (recommended) {
         if (confidence < 70) {
             if (dropFromHighPct >= 2.0 || (indicators?.yesterdayHigh && currentPrice < indicators.yesterdayHigh)) {
                 reason = `(확신도 미달:${confidence} - 하지만 변동성/저항선 위험으로 승인) ` + reason;
             } else {
                 recommended = false;
                 reason = `(매도 취소: 확신도 ${confidence}점 미달, 현재 상태 양호) ` + reason;
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
    const reserveAmount = Math.floor(rawProfit * SAFE_VAULT_RATIO);
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
  
  // 저널 저장 헬퍼 (Firestore 영구 저장 + bot-memory.json 로컬 저장)
  const saveJournal = (review: string) => {
    const holdTimeMinutes = context?.holdTimeMinutes ?? (
      position.buyTime ? Math.floor((Date.now() - position.buyTime) / 60000) : undefined
    );
    const entry: TradeJournal = {
      symbol, name: position.name || symbol, qty: position.qty,
      buyPrice: position.buyPrice, sellPrice, profitRate,
      profitAmount: rawProfit, review, date: Date.now(),
      strategyName: position.strategyName,
      holdTimeMinutes,
      maxPaperProfit: position.maxPaperProfit,
    };
    memory.journals.unshift(entry);
    if (memory.journals.length > 30) memory.journals.pop();
    memory.save();
    // 비동기로 Firestore 저장 (실패해도 메인 흐름 방해 안 함)
    saveTradeToFirestore(entry).catch((e: any) => console.error("Firestore trade save error:", e));
    // 5거래마다 교훈 추출
    const total = memory.journals.length;
    if (total >= 5 && total % 5 === 0) {
      extractAndSaveLessons().catch((e: any) => console.error("Lesson extraction error:", e));
    }
  };

  // AI 매매 복기 모듈
  if (process.env.GEMINI_API_KEY) {
    if (Date.now() < aiGlobalRateLimitEnd) {
      saveJournal("AI 쿼터 초과로 인해 요약이 생략되었습니다.");
      return;
    }
    try {
      const canCall = await aiLimiter.waitForTurn('LOW', `복기-${symbol}`);
      if (!canCall) {
        addBotLog(`🤖 [AI 매매 복기 대기열 초과] 패스 (기본형 기록 남김)`);
        saveJournal("대기열 초과로 인해 요약이 생성되지 않았습니다.");
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
- 진입 전략: ${position.strategyName || '알 수 없음'}
- 진입가: ${position.buyPrice}원
- 청산가: ${sellPrice}원
- 수익률: ${(profitRate * 100).toFixed(2)}%
- 최종 결과: ${isWin ? '익절' : '손실/타임컷'}${contextStr ? '\n' + contextStr : ''}

이 거래 결과에 대해 왜 이런 결과가 나왔을지 유추하고, 사용된 진입 전략(${position.strategyName || '알 수 없음'})의 관점에서 다음 거래에 반영할 점을 리스크 관리 포함 2~3문장으로 짧게 피드백해줘.
`;
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: reviewPrompt,
      });
      const reviewText = (response.text ?? "").trim();
      addBotLog(`🤖 [AI 매매 복기] ${reviewText}`);
      saveJournal(reviewText);
    } catch (e: any) {
      if (e.message?.includes("429")) {
        aiGlobalRateLimitEnd = Date.now() + 60000;
        addBotLog(`⚠️ AI 복기 생성 중 쿼터 초과(429). 60초간 호출 중지.`);
      }
      saveJournal("오류로 인해 요약이 생성되지 않았습니다.");
    }
  } else {
    saveJournal("AI 미연동 상태입니다.");
  }
}

// ------------------------------------
// AI 교훈 추출 — 과거 복기에서 패턴 학습
// ------------------------------------
async function extractAndSaveLessons() {
  if (memory.journals.length < 5) return;
  if (!process.env.GEMINI_API_KEY) return;

  const summary = memory.journals.slice(0, 30).map(j =>
    `- ${j.symbol} [${j.strategyName || '?'}] ${(j.profitRate * 100).toFixed(1)}% (${j.profitRate > 0 ? '익절' : '손절/타임컷'})\n  복기: ${j.review}`
  ).join('\n');

  const prompt = `
당신은 한국 주식 자동매매 봇의 성과를 분석하는 전문가입니다.
아래는 최근 ${memory.journals.length}건의 거래 복기입니다:

${summary}

이 복기 내역을 분석해 미래 거래에 반드시 반영할 핵심 교훈을 5가지 이내로 간결하게 작성하세요.
기법별 승률, 반복되는 실수, 피해야 할 진입 조건, 수익 극대화 팁을 포함하세요.
번호 목록 형식으로 작성하세요.
`;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    const lessons = (response.text ?? "").trim();
    if (!lessons) return;
    memory.lessons = lessons;
    memory.save();
    await saveLessonsToFirestore(lessons);
    addBotLog(`📚 [AI 교훈 업데이트] ${memory.journals.length}건 복기 분석 완료 — 다음 매매부터 반영됩니다.`);
  } catch (e: any) {
    console.error("extractAndSaveLessons error:", e.message);
  }
}

// 일봉 데이터 캐시 (30분 TTL — 장중 30초마다 재호출 방지)
const dailyBarCache: Map<string, { bars: any[]; updatedAt: number }> = new Map();
// 지표 실패 카운터: 3회 연속 실패 시 watchList에서 자동 제거
const indicatorFailCount: Map<string, number> = new Map();
const DAILY_CACHE_TTL = 30 * 60 * 1000;

async function fetchDailyBars(symbol: string, currentPrice: number): Promise<any[]> {
  const cached = dailyBarCache.get(symbol);
  if (cached && Date.now() - cached.updatedAt < DAILY_CACHE_TTL) {
    // 캐시 히트: 마지막 바의 close만 현재가로 갱신 (실시간 반영)
    const bars = [...cached.bars];
    if (bars.length > 0) bars[bars.length - 1] = { ...bars[bars.length - 1], close: currentPrice };
    return bars;
  }

  // KIS 일봉 우선 시도
  const kisBars = await getKisDailyBars(symbol, 120);
  if (kisBars.length >= 30) {
    const quotes = kisBars.map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    dailyBarCache.set(symbol, { bars: quotes, updatedAt: Date.now() });
    // 마지막 바를 현재가로 갱신
    quotes[quotes.length - 1] = { ...quotes[quotes.length - 1], close: currentPrice };
    return quotes;
  }

  // Yahoo Finance 폴백
  const yfSymbol = `${symbol}.KS`;
  const start = new Date();
  start.setDate(start.getDate() - 150);
  const chart: any = await Promise.race([
    yahooFinance.chart(yfSymbol, { period1: start, period2: new Date(), interval: "1d" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Yahoo Finance Timeout")), 8000))
  ]);
  if (chart?.quotes?.length > 26) {
    const quotes = chart.quotes
      .filter((q: any) => q.close !== null && q.high !== null && q.low !== null)
      .map((q: any) => ({ open: q.open || q.close, high: q.high, low: q.low, close: q.close, volume: q.volume || 1 }));
    dailyBarCache.set(symbol, { bars: quotes, updatedAt: Date.now() });
    quotes[quotes.length - 1] = { ...quotes[quotes.length - 1], close: currentPrice };
    return quotes;
  }
  return [];
}

async function getTechnicalIndicators(symbol: string, currentPrice: number) {
  try {
    const rawQuotes = await fetchDailyBars(symbol, currentPrice);

    if (rawQuotes.length > 26) {
      const quotes = rawQuotes;
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
      const stdDev = Math.sqrt(closes20.map((x: number) => Math.pow(x - ma20, 2)).reduce((a: number, b: number) => a + b, 0) / closes20.length);
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

      // MA60 (60일 이동평균)
      const ma60 = closes.length >= 60
        ? closes.slice(-60).reduce((a: number, b: number) => a + b, 0) / 60
        : closes.reduce((a: number, b: number) => a + b, 0) / closes.length;

      // MACD (12, 26, 9)
      const calcEMA = (data: number[], period: number): number[] => {
        const k = 2 / (period + 1);
        const result: number[] = [];
        let prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(prev);
        for (let i = period; i < data.length; i++) {
          prev = data[i] * k + prev * (1 - k);
          result.push(prev);
        }
        return result;
      };
      const ema12 = calcEMA(closes, 12);
      const ema26 = calcEMA(closes, 26);
      const macdLine = ema12.slice(-(ema26.length)).map((v, i) => v - ema26[i]);
      const signalLine = calcEMA(macdLine, 9);
      const macd = macdLine[macdLine.length - 1];
      const macdSignal = signalLine[signalLine.length - 1];
      const macdPrev = macdLine[macdLine.length - 2] ?? macd;
      const macdSignalPrev = signalLine[signalLine.length - 2] ?? macdSignal;
      // macdCross: 오늘 골든크로스 여부 (어제는 아래, 오늘은 위)
      const macdGoldenCross = macdPrev < macdSignalPrev && macd > macdSignal;

      // MACD Histogram (Elder Impulse용)
      const macdHistVal = macd - macdSignal;
      const macdHistPrev = macdPrev - macdSignalPrev;

      // EMA13 (Elder Impulse용)
      const ema13arr = calcEMA(closes, 13);
      const ema13val = ema13arr[ema13arr.length - 1];
      const ema13prev = ema13arr[ema13arr.length - 2] ?? ema13val;

      // Stochastic RSI (14, 14, 3, 3)
      const rsiArr: number[] = [];
      for (let ri = 0; ri < closes.length; ri++) {
        let u = 0, d = 0;
        for (let j = Math.max(1, ri - 13); j <= ri; j++) {
          const diff = closes[j] - closes[j - 1];
          if (diff > 0) u += diff; else d -= diff;
        }
        rsiArr.push(u === 0 ? 0 : 100 - 100 / (1 + u / (d || 1)));
      }
      const stochRawArr: number[] = rsiArr.map((r, ri) => {
        if (ri < 13) return 50;
        const sl = rsiArr.slice(ri - 13, ri + 1);
        const mn = Math.min(...sl), mx = Math.max(...sl);
        return mx === mn ? 50 : (r - mn) / (mx - mn) * 100;
      });
      const stochKArr2: number[] = stochRawArr.map((_, ri) => ri < 2 ? 50 :
        (stochRawArr[ri] + stochRawArr[ri-1] + stochRawArr[ri-2]) / 3);
      const stochDArr2: number[] = stochKArr2.map((_, ri) => ri < 2 ? 50 :
        (stochKArr2[ri] + stochKArr2[ri-1] + stochKArr2[ri-2]) / 3);
      const stochKval = stochKArr2[stochKArr2.length - 1];
      const stochDval = stochDArr2[stochDArr2.length - 1];
      const stochKprev = stochKArr2[stochKArr2.length - 2] ?? stochKval;
      const stochDprev = stochDArr2[stochDArr2.length - 2] ?? stochDval;

      // BB Squeeze (Keltner Channel 비교)
      const atr20 = (() => {
        let sum = 0;
        const n = Math.min(20, quotes.length - 1);
        for (let k = quotes.length - n; k < quotes.length; k++) {
          const pc = k > 0 ? (quotes[k-1].close ?? quotes[k].open ?? 0) : 0;
          sum += Math.max(quotes[k].high - quotes[k].low, Math.abs(quotes[k].high - pc), Math.abs(quotes[k].low - pc));
        }
        return sum / n;
      })();
      const bbWidth = stdDev * 4; // 2*stdDev above + 2*stdDev below
      const kcWidth = atr20 * 3;  // 1.5*atr above + 1.5*atr below
      // 기법 J: 전일 squeeze ON(BB inside KC) + 오늘 OFF = squeeze 직후 1바 전환만 포착
      const squeezePrevOn = (() => {
        if (quotes.length < 21) return false;
        const prevCloses = closes.slice(-21, -1);
        const prevMa20 = prevCloses.reduce((a: number, b: number) => a + b, 0) / 20;
        const prevStd = Math.sqrt(prevCloses.map((x: number) => (x - prevMa20) ** 2).reduce((a: number, b: number) => a + b) / 20);
        const prevN = Math.min(20, quotes.length - 1);
        let prevAtrSum = 0;
        for (let k = quotes.length - 1 - prevN; k < quotes.length - 1; k++) {
          const pc = k > 0 ? (quotes[k-1].close ?? quotes[k].open ?? 0) : 0;
          prevAtrSum += Math.max(quotes[k].high - quotes[k].low, Math.abs(quotes[k].high - pc), Math.abs(quotes[k].low - pc));
        }
        const prevAtr20 = prevAtrSum / prevN;
        return (prevStd * 4) < (prevAtr20 * 3); // BB was inside KC yesterday
      })();
      const squeezeFiring = squeezePrevOn && bbWidth >= kcWidth; // squeeze 직후 전환 바
      // Simple squeeze momentum: close - avg(20-period midpoint, MA20)
      const hi20 = Math.max(...quotes.slice(-20).map((q: any) => q.high));
      const lo20 = Math.min(...quotes.slice(-20).map((q: any) => q.low));
      const sqMomVal = closes[closes.length - 1] - ((hi20 + lo20) / 2 + ma20) / 2;
      const sqMomPrev = closes.length >= 2
        ? closes[closes.length - 2] - ((hi20 + lo20) / 2 + ma20) / 2
        : sqMomVal;

      // ATR (14일 Average True Range) 계산
      const atrPeriod = Math.min(14, quotes.length - 1);
      let totalTR = 0;
      for (let i = quotes.length - atrPeriod; i < quotes.length; i++) {
        const tr = Math.max(
          quotes[i].high - quotes[i].low,
          Math.abs(quotes[i].high - (quotes[i - 1]?.close ?? quotes[i].open)),
          Math.abs(quotes[i].low  - (quotes[i - 1]?.close ?? quotes[i].open))
        );
        totalTR += tr;
      }
      const atr = totalTR / atrPeriod;
      const atrPct = atr / currentPrice; // 가격 대비 변동성 비율

      return {
        currentPrice,
        openPrice: quotes[quotes.length - 1].open || currentPrice,
        ma5,
        ma20,
        ma60,
        rsi,
        bbLower,
        tenkan,
        kijun,
        spanA,
        spanB,
        volumeRatio,
        yesterdayHigh: quotes.length >= 2 ? (quotes[quotes.length - 2].high || currentPrice) : currentPrice,
        yesterdayOpen: quotes.length >= 2 ? (quotes[quotes.length - 2].open || currentPrice) : currentPrice,
        yesterdayClose: quotes.length >= 2 ? (quotes[quotes.length - 2].close || currentPrice) : currentPrice,
        todayOpen: quotes[quotes.length - 1].open || currentPrice,
        todayVolume: currentVolume,
        yesterdayVolume: volumes.length >= 2 ? (volumes[volumes.length - 2] || 1) : 1,
        atr,
        atrPct,
        macd,
        macdSignal,
        macdGoldenCross,
        macdHistVal,
        macdHistPrev,
        ema13val,
        ema13prev,
        stochKval,
        stochDval,
        stochKprev,
        stochDprev,
        squeezeFiring,
        sqMomVal,
        sqMomPrev,
        isFallback: false,
      };
    }
  } catch (e: any) {
    console.error("Indicator error:", e);
    addBotLog(`⚠️ [지표 오류] ${symbol} 데이터 수집 실패 (${e.message})`);
  }

  // 실패 시 기본 데이터 (isFallback=true → monitoringLoop에서 연속 실패 카운트)
  return {
    isFallback: true,
    currentPrice,
    openPrice: currentPrice,
    ma5: currentPrice,
    ma20: currentPrice,
    ma60: currentPrice,
    rsi: 50,
    bbLower: currentPrice * 0.95,
    tenkan: currentPrice,
    kijun: currentPrice,
    spanA: currentPrice,
    spanB: currentPrice,
    volumeRatio: 1,
    yesterdayHigh: currentPrice,
    yesterdayOpen: currentPrice,
    yesterdayClose: currentPrice,
    todayOpen: currentPrice,
    todayVolume: 1,
    yesterdayVolume: 1,
    atr: 0,
    atrPct: 0.02,
    macd: 0,
    macdSignal: 0,
    macdGoldenCross: false,
    macdHistVal: 0,
    macdHistPrev: 0,
    ema13val: currentPrice,
    ema13prev: currentPrice,
    stochKval: 50,
    stochDval: 50,
    stochKprev: 50,
    stochDprev: 50,
    squeezeFiring: false,
    sqMomVal: 0,
    sqMomPrev: 0,
  };
}

// ------------------------------------
// 분봉 기반 신호 확인 (전략 신호 뜬 종목에만 호출)
// ------------------------------------
async function confirmWithMinuteBars(
  symbol: string,
  strategyName: string
): Promise<{ confirmed: boolean; intradayRsi: number; intradayVolumeRatio: number; realOpenPrice: number }> {
  const bars = await getKisMinuteBars(symbol, 20);

  if (bars.length < 2) {
    // A/B/E/F/G: 분봉 없으면 진입 보류 (KIS 다운 = 리스크 상황)
    // C/D: 추세/일목 기반이라 일봉 필터로 충분 → 통과
    const requiresBars = strategyName.includes('기법 A') || strategyName.includes('기법 B')
      || strategyName.includes('기법 E') || strategyName.includes('기법 F') || strategyName.includes('기법 G');
    return { confirmed: !requiresBars, intradayRsi: 50, intradayVolumeRatio: 0, realOpenPrice: 0 };
  }

  // output2는 최신→과거 순 → 역순으로 정렬해 시간 오름차순으로
  const sorted = [...bars].reverse();

  let iUps = 0, iDowns = 0;
  for (let j = 1; j < sorted.length; j++) {
    const diff = sorted[j].close - sorted[j - 1].close;
    if (diff > 0) iUps += diff;
    else iDowns += Math.abs(diff);
  }
  const intradayRsi = iUps === 0 ? 0 : 100 - (100 / (1 + (iUps / (iDowns || 1))));

  const currVol = bars[0].volume;
  const prevAvg = bars.slice(1).reduce((a: number, b) => a + b.volume, 0) / (bars.length - 1);
  const intradayVolumeRatio = currVol / (prevAvg || 1);

  const realOpenPrice = sorted[0].open; // 첫 분봉 시가 = 실제 당일 시가

  let confirmed = true;

  if (strategyName.includes('기법 A')) {
    const recentVolOK = intradayVolumeRatio >= 1.5;
    // 첫 3분봉 거래량이 연속 감소하면 허위 돌파(false breakout) 가능성 높음 → 필터
    const isDecliningVolume = sorted.length >= 3 &&
      sorted[0].volume > sorted[1].volume &&
      sorted[1].volume > sorted[2].volume;
    confirmed = recentVolOK && !isDecliningVolume;
    if (isDecliningVolume) {
      console.log(`[기법 A 거래량 필터] ${symbol} 첫 3분봉 거래량 감소 패턴 감지 → 허위 돌파 차단`);
    }
  } else if (strategyName.includes('기법 B')) {
    // 과매도: 인트라데이 RSI도 45 이하여야 반등 유효
    confirmed = intradayRsi <= 45;
  } else if (strategyName.includes('기법 E')) {
    // 거래량 폭증: 인트라데이 기준도 1.5배 이상
    confirmed = intradayVolumeRatio >= 1.5;
  } else if (strategyName.includes('기법 F')) {
    // MACD 골든크로스: RSI 과매수(>65) 진입은 피하고, 거래량도 최소 0.8배 이상
    confirmed = intradayRsi <= 65 && intradayVolumeRatio >= 0.8;
  } else if (strategyName.includes('기법 G')) {
    // 정배열 눌림목: 인트라데이 RSI가 55 이하로 과열 아닌 구간에서만 진입
    confirmed = intradayRsi <= 58;
  }
  // 기법 C, D: 추세/일목 기반 → 일봉 필터로 충분, 분봉 미필터

  return { confirmed, intradayRsi, intradayVolumeRatio, realOpenPrice };
}

// ------------------------------------
// 2. 복수 종목 순회 감시 루프
// ------------------------------------
async function monitoringLoop() {
  if (!memory.isRunning) return;
  
  if (!isKoreanMarketOpenStrict()) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    addBotLog(`💤 [장외 시간] 현재 시각 ${timeStr} - 한국 주식 시장이 열려있지 않습니다 (평일 09:00~15:30).`);
    return;
  }

  // KOSPI 지수 캐시 갱신 (3분 TTL)
  const nowMs = Date.now();
  if (!kospiCache || nowMs - kospiCache.updatedAt > KOSPI_CACHE_TTL) {
    const kospi = await getKospiStatus();
    if (kospi) {
      kospiCache = { ...kospi, updatedAt: nowMs };
      addBotLog(`📊 [KOSPI] ${kospi.price.toLocaleString()} (${kospi.changeRate >= 0 ? '+' : ''}${kospi.changeRate.toFixed(2)}%)`);
    }
  }
  const isKospiDown = kospiCache ? kospiCache.changeRate <= KOSPI_DOWN_THRESHOLD : false;
  if (isKospiDown) {
    addBotLog(`⚠️ [KOSPI 경보] ${kospiCache!.changeRate.toFixed(2)}% 하락 — 신규 매수 일시 중단`);
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
      investAmount: DEFAULT_INVEST_AMOUNT,
      takeProfitPct: DEFAULT_PROFIT_TARGET,
      stopLossPct: DEFAULT_STOP_LOSS,
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

      // KIS API rate limit: 초당 최대 1회 안전 여유
      await delay(700);

      const stock = await getKisPrice(symbol);
      if (!stock) continue;
      
      // 전역 캐시에 최근 가격 갱신 (UI용)
      (global as any).priceCache = (global as any).priceCache || {};
      (global as any).priceCache[symbol] = { price: stock.price, name: stock.name, time: Date.now() };

      
      scannedCount++;
      const currentPrice = stock.price;
      const position = memory.positions.get(symbol);

      if (position) {
        // 최고가 및 최대 수익률 업데이트 (트레일링 스탑 + 나중 분석용)
        if (!position.highestPrice || currentPrice > position.highestPrice) {
           position.highestPrice = currentPrice;
        }
        const currentPaperProfit = (currentPrice - position.buyPrice) / position.buyPrice;
        if (currentPaperProfit > (position.maxPaperProfit ?? 0)) {
          position.maxPaperProfit = currentPaperProfit;
        }

        // [상황 A] 보유 중인 종목 감시 (익절/손절/타임컷)
        const profitRate = (currentPrice - position.buyPrice) / position.buyPrice;
        const peakPrice = position.highestPrice ?? currentPrice;
        const highestProfitRate = (peakPrice - position.buyPrice) / position.buyPrice;
        const dropFromHigh = (peakPrice - currentPrice) / peakPrice;
        const holdTimeHours = position.buyTime ? (Date.now() - position.buyTime) / (1000 * 60 * 60) : 0;

        // 보유 종목은 매 루프마다 상태 출력 (너무 잦으면 3번에 한번 등으로 조절 가능하지만 현재는 매번)
        addBotLog(`[감시] ${stock.name} ${currentPrice.toLocaleString()}원 (${(profitRate * 100).toFixed(2)}%)`);

        // 트레일링 스탑: 익절 목표가(takeProfitPct) 도달 후 고점 대비 1.5% 하락 시 매도
        if (highestProfitRate >= config.takeProfitPct && dropFromHigh >= TRAILING_STOP_DROP) {
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

          if (order.success) await handleTakeProfit(symbol, currentPrice, position, { trigger: '트레일링 스탑', dropFromHighPct: dropFromHigh * 100, holdTimeMinutes: Math.floor(holdTimeHours * 60) });
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

          if (order.success) await handleTakeProfit(symbol, currentPrice, position, { trigger: '목표 수익 도달 (익절)', holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
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

          if (order.success) await handleTakeProfit(symbol, currentPrice, position, { trigger: '손절선 도달 (손절)', stopLossPct: config.stopLossPct * 100, holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
          else addBotLog(`매도 실패: ${order.message}`);
        }
        else if (holdTimeHours >= 6) {
          const tcNow = new Date();
          const tcKstH = tcNow.getHours();
          const tcKstM = tcNow.getMinutes();
          const tcReason = tcKstH * 100 + tcKstM >= 1510 ? '장 마감 임박 강제청산 (15:10)' : '6시간 초과 타임컷';
          addBotLog(`⏰ [타임컷] ${config.name} - ${tcReason}`, currentPrice, profitRate);
          const order = await sellOrder(symbol, currentPrice.toString(), position.qty.toString());

          memory.orders.unshift({
            symbol, name: config.name, type: 'SELL', price: currentPrice, qty: position.qty,
            amount: currentPrice * position.qty, timestamp: Date.now(),
            status: order.success ? 'SUCCESS' : 'FAILED', message: order.success ? tcReason : order.message,
            profitRate, profitAmount: (currentPrice - position.buyPrice) * position.qty
          });
          if (memory.orders.length > 50) memory.orders.pop();
          memory.save();

          if (order.success) await handleTakeProfit(symbol, currentPrice, position, { trigger: `타임컷: ${tcReason}`, holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
          else addBotLog(`청산 매도 실패: ${order.message}`);
        }
        else if (process.env.GEMINI_API_KEY) {
          const holdTimeMinutes = Math.floor(holdTimeHours * 60);

          // API 과부하 방지 처리는 askGeminiForSell 모듈 안에 aiSellCache 3분 제한으로 반영되어있습니다.

          let aiTriggerReason = "";

          // [트리거 1] 수익 수성 구간
          if (profitRate >= AI_SELL_TRIGGER_PROFIT) {
            aiTriggerReason = "수익 보전 (1.5% 도달, 추가 모멘텀 둔화 여부 판독)";
          } 
          // [트리거 2] 손절 방어 구간
          else if (profitRate <= AI_SELL_TRIGGER_LOSS) {
            aiTriggerReason = "손절 방어 (-2.5% 하락, 추가 투매 위험 판독)";
          } 
          // [트리거 3] 고점 대비 2% 이상 하락
          else if (dropFromHigh >= AI_SELL_TRIGGER_DROP) {
            aiTriggerReason = "고점 대비 하락 (최고가 대비 2% 이상 하락, 하락 추세 전환 판독)";
          }
          // [트리거 4] 기회비용 (시간 컷) 방어 구간
          else if (holdTimeMinutes >= AI_SELL_TRIGGER_MINUTES && profitRate < 0.01) {
            aiTriggerReason = "시간 컷 (45분 이상 정체 및 수익률 1% 미만, 재료 소멸 및 기회비용 상실 판독)";
          }

          if (aiTriggerReason !== "") {
             // addBotLog(`\n🔍 [AI 스마트 매도 검사 발동] 종목: ${config.name}`);
             // addBotLog(`👉 발동 사유: ${aiTriggerReason} | 현재 수익률: ${(profitRate * 100).toFixed(2)}%`);
             
             const indicators = await getTechnicalIndicators(symbol, currentPrice);
             const aiSell = await askGeminiForSell(symbol, stock.name, currentPrice, profitRate * 100, holdTimeMinutes, aiTriggerReason, dropFromHigh * 100, indicators);
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

                if (order.success) await handleTakeProfit(symbol, currentPrice, position, { trigger: `AI 조기 매도 지시 (${aiTriggerReason})`, holdTimeMinutes: Math.floor(holdTimeHours * 60), dropFromHighPct: dropFromHigh * 100 });
                else addBotLog(`청산 매도 실패: ${order.message}`);
             }
          }
        }
      } 
      else {
        // [상황 B] 미보유 종목 타점 감시
        const indicators = await getTechnicalIndicators(symbol, currentPrice);

        // 지표 fallback(데이터 없음) → 연속 실패 카운트, 3회 이상 시 watchList 자동 제거
        if (indicators.isFallback) {
          const fails = (indicatorFailCount.get(symbol) ?? 0) + 1;
          indicatorFailCount.set(symbol, fails);
          if (fails >= 3) {
            memory.watchList.delete(symbol);
            indicatorFailCount.delete(symbol);
            dailyBarCache.delete(symbol);
            memory.save();
            addBotLog(`🗑️ [자동 제거] ${symbol} — 3회 연속 지표 수집 실패로 감시 목록에서 제거됨 (상장폐지/거래정지 의심)`);
            continue;
          }
          addBotLog(`⏭️ [지표 없음] ${symbol} — 유효 데이터 없음, 이번 루프 건너뜀 (${fails}/3회)`);
          continue;
        }
        indicatorFailCount.delete(symbol); // 성공 시 실패 카운트 초기화

        const { openPrice, ma5, ma20, rsi, bbLower } = indicators;
        
        let strategyMatched = false;
        let matchedStrategyName = "";

        const now = new Date();
        const kstHours = now.getHours();
        const kstMinutes = now.getMinutes();
        const currentTime = kstHours * 100 + kstMinutes;

        // 공통 파생 지표 (openPrice는 위에서 이미 구조분해)
        const effectiveOpen = openPrice || currentPrice;
        const dayGainPct = (currentPrice - effectiveOpen) / effectiveOpen;
        const distFromMA5 = ma5 ? (currentPrice - ma5) / ma5 : 0;

        // =====================================================================
        // 🔥 [기법 A] 09:00 ~ 09:30: 갭업 돌파 매매 (야수의 시간)
        // 조건: 당일 +3% 이상 갭업 시초가 + 전일 고가 돌파 + MA5 근처
        // =====================================================================
        if (currentTime >= 900 && currentTime < 930) {
          const isGapUp = dayGainPct >= 0.03;
          const isGapNotTooHigh = dayGainPct <= 0.08; // 8% 이상 갭은 설거지 위험
          const isBreakingHigh = currentPrice > indicators.yesterdayHigh;
          const isNearMA5 = Math.abs(distFromMA5) <= 0.02;

          if (ENABLED_STRATEGIES.A && isGapUp && isGapNotTooHigh && isBreakingHigh && isNearMA5) {
            strategyMatched = true;
            matchedStrategyName = "🔥 기법 A: 갭업 돌파 + MA5 근처";
          }
        }
        // =====================================================================
        // 🛡️ [기법 B~E] 09:30 ~ 14:30: 중반장 눌림목 / 모멘텀 전략
        // =====================================================================
        else if (currentTime >= 930 && currentTime < 1430) {
          // 기법 B: RSI 과매도 + 볼린저밴드 하단 + MA20 추세 필터
          if (ENABLED_STRATEGIES.B && rsi <= 35 && currentPrice < bbLower * 1.01 && currentPrice > ma20 * 0.97) {
            strategyMatched = true;
            matchedStrategyName = "🛡️ 기법 B: RSI 과매도 + BB하단 반등";
          }
          // 기법 C: 골든크로스(MA5>MA20 막 돌파) 직후 첫 눌림목
          else if (ENABLED_STRATEGIES.C && ma5 > ma20
            && (ma5 - ma20) / ma20 < 0.01
            && currentPrice > ma20
            && currentPrice < ma20 * 1.02) {
            strategyMatched = true;
            matchedStrategyName = "🌟 기법 C: 골든크로스 첫 눌림목";
          }
          // 기법 D: 일목균형표 구름대 위 + 기준선(kijun) 근처 지지
          else if (ENABLED_STRATEGIES.D && currentPrice > Math.max(indicators.spanA || currentPrice, indicators.spanB || currentPrice)
            && Math.abs(currentPrice - indicators.kijun) / indicators.kijun < 0.015
            && currentPrice >= indicators.kijun) {
            strategyMatched = true;
            matchedStrategyName = "⛅ 기법 D: 일목 기준선 지지";
          }
          // 기법 E: 거래량 2배 폭증 + RSI 60~70 (과열 전 모멘텀 진입)
          else if (ENABLED_STRATEGIES.E && indicators.volumeRatio >= 2.0 && rsi >= 60 && rsi <= 70) {
            strategyMatched = true;
            matchedStrategyName = "⚡ 기법 E: 거래량 폭증 모멘텀";
          }
          // 기법 F: MACD 골든크로스 + RSI 중립 (40~60) + MA20 위
          // MACD가 시그널선을 하향에서 상향 돌파 → 추세 전환 초입 포착
          else if (ENABLED_STRATEGIES.F
            && indicators.macdGoldenCross
            && rsi >= 40 && rsi <= 60
            && currentPrice > ma20) {
            strategyMatched = true;
            matchedStrategyName = "📈 기법 F: MACD 골든크로스 전환";
          }
          // 기법 G: MA5/20/60 정배열 + MA20 눌림목
          // 세 이평선이 정배열(상승 추세 확인) + 현재가가 MA20 근처에서 지지받는 국면
          else if (ENABLED_STRATEGIES.G
            && indicators.ma5 > indicators.ma20
            && indicators.ma20 > (indicators.ma60 ?? currentPrice)
            && currentPrice > indicators.ma20
            && currentPrice < indicators.ma20 * 1.03
            && rsi >= 45 && rsi <= 65) {
            strategyMatched = true;
            matchedStrategyName = "📊 기법 G: 정배열 MA20 눌림목";
          }
          // 기법 H: Stochastic RSI 과매도 반등 (%K < 20 & %D < 20, K가 D 상향 돌파)
          else if (ENABLED_STRATEGIES.H
            && indicators.stochKval < 20 && indicators.stochDval < 20
            && indicators.stochKprev <= indicators.stochDprev
            && indicators.stochKval > indicators.stochDval
            && rsi >= 30 && rsi <= 60
            && currentPrice > ma20 * 0.97) {
            strategyMatched = true;
            matchedStrategyName = "🔄 기법 H: StochRSI 과매도 반등";
          }
          // 기법 I: Elder Impulse (EMA13 상승 + MACD-H 양수 증가 + MA20 위)
          else if (ENABLED_STRATEGIES.I
            && indicators.ema13val > indicators.ema13prev
            && indicators.macdHistVal > 0 && indicators.macdHistVal > indicators.macdHistPrev
            && rsi >= 45 && rsi <= 65
            && currentPrice > ma20) {
            strategyMatched = true;
            matchedStrategyName = "⚡ 기법 I: Elder Impulse 상승";
          }
          // 기법 J: BB Squeeze 이탈 + 양적 모멘텀 (저변동성 압축 후 방향성 돌파)
          else if (ENABLED_STRATEGIES.J
            && indicators.squeezeFiring
            && indicators.sqMomVal > 0 && indicators.sqMomVal > indicators.sqMomPrev
            && indicators.volumeRatio >= 1.2
            && currentPrice > ma20) {
            strategyMatched = true;
            matchedStrategyName = "💥 기법 J: BB Squeeze 돌파";
          }
          // 기법 K: Bullish Engulfing + 거래량 급증 (전일 음봉을 당일 양봉이 완전히 포함)
          else if (ENABLED_STRATEGIES.K
            && indicators.yesterdayClose < indicators.yesterdayOpen
            && indicators.todayOpen <= indicators.yesterdayClose
            && currentPrice > indicators.yesterdayOpen
            && indicators.volumeRatio >= 1.5
            && currentPrice > ma20
            && rsi >= 40 && rsi <= 65) {
            strategyMatched = true;
            matchedStrategyName = "🕯️ 기법 K: Bullish Engulfing";
          }
        }
        // =====================================================================
        // 🛑 14:30 이후: 투매 방어, 신규 매수 금지
        // =====================================================================
        else {
          strategyMatched = false;
        }

        if (strategyMatched && isKospiDown) {
          addBotLog(`🚫 [KOSPI 경보] ${config.name} 매수 신호 감지됐지만 KOSPI 하락으로 진입 차단`);
          strategyMatched = false;
        }

        // 최대 보유 종목 수 체크
        if (strategyMatched) {
          const totalPositions = memory.positions.size;
          const strategyAPositions = Array.from(memory.positions.values())
            .filter((p: any) => p.strategyName?.includes('기법 A')).length;

          if (matchedStrategyName.includes('기법 A') && strategyAPositions >= MAX_STRATEGY_A_POSITIONS) {
            addBotLog(`🚫 [기법 A 한도] 기법 A 종목 이미 ${strategyAPositions}개 보유 — 추가 진입 차단`);
            strategyMatched = false;
          } else if (totalPositions >= MAX_POSITIONS) {
            addBotLog(`🚫 [최대 보유 한도] 현재 ${totalPositions}종목 보유 중 — 신규 진입 차단 (최대 ${MAX_POSITIONS}종목)`);
            strategyMatched = false;
          }
        }

        // 분봉 확인 (신호 뜬 종목에만 KIS 분봉 조회)
        if (strategyMatched) {
          const minuteConfirm = await confirmWithMinuteBars(symbol, matchedStrategyName);
          if (!minuteConfirm.confirmed) {
            addBotLog(`🔍 [분봉 미확인] ${config.name} — 전략 ${matchedStrategyName} 분봉 조건 불충족 (인트라RSI: ${minuteConfirm.intradayRsi.toFixed(1)}, 거래량비: ${minuteConfirm.intradayVolumeRatio.toFixed(2)}x)`);
            strategyMatched = false;
          }
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

          // ATR 기반 포지션 사이징 (1% 리스크 룰)
          // - 총자산의 1%를 1회 거래에서 감수할 최대 손실로 설정
          // - 변동성(ATR)이 클수록 포지션 축소, 작을수록 확대 (15% 상한)
          const atrPct: number = indicators.atrPct > 0 ? indicators.atrPct : 0.02;
          const totalCapital = memory.totalEquity > 0 ? memory.totalEquity : memory.availableCapital;
          const riskBudget = totalCapital * 0.01; // 총자산의 1% = 1회 허용 손실
          const effectiveStop = Math.max(Math.abs(config.stopLossPct), atrPct * 1.5);
          const investAmount = Math.round(Math.min(
            Math.max(riskBudget / effectiveStop, 500_000), // 최소 50만원
            totalCapital * 0.15,                           // 최대 총자산의 15%
            memory.availableCapital * 0.95                 // 가용 현금 초과 불가
          ) / 1000) * 1000; // 1000원 단위 반올림

          if (aiApproved && memory.availableCapital >= investAmount) {
            addBotLog(`\n⚡ [매수 타점 포착!] 종목: ${config.name} (${symbol})`);
            addBotLog(`🎯 발동 전략: ${matchedStrategyName} | 현재가: ${currentPrice.toLocaleString()}원`);
            addBotLog(`📐 [ATR 사이징] 총자산 ${totalCapital.toLocaleString()}원 × 1% ÷ 유효손절 ${(effectiveStop*100).toFixed(1)}% → 투자금 ${investAmount.toLocaleString()}원`);

            const qtyToBuy = Math.floor(investAmount / currentPrice);
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
                    highestPrice: currentPrice,
                    strategyName: matchedStrategyName
                  });
                  memory.save();
                } else {
                  addBotLog(`매수 거절: ${order.message}`);
                }
            }
          } else if (aiApproved && memory.availableCapital < investAmount) {
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
  
  if (symbolsToScan.length === 0) {
    addBotLog(`⚠️ [감시 풀 비어있음] 감시 종목이 없습니다. 잠시 후 자동으로 종목을 탐색합니다...`);
  } else if (scannedCount === 0) {
    addBotLog(`⚠️ [가격 조회 전부 실패] ${symbolsToScan.length}개 종목 중 가격 수신 0개 — KIS API 상태 확인 필요`);
  } else {
    addBotLog(`✅ 스캔 완료: ${scannedCount}종목 체크됨 (발견된 타점: ${matchesCount}개)`);
  }
}

async function updateBalance() {
  const res = await getKisBalance();
  if (res && !res.error) {
    memory.availableCapital = res.balance;
    memory.totalEquity = res.totalEquity;
    // 포지션 동기화 (API 포지션 > 0 일 때만 로컬 장부 정리 — VTS에서 0 반환 시 포지션 유실 방지)
    if (res.positions && res.positions.length > 0) {
      const apiSymbols = new Set(res.positions.map((p: any) => p.symbol));
      for (const key of memory.positions.keys()) {
        if (!apiSymbols.has(key)) {
          addBotLog(`🗑️ [포지션 정리] ${key}: API 잔고에 없음 → 로컬 장부에서 제거`);
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
            if (existing) {
              existing.qty = p.qty;
              existing.buyPrice = p.buyPrice;
              if (p.name) existing.name = p.name;
            }
         }
      });
    } else if (res.positions && res.positions.length === 0 && memory.positions.size > 0) {
      addBotLog(`⚠️ [포지션 동기화 주의] API가 보유 종목 0개 반환. 로컬 장부(${memory.positions.size}개) 유지 (VTS 불일치 가능성)`);
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
  
  memory.isStarting = true;
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
    memory.isStarting = false;
  }
}

// 10분마다 잔고 강제 동기화 (오차 누적 방지)
cron.schedule("0 */10 * * * *", () => {
  if (memory.isRunning) {
    updateBalance();
  }
});

// 5분마다 watchList 자동 복구 (감시 풀이 비어있으면 재탐색)
let isRefreshingWatchList = false;
cron.schedule("0 */5 * * * *", async () => {
  if (!memory.isRunning) return;
  if (memory.watchList.size > 0) return; // 이미 감시 종목 있으면 패스
  if (isRefreshingWatchList) return;
  if (!isKoreanMarketOpenStrict()) return;

  isRefreshingWatchList = true;
  addBotLog(`♻️ [watchList 자동 복구] 감시 풀이 비어있어 종목 재탐색을 시작합니다...`);
  try {
    const filteredStocks = await getFilteredTopStocks();
    if (filteredStocks.length > 0) {
      const firstConfig = Array.from(memory.watchList.values())[0];
      const investAmount = firstConfig?.investAmount ?? DEFAULT_INVEST_AMOUNT;
      const takeProfitPct = firstConfig?.takeProfitPct ?? DEFAULT_PROFIT_TARGET;
      const stopLossPct = firstConfig?.stopLossPct ?? DEFAULT_STOP_LOSS;
      const useAI = firstConfig?.useAI ?? true;

      memory.watchList.clear();
      for (const st of filteredStocks) {
        memory.watchList.set(st.symbol, {
          symbol: st.symbol,
          name: st.name,
          investAmount,
          takeProfitPct,
          stopLossPct,
          useAI
        });
      }
      addBotLog(`✅ [watchList 자동 복구 완료] ${filteredStocks.length}개 종목으로 감시 풀 재구성`);
      memory.save();
    } else {
      addBotLog(`⚠️ [watchList 자동 복구 실패] 적합 종목 없음. 5분 후 재시도합니다.`);
    }
  } catch (e: any) {
    addBotLog(`❌ [watchList 자동 복구 오류] ${e.message}`);
  } finally {
    isRefreshingWatchList = false;
  }
});

// 60초마다 보유 포지션 현재가 갱신 (봇 정지 중에도 포트폴리오 실시간 반영)
cron.schedule("0 */1 * * * *", async () => {
  if (memory.isRunning) return; // 봇 실행 중엔 monitoringLoop이 처리
  if (memory.positions.size === 0) return;
  if (!isKoreanMarketOpenStrict()) return;
  (global as any).priceCache = (global as any).priceCache || {};
  for (const [symbol] of memory.positions) {
    try {
      const stock = await getKisPrice(symbol);
      if (stock) {
        (global as any).priceCache[symbol] = { price: stock.price, name: stock.name, time: Date.now() };
      }
      await delay(600);
    } catch (e) {}
  }
});

// 장마감 10분 전(KST 15:15) 전체 포지션 강제청산 (당일 데이트레이딩 원칙)
cron.schedule('15 15 * * 1-5', async () => {
  const holdingSymbols = Array.from(memory.positions.keys());
  if (holdingSymbols.length === 0) return;
  addBotLog(`🔔 [장마감 강제청산] KST 15:15 도달. 잔여 ${holdingSymbols.length}개 포지션 전량 청산 시작.`);
  for (const symbol of holdingSymbols) {
    const pos = memory.positions.get(symbol);
    if (!pos) continue;
    await delay(700);
    const stock = await getKisPrice(symbol);
    const sellPrice = stock ? stock.price : pos.buyPrice;
    const order = await sellOrder(symbol, sellPrice.toString(), pos.qty.toString());
    const profitRate = (sellPrice - pos.buyPrice) / pos.buyPrice;
    memory.orders.unshift({
      symbol, name: pos.name || symbol, type: 'SELL', price: sellPrice, qty: pos.qty,
      amount: sellPrice * pos.qty, timestamp: Date.now(),
      status: order.success ? 'SUCCESS' : 'FAILED',
      message: order.success ? '장마감 강제청산 (15:15)' : order.message,
      profitRate, profitAmount: (sellPrice - pos.buyPrice) * pos.qty
    });
    if (memory.orders.length > 50) memory.orders.pop();
    if (order.success) {
      addBotLog(`✅ [장마감 청산] ${pos.name || symbol} 매도 완료 (${(profitRate * 100).toFixed(2)}%)`);
      await handleTakeProfit(symbol, sellPrice, pos, { trigger: '장마감 강제청산 (15:15)', holdTimeMinutes: Math.floor((Date.now() - (pos.buyTime || Date.now())) / 60000) });
    } else {
      addBotLog(`❌ [장마감 청산 실패] ${pos.name || symbol}: ${order.message}`);
    }
  }
  memory.save();
  addBotLog(`🔔 [장마감 강제청산] 완료.`);
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
  const todayStr = new Date().toLocaleDateString("ko-KR").replace(/\. /g, '-').replace('.', '');

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
  memory.isStarting = false;
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

    const result = await runBacktest(symbol, days, initialCapital, DEFAULT_PROFIT_TARGET, DEFAULT_STOP_LOSS);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/bot/status", async (req, res) => {
  let targetSymbol = "005930";
  let targetPrice = DEFAULT_INVEST_AMOUNT;
  let useAI = true;
  let profitTarget = DEFAULT_PROFIT_TARGET;
  let lossLimits = DEFAULT_STOP_LOSS;
  
  // 봇 실행 중일 때만 watchList 설정값 반영 (정지 시엔 저장된 stale 값 대신 기본값 사용)
  if (memory.isRunning && memory.watchList.size > 0) {
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
    await startAutoBot(); // await해야 잔고 동기화 실패 시 isRunning=false 상태를 정확히 반영

    if (!memory.isRunning) {
      return res.json({ success: false, isRunning: false, error: "잔고 동기화 실패로 봇 가동 중단" });
    }

    addBotLog(`🚀 봇 가동 시작! 실시간 퀀트 스캐닝을 통해 조건에 맞는 종목(시총 1천억~20조)을 탐색 중입니다 (1~2분 소요)...`);

    // Non-blocking background scan (감시 풀 구성)
    res.json({ success: true, isRunning: true });

    const scanConfig = { price, profitTarget, lossLimits, useAI };
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
                investAmount: Number(scanConfig.price) || DEFAULT_INVEST_AMOUNT,
                takeProfitPct: Number(scanConfig.profitTarget) || DEFAULT_PROFIT_TARGET,
                stopLossPct: Number(scanConfig.lossLimits) || DEFAULT_STOP_LOSS,
                useAI: scanConfig.useAI !== undefined ? scanConfig.useAI : true
              });
            }
            addBotLog(`🚀 퀀트 필터링 완료: 주도주 ${filteredStocks.length}개로 감시 풀이 업데이트되었습니다.`);
            memory.save();
          } else {
            addBotLog(`⚠️ 필터링 결과 매매 적합 종목이 없습니다. 5분마다 자동 재탐색합니다.`);
          }
      } catch(e: any) {
          addBotLog(`⚠️ 실시간 필터링 중 오류: ${e.message || '알 수 없는 오류'}. 5분마다 자동 재탐색합니다.`);
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
      if (result.positions && result.positions.length > 0) {
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
              if (existing) {
                existing.qty = p.qty;
                existing.buyPrice = p.buyPrice;
                if (p.name) existing.name = p.name;
              }
           }
        });
      }
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
    const todayStr = new Date().toLocaleDateString("ko-KR").replace(/\. /g, '-').replace('.', '');
    
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
