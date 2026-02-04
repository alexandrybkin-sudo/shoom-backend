# shoom-backend/Dockerfile

FROM node:20-alpine AS builder

WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем зависимости (включая devDependencies для сборки TS)
RUN npm ci

# Копируем исходный код
COPY . .

# Собираем TypeScript в JavaScript (папка dist)
RUN npm run build

# --- Production Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Копируем package.json для запуска
COPY package*.json ./

# Устанавливаем только production зависимости (меньше вес образа)
RUN npm ci --only=production

# Копируем собранный код из builder
COPY --from=builder /app/dist ./dist

# Создаем пользователя (безопасность)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

EXPOSE 3001

# Запускаем скомпилированный файл (проверь, что в package.json main указывает на dist/index.js)
CMD ["node", "dist/index.js"]
