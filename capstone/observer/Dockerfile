FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY observer ./observer
CMD ["node", "observer/index.js"]
