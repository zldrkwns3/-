import { useState } from 'react';
import { Target, Activity, Settings2 } from 'lucide-react';
import StockChart from './StockChart.tsx';
import { ChartData } from '../types.ts';

export default function BacktestView() {
  const [symbol, setSymbol] = useState('005930');
  const [days, setDays] = useState(365);
  const [capital, setCapital] = useState(10000000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<ChartData[] | null>(null);

  const runBacktest = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setChartData(null);
    try {
      const res = await fetch(`/api/backtest?symbol=${symbol}&days=${days}&capital=${capital}`);
      const data = await res.json();
      if (data.success) {
        setResult(data.data);
        
        // 차트 데이터를 가져와서 시그널 맵핑
        fetch(`/api/stock/${symbol.split('.')[0]}`)
          .then(r => r.json())
          .then(stock => {
             if (stock.chart) {
               const mapped = stock.chart.map((d: any) => {
                 const dateStr = new Date(d.date).toLocaleDateString();
                 const matchedTrades = data.data.trades.filter((t: any) => new Date(t.date).toLocaleDateString() === dateStr);
                 
                 let buySignal, sellSignal;
                 matchedTrades.forEach((t: any) => {
                    if (t.type.includes('BUY')) buySignal = d.close;
                    if (t.type.includes('SELL')) sellSignal = d.close;
                 });

                 return {
                    date: dateStr,
                    close: d.close,
                    tenkan: d.tenkan,
                    kijun: d.kijun,
                    spanA: d.spanA,
                    spanB: d.spanB,
                    buySignal,
                    sellSignal
                 };
               });
               setChartData(mapped);
             }
          }).catch(console.error);

      } else {
        setError(data.message || '백테스트 중 오류가 발생했습니다.');
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-3xl font-serif italic mb-6">전략 백테스트 (Strategy Backtest)</h2>
      <div className="text-sm font-mono opacity-80 bg-white p-4 border border-[#141414]">
        과거 데이터를 기반으로 현재 AI 봇에 적용된 트레이딩 기법들을 시뮬레이션 합니다. (일봉 기준 시뮬레이션으로 실제 분봉/틱 단위 매매와 차이가 있을 수 있습니다.)
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="border border-[#141414] bg-white p-6">
          <h3 className="text-xl font-bold font-mono mb-4 border-b border-gray-200 pb-2 flex items-center gap-2">
            <Settings2 size={20} /> 테스트 설정
          </h3>
          <div className="space-y-4 font-mono text-sm">
            <div>
              <label className="block opacity-60 mb-1">대상 종목코드</label>
              <input 
                type="text" 
                value={symbol}
                onChange={e => setSymbol(e.target.value)}
                className="w-full border border-black p-2 bg-gray-50 focus:bg-white outline-none"
              />
            </div>
            <div>
              <label className="block opacity-60 mb-1">테스트 기간 (최근 N일)</label>
              <input 
                type="number" 
                value={days}
                onChange={e => setDays(Number(e.target.value))}
                className="w-full border border-black p-2 bg-gray-50 focus:bg-white outline-none"
              />
            </div>
            <div>
              <label className="block opacity-60 mb-1">초기 자본금</label>
              <input 
                type="number" 
                value={capital}
                onChange={e => setCapital(Number(e.target.value))}
                className="w-full border border-black p-2 bg-gray-50 focus:bg-white outline-none"
              />
            </div>
            
            <button 
              onClick={runBacktest}
              disabled={loading}
              className="w-full mt-4 bg-black text-white hover:bg-gray-800 disabled:bg-gray-400 py-3 uppercase tracking-widest font-bold font-mono transition-colors"
            >
              {loading ? '시뮬레이션 중...' : '백테스트 실행'}
            </button>
            {error && <div className="text-red-500 mt-2 text-xs">{error}</div>}
          </div>
        </div>

        <div className="lg:col-span-2">
          {loading && (
             <div className="h-full min-h-[300px] border border-[#141414] bg-white/50 flex flex-col items-center justify-center font-mono opacity-50 space-y-4">
                <Activity size={48} className="animate-pulse" />
                <span>데이터 수집 및 시뮬레이션 진행 중...</span>
             </div>
          )}
          {!loading && result && (
            <div className="border border-[#141414] bg-white p-6 h-full">
              <h3 className="text-2xl font-bold font-mono mb-6 border-b border-gray-200 pb-2">시뮬레이션 결과</h3>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">초기 시작금</div>
                  <div className="font-bold">{result.initialCapital.toLocaleString()}원</div>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">최종 평가 잔액</div>
                  <div className={`font-bold ${result.finalBalance > result.initialCapital ? 'text-green-600' : 'text-red-600'}`}>
                    {result.finalBalance.toLocaleString()}원
                  </div>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">총 수익률</div>
                  <div className={`font-bold ${result.totalReturnPct > 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {result.totalReturnPct.toFixed(2)}%
                  </div>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">최대 낙폭 (MDD)</div>
                  <div className="font-bold text-red-600">
                    -{result.maxDrawdown.toFixed(2)}%
                  </div>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">승률 (Win Rate)</div>
                  <div className="font-bold">
                    {result.winRate.toFixed(1)}%
                  </div>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200">
                  <div className="text-xs opacity-60 mb-1">총 매매 횟수</div>
                  <div className="font-bold">
                    {result.totalTrades}회
                  </div>
                </div>
              </div>

              {chartData && chartData.length > 0 && (
                <div className="mb-8 h-[400px]">
                  <h4 className="font-bold text-lg mb-4 font-mono border-b border-gray-100 pb-2">백테스트 시뮬레이션 차트</h4>
                  <div className="text-xs text-gray-500 mb-2 flex gap-4">
                     <div><span className="inline-block w-2 h-2 rounded-full bg-blue-600 mr-1"></span>매수 타점</div>
                     <div><span className="inline-block w-2 h-2 rounded-full bg-red-600 mr-1"></span>매도 타점</div>
                  </div>
                  <div className="h-full border border-gray-100 bg-gray-50/50 pt-4">
                    <StockChart data={chartData} />
                  </div>
                </div>
              )}

              <h4 className="font-bold text-lg mb-4 font-mono border-b border-gray-100 pb-2">주요 매매 내역</h4>
              <div className="max-h-[400px] overflow-y-auto pr-2 space-y-2">
                {result.trades.map((trade: any, idx: number) => (
                   <div key={idx} className="flex justify-between items-center text-sm font-mono border-b border-gray-100 pb-2 hover:bg-gray-50 p-2">
                     <div className="flex gap-4">
                       <span className={trade.type.includes('BUY') ? 'text-blue-600 font-bold' : 'text-red-600 font-bold w-12'}>
                         {trade.type.includes('BUY') ? '매수' : '매도'}
                       </span>
                       <span className="opacity-60">{new Date(trade.date).toLocaleDateString()}</span>
                       <span className="opacity-80">[{trade.reason}]</span>
                     </div>
                     <div className="text-right">
                       <div className="font-bold">{trade.price.toLocaleString()}원</div>
                       {trade.profitRate !== undefined && (
                         <div className={`text-xs ${trade.profitRate > 0 ? 'text-green-600' : 'text-red-600'}`}>
                           {(trade.profitRate * 100).toFixed(2)}%
                         </div>
                       )}
                     </div>
                   </div>
                ))}
                {result.trades.length === 0 && (
                  <div className="text-center py-8 opacity-50 italic">이 기간 내에 매매된 내역이 없습니다. (조건 불만족)</div>
                )}
              </div>
            </div>
          )}
          {!loading && !result && !error && (
            <div className="h-full min-h-[300px] border border-[#141414] bg-white flex flex-col items-center justify-center font-mono opacity-50 space-y-4">
               <Target size={48} className="opacity-20" />
               <span>좌측에서 테스트 조건을 설정하고 실행해주세요.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
