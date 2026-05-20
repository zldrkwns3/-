import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Scatter
} from 'recharts';
import { ChartData } from '../types.ts';

interface StockChartProps {
  data: ChartData[];
}

export default function StockChart({ data }: StockChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#141414" stopOpacity={0.1}/>
            <stop offset="95%" stopColor="#141414" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#141414" opacity={0.1} />
        <XAxis 
          dataKey="date" 
          axisLine={false} 
          tickLine={false} 
          tick={{ fontSize: 10, fontFamily: 'monospace', opacity: 0.5 }}
          minTickGap={30}
        />
        <YAxis 
          domain={['auto', 'auto']}
          axisLine={false} 
          tickLine={false} 
          tick={{ fontSize: 10, fontFamily: 'monospace', opacity: 0.5 }}
        />
        <Tooltip 
          contentStyle={{ 
            backgroundColor: '#141414', 
            border: 'none', 
            borderRadius: '0px',
            color: '#E4E3E0',
            fontFamily: 'monospace',
            fontSize: '12px'
          }}
          itemStyle={{ color: '#E4E3E0' }}
        />
        <Area 
          type="monotone" 
          dataKey="close" 
          stroke="#141414" 
          strokeWidth={2}
          fillOpacity={1} 
          fill="url(#colorClose)" 
          animationDuration={1000}
        />
        {/* 일목균형표 라인들 */}
        <Line type="monotone" dataKey="tenkan" stroke="#FF0000" strokeWidth={1} dot={false} strokeOpacity={0.7} />
        <Line type="monotone" dataKey="kijun" stroke="#0000FF" strokeWidth={1} dot={false} strokeOpacity={0.7} />
        <Line type="monotone" dataKey="spanA" stroke="#FFA500" strokeWidth={1} dot={false} strokeOpacity={0.5} />
        <Line type="monotone" dataKey="spanB" stroke="#008000" strokeWidth={1} dot={false} strokeOpacity={0.5} />
        
        {/* AI & 백테스트 시그널 표시 */}
        <Scatter dataKey="buySignal" fill="#2563eb" fillOpacity={1} stroke="white" strokeWidth={1} />
        <Scatter dataKey="sellSignal" fill="#dc2626" fillOpacity={1} stroke="white" strokeWidth={1} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
