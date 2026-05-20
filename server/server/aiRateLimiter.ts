type Priority = 'HIGH' | 'LOW'; // HIGH: 매도/손절 감시, LOW: 신규 매수 감시

interface QueueItem {
  id: string;             // 종목명 등 식별자
  priority: Priority;     // 하이패스 여부
  addedAt: number;        // 큐에 들어온 시간 (Fail-fast용)
  resolve: (value: boolean) => void; // 실행 승인 콜백
}

class AiRateLimiter {
  private highQueue: QueueItem[] = [];
  private lowQueue: QueueItem[] = [];
  private isProcessing = false;
  private lastCallTime = 0;
  
  // API 제한 설정
  private readonly COOLDOWN_MS = 5000; // 분당 12회 (5초 쿨타임)
  private readonly TIMEOUT_MS = 60000; // 60초 대기 초과 시 Fail-Fast 자동 폐기

  // AI 호출 권한을 요청하는 메인 진입점
  public async waitForTurn(priority: Priority, contextId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const item: QueueItem = { id: contextId, priority, addedAt: Date.now(), resolve };

      if (priority === 'HIGH') {
        this.highQueue.push(item);
        console.log(`🚨 [하이패스 큐 진입] ${contextId} - 매도 판독 최우선 배치 (대기열 새치기)`);
      } else {
        this.lowQueue.push(item);
        console.log(`⏳ [일반 큐 진입] ${contextId} - 신규 매수 판독 대기`);
      }

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    
    // 두 큐가 모두 비어있으면 루프 종료
    if (this.highQueue.length === 0 && this.lowQueue.length === 0) return;

    this.isProcessing = true;

    // 1. 글로벌 5초 쿨타임 대기 (API 한도 보호)
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    if (timeSinceLastCall < this.COOLDOWN_MS) {
      const delay = this.COOLDOWN_MS - timeSinceLastCall;
      await new Promise(r => setTimeout(r, delay));
    }

    // 2. 다음 처리할 아이템 추출 (HIGH 큐가 무조건 우선!)
    let nextItem: QueueItem | undefined = this.highQueue.shift();
    if (!nextItem) {
      nextItem = this.lowQueue.shift(); // HIGH가 비어있을 때만 LOW 처리
    }

    if (nextItem) {
      // 3. 60초 타임아웃(Fail-Fast) 검증
      const timeInQueue = Date.now() - nextItem.addedAt;
      if (timeInQueue > this.TIMEOUT_MS) {
        console.warn(`⚠️ [Fail-Fast 발동] ${nextItem.id} 요청 대기 60초 초과. 시스템 안전을 위해 자동 폐기(Pass)합니다.`);
        nextItem.resolve(false); // 승인 거부
      } else {
        // 정상 승인
        this.lastCallTime = Date.now();
        nextItem.resolve(true); 
      }
    }

    this.isProcessing = false;
    
    // 큐에 남은 항목이 있다면 재귀적으로 즉시 이어서 처리
    this.processQueue();
  }
}

// 싱글톤 인스턴스로 내보내어 앱 전체에서 하나의 큐를 공유
export const aiLimiter = new AiRateLimiter();
