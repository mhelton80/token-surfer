FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY *.ts ./
RUN npx tsc

# Create data directory for persistence
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "dist/runtime.js"]
