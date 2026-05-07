module.exports = {
    apps: [
        {
            script: 'dist/main.js',
            watch: false,
            instances: 1,
            autorestart: true,
            max_memory_restart: '2700M',
            env: { NODE_ENV: 'production' },
        },
    ],
};
