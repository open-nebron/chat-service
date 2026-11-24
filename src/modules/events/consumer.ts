import os from 'node:os';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { parseEvent } from '@nebron/contracts';
import type { SubscriptionManager } from '../../ws/subscriptions.js';
import type { Repositories } from '../../plugins/repos.js';

export interface RedisStreamConsumerOptions {
  redisUrl: string;
  streamName?: string;
  groupName?: string;
  consumerName?: string;
  subscriptionManager?: SubscriptionManager;
  repos?: Repositories;
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
  private readonly repos?: Repositories;
  private readonly logger?: any;

  constructor(options: RedisStreamConsumerOptions) {
    this.redisUrl = options.redisUrl;
    this.streamName = options.streamName || 'nebron.events';
    this.groupName = options.groupName || 'chat-service';
    this.consumerName =
      options.consumerName || `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
    this.subscriptionManager = options.subscriptionManager;
    this.repos = options.repos;
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

        // Section 9: We publish to BOTH Redis Pub/Sub channels and nebron.events stream.
        // The stream is the single source of truth across all chat-service instances,
        // so consuming chat.conversation.* events here guarantees WS subscription sync across pods.
        case 'chat.conversation.created': {
          const { conversationId, memberIds } = event.payload;
          if (this.subscriptionManager && Array.isArray(memberIds)) {
            for (const memberId of memberIds) {
              await this.subscriptionManager.subscribeUserSockets(
                memberId,
                `ws:conv:${conversationId}`
              );
            }
          }
          break;
        }

        case 'chat.conversation.member_added': {
          const { conversationId, userIds } = event.payload;
          if (this.subscriptionManager && Array.isArray(userIds)) {
            for (const memberId of userIds) {
              await this.subscriptionManager.subscribeUserSockets(
                memberId,
                `ws:conv:${conversationId}`
              );
            }
          }
          break;
        }

        case 'chat.conversation.member_removed': {
          const { conversationId, userId } = event.payload;
          if (this.subscriptionManager) {
            const sockets = this.subscriptionManager.getUserSockets(userId);
            for (const s of sockets) {
              await this.subscriptionManager.unsubscribe(s, `ws:conv:${conversationId}`);
              try {
                s.send(
                  JSON.stringify({
                    type: 'conversation.removed',
                    payload: { conversationId },
                  })
                );
              } catch {
                // Ignore send errors on disconnecting socket
              }
            }
          }
          break;
        }

        case 'chat.conversation.renamed': {
          // No subscription changes required on rename
          break;
        }

        case 'chat.conversation.deleted': {
          // Conversation deleted: unsubscribe any connected local sockets
          break;
        }

        case 'voice.call.group_started': {
          const { callId, conversationId, hostId, roomName, mode, startedAt } = event.payload;
          if (this.repos && this.redis) {
            const messageBody = JSON.stringify({
              callId,
              roomName,
              hostId,
              mode: mode || 'audio',
              startedAt,
            });

            const message = await this.repos.messages.insert({
              conversationId,
              senderId: hostId,
              body: messageBody,
              kind: 'call_invite',
            });

            // Store callId -> { conversationId, messageId } mapping for fast lookup when call ends
            await this.redis.set(
              `call_msg:${callId}`,
              JSON.stringify({ conversationId, messageId: message.id }),
              'EX',
              86400
            );

            // Update user_conversations for members
            try {
              const conv = await this.repos.conversations.getById(conversationId);
              const memberIds = conv ? conv.memberIds : [];
              for (const memberId of memberIds) {
                await this.repos.userConversations.upsert({
                  userId: memberId,
                  conversationId,
                  lastMessageAt: message.createdAt,
                  lastMessageId: message.id,
                  lastMessageBody: 'Started a call',
                  unreadDelta: memberId === hostId ? 0 : 1,
                });
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.logWarn(`Failed updating user_conversations for call_invite: ${errMsg}`);
            }

            const formatted = {
              id: message.id,
              conversationId,
              senderId: hostId,
              body: message.body,
              createdAt: message.createdAt.toISOString(),
              editedAt: null,
              deleted: false,
              reactions: [],
              kind: 'call_invite',
            };

            await this.redis.publish(
              `ws:conv:${conversationId}`,
              JSON.stringify({
                type: 'message.new',
                payload: {
                  message: formatted,
                  conversationId,
                },
              })
            );
          }
          break;
        }

        case 'voice.call.participant_joined': {
          const { callId, conversationId, userId, at } = event.payload;
          if (this.redis) {
            await this.redis.publish(
              `ws:conv:${conversationId}`,
              JSON.stringify({
                type: 'call.participant_joined',
                payload: {
                  callId,
                  conversationId,
                  userId,
                  joinedAt: at,
                },
              })
            );
          }
          break;
        }

        case 'voice.call.participant_left': {
          const { callId, conversationId, userId, at } = event.payload;
          if (this.redis) {
            await this.redis.publish(
              `ws:conv:${conversationId}`,
              JSON.stringify({
                type: 'call.participant_left',
                payload: {
                  callId,
                  conversationId,
                  userId,
                  leftAt: at,
                },
              })
            );
          }
          break;
        }

        case 'voice.call.ended': {
          const { callId, conversationId, endedBy, reason, at } = event.payload;
          if (this.redis) {
            let convId = conversationId;
            let msgId: string | null = null;

            const mappingRaw = await this.redis.get(`call_msg:${callId}`);
            if (mappingRaw) {
              try {
                const mapping = JSON.parse(mappingRaw);
                if (!convId) convId = mapping.conversationId;
                msgId = mapping.messageId;
              } catch {
                // ignore
              }
            }

            if (convId && msgId && this.repos) {
              const existingMsg = await this.repos.messages.getById(convId, msgId);
              if (existingMsg && existingMsg.kind === 'call_invite') {
                let parsedBody: Record<string, unknown> = {};
                try {
                  parsedBody = JSON.parse(existingMsg.body);
                } catch {
                  parsedBody = { raw: existingMsg.body };
                }
                parsedBody.endedAt = at;
                parsedBody.endReason = reason;
                parsedBody.endedBy = endedBy;

                const updatedBody = JSON.stringify(parsedBody);
                const updatedMsg = await this.repos.messages.updateBody(
                  convId,
                  msgId,
                  updatedBody,
                  existingMsg.editCount || 0
                );

                const formatted = {
                  id: updatedMsg.id,
                  conversationId: convId,
                  senderId: updatedMsg.senderId,
                  body: updatedMsg.body,
                  createdAt: updatedMsg.createdAt.toISOString(),
                  editedAt: updatedMsg.editedAt ? updatedMsg.editedAt.toISOString() : null,
                  deleted: updatedMsg.deleted,
                  reactions: [],
                  kind: 'call_invite',
                };

                await this.redis.publish(
                  `ws:conv:${convId}`,
                  JSON.stringify({
                    type: 'message.edited',
                    payload: {
                      conversationId: convId,
                      messageId: msgId,
                      body: updatedBody,
                      editedAt: at,
                      message: formatted,
                    },
                  })
                );
              }
            }

            if (convId) {
              await this.redis.publish(
                `ws:conv:${convId}`,
                JSON.stringify({
                  type: 'call.ended',
                  payload: {
                    callId,
                    conversationId: convId,
                    endedBy,
                    reason,
                  },
                })
              );
            }
          }
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
