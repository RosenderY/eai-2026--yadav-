FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY orchestrator ./orchestrator
CMD ["node", "orchestrator/index.js"]
