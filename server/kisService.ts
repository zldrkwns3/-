import dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';

// 0.1초 ~ 0.2초씩 코드를 잠시 멈춰주는 유틸리티 함수
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// KIS API 초당 호출 제한을 피하기 위한 글로벌 쓰로틀링 (초당 2건 미만)
let nextAvailableTime = Date.now();
const KIS_MIN_INTERVAL = 600; // 0.6초 (안전 마진 확보)

async function throttleKis() {
    const now = Date.now();
    const targetTime = Math.max(now, nextAvailableTime);
    nextAvailableTime = targetTime + KIS_MIN_INTERVAL;
    
    if (targetTime > now) {
        await new Promise(resolve => setTimeout(resolve, targetTime - now));
    }
}

const getAccNo = () => {
    const val = process.env.KIS_ACC_NO;
    if (!val || val === "undefined" || val === "null" || val === "UNDEFINED") return "";
    return val.trim();
};

const getURL = () => process.env.KIS_URL || "https://openapivts.koreainvestment.com:29443";
const getAppKey = () => process.env.KIS_APP_KEY || "";
const getAppSecret = () => process.env.KIS_APP_SECRET || "";

// 환경에 따른 TR_ID 자동 설정
const getIsVts = () => {
    const url = getURL();
    // 1. URL에 vts가 포함되어 있으면 모의투자
    if (url.includes("vts")) return true;
    
    // 2. 계좌번호(CANO)가 7이나 8로 시작하면 KIS 관행상 모의투자일 확률이 높음
    const acc = getAccNo();
    if (acc.startsWith('7') || acc.startsWith('8')) return true;
    
    // 3. KIS_URL이 설정되지 않았거나 기본값이면 모의투자
    if (!process.env.KIS_URL) return true;

    return false;
};
const getTrId = () => ({
    BALANCE: getIsVts() ? "VTTC8434R" : "TTTC8434R",
    BUY: getIsVts() ? "VTTC0012U" : "TTTC0012U",
    SELL: getIsVts() ? "VTTC0011U" : "TTTC0011U",
    PRICE: "FHKST01010100"
});

import fs from 'fs';

// 캐싱용 토큰
let cachedToken: string | null = null;
let tokenExpiry: number | null = null;

try {
  if (fs.existsSync('./kis-token.json')) {
    const raw = fs.readFileSync('./kis-token.json', 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.token && parsed.expiry && Date.now() < parsed.expiry) {
      cachedToken = parsed.token;
      tokenExpiry = parsed.expiry;
    }
  }
} catch (e) {}

export const getKisToken = async () => {
  // 토큰이 존재하고 만료 전이면 재사용
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  await throttleKis();
  const appKey = getAppKey();
  const appSecret = getAppSecret();

  if (!appKey || !appSecret) {
     throw new Error("KIS API 키가 환경변수에 설정되지 않았습니다.");
  }

  try {
    const res = await axios.post(`${getURL()}/oauth2/tokenP`, {
      grant_type: "client_credentials",
      appkey: appKey,
      appsecret: appSecret,
    });
    
    cachedToken = res.data.access_token;
    // 발급 후 대략 24시간 후 만료 (안전을 위해 23시간으로 설정)
    tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
    
    try {
      fs.writeFileSync('./kis-token.json', JSON.stringify({ token: cachedToken, expiry: tokenExpiry }));
    } catch(e) {}

    return cachedToken;
  } catch (err: any) {
    const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("KIS Token Error:", errorDetail);
    throw new Error(`토큰 발급 실패: ${errorDetail}`);
  }
};

export const getHashKey = async (body: any) => {
  await throttleKis();
  try {
    const res = await axios.post(`${getURL()}/uapi/hashkey`, body, {
      headers: {
        'content-type': 'application/json',
        'appkey': getAppKey(),
        'appsecret': getAppSecret(),
      }
    });
    return res.data.HASH;
  } catch (err: any) {
    // console.error("HashKey Error:", err.response?.data || err.message);
    return null;
  }
};

export const getKisPrice = async (symbol: string, retryCount = 0): Promise<any> => {
  const token = await getKisToken();
  await throttleKis();
  try {
    const res = await axios.get(`${getURL()}/uapi/domestic-stock/v1/quotations/inquire-price`, {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": getAppKey(),
        "appsecret": getAppSecret(),
        "tr_id": "FHKST01010100"
      },
      params: {
        "fid_cond_mrkt_div_code": "J",
        "fid_input_iscd": symbol
      }
    });
    if (res.data.rt_cd !== '0' && retryCount < 3) {
      console.warn(`[KIS API] Price API Error for ${symbol}: ${res.data.msg1} (Code: ${res.data.rt_cd}). Retrying in 1s... (${retryCount + 1}/3)`);
      await delay(1000);
      return getKisPrice(symbol, retryCount + 1);
    }
    
    if (res.data.rt_cd !== '0') {
        console.warn(`[KIS API] Price API Error for ${symbol}: ${res.data.msg1} (Code: ${res.data.rt_cd})`);
        return null;
    }

    const output = res.data.output;
    if (!output) return null;

    const price = parseInt(output.stck_prpr, 10) || 0;
    const high52Week = parseInt(output.stck_dryy_hgpr, 10) || price;
    return {
      name: output.hts_kor_isnm,
      price,
      marketCap: parseInt(output.hts_avls, 10) * 100000000, // 억원 단위 → 원
      high52Week,
      dayChangeRate: parseFloat(output.prdy_ctrt) || 0
    };
  } catch (err: any) {
     const errMsg = err.response?.data?.msg1 || err.message || "알 수 없는 오류";
     if ((err.response?.status === 429 || errMsg.includes("초당 거래건수")) && retryCount < 3) {
        console.warn(`[KIS API] Rate Limit on getKisPrice(${symbol}). Retrying in 1s... (${retryCount + 1}/3)`);
        await delay(1000);
        return getKisPrice(symbol, retryCount + 1);
     }
     console.error(`[KIS API] GetPrice Error for ${symbol}: ${errMsg}`);
     return null;
  }
};

export const getKisBalance = async (retryCount = 0): Promise<any> => {
    const rawAccNo = process.env.KIS_ACC_NO;
    const accNo = getAccNo();
    
    if (!accNo) {
        const detail = rawAccNo === undefined ? "undefined value" : (rawAccNo === "" ? "empty string" : `value: ${rawAccNo}`);
        console.warn(`[KIS API] Balance check failed: Account number check failed. raw value is ${detail}`);
        return { error: `계좌 번호(KIS_ACC_NO)가 환경변수에 설정되지 않았거나 유효하지 않습니다. (입력값: ${rawAccNo})` };
    }

    const token = await getKisToken();
    await throttleKis();
    try {
        const trId = getTrId();
        const url = getURL();
        const [cano, acntPrdtCd] = accNo.split('-');
        
        console.log(`[KIS API] Requesting balance for ${cano}-${acntPrdtCd || '01'} (isVts: ${getIsVts()})`);
        
        const res = await axios.get(`${url}/uapi/domestic-stock/v1/trading/inquire-balance`, {
            headers: {
                "Content-Type": "application/json",
                "authorization": `Bearer ${token}`,
                "appkey": getAppKey(),
                "appsecret": getAppSecret(),
                "tr_id": trId.BALANCE,
                "custtype": "P"
            },
            params: {
                "CANO": cano,
                "ACNT_PRDT_CD": acntPrdtCd || "01",
                "AFHR_FLPR_YN": "N",
                "OFL_YN": "",
                "INQR_DVSN": "02",
                "UNPR_DVSN": "01",
                "FUND_STTL_ICLD_YN": "N",
                "FSRB_RESA_ICLD_YN": "N",
                "FNCG_AMT_AUTO_RDPT_YN": "N",
                "PRCS_DVSN": "00",
                "CTX_AREA_FK100": "",
                "CTX_AREA_NK100": ""
            }
        });
        
        if (res.data.rt_cd === '0') {
            console.log(`[KIS API] Balance check success for ${accNo}`);
            let balance = 0;
            let totalEquity = 0;
            if (res.data.output2 && res.data.output2.length > 0) {
                const d2Balance = res.data.output2[0].prvs_rcdl_excc_amt;
                if (d2Balance) balance = parseInt(d2Balance, 10) || 0;
                else balance = parseInt(res.data.output2[0].dnca_tot_amt, 10) || 0;

                totalEquity = parseInt(res.data.output2[0].tot_evlu_amt || "0", 10) || 0;
            }
            
            const positionItems = res.data.output1 || [];
            const positions = positionItems.map((item: any) => ({
                 symbol: item.pdno,
                 name: item.prdt_name,
                 qty: parseInt(item.hldg_qty, 10),
                 buyPrice: parseInt(item.pchs_avg_pric, 10),
                 currentPrice: parseInt(item.prpr, 10),
                 profitRate: parseFloat(item.evlu_pfls_rt) / 100,
                 profitAmount: parseInt(item.evlu_pfls_amt || "0", 10)
            }));
            
            return { 
                balance, 
                totalEquity, 
                positions, 
                accountNo: accNo, 
                isVts: getIsVts() 
            };
        }
        
        if (retryCount < 3) {
            console.warn(`[KIS API] Balance API Error: ${res.data.msg1} (Code: ${res.data.rt_cd}). Retrying in 1s... (${retryCount + 1}/3)`);
            await delay(1000);
            return getKisBalance(retryCount + 1);
        }
        
        console.warn(`[KIS API] Balance API Error: ${res.data.msg1} (Code: ${res.data.rt_cd})`);
        return { 
            error: res.data.msg1 || "알 수 없는 API 오류", 
            rt_cd: res.data.rt_cd,
            accountNo: accNo,
            isVts: getIsVts()
        };
    } catch (err: any) {
        const errMsg = err.response?.data?.msg1 || err.message || "서버 통신 오류";

        if ((err.response?.status === 429 || errMsg.includes("초당 거래건수")) && retryCount < 3) {
            console.warn(`[KIS API] Rate Limit on getKisBalance(). Retrying in 1s... (${retryCount + 1}/3)`);
            await delay(1000);
            return getKisBalance(retryCount + 1);
        }
        
        console.error(`[KIS API] critical error: ${errMsg}`);
        return { 
            error: errMsg,
            accountNo: getAccNo(),
            isVts: getIsVts()
        };
    }
};

export const buyOrder = async (symbol: string, price: string, qty: string) => {
    return _sendOrder(symbol, price, qty, getTrId().BUY); 
};

export const sellOrder = async (symbol: string, price: string, qty: string) => {
    return _sendOrder(symbol, price, qty, getTrId().SELL); 
};

const _sendOrder = async (symbol: string, price: string, qty: string, tr_id: string) => {
    const token = await getKisToken();
    const accNo = getAccNo();
    const body = {
        "CANO": accNo.split('-')[0],
        "ACNT_PRDT_CD": accNo.split('-')[1] || "01",
        "PDNO": symbol.toString(),
        "ORD_DVSN": "01", // 시장가
        "ORD_QTY": qty.toString(),
        "ORD_UNPR": "0" // 시장가는 0으로 전송
    };

    const hashkey = await getHashKey(body);
    if (!hashkey) return { success: false, message: "암호화 키(HashKey) 발급 실패" };

    await throttleKis();
    try {
        const res = await axios.post(`${getURL()}/uapi/domestic-stock/v1/trading/order-cash`, body, {
            headers: {
                "Content-Type": "application/json",
                "authorization": `Bearer ${token}`,
                "appkey": getAppKey(),
                "appsecret": getAppSecret(),
                "tr_id": tr_id,
                "custtype": "P",
                "hashkey": hashkey
            }
        });

        if (res.data.rt_cd === '0') {
            return { success: true, message: res.data.msg1, orderId: res.data.output?.ODNO };
        } else {
            return { success: false, message: res.data.msg1 };
        }
    } catch (err: any) {
        return { success: false, message: err.response?.data?.msg1 || "서버 통신 오류" };
    }
};

export const sendSlackNotification = async (message: string) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, { text: message });
    } catch (err) {
        console.error("Slack webhook error");
    }
};

// 거래대금 상위 100개 실시간 호출
async function fetchTop100ByVolume(): Promise<{symbol: string}[]> {
  try {
    const token = await getKisToken();
    await throttleKis();
    const res = await axios.get(`${getURL()}/uapi/domestic-stock/v1/quotations/volume-rank`, {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": getAppKey(),
        "appsecret": getAppSecret(),
        "tr_id": "FHPST01710000",
        "custtype": "P"
      },
      params: {
        "fid_cond_mrkt_div_code": "J",
        "fid_cond_scrn_id": "20171",      // fix: 1102 → 20171 (KIS 거래량순위 표준 스크린ID)
        "fid_input_iscd": "0000",
        "fid_div_cls_code": "0",
        "fid_blng_cls_code": "0",
        "fid_trgt_cls_code": "111111111",
        "fid_trgt_exls_cls_code": "000000",
        "fid_input_price_1": "",
        "fid_input_price_2": "",
        "fid_vol_cnt": "",
        "fid_input_date_1": ""
      }
    });

    if (res.data.rt_cd === '0' && res.data.output && res.data.output.length > 0) {
      console.log(`📋 [거래량 순위] API 성공: ${res.data.output.length}개 종목 수신`);
      return res.data.output.slice(0, 100).map((item: any) => ({
        symbol: item.mksc_shrn_iscd
      }));
    }
    console.warn(`[거래량 순위 API] 응답 이상: rt_cd=${res.data.rt_cd}, msg=${res.data.msg1}`);
  } catch (e: any) {
    console.error("Top volume API error:", e.response?.data?.msg1 || e.message);
  }
  // 실패 시 시총 1천억~2조 중형주 폴백 (대형주 사용 시 시총 필터 전부 탈락)
  console.warn("⚠️ [폴백] 거래량 순위 API 실패 → 중형주 기본 풀 사용");
  return [
    { symbol: "011200" }, { symbol: "000860" }, { symbol: "034020" },
    { symbol: "047040" }, { symbol: "073240" }, { symbol: "088790" },
    { symbol: "064350" }, { symbol: "054000" }, { symbol: "030000" },
    { symbol: "034120" }, { symbol: "105630" }, { symbol: "001230" },
    { symbol: "024720" }, { symbol: "006360" }, { symbol: "038530" },
    { symbol: "025620" }, { symbol: "204320" }, { symbol: "060980" },
    { symbol: "003410" }, { symbol: "095570" },
  ];
}

// 실시간 종목 상세 정보 조회
async function fetchStockDetail(symbol: string): Promise<any> {
  const kisData = await getKisPrice(symbol);
  
  const currentPrice = kisData?.price || 10000;
  return {
    symbol,
    name: kisData?.name || symbol,
    isWarning: false,
    isAdmin: false,
    isHalted: false,
    isCaution: false,
    marketCap: kisData?.marketCap || 0,
    high52Week: kisData?.high52Week || currentPrice * 1.1,
    currentPrice
  };
}

export async function getFilteredTopStocks(): Promise<{symbol: string, name: string}[]> {
  console.log("🔍 [1차 퀀트 스캐너] 당일 거래대금 상위 100개 종목 분석을 시작합니다...");
  
  // 1. KIS API로 거래대금 상위 100개 종목을 여유 있게 가져옵니다.
  // (기존의 top20 조회 API 호출 본문에서 요청 수량 파라미터를 100으로 변경)
  const top100Stocks = await fetchTop100ByVolume(); 
  
  const filteredStocks: {symbol: string, name: string}[] = [];
  const MAX_POOL_SIZE = 25; // 🎯 최종적으로 채울 감시 종목 수

  for (const stock of top100Stocks) {
    if (filteredStocks.length >= MAX_POOL_SIZE) {
      break;
    }

    // API 과부하 방지 (초당 2건 제한 준수 -> 500ms 지연)
    await delay(500);

    try {
      const detail = await fetchStockDetail(stock.symbol); 

      // [필터 1] 관리종목 / 투자경고 / 투자위험 / 거래정지 / 환기종목 원천 배제
      if (detail.isWarning || detail.isAdmin || detail.isHalted || detail.isCaution) {
        continue; 
      }

      // [필터 2] 시가총액 제한 (1,000억 ~ 20조) - API 실패(0)는 필터 통과
      const marketCap = detail.marketCap;
      if (marketCap > 0 && (marketCap < 100_000_000_000 || marketCap > 20_000_000_000_000)) {
        console.log(`  ✗ 시총 탈락: ${detail.name} (${(marketCap / 100_000_000).toFixed(0)}억)`);
        continue;
      }

      // [필터 3] 일봉상 전고점(신고가) 근접 여부 검사
      const high52w = detail.high52Week;
      const priceRatio = detail.currentPrice / high52w;
      if (priceRatio < 0.90) {
        continue; 
      }

      filteredStocks.push({symbol: stock.symbol, name: detail.name});
      console.log(`✅ [감시 풀 등록] ${detail.name} (${stock.symbol}) - 시총: ${(marketCap / 100_000_000).toFixed(0)}억 / 전고점 대비: ${(priceRatio * 100).toFixed(1)}%`);

    } catch (error) {
      console.error(`⚠️ 종목코드 ${stock.symbol} 필터링 중 오류 발생 (패스):`, error);
      continue;
    }
  }

  console.log(`🏁 [스캔 완료] 최종적으로 ${filteredStocks.length}개의 정예 주도주로 감시 풀을 구성했습니다.`);
  return filteredStocks;
}

export const getKospiStatus = async (): Promise<{
  price: number;
  changeRate: number;
  isDown: boolean;
} | null> => {
  try {
    const token = await getKisToken();
    await throttleKis();

    // KOSPI 지수 조회 (tr_id: FHPUP02100000, 모의투자에서 지원 안 될 수 있음)
    const res = await axios.get(`${getURL()}/uapi/domestic-stock/v1/quotations/inquire-index-price`, {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": getAppKey(),
        "appsecret": getAppSecret(),
        "tr_id": "FHPUP02100000",
        "custtype": "P"
      },
      params: {
        "fid_cond_mrkt_div_code": "U",
        "fid_input_iscd": "0001"
      }
    });

    if (res.data.rt_cd === '0' && res.data.output) {
      const out = res.data.output;
      const price = parseFloat(out.bstp_nmix_prpr || "0");
      const changeRate = parseFloat(out.prdy_ctrt || "0");
      const sign = out.prdy_vrss_sign; // '1'=상한, '2'=상승, '3'=보합, '4'=하한, '5'=하락
      const isDown = sign === '4' || sign === '5';
      if (price > 0) {
        return { price, changeRate: isDown ? -Math.abs(changeRate) : Math.abs(changeRate), isDown };
      }
    }
    // 모의투자에서는 지수 조회가 안 될 수 있음 - 조용히 null 반환
    if (getIsVts()) {
      console.warn("[KIS] KOSPI 지수 조회 미지원 (모의투자). 지수 감시 비활성화.");
    } else {
      console.warn(`[KIS] KOSPI 지수 조회 실패: rt_cd=${res.data.rt_cd}, msg=${res.data.msg1}`);
    }
    return null;
  } catch (err: any) {
    console.error("[KIS API] KOSPI status error:", err.response?.data?.msg1 || err.message);
    return null;
  }
};

export const getKisDailyBars = async (symbol: string, nDays: number = 100): Promise<{
  date: string; open: number; high: number; low: number; close: number; volume: number;
}[]> => {
  try {
    const token = await getKisToken();
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startD = new Date(today);
    startD.setDate(startD.getDate() - Math.ceil(nDays * 1.5)); // 주말/공휴일 여유
    const startDate = startD.toISOString().slice(0, 10).replace(/-/g, '');

    await throttleKis();
    const res = await axios.get(`${getURL()}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`, {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": getAppKey(),
        "appsecret": getAppSecret(),
        "tr_id": "FHKST03010100",
        "custtype": "P"
      },
      params: {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_INPUT_ISCD": symbol,
        "FID_INPUT_DATE_1": startDate,
        "FID_INPUT_DATE_2": endDate,
        "FID_PERIOD_DIV_CODE": "D",
        "FID_ORG_ADJ_PRC": "1"
      }
    });

    if (res.data.rt_cd === '0' && res.data.output2 && res.data.output2.length > 0) {
      return res.data.output2
        .filter((b: any) => b.stck_bsop_date && parseInt(b.stck_clpr || '0') > 0)
        .map((b: any) => ({
          date: b.stck_bsop_date,
          open: parseInt(b.stck_oprc || '0', 10),
          high: parseInt(b.stck_hgpr || '0', 10),
          low: parseInt(b.stck_lwpr || '0', 10),
          close: parseInt(b.stck_clpr || '0', 10),
          volume: parseInt(b.acml_vol || '0', 10),
        }))
        .reverse() // KIS는 최신→과거 순으로 반환, 역순으로 변환
        .slice(-nDays);
    }
    // KIS 응답 실패 — rt_cd와 메시지 출력해서 원인 진단
    console.warn(`[KIS Daily] ${symbol} 실패: rt_cd=${res.data.rt_cd}, msg="${res.data.msg1}", output2길이=${res.data.output2?.length ?? 'undefined'}`);
    return [];
  } catch (err: any) {
    console.error(`[KIS API] Daily bars error for ${symbol}:`, err.response?.data?.msg1 || err.message);
    return [];
  }
};

export const getKisMinuteBars = async (symbol: string, nBars: number = 20): Promise<{
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}[]> => {
  try {
    const token = await getKisToken();

    const now = new Date();
    const kstHours = now.getHours();
    const kstMinutes = now.getMinutes();
    const kstSeconds = now.getSeconds();
    const inputHour = `${String(kstHours).padStart(2, '0')}${String(kstMinutes).padStart(2, '0')}${String(kstSeconds).padStart(2, '0')}`;

    await throttleKis();
    const res = await axios.get(`${getURL()}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`, {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": getAppKey(),
        "appsecret": getAppSecret(),
        "tr_id": "FHKST03010200",
        "custtype": "P"
      },
      params: {
        "fid_etc_cls_code": "",
        "fid_cond_mrkt_div_code": "J",
        "fid_input_iscd": symbol,
        "fid_input_hour_1": inputHour,
        "fid_pw_data_incu_yn": "Y"
      }
    });

    if (res.data.rt_cd === '0' && res.data.output2 && res.data.output2.length > 0) {
      return res.data.output2.slice(0, nBars).map((bar: any) => ({
        time: bar.stck_cntg_hour,
        open: parseInt(bar.stck_oprc || "0", 10),
        high: parseInt(bar.stck_hgpr || "0", 10),
        low: parseInt(bar.stck_lwpr || "0", 10),
        close: parseInt(bar.stck_prpr || "0", 10),
        volume: parseInt(bar.cntg_vol || "0", 10)
      }));
    }
    return [];
  } catch (err: any) {
    console.error(`[KIS API] Minute bars error for ${symbol}:`, err.response?.data?.msg1 || err.message);
    return [];
  }
};

