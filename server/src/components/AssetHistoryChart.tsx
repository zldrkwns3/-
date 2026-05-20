import { useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface AssetSnapshot {
  date: string;
  totalEquity: number;
  operationPool: number;
  safeVault: number;
}

type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

export default function AssetHistoryChart({ data }: { data: AssetSnapshot[] }) {
  const [period, setPeriod] = useState<Period>('daily');

  const processedData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    if (period === 'daily') return data;

    const grouped = new Map<string, AssetSnapshot>();
    
    data.forEach(item => {
       const dateObj = new Date(item.date);
       let key = item.date;
       
       if (period === 'weekly') {
         // Get the Monday of the week
         const day = dateObj.getDay();
         const diff = dateObj.getDate() - day + (day === 0 ? -6 : 1);
         const monday = new Date(dateObj.setDate(diff));
         key = monday.toISOString().split('T')[0];
       } else if (period === 'monthly') {
         key = item.date.substring(0, 7); // YYYY-MM
       } else if (period === 'yearly') {
         key = item.date.substring(0, 4); // YYYY
       }

       // For aggregated items, we mostly care about the latest snapshot in that period
       // So we can continually overwrite for the same key (assuming data is sorted chronologically)
       grouped.set(key, { ...item, date: key });
    });

    return Array.from(grouped.values());
  }, [data, period]);

  if (!data || data.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center border border-[gray-900] bg-white/50 min-h-[300px]">
        <div className="font-mono text-sm opacity-50">장부 기록이 없습니다. (No historical data)</div>
        <div className="font-mono text-xs opacity-40 mt-2">오늘 장마감 후 첫 기록이 생성됩니다.</div>
      </div>
    );
  }

  // Format currency for Y-Axis and Tooltip
  const formatCurrency = (value: number) => `₩${(value / 10000).toLocaleString(undefined, { maximumFractionDigits: 0 })}만`;

  // Provide a subtle tooltip formatter
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white border border-black p-3 shadow-lg font-mono text-xs">
          <p className="font-bold border-b border-gray-200 pb-1 mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
             <p key={index} className="flex justify-between gap-4 py-0.5" style={{ color: entry.color }}>
               <span>{entry.name}:</span>
               <span className="font-bold">{entry.value.toLocaleString()}원</span>
             </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex border border-gray-200 bg-white w-fit divide-x divide-gray-200 rounded overflow-hidden">
         <button 
           className={`px-4 py-1.5 text-xs font-mono transition-colors ${period === 'daily' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'}`}
           onClick={() => setPeriod('daily')}
         >
           일별 (Daily)
         </button>
         <button 
           className={`px-4 py-1.5 text-xs font-mono transition-colors ${period === 'weekly' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'}`}
           onClick={() => setPeriod('weekly')}
         >
           주별 (Weekly)
         </button>
         <button 
           className={`px-4 py-1.5 text-xs font-mono transition-colors ${period === 'monthly' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'}`}
           onClick={() => setPeriod('monthly')}
         >
           월별 (Monthly)
         </button>
         <button 
           className={`px-4 py-1.5 text-xs font-mono transition-colors ${period === 'yearly' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'}`}
           onClick={() => setPeriod('yearly')}
         >
           연별 (Yearly)
         </button>
      </div>

      <div className="w-full h-[400px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={processedData}
            margin={{ top: 20, right: 0, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
            <XAxis 
              dataKey="date" 
              tick={{ fontSize: 11, fontFamily: 'monospace' }} 
              tickLine={false}
              axisLine={false}
              tickMargin={10}
            />
            <YAxis 
               tickFormatter={formatCurrency} 
               tick={{ fontSize: 11, fontFamily: 'monospace' }}
               width={80}
               tickLine={false}
               axisLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontFamily: 'monospace', fontSize: '12px', marginTop: '10px' }} />
            <Area 
               type="monotone" 
               dataKey="totalEquity" 
               name="총 자산 (Total Equity)" 
               stroke="#111827" 
               fill="#e5e5e5" 
               fillOpacity={0.8}
            />
            <Area 
               type="monotone" 
               dataKey="operationPool" 
               name="운용 자금 (Operation Pool)" 
               stroke="#3b82f6" 
               fill="none" 
               strokeWidth={2}
            />
            <Area 
              type="monotone" 
              dataKey="safeVault" 
              name="안전 금고 (Safe Vault)" 
              stroke="#10b981" 
              fill="none" 
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
