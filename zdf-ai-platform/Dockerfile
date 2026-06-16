FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/server.js ./backend/
RUN mkdir -p backend/data backend/data/rag

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "backend/server.js"]
