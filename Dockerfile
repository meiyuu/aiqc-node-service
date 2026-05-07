FROM --platform=linux/amd64 node:22.19.0-bookworm

WORKDIR /data/srv/

ENV TZ Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && apt-get -y install procps \
    && apt-get -y install iputils-ping \
    && apt-get -y install telnet \
    && apt-get -y install curl \
    && apt-get -y install vim \
    && apt-get -y install dnsutils \
    && apt-get -y install dns2tcp

COPY package*.json ./

RUN npm set registry https://registry.npmmirror.com
# RUN npm config set registry https://registry.npmjs.org

RUN npm install \
    && npm install pm2 -g

COPY . ./

RUN npm run build && npm prune --omit=dev

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js"]
