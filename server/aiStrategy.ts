import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

export async function askGeminiForApproval(stockName: string, recentNews: string): Promise<boolean> {
  const prompt = `
    당신은 한국 주식 시장의 단타(스캘핑/데이 트레이딩) 최고 전문가입니다.
    현재 '${stockName}' 종목이 알고리즘상 매수 타점에 도달했습니다.
    아래 제공된 오늘자 최신 뉴스와 시장 분위기를 분석하여 당일 진입해도 좋은지 최종 승인(YES/NO)을 내려주세요.

    [평가 기준]
    1. 이 종목이 현재 시장을 주도하는 테마의 1등주(대장주)인가? (2, 3등주는 감점)
    2. 당일 강력한 상승을 뒷받침할 명확한 호재(국책과제, 대규모 수주, 세계 최초 등)가 있는가?
    3. 뉴스가 이미 재료 소멸(설거지) 단계인지, 이제 막 시작된 재료인지 파악할 것.

    [종목 정보]
    - 종목명: ${stockName}
    - 관련 최신 뉴스: "${recentNews}"

    결과를 아래 JSON 형식으로만 반환하세요.
    {
      "buy_approved": true 또는 false,
      "reason": "결정에 대한 1~2줄의 짧고 명확한 이유"
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });
    
    if (!response.text) return false;

    const responseData = JSON.parse(response.text);
    console.log(`🤖 [Gemini 판단]: ${responseData.buy_approved ? '🟢 매수 승인' : '🔴 매수 거절'} (사유: ${responseData.reason})`);
    
    return responseData.buy_approved;
  } catch (error) {
    console.error("❌ Gemini AI 분석 중 오류 발생, 안전을 위해 매수를 보류합니다.", error);
    return false; 
  }
}
