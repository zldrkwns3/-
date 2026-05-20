/**
 * 300종목 × 730일 일괄 백테스트 → 전략별 승률 통계
 * 실행: npx tsx scripts/bulk-backtest.ts
 * 통계 근거: 전략당 100건 이상 거래 확보 목표
 */

import { runBacktest } from '../backtest.ts';

const STOCKS = [
  // KOSPI 초대형주 (20)
  '005930', '000660', '005380', '000270', '005490', '051910', '035420',
  '035720', '003550', '028260', '096770', '017670', '030200', '032830',
  '055550', '105560', '086790', '316140', '024110', '000810',

  // KOSPI IT/반도체/전자 (18)
  '009150', '006400', '207940', '068270', '042700', '000990', '079550',
  '036830', '058470', '095340', '357780', '039030', '241560', '033640',
  '066570', '034220', '032640', '018260',

  // KOSPI 자동차/운송/항공 (12)
  '012330', '018880', '010130', '161390', '064350', '054000', '073240',
  '072490', '088790', '086280', '180640', '024720',

  // KOSPI 에너지/화학/소재 (16)
  '047050', '011170', '009830', '010950', '011790', '078930', '010060',
  '006650', '002380', '001390', '011780', '004990', '012450', '014680',
  '036490', '003670',

  // KOSPI 금융/보험/증권 (22)
  '003490', '001040', '004020', '000100', '069960', '004170', '033780',
  '000720', '042660', '329180', '009540', '010620', '016360', '005940',
  '071050', '085620', '001450', '005830', '029780', '175330', '138040',
  '006800',

  // KOSPI 소비재/유통/호텔 (18)
  '097950', '271560', '000150', '000080', '021240', '005850', '007310',
  '009290', '139480', '031430', '093050', '105630', '008770', '030000',
  '114090', '192400', '023530', '007070',

  // KOSPI 유틸리티/중공업/건설 (12)
  '015760', '036460', '017000', '034020', '047040', '000860',
  '051600', '052690', '028050', '010140', '095570', '006360',

  // KOSPI 엔터/미디어 (9)
  '041510', '036570', '251270', '112040', '352820', '259960', '035900',
  '122900', '034120',

  // KOSPI 바이오/헬스/제약 (10)
  '011000', '000640', '001740', '090430', '002790', '000370', '069620',
  '128940', '170900', '006280',

  // KOSPI 방산/물류/기타 (10)
  '047810', '034730', '011200', '120110', '001230', '006120', '004800',
  '272210', '326030', '003410',

  // KOSPI 중형주 혼합 (15)
  '002220', '038530', '001680', '003240', '005720', '020560', '060980',
  '025620', '204320', '001800', '005070', '004530', '028670', '014830',
  '009720',

  // KOSDAQ 대형주 (15)
  '247540', '086520', '323410', '263750', '028300', '066970', '196170',
  '145020', '214150', '122870', '041960', '036800', '217270', '091990',
  '068760',

  // KOSDAQ IT/반도체/SW (12)
  '240810', '293490', '237690', '054620', '053800', '030520', '098460',
  '039490', '084370', '046140', '119610', '078020',

  // KOSDAQ 바이오/헬스 (10)
  '031510', '067630', '086900', '234080', '140410', '265520', '096530',
  '243070', '080800', '025980',

  // KOSDAQ 게임/콘텐츠 (5)
  '194480', '225570', '373220', '376300', '085680',

  // KOSDAQ 소부장/반도체장비 (8)
  '151910', '036930', '048870', '064760', '108380', '041830', '060310',
  '032500',

  // 추가 다양성 (10)
  '003920', '026890', '003580', '200130', '290150', '108490', '036540',
  '025600', '078520', '049800',
];

// 중복 제거
const UNIQUE_STOCKS = [...new Set(STOCKS)];

interface StratAccum {
  wins: number;
  losses: number;
  totalProfitPct: number;
  stocks: number;
}

async function main() {
  const DAYS = 730;
  const CAPITAL = 10_000_000;

  const stratAccum: Record<string, StratAccum> = {};
  let succeeded = 0;
  let failed = 0;

  console.log(`\n📊 [Bulk Backtest] ${UNIQUE_STOCKS.length}개 종목 × ${DAYS}일(2년) 백테스트 시작...`);
  console.log(`⏱  예상 소요: 10~15분\n`);

  for (let i = 0; i < UNIQUE_STOCKS.length; i++) {
    const symbol = UNIQUE_STOCKS[i];
    try {
      const result = await runBacktest(symbol, DAYS, CAPITAL, 0.03, -0.03);
      if (!result.success || !result.data?.strategyBreakdown) {
        failed++;
        process.stdout.write(`✗`);
        continue;
      }

      for (const s of result.data.strategyBreakdown) {
        if (!stratAccum[s.name]) {
          stratAccum[s.name] = { wins: 0, losses: 0, totalProfitPct: 0, stocks: 0 };
        }
        stratAccum[s.name].wins += s.wins;
        stratAccum[s.name].losses += s.losses;
        stratAccum[s.name].totalProfitPct += s.avgProfitPct * (s.wins + s.losses);
        stratAccum[s.name].stocks++;
      }

      succeeded++;
      process.stdout.write(`·`);
      if ((i + 1) % 20 === 0) {
        const pct = ((i + 1) / UNIQUE_STOCKS.length * 100).toFixed(0);
        process.stdout.write(` ${i + 1}/${UNIQUE_STOCKS.length} (${pct}%)\n`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e: any) {
      failed++;
      process.stdout.write(`✗`);
    }
  }

  console.log(`\n\n✅ 완료: ${succeeded}개 성공, ${failed}개 실패\n`);

  const summary = Object.entries(stratAccum).map(([name, s]) => {
    const total = s.wins + s.losses;
    const winRate = total > 0 ? (s.wins / total) * 100 : 0;
    const avgProfitPct = total > 0 ? s.totalProfitPct / total : 0;
    const ciHalf = total > 0 ? 1.96 * Math.sqrt((winRate / 100) * (1 - winRate / 100) / total) * 100 : 99;
    return { name, total, wins: s.wins, losses: s.losses, winRate, avgProfitPct, stocks: s.stocks, ciHalf };
  }).sort((a, b) => b.winRate - a.winRate);

  console.log('━'.repeat(95));
  console.log(
    '전략명'.padEnd(28) +
    '거래수'.padStart(7) +
    '승률'.padStart(8) +
    '95% CI'.padStart(11) +
    '평균수익'.padStart(10) +
    '발동종목'.padStart(9) +
    '신뢰도'.padStart(8) +
    '추천'.padStart(6)
  );
  console.log('━'.repeat(95));

  for (const s of summary) {
    const reliable = s.total >= 100 ? '✅' : s.total >= 50 ? '⚠️ ' : '❌';
    const recommend = s.winRate >= 52 && s.avgProfitPct >= 0 ? '✅ ON' : '❌ OFF';
    console.log(
      s.name.slice(0, 26).padEnd(28) +
      String(s.total).padStart(7) +
      `${s.winRate.toFixed(1)}%`.padStart(8) +
      `±${s.ciHalf.toFixed(1)}%`.padStart(11) +
      `${s.avgProfitPct >= 0 ? '+' : ''}${s.avgProfitPct.toFixed(2)}%`.padStart(10) +
      String(s.stocks).padStart(9) +
      reliable.padStart(8) +
      recommend.padStart(8)
    );
  }
  console.log('━'.repeat(95));

  console.log('\n📌 신뢰도 기준: ✅ 100건 이상 (95% CI ±10% 이하), ⚠️  50~99건, ❌ 50건 미만');

  const stratKeys: Record<string, string> = {
    '기법 A': 'A', '기법 B': 'B', '기법 C': 'C', '기법 D': 'D',
    '기법 E': 'E', '기법 F': 'F', '기법 G': 'G',
    '기법 H': 'H', '기법 I': 'I', '기법 J': 'J', '기법 K': 'K',
  };
  const recommended: Record<string, boolean> = { A: true, B: true, C: true, D: true, E: true, F: true, G: true, H: true, I: true, J: true, K: true };

  for (const s of summary) {
    const key = Object.entries(stratKeys).find(([k]) => s.name.includes(k))?.[1];
    if (key && s.total >= 50) {
      recommended[key] = s.winRate >= 52 && s.avgProfitPct >= 0;
    }
  }

  console.log('\n📋 server.ts ENABLED_STRATEGIES 권장 설정 (50건 이상 거래만 반영):');
  console.log('const ENABLED_STRATEGIES: Record<string, boolean> = {');
  for (const [k, v] of Object.entries(recommended)) {
    const s = summary.find(x => x.name.includes(`기법 ${k}`));
    const note = s ? `승률 ${s.winRate.toFixed(1)}%, 거래${s.total}건` : '데이터 부족';
    console.log(`  ${k}: ${String(v).padEnd(5)},  // ${note}`);
  }
  console.log('};\n');
}

main().catch(console.error);
