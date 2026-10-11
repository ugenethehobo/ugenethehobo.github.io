FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080 3457
CMD ["node", "server/index.js"]
