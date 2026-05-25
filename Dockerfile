FROM --platform=linux/amd64 node:22.19.0-bookworm-slim

WORKDIR /data/srv/

ENV TZ Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && apt-get -y install curl

COPY package*.json ./

RUN npm set registry https://registry.npmmirror.com

RUN npm install \
    && npm install pm2 -g

COPY . ./

RUN npm run build && npm prune --omit=dev

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]
