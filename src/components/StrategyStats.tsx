import { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase.ts';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts';
import { BarChart2, TrendingUp, Clock, Award } from 'lucide-react';

interface TradeDoc {
  symbol: string;
  strategyName?: string;
  profitRate: number;
  holdTimeMinutes?: number;
  maxPaperProfit?: number;
  date: number;
}

interface StrategyStat {
  name: string;
  shortName: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfit: number;
  avgHoldMin: number;
  avgMaxPaperProfit: number;
}

const STRATEGY_COLOR: Record<string, string> = {
  'A': '#f59e0b', 'B': '#3b82f6', 'C': '#8b5cf6', 'D': '#06b6d4', 'E': '#ec4899',
  'F': '#10b981', 'G': '#f97316',
};

function getColor(name: string, value: number) {
  const key = Object.keys(STRATEGY_COLOR).find(k => name.includes(`기법 ${k}`)) ?? '';
  return STRATEGY_COLOR[key] ?? (value >= 0 ? '#16a34a' : '#dc2626');
}

export default function StrategyStats() {
  const [stats, setStats] = useState<StrategyStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalTrades, setTotalTrades] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        if (!db) { setError('Firebase 초기화 실패'); setLoading(false); return; }
        const snap = await getDocs(collection(db, 'trades'));
        const docs: TradeDoc[] = snap.docs.map(d => d.data() as TradeDoc);
        setTotalTrades(docs.length);

        const map = new Map<string, { trades: TradeDoc[] }>();
        for (const t of docs) {
          const key = t.strategyName || '미분류';
          if (!map.has(key)) map.set(key, { trades: [] });
          map.get(key)!.trades.push(t);
        }

        const result: StrategyStat[] = [];
        for (const [name, { trades }] of map.entries()) {
          const wins = trades.filter(t => t.profitRate > 0).length;
          const total = trades.length;
          const avgProfit = trades.reduce((s, t) => s + t.profitRate * 100, 0) / total;
          const holdTrades = trades.filter(t => t.holdTimeMinutes != null);
          const avgHoldMin = holdTrades.length > 0
            ? holdTrades.reduce((s, t) => s + (t.holdTimeMinutes ?? 0), 0) / holdTrades.length
            : 0;
          const paperTrades = trades.filter(t => t.maxPaperProfit != null);
          const avgMaxPaperProfit = paperTrades.length > 0
            ? paperTrades.reduce((s, t) => s + (t.maxPaperProfit ?? 0) * 100, 0) / paperTrades.length
            : 0;

          // 짧은 이름 추출 (🔥 기법 A: ... → 기법 A)
          const shortMatch = name.match(/기법\s[A-Z]/);
          result.push({
            name,
            shortName: shortMatch ? shortMatch[0] : name.slice(0, 6),
            total,
            wins,
            losses: total - wins,
            winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
            avgProfit: parseFloat(avgProfit.toFixed(2)),
            avgHoldMin: Math.round(avgHoldMin),
            avgMaxPaperProfit: parseFloat(avgMaxPaperProfit.toFixed(2)),
          });
        }

        result.sort((a, b) => b.total - a.total);
        setStats(result);
      } catch (e: any) {
        setError(e.message);
      }
      setLoading(false);
    }
    load();
  }, []);

  const radarData = stats.map(s => ({
    subject: s.shortName,
    승률: s.winRate,
    '평균수익(%)': Math.max(0, s.avgProfit),
    거래횟수: Math.min(100, s.total * 10),
  }));

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 font-mono opacity-50 gap-4">
        <BarChart2 size={48} className="animate-pulse" />
        <span>Firestore 데이터 로딩 중...</span>
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-red-600 font-mono text-sm">오류: {error}</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-serif italic">전략별 성과 (Strategy Analytics)</h2>
        <span className="font-mono text-xs opacity-50">총 {totalTrades}건 누적 데이터 기준</span>
      </div>

      {stats.length === 0 ? (
        <div className="border border-gray-200 p-16 text-center bg-white font-mono text-sm opacity-50 rounded-xl italic">
          아직 기록된 매매 데이터가 없습니다. 봇을 운용하면 여기에 전략별 통계가 쌓입니다.
        </div>
      ) : (
        <>
          {/* 요약 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { icon: Award, label: '최고 승률 전략', value: [...stats].sort((a,b)=>b.winRate-a.winRate)[0]?.shortName ?? '-', sub: `${[...stats].sort((a,b)=>b.winRate-a.winRate)[0]?.winRate ?? 0}%` },
              { icon: TrendingUp, label: '최고 평균 수익', value: [...stats].sort((a,b)=>b.avgProfit-a.avgProfit)[0]?.shortName ?? '-', sub: `+${[...stats].sort((a,b)=>b.avgProfit-a.avgProfit)[0]?.avgProfit ?? 0}%` },
              { icon: Clock, label: '평균 보유 시간', value: `${Math.round(stats.reduce((s,t)=>s+t.avgHoldMin,0)/Math.max(1,stats.length))}분`, sub: '전략 평균' },
              { icon: BarChart2, label: '총 거래 횟수', value: `${totalTrades}건`, sub: `${stats.length}개 전략` },
            ].map(({ icon: Icon, label, value, sub }) => (
              <div key={label} className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
                <div className="flex items-center gap-2 text-gray-400 mb-2">
                  <Icon size={14} />
                  <span className="text-[10px] font-mono uppercase tracking-wider">{label}</span>
                </div>
                <div className="text-2xl font-bold text-gray-900">{value}</div>
                <div className="text-xs text-gray-400 mt-1 font-mono">{sub}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 승률 바 차트 */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <h3 className="font-bold font-mono mb-4 text-sm uppercase tracking-wider">전략별 승률</h3>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="shortName" tick={{ fontSize: 11, fontFamily: 'monospace' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                    <Tooltip formatter={(v: any) => [`${v}%`, '승률']} />
                    <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                      {stats.map((s, i) => (
                        <Cell key={i} fill={getColor(s.name, s.winRate - 50)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 평균 수익률 바 차트 */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <h3 className="font-bold font-mono mb-4 text-sm uppercase tracking-wider">전략별 평균 수익률</h3>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="shortName" tick={{ fontSize: 11, fontFamily: 'monospace' }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                    <Tooltip formatter={(v: any) => [`${v}%`, '평균 수익률']} />
                    <Bar dataKey="avgProfit" radius={[4, 4, 0, 0]}>
                      {stats.map((s, i) => (
                        <Cell key={i} fill={s.avgProfit >= 0 ? '#2563eb' : '#dc2626'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 레이더 차트 */}
            {radarData.length > 1 && (
              <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
                <h3 className="font-bold font-mono mb-4 text-sm uppercase tracking-wider">전략 종합 비교 (Radar)</h3>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={radarData}>
                      <PolarGrid />
                      <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11 }} />
                      <Radar name="승률" dataKey="승률" stroke="#2563eb" fill="#2563eb" fillOpacity={0.2} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* 보유 시간 vs 최고 수익 */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <h3 className="font-bold font-mono mb-4 text-sm uppercase tracking-wider">최고 미실현 수익률 (maxPaperProfit)</h3>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="shortName" tick={{ fontSize: 11, fontFamily: 'monospace' }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                    <Tooltip formatter={(v: any) => [`${v}%`, '평균 최고 미실현 수익']} />
                    <Bar dataKey="avgMaxPaperProfit" radius={[4, 4, 0, 0]} fill="#8b5cf6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* 상세 테이블 */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-6 border-b border-gray-100">
              <h3 className="font-bold font-mono text-sm uppercase tracking-wider">전략별 상세 통계</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead className="bg-gray-50">
                  <tr>
                    {['전략', '총거래', '승', '패', '승률', '평균수익', '평균보유', '최고미실현'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-200">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s, i) => (
                    <tr key={i} className="hover:bg-gray-50 border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3 font-bold text-xs max-w-[180px] truncate" title={s.name}>{s.name}</td>
                      <td className="px-4 py-3">{s.total}</td>
                      <td className="px-4 py-3 text-green-600 font-bold">{s.wins}</td>
                      <td className="px-4 py-3 text-red-600 font-bold">{s.losses}</td>
                      <td className={`px-4 py-3 font-bold ${s.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                        {s.winRate}%
                      </td>
                      <td className={`px-4 py-3 font-bold ${s.avgProfit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {s.avgProfit > 0 ? '+' : ''}{s.avgProfit}%
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {s.avgHoldMin > 0 ? `${s.avgHoldMin}분` : '-'}
                      </td>
                      <td className="px-4 py-3 text-purple-600 font-bold">
                        {s.avgMaxPaperProfit > 0 ? `+${s.avgMaxPaperProfit}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
