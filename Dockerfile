FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
