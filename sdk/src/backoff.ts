// §17.6 429 バックオフの状態を1か所に集約する値オブジェクト。
// 「送信停止中か？」の判定と「Retry-After 分だけ停止」をここだけで扱う。
export class Backoff {
  private until = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  paused(): boolean {
    return this.now() < this.until;
  }

  pauseForSec(sec: number): void {
    this.until = this.now() + sec * 1000;
  }
}
