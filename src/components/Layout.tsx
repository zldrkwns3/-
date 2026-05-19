import { ReactNode } from 'react';
import { motion } from 'motion/react';
import { LayoutGrid, TrendingUp, Wallet, History, Search, Activity, LogOut } from 'lucide-react';
import { auth } from '../lib/firebase.ts';

interface LayoutProps {
  children: ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  capital?: number;
  reserve?: number;
  totalEquity?: number;
  apiStatus?: string;
  userEmail?: string | null;
}

export default function DashboardLayout({ children, activeTab, setActiveTab, capital, reserve, totalEquity, apiStatus, userEmail }: LayoutProps) {
  const navItems = [
    { id: 'explore', icon: Activity, label: '시장 (Market)' },
    { id: 'portfolio', icon: Wallet, label: '포트폴리오 (Portfolio)' },
    { id: 'history', icon: History, label: '기록 (History)' },
    { id: 'search', icon: Search, label: '검색 (Search)' },
    { id: 'log', icon: LayoutGrid, label: '로그 (Log)' },
    { id: 'backtest', icon: TrendingUp, label: '백테스트 (Backtest)' },
  ];

  const handleLogout = () => {
    auth.signOut();
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans selection:bg-gray-900 selection:text-white">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:block fixed left-0 top-0 h-full w-64 border-r border-gray-200 bg-gray-50 z-20">
        <div className="p-8 border-b border-gray-200">
          <h1 className="font-serif italic text-2xl tracking-tight flex items-center gap-2">
            <TrendingUp size={24} />
            StockBot AI
          </h1>
        </div>
        
        <nav className="mt-8">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-4 px-8 py-4 transition-colors font-mono uppercase text-xs tracking-widest ${
                activeTab === item.id 
                  ? 'bg-gray-900 text-white' 
                  : 'hover:bg-gray-900/5'
              }`}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="md:pl-64 min-h-screen pb-20 md:pb-0">
        <header className="h-auto py-4 md:h-20 border-b border-gray-200 flex flex-col md:flex-row items-start md:items-center justify-between px-4 md:px-10 sticky top-0 bg-gray-50/80 backdrop-blur-sm z-10 gap-4 md:gap-0">
          <div className={`font-mono text-xs uppercase tracking-tighter shadow-sm py-1 px-3 border transition-colors ${
            apiStatus?.startsWith('🔴') 
              ? 'bg-red-50 border-red-200 text-red-600 font-bold animate-pulse' 
              : 'bg-white/50 border-gray-200 text-gray-700'
          }`}>
            상태: {apiStatus || '확인 중...'}
          </div>
          <div className="flex items-center gap-4 md:gap-8 w-full md:w-auto justify-between md:justify-end">
            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex flex-col items-end">
                <div className="font-sans text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">총 자산 (Equity)</div>
                <div className="font-mono font-bold text-lg md:text-xl text-gray-900">
                  {totalEquity !== undefined ? `₩${totalEquity.toLocaleString()}` : '─'}
                </div>
              </div>
              <div className="w-px h-10 bg-gray-300 hidden md:block"></div>
              <div className="flex flex-col items-end">
                <div className="font-sans text-[10px] uppercase tracking-wider text-green-600 mb-0.5">안전 금고 (Vault)</div>
                <div className="font-mono font-bold text-green-700 text-sm md:text-base">
                  {reserve !== undefined ? `₩${reserve.toLocaleString()}` : '₩0'}
                </div>
              </div>
              <div className="w-px h-10 bg-gray-300 hidden md:block"></div>
              <div className="flex flex-col items-end">
                <div className="font-sans text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">예수금 (Pool)</div>
                <div className="font-mono font-bold text-sm md:text-base text-gray-900">
                  {capital !== undefined ? `₩${capital.toLocaleString()}` : '₩─'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden lg:flex flex-col items-end mr-1">
                <div className="text-[10px] font-mono text-gray-400 truncate max-w-[120px]">{userEmail}</div>
              </div>
              <button 
                onClick={handleLogout}
                className="w-10 h-10 rounded-full border border-gray-200 flex-shrink-0 items-center justify-center bg-gray-50 hover:bg-red-50 hover:text-red-600 transition-colors group cursor-pointer"
                title="로그아웃"
              >
                <LogOut size={16} className="group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>
        </header>

        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="p-4 md:p-10"
        >
          {children}
        </motion.div>
      </main>

      {/* Bottom Nav - Mobile */}
      <nav className="md:hidden fixed bottom-0 left-0 w-full bg-gray-50 border-t border-gray-200 z-50 flex justify-between items-center pb-2 pt-1 px-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-1 rounded-sm transition-colors ${
              activeTab === item.id 
                ? 'bg-gray-900 text-white' 
                : 'text-gray-900 hover:bg-gray-900/10'
            }`}
          >
            <item.icon size={18} />
            <span className="text-[9px] font-mono uppercase tracking-tighter truncate w-full text-center px-1">
              {item.label.split(' ')[0]}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
