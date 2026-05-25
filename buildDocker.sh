#!/bin/bash

set -e

IMAGE_NAME="app-1sc29m7a1sg0c"
DOCKER_REGISTRY="4b8f745c43d70ec42ac5b8dce7c1e5b6-cn-north-1.jcr.service.jdcloud.com"
VERSION=${1:-main}
FULL_IMAGE_NAME="${DOCKER_REGISTRY}/${IMAGE_NAME}"

echo "版本号: $VERSION"
echo "开始构建Docker镜像..."

# 构建Docker镜像
docker buildx build --platform=linux/amd64 -t ${FULL_IMAGE_NAME}:${VERSION} .

echo "Docker镜像构建完成：${FULL_IMAGE_NAME}:${VERSION}"
echo "推送Docker镜像到仓库..."

# 推送带版本号的镜像
docker push ${FULL_IMAGE_NAME}:${VERSION}

echo "Docker镜像推送完成！"

docker rmi ${FULL_IMAGE_NAME}:${VERSION}
echo "已删除本地中间镜像"
