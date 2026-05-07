import axios from 'axios';
import * as crypto from 'crypto';
import { logger } from './logger';

const JCQ_PULL_INTERVAL = Number(process.env.JD_JCQ_PULL_INTERVAL_MS || 3000);
const MAX_CONSECUTIVE_FAILURES = 50;

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
): Promise<void> {
    const ackBody = {
        topic: config.topic,
        consumerGroupId: config.consumerGroupId,
        ackAction: 'SUCCESS',
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
    logger.info(JSON.stringify({ desc: 'pullJcqMessages--ACK参数', content: { ackUrl, ackBody } }));
    const resp = await axios.post(ackUrl, ackBody, { headers: ackHeaders, timeout: 300000 });
    logger.info(JSON.stringify({ desc: 'pullJcqMessages--ACK结果', content: resp.data }));
}

export async function pullJcqMessages(): Promise<void> {
    const config = {
        url: process.env.JD_JCQ_URL!,
        accessKey: process.env.JD_JCQ_KEY!,
        secretKey: process.env.JD_JCQ_SECRET!,
        topic: process.env.JD_JCQ_TOPIC!,
        consumerGroupId: process.env.JD_JCQ_CONSUMER_GROUP_ID!,
        size: 1,
        ack: 'false',
    };

    if (!config.accessKey || !config.secretKey || !config.topic || !config.consumerGroupId) {
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

    const pullResp = await axios.get(pullUrl, { headers: pullHeaders, timeout: 300000 });
    const pullResult = pullResp.data;
    const ackIndex = pullResult?.result?.ackIndex ? String(pullResult.result.ackIndex) : null;

    if (ackIndex) {
        logger.info(JSON.stringify({ desc: 'pullJcqMessages--拉取结果', content: pullResult }));
        void ackJcqMessage(config, ackIndex);
    }

    if (pullResult?.result?.messages?.length > 0) {
        const forwardResp = await axios.post('https://aiqc.aiyongtech.com/message/receiveJdMessage', {
            messages: pullResult.result.messages,
        });
        logger.info(JSON.stringify({ desc: 'pullJcqMessages--结束', content: forwardResp.data }));
    }
}

async function executePull(): Promise<void> {
    if (isPulling) {
        logger.info('[pullJcqMessages] 上一次轮询尚未结束，跳过本次');
        scheduleNextPull(JCQ_PULL_INTERVAL);
        return;
    }
    isPulling = true;
    try {
        await pullJcqMessages();
        consecutiveFailureCount = 0;
    } catch (error) {
        consecutiveFailureCount++;
        logger.error(JSON.stringify({ desc: 'pullJcqMessages--自动轮询执行失败', error: (error as Error)?.message || error }));
        if (consecutiveFailureCount > MAX_CONSECUTIVE_FAILURES) {
            logger.error(JSON.stringify({
                desc: 'pullJcqMessages--自动轮询连续失败次数超过阈值，请关注服务状态',
                consecutiveFailureCount,
                maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
            }));
        }
    } finally {
        isPulling = false;
        scheduleNextPull(JCQ_PULL_INTERVAL);
    }
}

function scheduleNextPull(delay: number): void {
    if (pullTimer) clearTimeout(pullTimer);
    pullTimer = setTimeout(() => void executePull(), Math.max(0, delay));
}

export function startPullLoop(): void {
    consecutiveFailureCount = 0;
    scheduleNextPull(0);
    logger.info('京东消息任务启动');
}

export async function callApi({ url, params }: { url: string; params?: Record<string, any> }): Promise<any> {
    if (!url) throw new Error('缺少必填参数');
    const resp = await axios.get(url, params);
    return resp.data;
}
