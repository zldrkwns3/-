/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase.ts';
import DashboardLayout from './components/Layout.tsx';
import StockChart from './components/StockChart.tsx';
import BacktestView from './components/BacktestView.tsx';
import LoginForm from './components/LoginForm.tsx';
import { StockQuote, ChartData } from './types.ts';
import { TrendingUp, TrendingDown, Target, BrainCircuit, Activity, History, Shield } from 'lucide-react';
import Markdown from 'react-markdown';
import AssetHistoryChart from './components/AssetHistoryChart.tsx';

export default function App() {
  const [activeTab, setActiveTab] = useState('explore');
  const [historyPeriod, setHistoryPeriod] = useState<'D' | 'W' | 'M' | 'Y'>('D');

  const getFilteredHistory = (history: any[], period: 'D' | 'W' | 'M' | 'Y') => {
    if (!history || history.length === 0) return [];
    const sorted = [...history].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    if (period === 'D') return sorted;
    const groups = new Map<string, any>();
    sorted.forEach(item => {
      const d = new Date(item.date);
      let key = '';
      if (period === 'W') {
         const jan1 = new Date(d.getFullYear(), 0, 1);
         const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getDay() + 1) / 7);
         key = `${d.getFullYear()}-W${week}`;
      } else if (period === 'M') {
         key = `${d.getFullYear()}-${d.getMonth()}`;
      } else if (period === 'Y') {
         key = `${d.getFullYear()}`;
      }
      groups.set(key, item);
    });
    return Array.from(groups.values());
  };
  const [selectedSymbol, setSelectedSymbol] = useState('005930');
  const [stockData, setStockData] = useState<{ quote: StockQuote; chart: ChartData[] } | null>(null);
  const [analysis, setAnalysis] = useState<{ text: string, confidence: number, recommendation?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [apiStatus, setApiStatus] = useState<string>('확인 중...');
  
  // Modal for Journal entry details
  const [selectedJournal, setSelectedJournal] = useState<any | null>(null);
  const [journalChartData, setJournalChartData] = useState<ChartData[] | null>(null);
  
  useEffect(() => {
    if (selectedJournal) {
      setJournalChartData(null);
      const parsedSymbol = selectedJournal.symbol.split('.')[0];
      fetch(`/api/stock/${parsedSymbol}`)
        .then(res => res.json())
        .then(data => {
           if (data.chart) {
             const chart = data.chart.map((d: any) => ({
                date: new Date(d.date).toLocaleDateString(),
                close: d.close,
                tenkan: d.tenkan,
                kijun: d.kijun,
                spanA: d.spanA,
                spanB: d.spanB,
                rawDate: new Date(d.date).getTime()
             }));
             // filter out dates strictly after the journal date to show the chart "at the time"
             const filteredChart = chart.filter((d: any) => d.rawDate <= selectedJournal.date + 24 * 60 * 60 * 1000);
             setJournalChartData(filteredChart.length > 0 ? filteredChart : chart);
           }
        })
        .catch(console.error);
    } else {
      setJournalChartData(null);
    }
  }, [selectedJournal]);

  // Bot State
  const [botState, setBotState] = useState({ 
    isRunning: false, 
    logs: [] as string[],
    capital: undefined as number | undefined,
    totalEquity: undefined as number | undefined,
    reserve: undefined as number | undefined,
    positions: [] as any[],
    journals: [] as any[],
    orders: [] as any[],
    history: [] as any[]
  });

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        const data = await res.json();
        if (Array.isArray(data)) setSearchResults(data);
      } catch (e) {}
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [botConfig, setBotConfig] = useState({ 
    symbol: '005930', price: 290000, qty: 1, profitTarget: 0.03, lossLimits: -0.05, useAI: true 
  });

  // 봇 상태 주기적 업데이트 (1초마다)
  useEffect(() => {
    const fetchBotStatus = async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        setBotState(data);
        if (data.isRunning === false) {
           // 서버 측 설정값을 동기화
           setBotConfig({
             symbol: data.targetSymbol,
             price: data.targetPrice,
             qty: data.tradeQty,
             profitTarget: data.profitTarget || 0.03,
             lossLimits: data.lossLimits || -0.05,
             useAI: data.useAI ?? true
           });
        }
      } catch (err) {
        // 서버 파업 무시
      }
    };
    fetchBotStatus();
    const interval = setInterval(fetchBotStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const toggleBot = async (action: "START" | "STOP") => {
     setBotState(prev => ({ ...prev, isRunning: action === "START" }));
     try {
       await fetch('/api/bot/config', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           action,
           ...botConfig
         })
       });
     } catch (err) {
       console.error("Bot action error:", err);
     }
  };

  const [accountInfo, setAccountInfo] = useState<{ accountNo?: string; isVts?: boolean } | null>(null);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthInitialized(true);
      console.log('User:', user?.uid);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    fetch('/api/kis/balance')
      .then(res => res.json())
      .then(data => {
         console.log('KIS Balance Response:', data);
         const accNo = data.accountNo || data.account_no || '정보 없음';
         const isVts = data.isVts ?? true; // 기본값은 모의투자로 취급
         setAccountInfo({ accountNo: accNo, isVts });

         if (data.error) {
            setApiStatus(`🔴 [연결 오류] ${data.error} | (${isVts ? '모의' : '실전'})`);
         } else {
            setApiStatus(`🟢 ${isVts ? '모의' : '실전'}연동됨: ${accNo}`);
         }
      })
      .catch(() => setApiStatus('🔴 서버 통신 불가'));
  }, []);

  useEffect(() => {
    fetchStockData(selectedSymbol);
  }, [selectedSymbol]);

  const fetchStockData = async (symbol: string) => {
    setLoading(true);
    setAnalysis(null);
    try {
      const parsedSymbol = symbol.split('.')[0];
      const res = await fetch(`/api/stock/${parsedSymbol}`);
      if (!res.ok) throw new Error("Fetch failed: " + res.status);
      
      const text = await res.text();
      let data;
      try {
         data = JSON.parse(text);
      } catch (e) {
         throw new Error("서버 응답 파싱 실패 (HTML을 반환했을 수 있습니다)");
      }
      
      if (!data.quote) {
         setStockData(null);
      } else {
        setStockData({
          quote: data.quote,
          chart: data.chart ? data.chart.map((d: any) => ({
            date: new Date(d.date).toLocaleDateString(),
            close: d.close,
            tenkan: d.tenkan,
            kijun: d.kijun,
            spanA: d.spanA,
            spanB: d.spanB
          })) : []
        });
      }
    } catch (error: any) {
      console.error('Fetch error:', error);
      setStockData(null);
      setApiStatus('🔴 ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const analyzeStock = async (isSellCheck = false) => {
    if (!stockData) return;
    setAnalyzing(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: stockData.quote.symbol,
          price: stockData.quote.regularMarketPrice,
          history: stockData.chart,
          isSellCheck
        })
      });
      const data = await res.json();
      setAnalysis({ text: data.analysis, confidence: data.confidence_score || 0, recommendation: data.recommendation });
    } catch (error) {
      console.error('Analysis error:', error);
    } finally {
      setAnalyzing(false);
    }
  };

  const positionsValue = (botState.positions || []).reduce((acc, pos) => acc + ((pos.currentPrice || pos.buyPrice) * (pos.qty || 0)), 0);
  const totalEquity = (botState.capital !== undefined && botState.reserve !== undefined) 
    ? botState.capital + botState.reserve + positionsValue 
    : undefined;

  if (!authInitialized) {
    return <div className="min-h-screen flex items-center justify-center font-mono opacity-50">Auth initialization...</div>;
  }

  if (!authUser) {
    return <LoginForm />;
  }

  return (
    <DashboardLayout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab}
      capital={botState.capital}
      reserve={botState.reserve}
      totalEquity={totalEquity}
      apiStatus={apiStatus}
      userEmail={authUser?.email}
    >
      {(() => {
        const lastError = botState.logs?.find(log => log.includes('에러') || log.includes('실패') || log.includes('Error') || log.includes('❌') || log.includes('⚠️'));
        if (!lastError) return null;
        return (
          <div className="mb-6 p-4 bg-red-50 border-l-4 border-red-500 rounded-r-xl flex items-start gap-3 animate-in slide-in-from-top-4 duration-300">
             <Activity size={20} className="text-red-500 mt-0.5 flex-shrink-0" />
             <div className="flex-grow">
                <div className="font-mono text-[10px] uppercase text-red-600 font-bold mb-1">최근 시스템 경고 / 에러 (Latest System Alert)</div>
                <div className="text-sm text-red-900 font-medium">{lastError}</div>
             </div>
             <button 
               onClick={() => setActiveTab('log')}
               className="text-[10px] font-mono uppercase bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded transition-colors whitespace-nowrap"
             >
               로그 확인
             </button>
          </div>
        );
      })()}
      {activeTab === 'search' && (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 md:p-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4 md:gap-0">
              <div className="flex-grow">
                <div className="font-mono text-xs uppercase opacity-50 mb-1">검색 및 차트 (Search & Chart)</div>
                <div className="flex items-center gap-4">
                  <h2 className="text-4xl font-bold">
                    {loading ? '로딩중...' : (stockData?.quote ? stockData.quote.symbol : selectedSymbol)}
                  </h2>
                  <div className="relative z-10 font-mono">
                    <div className="flex gap-2">
                       <input 
                         type="text" 
                         placeholder="종목명/심볼 005930..."
                         value={searchQuery}
                         onChange={(e) => setSearchQuery(e.target.value)}
                         className="bg-transparent border-b border-gray-200/30 font-mono text-sm px-2 py-1 focus:outline-none focus:border-gray-200 transition-colors w-64 uppercase"
                         onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                               if (searchResults.length > 0) {
                                   setSelectedSymbol(searchResults[0].symbol);
                                   setSearchQuery('');
                               } else if (searchQuery.trim().length > 0) {
                                   setSelectedSymbol(searchQuery);
                                   setSearchQuery('');
                               }
                            }
                         }}
                       />
                       <button
                         onClick={() => {
                            if (searchResults.length > 0) {
                               setSelectedSymbol(searchResults[0].symbol);
                            } else if (searchQuery.trim().length > 0) {
                               setSelectedSymbol(searchQuery);
                            }
                            setSearchQuery('');
                         }}
                         className="px-3 py-1 bg-gray-900 text-white text-xs font-bold uppercase transition-colors hover:bg-black"
                       >
                         검색
                       </button>
                    </div>
                    {searchResults.length > 0 && (
                      <div className="absolute top-full left-0 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                        {searchResults.map((res, idx) => (
                          <div 
                             key={idx}
                             className="px-3 py-2 cursor-pointer hover:bg-gray-900/5 text-xs truncate border-b border-gray-200/10 last:border-0"
                             onClick={() => {
                                setSelectedSymbol(res.symbol);
                                setSearchQuery('');
                             }}
                          >
                             <span className="font-bold opacity-70 w-16 inline-block">{res.symbol}</span> 
                             {res.name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-sm font-normal text-gray-900/60 mt-1">{stockData?.quote.shortName}</div>
              </div>
              <div className="text-left md:text-right w-full md:w-auto">
                <div className="font-mono text-3xl font-bold">
                  {stockData ? (stockData.quote.regularMarketPrice ? stockData.quote.regularMarketPrice.toLocaleString() + '원' : '---') : '---'}
                </div>
                <div className={`flex items-center md:justify-end gap-1 font-mono text-sm ${
                  (stockData?.quote.regularMarketChangePercent || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {(stockData?.quote.regularMarketChangePercent || 0) >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                  {stockData?.quote.regularMarketChangePercent ? `${stockData.quote.regularMarketChangePercent.toFixed(2)}%` : '---'}
                </div>
              </div>
            </div>

            <div className="h-[300px] md:h-[400px] w-full mt-6">
              {loading ? (
                 <div className="w-full h-full flex items-center justify-center border border-dashed border-gray-200/10 text-gray-900/50 font-mono text-sm">
                    데이터 불러오는 중...
                 </div>
              ) : stockData?.chart && stockData.chart.length > 0 ? (
                 <StockChart data={stockData.chart} />
              ) : (
                 <div className="w-full h-full flex items-center justify-center border border-dashed border-gray-200/10 text-gray-900/50 font-mono text-sm text-center px-8">
                    차트 데이터가 없습니다. <br/> 한국장 운영시간 외이거나 지원하지 않는 심볼일 수 있습니다.
                 </div>
              )}
            </div>
            
            <div className="mt-8 pt-8 border-t border-gray-200">
               <h3 className="font-mono text-xs uppercase mb-4 opacity-70 flex items-center gap-2">
                 <BrainCircuit size={14} className="text-blue-600" />
                 이 종목의 최근 매매 복기 (Trade Journals)
               </h3>
               <div className="space-y-3">
                 {botState.journals && botState.journals.filter(j => j.symbol === selectedSymbol || j.symbol.startsWith(selectedSymbol)).length > 0 ? (
                    botState.journals.filter(j => j.symbol === selectedSymbol || j.symbol.startsWith(selectedSymbol)).map((journal, idx) => (
                       <div 
                         key={idx} 
                         className="p-4 border border-gray-200 rounded-xl bg-gray-50 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer hover:bg-white transition-colors"
                         onClick={() => setSelectedJournal(journal)}
                       >
                          <div>
                            <div className="font-bold mb-1 flex items-center gap-2">
                              {journal.profitRate > 0 ? <TrendingUp size={16} className="text-green-600"/> : <TrendingDown size={16} className="text-red-600"/>}
                              {journal.name || journal.symbol}
                            </div>
                            <div className="text-xs font-mono opacity-60">
                              {new Date(journal.date).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-sm font-mono whitespace-nowrap">
                             <div className="flex flex-col text-right">
                               <span className="opacity-60 text-[10px]">매수단가</span>
                               <span>{journal.buyPrice?.toLocaleString()}원</span>
                             </div>
                             <div className="flex flex-col text-right">
                               <span className="opacity-60 text-[10px]">매도단가</span>
                               <span>{journal.sellPrice?.toLocaleString()}원</span>
                             </div>
                             <div className={`flex flex-col text-right ${journal.profitRate > 0 ? 'text-green-600' : 'text-red-600'}`}>
                               <span className="font-bold text-[10px]">수익률</span>
                               <span className="font-bold">{(journal.profitRate * 100).toFixed(2)}%</span>
                             </div>
                          </div>
                       </div>
                    ))
                 ) : (
                    <div className="p-4 text-center border border-dashed border-gray-200 rounded-xl text-gray-500 font-mono text-xs italic">
                       최근 매매 기록이 없습니다.
                    </div>
                 )}
               </div>
            </div>
          </section>

          <section className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div className="border border-gray-200 rounded-xl shadow-sm p-6 bg-white">
              <div className="flex items-center gap-3 mb-4 opacity-70">
                <Activity size={18} />
                <span className="font-mono text-xs uppercase">거시 지표 (Volatility)</span>
              </div>
              <div className="text-2xl font-bold">Medium</div>
            </div>
            <div className="border border-gray-200 rounded-xl shadow-sm p-6 bg-white">
              <div className="flex items-center gap-3 mb-4 opacity-70">
                <Target size={18} />
                <span className="font-mono text-xs uppercase">RSI (14)</span>
              </div>
              <div className="text-2xl font-bold">58.4</div>
            </div>
            <div className="border border-gray-200 rounded-xl shadow-sm p-6 bg-white">
              <div className="flex items-center gap-3 mb-4 opacity-70">
                <BrainCircuit size={18} />
                <span className="font-mono text-xs uppercase">AI Score</span>
              </div>
              <div className="text-2xl font-bold">{analysis?.confidence ? (analysis.confidence / 10).toFixed(1) : '-'} / 10</div>
            </div>
          </section>
        </div>

        <div className="lg:col-span-4 space-y-8">
          <section className="bg-gray-900 text-white p-4 md:p-8 min-h-[400px] flex flex-col rounded-xl shadow-xl">
            <div className="flex items-center justify-between mb-8">
              <h3 className="font-serif italic text-lg flex items-center gap-2">
                <BrainCircuit size={20} />
                Gemini Market Analysis
              </h3>
              <div className="flex gap-2">
                <button 
                  onClick={() => analyzeStock(true)}
                  disabled={analyzing || loading}
                  className="font-mono text-[10px] uppercase border border-red-500/50 text-red-400 px-3 py-1 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                >
                  AI Sell Check
                </button>
                <button 
                  onClick={() => analyzeStock(false)}
                  disabled={analyzing || loading}
                  className="font-mono text-[10px] uppercase border border-[#E4E3E0]/30 px-3 py-1 hover:bg-[#E4E3E0] hover:text-gray-900 transition-colors disabled:opacity-50"
                >
                  {analyzing ? '분석 중...' : '분석 실행'}
                </button>
              </div>
            </div>

            <div className="flex-grow prose prose-invert max-w-none prose-sm font-sans opacity-90 overflow-auto max-h-[500px]">
              {analysis ? (
                <div>
                  <div className="mb-4 flex flex-wrap gap-2 items-center">
                    {analysis.confidence > 0 && (
                      <div className="inline-flex items-center gap-2 bg-blue-900/50 text-blue-200 px-3 py-1.5 rounded-full text-xs font-bold border border-blue-500/30">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                        Confidence: {analysis.confidence}%
                      </div>
                    )}
                    {analysis.recommendation && (
                      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border ${analysis.recommendation === 'SELL' ? 'bg-red-900/50 text-red-200 border-red-500/30' : 'bg-green-900/50 text-green-200 border-green-500/30'}`}>
                        {analysis.recommendation === 'SELL' ? '📉 AI 추천: 매도 (SELL)' : '🛡️ AI 추천: 홀딩 (HOLD)'}
                      </div>
                    )}
                  </div>
                  <Markdown>{analysis.text}</Markdown>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-center opacity-40 italic mt-20">
                  Gemini 분석을 실행하여 실시간 시장 통찰과 전략을 받아보세요.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      )}

      {activeTab === 'explore' && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
           <h2 className="text-3xl font-serif italic mb-6">시장 (Market)</h2>

           <section className="border border-gray-200 rounded-xl shadow-sm p-4 md:p-8 bg-white mb-8">
             <h3 className="font-mono text-xs uppercase mb-6 flex items-center gap-2">
               <Target size={16} />
               🤖 자동매매 봇 설정
             </h3>

             <div className="text-[10px] font-mono text-blue-600 mb-6 py-2 px-3 bg-blue-50 border border-blue-200">
               안내: 실시간 퀀트 알고리즘(거래대금/시총/차트)을 통해 선별된 주도주 20종목을 우선적으로 감시합니다.
             </div>
             
             <div className="space-y-4 mb-6">
               <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                 <div className="col-span-2">
                   <label className="block font-mono text-[10px] uppercase opacity-60 mb-1">종목당 진입 금액 (Buy Amount ₩)</label>
                   <input 
                     type="number" 
                     value={botConfig.price}
                     onChange={(e) => setBotConfig({...botConfig, price: parseFloat(e.target.value)})}
                     disabled={botState.isRunning}
                     className="w-full bg-transparent border-b border-gray-200 font-mono text-sm py-1 focus:outline-none disabled:opacity-50"
                   />
                 </div>
                 <div>
                   <label className="block font-mono text-[10px] uppercase text-green-600 opacity-80 mb-1">초단타 익절 (%)</label>
                   <input 
                     type="number" 
                     step="0.01"
                     value={botConfig.profitTarget * 100}
                     onChange={(e) => setBotConfig({...botConfig, profitTarget: parseFloat(e.target.value) / 100})}
                     disabled={botState.isRunning}
                     className={`w-full bg-transparent border-b border-gray-200 font-mono text-sm py-1 focus:outline-none disabled:opacity-50 ${botConfig.profitTarget > 0 ? 'text-green-600 font-bold' : ''}`}
                   />
                 </div>
                 <div>
                   <label className="block font-mono text-[10px] uppercase text-red-600 opacity-80 mb-1">급락장 손절 (%)</label>
                   <input 
                     type="number" 
                     step="0.01"
                     value={botConfig.lossLimits * 100}
                     onChange={(e) => setBotConfig({...botConfig, lossLimits: parseFloat(e.target.value) / 100})}
                     disabled={botState.isRunning}
                     className={`w-full bg-transparent border-b border-gray-200 font-mono text-sm py-1 focus:outline-none disabled:opacity-50 ${botConfig.lossLimits < 0 ? 'text-red-600 font-bold' : ''}`}
                   />
                 </div>
               </div>
               
               <div className="flex items-center gap-3 pt-2">
                 <input 
                   type="checkbox" 
                   id="ai-toggle"
                   checked={botConfig.useAI}
                   onChange={(e) => setBotConfig({...botConfig, useAI: e.target.checked})}
                   disabled={botState.isRunning}
                   className="w-4 h-4 accent-[#141414]"
                 />
                 <label htmlFor="ai-toggle" className="font-mono text-[10px] flex items-center gap-2">
                   <BrainCircuit size={14} className={botConfig.useAI ? "text-blue-600" : "opacity-30"}/>
                   매수 전 Gemini 강제 분석 승인
                 </label>
               </div>
             </div>

             <div className="mb-6">
               {!botState.isRunning ? (
                 <button 
                   onClick={() => toggleBot("START")}
                   className="w-full bg-gray-900 text-white font-mono uppercase text-xs tracking-widest py-3 font-bold hover:bg-gray-900/80 transition-colors"
                 >
                   🚀 자동매매 봇 시작
                 </button>
               ) : (
                 <button 
                   onClick={() => toggleBot("STOP")}
                   className="w-full bg-red-600 text-white font-mono uppercase text-[10px] tracking-widest py-3 font-bold hover:bg-red-700 transition-colors animate-pulse flex items-center justify-center gap-2"
                 >
                   <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
                   Running... Stop
                 </button>
               )}
             </div>
           </section>

           <div className="mb-8 p-6 bg-white border border-gray-200 rounded-xl shadow-sm">
             <h3 className="font-mono text-xs uppercase mb-4 opacity-70">실시간 감시 종목 (퀀트 주도주 Top 20)</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                 {(botState as any).watchList && (botState as any).watchList.length > 0 ? (
                   (botState as any).watchList.map((item: any) => (
                    <div key={item.symbol} className="border border-gray-200 rounded-lg p-3 bg-gray-50 cursor-pointer hover:bg-white hover:border-blue-500 transition-colors group" onClick={() => { setSelectedSymbol(item.symbol); setActiveTab('search'); }}>
                       <div className="text-sm font-bold group-hover:text-blue-600 truncate">{item.name || item.symbol}</div>
                       <div className="text-[10px] font-mono opacity-50">{item.symbol}</div>
                    </div>
                   ))
                 ) : (
                   ['005930', '000660', '373220', '207940', '005380', '000270', '068270', '051910', '035420', '323410', '006400', '105560'].map((sym) => (
                    <div key={sym} className="border border-gray-200 rounded-lg p-3 bg-gray-50 cursor-pointer hover:bg-white hover:border-blue-500 transition-colors group" onClick={() => { setSelectedSymbol(sym); setActiveTab('search'); }}>
                       <div className="text-sm font-bold group-hover:text-blue-600">{sym}</div>
                    </div>
                   ))
                 )}
              </div>
            </div>

            <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 md:p-8">
             <div className="flex items-center justify-between mb-6">
                <div className="flex flex-col">
                   <h3 className="font-serif italic text-lg uppercase">통계 요약 (Market Insights)</h3>
                   <span className="text-[10px] font-mono opacity-50 uppercase tracking-widest">Global Asset Snapshot</span>
                </div>
                <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                   {(['D', 'W', 'M', 'Y'] as const).map(p => (
                      <button
                         key={p}
                         onClick={() => setHistoryPeriod(p)}
                         className={`px-3 py-1 text-[10px] font-mono rounded-md transition-all ${historyPeriod === p ? 'bg-white shadow-sm font-bold' : 'opacity-50 hover:opacity-100'}`}
                      >
                         {p === 'D' ? 'D' : p === 'W' ? 'W' : p === 'M' ? 'M' : 'Y'}
                      </button>
                   ))}
                </div>
             </div>
             <AssetHistoryChart data={getFilteredHistory(botState.history, historyPeriod)} />
           </section>
        </div>
      )}

      {activeTab === 'portfolio' && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
           {/* 안전 금고 위젯 추가 */}
           <div className="bg-gradient-to-br from-green-50 to-emerald-100 border border-green-200 rounded-3xl p-8 shadow-sm flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="flex items-center gap-5">
                 <div className="bg-white p-4 rounded-2xl shadow-sm text-green-600 flex-shrink-0">
                    <Shield size={32} />
                 </div>
                 <div>
                    <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                      안전 금고 (Safe Vault)
                      <span className="bg-green-200 text-green-800 text-[10px] px-2 py-0.5 rounded-full font-mono uppercase tracking-wider">Unlosable</span>
                    </h3>
                    <p className="text-sm text-gray-600 mt-1 max-w-[400px]">
                      익절 발생 시 순수익금의 20%를 복리 보존 및 리스크 헷지를 위해 이곳에 영구 보관합니다. 이 금액은 봇이 매매에 재투자하지 않는 안전 자산입니다.
                    </p>
                 </div>
              </div>
              <div className="text-right flex-shrink-0 bg-white/60 px-6 py-4 rounded-2xl border border-green-100 backdrop-blur-sm">
                 <div className="text-[10px] uppercase font-mono tracking-wider text-green-700 opacity-80 mb-1">총 누적 금고액</div>
                 <div className="text-4xl font-black font-mono text-green-700">
                    ₩{botState.reserve?.toLocaleString() || '0'}
                 </div>
              </div>
           </div>

           <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-black pb-6">
              <h2 className="text-3xl font-serif italic">보유 포지션 (Open Positions)</h2>
              <div className="flex gap-8 font-mono">
                 <div className="text-right">
                    <div className="text-[10px] opacity-50 uppercase">총 매수 금액</div>
                    <div className="text-2xl font-bold">
                      ₩{(botState.positions?.reduce((acc: number, pos: any) => acc + (pos.buyPrice * pos.qty), 0) || 0).toLocaleString()}
                    </div>
                 </div>
                 <div className="text-right">
                    <div className="text-[10px] opacity-50 uppercase">총 평가 손익</div>
                    <div className={`text-2xl font-bold ${(botState.positions?.reduce((acc: number, pos: any) => acc + (pos.profitAmount || 0), 0) || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      { (botState.positions?.reduce((acc: number, pos: any) => acc + (pos.profitAmount || 0), 0) || 0) > 0 ? '+' : '' }
                      ₩{(botState.positions?.reduce((acc: number, pos: any) => acc + (pos.profitAmount || 0), 0) || 0).toLocaleString()}
                    </div>
                 </div>
              </div>
           </div>
           <div className="text-xs font-mono text-blue-600 mb-6 py-2 px-3 bg-blue-50 border border-blue-200">
              보유 중인 종목은 진입 후 24시간이 경과하면 설정에 관계없이 시장가로 강제 청산(타임컷)됩니다.
           </div>
           {botState.positions && botState.positions.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                 {botState.positions.map((pos, i) => (
                    <div key={i} className="border border-gray-200 rounded-xl shadow-sm p-6 bg-white transition-all hover:shadow-md cursor-pointer" onClick={() => { setSelectedSymbol(pos.symbol); setActiveTab('search'); }}>
                       <div className="flex justify-between items-start mb-4">
                            <div className="flex flex-col">
                               <h3 className="font-bold text-xl">{pos.name || 'Unknown'}</h3>
                               <span className="font-mono text-xs opacity-60">{pos.symbol} · {pos.qty}주</span>
                            </div>
                            {pos.profitRate !== undefined && (
                               <div className={`text-right font-mono font-bold text-sm ${pos.profitRate >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  <div>{pos.profitRate > 0 ? '+' : ''}{(pos.profitRate * 100).toFixed(2)}%</div>
                                  <div className="text-xs">{(pos.profitAmount || 0) > 0 ? '+' : ''}₩{Math.round(pos.profitAmount || 0).toLocaleString()}</div>
                               </div>
                            )}
                        </div>
                        <div className="space-y-2 font-mono text-sm border-t border-gray-100 pt-3">
                           <div className="flex justify-between border-b border-gray-200/10 pb-1">
                               <span className="opacity-60 text-xs">진입가 (Buy)</span>
                               <span className="font-semibold">₩{pos.buyPrice?.toLocaleString() || '---'}</span>
                           </div>
                           <div className="flex justify-between border-b border-gray-200/10 pb-1">
                               <span className="opacity-60 text-xs">현재가 (Close)</span>
                               <span className="font-semibold">₩{pos.currentPrice?.toLocaleString() || '---'}</span>
                           </div>
                           <div className="flex justify-between border-b border-gray-200/10 pb-1">
                               <span className="opacity-60 text-xs">매수금액 (Total)</span>
                               <span className="font-semibold">₩{(pos.buyPrice * pos.qty).toLocaleString()}</span>
                           </div>
                           <div className="flex justify-between pt-1">
                               <span className="opacity-60 text-xs text-red-500">진입 시간</span>
                               <span className="text-[10px]">{pos.buyTime ? new Date(pos.buyTime).toLocaleString() : '---'}</span>
                           </div>
                        </div>
                    </div>
                 ))}
              </div>
           ) : (
              <div className="border border-gray-200 rounded-xl shadow-sm p-12 text-center bg-white font-mono text-sm opacity-60">
                 현재 보유 중인 포지션이 없습니다. (No active positions)
              </div>
           )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
           <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-black pb-6">
              <h2 className="text-3xl font-serif italic">거래 및 자산 기록 (History)</h2>
              <div className="flex gap-8 font-mono">
                 <div className="text-right">
                    <div className="text-[10px] opacity-50 uppercase">현재 총 자산</div>
                    <div className="text-2xl font-bold">₩{botState.totalEquity?.toLocaleString() || '0'}</div>
                 </div>
                 <div className="text-right">
                    <div className="text-[10px] opacity-50 uppercase">보유 안전 금고</div>
                    <div className="text-2xl font-bold text-blue-600">₩{botState.reserve?.toLocaleString() || '0'}</div>
                 </div>
              </div>
           </div>

           <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              {[
                { 
                  label: '누적 수익금 (ROI ₩)', 
                  value: botState.totalEquity !== undefined 
                    ? (botState.totalEquity - (botState.history[0]?.totalEquity || botState.totalEquity)) 
                    : 0, 
                  color: 'text-gray-900' 
                },
                { 
                  label: '누적 수익률 (%)', 
                  value: botState.totalEquity !== undefined 
                    ? (((botState.totalEquity - (botState.history[0]?.totalEquity || botState.totalEquity)) / (botState.history[0]?.totalEquity || botState.totalEquity)) * 100).toFixed(2) + '%' 
                    : '0.00%', 
                  color: 'text-blue-600' 
                },
                { label: '총 체결 기록 (History)', value: botState.orders?.length || 0, color: 'text-gray-900' },
                { label: 'AI 복기 장부 (Journals)', value: botState.journals?.length || 0, color: 'text-gray-900' },
              ].map((stat, i) => (
                <div key={i} className="bg-white border border-gray-200 p-4 rounded-xl shadow-sm">
                   <div className="text-[10px] font-mono opacity-50 uppercase mb-1">{stat.label}</div>
                   <div className={`text-xl font-bold ${stat.color}`}>
                     {typeof stat.value === 'number' && stat.value >= 0 ? '+' : ''}
                     {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
                     {typeof stat.value === 'number' && i === 0 ? '원' : ''}
                   </div>
                </div>
              ))}
           </div>

           <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 md:p-8 mb-8">
              <div className="flex justify-between items-center mb-6">
                <h3 className="font-mono text-xs uppercase flex items-center gap-2">
                  <Activity size={16} />
                  📈 자산 증식 그래프 (Growth)
                </h3>
                <button 
                  onClick={async () => {
                     const res = await fetch('/api/bot/snapshot/manual', { method: 'POST' });
                     const data = await res.json();
                     if (data.success) {
                        alert(`스냅샷 기록 완료! (오늘의 자산: ₩${data.snapshot.totalEquity.toLocaleString()})`);
                        // Refresh status
                        const sRes = await fetch('/api/bot/status');
                        const sData = await sRes.json();
                        setBotState(sData);
                     }
                  }}
                  className="font-mono text-[10px] uppercase border border-gray-900 px-3 py-1 hover:bg-gray-900 hover:text-white transition-colors"
                >
                   실시간 자산 기록 (New Snapshot)
                </button>
                <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                   {(['D', 'W', 'M', 'Y'] as const).map(p => (
                      <button
                         key={p}
                         onClick={() => setHistoryPeriod(p)}
                         className={`px-3 py-1 text-[10px] font-mono rounded-md transition-all ${historyPeriod === p ? 'bg-white shadow-sm font-bold' : 'opacity-50 hover:opacity-100'}`}
                      >
                         {p === 'D' ? 'D' : p === 'W' ? 'W' : p === 'M' ? 'M' : 'Y'}
                      </button>
                   ))}
                </div>
              </div>
              <AssetHistoryChart data={getFilteredHistory(botState.history, historyPeriod)} />
           </section>
           
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
             <div>
               <h3 className="text-xl font-bold font-mono mb-4 border-b border-black pb-2 flex items-center gap-2">
                 <BrainCircuit size={20} className="text-blue-600" />
                 AI 매매 복기 (Trade Journal)
               </h3>
               
               <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                 {botState.journals && botState.journals.length > 0 ? (
                    botState.journals.map((journal, idx) => (
                       <div 
                         key={idx} 
                         className="p-4 border border-gray-200 bg-white shadow-sm cursor-pointer hover:bg-gray-50 transition-colors rounded-xl"
                         onClick={() => setSelectedJournal(journal)}
                       >
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-lg">{journal.name || journal.symbol} <span className="text-xs font-mono opacity-50 ml-1">{journal.symbol}</span></span>
                            <div className="text-right flex items-center">
                              <span className={`text-base font-bold uppercase ${journal.profitRate > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                 {journal.profitAmount > 0 ? '+' : ''}{(journal.profitAmount || 0).toLocaleString()}원
                              </span>
                              <span className={`text-xs ml-2 font-bold px-2 py-0.5 uppercase ${journal.profitRate > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                 {(journal.profitRate * 100).toFixed(2)}%
                              </span>
                            </div>
                          </div>
                          
                          <div className="text-xs font-mono opacity-40 mb-3 ml-0.5">
                            {new Date(journal.date).toLocaleString()}
                          </div>

                          <div className="text-sm leading-relaxed bg-gray-50 p-3 border border-gray-200 rounded-xl shadow-sm">
                            <span className="text-blue-600 font-bold mr-1">🤖 AI:</span>
                            <span className="line-clamp-2">{journal.review ? journal.review.substring(0, 150) : ''}...</span>
                          </div>
                       </div>
                    ))
                 ) : (
                    <div className="border border-gray-200 p-8 text-center bg-gray-50 font-mono text-sm opacity-50 rounded-xl italic">
                       기록된 매매가 없습니다.
                    </div>
                 )}
               </div>
             </div>

             <div id="trade-history">
               <h3 className="text-xl font-bold font-mono mb-4 border-b border-black pb-2 flex items-center gap-2">
                 <Activity size={20} />
                 최근 거래 체결 내역 (Trade History)
               </h3>
               
               <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                 {botState.orders && botState.orders.length > 0 ? (
                    botState.orders.map((order, idx) => (
                       <div key={idx} className="p-4 border border-gray-200 bg-white shadow-sm font-sans text-sm rounded-xl transition-all hover:shadow-md">
                          <div className="flex justify-between items-center mb-3">
                             <div className="flex items-center gap-2">
                                <span className={`px-2.5 py-1 rounded-md text-xs font-bold ${order.type === 'BUY' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>
                                   {order.type === 'BUY' ? '매수 (BUY)' : '매도 (SELL)'}
                                </span>
                                <span className="font-bold text-gray-900">{order.name || order.symbol}</span>
                                <span className="text-gray-400 text-xs font-mono">{order.symbol}</span>
                             </div>
                             <span className="text-gray-400 text-xs font-mono">{new Date(order.timestamp).toLocaleString()}</span>
                          </div>
                          
                          <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-y-2 gap-x-4 mb-3">
                             <div className="flex justify-between">
                                <span className="text-gray-500">체결단가</span>
                                <span className="font-mono font-medium text-gray-900">{order.price.toLocaleString()}원</span>
                             </div>
                             <div className="flex justify-between">
                                <span className="text-gray-500">수량</span>
                                <span className="font-mono font-medium text-gray-900">{order.qty.toLocaleString()}주</span>
                             </div>
                             <div className="col-span-2 flex justify-between border-t border-gray-200 pt-2 mt-1">
                                <span className="text-gray-500">총 거래대금</span>
                                <span className="font-mono font-bold text-gray-900">{order.amount.toLocaleString()}원</span>
                             </div>
                          </div>

                          {order.type === 'SELL' && order.profitRate !== undefined && (
                             <div className={`p-3 rounded-lg mb-3 border ${order.profitRate >= 0 ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                                <div className="flex justify-between items-center">
                                   <span className={`font-bold ${order.profitRate >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                      {order.profitRate >= 0 ? '수익 (Profit)' : '손실 (Loss)'}
                                   </span>
                                   <div className={`text-right font-mono font-bold text-lg ${order.profitRate >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                      {order.profitRate > 0 ? '+' : ''}{(order.profitAmount || 0).toLocaleString()}원
                                      <span className="text-sm ml-2">
                                         ({order.profitRate > 0 ? '+' : ''}{(order.profitRate * 100).toFixed(2)}%)
                                      </span>
                                   </div>
                                </div>
                             </div>
                          )}

                          <div className="space-y-2">
                             <div className="flex items-start gap-2">
                                <span className="text-gray-500 text-xs shrink-0 mt-0.5">트리거:</span>
                                <span className="text-gray-700 text-sm font-medium">{order.message || '-'}</span>
                             </div>
                             
                             {order.aiReason && (
                                <div className="flex items-start gap-2 bg-blue-50/50 p-2.5 rounded-lg border border-blue-100/50 mt-2">
                                   <span className="shrink-0 mt-0.5">🤖</span>
                                   <div className="flex flex-col gap-1 w-full">
                                      {order.aiConfidence !== undefined && (
                                         <span className="text-xs font-bold text-blue-800">
                                            Confidence: {order.aiConfidence}%
                                         </span>
                                      )}
                                      <p className="text-sm text-blue-900 leading-snug">{order.aiReason}</p>
                                   </div>
                                </div>
                             )}
                             {order.type === 'SELL' && botState.journals?.some(j => j.symbol === order.symbol && Math.abs(j.date - order.timestamp) < 60000) && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const journal = botState.journals?.find(j => j.symbol === order.symbol && Math.abs(j.date - order.timestamp) < 60000);
                                    if (journal) setSelectedJournal(journal);
                                  }}
                                  className="mt-3 w-full bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold text-xs py-2 px-4 rounded-lg flex items-center justify-center gap-2 border border-blue-200 transition-colors"
                                >
                                  <BrainCircuit size={14} />
                                  View AI Review
                                </button>
                             )}
                          </div>
                       </div>
                    ))
                 ) : (
                    <div className="border border-gray-200 p-8 text-center bg-gray-50 font-mono text-sm opacity-50 rounded-xl italic">
                       최근 체결 기록이 없습니다.
                    </div>
                 )}
               </div>
             </div>
           </div>
        </div>
      )}

      {activeTab === 'log' && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
           <h2 className="text-3xl font-serif italic mb-6">시스템 로그 (Logs)</h2>
           <div className="border border-gray-200 rounded-xl shadow-sm bg-gray-900 text-[#80ff80] p-6 min-h-[500px] font-mono text-sm shadow-xl overflow-y-auto h-[600px] md:h-[700px] custom-scrollbar">
              {botState.logs && botState.logs.length > 0 ? (
                 botState.logs.map((log, idx) => (
                    <div key={idx} className="mb-2 pb-2 border-b border-[#E4E3E0]/10 last:border-0 hover:bg-[#E4E3E0]/5 px-2 -mx-2">{log}</div>
                 ))
              ) : (
                <div className="opacity-50 italic">기록된 로그가 없습니다. (System is quiet)</div>
              )}
           </div>
        </div>
      )}
      {activeTab === 'backtest' && <BacktestView />}
      {selectedJournal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setSelectedJournal(null)}>
          <div className="bg-white border-2 border-black w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b-2 border-black flex justify-between items-center bg-gray-50">
              <h3 className="font-bold text-xl font-mono flex items-center gap-2">
                <BrainCircuit size={24} className="text-blue-600" />
                AI Trade Journal
              </h3>
              <button 
                onClick={() => setSelectedJournal(null)}
                className="text-gray-500 hover:text-black font-bold p-1"
              >
                ✕
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
               <div className="flex justify-between items-center mb-6">
                 <div>
                    <h4 className="text-3xl font-bold font-mono text-gray-900">{selectedJournal.name || selectedJournal.symbol}</h4>
                    <div className="text-sm font-mono opacity-60 text-gray-800">{new Date(selectedJournal.date).toLocaleString()}</div>
                 </div>
                 <div className={`text-xl font-bold px-4 py-2 uppercase border-2 ${selectedJournal.profitRate > 0 ? 'bg-green-100 text-green-700 border-green-500' : 'bg-red-100 text-red-700 border-red-500'}`}>
                    수익률: {(selectedJournal.profitRate * 100).toFixed(2)}%
                 </div>
               </div>
               
               <div className="grid grid-cols-2 gap-4 font-mono text-sm mb-6 pb-6 border-b border-gray-200">
                 <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl shadow-sm">
                    <div className="opacity-60 mb-1 text-gray-700">진입가 (Buy Price)</div>
                    <div className="text-xl font-bold text-gray-900">{selectedJournal.buyPrice.toLocaleString()}원</div>
                 </div>
                 <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl shadow-sm">
                    <div className="opacity-60 mb-1 text-gray-700">청산가 (Sell Price)</div>
                    <div className="text-xl font-bold text-gray-900">{selectedJournal.sellPrice.toLocaleString()}원</div>
                 </div>
               </div>

               <div className="mb-4">
                  <h5 className="font-bold text-lg mb-3 flex items-center gap-2 border-l-4 border-blue-600 pl-2 text-gray-900">
                     <BrainCircuit size={18} />
                     전체 AI 복기 레포트
                  </h5>
                  <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-headings:text-gray-900 prose-headings:font-bold prose-a:text-blue-600 prose-blue bg-white font-sans text-gray-800 pb-8">
                     <Markdown>{selectedJournal.review}</Markdown>
                  </div>
             </div>
           </div>
            </div>
          </div>
        )}
    </DashboardLayout>
  );
}

