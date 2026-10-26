import axios from 'axios';
import * as crypto from 'crypto';
import { logger } from './logger';

const JCQ_PULL_INTERVAL = Number(process.env.JD_JCQ_PULL_INTERVAL_MS || 1000);
const JCQ_PULL_SIZE = Number(process.env.JD_JCQ_PULL_SIZE || 32);
const JCQ_PULL_TIMEOUT = Number(process.env.JD_JCQ_PULL_TIMEOUT_MS || 30000);
const JCQ_ACK_TIMEOUT = Number(process.env.JD_JCQ_ACK_TIMEOUT_MS || 10000);
const JCQ_FORWARD_TIMEOUT = Number(process.env.JD_JCQ_FORWARD_TIMEOUT_MS || 30000);
const MAX_RETRY_INTERVAL = 30000;
const MAX_CONSECUTIVE_FAILURES = 50;

type JcqAckAction = 'SUCCESS' | 'CONSUME_FAILED' | 'RESEND' | 'DISCARD';

let isPulling = false;
let consecutiveFailureCount = 0;
let pullTimer: NodeJS.Timeout | null = null;

function getIsoDateTime(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getJcqSignature(signParams: Record<string, string | number>, secretKey: string): string {
    const signSource = Object.keys(signParams)
        .sort()
        .map((k) => `${k}=${signParams[k] ?? ''}`)
        .join('&');
    return crypto.createHmac('sha1', secretKey).update(signSource, 'utf8').digest('base64');
}

async function ackJcqMessage(
    config: { url: string; accessKey: string; secretKey: string; topic: string; consumerGroupId: string },
    ackIndex: string,
    ackAction: JcqAckAction = 'SUCCESS',
): Promise<void> {
    const ackBody = {
        topic: config.topic,
        consumerGroupId: config.consumerGroupId,
        ackAction,
        ackIndex,
    };
    const ackDateTime = getIsoDateTime();
    const ackHeaders = {
        'Content-Type': 'application/json',
        accessKey: config.accessKey,
        dateTime: ackDateTime,
        signature: getJcqSignature(
            { accessKey: config.accessKey, dateTime: ackDateTime, ...ackBody },
            config.secretKey,
        ),
    };
    const ackUrl = `${config.url}/v2/ack`;
    const resp = await axios.post(ackUrl, ackBody, { headers: ackHeaders, timeout: JCQ_ACK_TIMEOUT });
    if (resp.data?.error != null) {
        logger.error(JSON.stringify({ desc: 'pullJcqMessages--ACK失败', ackIndex, ackAction, content: resp.data }));
        throw new Error(`JCQ ACK业务失败: ${JSON.stringify(resp.data)}`);
    }
    logger.info(JSON.stringify({ desc: 'pullJcqMessages--ACK结果', content: resp.data }));
}

export async function pullJcqMessages(): Promise<number> {
    const startedAt = Date.now();
    const config = {
        url: process.env.JD_JCQ_URL!,
        accessKey: process.env.JD_JCQ_KEY!,
        secretKey: process.env.JD_JCQ_SECRET!,
        topic: process.env.JD_JCQ_TOPIC!,
        consumerGroupId: process.env.JD_JCQ_CONSUMER_GROUP_ID!,
        size: JCQ_PULL_SIZE,
        ack: 'true',
    };

    if (!config.url || !config.accessKey || !config.secretKey || !config.topic || !config.consumerGroupId) {
        logger.error('JCQ配置缺失，请检查');
        throw new Error('JCQ配置缺失，请检查');
    }

    const dateTime = getIsoDateTime();
    const pullSignData = {
        accessKey: config.accessKey,
        dateTime,
        topic: config.topic,
        consumerGroupId: config.consumerGroupId,
        size: config.size,
        ack: config.ack,
    };
    const pullHeaders = {
        accessKey: config.accessKey,
        dateTime,
        signature: getJcqSignature(pullSignData, config.secretKey),
    };
    const pullUrl = `${config.url}/v2/messages?topic=${encodeURIComponent(config.topic)}&consumerGroupId=${encodeURIComponent(config.consumerGroupId)}&size=${config.size}&ack=${config.ack}`;

    const pullResp = await axios.get(pullUrl, { headers: pullHeaders, timeout: JCQ_PULL_TIMEOUT });
    const pullResult = pullResp.data;
    if (pullResult?.error != null) {
        logger.error(JSON.stringify({ desc: 'JCQ拉取业务失败', content: pullResult }));
        throw new Error(`JCQ拉取业务失败: ${JSON.stringify(pullResult)}`);
    }
    const messages = pullResult?.result?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    const rawAckIndex = pullResult.result.ackIndex;
    if ((typeof rawAckIndex !== 'string' && typeof rawAckIndex !== 'number') || String(rawAckIndex).length === 0) {
        logger.error(JSON.stringify({ desc: 'JCQ拉取到消息但缺少有效的 ackIndex', content: pullResult }));
    }
    const ackIndex = String(rawAckIndex);
    const messageIds = messages.map((message) => message.messageId);
    logger.info(JSON.stringify({ desc: 'pullJcqMessages--拉取结果', messageCount: messages.length, messageIds, ackIndex }));

    let forwardResult: any;
    try {
        const forwardResp = await axios.post('https://aiqc.aiyongtech.com/message/receiveJdMessage', {
            messages,
        }, { timeout: JCQ_FORWARD_TIMEOUT });
        forwardResult = forwardResp.data;
        if (forwardResult?.code !== 200) {
            logger.error(JSON.stringify({ desc: '消息转发失败', ackIndex, content: forwardResult }));
            throw new Error(`消息转发业务失败: ${JSON.stringify(forwardResult)}`);
        }
    } catch (error) {
        logger.error(JSON.stringify({ desc: '消息转发出错', ackIndex, error: (error as Error)?.message }));
        // try {
        //     await ackJcqMessage(config, ackIndex, 'CONSUME_FAILED');
        // } catch (ackError) {
        //     logger.error(JSON.stringify({
        //         desc: 'pullJcqMessages--消费失败ACK失败',
        //         ackIndex,
        //         error: (ackError as Error)?.message || ackError,
        //     }));
        // }
        // throw error;
    }
    // await ackJcqMessage(config, ackIndex);
    logger.info(JSON.stringify({ desc: 'pullJcqMessages--结束', messageCount: messages.length, durationMs: Date.now() - startedAt }));
    return messages.length;
}

async function executePull(): Promise<void> {
    if (isPulling) {
        logger.info('[pullJcqMessages] 上一次轮询尚未结束，跳过本次');
        return;
    }
    isPulling = true;
    let nextDelay = JCQ_PULL_INTERVAL;
    try {
        const messageCount = await pullJcqMessages();
        consecutiveFailureCount = 0;
        nextDelay = messageCount > 0 ? 0 : JCQ_PULL_INTERVAL;
    } catch (error) {
        consecutiveFailureCount++;
        nextDelay = Math.min(MAX_RETRY_INTERVAL, JCQ_PULL_INTERVAL * 2 ** Math.min(consecutiveFailureCount - 1, 30));
        logger.error(JSON.stringify({
            desc: 'pullJcqMessages--自动轮询执行失败',
            error: (error as Error)?.message || error,
            consecutiveFailureCount,
            nextDelay,
        }));
        if (consecutiveFailureCount > MAX_CONSECUTIVE_FAILURES) {
            logger.error(JSON.stringify({
                desc: 'pullJcqMessages--自动轮询连续失败次数超过阈值，请关注服务状态',
                consecutiveFailureCount,
                maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
            }));
        }
    } finally {
        isPulling = false;
        scheduleNextPull(nextDelay);
    }
}

function scheduleNextPull(delay: number): void {
    if (pullTimer) clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
        pullTimer = null;
        void executePull();
    }, Math.max(0, delay));
}

export function startPullLoop(): void {
    if (pullTimer || isPulling) return;
    consecutiveFailureCount = 0;
    scheduleNextPull(0);
    logger.info('消息任务启动');
}

export async function callApi({ url, params }: { url: string; params?: Record<string, any> }): Promise<any> {
    if (!url) {
        logger.error('callApi缺少必填参数 url');
        throw new Error('缺少必填参数');
    }
    const resp = await axios.get(url, params);
    return resp.data;
}
