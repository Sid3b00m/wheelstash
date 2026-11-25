FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY seed ./seed
COPY public ./public
COPY storage/.gitkeep ./storage/.gitkeep

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/storage
ENV TZ=UTC

EXPOSE 3000

CMD ["node", "server.js"]
