import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();

export async function runBacktest(symbol: string, days: number, initialCapital: number, takeProfitPct: number, stopLossPct: number) {
  try {
    const yfSymbol = `${symbol}.KS`;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days + 150)); // Add 150 days buffer for indicators

    const chart = await yahooFinance.chart(yfSymbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });

    if (!chart || !chart.quotes || chart.quotes.length < 150) {
      return { success: false, message: "Not enough historical data." };
    }

    const quotes = chart.quotes.filter(q => q.close !== null && q.high !== null && q.low !== null);
    
    // Calculate indicators for all points
    const closes = quotes.map(q => q.close);
    const volumes = quotes.map(q => q.volume || 1);
    
    let balance = initialCapital;
    let position: { buyPrice: number, qty: number, highestPrice: number, buyDate: string, strategyName: string } | null = null;
    let trades: any[] = [];
    const strategyStats: Record<string, { wins: number; losses: number; totalProfitPct: number }> = {};

    const getHighLow = (period: number, index: number) => {
        if (index < period - 1) return null;
        const slice = quotes.slice(index - period + 1, index + 1);
        return {
            high: Math.max(...slice.map((q: any) => q.high)),
            low: Math.min(...slice.map((q: any) => q.low))
        };
    };

    const calcEMA = (data: number[], period: number): number[] => {
        if (data.length < period) return [data[data.length - 1] ?? 0];
        const k = 2 / (period + 1);
        let prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const result = [prev];
        for (let j = period; j < data.length; j++) {
            prev = data[j] * k + prev * (1 - k);
            result.push(prev);
        }
        return result;
    };

    // ─── 사전 계산 지표 배열 (전체 quotes 기준 인덱스) ──────────────────────────
    const closesNum = closes.map(c => c ?? 0);

    // RSI per-bar (14)
    const rsiPerBar: number[] = new Array(quotes.length).fill(50);
    for (let i = 1; i < quotes.length; i++) {
        let u = 0, d = 0;
        for (let j = Math.max(1, i - 13); j <= i; j++) {
            const diff = closesNum[j] - closesNum[j - 1];
            if (diff > 0) u += diff; else d -= diff;
        }
        rsiPerBar[i] = u === 0 ? 0 : 100 - 100 / (1 + u / (d || 1));
    }

    // Stochastic RSI (14, 14, 3, 3) → %K, %D
    const stochRaw: number[] = new Array(quotes.length).fill(50);
    for (let i = 13; i < quotes.length; i++) {
        const sl = rsiPerBar.slice(i - 13, i + 1);
        const mn = Math.min(...sl), mx = Math.max(...sl);
        stochRaw[i] = mx === mn ? 50 : (rsiPerBar[i] - mn) / (mx - mn) * 100;
    }
    const stochK: number[] = new Array(quotes.length).fill(50);
    const stochD: number[] = new Array(quotes.length).fill(50);
    for (let i = 2; i < quotes.length; i++) {
        stochK[i] = (stochRaw[i] + stochRaw[i-1] + stochRaw[i-2]) / 3;
    }
    for (let i = 2; i < quotes.length; i++) {
        stochD[i] = (stochK[i] + stochK[i-1] + stochK[i-2]) / 3;
    }

    // EMA13 per-bar (Elder Impulse)
    const ema13raw = calcEMA(closesNum, 13);
    const ema13: number[] = new Array(quotes.length).fill(0);
    for (let i = 12; i < quotes.length; i++) ema13[i] = ema13raw[i - 12];

    // MACD Histogram per-bar (12, 26, 9)
    const ema12raw = calcEMA(closesNum, 12);
    const ema26raw = calcEMA(closesNum, 26);
    const macdLineFull: number[] = new Array(quotes.length).fill(0);
    for (let i = 25; i < quotes.length; i++) {
        macdLineFull[i] = ema12raw[i - 11] - ema26raw[i - 25];
    }
    const signalRaw2 = calcEMA(macdLineFull.slice(25), 9);
    const macdHist: number[] = new Array(quotes.length).fill(0);
    for (let i = 33; i < quotes.length; i++) macdHist[i] = macdLineFull[i] - signalRaw2[i - 33];

    // BB Squeeze (BB 내에 Keltner Channel이 포함되는 압축 구간)
    const squeezeOn: boolean[] = new Array(quotes.length).fill(false);
    const sqMomentum: number[] = new Array(quotes.length).fill(0);
    for (let i = 19; i < quotes.length; i++) {
        const c20 = closesNum.slice(i - 19, i + 1);
        const ma20s = c20.reduce((a, b) => a + b) / 20;
        const std20 = Math.sqrt(c20.map(x => (x - ma20s) ** 2).reduce((a, b) => a + b) / 20);
        const n = Math.min(20, i);
        let atrSum = 0;
        for (let k = i - n + 1; k <= i; k++) {
            const pc = k > 0 ? closesNum[k - 1] : closesNum[k];
            atrSum += Math.max(quotes[k].high! - quotes[k].low!, Math.abs(quotes[k].high! - pc), Math.abs(quotes[k].low! - pc));
        }
        const atr = atrSum / n;
        squeezeOn[i] = (ma20s + 2 * std20) < (ma20s + 1.5 * atr) && (ma20s - 2 * std20) > (ma20s - 1.5 * atr);
        const hi20 = Math.max(...quotes.slice(i - 19, i + 1).map(q => q.high!));
        const lo20 = Math.min(...quotes.slice(i - 19, i + 1).map(q => q.low!));
        sqMomentum[i] = closesNum[i] - ((hi20 + lo20) / 2 + ma20s) / 2;
    }
    // ────────────────────────────────────────────────────────────────────────────

    for (let i = 150; i < quotes.length; i++) {
        const currentData = quotes[i];
        const currentPrice = currentData.close!;
        const currentDate = currentData.date;

        if (position) {
            // Check sell conditions
            const profitRate = (currentPrice - position.buyPrice) / position.buyPrice;
            const highestProfitRate = (position.highestPrice - position.buyPrice) / position.buyPrice;
            const dropFromHigh = (position.highestPrice - currentPrice) / position.highestPrice;

            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
            }

            let sellReason = "";
            let shouldSell = false;

            if (highestProfitRate >= 0.05 && dropFromHigh >= 0.02) {
                shouldSell = true;
                sellReason = "Trailing Stop (+5% peak, -2% drop)";
            } else if (profitRate >= takeProfitPct) {
                shouldSell = true;
                sellReason = "Take Profit";
            } else if (profitRate <= stopLossPct) {
                shouldSell = true;
                sellReason = "Stop Loss";
            }

            if (shouldSell) {
                const returnAmount = position.qty * currentPrice;
                const profitAmount = returnAmount - (position.qty * position.buyPrice);
                balance += returnAmount;
                trades.push({
                    type: 'SELL',
                    date: currentDate,
                    price: currentPrice,
                    qty: position.qty,
                    profitAmount,
                    profitRate,
                    reason: sellReason,
                    strategyName: position.strategyName,
                    balance
                });
                // 전략별 통계 집계
                const sn = position.strategyName;
                if (!strategyStats[sn]) strategyStats[sn] = { wins: 0, losses: 0, totalProfitPct: 0 };
                if (profitAmount > 0) strategyStats[sn].wins++;
                else strategyStats[sn].losses++;
                strategyStats[sn].totalProfitPct += profitRate * 100;
                position = null;
            }
        } else {
            // Check buy conditions
            // Need indicators up to day i
            const sliceCloses = closes.slice(0, i + 1);
            const sliceVolumes = volumes.slice(0, i + 1);
            
            const ma5 = sliceCloses.slice(-5).reduce((a, b) => a! + b!, 0) / 5;
            
            // 사전계산된 RSI 배열 재사용 (H 전략의 StochRSI와 동일 기반)
            const rsi = rsiPerBar[i];

            const closes20 = sliceCloses.slice(-20);
            const ma20 = closes20.reduce((a, b) => a! + b!, 0) / 20;
            const stdDev = Math.sqrt(closes20.map(x => Math.pow(x! - ma20, 2)).reduce((a, b) => a + b) / 20);
            const bbLower = ma20 - (stdDev * 2);

            let tenkan = currentPrice, kijun = currentPrice, spanA = currentPrice, spanB = currentPrice;
            const hl9 = getHighLow(9, i);
            if (hl9) tenkan = (hl9.high + hl9.low) / 2;
            const hl26 = getHighLow(26, i);
            if (hl26) kijun = (hl26.high + hl26.low) / 2;
            
            const pastIndex = i - 26;
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

            const currentVolume = sliceVolumes[sliceVolumes.length - 1] || 1;
            const avgVolume5 = sliceVolumes.slice(Math.max(0, sliceVolumes.length - 6), -1).reduce((a, b) => a! + b!, 0) / 5;
            const volumeRatio = currentVolume! / (avgVolume5 || 1);

            const openPrice = currentData.open || currentPrice;
            const dayGainPct = (currentPrice - openPrice) / openPrice;
            const distanceFromMA5 = (currentPrice - ma5) / ma5;

            // MA60
            const ma60 = sliceCloses.length >= 60
                ? sliceCloses.slice(-60).reduce((a, b) => a! + b!, 0)! / 60
                : sliceCloses.reduce((a, b) => a! + b!, 0)! / sliceCloses.length;

            // MACD (12, 26, 9)
            const closesNum = sliceCloses.map(c => c ?? currentPrice);
            const ema12arr = calcEMA(closesNum, 12);
            const ema26arr = calcEMA(closesNum, 26);
            const macdArr = ema12arr.slice(-ema26arr.length).map((v, idx) => v - ema26arr[idx]);
            const signalArr = calcEMA(macdArr, 9);
            const macdVal = macdArr[macdArr.length - 1] ?? 0;
            const macdSignalVal = signalArr[signalArr.length - 1] ?? 0;
            const macdPrevVal = macdArr[macdArr.length - 2] ?? macdVal;
            const macdSignalPrevVal = signalArr[signalArr.length - 2] ?? macdSignalVal;
            const macdGoldenCross = macdPrevVal < macdSignalPrevVal && macdVal > macdSignalVal;

            let strategyMatched = false;
            let strategyName = "";

            if (dayGainPct >= 0.03 && dayGainPct <= 0.08 && Math.abs(distanceFromMA5) <= 0.015) {
                strategyMatched = true; strategyName = "기법 A";
            } else if (rsi <= 35 && currentPrice < bbLower * 1.01 && currentPrice > ma20 * 0.97) {
                // 기법 B: MA20 추세 필터 추가 (하락 추세 종목 진입 방지)
                strategyMatched = true; strategyName = "기법 B";
            } else if (ma5 > ma20 && (ma5 - ma20) / ma20 < 0.01 && currentPrice > ma20 && currentPrice < ma20 * 1.02) {
                strategyMatched = true; strategyName = "기법 C";
            } else if (currentPrice > Math.max(spanA, spanB) && Math.abs(currentPrice - kijun) / kijun < 0.015 && currentPrice >= kijun) {
                strategyMatched = true; strategyName = "기법 D";
            } else if (volumeRatio >= 2.0 && rsi >= 60 && rsi <= 70) {
                // 기법 E: RSI 상단 75→70 (과매수 직전 구간 회피)
                strategyMatched = true; strategyName = "기법 E";
            } else if (macdGoldenCross && rsi >= 40 && rsi <= 60 && currentPrice > ma20) {
                strategyMatched = true; strategyName = "기법 F";
            } else if (ma5 > ma20 && ma20 > ma60 && currentPrice > ma20 && currentPrice < ma20 * 1.03 && rsi >= 45 && rsi <= 65) {
                strategyMatched = true; strategyName = "기법 G";
            }
            // 기법 H: Stochastic RSI 과매도 반등 (%K < 20 && %D < 20, %K가 %D 상향 돌파)
            else if (
                stochK[i] < 20 && stochD[i] < 20 &&
                stochK[i - 1] <= stochD[i - 1] && stochK[i] > stochD[i] &&
                rsi >= 30 && rsi <= 60 &&
                currentPrice > ma20 * 0.97
            ) {
                strategyMatched = true; strategyName = "기법 H";
            }
            // 기법 I: Elder Impulse (EMA13 상승 + MACD-H 양수 증가 + MA20 위)
            else if (
                i >= 1 &&
                ema13[i] > ema13[i - 1] &&
                macdHist[i] > 0 && macdHist[i] > macdHist[i - 1] &&
                rsi >= 45 && rsi <= 65 &&
                currentPrice > ma20
            ) {
                strategyMatched = true; strategyName = "기법 I";
            }
            // 기법 J: BB Squeeze 이탈 + 양적 모멘텀 (저변동성 → 방향성 돌파)
            else if (
                i >= 1 &&
                squeezeOn[i - 1] && !squeezeOn[i] &&
                sqMomentum[i] > 0 && sqMomentum[i] > sqMomentum[i - 1] &&
                volumeRatio >= 1.2 &&
                currentPrice > ma20
            ) {
                strategyMatched = true; strategyName = "기법 J";
            }
            // 기법 K: Bullish Engulfing + 거래량 급증 (전일 음봉을 당일 양봉이 완전히 포함)
            else if (
                i >= 1 &&
                quotes[i - 1].close! < (quotes[i - 1].open ?? quotes[i - 1].close)! &&
                (currentData.open ?? currentPrice) <= quotes[i - 1].close! &&
                currentPrice > (quotes[i - 1].open ?? quotes[i - 1].close)! &&
                volumeRatio >= 1.5 &&
                currentPrice > ma20
            ) {
                strategyMatched = true; strategyName = "기법 K";
            }

            if (strategyMatched && balance >= currentPrice) {
                // Buy
                const qtyToBuy = Math.floor((balance * 0.99) / currentPrice); // use 99% of balance to avoid zero
                if (qtyToBuy > 0) {
                    balance -= qtyToBuy * currentPrice;
                    position = {
                        buyPrice: currentPrice,
                        qty: qtyToBuy,
                        highestPrice: currentPrice,
                        buyDate: currentDate as unknown as string,
                        strategyName
                    };
                    trades.push({
                        type: 'BUY',
                        date: currentDate,
                        price: currentPrice,
                        qty: qtyToBuy,
                        reason: strategyName,
                        balance
                    });
                }
            }
        }
    }

    if (position) {
         const currentPrice = quotes[quotes.length - 1].close!;
         const currentDate = quotes[quotes.length - 1].date;
         const profitRate = (currentPrice - position.buyPrice) / position.buyPrice;
         const returnAmount = position.qty * currentPrice;
         const profitAmount = returnAmount - (position.qty * position.buyPrice);
         balance += returnAmount;
         trades.push({
             type: 'SELL (End Of Test)',
             date: currentDate,
             price: currentPrice,
             qty: position.qty,
             profitAmount,
             profitRate,
             strategyName: position.strategyName,
             reason: "End of backtest",
             balance
         });
         const sn = position.strategyName;
         if (!strategyStats[sn]) strategyStats[sn] = { wins: 0, losses: 0, totalProfitPct: 0 };
         if (profitAmount > 0) strategyStats[sn].wins++;
         else strategyStats[sn].losses++;
         strategyStats[sn].totalProfitPct += profitRate * 100;
    }

    const totalReturnRate = (balance - initialCapital) / initialCapital;

    // Calculate max drawdown
    let peak = initialCapital;
    let maxDrawdown = 0;
    
    let currentBalance = initialCapital;
    trades.forEach(t => {
        if (t.balance > peak) peak = t.balance;
        const drawdown = (peak - t.balance) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });

    const winningTrades = trades.filter(t => t.type.includes('SELL') && t.profitAmount! > 0).length;
    const losingTrades = trades.filter(t => t.type.includes('SELL') && t.profitAmount! <= 0).length;
    const totalFinishedTrades = winningTrades + losingTrades;
    const winRate = totalFinishedTrades > 0 ? winningTrades / totalFinishedTrades : 0;

    // 전략별 요약 계산
    const strategyBreakdown = Object.entries(strategyStats).map(([name, s]) => {
      const total = s.wins + s.losses;
      return {
        name,
        wins: s.wins,
        losses: s.losses,
        total,
        winRate: total > 0 ? Math.round((s.wins / total) * 100) : 0,
        avgProfitPct: total > 0 ? parseFloat((s.totalProfitPct / total).toFixed(2)) : 0,
      };
    });

    return {
        success: true,
        data: {
            symbol,
            initialCapital,
            finalBalance: balance,
            totalReturnPct: totalReturnRate * 100,
            maxDrawdown: maxDrawdown * 100,
            winRate: winRate * 100,
            totalTrades: totalFinishedTrades,
            trades,
            strategyBreakdown,
        }
    };

  } catch (error: any) {
    return { success: false, message: error.message };
  }
}
