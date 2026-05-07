import 'dotenv/config';
import Fastify from 'fastify';
import { startPullLoop, callApi } from './message';
import { logger } from './logger';

process.on('uncaughtException', (error) => logger.error(`全局异常捕获: ${(error as Error).message}`));
process.on('unhandledRejection', (reason) => logger.error(`未处理的Promise拒绝: ${reason}`));

const app = Fastify();

app.get('/', async () => '访问成功');
app.get('/health/liveness', async () => 'ok');
app.get('/health/readiness', async () => 'ok');

app.all('/message/callApi', async (request, reply) => {
    const { url, params } = (request.body ?? {}) as { url?: string; params?: Record<string, any> };
    if (!url) {
        reply.status(400);
        return { code: 400, message: '缺少必填参数' };
    }
    try {
        const data = await callApi({ url, params });
        return { code: 200, data };
    } catch (error: any) {
        reply.status(500);
        return { code: 500, message: error?.message };
    }
});

app.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) {
        logger.error(err.message);
        process.exit(1);
    }
    logger.info('服务启动，端口 3000');
    startPullLoop();
});
