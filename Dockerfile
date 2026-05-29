FROM node:20-bookworm-slim AS telegram-bot-api-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  cmake \
  g++ \
  git \
  gperf \
  make \
  libssl-dev \
  zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --recursive https://github.com/tdlib/telegram-bot-api.git

WORKDIR /build/telegram-bot-api
RUN mkdir build \
  && cd build \
  && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. \
  && cmake --build . --target install -j"$(nproc)"

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  libssl3 \
  zlib1g \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=telegram-bot-api-builder /usr/local /usr/local

RUN chmod +x /app/start.sh

ENV NODE_ENV=production
EXPOSE 4000

CMD ["/app/start.sh"]
