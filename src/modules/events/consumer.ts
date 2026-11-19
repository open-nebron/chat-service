import os from 'node:os';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { parseEvent } from '@nebron/contracts';
import type { SubscriptionManager } from '../../ws/subscriptions.js';

export interface RedisStreamConsumerOptions {
  redisUrl: string;
  streamName?: string;
  groupName?: string;
  consumerName?: string;
  subscriptionManager?: SubscriptionManager;
  logger?: any;
}

export class RedisStreamEventConsumer {
  private redis: Redis | null = null;
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private readonly redisUrl: string;
  private readonly streamName: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly subscriptionManager?: SubscriptionManager;
  private readonly logger?: any;

  constructor(options: RedisStreamConsumerOptions) {
    this.redisUrl = options.redisUrl;
    this.streamName = options.streamName || 'nebron.events';
    this.groupName = options.groupName || 'chat-service';
    this.consumerName =
      options.consumerName || `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
    this.subscriptionManager = options.subscriptionManager;
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    this.isRunning = true;
    await this.initConsumerGroup();
    this.loopPromise = this.consumeLoop();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // Ignore
      }
      this.redis = null;
    }
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  private async initConsumerGroup(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.xgroup('CREATE', this.streamName, this.groupName, '$', 'MKSTREAM');
      this.logInfo(`Created consumer group '${this.groupName}' on stream '${this.streamName}'`);
    } catch (err: any) {
      if (err.message && err.message.includes('BUSYGROUP')) {
        this.logInfo(`Consumer group '${this.groupName}' already exists on '${this.streamName}'`);
      } else {
        this.logWarn(`Error creating consumer group: ${err.message}`);
      }
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.isRunning && this.redis) {
      try {
        const response = (await (this.redis as any).xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'BLOCK',
          2000,
          'COUNT',
          10,
          'STREAMS',
          this.streamName,
          '>'
        )) as [string, [string, string[]][]][] | null;

        if (!response || response.length === 0) {
          continue;
        }

        for (const [, messages] of response) {
          for (const [messageId, rawFields] of messages) {
            await this.processMessage(messageId, rawFields);
          }
        }
      } catch (err: any) {
        if (!this.isRunning) break;
        this.logWarn(`Error in event stream reading loop: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private parseFields(rawFields: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (let i = 0; i < rawFields.length; i += 2) {
      const key = rawFields[i];
      const val = rawFields[i + 1];
      if (key !== undefined && val !== undefined) {
        fields[key] = val;
      }
    }
    return fields;
  }

  private async processMessage(messageId: string, rawFields: string[]): Promise<void> {
    if (!this.redis) return;

    const fields = this.parseFields(rawFields);
    let event: any;

    try {
      let payloadObj = fields.payload;
      if (typeof payloadObj === 'string') {
        try {
          payloadObj = JSON.parse(payloadObj);
        } catch {
          // If not JSON, leave as is
        }
      }

      event = parseEvent({
        type: fields.type,
        payload: payloadObj,
      });
    } catch (parseErr: any) {
      // Poison-handling: if parseEvent throws, XACK and log, do not retry
      this.logWarn(`Poison event in stream [id=${messageId}]: ${parseErr.message}`);
      await this.ack(messageId);
      return;
    }

    try {
      switch (event.type) {
        case 'auth.session.revoked': {
          const { sessionId, userId } = event.payload;
          // SETEX revoked_sessions:{sessionId} 86400 "1" (24h, longer than token TTL)
          await this.redis.set(`revoked_sessions:${sessionId}`, '1', 'EX', 86400);

          // Find all connected local sockets with socket.sessionId === sessionId
          if (this.subscriptionManager) {
            const sockets = this.subscriptionManager.getAllSockets();
            for (const socket of sockets) {
              if (socket.sessionId === sessionId) {
                try {
                  socket.close(4403, 'session_revoked');
                } catch {
                  // Ignore
                }
              }
            }

            // Also publish to Redis ws:user channel for cross-pod coordination
            await this.redis.publish(
              `ws:user:${userId}`,
              JSON.stringify({
                type: 'session.revoked',
                sessionId,
              })
            );
          }
          break;
        }

        case 'core.profile.updated': {
          const { userId } = event.payload;
          // SET profile:{userId} '<json>' EX 3600
          await this.redis.set(`profile:${userId}`, JSON.stringify(event.payload), 'EX', 3600);
          break;
        }

        case 'core.relationship.blocked': {
          const { fromUserId, toUserId } = event.payload;
          // Update local sockets
          if (this.subscriptionManager) {
            const sockets = this.subscriptionManager.getAllSockets();
            for (const socket of sockets) {
              if (socket.userId === fromUserId) {
                socket.blockedPeers.set(toUserId, { blocked: true });
              }
              if (socket.userId === toUserId) {
                socket.blockedPeers.set(fromUserId, { blocked: true });
              }
            }

            // Cross-pod notification
            await this.redis.publish(
              `ws:user:${fromUserId}`,
              JSON.stringify({
                type: 'relationship.blocked',
                peerUserId: toUserId,
              })
            );
            await this.redis.publish(
              `ws:user:${toUserId}`,
              JSON.stringify({
                type: 'relationship.blocked',
                peerUserId: fromUserId,
              })
            );
          }

          // Update Redis relationship cache
          await this.redis.set(
            `rel:${fromUserId}:${toUserId}`,
            JSON.stringify({ blocked: true }),
            'EX',
            300
          );
          await this.redis.set(
            `rel:${toUserId}:${fromUserId}`,
            JSON.stringify({ blocked: true }),
            'EX',
            300
          );
          break;
        }

        case 'core.relationship.unblocked': {
          const { fromUserId, toUserId } = event.payload;
          // Update local sockets
          if (this.subscriptionManager) {
            const sockets = this.subscriptionManager.getAllSockets();
            for (const socket of sockets) {
              if (socket.userId === fromUserId) {
                socket.blockedPeers.set(toUserId, { blocked: false });
              }
              if (socket.userId === toUserId) {
                socket.blockedPeers.set(fromUserId, { blocked: false });
              }
            }

            // Cross-pod notification
            await this.redis.publish(
              `ws:user:${fromUserId}`,
              JSON.stringify({
                type: 'relationship.unblocked',
                peerUserId: toUserId,
              })
            );
            await this.redis.publish(
              `ws:user:${toUserId}`,
              JSON.stringify({
                type: 'relationship.unblocked',
                peerUserId: fromUserId,
              })
            );
          }

          // Clear Redis relationship cache
          await this.redis.del(`rel:${fromUserId}:${toUserId}`);
          await this.redis.del(`rel:${toUserId}:${fromUserId}`);
          break;
        }

        default:
          // Unknown or unhandled event types: XACK and ignore
          break;
      }
    } catch (err: any) {
      this.logWarn(`Error processing event [id=${messageId}]: ${err.message}`);
    } finally {
      await this.ack(messageId);
    }
  }

  private async ack(messageId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.xack(this.streamName, this.groupName, messageId);
      } catch {
        // Ignore
      }
    }
  }

  private logInfo(msg: string): void {
    if (this.logger?.info) {
      this.logger.info(`[RedisStreamEventConsumer] ${msg}`);
    }
  }

  private logWarn(msg: string): void {
    if (this.logger?.warn) {
      this.logger.warn(`[RedisStreamEventConsumer] ${msg}`);
    }
  }
}
