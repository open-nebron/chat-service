export interface RateLimiterOptions {
  messagesPerSec?: number;
  typingPerSec?: number;
  readPerSec?: number;
  maxFrameBytes?: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly fillRatePerMs: number;

  constructor(ratePerSec: number) {
    this.capacity = ratePerSec;
    this.tokens = ratePerSec;
    this.fillRatePerMs = ratePerSec / 1000;
    this.lastRefill = Date.now();
  }

  public tryConsume(tokens = 1): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillRatePerMs);
    this.lastRefill = now;

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }
}

export class SocketRateLimiter {
  private readonly sendBucket: TokenBucket;
  private readonly typingBucket: TokenBucket;
  private readonly readBucket: TokenBucket;
  public readonly maxFrameBytes: number;

  constructor(options: RateLimiterOptions = {}) {
    this.sendBucket = new TokenBucket(options.messagesPerSec ?? 10);
    this.typingBucket = new TokenBucket(options.typingPerSec ?? 10);
    this.readBucket = new TokenBucket(options.readPerSec ?? 20);
    this.maxFrameBytes = options.maxFrameBytes ?? 32768;
  }

  public allowSend(): boolean {
    return this.sendBucket.tryConsume(1);
  }

  public allowTyping(): boolean {
    return this.typingBucket.tryConsume(1);
  }

  public allowRead(): boolean {
    return this.readBucket.tryConsume(1);
  }

  public isFrameValid(sizeInBytes: number): boolean {
    return sizeInBytes <= this.maxFrameBytes;
  }
}
