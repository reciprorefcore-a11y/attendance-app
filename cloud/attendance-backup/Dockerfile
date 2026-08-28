FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib/clock-log-backup.ts ./lib/clock-log-backup.ts
COPY lib/clock-log-restore.ts ./lib/clock-log-restore.ts
COPY cloud/attendance-backup/index.ts ./cloud/attendance-backup/index.ts
USER node
CMD ["node", "cloud/attendance-backup/index.ts"]
