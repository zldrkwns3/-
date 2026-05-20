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
    let position: { buyPrice: number, qty: number, highestPrice: number, buyDate: string } | null = null;
    let trades = [];

    const getHighLow = (period: number, index: number) => {
        if (index < period - 1) return null;
        const slice = quotes.slice(index - period + 1, index + 1);
        return {
            high: Math.max(...slice.map((q: any) => q.high)),
            low: Math.min(...slice.map((q: any) => q.low))
        };
    };

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
                    balance
                });
                position = null;
            }
        } else {
            // Check buy conditions
            // Need indicators up to day i
            const sliceCloses = closes.slice(0, i + 1);
            const sliceVolumes = volumes.slice(0, i + 1);
            
            const ma5 = sliceCloses.slice(-5).reduce((a, b) => a! + b!, 0) / 5;
            
            let ups = 0, downs = 0;
            for (let j = Math.max(1, sliceCloses.length - 14); j < sliceCloses.length; j++) {
                const diff = sliceCloses[j]! - sliceCloses[j-1]!;
                if (diff > 0) ups += diff;
                else downs += Math.abs(diff);
            }
            const rsi = ups === 0 ? 0 : 100 - (100 / (1 + (ups / (downs || 1))));

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

            let strategyMatched = false;
            let strategyName = "";

            if (dayGainPct >= 0.03 && Math.abs(distanceFromMA5) <= 0.015) {
                strategyMatched = true; strategyName = "기법 A";
            } else if (rsi <= 35 && currentPrice < bbLower * 1.01) {
                strategyMatched = true; strategyName = "기법 B";
            } else if (ma5 > ma20 && (ma5 - ma20) / ma20 < 0.01 && currentPrice > ma20 && currentPrice < ma20 * 1.02) {
                strategyMatched = true; strategyName = "기법 C";
            } else if (currentPrice > Math.max(spanA, spanB) && Math.abs(currentPrice - kijun) / kijun < 0.015 && currentPrice >= kijun) {
                strategyMatched = true; strategyName = "기법 D";
            } else if (volumeRatio >= 2.0 && rsi >= 65 && rsi <= 75) {
                strategyMatched = true; strategyName = "기법 E";
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
                        buyDate: currentDate as unknown as string
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
         // Close pending position at end
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
             reason: "End of backtest",
             balance
         });
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
            trades
        }
    };

  } catch (error: any) {
    return { success: false, message: error.message };
  }
}
