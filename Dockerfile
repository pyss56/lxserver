FROM alpine AS base

FROM base AS builder
WORKDIR /source-code
COPY . .

# 构建期依赖：任一 apk 包缺失（如部分 alpine 版本已移除 py3-pip）都不应中断整条构建
RUN apk add --update --no-cache g++ make nodejs npm \
  && (apk add --no-cache py3-pip || echo "py3-pip unavailable, skipping") \
  && (apk add --no-cache chromaprint || echo "chromaprint apk unavailable, skipping")

# fpcalc 仅为可选的音频指纹依赖，构建期跳过其联网下载（缺失不影响启动）
ENV SKIP_FPCALC_DOWNLOAD=1

RUN npm install --ignore-scripts --no-audit --no-fund \
  && npm run build \
  && rm -rf node_modules \
  && npm install --omit=dev --no-audit --no-fund \
  && mkdir -p build-output \
  && cp config.example.js build-output/config.js \
  && mv server node_modules index.js package.json public -t build-output


FROM base AS final
WORKDIR /server

RUN apk add --update --no-cache nodejs \
  && (apk add --no-cache chromaprint || echo "chromaprint apk not found, will use bundled binary")

COPY --from=builder ./source-code/build-output ./

VOLUME /server/data
ENV DATA_PATH='/server/data'
ENV LOG_PATH='/server/data/logs'

EXPOSE 9527
ENV NODE_ENV='production'
ENV PORT=9527
ENV BIND_IP='0.0.0.0'
# ENV PROXY_HEADER 'x-real-ip'
# ENV SERVER_NAME 'My Sync Server'
# ENV MAX_SNAPSHOT_NUM '10'
# ENV LIST_ADD_MUSIC_LOCATION_TYPE 'top'
# ENV LX_USER_user1 '123.123'
# ENV LX_USER_user2 '{ "password": "123.456", "maxSnapshotNum": 10, "list.addMusicLocationType": "top" }'
# ENV CONFIG_PATH '/server/config.js'
# ENV WEBDAV_URL ''
# ENV WEBDAV_USERNAME ''
# ENV WEBDAV_PASSWORD ''
# ENV SYNC_INTERVAL '60'
# ENV ENABLE_WEBPLAYER_AUTH 'false'
# ENV WEBPLAYER_PASSWORD '123456'
# ENV LOG_PATH '/server/logs'
# ENV DATA_PATH '/server/data'
# ENV PLAYER_ENABLE_AUTH 'true'
# ENV PLAYER_PASSWORD '123.456'

CMD [ "node", "index.js" ]
