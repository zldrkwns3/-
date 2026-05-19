export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  balance: number;
  createdAt: string;
}

export interface PortfolioItem {
  symbol: string;
  quantity: number;
  averageBuyPrice: number;
  lastUpdated: string;
}

export interface Trade {
  id?: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  timestamp: any;
}

export interface StockQuote {
  symbol: string;
  regularMarketPrice: number;
  regularMarketChangePercent: number;
  shortName: string;
  currency: string;
}

export interface ChartData {
  date: string;
  close?: number;
  tenkan?: number;
  kijun?: number;
  spanA?: number;
  spanB?: number;
  buySignal?: number;
  sellSignal?: number;
}
