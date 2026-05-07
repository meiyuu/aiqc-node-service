import * as winston from 'winston';
import DailyRotateFile = require('winston-daily-rotate-file');
import dayjs from 'dayjs';

const formatter = winston.format.printf(({ level, message }) =>
    JSON.stringify({ level, message, time: dayjs().format('YYYY-MM-DD HH:mm:ss.SSS') }),
);

const fileTransport = new DailyRotateFile({
    dirname: 'logs',
    filename: 'application-%DATE%',
    extension: '.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '100m',
    maxFiles: '14d',
    format: winston.format.combine(winston.format.timestamp(), formatter),
});

const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(winston.format.timestamp(), formatter),
});

export const logger = winston.createLogger({
    transports:
        process.env.NODE_ENV === 'development'
            ? [fileTransport, consoleTransport]
            : [fileTransport],
});
